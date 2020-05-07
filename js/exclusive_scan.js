var alignTo = function(val, align) {
    return Math.floor((val + align - 1) / align) * align;
}

// Serial scan for validation
var serialExclusiveScan = function(array, output) {
    output[0] = 0;
    for (var i = 1; i < array.length; ++i) {
        output[i] = array[i - 1] + output[i - 1];
    }
    return output[array.length - 1] + array[array.length - 1];
}

var ExclusiveScanner = function(device) {
    this.device = device;
    this.blockSize = ScanBlockSize;
    // Each thread in a work group is responsible for 2 elements
    this.workGroupSize = this.blockSize / 2;
    // The max size which can be scanned by a single batch without carry in/out
    this.maxScanSize = this.blockSize * this.blockSize;
    console.log(`Block size: ${this.blockSize}, max scan size: ${this.maxScanSize}`);

    this.fence = device.defaultQueue.createFence();
    this.fenceValue = 1;

    this.scanBlocksLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer",
                hasDynamicOffset: true,
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            }
        ]
    });

    this.scanBlockResultsLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            }
        ]
    });

    this.addBlockSumsLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer",
                hasDynamicOffset: true,
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            }
        ]
    });

    this.scanBlocksPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({bindGroupLayouts: [this.scanBlocksLayout]}),
        computeStage: {
            module: device.createShaderModule({code: prefix_sum_comp_spv}),
            entryPoint: "main"
        }
    });

    this.scanBlockResultsPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({bindGroupLayouts: [this.scanBlockResultsLayout]}),
        computeStage: {
            module: device.createShaderModule({code: block_prefix_sum_comp_spv}),
            entryPoint: "main"
        }
    });

    this.addBlockSumsPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({bindGroupLayouts: [this.addBlockSumsLayout]}),
        computeStage: {
            module: device.createShaderModule({code: add_block_sums_comp_spv}),
            entryPoint: "main"
        }
    });

    this.readbackBuf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var [clearCarryBuf, mapping] = this.device.createBufferMapped({
        size: 8,
        usage: GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(mapping).set([0, 0]);
    clearCarryBuf.unmap();
    this.clearCarryBuf = clearCarryBuf;
}

ExclusiveScanner.prototype.prepareInput = function(array) {
    this.inputSize = alignTo(array.length, this.blockSize)

    // Upload input and pad to block size elements
    var [inputBuf, mapping] = this.device.createBufferMapped({
        size: this.inputSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    new Uint32Array(mapping).set(array);
    inputBuf.unmap();
    this.inputBuf = inputBuf;

    // Block sum buffer
    var [blockSumBuf, mapping] = this.device.createBufferMapped({
        size: this.blockSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(mapping).fill(0);
    blockSumBuf.unmap();
    this.blockSumBuf = blockSumBuf;

    var [carryBuf, mapping] = this.device.createBufferMapped({
        size: 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    new Uint32Array(mapping).fill(0);
    carryBuf.unmap();
    this.carryBuf = carryBuf;

    this.scanBlocksBindGroup = this.device.createBindGroup({
        layout: this.scanBlocksLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: inputBuf,
                    size: Math.min(this.maxScanSize * 4, this.inputSize),
                    offset: 0,
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: blockSumBuf
                }
            }
        ]
    });

    this.scanBlockResultsBindGroup = this.device.createBindGroup({
        layout: this.scanBlockResultsLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: blockSumBuf
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: carryBuf
                }
            }
        ]
    });

    this.addBlockSumsBindGroup = this.device.createBindGroup({
        layout: this.addBlockSumsLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: inputBuf,
                    size: Math.min(this.maxScanSize * 4, this.inputSize),
                    offset: 0,
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: blockSumBuf
                }
            }
        ]
    });

    // Bind groups for processing the remainder if the aligned size isn't
    // an even multiple of the max scan size
    this.remainderScanBlocksBindGroup = null;
    this.remainderAddBlockSumsBindGroup = null;
    if (this.inputSize % this.maxScanSize) {
        this.remainderScanBlocksBindGroup = this.device.createBindGroup({
            layout: this.scanBlocksLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: inputBuf,
                        size: (this.inputSize % this.maxScanSize) * 4,
                        offset: 0,
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: blockSumBuf
                    }
                }
            ]
        });
        this.remainderAddBlockSumsBindGroup = this.device.createBindGroup({
            layout: this.addBlockSumsLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: inputBuf,
                        size: (this.inputSize % this.maxScanSize) * 4,
                        offset: 0,
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: blockSumBuf
                    }
                }
            ]
        });
    }

    var numChunks = Math.ceil(this.inputSize / (this.blockSize * this.blockSize));
    this.offsets = new Uint32Array(numChunks);
    for (var i = 0; i < numChunks; ++i) {
        this.offsets.set([i * this.maxScanSize * 4], i);
    }

    var numChunks = Math.ceil(this.inputSize / (this.blockSize * this.blockSize));
    // Scan through the data in chunks, updating carry in/out at the end to carry
    // over the results of the previous chunks
    var commandEncoder = this.device.createCommandEncoder();

    // Clear the carry buffer
    commandEncoder.copyBufferToBuffer(this.clearCarryBuf, 0, this.carryBuf, 0, 8);
    for (var i = 0; i < numChunks; ++i) {
        var nWorkGroups = Math.min((this.inputSize - i * this.maxScanSize) / this.blockSize, this.blockSize);

        var scanBlockBG = this.scanBlocksBindGroup;
        var addBlockSumsBG = this.addBlockSumsBindGroup;
        if (nWorkGroups < this.maxScanSize / this.blockSize) {
            scanBlockBG = this.remainderScanBlocksBindGroup;
            addBlockSumsBG = this.remainderAddBlockSumsBindGroup;
        }

        var computePass = commandEncoder.beginComputePass();

        computePass.setPipeline(this.scanBlocksPipeline);
        computePass.setBindGroup(0, scanBlockBG, this.offsets, i, 1);
        computePass.dispatch(nWorkGroups, 1, 1);

        computePass.setPipeline(this.scanBlockResultsPipeline);
        computePass.setBindGroup(0, this.scanBlockResultsBindGroup);
        computePass.dispatch(1, 1, 1);

        computePass.setPipeline(this.addBlockSumsPipeline);
        computePass.setBindGroup(0, addBlockSumsBG, this.offsets, i, 1);
        computePass.dispatch(nWorkGroups, 1, 1);

        computePass.endPass();

        // Update the carry in value for the next chunk, copy carry out to carry in
        commandEncoder.copyBufferToBuffer(this.carryBuf, 4, this.carryBuf, 0, 4);
    }
    // Readback the the last element to return the total sum as well
    commandEncoder.copyBufferToBuffer(this.carryBuf, 4, this.readbackBuf, 0, 4);
    this.commandBuffer = commandEncoder.finish();
}

async function exclusive_scan(scanner) {
    scanner.device.defaultQueue.submit([scanner.commandBuffer]);
    scanner.device.defaultQueue.signal(scanner.fence, scanner.fenceValue);

    await scanner.fence.onCompletion(scanner.fenceValue);
    scanner.fenceValue += 1;

    // Readback the final carry out, which is the sum
    var mapping = new Uint32Array(await scanner.readbackBuf.mapReadAsync());
    var sum = mapping[0];
    scanner.readbackBuf.unmap();

    return sum;
}


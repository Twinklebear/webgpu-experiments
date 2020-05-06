var alignTo = function(val, align) {
    return Math.floor((val + align - 1) / align) * align;
}

// Serial scan for validation
var serialExclusiveScan = function(array) {
    var output = Array.from(array);
    output[0] = 0;
    for (var i = 1; i < array.length; ++i) {
        output[i] = array[i - 1] + output[i - 1];
    }
    return output;
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
}

ExclusiveScanner.prototype.prepareInput = function(array) {
    this.inputSize = alignTo(array.length, this.blockSize)

    // Upload input and pad to block size elements
    var [inputBuf, mapping] = this.device.createBufferMapped({
        size: this.inputSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
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
    console.log(`remainder elements ${this.inputSize % this.maxScanSize}`);
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
}

// TODO: Array should be a device-side buffer
async function exclusive_scan(scanner, array) {
    var alignedSize = alignTo(array.length, scanner.blockSize); 
    console.log(`scanning array of size ${array.length}, size aligned to block size: ${alignedSize}, total bytes ${alignedSize * 4}`);

    var startScan = performance.now();

    // Scan through the data in chunks, updating carry in/out at the end to carry
    // over the results of the previous chunks
    var numChunks = Math.ceil(alignedSize / (scanner.blockSize * scanner.blockSize));
    console.log(`Must perform ${numChunks} chunk scans`);
    var offsets = new Uint32Array(numChunks);
    for (var i = 0; i < numChunks; ++i) {
        offsets.set([i * scanner.maxScanSize * 4], i);
    }
    console.log("Offsets:");
    console.log(offsets);
    var commandEncoder = scanner.device.createCommandEncoder();
    for (var i = 0; i < numChunks; ++i) {
        var nWorkGroups = Math.min((alignedSize - i * scanner.maxScanSize) / scanner.blockSize, scanner.blockSize);

        var scanBlockBG = scanner.scanBlocksBindGroup;
        var addBlockSumsBG = scanner.addBlockSumsBindGroup;
        if (nWorkGroups < scanner.maxScanSize / scanner.blockSize) {
            scanBlockBG = scanner.remainderScanBlocksBindGroup;
            addBlockSumsBG = scanner.remainderAddBlockSumsBindGroup;
        }

        var computePass = commandEncoder.beginComputePass();

        computePass.setPipeline(scanner.scanBlocksPipeline);
        computePass.setBindGroup(0, scanBlockBG, offsets, i, 1);
        computePass.dispatch(nWorkGroups, 1, 1);

        computePass.setPipeline(scanner.scanBlockResultsPipeline);
        computePass.setBindGroup(0, scanner.scanBlockResultsBindGroup);
        computePass.dispatch(1, 1, 1);

        computePass.setPipeline(scanner.addBlockSumsPipeline);
        computePass.setBindGroup(0, addBlockSumsBG, offsets, i, 1);
        computePass.dispatch(nWorkGroups, 1, 1);

        computePass.endPass();

        // Update the carry in value for the next chunk, copy carry out to carry in
        commandEncoder.copyBufferToBuffer(scanner.carryBuf, 4, scanner.carryBuf, 0, 4);
    }
    // Readback the the last element to return the total sum as well
    commandEncoder.copyBufferToBuffer(scanner.inputBuf, (array.length - 1) * 4, scanner.readbackBuf, 0, 4);
    scanner.device.defaultQueue.submit([commandEncoder.finish()]);

    scanner.device.defaultQueue.signal(scanner.fence, 1);
    await scanner.fence.onCompletion(1);

    var endScan = performance.now();

    console.log(`Parallel scan took ${endScan - startScan}`);

    // Save the last element in the array so we can also return the total sum
    // This is also stored in the final carry out
    var lastElem = array[array.length - 1];

    // Readback the result and write it to the input array
    var mapping = new Uint32Array(await scanner.readbackBuf.mapReadAsync());
    console.log(mapping);
    var sum = mapping[0] + array[array.length - 1];
    scanner.readbackBuf.unmap();

    return sum;
}


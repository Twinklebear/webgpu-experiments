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
}

ExclusiveScanner.prototype.getAlignedSize = function(size) {
    return alignTo(size, this.blockSize)
}

// TODO: Array should be a device-side buffer
async function exclusive_scan(scanner, array, gpuArray) {
    var alignedSize = alignTo(array.length, scanner.blockSize); 
    console.log(`scanning array of size ${array.length}, size aligned to block size: ${alignedSize}, total bytes ${alignedSize * 4}`);

    // Block sum buffer, padded up to block size elements
    var nBlockSums = scanner.blockSize;
    console.log(`num block sums ${nBlockSums}`);
    var [blockSumBuf, mapping] = scanner.device.createBufferMapped({
        size: nBlockSums * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(mapping).fill(0);
    blockSumBuf.unmap();

    var [carryBuf, mapping] = scanner.device.createBufferMapped({
        size: 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    new Uint32Array(mapping).fill(0);
    carryBuf.unmap();

    var scanBlocksBindGroup = scanner.device.createBindGroup({
        layout: scanner.scanBlocksLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: gpuArray,
                    size: Math.min(scanner.maxScanSize * 4, alignedSize),
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

    var scanBlockResultsBindGroup = scanner.device.createBindGroup({
        layout: scanner.scanBlockResultsLayout,
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

    var addBlockSumsBindGroup = scanner.device.createBindGroup({
        layout: scanner.addBlockSumsLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: gpuArray,
                    size: Math.min(scanner.maxScanSize * 4, alignedSize),
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
    console.log(`remainder elements ${alignedSize % scanner.maxScanSize}`);
    var remainderScanBlocksBindGroup = scanner.device.createBindGroup({
        layout: scanner.scanBlocksLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: gpuArray,
                    size: (alignedSize % scanner.maxScanSize) * 4,
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
    var remainderAddBlockSumsBindGroup = scanner.device.createBindGroup({
        layout: scanner.addBlockSumsLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: gpuArray,
                    size: (alignedSize % scanner.maxScanSize) * 4,
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

    var debugReadback = scanner.device.createBuffer({
        size: 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var readBlockSumBuf = scanner.device.createBuffer({
        size: nBlockSums * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

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
    for (var i = 0; i < numChunks; ++i) {
        var nWorkGroups = Math.min((alignedSize - i * scanner.maxScanSize) / scanner.blockSize, scanner.blockSize);

        var scanBlockBG = scanBlocksBindGroup;
        var addBlockSumsBG = addBlockSumsBindGroup;
        if (nWorkGroups < scanner.maxScanSize / scanner.blockSize) {
            scanBlockBG = remainderScanBlocksBindGroup;
            addBlockSumsBG = remainderAddBlockSumsBindGroup;
        }

        var commandEncoder = scanner.device.createCommandEncoder();
        var computePass = commandEncoder.beginComputePass();

        computePass.setPipeline(scanner.scanBlocksPipeline);
        computePass.setBindGroup(0, scanBlockBG, offsets, i, 1);
        computePass.dispatch(nWorkGroups, 1, 1);

        computePass.setPipeline(scanner.scanBlockResultsPipeline);
        computePass.setBindGroup(0, scanBlockResultsBindGroup);
        computePass.dispatch(1, 1, 1);

        computePass.setPipeline(scanner.addBlockSumsPipeline);
        computePass.setBindGroup(0, addBlockSumsBG, offsets, i, 1);
        computePass.dispatch(nWorkGroups, 1, 1);

        computePass.endPass();

        // Update the carry in value for the next chunk, copy carry out to carry in
        commandEncoder.copyBufferToBuffer(carryBuf, 4, carryBuf, 0, 4);

        scanner.device.defaultQueue.submit([commandEncoder.finish()]);
    }
    var endScan = performance.now();
    console.log(`Parallel scan took ${endScan - startScan}`);

    // Readback the the last element to return the total sum as well
    var readbackBuf = scanner.device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var commandEncoder = scanner.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(gpuArray, (array.length - 1) * 4, readbackBuf, 0, 4);
    scanner.device.defaultQueue.submit([commandEncoder.finish()]);

    var fence = scanner.device.defaultQueue.createFence();
    scanner.device.defaultQueue.signal(fence, 1);
    await fence.onCompletion(1);

    // Save the last element in the array so we can also return the total sum
    // This is also stored in the final carry out
    var lastElem = array[array.length - 1];

    // Readback the result and write it to the input array
    var mapping = new Uint32Array(await readbackBuf.mapReadAsync());
    console.log(mapping);
    var sum = mapping[0] + array[array.length - 1];
    readbackBuf.unmap();

    return sum;
}


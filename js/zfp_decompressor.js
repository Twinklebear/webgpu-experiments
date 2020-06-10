var ZFPDecompressor = function(device) {
    this.device = device;

    this.bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                type: "uniform-buffer"
            },
            {
                binding: 2,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            },
        ]
    });

    this.pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout]
        }),
        computeStage: {
            module: device.createShaderModule({code: zfp_decompress_block_comp_spv}),
            entryPoint: "main"
        }
    });

    // Note: this could be done by the server for us, but for this prototype
    // it's a bit easier to just do it here
    this.computeBlockRangePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout]
        }),
        computeStage: {
            module: device.createShaderModule({code: zfp_compute_block_range_comp_spv}),
            entryPoint: "main"
        }
    });
}

ZFPDecompressor.prototype.prepareInput = async function(compressedInput, compressionRate, volumeDims) {
    this.volumeDims = volumeDims;
    this.paddedDims = [alignTo(volumeDims[0], 4), alignTo(volumeDims[1], 4), alignTo(volumeDims[2], 4)]
    this.totalBlocks = (this.paddedDims[0] * this.paddedDims[1] * this.paddedDims[2]) / 64;
    console.log(`total blocks ${this.totalBlocks}`);
    const groupThreadCount = 32;
    this.numWorkGroups = Math.ceil(this.totalBlocks / groupThreadCount);
    console.log(`num work groups ${this.numWorkGroups}`);

    var [decodeParamsBuf, mapping] = this.device.createBufferMapped({
        size: 9 * 4,
        usage: GPUBufferUsage.UNIFORM
    });
    {
        var maxBits = (1 << (2 * 3)) * compressionRate;
        console.log(`max bits = ${maxBits}`);
        var buf = new Uint32Array(mapping);
        buf.set(volumeDims)
        buf.set(this.paddedDims, 4);
        buf.set([maxBits], 8);
    }
    decodeParamsBuf.unmap();
    this.decodeParamsBuf = decodeParamsBuf;

    var [compressedBuffer, mapping] = this.device.createBufferMapped({
        size: compressedInput.byteLength,
        usage: GPUBufferUsage.STORAGE
    });
    new Uint8Array(mapping).set(compressedInput);
    compressedBuffer.unmap();
    this.compressedBuffer = compressedBuffer;

    // Compute the block ranges
    this.blockRangesBuffer = this.device.createBuffer({
        size: this.totalBlocks * 2 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    // TODO next: union each block's range with its neighbors so we can see
    // the full range of values which may be contained in its dual
    var bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: this.compressedBuffer
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: this.decodeParamsBuf
                }
            },
            {
                binding: 2,
                resource: {
                    buffer: this.blockRangesBuffer
                }
            }
        ]
    });

    var commandEncoder = this.device.createCommandEncoder();
    var pass = commandEncoder.beginComputePass();
    pass.setPipeline(this.computeBlockRangePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatch(this.numWorkGroups, 1, 1);
    pass.endPass();
    this.device.defaultQueue.submit([commandEncoder.finish()]);

    // For testing: readback the block range buffer
    var readback = this.device.createBuffer({
        size: this.totalBlocks * 2 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(this.blockRangesBuffer, 0, readback, 0, this.totalBlocks * 2 * 4);
    this.device.defaultQueue.submit([commandEncoder.finish()]);

    var mapping = new Float32Array(await readback.mapReadAsync());
    console.log(mapping);
    readback.unmap();
}

ZFPDecompressor.prototype.decompress = async function() {
    const volumeBytes = this.volumeDims[0] * this.volumeDims[1] * this.volumeDims[2] * 4;
    var decompressedBuffer = this.device.createBuffer({
        size: volumeBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    var bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: this.compressedBuffer
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: this.decodeParamsBuf
                }
            },
            {
                binding: 2,
                resource: {
                    buffer: decompressedBuffer
                }
            }
        ]
    });

    var fence = this.device.defaultQueue.createFence();
    var fenceValue = 1;

    //for (var i = 0; i < 10; ++i) {
        var start = performance.now();
        var commandEncoder = this.device.createCommandEncoder();
        var pass = commandEncoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatch(this.numWorkGroups, 1, 1);
        pass.endPass();
        this.device.defaultQueue.submit([commandEncoder.finish()]);

        this.device.defaultQueue.signal(fence, fenceValue);
        await fence.onCompletion(fenceValue);
        fenceValue += 1;
        var end = performance.now();
        console.log(`Decompressed ${volumeBytes} in ${end - start}ms = ${1e-3 * volumeBytes / (end - start)} MB/s`);
    //}

    return decompressedBuffer;
}


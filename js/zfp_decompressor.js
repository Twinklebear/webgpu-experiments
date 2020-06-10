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
}

ZFPDecompressor.prototype.decompress = async function(compressedInput, compressionRate, volumeDims) {
    const paddedDims = [alignTo(volumeDims[0], 4), alignTo(volumeDims[1], 4), alignTo(volumeDims[2], 4)]
    const totalBlocks = (paddedDims[0] * paddedDims[1] * paddedDims[2]) / 64;
    console.log(`total blocks ${totalBlocks}`);
    const groupThreadCount = 32; 
    const numWorkGroups = Math.ceil(totalBlocks / groupThreadCount);
    console.log(`num work groups ${numWorkGroups}`);

    var [decodeParamsBuf, mapping] = this.device.createBufferMapped({
        size: 9 * 4,
        usage: GPUBufferUsage.UNIFORM
    });
    {
        var maxBits = (1 << (2 * 3)) * compressionRate;
        var buf = new Uint32Array(mapping);
        buf.set(volumeDims)
        buf.set(paddedDims, 4);
        buf.set([maxBits], 8);
    }
    decodeParamsBuf.unmap();

    var [compressedBuffer, mapping] = this.device.createBufferMapped({
        size: compressedInput.byteLength,
        usage: GPUBufferUsage.STORAGE
    });
    new Uint8Array(mapping).set(compressedInput);
    compressedBuffer.unmap();

    const volumeBytes = volumeDims[0] * volumeDims[1] * volumeDims[2] * 4;
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
                    buffer: compressedBuffer
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: decodeParamsBuf
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
        pass.dispatch(numWorkGroups, 1, 1);
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


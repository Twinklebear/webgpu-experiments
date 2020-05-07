(async () => {
    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("gpupresent");
    var swapChainFormat = "bgra8unorm";
    var swapChain = context.configureSwapChain({
        device: device,
        format: swapChainFormat,
        usage: GPUTextureUsage.OUTPUT_ATTACHMENT
    });

    var volumeData = await fetch(makeVolumeURL("Fuel"))
        .then(res => res.arrayBuffer().then(arr => new Uint8Array(arr)));

    // Note: bytes per row has to be multiple of 256, so smaller volumes would
    // need padding later on when using textures
    var volumeDims = getVolumeDimensions("Fuel");
    var [volumeDimsBuffer, mapping] = device.createBufferMapped({
        size: 4 * 4,
        usage: GPUBufferUsage.UNIFORM,
    });
    new Uint32Array(mapping).set(volumeDims);
    console.log(new Uint32Array(mapping));
    volumeDimsBuffer.unmap();

    var [volumeBuffer, mapping] = device.createBufferMapped({
        size: volumeData.length * 4,
        usage: GPUBufferUsage.STORAGE,
    });
    new Uint32Array(mapping).set(volumeData);

    console.log(new Uint32Array(mapping));
    volumeBuffer.unmap();

    /*
    var volumeTexture = device.createTexture({
        size: volumeDims,
        //format: "r8unorm",
        format: "r32float",
        usage: GPUTextureUsage.STORAGE, // | GPUTextureUsage.COPY_DST,
    });
    {
        // TODO: Chrome Canary/Dawn doesn't support copying data into 3D textures yet
        // As a hack use a compute shader which copies the buffer into a 3D texture
        // but this would also need to use a texture format that supports use as texture
        // storage in Chrome/Dawn (so, r32float)
        // TODO: It also doesn't support write/read storage textures at all yet

        {
        var commandEncoder = device.createCommandEncoder();
        var bufferCopyView = {
            buffer: volumeUploadBuffer,
            bytesPerRow: volumeDims[0],
        };
        var textureCopyView = {
            texture: volumeTexture,
        };
        commandEncoder.copyBufferToTexture(bufferCopyView, textureCopyView, volumeDims);
        device.defaultQueue.submit([commandEncoder.finish()]);
    }
    */

    var [isovalueBuffer, mapping] = device.createBufferMapped({
        size: 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    new Float32Array(mapping).set([64.0]);
    isovalueBuffer.unmap();

    var activeVoxelScanner = new ExclusiveScanner(device);

    var alignedActiveVoxelSize = activeVoxelScanner.getAlignedSize(volumeData.length);
    var [voxelActiveBuffer, mapping] = device.createBufferMapped({
        size: alignedActiveVoxelSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(mapping).fill(0);
    voxelActiveBuffer.unmap();

    {
        // Compute active voxels: mark 1 or 0 for if a voxel is active
        // in the data set
        var computeActiveVoxelsBGLayout = device.createBindGroupLayout({
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
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    type: "uniform-buffer"
                }
            ]
        });
        var computeActivePipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({bindGroupLayouts: [computeActiveVoxelsBGLayout]}),
            computeStage: {
                module: device.createShaderModule({code: compute_active_voxel_comp_spv}),
                entryPoint: "main"
            }
        });
        var computeActiveBG = device.createBindGroup({
            layout: computeActiveVoxelsBGLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: volumeBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: volumeDimsBuffer
                    }
                },
                {
                    binding: 2,
                    resource: {
                        buffer: voxelActiveBuffer
                    }
                },
                {
                    binding: 3,
                    resource: {
                        buffer: isovalueBuffer
                    }
                }
            ]
        });
        var commandEncoder = device.createCommandEncoder();
        var pass = commandEncoder.beginComputePass();
        pass.setPipeline(computeActivePipeline);
        pass.setBindGroup(0, computeActiveBG);
        pass.dispatch(volumeDims[0], volumeDims[1], volumeDims[2]);
        pass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);
    }

    activeVoxelScanner.prepareGPUInput(voxelActiveBuffer, alignedActiveVoxelSize);

    var start = performance.now();
    var totalActive = await exclusive_scan(activeVoxelScanner);
    var end = performance.now();
    console.log(`scan took ${end - start}`);
    console.log(`Total active voxels ${totalActive}`);

    // Readback the result. Not timed since the future Marching Cubes method will
    // keep this data on the GPU. So this should in the future take a GPU buffer
    var readbackBuf = activeVoxelScanner.device.createBuffer({
        size: alignedActiveVoxelSize * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var commandEncoder = device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(activeVoxelScanner.inputBuf, 0, readbackBuf, 0, volumeData.length);
    device.defaultQueue.submit([commandEncoder.finish()]);

    var fence = device.defaultQueue.createFence();
    device.defaultQueue.signal(fence, 1);
    await fence.onCompletion(1);

    var mapping = new Uint32Array(await readbackBuf.mapReadAsync());
    console.log(mapping);
})();



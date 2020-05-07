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
    var isovalue = 128;

    // Info buffer contains the volume dims and the isovalue
    var [volumeInfoBuffer, mapping] = device.createBufferMapped({
        size: 4 * 4 + 4,
        usage: GPUBufferUsage.UNIFORM,
    });
    new Uint32Array(mapping).set(volumeDims);
    new Float32Array(mapping).set([isovalue], 4);
    volumeInfoBuffer.unmap();

    console.log(`Isovalue ${isovalue}`);

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

    var volumeDataBGLayout = device.createBindGroupLayout({
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
            }
        ]
    });
    var volumeDataBG = device.createBindGroup({
        layout: volumeDataBGLayout,
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
                    buffer: volumeInfoBuffer
                }
            }
        ]
    });

    var activeVoxelScanner = new ExclusiveScanner(device);

    var voxelsToProcess = (volumeDims[0] - 1) * (volumeDims[1] - 1) * (volumeDims[2] - 1);
    console.log(`Voxels to process ${voxelsToProcess}`);
    var [voxelActiveBuffer, mapping] = device.createBufferMapped({
        size: voxelsToProcess * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(mapping).fill(0);
    voxelActiveBuffer.unmap();

    var alignedActiveVoxelSize = activeVoxelScanner.getAlignedSize(voxelsToProcess);
    var activeVoxelOffsets = device.createBuffer({
        size: alignedActiveVoxelSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Compute active voxels: mark 1 or 0 for if a voxel is active in the data set
    // TODO/NOTE: Larger datasets (beyond the 32-bit indexing we have in the shaders) could be
    // supported by using dyanmic offsets for the bind groups and processing them in chunks
    // Though w/ proper 3D texture support this would only be needed for some of the later
    // passes (scan and compaction)
    {
        var computeActiveVoxelsBGLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    type: "storage-buffer"
                }
            ]
        });
        var computeActivePipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [volumeDataBGLayout, computeActiveVoxelsBGLayout]
            }),
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
                        buffer: voxelActiveBuffer
                    }
                }
            ]
        });

        var commandEncoder = device.createCommandEncoder();
        var pass = commandEncoder.beginComputePass();
        pass.setPipeline(computeActivePipeline);
        pass.setBindGroup(0, volumeDataBG);
        pass.setBindGroup(1, computeActiveBG);
        pass.dispatch(volumeDims[0] - 1, volumeDims[1] - 1, volumeDims[2] - 1);
        pass.endPass();
        commandEncoder.copyBufferToBuffer(voxelActiveBuffer, 0, activeVoxelOffsets, 0, voxelsToProcess * 4);
        device.defaultQueue.submit([commandEncoder.finish()]);
    }

    activeVoxelScanner.prepareGPUInput(activeVoxelOffsets, alignedActiveVoxelSize);

    // Compute total number of active voxels and offsets for each in the compact buffer
    var start = performance.now();
    var totalActive = await exclusive_scan(activeVoxelScanner);
    var end = performance.now();
    console.log(`scan took ${end - start}`);
    console.log(`Total active voxels ${totalActive}`);

    // Compact the active voxel list down to the indices of the active voxels
    var activeVoxelIds = device.createBuffer({
        size: totalActive * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    {
        var streamCompactLayout = device.createBindGroupLayout({
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
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    type: "storage-buffer"
                }
            ]
        });
        var streamCompactPipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({bindGroupLayouts: [streamCompactLayout]}),
            computeStage: {
                module: device.createShaderModule({code: stream_compact_comp_spv}),
                entryPoint: "main"
            }
        });
        var streamCompactBG = device.createBindGroup({
            layout: streamCompactLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: voxelActiveBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: activeVoxelOffsets
                    }
                },
                {
                    binding: 2,
                    resource: {
                        buffer: activeVoxelIds
                    }
                }
            ]
        });

        var commandEncoder = device.createCommandEncoder();
        var pass = commandEncoder.beginComputePass();
        pass.setPipeline(streamCompactPipeline);
        pass.setBindGroup(0, streamCompactBG);
        pass.dispatch(voxelsToProcess, 1, 1);
        pass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);
    }

    // Determine the number of vertices generated by each active voxel
    var numVertsScanner = new ExclusiveScanner(device);
    var alignedNumVertsSize = numVertsScanner.getAlignedSize(totalActive);
    var numVertsBuffer = device.createBuffer({
        size: alignedNumVertsSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    {
        var computeNumVertsBGLayout = device.createBindGroupLayout({
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
        var computeNumVertsPipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [volumeDataBGLayout, computeNumVertsBGLayout]
            }),
            computeStage: {
                module: device.createShaderModule({code: compute_num_verts_comp_spv}),
                entryPoint: "main"
            }
        });
        var computeNumVertsBG = device.createBindGroup({
            layout: computeNumVertsBGLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: activeVoxelIds,
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: numVertsBuffer
                    }
                }
            ]
        });

        var commandEncoder = device.createCommandEncoder();
        var pass = commandEncoder.beginComputePass();
        pass.setPipeline(computeNumVertsPipeline);
        pass.setBindGroup(0, volumeDataBG);
        pass.setBindGroup(1, computeNumVertsBG);
        pass.dispatch(totalActive, 1, 1);
        pass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);
    }

    // Scan to compute total number of vertices and offsets for each voxel to write its output
    numVertsScanner.prepareGPUInput(numVertsBuffer, alignedNumVertsSize);
    var start = performance.now();
    var totalVerts = await exclusive_scan(numVertsScanner);
    var end = performance.now();
    console.log(`scan took ${end - start}`);
    console.log(`Total verts ${totalVerts}`);

    // Compute the vertices and output them along with the rendering command
    // We just write vec4's for positions to have an easier std430 layout
    var vertexBuffer = device.createBuffer({
        size: totalVerts * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC
    });
    {
        var computeVertsBGLayout = device.createBindGroupLayout({
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
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    type: "storage-buffer"
                }
            ]
        });
        var computeVertsPipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [volumeDataBGLayout, computeVertsBGLayout],
            }),
            computeStage: {
                module: device.createShaderModule({code: compute_vertices_comp_spv}),
                entryPoint: "main"
            }
        });
        var computeVertsBG = device.createBindGroup({
            layout: computeVertsBGLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: activeVoxelIds,
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: numVertsBuffer
                    }
                },
                {
                    binding: 2,
                    resource: {
                        buffer: vertexBuffer
                    }
                }
            ]
        });

        var commandEncoder = device.createCommandEncoder();
        var pass = commandEncoder.beginComputePass();
        pass.setPipeline(computeVertsPipeline);
        pass.setBindGroup(0, volumeDataBG);
        pass.setBindGroup(1, computeVertsBG);
        pass.dispatch(totalActive, 1, 1);
        pass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);
    }

    // Render it!

    // Readback the result. Not timed since the future Marching Cubes method will
    // keep this data on the GPU. So this should in the future take a GPU buffer
    var readbackBuf = activeVoxelScanner.device.createBuffer({
        size: totalVerts * 4 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    var commandEncoder = device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(vertexBuffer, 0, readbackBuf, 0, totalVerts * 4 * 4);
    device.defaultQueue.submit([commandEncoder.finish()]);

    var fence = device.defaultQueue.createFence();
    device.defaultQueue.signal(fence, 1);
    await fence.onCompletion(1);

    var mapping = new Float32Array(await readbackBuf.mapReadAsync());
    console.log(mapping);
})();



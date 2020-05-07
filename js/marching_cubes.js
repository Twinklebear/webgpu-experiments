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

    var volumeName = "Neghip";
    var volumeData = await fetch(makeVolumeURL(volumeName))
        .then(res => res.arrayBuffer().then(arr => new Uint8Array(arr)));

    // Note: bytes per row has to be multiple of 256, so smaller volumes would
    // need padding later on when using textures
    var volumeDims = getVolumeDimensions(volumeName);
    var isovalue = 80;

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

    volumeBuffer.unmap();

    /*
    var volumeTexture = device.createTexture({
        size: volumeDims,
        //format: "r8unorm",
        format: "r32float",
        usage: GPUTextureUsage.STORAGE | GPUTextureUsage.COPY_DST,
    });
    {
        // TODO: Chrome Canary/Dawn doesn't support copying data into 3D textures yet
        // As a hack use a compute shader which copies the buffer into a 3D texture
        // but this would also need to use a texture format that supports use as texture
        // storage in Chrome/Dawn (so, r32float)
        // Also seems like FF nightly doesn't support it yet either
        // TODO: It also doesn't support write/read storage textures at all yet

        var commandEncoder = device.createCommandEncoder();
        var bufferCopyView = {
            buffer: volumeBuffer,
            bytesPerRow: volumeDims[0],
        };
        var textureCopyView = {
            texture: volumeTexture,
        };
        commandEncoder.copyBufferToTexture(bufferCopyView, textureCopyView, volumeDims);
        device.defaultQueue.submit([commandEncoder.finish()]);
    }
    */

    // Not sure how to query this limit, assuming this size based on OpenGL
    // In a less naive implementation doing some block-based implementation w/
    // larger group sizes might be better as well
    // We also need to make sure the offset we'll end up using for the
    // dynamic offsets is aligned to 256 bytes. We're offsetting into arrays
    // of uint32, so determine the max dispatch size we should use for each
    // individual aligned chunk
    var maxDispatchSize = Math.floor((2 * 65535 * 4) / 256) * 256;
    console.log(`max dispatch: ${maxDispatchSize}`);

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

    console.log(volumeDims);
    var voxelsToProcess = (volumeDims[0] - 1) * (volumeDims[1] - 1) * (volumeDims[2] - 1);
    console.log(`Voxels to process ${voxelsToProcess}`);
    var [voxelActiveBuffer, mapping] = device.createBufferMapped({
        size: voxelsToProcess * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(mapping).fill(0);
    voxelActiveBuffer.unmap();

    var alignedActiveVoxelSize = activeVoxelScanner.getAlignedSize(voxelsToProcess);
    var [activeVoxelOffsets, mapping] = device.createBufferMapped({
        size: alignedActiveVoxelSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    new Uint32Array(mapping).fill(0);
    activeVoxelOffsets.unmap();

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

    activeVoxelScanner.prepareGPUInput(activeVoxelOffsets, alignedActiveVoxelSize, voxelsToProcess);

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
                    type: "storage-buffer",
                    hasDynamicOffset: true
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    type: "storage-buffer",
                    hasDynamicOffset: true
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    type: "uniform-buffer",
                    hasDynamicOffset: true
                },
                {
                    binding: 3,
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

        // No push constants in the API? This is really a hassle to hack together
        // because I also have to obey (at least Dawn's rule is it part of the spec?)
        // that the dynamic offsets be 256b aligned
        // Please add push constants!
        var numChunks = Math.ceil(voxelsToProcess / maxDispatchSize);
        var [compactPassOffset, mapping] = device.createBufferMapped({
            size: numChunks * 1024,
            usage: GPUBufferUsage.UNIFORM
        });
        {
            var map = new Uint32Array(mapping);
            for (var i = 0; i < numChunks; ++i) {
                map[i * 64] = i * maxDispatchSize;
            }
            compactPassOffset.unmap();
        }

        var streamCompactBG = device.createBindGroup({
            layout: streamCompactLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: voxelActiveBuffer,
                        size: 4 * Math.min(voxelsToProcess, maxDispatchSize),
                        offset: 0
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: activeVoxelOffsets,
                        size: 4 * Math.min(voxelsToProcess, maxDispatchSize),
                        offset: 0
                    }
                },
                {
                    binding: 2,
                    resource: {
                        buffer: compactPassOffset,
                        size: 4,
                        offset: 0
                    }
                },
                {
                    binding: 3,
                    resource: {
                        buffer: activeVoxelIds
                    }
                }
            ]
        });
        var streamCompactRemainderBG = null;
        if (voxelsToProcess % maxDispatchSize) {
            streamCompactRemainderBG = device.createBindGroup({
                layout: streamCompactLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: voxelActiveBuffer,
                            size: 4 * (voxelsToProcess % maxDispatchSize),
                            offset: 0
                        }
                    },
                    {
                        binding: 1,
                        resource: {
                            buffer: activeVoxelOffsets,
                            size: 4 * (voxelsToProcess % maxDispatchSize),
                            offset: 0
                        }
                    },
                    {
                        binding: 2,
                        resource: {
                            buffer: compactPassOffset,
                            size: 4,
                            offset: 0
                        }
                    },
                    {
                        binding: 3,
                        resource: {
                            buffer: activeVoxelIds
                        }
                    }
                ]
            });
        }

        var commandEncoder = device.createCommandEncoder();
        var pass = commandEncoder.beginComputePass();
        pass.setPipeline(streamCompactPipeline);
        for (var i = 0; i < numChunks; ++i) {
            var numWorkGroups = Math.min(voxelsToProcess - i * maxDispatchSize, maxDispatchSize);
            var offset = i * maxDispatchSize * 4;
            if (numWorkGroups == maxDispatchSize) {
                // These are supposed to be passed in REVERSE order of how they appear in the bindgroup layout!??
                // This seems like a bug, the spec says it should be passed in increasing order of
                // binding number https://gpuweb.github.io/gpuweb/#bind-group-layout-creation
                // so I'd think this should be [offset, offset, i * 256]?
                pass.setBindGroup(0, streamCompactBG, [i * 256, offset, offset]);
            } else {
                pass.setBindGroup(0, streamCompactRemainderBG, [i * 256, offset, offset]);
            }
            pass.dispatch(numWorkGroups, 1, 1);
        }
        pass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);
    }

    // Note: Both compute num verts and compute verts might also need chunking
    // if the # of active voxels gets very high and exceeds what we can do in one launch
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

        var start = performance.now();
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
    numVertsScanner.prepareGPUInput(numVertsBuffer, alignedNumVertsSize, totalActive);
    var start = performance.now();
    var totalVerts = await exclusive_scan(numVertsScanner);
    var end = performance.now();
    console.log(`scan took ${end - start}`);
    console.log(`Total verts ${totalVerts}`);

    // Compute the vertices and output them along with the rendering command
    // We just write vec4's for positions to have an easier std430 layout
    var vertexBuffer = device.createBuffer({
        size: totalVerts * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX
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

        // No fences on FF nightly
        /*
        var fence = device.defaultQueue.createFence();
        device.defaultQueue.signal(fence, 1);
        await fence.onCompletion(1);
        var end = performance.now();
        console.log(`Vertex computation took ${end - start}`);
        */
    }

    // Render it!
    const defaultEye = vec3.set(vec3.create(), 0.0, 0.0, 1.0);
    const center = vec3.set(vec3.create(), 0.0, 0.0, 0.0);
    const up = vec3.set(vec3.create(), 0.0, 1.0, 0.0);
    var camera = new ArcballCamera(defaultEye, center, up, 2, [canvas.width, canvas.height]);
	var proj = mat4.perspective(mat4.create(), 50 * Math.PI / 180.0,
		canvas.width / canvas.height, 0.1, 1000);
	var projView = mat4.create();

	var controller = new Controller();
	controller.mousemove = function(prev, cur, evt) {
		if (evt.buttons == 1) {
			camera.rotate(prev, cur);

		} else if (evt.buttons == 2) {
			camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
		}
	};
	controller.wheel = function(amt) { camera.zoom(amt * 0.5); };
	controller.pinch = controller.wheel;
	controller.twoFingerDrag = function(drag) { camera.pan(drag); };
	controller.registerForCanvas(canvas);

    var swapChainFormat = "bgra8unorm";
    var swapChain = context.configureSwapChain({
        device: device,
        format: swapChainFormat,
        usage: GPUTextureUsage.OUTPUT_ATTACHMENT
    });

    var depthTexture = device.createTexture({
        size: {
            width: canvas.width,
            height: canvas.height,
            depth: 1
        },
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.OUTPUT_ATTACHMENT
    });

    var renderPassDesc = {
        colorAttachments: [{
            attachment: undefined,
            loadValue: [0.3, 0.3, 0.3, 1]
        }],
        depthStencilAttachment: {
            attachment: depthTexture.createView(),
            depthLoadValue: 1.0,
            depthStoreOp: "store",
            stencilLoadValue: 0,
            stencilStoreOp: "store"
        }
    };

    var viewParamsLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            },
            {
                binding: 1,
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            }
        ]
    });

    var viewParamBuf = device.createBuffer({
        size: 4 * 4 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    var viewParamsBindGroup = device.createBindGroup({
        layout: viewParamsLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: viewParamBuf
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

    var renderPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({bindGroupLayouts: [viewParamsLayout] }),
        vertexStage: {
            module: device.createShaderModule({code: mc_isosurface_vert_spv}),
            entryPoint: "main"
        },
        fragmentStage: {
            module: device.createShaderModule({code: mc_isosurface_frag_spv}),
            entryPoint: "main"
        },
        primitiveTopology: "triangle-list",
        vertexState: {
            vertexBuffers: [
                {
                    arrayStride: 4 * 4,
                    attributes: [
                        {
                            format: "float4",
                            offset: 0,
                            shaderLocation: 0
                        }
                    ]
                }
            ]
        },
        colorStates: [{
            format: swapChainFormat
        }],
        depthStencilState: {
            format: "depth24plus-stencil8",
            depthWriteEnabled: true,
            depthCompare: "less"
        }
    });

    var frame = function() {
        renderPassDesc.colorAttachments[0].attachment = swapChain.getCurrentTexture().createView();

        var commandEncoder = device.createCommandEncoder();
        
        projView = mat4.mul(projView, proj, camera.camera);
        var [upload, uploadMap] = device.createBufferMapped({
            size: 4 * 4 * 4,
            usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC
        });
        new Float32Array(uploadMap).set(projView);
        upload.unmap();

        commandEncoder.copyBufferToBuffer(upload, 0, viewParamBuf, 0, 4 * 4 * 4);

        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, viewParamsBindGroup);
        renderPass.setVertexBuffer(0, vertexBuffer);
        renderPass.draw(totalVerts, 1, 0, 0);

        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();


// Volume input should be a uint8/16/32 or float32 array
var MarchingCubes = function(device, volume, volumeDims, volumeType) {
    this.device = device;

    // Info buffer contains the volume dims and the isovalue
    var [volumeInfoBuffer, mapping] = device.createBufferMapped({
        size: 4 * 4 + 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    new Uint32Array(mapping).set(volumeDims);
    new Float32Array(mapping).set([128], 4);
    volumeInfoBuffer.unmap();
    this.volumeInfoBuffer = volumeInfoBuffer;
    this.volumeDims = volumeDims;

    // Note: bytes per row has to be multiple of 256, so smaller volumes would
    // need padding later on when using textures
    var [volumeBuffer, mapping] = device.createBufferMapped({
        size: volume.length * volume.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE,
    });

    var compute_active_shader = null;
    var compute_num_verts_shader = null;
    var compute_verts_shader = null;
    if (volumeType == "uint8") {
        new Uint8Array(mapping).set(volume);
        compute_active_shader = device.createShaderModule({code: compute_active_voxel_uint8_comp_spv});
        compute_num_verts_shader = device.createShaderModule({code: compute_num_verts_uint8_comp_spv});
        compute_verts_shader = device.createShaderModule({code: compute_vertices_uint8_comp_spv});
    } else if (volumeType == "uint16") {
        new Uint16Array(mapping).set(volume);
        compute_active_shader = device.createShaderModule({code: compute_active_voxel_uint16_comp_spv});
        compute_num_verts_shader = device.createShaderModule({code: compute_num_verts_uint16_comp_spv});
        compute_verts_shader = device.createShaderModule({code: compute_vertices_uint16_comp_spv});
    } else if (volumeType == "uint32") {
        new Uint32Array(mapping).set(volume);
        compute_active_shader = device.createShaderModule({code: compute_active_voxel_uint32_comp_spv});
        compute_num_verts_shader = device.createShaderModule({code: compute_num_verts_uint32_comp_spv});
        compute_verts_shader = device.createShaderModule({code: compute_vertices_uint32_comp_spv});
    } else if (volumeType == "float32") {
        new Float32Array(mapping).set(volume);
        compute_active_shader = device.createShaderModule({code: compute_active_voxel_float_comp_spv});
        compute_num_verts_shader = device.createShaderModule({code: compute_num_verts_float_comp_spv});
        compute_verts_shader = device.createShaderModule({code: compute_vertices_float_comp_spv});
    }
    volumeBuffer.unmap();
    this.volumeBuffer = volumeBuffer;

    var [triTableBuf, mapping] = device.createBufferMapped({
        size: triTable.byteLength,
        usage: GPUBufferUsage.UNIFORM
    });
    new Int32Array(mapping).set(triTable);
    triTableBuf.unmap();
    this.triTable = triTableBuf;

    this.totalActive = 0;
    this.alignedNumVertsSize = 0;
    this.totalVerts = 0;

    this.fence = device.defaultQueue.createFence();
    this.fenceValue = 1;

    // TODO: Implement some upload chunking for large data (over 512*512*512 bytes seems to be the limit)
    // Is this a limitation to expect to exist in the future permanently?

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
    this.maxDispatchSize = Math.floor((2 * 65535 * 4) / 256) * 256;

    this.volumeDataBGLayout = device.createBindGroupLayout({
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
    this.volumeDataBG = device.createBindGroup({
        layout: this.volumeDataBGLayout,
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

    var voxelsToProcess = (volumeDims[0] - 1) * (volumeDims[1] - 1) * (volumeDims[2] - 1);

    this.voxelActiveBuffer = device.createBuffer({
        size: voxelsToProcess * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    this.activeVoxelScanner = new ExclusiveScanner(this.device);
    var alignedActiveVoxelSize = this.activeVoxelScanner.getAlignedSize(voxelsToProcess);
    this.activeVoxelOffsets = device.createBuffer({
        size: alignedActiveVoxelSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Compute active voxels: mark 1 or 0 for if a voxel is active in the data set
    // TODO/NOTE: Larger datasets (beyond the 32-bit indexing we have in the shaders) could be
    // supported by using dyanmic offsets for the bind groups and processing them in chunks
    // Though w/ proper 3D texture support this would only be needed for some of the later
    // passes (scan and compaction)
    this.computeActiveVoxelsBGLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            }
        ]
    });
    this.computeActivePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [this.volumeDataBGLayout, this.computeActiveVoxelsBGLayout]
        }),
        computeStage: {
            module: compute_active_shader,
            entryPoint: "main"
        }
    });
    this.computeActiveBG = device.createBindGroup({
        layout: this.computeActiveVoxelsBGLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: this.voxelActiveBuffer
                }
            }
        ]
    });

    this.activeVoxelScanner.prepareGPUInput(this.activeVoxelOffsets, alignedActiveVoxelSize, voxelsToProcess);

    this.streamCompactLayout = device.createBindGroupLayout({
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
    this.streamCompactPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({bindGroupLayouts: [this.streamCompactLayout]}),
        computeStage: {
            module: device.createShaderModule({code: stream_compact_comp_spv}),
            entryPoint: "main"
        }
    });


    // Note: Both compute num verts and compute verts might also need chunking
    // if the # of active voxels gets very high and exceeds what we can do in one launch
    // Determine the number of vertices generated by each active voxel
    this.numVertsScanner = new ExclusiveScanner(device);

    this.computeNumVertsBGLayout = device.createBindGroupLayout({
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
                type: "uniform-buffer"
            }
        ]
    });
    this.computeNumVertsPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [this.volumeDataBGLayout, this.computeNumVertsBGLayout]
        }),
        computeStage: {
            module: compute_num_verts_shader,
            entryPoint: "main"
        }
    });

    this.computeVertsBGLayout = device.createBindGroupLayout({
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
            },
            {
                binding: 3,
                visibility: GPUShaderStage.COMPUTE,
                type: "uniform-buffer"
            }
        ]
    });
    this.computeVertsPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [this.volumeDataBGLayout, this.computeVertsBGLayout],
        }),
        computeStage: {
            module: compute_verts_shader,
            entryPoint: "main"
        }
    });
}

MarchingCubes.prototype.computeSurface = async function(isovalue) {
    // Upload the isovalue
    var [upload, mapping] = this.device.createBufferMapped({
        size: 4,
        usage: GPUBufferUsage.COPY_SRC,
    });
    new Float32Array(mapping).set([isovalue]);
    upload.unmap();

    var commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(upload, 0, this.volumeInfoBuffer, 16, 4);
    this.device.defaultQueue.submit([commandEncoder.finish()]);

    var totalActive = await this.computeActiveVoxels();
    if (totalActive == 0) {
        return 0;
    }
    var activeVoxelIds = this.compactActiveVoxels(totalActive);

    // Note: Both compute num verts and compute verts might also need chunking
    // if the # of active voxels gets very high and exceeds what we can do in one launch
    var [totalVerts, vertexOffsetBuffer] = await this.computeNumVertices(totalActive, activeVoxelIds);
    if (totalVerts == 0) {
        return 0;
    }
    this.computeVertices(totalActive, activeVoxelIds, totalVerts, vertexOffsetBuffer);

    this.device.defaultQueue.signal(this.fence, this.fenceValue);
    await this.fence.onCompletion(this.fenceValue);
    this.fenceValue += 1;
    return totalVerts;
}

MarchingCubes.prototype.computeActiveVoxels = async function() {
    // Compute active voxels: mark 1 or 0 for if a voxel is active in the data set and scan
    // to compute the total number of active voxels
    var voxelsToProcess = (this.volumeDims[0] - 1) * (this.volumeDims[1] - 1) * (this.volumeDims[2] - 1);

    var commandEncoder = this.device.createCommandEncoder();
    var pass = commandEncoder.beginComputePass();
    pass.setPipeline(this.computeActivePipeline);
    pass.setBindGroup(0, this.volumeDataBG);
    pass.setBindGroup(1, this.computeActiveBG);
    pass.dispatch(this.volumeDims[0] - 1, this.volumeDims[1] - 1, this.volumeDims[2] - 1);
    pass.endPass();
    commandEncoder.copyBufferToBuffer(this.voxelActiveBuffer, 0, this.activeVoxelOffsets, 0, voxelsToProcess * 4);
    this.device.defaultQueue.submit([commandEncoder.finish()]);

    // Compute total number of active voxels and offsets for each in the compact buffer
    var start = performance.now();
    var totalActive = await this.activeVoxelScanner.scan();
    var end = performance.now();
    //console.log(`Active voxel scan took ${end - start}`);
    return totalActive;
}

MarchingCubes.prototype.compactActiveVoxels = function(totalActive) {
    // Compact the active voxel list down to the indices of the active voxels
    // TODO: can also re-use this buffer if it's got enough room
    if (totalActive > this.totalActive) {
        this.activeVoxelIds = this.device.createBuffer({
            size: totalActive * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        this.totalActive = totalActive;
    }
    var voxelsToProcess = (this.volumeDims[0] - 1) * (this.volumeDims[1] - 1) * (this.volumeDims[2] - 1);

    // No push constants in the API? This is really a hassle to hack together
    // because I also have to obey (at least Dawn's rule is it part of the spec?)
    // that the dynamic offsets be 256b aligned
    // Please add push constants!
    var numChunks = Math.ceil(voxelsToProcess / this.maxDispatchSize);
    var [compactPassOffset, mapping] = this.device.createBufferMapped({
        size: numChunks * 256,
        usage: GPUBufferUsage.UNIFORM
    });
    {
        var map = new Uint32Array(mapping);
        for (var i = 0; i < numChunks; ++i) {
            map[i * 64] = i * this.maxDispatchSize;
        }
        compactPassOffset.unmap();
    }

    var streamCompactBG = this.device.createBindGroup({
        layout: this.streamCompactLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: this.voxelActiveBuffer,
                    size: 4 * Math.min(voxelsToProcess, this.maxDispatchSize),
                    offset: 0
                }
            },
            {
                binding: 1,
                resource: {
                    buffer: this.activeVoxelOffsets,
                    size: 4 * Math.min(voxelsToProcess, this.maxDispatchSize),
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
                    buffer: this.activeVoxelIds
                }
            }
        ]
    });

    var streamCompactRemainderBG = null;
    if (voxelsToProcess % this.maxDispatchSize) {
        streamCompactRemainderBG = this.device.createBindGroup({
            layout: this.streamCompactLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.voxelActiveBuffer,
                        size: 4 * (voxelsToProcess % this.maxDispatchSize),
                        offset: 0
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: this.activeVoxelOffsets,
                        size: 4 * (voxelsToProcess % this.maxDispatchSize),
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
                        buffer: this.activeVoxelIds
                    }
                }
            ]
        });
    }

    var commandEncoder = this.device.createCommandEncoder();
    var pass = commandEncoder.beginComputePass();
    pass.setPipeline(this.streamCompactPipeline);
    for (var i = 0; i < numChunks; ++i) {
        var numWorkGroups = Math.min(voxelsToProcess - i * this.maxDispatchSize, this.maxDispatchSize);
        var offset = i * this.maxDispatchSize * 4;
        if (numWorkGroups == this.maxDispatchSize) {
            pass.setBindGroup(0, streamCompactBG, [i * 256, offset, offset]);
            // TODO: When Chrome Canary gets the Dawn bugfix added, switch to pass it in right order
            // https://bugs.chromium.org/p/dawn/issues/detail?id=408
            //pass.setBindGroup(0, streamCompactBG, [offset, offset, i * 256]);
        } else {
            // TODO: When Chrome Canary gets the Dawn bugfix added, switch to pass it in right order
            // https://bugs.chromium.org/p/dawn/issues/detail?id=408
            pass.setBindGroup(0, streamCompactRemainderBG, [i * 256, offset, offset]);
            //pass.setBindGroup(0, streamCompactRemainderBG, [offset, offset, i * 256]);
        }
        pass.dispatch(numWorkGroups, 1, 1);
    }
    pass.endPass();
    this.device.defaultQueue.submit([commandEncoder.finish()]);

    return this.activeVoxelIds;
}

MarchingCubes.prototype.computeNumVertices = async function(totalActive, activeVoxelIds) {
    // Determine the number of vertices generated by each active voxel
    var alignedNumVertsSize = this.numVertsScanner.getAlignedSize(totalActive);
    if (alignedNumVertsSize > this.alignedNumVertsSize) {
        this.numVertsBuffer = this.device.createBuffer({
            size: alignedNumVertsSize * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        this.alignedNumVertsSize = alignedNumVertsSize;
    }

    var computeNumVertsBG = this.device.createBindGroup({
        layout: this.computeNumVertsBGLayout,
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
                    buffer: this.numVertsBuffer
                }
            },
            {
                binding: 2,
                resource: {
                    buffer: this.triTable
                }
            }
        ]
    });

    var commandEncoder = this.device.createCommandEncoder();
    var pass = commandEncoder.beginComputePass();
    pass.setPipeline(this.computeNumVertsPipeline);
    pass.setBindGroup(0, this.volumeDataBG);
    pass.setBindGroup(1, computeNumVertsBG);
    pass.dispatch(totalActive, 1, 1);
    pass.endPass();
    this.device.defaultQueue.submit([commandEncoder.finish()]);

    // Scan to compute total number of vertices and offsets for each voxel to write its output
    this.numVertsScanner.prepareGPUInput(this.numVertsBuffer, alignedNumVertsSize, totalActive);

    var start = performance.now();
    var totalVerts = await this.numVertsScanner.scan();
    var end = performance.now();
    //console.log(`Vertex count scan took ${end - start}`);
    return [totalVerts, this.numVertsBuffer];
}

MarchingCubes.prototype.computeVertices = function(totalActive, activeVoxelIds, totalVerts, vertexOffsetBuffer) {
    // Compute the vertices and output them along with the rendering command
    // We just write vec4's for positions to have an easier std430 layout
    // TODO: Don't re-allocate if our old one has enough room to hold the new surface
    if (totalVerts > this.totalVerts) {
        this.vertexBuffer = this.device.createBuffer({
            size: totalVerts * 4 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX
        });
        this.totalVerts = totalVerts;
    }

    var computeVertsBG = this.device.createBindGroup({
        layout: this.computeVertsBGLayout,
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
                    buffer: vertexOffsetBuffer
                }
            },
            {
                binding: 2,
                resource: {
                    buffer: this.vertexBuffer
                }
            },
            {
                binding: 3,
                resource: {
                    buffer: this.triTable
                }
            }
        ]
    });

    var commandEncoder = this.device.createCommandEncoder();
    var pass = commandEncoder.beginComputePass();
    pass.setPipeline(this.computeVertsPipeline);
    pass.setBindGroup(0, this.volumeDataBG);
    pass.setBindGroup(1, computeVertsBG);
    pass.dispatch(totalActive, 1, 1);
    pass.endPass();
    this.device.defaultQueue.submit([commandEncoder.finish()]);
}

var computeValueRange = function(data) {
    var min = Number.POSITIVE_INFINITY;
    var max = Number.NEGATIVE_INFINITY;
    for (var i = 0; i < data.length; ++i) {
        min = Math.min(data[i], min);
        max = Math.max(data[i], max);
    }
    //console.log(`value range ${min} to ${max}`);
    return [min, max];
}


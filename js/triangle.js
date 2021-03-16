(async () => {
    if (!navigator.gpu) {
        alert("WebGPU is not supported/enabled in your browser");
        return;
    }

    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("gpupresent");
    var swapChainFormat = "bgra8unorm";
    var swapChain = context.configureSwapChain({
        device: device,
        format: swapChainFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    var depthTexture = device.createTexture({
        size: {
            width: canvas.width,
            height: canvas.height,
            depth: 1
        },
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT
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

    // Testing some dynamic color offsets
    var testDynamicBuf = device.createBuffer({
        size: 3 * 4 * 4,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true
    });
    // Interleaved positions and colors
    new Float32Array(testDynamicBuf.getMappedRange()).set([
        1, 0, 0, 1,
        0, 1, 0, 1,
        0, 0, 1, 1
    ]);
    testDynamicBuf.unmap();

    var dataBuf = device.createBuffer({
        size: 3 * 2 * 4 * 4,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true
    });
    // Interleaved positions and colors
    new Float32Array(dataBuf.getMappedRange()).set([
        1, -1, 0, 1,
        1, 0, 0, 1,
        -1, -1, 0, 1,
        0, 1, 0, 1,
        0, 1, 0, 1,
        0, 0, 1, 1,
    ]);
    dataBuf.unmap();

    var vertModule = device.createShaderModule({code: simple_vert_spv});
    var fragModule = device.createShaderModule({code: simple_frag_spv});

    var bgLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                type: "storage-buffer",
                hasDynamicOffset: true
            }
        ]
    });

    var testBg = device.createBindGroup({
        layout: bgLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: testDynamicBuf,
                    size: 4 * 4,
                    offset: 0
                }
            }
        ]
    });

    var layout = device.createPipelineLayout({bindGroupLayouts: [bgLayout]});

    var renderPipeline = device.createRenderPipeline({
        layout: layout,
        vertexStage: {
            module: vertModule,
            entryPoint: "main"
        },
        fragmentStage: {
            module: fragModule,
            entryPoint: "main"
        },
        primitiveTopology: "triangle-list",
        vertexState: {
            vertexBuffers: [
                {
                    arrayStride: 2 * 4 * 4,
                    attributes: [
                        {
                            format: "float32x4",
                            offset: 0,
                            shaderLocation: 0
                        },
                        {
                            format: "float32x4",
                            offset: 4 * 4,
                            shaderLocation: 1
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
        
        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, testBg, [0]);
        renderPass.setVertexBuffer(0, dataBuf);
        renderPass.draw(3, 1, 0, 0);

        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();


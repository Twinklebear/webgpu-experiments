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
        device,
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

    // Setup compute pass to generate our "vertices"
    var dataBuf = device.createBuffer({
        size: (3 + 3) * 3 * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE
    });

    var computeBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                type: "storage-buffer"
            }
        ]
    });
    var computeBindGroup = device.createBindGroup({
        layout: computeBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: dataBuf
                }
            }
        ]
    });
    var computeLayout = device.createPipelineLayout({bindGroupLayouts: [computeBindGroupLayout]});

    var simpleCompute = await fetch("/shaders/simple.comp.spv")
        .then(res => res.arrayBuffer().then(arr => new Uint32Array(arr)));
    var computeModule = device.createShaderModule({code: simpleCompute});

    var computePipeline = device.createComputePipeline({
        layout: computeLayout,
        computeStage: {
            module: computeModule,
            entryPoint: "main"
        }
    });

    // TODO: Embed these in JS with some script as Uint32Arrays
    var simpleVert = await fetch("/shaders/simple.vert.spv")
        .then(res => res.arrayBuffer().then(arr => new Uint32Array(arr)));
    var simpleFrag = await fetch("/shaders/simple.frag.spv")
        .then(res => res.arrayBuffer().then(arr => new Uint32Array(arr)));

    var vertModule = device.createShaderModule({code: simpleVert});
    var fragModule = device.createShaderModule({code: simpleFrag});

    var layout = device.createPipelineLayout({bindGroupLayouts: []});

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
                    arrayStride: (3 + 3) * 4,
                    attributes: [
                        {
                            format: "float3",
                            offset: 0,
                            shaderLocation: 0
                        },
                        {
                            format: "float3",
                            offset: 3 * 4,
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
        
        var computePass = commandEncoder.beginComputePass();
        computePass.setBindGroup(0, computeBindGroup);
        computePass.setPipeline(computePipeline);
        computePass.dispatch(3, 1, 1);
        computePass.endPass();

        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

        renderPass.setPipeline(renderPipeline);
        renderPass.setVertexBuffer(0, dataBuf);
        renderPass.draw(3, 1, 0, 0);

        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();


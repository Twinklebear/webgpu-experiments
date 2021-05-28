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
    var swapChain = context.configureSwapChain(
        {device, format: swapChainFormat, usage: GPUTextureUsage.OUTPUT_ATTACHMENT});

    var depthTexture = device.createTexture({
        size: {width: canvas.width, height: canvas.height, depth: 1},
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    var storageTexture = device.createTexture({
        size: {width: canvas.width, height: canvas.height, depth: 1},
        format: "rgba8unorm",
        usage: GPUTextureUsage.STORAGE
    });

    var renderPassDesc = {
        colorAttachments: [{attachment: undefined, loadValue: [0.3, 0.3, 0.3, 1]}],
        depthStencilAttachment: {
            view: depthTexture.createView(),
            depthLoadValue: 1.0,
            depthStoreOp: "store",
            stencilLoadValue: 0,
            stencilStoreOp: "store"
        }
    };

    var computeBindGroupLayout = device.createBindGroupLayout({
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {access: "write-only", format: "rgba8unorm"}
        }]
    });

    var computeLayout =
        device.createPipelineLayout({bindGroupLayouts: [computeBindGroupLayout]});

    var computeModule = device.createShaderModule({code: mandelbrot_comp_spv});

    var computePipeline = device.createComputePipeline(
        {layout: computeLayout, compute: {module: computeModule, entryPoint: "main"}});

    var computeBindGroup = device.createBindGroup({
        layout: computeBindGroupLayout,
        entries: [{binding: 0, resource: storageTexture.createView()}]
    });

    var vertModule = device.createShaderModule({code: mandelbrot_vert_spv});
    var fragModule = device.createShaderModule({code: mandelbrot_frag_spv});

    var renderBGLayout = device.createBindGroupLayout({
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            storageTexture: {access: "read-only", format: "rgba8unorm"}
        }]
    });

    var renderPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({bindGroupLayouts: [renderBGLayout]}),
        vertex: {
            module: vertModule,
            entryPoint: "main",
        },
        fragment:
            {module: fragModule, entryPoint: "main", targets: [{format: swapChainFormat}]},
        depthStencil:
            {format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less"}
    });

    var renderPipelineBG = device.createBindGroup({
        layout: renderBGLayout,
        entries: [{binding: 0, resource: storageTexture.createView()}]
    });

    var frame = function() {
        renderPassDesc.colorAttachments[0].view = swapChain.getCurrentTexture().createView();

        var commandEncoder = device.createCommandEncoder();

        var computePass = commandEncoder.beginComputePass();
        computePass.setBindGroup(0, computeBindGroup);
        computePass.setPipeline(computePipeline);
        // Fill the texture
        computePass.dispatch(640, 480, 1);
        computePass.endPass();

        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, renderPipelineBG);
        // Draw a full screen quad
        renderPass.draw(6, 1, 0, 0);
        renderPass.endPass();

        device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
})();


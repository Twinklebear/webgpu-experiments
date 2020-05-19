(async () => {
    if (!navigator.gpu) {
        alert("WebGPU is not supported/enabled in your browser");
        return;
    }

    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    //var glbFile = await fetch("/models/2CylinderEngine.glb")
    //var glbFile = await fetch("/models/FlightHelmet.glb")
    //var glbFile = await fetch("/models/sponza.glb")
    //var glbFile = await fetch("/models/san-miguel.glb")
    //var glbFile = await fetch("/models/DamagedHelmet.glb")
    var glbFile = await fetch("https://www.dl.dropboxusercontent.com/s/7ndj8pfjhact7lz/DamagedHelmet.glb?dl=1")
        .then(res => res.arrayBuffer().then(buf => uploadGLBModel(buf, device)));

    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("gpupresent");
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

    var shaderModules = {
        posVert: {
            module: device.createShaderModule({code: glb_pos_vert_spv}),
            entryPoint: "main",
        },
        posFrag: {
            module: device.createShaderModule({code: glb_pos_frag_spv}),
            entryPoint: "main",
        },
        posNormalVert: {
            module: device.createShaderModule({code: glb_posnormal_vert_spv}),
            entryPoint: "main",
        },
        posNormalFrag: {
            module: device.createShaderModule({code: glb_posnormal_frag_spv}),
            entryPoint: "main",
        },
        posNormalUVVert: {
            module: device.createShaderModule({code: glb_posnormaluv_vert_spv}),
            entryPoint: "main",
        },
        posNormalUVFrag: {
            module: device.createShaderModule({code: glb_posnormaluv_frag_spv}),
            entryPoint: "main",
        },
        posUVVert: {
            module: device.createShaderModule({code: glb_posuv_vert_spv}),
            entryPoint: "main",
        },
        posUVFrag: {
            module: device.createShaderModule({code: glb_posuv_frag_spv}),
            entryPoint: "main",
        },
        pnuTexturedVert: {
            module: device.createShaderModule({code: glb_pnutex_vert_spv}),
            entryPoint: "main",
        },
        pnuTexturedFrag: {
            module: device.createShaderModule({code: glb_pnutex_frag_spv}),
            entryPoint: "main",
        },
    };

    var sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear"
    });

    var viewParamsLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
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
            }
        ]
    });

    var renderBundles = glbFile.buildRenderBundles(device, shaderModules, viewParamsLayout,
        viewParamsBindGroup, swapChainFormat);

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

    var animationFrame = function() {
        var resolve = null;
        var promise = new Promise(r => resolve = r);
        window.requestAnimationFrame(resolve);
        return promise
    };
    requestAnimationFrame(animationFrame);

    var fpsDisplay = document.getElementById("fps");
    var fence = device.defaultQueue.createFence();
    var fenceValue = 1;
    numFrames = 0;
    totalTimeMS = 0;
    while (true) {
        await animationFrame();
        if (glbBuffer != null) {
            glbFile = await uploadGLBModel(glbBuffer, device);
            renderBundles = glbFile.buildRenderBundles(device, shaderModules, viewParamsLayout,
                viewParamsBindGroup, swapChainFormat);
            glbBuffer = null;
        }

        var start = performance.now();
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
        renderPass.executeBundles(renderBundles);

        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        device.defaultQueue.signal(fence, fenceValue);
        await fence.onCompletion(fenceValue);
        fenceValue += 1;
        var end = performance.now();
        numFrames += 1;
        totalTimeMS += end - start;
        fpsDisplay.innerHTML = `Avg. FPS ${Math.round(1000.0 * numFrames / totalTimeMS)}`;
    }
})();


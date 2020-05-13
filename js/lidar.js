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
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                type: "uniform-buffer"
            }
        ]
    });
    var viewParamBuf = device.createBuffer({
        size: 20 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    var lasInfoBuffer = device.createBuffer({
        size: 10 * 4,
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
                    buffer: lasInfoBuffer
                }
            }
        ]
    });

    var lasInfoDisplay = document.getElementById("lasInfo");
    var pointRadiusSlider = document.getElementById("pointRadius");
    var roundPoints = document.getElementById("roundPoints");

    var pointRadius = 1;
    pointRadiusSlider.value = pointRadius;
    var useRoundPoints = true;
    roundPoints.checked = true;

    var renderPipeline = null;

    const defaultEye = vec3.set(vec3.create(), 0.0, 0.0, 1.0);
    const center = vec3.set(vec3.create(), 0.0, 0.0, 0.0);
    const up = vec3.set(vec3.create(), 0.0, 1.0, 0.0);
    var camera = new ArcballCamera(defaultEye, center, up, 2, [canvas.width, canvas.height]);
	var proj = mat4.perspective(mat4.create(), 50 * Math.PI / 180.0,
		canvas.width / canvas.height, 1, 4000);
	var projView = mat4.create();

    var fpsDisplay = document.getElementById("fps");
    var numFrames = 0;
    var totalTimeMS = 0;

	var controller = new Controller();
	controller.mousemove = function(prev, cur, evt) {
		if (evt.buttons == 1) {
			camera.rotate(prev, cur);
            numFrames = 0;
            totalTimeMS = 0;
		} else if (evt.buttons == 2) {
			camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
            numFrames = 0;
            totalTimeMS = 0;
		}
	};
	controller.wheel = function(amt) {
        camera.zoom(amt * 0.5);
        numFrames = 0;
        totalTimeMS = 0;
    };
	controller.pinch = controller.wheel;
	controller.twoFingerDrag = function(drag) {
        camera.pan(drag);
        numFrames = 0;
        totalTimeMS = 0;
    };
	controller.registerForCanvas(canvas);

    var animationFrame = function() {
        var resolve = null;
        var promise = new Promise(r => resolve = r);
        window.requestAnimationFrame(resolve);
        return promise
    };

    requestAnimationFrame(animationFrame);

    var lasVertexBuffer = null;
    var lasColorBuffer = null;

    var fence = device.defaultQueue.createFence();
    var fenceValue = 1;
    while (true) {
        await animationFrame();
        var start = performance.now();
        renderPassDesc.colorAttachments[0].attachment = swapChain.getCurrentTexture().createView();

        var commandEncoder = device.createCommandEncoder();

        projView = mat4.mul(projView, proj, camera.camera);
        var [upload, uploadMap] = device.createBufferMapped({
            size: 20 * 4,
            usage: GPUBufferUsage.COPY_SRC
        });
        {
            var viewmap = new Float32Array(uploadMap);
            viewmap.set(projView);
            viewmap.set(camera.eyePos(), 16);
        }
        upload.unmap();

        commandEncoder.copyBufferToBuffer(upload, 0, viewParamBuf, 0, 20 * 4);

        if (newLasFileReady) {
            numFrames = 0;
            totalTimeMS = 0;

            if (lasFile) {
                lasFile.close();
            }
            lasFile = newLasFile;
            newLasFileReady = false;
            lasVertexBuffer = null;
            lasColorBuffer = null;
            lasInfo.innerHTML = `LAS File with ${lasFile.numLoadedPoints} loaded points (noise classified points are discarded)`;

            var [buffer, mapping] = device.createBufferMapped({
                size: lasFile.numLoadedPoints * 3 * 4,
                usage: GPUBufferUsage.VERTEX
            });
            new Float32Array(mapping).set(lasFile.positions);
            buffer.unmap();
            lasVertexBuffer = buffer;

            var vertexBuffers = [
                {
                    arrayStride: 3 * 4,
                    stepMode: "instance",
                    attributes: [
                        {
                            format: "float3",
                            offset: 0,
                            shaderLocation: 0
                        }
                    ]
                }
            ];
            var vertexStage = null;
            var fragmentStage = null;

            if (lasFile.hasColors) {
                vertexBuffers.push({
                    arrayStride: 4,
                    stepMode: "instance",
                    attributes: [
                        {
                            format: "uchar4norm",
                            offset: 0,
                            shaderLocation: 1
                        }
                    ]
                });

                var [buffer, mapping] = device.createBufferMapped({
                    size: lasFile.numLoadedPoints * 4,
                    usage: GPUBufferUsage.VERTEX
                });
                new Uint8Array(mapping).set(lasFile.colors);
                buffer.unmap();
                lasColorBuffer = buffer;

                vertexStage = {
                    module: device.createShaderModule({code: lidar_poscolor_vert_spv}),
                    entryPoint: "main"
                };
                fragmentStage = {
                    module: device.createShaderModule({code: lidar_poscolor_frag_spv}),
                    entryPoint: "main"
                };
            } else {
                vertexStage = {
                    module: device.createShaderModule({code: lidar_pos_vert_spv}),
                    entryPoint: "main"
                };
                fragmentStage = {
                    module: device.createShaderModule({code: lidar_pos_frag_spv}),
                    entryPoint: "main"
                };
            }

            // Update the dataset info
            var [buffer, mapping] = device.createBufferMapped({
                size: 10 * 4,
                usage: GPUBufferUsage.COPY_SRC
            });
            {
                var arr = new Float32Array(mapping);
                arr.set([lasFile.bounds[0], lasFile.bounds[1], lasFile.bounds[2]]);
                arr.set([lasFile.bounds[3], lasFile.bounds[4], lasFile.bounds[5]], 4);
                arr.set([0.5], 8);
                new Uint32Array(mapping).set([1], 9);
            }
            buffer.unmap();

            // The UBO will pad the vec3's to vec4's anyway so we just write vec4's there
            commandEncoder.copyBufferToBuffer(buffer, 0, lasInfoBuffer, 0, 10 * 4);

            renderPipeline = device.createRenderPipeline({
                layout: device.createPipelineLayout({bindGroupLayouts: [viewParamsLayout]}),
                vertexStage: vertexStage,
                fragmentStage: fragmentStage,
                primitiveTopology: "triangle-strip",
                vertexState: {
                    vertexBuffers: vertexBuffers
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
        }

        if (pointRadiusSlider.value != pointRadius || roundPoints.checked != useRoundPoints) {
            pointRadius = pointRadiusSlider.value;
            useRoundPoints = roundPoints.checked;

            var [buffer, mapping] = device.createBufferMapped({
                size: 8,
                usage: GPUBufferUsage.COPY_SRC
            });
            new Float32Array(mapping).set([pointRadius], 0);
            new Uint32Array(mapping).set([useRoundPoints ? 1 : 0], 1);
            buffer.unmap();

            commandEncoder.copyBufferToBuffer(buffer, 0, lasInfoBuffer, 8 * 4, 8);
        }

        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);
        if (lasFile && lasVertexBuffer) {
            renderPass.setPipeline(renderPipeline);
            renderPass.setBindGroup(0, viewParamsBindGroup);
            renderPass.setVertexBuffer(0, lasVertexBuffer);
            if (lasFile.hasColors) {
                renderPass.setVertexBuffer(1, lasColorBuffer);
            }
            renderPass.draw(4, lasFile.numLoadedPoints, 0, 0);

        }
        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        // Measure render time by waiting for the fence
        device.defaultQueue.signal(fence, fenceValue);
        await fence.onCompletion(fenceValue);
        fenceValue += 1;
        var end = performance.now();
        numFrames += 1;
        totalTimeMS += end - start;
        fpsDisplay.innerHTML = `Avg. FPS ${Math.round(1000.0 * numFrames / totalTimeMS)}`;
    }
})();



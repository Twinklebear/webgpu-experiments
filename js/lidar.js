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
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            }
        ]
    });
    var viewParamBuf = device.createBuffer({
        size: 16 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    var lasInfoBuffer = device.createBuffer({
        size: 8 * 4,
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

    var renderPipeline = null;

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
	controller.wheel = function(amt) { camera.zoom(amt * 0.1); };
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

    var lasVertexBuffer = null;
    var lasColorBuffer = null;

    while (true) {
        await animationFrame();
        renderPassDesc.colorAttachments[0].attachment = swapChain.getCurrentTexture().createView();

        var commandEncoder = device.createCommandEncoder();

        projView = mat4.mul(projView, proj, camera.camera);
        var [upload, uploadMap] = device.createBufferMapped({
            size: 16 * 4,
            usage: GPUBufferUsage.COPY_SRC
        });
        new Float32Array(uploadMap).set(projView);
        upload.unmap();

        commandEncoder.copyBufferToBuffer(upload, 0, viewParamBuf, 0, 16 * 4);

        if (newLasFile) {
            newLasFile = false;
            lasVertexBuffer = null;
            lasColorBuffer = null;

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
                console.log("uploading colors");
                vertexBuffers.push({
                    arrayStride: 4,
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
                size: 6 * 4,
                usage: GPUBufferUsage.COPY_SRC
            });
            new Float32Array(mapping).set(lasFile.bounds);
            buffer.unmap();

            // The UBO will pad the vec3's to vec4's anyway so we just write vec4's there
            commandEncoder.copyBufferToBuffer(buffer, 0, lasInfoBuffer, 0, 3 * 4);
            commandEncoder.copyBufferToBuffer(buffer, 3 * 4, lasInfoBuffer, 4 * 4, 3 * 4);

            renderPipeline = device.createRenderPipeline({
                layout: device.createPipelineLayout({bindGroupLayouts: [viewParamsLayout]}),
                vertexStage: vertexStage,
                fragmentStage: fragmentStage,
                primitiveTopology: "point-list",
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

        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);
        if (lasFile && lasVertexBuffer) {
            renderPass.setPipeline(renderPipeline);
            renderPass.setBindGroup(0, viewParamsBindGroup);
            renderPass.setVertexBuffer(0, lasVertexBuffer);
            if (lasFile.hasColors) {
                renderPass.setVertexBuffer(1, lasColorBuffer);
            }
            renderPass.draw(lasFile.numLoadedPoints, 1, 0, 0);

        }
        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);
    }
})();



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

    var volumeName = "Fuel";
    if (window.location.hash) {
        volumeName = decodeURI(window.location.hash.substr(1));
    }
    var volumeType = getVolumeType(volumeName);
    var volumeDims = getVolumeDimensions(volumeName);
    var volumeData = await fetch(makeVolumeURL(volumeName))
        .then(res => res.arrayBuffer().then(function (arr) { 
            if (volumeType == "uint8") {
                return new Uint8Array(arr);
            } else if (volumeType == "uint16") {
                return new Uint16Array(arr);
            } else if (volumeType == "uint32") {
                return new Uint32Array(arr);
            } else if (volumeType == "float32") {
                return new Float32Array(arr);
            }
            return null;
        }));
    if (volumeData == null) {
        alert(`Unsupported volume data type ${volumeType}`);
        return;
    }

    var isovalueSlider = document.getElementById("isovalue");
    isovalueSlider.min = 0;
    isovalueSlider.max = 255;
    isovalueSlider.value = (isovalueSlider.max - isovalueSlider.min) / 2;
    var currentIsovalue = isovalueSlider.value;

    var mcInfo = document.getElementById("mcInfo");

    var marchingCubes = new MarchingCubes(device, volumeData, volumeDims, volumeType);
    var start = performance.now();
    var totalVerts = await marchingCubes.computeSurface(currentIsovalue);
    var end = performance.now();
    console.log(`total vertices ${totalVerts} in ${end - start}ms`);
    mcInfo.innerHTML = `Extracted surface with ${totalVerts / 3} triangles in ${end - start}ms. Isovalue = ${currentIsovalue}`;

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
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                type: "uniform-buffer"
            },
            {
                binding: 1,
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            }
        ]
    });

    // The proj_view matrix and eye position
    var viewParamSize = (16 + 4) * 4;
    var viewParamBuf = device.createBuffer({
        size: viewParamSize,
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
                    buffer: marchingCubes.volumeInfoBuffer,
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

    var animationFrame = function() {
        var resolve = null;
        var promise = new Promise(r => resolve = r);
        window.requestAnimationFrame(resolve);
        return promise
    };

    requestAnimationFrame(animationFrame);

    while (true) {
        await animationFrame();

        if (isovalueSlider.value != currentIsovalue || requestRecompute) {
            currentIsovalue = isovalueSlider.value;
            var start = performance.now();
            totalVerts = await marchingCubes.computeSurface(currentIsovalue);
            var end = performance.now();
            console.log(`Computation took ${end - start}ms`);
            mcInfo.innerHTML = `Extracted surface with ${totalVerts / 3} triangles in ${end - start}ms. Isovalue = ${currentIsovalue}`;
            requestRecompute = false;
        }

        renderPassDesc.colorAttachments[0].attachment = swapChain.getCurrentTexture().createView();

        var commandEncoder = device.createCommandEncoder();
        
        projView = mat4.mul(projView, proj, camera.camera);
        var [upload, uploadMap] = device.createBufferMapped({
            size: viewParamSize,
            usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC
        });
        var uploadArry = new Float32Array(uploadMap);
        uploadArry.set(projView);
        uploadArry.set(camera.eyePos(), 16);
        upload.unmap();

        commandEncoder.copyBufferToBuffer(upload, 0, viewParamBuf, 0, viewParamSize);

        var renderPass = commandEncoder.beginRenderPass(renderPassDesc);
        if (totalVerts > 0) {
            renderPass.setPipeline(renderPipeline);
            renderPass.setBindGroup(0, viewParamsBindGroup);
            renderPass.setVertexBuffer(0, marchingCubes.vertexBuffer);
            renderPass.draw(totalVerts, 1, 0, 0);
        }
        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);
    }
})();


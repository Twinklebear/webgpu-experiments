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

    var isovalueSlider = document.getElementById("isovalue");
    isovalueSlider.min = 0;
    isovalueSlider.max = 255;
    isovalueSlider.step = (isovalueSlider.max - isovalueSlider.min) / 255;
    isovalueSlider.value = (isovalueSlider.max - isovalueSlider.min) / 2;
    var currentIsovalue = isovalueSlider.value;

    var volumeName = "Fuel";
    if (window.location.hash) {
        var urlParams = window.location.hash.substr(1).split("&");
        for (var i = 0; i < urlParams.length; ++i) {
            var str = decodeURI(urlParams[i]);
            if (str.startsWith("vol=")) {
                volumeName = str.substr(4);
            } else if (str.startsWith("iso=")) {
                isovalueSlider.value = parseFloat(str.substr(4));
                currentIsovalue = isovalueSlider.value;
            }
        }
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
        camera.zoom(amt * 0.1);
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

    var fence = device.defaultQueue.createFence();
    var fenceValue = 1;

    var RandomIsovalueBenchmark = function(isovalueSlider, perfResults, range) {
        this.iteration = 0;
        this.isovalueSlider = isovalueSlider;
        this.perfResults = perfResults;
        this.range = range;
    }

    RandomIsovalueBenchmark.prototype.run = function() {
        if (this.iteration == 100) {
            console.log(JSON.stringify(this.perfResults));
            for (const prop in this.perfResults) {
                var sum = this.perfResults[prop].reduce(function(acc, x) { return acc + x; });
                console.log(`${prop} average = ${(sum / this.perfResults[prop].length).toFixed(3)}`);
            }
            return false;
        }
        var range = this.range[1] - this.range[0];
        this.isovalueSlider.value = Math.random() * range + this.range[0];
        this.iteration += 1;
        return true;
    }
    var currentBenchmark = null;
    var requestBenchmark = 0;
    var perfResults = {};

    function runBenchmark() {
        requestBenchmark = 1;
    }
    document.getElementById("runRandomBenchmark").onclick = runBenchmark;

    while (true) {
        await animationFrame();
        var start = performance.now();

        if (requestBenchmark && !currentBenchmark) {
            perfResults = {
                time: []
            };
            currentBenchmark = new RandomIsovalueBenchmark(isovalueSlider, perfResults, [10, 255]);
            requestBenchmark = 0;
        }
        if (currentBenchmark) {
            if (!currentBenchmark.run()) {
                currentBenchmark = null;
            }
        }

        if (isovalueSlider.value != currentIsovalue || requestRecompute) {
            currentIsovalue = isovalueSlider.value;
            var start = performance.now();
            totalVerts = await marchingCubes.computeSurface(currentIsovalue);
            var end = performance.now();
            if (perfResults.time !== undefined) {
                perfResults.time.push(end - start);
            }
            console.log(`Computation took ${end - start}ms`);
            mcInfo.innerHTML = `Extracted surface with ${totalVerts / 3} triangles in ${end - start}ms. Isovalue = ${currentIsovalue}`;
            requestRecompute = false;
            numFrames = 0;
            totalTimeMS = 0;
        }

        renderPassDesc.colorAttachments[0].attachment = swapChain.getCurrentTexture().createView();

        var commandEncoder = device.createCommandEncoder();
        
        projView = mat4.mul(projView, proj, camera.camera);
        var upload = device.createBuffer({
            size: viewParamSize,
            usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
            mappedAtCreation: true
        });
        var uploadArry = new Float32Array(upload.getMappedRange());
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


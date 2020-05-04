(async () => {
    if (!navigator.gpu) {
        alert("WebGPU is not supported/enabled in your browser");
        return;
    }

    var glbFile = await fetch("/models/suzanne.glb")
        .then(res => res.arrayBuffer());
    console.log(glbFile);
    // The file header and chunk 0 header
    // TODO: It sounds like the spec does allow for multiple binary chunks,
    // so then how do you know which chunk a buffer exists in? Maybe the buffer id
    // corresponds to the binary chunk ID? Would have to find info in the spec
    // or an example file to check this
    var header = new Uint32Array(glbFile, 0, 5);
    console.log(header);
    if (header[0] != 0x46546C67) {
        alert("This does not appear to be a glb file?");
        return;
    }
    console.log(`GLB Version ${header[1]}, file length ${header[2]}`);
    console.log(`JSON chunk length ${header[3]}, type ${header[4]}`);
    var glbJsonData = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(glbFile, 20, header[3])));
    console.log(glbJsonData);

    var binaryHeader = new Uint32Array(glbFile, 20 + header[3], 2);
    console.log(binaryHeader);
    var glbBuffer = new GLTFBuffer(new Uint8Array(glbFile, 28 + header[3], binaryHeader[0]), binaryHeader[0]);

    if (28 + header[3] + binaryHeader[0] != glbFile.byteLength) {
        console.log("TODO: Multiple binary chunks in file");
    }

    var meshes = [];
    for (var i = 0; i < glbJsonData.meshes.length; ++i) {
        var mesh = glbJsonData.meshes[i];
        console.log(mesh);

        var primitives = []
        for (var j = 0; j < mesh.primitives.length; ++j) {
            var prim = mesh.primitives[j];
            console.log(prim);
            if (prim["mode"] != undefined && prim["mode"] != 4) {
                alert("Ignoring primitive with unsupported mode " + prim["mode"]);
                continue;
            }

            var accessor = glbJsonData["accessors"][prim["indices"]]

            var indices = makeGLTFAccessor(glbBuffer, glbJsonData["bufferViews"][accessor["bufferView"]], accessor);
            console.log(indices);

            accessor = glbJsonData["accessors"][prim["attributes"]["POSITION"]];
            var positions = makeGLTFAccessor(glbBuffer, glbJsonData["bufferViews"][accessor["bufferView"]], accessor);

            accessor = glbJsonData["accessors"][prim["attributes"]["NORMAL"]];
            var normals = makeGLTFAccessor(glbBuffer, glbJsonData["bufferViews"][accessor["bufferView"]], accessor);

            primitives.push(new GLTFPrimitive(indices, positions, normals));
        }
        meshes.push(new GLTFMesh(mesh["name"], primitives));
    }
    console.log(meshes);

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

    var [indexBuf, indexBufMapping] = device.createBufferMapped({
        size: meshes[0].primitives[0].indices.byteLength(),
        usage: GPUBufferUsage.INDEX
    });
    // TODO wrapper util to upload the primitive buffer
    new Uint16Array(indexBufMapping).set(meshes[0].primitives[0].indices.view)
    indexBuf.unmap();

    var [vertexBuf, vertexBufMapping] = device.createBufferMapped({
        size: meshes[0].primitives[0].positions.byteLength(),
        usage: GPUBufferUsage.VERTEX
    });
    new Float32Array(vertexBufMapping).set(meshes[0].primitives[0].positions.view);
    vertexBuf.unmap();

    var [normalBuf, normalBufMapping] = device.createBufferMapped({
        size: meshes[0].primitives[0].normals.byteLength(),
        usage: GPUBufferUsage.VERTEX
    });
    new Float32Array(normalBufMapping).set(meshes[0].primitives[0].normals.view);
    normalBuf.unmap();

    var vertModule = device.createShaderModule({code: glb_vert_spv});
    var fragModule = device.createShaderModule({code: glb_frag_spv});

    var bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            }
        ]
    });
    var layout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});

    var viewParamBuf = device.createBuffer({
        size: 4 * 4 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    var bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: viewParamBuf
                }
            }
        ]
    });

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
            // TODO: GLB can also have uint32
            indexFormat: "uint16",
            vertexBuffers: [
                {
                    arrayStride: 3 * 4,
                    attributes: [
                        {
                            format: "float3",
                            offset: 0,
                            shaderLocation: 0
                        }
                    ]
                },
                {
                    arrayStride: 3 * 4,
                    attributes: [
                        {
                            format: "float3",
                            offset: 0,
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

    const defaultEye = vec3.set(vec3.create(), 0.0, 0.0, 1.0);
    const center = vec3.set(vec3.create(), 0.0, 0.0, 0.0);
    const up = vec3.set(vec3.create(), 0.0, 1.0, 0.0);
    var camera = new ArcballCamera(defaultEye, center, up, 2, [canvas.width, canvas.height]);
	var proj = mat4.perspective(mat4.create(), 50 * Math.PI / 180.0,
		canvas.width / canvas.height, 0.1, 100);
	var projView = mat4.create();

	var controller = new Controller();
	controller.mousemove = function(prev, cur, evt) {
		if (evt.buttons == 1) {
			camera.rotate(prev, cur);

		} else if (evt.buttons == 2) {
			camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
		}
	};
	controller.wheel = function(amt) { camera.zoom(amt); };
	controller.pinch = controller.wheel;
	controller.twoFingerDrag = function(drag) { camera.pan(drag); };
	controller.registerForCanvas(canvas);

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
        renderPass.setBindGroup(0, bindGroup);
        renderPass.setIndexBuffer(indexBuf, 0, 0);
        renderPass.setVertexBuffer(0, vertexBuf, 0, 0);
        renderPass.setVertexBuffer(1, normalBuf, 0, 0);
        renderPass.drawIndexed(meshes[0].primitives[0].indices.count, 1, 0, 0, 0);

        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();



(async () => {
    if (!navigator.gpu) {
        alert("WebGPU is not supported/enabled in your browser");
        return;
    }

    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    var glbFile = await fetch("/models/2CylinderEngine.glb")
        .then(res => res.arrayBuffer());

    // The file header and chunk 0 header
    // TODO: It sounds like the spec does allow for multiple binary chunks,
    // so then how do you know which chunk a buffer exists in? Maybe the buffer id
    // corresponds to the binary chunk ID? Would have to find info in the spec
    // or an example file to check this
    var header = new Uint32Array(glbFile, 0, 5);
    if (header[0] != 0x46546C67) {
        alert("This does not appear to be a glb file?");
        return;
    }
    console.log(`GLB Version ${header[1]}, file length ${header[2]}`);
    console.log(`JSON chunk length ${header[3]}, type ${header[4]}`);
    var glbJsonData = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(glbFile, 20, header[3])));
    console.log(glbJsonData);

    var binaryHeader = new Uint32Array(glbFile, 20 + header[3], 2);
    var glbBuffer = new GLTFBuffer(glbFile, binaryHeader[0], 28 + header[3]);

    if (28 + header[3] + binaryHeader[0] != glbFile.byteLength) {
        console.log("TODO: Multiple binary chunks in file");
    }

    // TODO: Later could look at merging buffers and actually using the starting offsets,
    // but want to avoid uploading the entire buffer since it may contain packed images 
    var bufferViews = []
    for (var i = 0; i < glbJsonData.bufferViews.length; ++i) {
        bufferViews.push(new GLTFBufferView(glbBuffer, glbJsonData.bufferViews[i]));
    }
    console.log(bufferViews);

    var meshes = [];
    for (var i = 0; i < glbJsonData.meshes.length; ++i) {
        var mesh = glbJsonData.meshes[i];

        var primitives = []
        for (var j = 0; j < mesh.primitives.length; ++j) {
            var prim = mesh.primitives[j];
            if (prim["mode"] != undefined && prim["mode"] != 4) {
                alert("Ignoring primitive with unsupported mode " + prim["mode"]);
                continue;
            }

            var accessor = glbJsonData["accessors"][prim["indices"]]
            var viewID = accessor["bufferView"];
            bufferViews[viewID].needsUpload = true;
            bufferViews[viewID].addUsage(GPUBufferUsage.INDEX);
            var indices = new GLTFAccessor(bufferViews[viewID], accessor);

            accessor = glbJsonData["accessors"][prim["attributes"]["POSITION"]];
            viewID = accessor["bufferView"];
            bufferViews[viewID].needsUpload = true;
            bufferViews[viewID].addUsage(GPUBufferUsage.VERTEX);
            var positions = new GLTFAccessor(bufferViews[viewID], accessor);

            accessor = glbJsonData["accessors"][prim["attributes"]["NORMAL"]];
            viewID = accessor["bufferView"];
            bufferViews[viewID].needsUpload = true;
            bufferViews[viewID].addUsage(GPUBufferUsage.VERTEX);
            var normals = new GLTFAccessor(bufferViews[viewID], accessor);

            // TODO: Should instead loop through since there may be multiple texcoord attributes
            var texcoords = null;
            if (prim["attributes"]["TEXCOORD_0"] !== undefined) {
                accessor = glbJsonData["accessors"][prim["attributes"]["TEXCOORD_0"]];
                viewID = accessor["bufferView"];
                bufferViews[viewID].needsUpload = true;
                bufferViews[viewID].addUsage(GPUBufferUsage.VERTEX);
                texcoords = new GLTFAccessor(bufferViews[viewID], accessor);
            }

            var gltfPrim = new GLTFPrimitive(indices, positions, normals, texcoords);
            gltfPrim.upload(device);
            primitives.push(gltfPrim);
        }
        meshes.push(new GLTFMesh(mesh["name"], primitives));
    }
    console.log(meshes);

    // Upload the different views used by meshes
    for (var i = 0; i < bufferViews.length; ++i) {
        if (bufferViews[i].needsUpload) {
            bufferViews[i].upload(device);
        }
    }

    var nodeBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            }
        ]
    });

    var nodes = []
    var gltfNodes = makeGLTFSingleLevel(glbJsonData["nodes"]);
    for (var i = 0; i < gltfNodes.length; ++i) {
        var n = gltfNodes[i];
        if (n["mesh"] !== undefined) {
            var node = new GLTFNode(n["name"], meshes[n["mesh"]], readNodeTransform(n));
            node.upload(device, nodeBindGroupLayout);
            nodes.push(node);
        }
    }
    console.log(nodes);

    // Just a basic test for loading textures and using them: assume image 0 is the
    // one used by the model as its base color
    /*
    var imageTexture = null;
    {
        console.log("making img view");
        var imageView = new GLTFBufferView(glbBuffer, glbJsonData["bufferViews"][glbJsonData["images"][0]["bufferView"]]);
        console.log(imageView);
        var imgBlob = new Blob([imageView.buffer], {type: glbJsonData["images"][0]["mimeType"]});
        console.log(imgBlob);

        var img = await createImageBitmap(imgBlob);
        console.log(img);

        imageTexture = device.createTexture({
            size: [img.width, img.height, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.SAMPLED | GPUTextureUsage.COPY_DST,
        });

        var copySrc = {
            imageBitmap: img
        };
        var copyDst = {
            texture: imageTexture
        };
        device.defaultQueue.copyImageBitmapToTexture(copySrc, copyDst, [img.width, img.height, 1]);
    }
    */

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

    var vertModule = device.createShaderModule({code: glb_vert_spv});
    var fragModule = device.createShaderModule({code: glb_frag_spv});

    var sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear"
    });

    var bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            }
        ]
    });
    var layout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout, nodeBindGroupLayout]
    });

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
                    // TODO: Should use the view's stride when making bundles
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
                }/*,
                {
                    arrayStride: 2 * 4,
                    attributes: [
                        {
                            format: "float2",
                            offset: 0,
                            shaderLocation: 2
                        }
                    ]
                }
                */
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

    var renderBundle = null;
    {
        var bundleEncoder = device.createRenderBundleEncoder({
            colorFormats: [swapChainFormat],
            depthStencilFormat: "depth24plus-stencil8"
        });
        bundleEncoder.setPipeline(renderPipeline);
        bundleEncoder.setBindGroup(0, bindGroup);

        for (var i = 0; i < nodes.length; ++i) {
            var n = nodes[i];
            bundleEncoder.setBindGroup(1, n.bindGroup);
            for (var j = 0; j < n.mesh.primitives.length; ++j) {
                var p = n.mesh.primitives[j];
                bundleEncoder.setIndexBuffer(p.indices.view.gpuBuffer, p.indices.byteOffset, 0);
                bundleEncoder.setVertexBuffer(0, p.positions.view.gpuBuffer, p.positions.byteOffset, 0);
                bundleEncoder.setVertexBuffer(1, p.normals.view.gpuBuffer, p.normals.byteOffset, 0);
                if (p.texcoords) {
                    bundleEncoder.setVertexBuffer(2, p.texcoords.view.gpuBuffer, p.texcoords.byteOffset, 0);
                }
                bundleEncoder.drawIndexed(p.indices.count, 1, 0, 0, 0);
            }
        }
        renderBundle = bundleEncoder.finish();
    }

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
        renderPass.executeBundles([renderBundle]);

        /*
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(0, bindGroup);

        for (var i = 0; i < nodes.length; ++i) {
            var n = nodes[i];
            renderPass.setBindGroup(1, n.bindGroup);
            for (var j = 0; j < n.mesh.primitives.length; ++j) {
                var p = n.mesh.primitives[j];
                renderPass.setIndexBuffer(p.indices.view.gpuBuffer, p.indices.byteOffset, 0);
                renderPass.setVertexBuffer(0, p.positions.view.gpuBuffer, p.positions.byteOffset, 0);
                renderPass.setVertexBuffer(1, p.normals.view.gpuBuffer, p.normals.byteOffset, 0);
                if (p.texcoords) {
                    renderPass.setVertexBuffer(2, p.texcoords.view.gpuBuffer, p.texcoords.byteOffset, 0);
                }
                renderPass.drawIndexed(p.indices.count, 1, 0, 0, 0);
            }
        }
        */

        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();



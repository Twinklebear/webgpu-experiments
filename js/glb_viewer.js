(async () => {
    if (!navigator.gpu) {
        alert("WebGPU is not supported/enabled in your browser");
        return;
    }

    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    var glbFile = await fetch("/models/2CylinderEngine.glb")
    //var glbFile = await fetch("/models/suzanne.glb")
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

    var nodes = []
    var gltfNodes = makeGLTFSingleLevel(glbJsonData["nodes"]);
    for (var i = 0; i < gltfNodes.length; ++i) {
        var n = gltfNodes[i];
        if (n["mesh"] !== undefined) {
            var node = new GLTFNode(n["name"], meshes[n["mesh"]], readNodeTransform(n));
            node.upload(device);
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

    var shaderModules = {
        simpleVert: device.createShaderModule({code: glb_vert_spv}),
        simpleFrag: device.createShaderModule({code: glb_frag_spv}),
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

    var renderBundles = [];
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        var bundle = n.buildRenderBundle(device, shaderModules, viewParamsLayout, viewParamsBindGroup,
            swapChainFormat, "depth24plus-stencil8");
        renderBundles.push(bundle);
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
        renderPass.executeBundles(renderBundles);

        renderPass.endPass();
        device.defaultQueue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();



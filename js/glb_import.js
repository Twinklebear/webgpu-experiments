const GLTFRenderMode = {
    POINTS: 0,
    LINE: 1,
    LINE_LOOP: 2,
    LINE_STRIP: 3,
    TRIANGLES: 4,
    TRIANGLE_STRIP: 5,
    // Note: fans are not supported in WebGPU, use should be
    // an error or converted into a list/strip
    TRIANGLE_FAN: 6,
};

const GLTFComponentType = {
    BYTE: 5120,
    UNSIGNED_BYTE: 5121,
    SHORT: 5122,
    UNSIGNED_SHORT: 5123,
    INT: 5124,
    UNSIGNED_INT: 5125,
    FLOAT: 5126,
    DOUBLE: 5130,
};

const GLTFTextureFilter = {
    NEAREST: 9728,
    LINEAR: 9729,
    NEAREST_MIPMAP_NEAREST: 9984,
    LINEAR_MIPMAP_NEAREST: 9985,
    NEAREST_MIPMAP_LINEAR: 9986,
    LINEAR_MIPMAP_LINEAR: 9987,
};

const GLTFTextureWrap = {
    REPEAT: 10497,
    CLAMP_TO_EDGE: 33071,
    MIRRORED_REPEAT: 33648,
};

var gltfTypeNumComponents = function(type) {
    switch (type) {
        case "SCALAR": return 1;
        case "VEC2": return 2;
        case "VEC3": return 3;
        case "VEC4": return 4;
        default:
            alert("Unhandled glTF Type " + type);
            return null;
    }
}

var gltfTypeToWebGPU = function(componentType, type) {
    var typeStr = null;
    switch (componentType) {
        case GLTFComponentType.BYTE:
            typeStr = "char";
            break;
        case GLTFComponentType.UNSIGNED_BYTE:
            typeStr = "uchar";
            break;
        case GLTFComponentType.SHORT:
            typeStr = "short";
            break;
        case GLTFComponentType.UNSIGNED_SHORT:
            typeStr = "ushort";
            break;
        case GLTFComponentType.INT:
            typeStr = "int";
            break;
        case GLTFComponentType.UNSIGNED_INT:
            typeStr = "uint";
            break;
        case GLTFComponentType.FLOAT:
            typeStr = "float";
            break;
        case GLTFComponentType.DOUBLE:
            typeStr = "double";
            break;
        default:
            alert("Unrecognized GLTF Component Type?");
    }

    switch (gltfTypeNumComponents(type)) {
        case 1: return typeStr;
        case 2: return typeStr + "2";
        case 3: return typeStr + "3";
        case 4: return typeStr + "4";
        default: alert("Too many components!");
    }
}

var gltfTypeSize = function(componentType, type) {
    var typeSize = 0;
    switch (componentType) {
        case GLTFComponentType.BYTE:
            typeSize = 1;
            break;
        case GLTFComponentType.UNSIGNED_BYTE:
            typeSize = 1;
            break;
        case GLTFComponentType.SHORT:
            typeSize = 2;
            break;
        case GLTFComponentType.UNSIGNED_SHORT:
            typeSize = 2;
            break;
        case GLTFComponentType.INT:
            typeSize = 4;
            break;
        case GLTFComponentType.UNSIGNED_INT:
            typeSize = 4;
            break;
        case GLTFComponentType.FLOAT:
            typeSize = 4;
            break;
        case GLTFComponentType.DOUBLE:
            typeSize = 4;
            break;
        default:
            alert("Unrecognized GLTF Component Type?");
    }
    return gltfTypeNumComponents(type) * typeSize;
}

// Create a GLTFBuffer referencing some ArrayBuffer
var GLTFBuffer = function(buffer, size, offset) {
    this.arrayBuffer = buffer;
    this.size = size;
    this.byteOffset = offset;
}

var GLTFBufferView = function(buffer, view) {
    this.length = view["byteLength"];
    this.byteOffset = buffer.byteOffset;
    if (view["byteOffset"] !== undefined) {
        this.byteOffset += view["byteOffset"];
    }
    this.byteStride = 0;
    if (view["byteStride"] !== undefined) {
        this.byteStride = view["byteStride"];
    }
    this.buffer = new Uint8Array(buffer.arrayBuffer, this.byteOffset, this.length);

    this.needsUpload = false;
    this.gpuBuffer = null;
    this.usage = 0;
}

GLTFBufferView.prototype.arrayBuffer = function() {
    return this.buffer.buffer;
}

GLTFBufferView.prototype.addUsage = function(usage) {
    this.usage = this.usage | usage;
}

GLTFBufferView.prototype.upload = function(device) {
    var [buf, mapping] = device.createBufferMapped({
        size: this.buffer.byteLength,
        usage: this.usage,
    });
    new (this.buffer.constructor)(mapping).set(this.buffer);
    buf.unmap();
    this.gpuBuffer = buf;
}

var GLTFAccessor = function(view, accessor) {
    this.count = accessor["count"];
    this.componentType = accessor["componentType"];
    this.gltfType = accessor["type"];
    this.webGPUType = gltfTypeToWebGPU(this.componentType, accessor["type"]);
    this.numComponents = gltfTypeNumComponents(accessor["type"]);
    this.numScalars = this.count * this.numComponents;
    this.view = view;
    this.byteOffset = 0;
    if (accessor["byteOffset"] !== undefined) {
        this.byteOffset = accessor["byteOffset"];
    }
}

GLTFAccessor.prototype.byteStride = function() {
    var elementSize = gltfTypeSize(this.componentType, this.gltfType);
    return Math.max(elementSize, this.view.byteStride);
}

var GLTFPrimitive = function(indices, positions, normals, texcoords) {
    this.indices = indices;
    this.positions = positions;
    this.normals = normals;
    this.texcoords = texcoords;
    // TODO: material
}

// Build the primitive render commands into the bundle
GLTFPrimitive.prototype.buildRenderBundle = function(device, layout, bundleEncoder, shaderModules,
    swapChainFormat, depthFormat)
{
    var vertexBuffers = [
        {
            arrayStride: this.positions.byteStride(),
            attributes: [
                {
                    format: "float3",
                    offset: 0,
                    shaderLocation: 0
                }
            ]
        }
    ];
    // TODO: Are normals are always required for GLB? 
    if (this.normals) {
        vertexBuffers.push({
            arrayStride: this.normals.byteStride(),
            attributes: [
                {
                    format: "float3",
                    offset: 0,
                    shaderLocation: 1
                }
            ]
        });
    }
    /*
    if (this.texcoords) {
        vertexBuffers.push({
            arrayStride: this.texcoords.byteStride(),
            attributes: [
                {
                    format: "float2",
                    offset: 0,
                    shaderLocation: 2
                }
            ]
        });
    }
    */

    var indexFormat = this.indices.componentType == GLTFComponentType.UNSIGNED_SHORT ? "uint16" : "uint32";

    var renderPipeline = device.createRenderPipeline({
        layout: layout,
        vertexStage: {
            module: shaderModules.simpleVert,
            entryPoint: "main"
        },
        fragmentStage: {
            module: shaderModules.simpleFrag,
            entryPoint: "main"
        },
        primitiveTopology: "triangle-list",
        vertexState: {
            indexFormat: indexFormat,
            vertexBuffers: vertexBuffers,
        },
        colorStates: [{
            format: swapChainFormat
        }],
        depthStencilState: {
            format: depthFormat,
            depthWriteEnabled: true,
            depthCompare: "less"
        }
    });

    bundleEncoder.setPipeline(renderPipeline);
    bundleEncoder.setIndexBuffer(this.indices.view.gpuBuffer, this.indices.byteOffset, 0);
    bundleEncoder.setVertexBuffer(0, this.positions.view.gpuBuffer, this.positions.byteOffset, 0);
    bundleEncoder.setVertexBuffer(1, this.normals.view.gpuBuffer, this.normals.byteOffset, 0);
    if (this.texcoords) {
        bundleEncoder.setVertexBuffer(2, this.texcoords.view.gpuBuffer, this.texcoords.byteOffset, 0);
    }
    bundleEncoder.drawIndexed(this.indices.count, 1, 0, 0, 0);
}

var GLTFMesh = function(name, primitives) {
    this.name = name;
    this.primitives = primitives;
}

var GLTFNode = function(name, mesh, transform) {
    this.name = name;
    this.mesh = mesh;
    this.transform = transform;

    this.gpuUniforms = null;
    this.bindGroup = null;
}

GLTFNode.prototype.upload = function(device) {
    var [buf, mapping] = device.createBufferMapped({
        size: 4 * 4 * 4,
        usage: GPUBufferUsage.UNIFORM
    });
    new Float32Array(mapping).set(this.transform);
    buf.unmap();
    this.gpuUniforms = buf;
}

GLTFNode.prototype.buildRenderBundle = function(device, shaderModules, viewParamsLayout, viewParamsBindGroup,
    swapChainFormat, depthFormat)
{
    var nodeParamsLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                type: "uniform-buffer"
            }
        ]
    });

    this.bindGroup = device.createBindGroup({
        layout: nodeParamsLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: this.gpuUniforms
                }
            }
        ]
    });

    var layout = device.createPipelineLayout({
        bindGroupLayouts: [viewParamsLayout, nodeParamsLayout]
    });

    var bundleEncoder = device.createRenderBundleEncoder({
        colorFormats: [swapChainFormat],
        depthStencilFormat: depthFormat,
    });

    bundleEncoder.setBindGroup(0, viewParamsBindGroup);
    bundleEncoder.setBindGroup(1, this.bindGroup);

    for (var i = 0; i < this.mesh.primitives.length; ++i) {
        this.mesh.primitives[i].buildRenderBundle(device, layout, bundleEncoder, shaderModules,
            swapChainFormat, depthFormat);
    }

    this.renderBundle = bundleEncoder.finish();
    return this.renderBundle;
}

var readNodeTransform = function(node) {
    if (node["matrix"]) {
        var m = node["matrix"];
        // Both glTF and gl matrix are column major
        return mat4.fromValues(
            m[0], m[1], m[2], m[3],
            m[4], m[5], m[6], m[7],
            m[8], m[9], m[10], m[11],
            m[12], m[13], m[14], m[15]
        );
    } else {
        var scale = [1, 1, 1];
        var rotation = [0, 0, 0, 1];
        var translation = [0, 0, 0];
        if (node["scale"]) {
            scale = node["scale"];
        }
        if (node["rotation"]) {
            rotation = node["rotation"];
        }
        if (node["translation"]) {
            translation = node["translation"];
        }
        var m = mat4.create();
        return mat4.fromRotationTranslationScale(m, rotation, translation, scale);
    }
}

var flattenGLTFChildren = function(nodes, node, parent_transform) {
    var tfm = readNodeTransform(node);
    var tfm = mat4.mul(tfm, parent_transform, tfm);
    node["matrix"] = tfm;
    node["scale"] = undefined;
    node["rotation"] = undefined;
    node["translation"] = undefined;
    if (node["children"]) {
        for (var i = 0; i < node["children"].length; ++i) {
            flattenGLTFChildren(nodes, nodes[node["children"][i]], tfm);
        }
        node["children"] = [];
    }
}

var makeGLTFSingleLevel = function(nodes) {
    var rootTfm = mat4.create();
    for (var i = 0; i < nodes.length; ++i) {
        flattenGLTFChildren(nodes, nodes[i], rootTfm);
    }
    return nodes;
}


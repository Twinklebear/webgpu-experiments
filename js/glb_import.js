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

// Create a GLTFBuffer referencing some ArrayBuffer
var GLTFBuffer = function(buffer, size, offset) {
    this.arrayBuffer = buffer;
    this.size = size;
    this.offset = offset;
}

var GLTFBufferView = function(buffer, view) {
    this.length = view["byteLength"];
    this.offset = buffer.offset;
    if (view["byteOffset"]) {
        this.offset += view["byteOffset"];
    }
    this.buffer = new Uint8Array(buffer.arrayBuffer, this.offset, this.length);
}

GLTFBufferView.prototype.arrayBuffer = function() {
    return this.buffer.buffer;
}

var GLTFAccessor = function(view, accessor) {
    this.count = accessor["count"];
    this.componentType = accessor["componentType"];
    this.type = gltfTypeToWebGPU(this.componentType, accessor["type"]);
    this.numComponents = gltfTypeNumComponents(accessor["type"]);
    var numScalars = this.count * this.numComponents;
    switch (this.componentType) {
        case GLTFComponentType.BYTE:
            this.view = new Int8Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        case GLTFComponentType.UNSIGNED_BYTE:
            this.view = new Uint8Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        case GLTFComponentType.SHORT:
            this.view = new Int16Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        case GLTFComponentType.UNSIGNED_SHORT:
            this.view = new Uint16Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        case GLTFComponentType.INT:
            this.view = new Int32Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        case GLTFComponentType.UNSIGNED_INT:
            this.view = new Uint32Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        case GLTFComponentType.FLOAT:
            this.view = new Float32Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        case GLTFComponentType.DOUBLE:
            this.view = new Float64Array(view.arrayBuffer(), view.offset, numScalars);
            break;
        default:
            alert("Unrecognized GLTF Component Type?");
            return null;
    }
}

GLTFAccessor.prototype.byteLength = function() {
    return this.view.byteLength;
}

GLTFAccessor.prototype.upload = function(mapping) {
    new (this.view.constructor)(mapping).set(this.view);
}

var makeGLTFAccessor = function(buffer, view, accessor) {
    var bufView = new GLTFBufferView(buffer, view);
    return new GLTFAccessor(bufView, accessor);
}

var GLTFPrimitive = function(indices, positions, normals, texcoords) {
    this.indices = indices;
    this.positions = positions;
    this.normals = normals;
    this.texcoords = texcoords;

    this.gpuIndices = null;
    this.gpuPositions = null;
    this.gpuNormals = null;
    this.gpuTexcoords = null;
    // TODO: material
}

GLTFPrimitive.prototype.upload = function(device) {
    var [buf, mapping] = device.createBufferMapped({
        size: this.indices.byteLength(),
        usage: GPUBufferUsage.INDEX
    });
    this.indices.upload(mapping);
    buf.unmap();
    this.gpuIndices = buf; 

    var [buf, mapping] = device.createBufferMapped({
        size: this.positions.byteLength(),
        usage: GPUBufferUsage.VERTEX
    });
    this.positions.upload(mapping);
    buf.unmap();
    this.gpuPositions = buf;

    var [buf, mapping] = device.createBufferMapped({
        size: this.normals.byteLength(),
        usage: GPUBufferUsage.VERTEX
    });
    this.normals.upload(mapping);
    buf.unmap();
    this.gpuNormals = buf;

    var [buf, mapping] = device.createBufferMapped({
        size: this.texcoords.byteLength(),
        usage: GPUBufferUsage.VERTEX
    });
    this.texcoords.upload(mapping);
    buf.unmap();
    this.gpuTexcoords = buf;
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

GLTFNode.prototype.upload = function(device, bindGroupLayout) {
    var [buf, mapping] = device.createBufferMapped({
        size: 4 * 4 * 4,
        usage: GPUBufferUsage.UNIFORM
    });
    new Float32Array(mapping).set(this.transform);
    buf.unmap();
    this.gpuUniforms = buf;

    this.bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 1,
                resource: {
                    buffer: this.gpuUniforms
                }
            }
        ]
    });
}

var readNodeTransform = function(node) {
    if (node["matrix"]) {
        var m = node["matrix"];
        // Both glTF and gl matrix are column major
        return mat4.fromValues(
            m[0], m[1], m[2], m[3],
            m[4], m[5], m[6], m[7],
            m[8], m[9], m[10], m[11],
            m[12], m[13], m[14], m[14]
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

var makeGLTFSingleLevel = function(nodes) {
    var singleLevel = {};
    // TODO
    return nodes;
}


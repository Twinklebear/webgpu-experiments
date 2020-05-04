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
var GLTFBuffer = function(buffer, size) {
    this.buffer = buffer;
    this.size = size;
}

var GLTFBufferView = function(buffer, view) {
    this.buffer = new Uint8Array(buffer.buffer, view["byteOffset"], view["byteLength"]);
    this.length = view["byteLength"];
    this.offset = view["byteOffset"];
}

var GLTFAccessor = function(view, accessor) {
    this.count = accessor["count"];
    this.componentType = accessor["componentType"];
    this.type = gltfTypeToWebGPU(this.componentType, accessor["type"]);
    this.numComponents = gltfTypeNumComponents(accessor["type"]);
    var numScalars = this.count * this.numComponents;
    switch (this.componentType) {
        case GLTFComponentType.BYTE:
            this.view = new Int8Array(view.buffer.buffer, view.offset, numScalars);
            break;
        case GLTFComponentType.UNSIGNED_BYTE:
            this.view = new Uint8Array(view.buffer.buffer, view.offset, numScalars);
            break;
        case GLTFComponentType.SHORT:
            this.view = new Int16Array(view.buffer.buffer, view.offset, numScalars);
            break;
        case GLTFComponentType.UNSIGNED_SHORT:
            this.view = new Uint16Array(view.buffer.buffer, view.offset, numScalars);
            break;
        case GLTFComponentType.INT:
            this.view = new Int32Array(view.buffer.buffer, view.offset, numScalars);
            break;
        case GLTFComponentType.UNSIGNED_INT:
            this.view = new Uint32Array(view.buffer.buffer, view.offset, numScalars);
            break;
        case GLTFComponentType.FLOAT:
            this.view = new Float32Array(view.buffer.buffer, view.offset, numScalars);
            break;
        case GLTFComponentType.DOUBLE:
            this.view = new Float64Array(view.buffer.buffer, view.offset, numScalars);
            break;
        default:
            alert("Unrecognized GLTF Component Type?");
            return null;
    }
}

GLTFAccessor.prototype.byteLength = function() {
    return this.view.byteLength;
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
}

var GLTFMesh = function(name, primitives) {
    this.name = name;
    this.primitives = primitives;
}


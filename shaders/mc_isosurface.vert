#version 450 core

layout(location = 0) in vec3 pos;

layout(location = 0) out vec3 vpos;

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 view_proj;
};

layout(set = 0, binding = 1, std140) uniform VolumeInfo {
    uvec4 volume_dims;
    float isovalue;
};

void main(void) {
    vpos = pos;
    gl_Position = view_proj * vec4(pos / vec3(volume_dims.xyz) - 0.5, 1);
}

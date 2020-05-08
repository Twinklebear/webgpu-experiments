#version 450 core

layout(location = 0) in vec3 pos;

layout(location = 0) out vec4 world_pos;

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 proj_view;
    vec4 eye_pos;
};

layout(set = 0, binding = 1, std140) uniform VolumeInfo {
    uvec4 volume_dims;
    float isovalue;
};

void main(void) {
    world_pos = vec4(pos / vec3(volume_dims.xyz) - 0.5, 1);
    gl_Position = proj_view * world_pos;
}

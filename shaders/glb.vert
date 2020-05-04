#version 450 core

layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 normal;
// TODO: For models missing uvs we need separate render pipeline and shader set
layout(location = 2) in vec2 uv;

layout(location = 0) out vec3 vnormal;
layout(location = 1) out vec2 vuv;

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 view_proj;
};

layout(set = 1, binding = 0, std140) uniform NodeParams {
    mat4 model;
};

void main(void) {
    vnormal = normal;
    vuv = uv;
    gl_Position = view_proj * model * vec4(pos, 1);
}


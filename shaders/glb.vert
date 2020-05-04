#version 450 core

layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;

layout(location = 0) out vec3 vnormal;
layout(location = 1) out vec2 vuv;

layout(binding = 0, std140) uniform ViewParams {
    mat4 view_proj;
};

void main(void) {
    vnormal = normal;
    vuv = uv;
    gl_Position = view_proj * vec4(pos, 1);
}


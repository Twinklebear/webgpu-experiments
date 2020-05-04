#version 450 core

layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 normal;

layout(location = 0) out vec3 vnormal;

layout(binding = 0, std140) uniform ViewParams {
    mat4 view_proj;
};

void main(void) {
    vnormal = normal;
    gl_Position = view_proj * vec4(pos, 1);
}


#version 450 core

layout(location = 0) in vec3 vnormal;

layout(location = 0) out vec4 color;

void main(void) {
    color = vec4(0.5 * vnormal + 1.0, 1.0);
}


#version 450 core

layout(location = 0) in vec3 vcolor;

layout(location = 0) out vec4 color;

void main(void) {
    color = vec4(vcolor, 1.0);
}


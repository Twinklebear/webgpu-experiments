#version 450 core

layout(location = 0) in vec3 pos;
layout(location = 1) in vec4 color;

layout(location = 0) out vec4 vcolor;

void main(void) {
    vcolor = color;
    gl_Position = vec4(pos, 1.0);
}


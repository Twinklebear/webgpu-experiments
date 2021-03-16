#version 450 core

layout(location = 0) in vec4 vcolor;

layout(location = 0) out vec4 color;

layout(set = 0, binding = 0) buffer ColorBuffer {
    vec4 bcolor;
};

void main(void) {
    //color = vcolor;
    color = bcolor;
}


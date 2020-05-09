#version 450 core

layout(location = 0) out vec4 color;
#ifdef COLOR_ATTRIB
layout(location = 1) in vec4 vcolor;
#endif

void main(void) {
#ifdef COLOR_ATTRIB
    color = vec4(vcolor.xyz, 1);
#else
    color = vec4(1, 0, 0, 1);
#endif
}


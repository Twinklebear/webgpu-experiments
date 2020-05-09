#version 450 core

layout(location = 0) out vec4 color;

layout(location = 0) flat in vec3 center;
layout(location = 1) in vec3 vpos;

#ifdef COLOR_ATTRIB
layout(location = 2) in vec4 vcolor;
#endif

layout(set = 0, binding = 1, std140) uniform LASInfo {
    vec4 box_lower;
    vec4 box_upper;
    float radius;
    int pt_mode;
};

void main(void) {
#ifdef COLOR_ATTRIB
    color = vec4(vcolor.xyz, 1);
#else
    color = vec4(1, 0, 0, 1);
#endif

    if (pt_mode == 1 && length(vpos - center) > radius) {
        discard;
    }
}


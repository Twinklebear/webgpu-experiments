#version 450 core

layout(location = 0) in vec3 pos;

#ifdef COLOR_ATTRIB
layout(location = 1) in vec4 color;
layout(location = 1) out vec4 vcolor;
#endif

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 view_proj;
};

layout(set = 0, binding = 1, std140) uniform LASInfo {
    vec4 box_lower;
    vec4 box_upper;
};

void main(void) {
#ifdef COLOR_ATTRIB
    vcolor = color;
#endif
    // Rescale the data to center at the origin
    vec3 size = normalize(box_upper.xyz - box_lower.xyz);
    vec3 p = size * (pos - box_lower.xyz) / (box_upper.xyz - box_lower.xyz) - vec3(0.5) * size;
    gl_Position = view_proj * vec4(p, 1);
}


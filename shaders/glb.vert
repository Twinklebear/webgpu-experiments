#version 450 core

layout(location = 0) in vec3 pos;

#ifdef NORMAL_ATTRIB
layout(location = 1) in vec3 normal;
#endif
#ifdef UV_ATTRIB
layout(location = 2) in vec2 uv;
#endif

#ifdef NORMAL_ATTRIB
layout(location = 0) out vec3 vnormal;
#endif
#ifdef UV_ATTRIB
layout(location = 1) out vec2 vuv;
#endif

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 view_proj;
};

layout(set = 1, binding = 0, std140) uniform NodeParams {
    mat4 model;
};

void main(void) {
#ifdef NORMAL_ATTRIB
    vnormal = normal;
#endif
#ifdef UV_ATTRIB
    vuv = uv;
#endif

    gl_Position = view_proj * model * vec4(pos, 1);
}


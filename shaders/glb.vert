#version 450 core

layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 normal;
// TODO: For models missing uvs we need separate render pipeline and shader set
layout(location = 2) in vec2 uv;

layout(location = 0) out vec3 vnormal;
layout(location = 1) out vec2 vuv;

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 view_proj;
};

// It seems that set = 1, binding = 0 doesn't work, giving me
// an error of: stage not compatible. So the set index corresponding
// to the bind group index in the bind group layout makes sense.
// However, if I do set = 1, binding = 0 this also gives an error that
// I'm setting a non-existant binding. If I use set 1 and set binding 1, it works?
// But it's not a set == binding thing, because I can use binding = 1 for the ViewParams
// and add some test other buffer on set = 1, binding = 2.
layout(set = 1, binding = 1, std140) uniform NodeParams {
    mat4 model;
};

void main(void) {
    vnormal = normal;
    vuv = uv;
    gl_Position = view_proj * model * vec4(pos, 1);
}


#version 450 core

const vec2 quad[4] = {
    vec2(-1, -1),
    vec2(1, -1),
    vec2(-1, 1),
    vec2(1, 1)
};

layout(location = 0) in vec3 pos;

layout(location = 0) flat out vec3 center;
layout(location = 1) out vec3 vpos;

#ifdef COLOR_ATTRIB
layout(location = 1) in vec4 color;
layout(location = 2) out vec4 vcolor;
#endif

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 proj_view;
    vec4 eye_pos;
};

layout(set = 0, binding = 1, std140) uniform LASInfo {
    vec4 box_lower;
    vec4 box_upper;
    float radius;
    int pt_mode;
};

void ortho_basis(out vec3 v_x, out vec3 v_y, const vec3 v_z) {
    v_y = vec3(0, 0, 0);

    if (v_z.x < 0.6f && v_z.x > -0.6f) {
        v_y.x = 1.f;
    } else if (v_z.y < 0.6f && v_z.y > -0.6f) {
        v_y.y = 1.f;
    } else if (v_z.z < 0.6f && v_z.z > -0.6f) {
        v_y.z = 1.f;
    } else {
        v_y.x = 1.f;
    }
    v_x = normalize(cross(v_y, v_z));
    v_y = normalize(cross(v_z, v_x));
}

void main(void) {
#ifdef COLOR_ATTRIB
    vcolor = color;
#endif
    // Recenter the data about the origin
    vec3 p = pos - box_lower.xyz - 0.5 * (box_upper.xyz - box_lower.xyz);
    center = p;

    // Build the quad coordinate frame
    vec3 v_z = normalize(p - eye_pos.xyz);
    vec3 v_x, v_y;
    ortho_basis(v_x, v_y, v_z);
    p = p + radius * v_x * quad[gl_VertexIndex].x + radius * v_y * quad[gl_VertexIndex].y;
    vpos = p;

    gl_Position = proj_view * vec4(p, 1);
}


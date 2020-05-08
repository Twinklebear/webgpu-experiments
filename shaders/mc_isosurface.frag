#version 450 core

layout(location = 0) in vec4 world_pos;

layout(location = 0) out vec4 color;

layout(set = 0, binding = 0, std140) uniform ViewParams {
    mat4 proj_view;
    vec4 eye_pos;
};

void main(void) {
    vec3 v = -normalize(world_pos.xyz - eye_pos.xyz); 
    vec3 light_dir = v;
    vec3 n = normalize(cross(dFdx(world_pos.xyz), dFdy(world_pos.xyz)));
    if (dot(n, light_dir) < 0.0) {
        n = -n;
    }

    vec3 base_color = vec3(0.3, 0.3, 0.9);
    vec3 h = normalize(v + light_dir);

    // Just some Blinn-Phong shading
    color.rgb = base_color * 0.2f;
    color.rgb += 0.6 * clamp(dot(light_dir, n), 0.f, 1.f) * base_color;
    color.rgb += 0.4 * pow(clamp(dot(n, h), 0.f, 1.f), 25.f);

    color.a = 1.0;
}


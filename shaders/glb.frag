#version 450 core

#ifdef NORMAL_ATTRIB
layout(location = 0) in vec3 vnormal;
#endif
#ifdef UV_ATTRIB
layout(location = 1) in vec2 vuv;
#endif

layout(location = 0) out vec4 color;

layout(set = 2, binding = 0, std140) uniform MaterialParams {
    vec4 base_color_factor;
    vec4 emissive_factor;
    float metallic_factor;
    float roughness_factor;
};

#ifdef BASE_COLOR_TEXTURE
layout(set = 2, binding = 1) uniform sampler base_color_sampler;
layout(set = 2, binding = 2) uniform texture2D base_color_texture;
#endif

float linear_to_srgb(float x) {
	if (x <= 0.0031308f) {
		return 12.92f * x;
	}
	return 1.055f * pow(x, 1.f / 2.4f) - 0.055f;
}

void main(void) {
    color = vec4(base_color_factor.xyz, 1);
    /*
#ifdef NORMAL_ATTRIB
    color = vec4(0.5 * (vnormal + 1.0), 1.0);
#endif
#ifdef UV_ATTRIB
    color = vec4(vuv, 0, 1.0);
#endif
*/
#ifdef BASE_COLOR_TEXTURE
    vec4 texture_color = texture(sampler2D(base_color_texture, base_color_sampler), vuv);
    if (texture_color.a < 0.001) {
        discard;
    }
    color = vec4(base_color_factor.xyz * texture_color.xyz, 1);
#endif

    color.x = linear_to_srgb(color.x);
    color.y = linear_to_srgb(color.y);
    color.z = linear_to_srgb(color.z);
}


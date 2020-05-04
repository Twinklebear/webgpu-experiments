#version 450 core

#ifdef NORMAL_ATTRIB
layout(location = 0) in vec3 vnormal;
#endif
#ifdef UV_ATTRIB
layout(location = 1) in vec2 vuv;
#endif

layout(location = 0) out vec4 color;

/*
layout(binding = 1) uniform sampler texture_sampler;
layout(binding = 2) uniform texture2D image_texture;
*/

void main(void) {
    color = vec4(1);
#ifdef NORMAL_ATTRIB
    color = vec4(0.5 * (vnormal + 1.0), 1.0);
#endif
#ifdef UV_ATTRIB
    color = vec4(vuv, 0, 1.0);
#endif
    //color = vec4(texture(sampler2D(image_texture, texture_sampler), vuv).rgb, 1);
}


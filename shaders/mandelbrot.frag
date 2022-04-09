#version 450 core

#extension GL_EXT_samplerless_texture_functions : require

layout(location = 0) out vec4 color;

layout(binding = 0) uniform texture2D output_texture;

void main(void) {
    color = texelFetch(output_texture, ivec2(gl_FragCoord.xy), 0);
    color.a = 1.f;
}


#version 450 core

layout(location = 0) in vec3 vpos;

layout(location = 0) out vec4 color;

void main(void) {
    vec3 normal = normalize(cross(dFdx(vpos), dFdy(vpos)));
    color = vec4((normal + 1.0) * 0.5, 1);
}


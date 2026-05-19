// GLSL source strings — inline for now, extract to shaders/ when they grow.

// Passthrough vertex shader for screen-space geometry (passepartout ring, etc.)
// Accepts pre-computed NDC coordinates — no matrix uniforms needed.
const VERT_PASSE = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const VERT_SCENE = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;

uniform mat3 uViewMatrix;    // viewport: world → NDC  (once per frame)
uniform mat3 uModelMatrix;   // instance: local → world (once per draw call)

void main() {
    vec3 world  = uModelMatrix * vec3(aPosition, 1.0);
    vec3 clip   = uViewMatrix  * world;
    gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`

const FRAG_SCENE = /* glsl */`#version 300 es
precision highp float;

uniform vec4 uColor;
out vec4 fragColor;

void main() {
    fragColor = uColor;
}
`

export { VERT_SCENE, FRAG_SCENE, VERT_PASSE }

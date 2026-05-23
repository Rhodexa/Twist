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

// Checkerboard background — screen-space, fixed tile, dark-mode palette.
// Two uniforms: uScale (tile size px), uOpacity (blended over cleared bg).
const FRAG_CHECKER = /* glsl */`#version 300 es
precision highp float;

uniform float uScale;
uniform float uOpacity;

out vec4 fragColor;

void main() {
    vec2  cell    = floor(gl_FragCoord.xy / uScale);
    float checker = mod(cell.x + cell.y, 2.0);
    vec3  col     = mix(vec3(0.094), vec3(0.157), checker);
    fragColor = vec4(col, uOpacity);
}
`

export { VERT_SCENE, FRAG_SCENE, VERT_PASSE, FRAG_CHECKER }

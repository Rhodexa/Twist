// GLSL source strings — inline for now, extract to shaders/ when they grow.

// Passthrough vertex shader for screen-space geometry (passepartout ring, etc.)
// Accepts pre-computed NDC coordinates — no matrix uniforms needed.
const VERT_PASSE = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vLocalPos;
out vec4 vVertColor;
void main() {
    vLocalPos   = aPosition;
    vVertColor  = vec4(0.0);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

// Scene vertex shader — emits vLocalPos (for gradient sampling) and vVertColor
// (for batched solid fills where per-vertex RGBA is stored in the VBO).
const VERT_SCENE = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec4 aColor;     // per-vertex RGBA; only read when uFillType == 3

uniform mat3 uViewMatrix;    // viewport: world → NDC  (once per frame)
uniform mat3 uModelMatrix;   // instance: local → world (once per draw call)

out vec2 vLocalPos;
out vec4 vVertColor;

void main() {
    vLocalPos   = aPosition;
    vVertColor  = aColor;
    vec3 world  = uModelMatrix * vec3(aPosition, 1.0);
    vec3 clip   = uViewMatrix  * world;
    gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`

// Scene fragment shader.
//
// uFillType:
//   0 = solid uniform colour (uColor)              — masks, highlights, legacy
//   1 = linear gradient                            — Flash LinearGradient
//   2 = radial gradient                            — Flash RadialGradient
//   3 = vertex colour (vVertColor)                 — batched solid fills
//
// Gradient coordinate system (Flash):
//   LinearGradient: x runs −819.2 → +819.2 along the gradient axis at y=0.
//   RadialGradient: centre (0,0), radius 819.2.
//   uGradMatInv maps from symbol-local space → gradient space (pre-inverted on CPU).
//
// Up to 16 stops per gradient (Flash maximum).
const FRAG_SCENE = /* glsl */`#version 300 es
precision highp float;

in vec2 vLocalPos;
in vec4 vVertColor;

uniform int   uFillType;           // 0=solid uniform, 1=linear, 2=radial, 3=vertex colour
uniform vec4  uColor;              // used when uFillType == 0
uniform mat3  uGradMatInv;         // symbol-local → gradient space
uniform int   uStopCount;
uniform float uStopOffsets[16];
uniform vec4  uStopColors[16];

out vec4 fragColor;

vec4 sampleGradient(float t) {
    t = clamp(t, 0.0, 1.0);
    if (uStopCount == 0) return vec4(0.0);
    if (t <= uStopOffsets[0]) return uStopColors[0];
    for (int i = 1; i < 16; i++) {
        if (i >= uStopCount) break;
        if (t <= uStopOffsets[i]) {
            float denom = uStopOffsets[i] - uStopOffsets[i - 1];
            float f     = denom > 0.0001 ? (t - uStopOffsets[i - 1]) / denom : 0.0;
            return mix(uStopColors[i - 1], uStopColors[i], f);
        }
    }
    return uStopColors[uStopCount - 1];
}

void main() {
    if (uFillType == 0) {
        fragColor = uColor;
    } else if (uFillType == 3) {
        fragColor = vVertColor;
    } else {
        vec3  gpos = uGradMatInv * vec3(vLocalPos, 1.0);
        float t;
        if (uFillType == 1) {
            t = (gpos.x + 819.2) / 1638.4;
        } else {
            t = length(gpos.xy) / 819.2;
        }
        fragColor = sampleGradient(t);
    }
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

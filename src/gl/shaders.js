// GLSL source strings — inline for now, extract to files/ when they grow.

// Renders a 2D mesh in world space, transformed by the viewport's view matrix.
// layout(location = 0) pins aPosition to attribute slot 0, matching the VAO
// setup in viewport.js without needing a gl.getAttribLocation() call.

const VERT_SCENE = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;

uniform mat3 uWorldToClip;

void main() {
    vec3 clip   = uWorldToClip * vec3(aPosition, 1.0);
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

export { VERT_SCENE, FRAG_SCENE }

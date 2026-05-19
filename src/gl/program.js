// WebGL2 shader compilation and program linking utilities.

function compileShader(gl, type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(shader)
        gl.deleteShader(shader)
        throw new Error(`Shader compile error:\n${err}`)
    }
    return shader
}

function createProgram(gl, vertSrc, fragSrc) {
    const vert    = compileShader(gl, gl.VERTEX_SHADER,   vertSrc)
    const frag    = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
    const program = gl.createProgram()

    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)

    // Shaders are baked into the program — the originals can go
    gl.deleteShader(vert)
    gl.deleteShader(frag)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const err = gl.getProgramInfoLog(program)
        gl.deleteProgram(program)
        throw new Error(`Program link error:\n${err}`)
    }

    return program
}

export { createProgram }

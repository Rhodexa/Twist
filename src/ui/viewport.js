// WebGL2 canvas (scene) + Canvas2D overlay (editor UI).
// Owns: GL context, view transform, pan/zoom input, camera frame rendering.

import scene                    from '../scene/scene.js'
import { createProgram }        from '../gl/program.js'
import { VERT_SCENE, FRAG_SCENE } from '../gl/shaders.js'

// ── Canvas setup ──────────────────────────────────────────────────────────

const container = document.getElementById('viewport-container')
const canvas    = document.getElementById('viewport-canvas')
const gl        = canvas.getContext('webgl2')

if (!gl) throw new Error('WebGL2 not available.')

// Overlay: a 2D canvas for editor UI (camera frame, handles, guides).
// pointer-events:none so clicks fall through to the WebGL canvas below.
const overlay         = document.createElement('canvas')
overlay.id            = 'overlay-canvas'
overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
container.appendChild(overlay)
const ctx2d = overlay.getContext('2d')

// ── CSS var helper ────────────────────────────────────────────────────────

function cssVarToGL(varName) {
    const hex = getComputedStyle(document.documentElement)
        .getPropertyValue(varName).trim()
    return [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
    ]
}

// ── View transform ────────────────────────────────────────────────────────
// The VIEWPORT camera — the editor's eye. Independent of scene.camera.
//
// view.x / view.y: pan offset in CSS pixels from the canvas centre.
// view.zoom: scale — 1.0 means 1 world unit = 1 CSS pixel.
//
// Y convention: world Y+ is DOWN, matching screen / canvas coordinates.
// World (0, 0) is the scene origin; camera frame is centred there by default.

const view = { x: 0, y: 0, zoom: 1.0 }

const MIN_ZOOM = 0.01
const MAX_ZOOM = 64.0

// Current canvas size in CSS pixels — updated by _resize().
// Module-level private state, like static members in C++.
let cssW = 0
let cssH = 0

function worldToScreen(wx, wy) {
    return {
        x: wx * view.zoom + view.x + cssW / 2,
        y: wy * view.zoom + view.y + cssH / 2,
    }
}

function screenToWorld(sx, sy) {
    return {
        x: (sx - cssW / 2 - view.x) / view.zoom,
        y: (sy - cssH / 2 - view.y) / view.zoom,
    }
}

// Builds the world→clip matrix for the vertex shader.
// WebGL clip space: X in [-1,1] left→right, Y in [-1,1] bottom→top.
// Screen space: Y increases downward, so we negate the Y scale.
// Result is a column-major Float32Array for gl.uniformMatrix3fv.
function worldToClipMatrix() {
    const sx = 2 * view.zoom / cssW    // world X → NDC X scale
    const sy = 2 * view.zoom / cssH    // world Y → NDC Y scale (negated below)
    const tx = 2 * view.x    / cssW    // pan X → NDC X offset
    const ty = 2 * view.y    / cssH    // pan Y → NDC Y offset (negated below)
    return new Float32Array([
        sx,   0,  0,   // column 0
        0,  -sy,  0,   // column 1 — negative: screen Y↓ becomes clip Y↑
        tx, -ty,  1,   // column 2 — translation
    ])
}

function fitCamera() {
    const padding = 48
    const cam     = scene.camera
    view.zoom = Math.min(
        (cssW - padding * 2) / cam.width,
        (cssH - padding * 2) / cam.height
    )
    view.x = -cam.x * view.zoom
    view.y = -cam.y * view.zoom
    viewport.markDirty()
}

// ── Pan / zoom input ──────────────────────────────────────────────────────

let isPanning  = false
let panOriginX = 0
let panOriginY = 0
let panMouseX  = 0
let panMouseY  = 0
let spaceDown  = false

window.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat) { spaceDown = true; e.preventDefault() }
})
window.addEventListener('keyup', e => {
    if (e.code === 'Space') { spaceDown = false; _stopPan() }
})

function _startPan(e) {
    isPanning  = true
    panOriginX = view.x
    panOriginY = view.y
    panMouseX  = e.clientX
    panMouseY  = e.clientY
    canvas.style.cursor = 'grabbing'
    canvas.setPointerCapture(e.pointerId)
}

function _movePan(e) {
    view.x = panOriginX + (e.clientX - panMouseX)
    view.y = panOriginY + (e.clientY - panMouseY)
    viewport.markDirty()
}

function _stopPan(e) {
    if (!isPanning) return
    isPanning = false
    if (e) canvas.releasePointerCapture(e.pointerId)
    canvas.style.cursor = ''
}

canvas.addEventListener('pointerdown', e => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
        e.preventDefault()
        _startPan(e)
    }
})
canvas.addEventListener('pointermove',   e => { if (isPanning) _movePan(e) })
canvas.addEventListener('pointerup',     e => { if (isPanning) _stopPan(e) })
canvas.addEventListener('pointercancel', e => { if (isPanning) _stopPan(e) })

canvas.addEventListener('wheel', e => {
    e.preventDefault()
    const rect    = canvas.getBoundingClientRect()
    const cx      = e.clientX - rect.left
    const cy      = e.clientY - rect.top
    const factor  = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const oldZoom = view.zoom

    const wx = (cx - cssW / 2 - view.x) / view.zoom
    const wy = (cy - cssH / 2 - view.y) / view.zoom

    view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor))
    view.x   += wx * (oldZoom - view.zoom)
    view.y   += wy * (oldZoom - view.zoom)
    viewport.markDirty()
}, { passive: false })

// ── GL state (populated by init) ──────────────────────────────────────────

let _prog     = null
let _uniforms = null
let _testVao  = null
const _testVertexCount = 6

// ── Rendering ─────────────────────────────────────────────────────────────

const viewport = {
    gl, canvas, overlay, ctx2d,
    view, worldToScreen, screenToWorld, fitCamera,

    get cssWidth()  { return cssW },
    get cssHeight() { return cssH },

    dirty: true,

    markDirty() { this.dirty = true },

    _resize() {
        const dpr = window.devicePixelRatio || 1
        const cw  = container.clientWidth
        const ch  = container.clientHeight
        if (cssW === cw && cssH === ch) return

        cssW = cw
        cssH = ch

        for (const c of [canvas, overlay]) {
            c.width        = Math.round(cw * dpr)
            c.height       = Math.round(ch * dpr)
            c.style.width  = cw + 'px'
            c.style.height = ch + 'px'
        }

        this.dirty = true
    },

    _renderScene() {
        gl.viewport(0, 0, canvas.width, canvas.height)

        const [r, g, b] = cssVarToGL('--bg-base')
        gl.clearColor(r, g, b, 1.0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        if (!_prog) return

        gl.useProgram(_prog)
        gl.uniformMatrix3fv(_uniforms.worldToClip, false, worldToClipMatrix())

        // Test shape — placeholder until the scene graph renders real symbols
        gl.uniform4f(_uniforms.color, 0.42, 0.38, 0.72, 1.0)   // soft purple
        gl.bindVertexArray(_testVao)
        gl.drawArrays(gl.TRIANGLES, 0, _testVertexCount)
        gl.bindVertexArray(null)
    },

    _renderOverlay() {
        const dpr = window.devicePixelRatio || 1
        const cam = scene.camera

        ctx2d.save()
        ctx2d.scale(dpr, dpr)
        ctx2d.clearRect(0, 0, cssW, cssH)

        const tl = worldToScreen(cam.x - cam.width  / 2, cam.y - cam.height / 2)
        const br = worldToScreen(cam.x + cam.width  / 2, cam.y + cam.height / 2)
        const fw = br.x - tl.x
        const fh = br.y - tl.y

        ctx2d.fillStyle = 'rgba(0,0,0,0.55)'
        ctx2d.fillRect(0,     0,     cssW,        tl.y)
        ctx2d.fillRect(0,     br.y,  cssW,        cssH - br.y)
        ctx2d.fillRect(0,     tl.y,  tl.x,        fh)
        ctx2d.fillRect(br.x,  tl.y,  cssW - br.x, fh)

        ctx2d.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx2d.lineWidth   = 1
        ctx2d.strokeRect(
            Math.round(tl.x) + 0.5,
            Math.round(tl.y) + 0.5,
            Math.round(fw),
            Math.round(fh)
        )

        ctx2d.restore()
    },

    _render() {
        if (!this.dirty) return
        this.dirty = false
        this._renderScene()
        this._renderOverlay()
    },

    init() {
        // Shader program
        _prog     = createProgram(gl, VERT_SCENE, FRAG_SCENE)
        _uniforms = {
            worldToClip: gl.getUniformLocation(_prog, 'uWorldToClip'),
            color:       gl.getUniformLocation(_prog, 'uColor'),
        }

        // Test shape: a 400×300 rect in world space, centred at origin.
        // Two triangles (6 vertices), wound counter-clockwise.
        // Replace this with real scene rendering once symbols exist.
        const vbo = gl.createBuffer()
        _testVao  = gl.createVertexArray()

        gl.bindVertexArray(_testVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -200, -150,    200, -150,    200,  150,
            -200, -150,    200,  150,   -200,  150,
        ]), gl.STATIC_DRAW)

        // Attribute 0 matches layout(location = 0) in the vertex shader
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)

        // Resize + fit before starting the loop
        const observer = new ResizeObserver(() => { this._resize(); this.markDirty() })
        observer.observe(container)
        this._resize()
        fitCamera()

        const loop = () => { this._render(); requestAnimationFrame(loop) }
        requestAnimationFrame(loop)
    }
}

export { view, worldToScreen, screenToWorld, fitCamera }
export default viewport

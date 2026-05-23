// WebGL2 canvas (scene) + Canvas2D overlay (editor UI).
// Owns: GL context, view transform, pan/zoom, selection, drag, playback timing.

import scene                      from '../scene/scene.js'
import journal                    from '../journal/journal.js'
import { createProgram }          from '../gl/program.js'
import { VERT_SCENE, FRAG_SCENE, VERT_PASSE } from '../gl/shaders.js'
import { evaluateInstance }       from '../scene/evaluate.js'

// ── Canvas setup ──────────────────────────────────────────────────────────

const container = document.getElementById('viewport-container')
const canvas    = document.getElementById('viewport-canvas')
const gl        = canvas.getContext('webgl2')

if (!gl) throw new Error('WebGL2 not available.')

const overlay         = document.createElement('canvas')
overlay.id            = 'overlay-canvas'
overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
container.appendChild(overlay)
const ctx2d = overlay.getContext('2d')

// ── Mat3 helpers (column-major Float32Array, matches GLSL mat3) ───────────

const _IDENTITY_GL = new Float32Array([1,0,0, 0,1,0, 0,0,1])

// Compose two column-major mat3s: result = A * B
function composeMat3(A, B) {
    const R = new Float32Array(9)
    for (let c = 0; c < 3; c++)
        for (let r = 0; r < 3; r++)
            R[c*3+r] = A[0*3+r]*B[c*3+0] + A[1*3+r]*B[c*3+1] + A[2*3+r]*B[c*3+2]
    return R
}

// Invert a 2D affine mat3 (column-major). Returns null if singular.
function invertMat3(m) {
    const a = m[0], b = m[1], c = m[3], d = m[4], tx = m[6], ty = m[7]
    const det = a*d - b*c
    if (Math.abs(det) < 1e-10) return null
    return new Float32Array([
        d/det, -b/det, 0,
       -c/det,  a/det, 0,
        (c*ty - d*tx)/det, (b*tx - a*ty)/det, 1,
    ])
}

// Apply a column-major mat3 to a 2D point.
function applyMat3(m, x, y) {
    return { x: m[0]*x + m[3]*y + m[6], y: m[1]*x + m[4]*y + m[7] }
}

// Build a column-major GL mat3 from an instance's current transform.
// If rawMatrix is set and no keyframes exist, use it directly.
// Otherwise compute from TRS (handles the test rectangle and keyframed instances).
function instanceLocalMat(inst, frame, dragging, dragId) {
    if (inst.rawMatrix && !_hasKeyframes(inst)) {
        const [a,b,c,d,tx,ty] = inst.rawMatrix
        return new Float32Array([a,b,0, c,d,0, tx,ty,1])
    }
    const t = (dragging && inst.id === dragId)
        ? inst.transform
        : evaluateInstance(inst, frame)
    return instanceToModelMatrix(t)
}

function _hasKeyframes(inst) {
    return inst.tracks && Object.values(inst.tracks).some(tr => tr.length > 0)
}

// Walk up the parent chain and compose local matrices → world mat3.
function getInstanceWorldMat(inst, frame) {
    const chain = []
    let cur = inst
    while (cur) {
        chain.unshift(instanceLocalMat(cur, frame, isDragging, dragInstanceId))
        cur = cur.parentId ? scene.instances.find(i => i.id === cur.parentId) : null
    }
    let mat = _IDENTITY_GL.slice()
    for (const m of chain) mat = composeMat3(mat, m)
    return mat
}

// ── Helpers ───────────────────────────────────────────────────────────────

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
// view.x/y: pan offset in CSS pixels from canvas centre.
// view.zoom: 1.0 = 1 world unit per CSS pixel.
// Y convention: world Y+ is DOWN (matches screen/canvas coordinates).

const view     = { x: 0, y: 0, zoom: 1.0 }
const MIN_ZOOM = 0.01
const MAX_ZOOM = 64.0

let cssW = 0   // canvas size in CSS pixels, updated by _resize()
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

// World → NDC matrix for the vertex shader. Column-major Float32Array.
// NDC Y is flipped (up = +1) vs screen Y (up = smaller value), hence -sy.
function worldToClipMatrix() {
    const sx = 2 * view.zoom / cssW
    const sy = 2 * view.zoom / cssH
    const tx = 2 * view.x    / cssW
    const ty = 2 * view.y    / cssH
    return new Float32Array([
        sx,   0,  0,
        0,  -sy,  0,
        tx, -ty,  1,
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

// ── Instance transform helpers ────────────────────────────────────────────

// TRS matrix: local space → world space. Column-major Float32Array for GLSL.
function instanceToModelMatrix(t) {
    const cos = Math.cos(t.rotation)
    const sin = Math.sin(t.rotation)
    return new Float32Array([
         cos * t.scaleX,  sin * t.scaleX,  0,
        -sin * t.scaleY,  cos * t.scaleY,  0,
         t.x,             t.y,             1,
    ])
}

// Transform a local-space point into world space.
function localToWorld(lx, ly, t) {
    const cos = Math.cos(t.rotation)
    const sin = Math.sin(t.rotation)
    return {
        x: cos * t.scaleX * lx - sin * t.scaleY * ly + t.x,
        y: sin * t.scaleX * lx + cos * t.scaleY * ly + t.y,
    }
}

// Transform a world-space point into an instance's local space (inverse TRS).
function worldToLocal(wx, wy, t) {
    const cos = Math.cos(t.rotation)
    const sin = Math.sin(t.rotation)
    const dx  = wx - t.x
    const dy  = wy - t.y
    return {
        x: ( cos * dx + sin * dy) / t.scaleX,
        y: (-sin * dx + cos * dy) / t.scaleY,
    }
}

// AABB of a symbol's vertices in its own local space.
// Supports both legacy {vertices} and new {submeshes} formats.
function getSymbolLocalAABB(symbol) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

    function scan(verts) {
        for (let i = 0; i < verts.length; i += 2) {
            const x = verts[i], y = verts[i + 1]
            if (x < minX) minX = x;  if (x > maxX) maxX = x
            if (y < minY) minY = y;  if (y > maxY) maxY = y
        }
    }

    if (symbol.submeshes) {
        for (const sm of symbol.submeshes) scan(sm.vertices)
    } else if (symbol.vertices) {
        scan(symbol.vertices)
    }

    return { minX, minY, maxX, maxY }
}

// Point-in-AABB test using the instance's full world matrix.
// Only tests instances without a parent (top-level); body-part selection
// goes through the outliner.
function hitTestInstance(wx, wy, instance) {
    if (instance.parentId) return false    // only top-level instances are viewport-selectable
    const sym = scene.symbols.find(s => s.id === instance.symbolId)
    if (!sym) return false
    const aabb = getSymbolLocalAABB(sym)
    if (aabb.minX === Infinity) return false
    const worldMat = getInstanceWorldMat(instance, scene.timeline.currentFrame)
    const inv = invertMat3(worldMat)
    if (!inv) return false
    const local = applyMat3(inv, wx, wy)
    return local.x >= aabb.minX && local.x <= aabb.maxX
        && local.y >= aabb.minY && local.y <= aabb.maxY
}

// ── Selection state ───────────────────────────────────────────────────────
// Not journaled — selection is editor state, not scene data.

let selectedId = null

// ── Drag state ────────────────────────────────────────────────────────────

let isDragging        = false
let dragInstanceId    = null
let dragStartWorld    = null    // world pos when drag began
let dragOldTransform  = null    // snapshot of transform before drag
let dragStartClientX  = 0
let dragStartClientY  = 0

// ── Pan state ─────────────────────────────────────────────────────────────

let isPanning  = false
let panOriginX = 0, panOriginY = 0
let panMouseX  = 0, panMouseY  = 0
let spaceDown  = false

window.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat) { spaceDown = true; e.preventDefault() }
})
window.addEventListener('keyup', e => {
    if (e.code === 'Space') { spaceDown = false; _stopPan() }
})

function _startPan(e) {
    isPanning  = true
    panOriginX = view.x;  panOriginY = view.y
    panMouseX  = e.clientX;  panMouseY = e.clientY
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

// ── Tool state (select / drag) ────────────────────────────────────────────

function _startTool(e) {
    const rect = canvas.getBoundingClientRect()
    const wx   = (e.clientX - rect.left - cssW / 2 - view.x) / view.zoom
    const wy   = (e.clientY - rect.top  - cssH / 2 - view.y) / view.zoom

    dragStartClientX = e.clientX
    dragStartClientY = e.clientY

    // Reverse order = topmost instance first
    const hit = [...scene.instances].reverse().find(i => hitTestInstance(wx, wy, i))

    if (hit) {
        selectedId       = hit.id
        document.dispatchEvent(new CustomEvent('twist:selectionChanged'))
        isDragging       = true
        dragInstanceId   = hit.id
        dragStartWorld   = { x: wx, y: wy }
        dragOldTransform = { ...hit.transform }
        canvas.setPointerCapture(e.pointerId)
    } else {
        selectedId = null
        document.dispatchEvent(new CustomEvent('twist:selectionChanged'))
        isDragging = false
    }

    viewport.markDirty()
}

function _moveTool(e) {
    if (!isDragging) return
    const rect = canvas.getBoundingClientRect()
    const wx   = (e.clientX - rect.left - cssW / 2 - view.x) / view.zoom
    const wy   = (e.clientY - rect.top  - cssH / 2 - view.y) / view.zoom
    const inst = scene.instances.find(i => i.id === dragInstanceId)
    if (!inst) return
    inst.transform.x = dragOldTransform.x + (wx - dragStartWorld.x)
    inst.transform.y = dragOldTransform.y + (wy - dragStartWorld.y)
    viewport.markDirty()
}

function _stopTool(e) {
    if (!isDragging) return
    canvas.releasePointerCapture(e.pointerId)

    const moved = Math.hypot(e.clientX - dragStartClientX, e.clientY - dragStartClientY)
    if (moved > 3) {
        const inst = scene.instances.find(i => i.id === dragInstanceId)
        if (inst) {
            const newT = { ...inst.transform }
            const oldT = dragOldTransform
            journal.push({
                execute: () => { inst.transform.x = newT.x; inst.transform.y = newT.y },
                undo:    () => { inst.transform.x = oldT.x; inst.transform.y = oldT.y }
            })
        }
    }

    isDragging     = false
    dragInstanceId = null
    viewport.markDirty()
}

// ── Pointer events ────────────────────────────────────────────────────────

canvas.addEventListener('pointerdown', e => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
        e.preventDefault()
        _startPan(e)
    } else if (e.button === 0 && !isPanning) {
        _startTool(e)
    }
})
canvas.addEventListener('pointermove', e => {
    if (isPanning)   _movePan(e)
    else if (isDragging) _moveTool(e)
})
canvas.addEventListener('pointerup',     e => { isPanning ? _stopPan(e) : _stopTool(e) })
canvas.addEventListener('pointercancel', e => {
    if (isPanning)   _stopPan(e)
    if (isDragging)  { isDragging = false; viewport.markDirty() }
})
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

let _prog        = null
let _uniforms    = null
const _symbolVaos = new Map()   // symbol.id → { vao, vertexCount }
const _edgeVaos   = new Map()   // symbol.id → [{ vao, count, color }]

let _showEdges = false   // E key toggles

window.addEventListener('keydown', e => {
    if (e.code === 'KeyE' && !e.repeat) {
        _showEdges = !_showEdges
        viewport.markDirty()
    }
})

let _passeProg  = null
let _passeColor = null
let _passeVao   = null
let _passeVbo   = null

// ── Viewport object ───────────────────────────────────────────────────────

const viewport = {
    gl, canvas, overlay, ctx2d,
    view, worldToScreen, screenToWorld, fitCamera,

    get cssWidth()    { return cssW },
    get cssHeight()   { return cssH },
    get selectedId()  { return selectedId },
    setSelected(id)   { selectedId = id; this.markDirty() },

    dirty:          true,
    _lastTimestamp: 0,
    _playAccum:     0,

    markDirty() { this.dirty = true },

    // Build GL VAO(s) for a symbol by id. Safe to call after init() for new symbols.
    buildSymbolVaos(symId) {
        const sym = scene.symbols.find(s => s.id === symId)
        if (!sym) return

        function makeVao(vertices) {
            const vao = gl.createVertexArray()
            const vbo = gl.createBuffer()
            gl.bindVertexArray(vao)
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
            gl.enableVertexAttribArray(0)
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
            gl.bindVertexArray(null)
            return { vao, vertexCount: vertices.length / 2 }
        }

        if (sym.meshes?.length) {
            // Ordered fill+stroke meshes — one VAO per entry, drawn in array order
            _symbolVaos.set(sym.id, sym.meshes.map(m => ({
                color: new Float32Array(m.color),
                ...makeVao(m.vertices),
            })))
        } else if (sym.vertices) {
            // Legacy single-mesh symbol
            _symbolVaos.set(sym.id, [{ color: new Float32Array(sym.color ?? [0,0,0,1]), ...makeVao(sym.vertices) }])
        }

        // Edge overlay: one VAO per stitched contour (LINE_LOOP)
        if (sym.edgeContours?.length) {
            _edgeVaos.set(sym.id, sym.edgeContours.map(({ color, vertices }) => ({
                color: new Float32Array(color),
                ...makeVao(vertices),
            })))
        }
    },

    _resize() {
        const dpr = window.devicePixelRatio || 1
        const cw  = container.clientWidth
        const ch  = container.clientHeight
        if (cssW === cw && cssH === ch) return
        cssW = cw;  cssH = ch
        for (const c of [canvas, overlay]) {
            c.width        = Math.round(cw * dpr)
            c.height       = Math.round(ch * dpr)
            c.style.width  = cw + 'px'
            c.style.height = ch + 'px'
        }
        this.dirty = true
    },

    // Advance playback by the elapsed time since the last RAF tick.
    _advance(timestamp) {
        const delta = this._lastTimestamp > 0 ? timestamp - this._lastTimestamp : 0
        this._lastTimestamp = timestamp

        if (!scene.timeline.playing) return

        this._playAccum += delta
        const msPerFrame = 1000 / scene.timeline.fps
        while (this._playAccum >= msPerFrame) {
            this._playAccum -= msPerFrame
            scene.timeline.currentFrame =
                (scene.timeline.currentFrame + 1) % scene.timeline.duration
            this.dirty = true
            document.dispatchEvent(new CustomEvent('twist:frameChange'))
        }
    },

    _renderScene() {
        gl.viewport(0, 0, canvas.width, canvas.height)
        const [r, g, b] = cssVarToGL('--bg-base')
        gl.clearColor(r, g, b, 1.0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        if (!_prog) return

        gl.useProgram(_prog)
        gl.uniformMatrix3fv(_uniforms.viewMatrix, false, worldToClipMatrix())
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

        // Build children map sorted by order (ascending = back-to-front).
        const childrenOf = new Map()
        for (const inst of scene.instances) {
            const pid = inst.parentId ?? null
            if (!childrenOf.has(pid)) childrenOf.set(pid, [])
            childrenOf.get(pid).push(inst)
        }
        for (const children of childrenOf.values())
            children.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

        const frame = scene.timeline.currentFrame

        // DFS traversal: accumulate world matrix, draw each symbol's geometry,
        // then recurse into children. This gives correct painter's-algorithm order.
        const drawSubtree = (parentId, parentWorldMat) => {
            for (const inst of (childrenOf.get(parentId) ?? [])) {
                const localMat = instanceLocalMat(inst, frame, isDragging, dragInstanceId)
                const worldMat = composeMat3(parentWorldMat, localMat)
                const mesh     = _symbolVaos.get(inst.symbolId)

                if (mesh?.length) {
                    gl.uniformMatrix3fv(_uniforms.modelMatrix, false, worldMat)
                    for (const { vao, vertexCount, color } of mesh) {
                        gl.uniform4fv(_uniforms.color, color)
                        gl.bindVertexArray(vao)
                        gl.drawArrays(gl.TRIANGLES, 0, vertexCount)
                    }
                }

                drawSubtree(inst.id, worldMat)
            }
        }

        drawSubtree(null, _IDENTITY_GL)

        // ── Edge overlay pass ────────────────────────────────────────────
        if (_showEdges) {
            const SEL_COLOR = new Float32Array([1.0, 0.85, 0.1, 1.0])   // yellow highlight
            const _dimColor = new Float32Array(4)                        // reused scratch

            const drawEdgeSubtree = (parentId, parentWorldMat) => {
                for (const inst of (childrenOf.get(parentId) ?? [])) {
                    const localMat  = instanceLocalMat(inst, frame, isDragging, dragInstanceId)
                    const worldMat  = composeMat3(parentWorldMat, localMat)
                    const contours  = _edgeVaos.get(inst.symbolId)
                    const isSelected = inst.id === selectedId

                    if (contours?.length) {
                        gl.uniformMatrix3fv(_uniforms.modelMatrix, false, worldMat)
                        for (const { vao, vertexCount, color } of contours) {
                            let drawColor
                            if (isSelected) {
                                drawColor = SEL_COLOR
                            } else {
                                _dimColor[0] = color[0]; _dimColor[1] = color[1]
                                _dimColor[2] = color[2]; _dimColor[3] = color[3] * 0.3
                                drawColor = _dimColor
                            }
                            gl.uniform4fv(_uniforms.color, drawColor)
                            gl.bindVertexArray(vao)
                            gl.drawArrays(gl.LINE_LOOP, 0, vertexCount)
                        }
                    }

                    drawEdgeSubtree(inst.id, worldMat)
                }
            }

            drawEdgeSubtree(null, _IDENTITY_GL)
        }

        gl.bindVertexArray(null)
    },

    // Ring mesh: outer quad (-1…1 NDC) with a rectangular hole cut out for the
    // camera frame. 8 verts × 4 bands × 2 tris = 8 tris, 24 verts, zero seams.
    _renderPassepartout() {
        if (!_passeProg) return
        const cam = scene.camera
        const tl  = worldToScreen(cam.x - cam.width  / 2, cam.y - cam.height / 2)
        const br  = worldToScreen(cam.x + cam.width  / 2, cam.y + cam.height / 2)
        // Screen-px → NDC.  NDC Y is flipped vs screen Y.
        const nx0 = (tl.x / cssW) * 2 - 1,  ny0 = 1 - (tl.y / cssH) * 2
        const nx1 = (br.x / cssW) * 2 - 1,  ny1 = 1 - (br.y / cssH) * 2
        // prettier-ignore
        const v = new Float32Array([
            // top band
            -1,  1,   1,  1,  nx1,ny0,   -1,  1,  nx1,ny0,  nx0,ny0,
            // right band
             1,  1,   1, -1,  nx1,ny1,    1,  1,  nx1,ny1,  nx1,ny0,
            // bottom band
             1, -1,  -1, -1,  nx0,ny1,    1, -1,  nx0,ny1,  nx1,ny1,
            // left band
            -1, -1,  -1,  1,  nx0,ny0,   -1, -1,  nx0,ny0,  nx0,ny1,
        ])
        gl.useProgram(_passeProg)
        gl.uniform4f(_passeColor, 0, 0, 0, 0.55)
        gl.bindVertexArray(_passeVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, _passeVbo)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, v)
        gl.drawArrays(gl.TRIANGLES, 0, 24)
        gl.bindVertexArray(null)
    },

    _renderOverlay() {
        const dpr = window.devicePixelRatio || 1
        const cam = scene.camera

        ctx2d.save()
        ctx2d.scale(dpr, dpr)
        ctx2d.clearRect(0, 0, cssW, cssH)

        // ── Passepartout border stroke ───────────────────────────────────
        const tl = worldToScreen(cam.x - cam.width  / 2, cam.y - cam.height / 2)
        const br = worldToScreen(cam.x + cam.width  / 2, cam.y + cam.height / 2)
        const fw = br.x - tl.x,  fh = br.y - tl.y
        ctx2d.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx2d.lineWidth   = 1
        ctx2d.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(fw), Math.round(fh))

        // ── Selection box ───────────────────────────────────────────────
        if (selectedId !== null) {
            const inst = scene.instances.find(i => i.id === selectedId)
            const sym  = inst && scene.symbols.find(s => s.id === inst.symbolId)
            if (inst && sym) {
                const worldMat = getInstanceWorldMat(inst, scene.timeline.currentFrame)
                const aabb     = getSymbolLocalAABB(sym)
                const corners = [
                    { x: aabb.minX, y: aabb.minY },
                    { x: aabb.maxX, y: aabb.minY },
                    { x: aabb.maxX, y: aabb.maxY },
                    { x: aabb.minX, y: aabb.maxY },
                ].map(c => {
                    const w = applyMat3(worldMat, c.x, c.y)
                    return worldToScreen(w.x, w.y)
                })

                ctx2d.beginPath()
                ctx2d.moveTo(corners[0].x, corners[0].y)
                for (let i = 1; i < corners.length; i++) ctx2d.lineTo(corners[i].x, corners[i].y)
                ctx2d.closePath()
                ctx2d.strokeStyle = 'rgba(255, 200, 50, 0.85)'
                ctx2d.lineWidth   = 1.5
                ctx2d.stroke()
            }
        }

        ctx2d.restore()
    },

    _render() {
        if (!this.dirty) return
        this.dirty = false
        this._renderScene()
        this._renderPassepartout()
        this._renderOverlay()
    },

    init() {
        // Compile shader program
        _prog     = createProgram(gl, VERT_SCENE, FRAG_SCENE)
        _uniforms = {
            viewMatrix:  gl.getUniformLocation(_prog, 'uViewMatrix'),
            modelMatrix: gl.getUniformLocation(_prog, 'uModelMatrix'),
            color:       gl.getUniformLocation(_prog, 'uColor'),
        }

        // Passepartout ring — dynamic VBO, 24 verts × 2 floats = 48 floats
        _passeProg  = createProgram(gl, VERT_PASSE, FRAG_SCENE)
        _passeColor = gl.getUniformLocation(_passeProg, 'uColor')
        _passeVao   = gl.createVertexArray()
        _passeVbo   = gl.createBuffer()
        gl.bindVertexArray(_passeVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, _passeVbo)
        gl.bufferData(gl.ARRAY_BUFFER, 48 * 4, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
        gl.bindVertexArray(null)

        // Build VAOs for all symbols in the initial scene
        for (const sym of scene.symbols) this.buildSymbolVaos(sym.id)

        const observer = new ResizeObserver(() => { this._resize(); this.markDirty() })
        observer.observe(container)
        this._resize()
        fitCamera()

        const loop = (timestamp) => {
            this._advance(timestamp)
            this._render()
            requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
    }
}

export { view, worldToScreen, screenToWorld, fitCamera }
export default viewport

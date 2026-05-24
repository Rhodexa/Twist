// WebGL2 canvas (scene) + Canvas2D overlay (editor UI).
// Owns: GL context, view transform, pan/zoom, selection, drag, playback timing.

import scene                      from '../scene/scene.js'
import journal                    from '../journal/journal.js'
import { createProgram }          from '../gl/program.js'
import { VERT_SCENE, FRAG_SCENE, VERT_PASSE, FRAG_CHECKER } from '../gl/shaders.js'
import { evaluateInstance }       from '../scene/evaluate.js'

// ── Canvas setup ──────────────────────────────────────────────────────────

const container = document.getElementById('viewport-container')
const canvas    = document.getElementById('viewport-canvas')
const gl        = canvas.getContext('webgl2', { stencil: true })

if (!gl) throw new Error('WebGL2 not available.')

const overlay         = document.createElement('canvas')
overlay.id            = 'overlay-canvas'
overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
container.appendChild(overlay)
const ctx2d = overlay.getContext('2d')

// ── Mat3 helpers (column-major Float32Array, matches GLSL mat3) ───────────

const _IDENTITY_GL = new Float32Array([1,0,0, 0,1,0, 0,0,1])
const _WHITE       = new Float32Array([1, 1, 1, 1])

function composeMat3(A, B) {
    const R = new Float32Array(9)
    for (let c = 0; c < 3; c++)
        for (let r = 0; r < 3; r++)
            R[c*3+r] = A[0*3+r]*B[c*3+0] + A[1*3+r]*B[c*3+1] + A[2*3+r]*B[c*3+2]
    return R
}

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

function applyMat3(m, x, y) {
    return { x: m[0]*x + m[3]*y + m[6], y: m[1]*x + m[4]*y + m[7] }
}

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

function _worldDeltaToLocal(parentInstId, wdx, wdy) {
    const parent = scene.instances.find(i => i.id === parentInstId)
    if (!parent) return { x: wdx, y: wdy }
    const m   = getInstanceWorldMat(parent, scene.timeline.currentFrame)
    const inv = invertMat3(m)
    if (!inv) return { x: wdx, y: wdy }
    const p0 = applyMat3(inv, 0,   0  )
    const pd = applyMat3(inv, wdx, wdy)
    return { x: pd.x - p0.x, y: pd.y - p0.y }
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

const view     = { x: 0, y: 0, zoom: 1.0 }
const MIN_ZOOM = 0.01
const MAX_ZOOM = 64.0

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

function instanceToModelMatrix(t) {
    const cos = Math.cos(t.rotation)
    const sin = Math.sin(t.rotation)
    return new Float32Array([
         cos * t.scaleX,  sin * t.scaleX,  0,
        -sin * t.scaleY,  cos * t.scaleY,  0,
         t.x,             t.y,             1,
    ])
}

function localToWorld(lx, ly, t) {
    const cos = Math.cos(t.rotation)
    const sin = Math.sin(t.rotation)
    return {
        x: cos * t.scaleX * lx - sin * t.scaleY * ly + t.x,
        y: sin * t.scaleX * lx + cos * t.scaleY * ly + t.y,
    }
}

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
// Handles renderGroups (new), meshes (legacy flat), submeshes, and bare vertices.
function getSymbolLocalAABB(symbol) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

    function scan(verts) {
        for (let i = 0; i < verts.length; i += 2) {
            const x = verts[i], y = verts[i + 1]
            if (x < minX) minX = x;  if (x > maxX) maxX = x
            if (y < minY) minY = y;  if (y > maxY) maxY = y
        }
    }

    if (symbol.renderGroups) {
        for (const g of symbol.renderGroups) {
            const all = g.type === 'plain'
                ? g.meshes
                : [...g.maskMeshes, ...g.contentMeshes]
            for (const m of all) scan(m.vertices)
        }
    } else if (symbol.meshes) {
        for (const m of symbol.meshes)    scan(m.vertices)
    } else if (symbol.submeshes) {
        for (const sm of symbol.submeshes) scan(sm.vertices)
    } else if (symbol.vertices) {
        scan(symbol.vertices)
    }

    return { minX, minY, maxX, maxY }
}

function _hasOwnGeometry(inst) {
    const sym = scene.symbols.find(s => s.id === inst.symbolId)
    if (!sym) return false
    return getSymbolLocalAABB(sym).minX !== Infinity
}

function hitTestInstance(wx, wy, instance) {
    if (instance.parentId) return false
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
// Multi-selection: a Set of selected IDs + one "active" (most-recently picked).
// activeId is what the transform tool and pivot calculations use.

const _selection = new Set()   // all selected instance IDs
let   _activeId  = null        // last clicked — "active" object

// ── External tool state ───────────────────────────────────────────────────

let _externalToolActive = false

const _overlayHooks = []

// ── Context-based selection ───────────────────────────────────────────────
// Single click picks direct children of the current context (null = root).
// Double-click enters the selected instance. Escape walks back up.
// Repeated clicks at the same spot cycle siblings at the current level.

let _selectionCtx  = null   // ID of the "entered" instance (null = root level)
let _ctxStack      = []     // stack of ancestor IDs for Alt/Escape to walk up

const _CYCLE_RADIUS_PX = 8

let _cycleIds      = []
let _cycleIndex    = 0
let _cycleScreenXY = null

// Returns true if the subtree rooted at instId (with known worldMat) contains
// the world-space point (wx, wy) — either in its own AABB or any descendant.
function _subtreeHitsPoint(inst, worldMat, wx, wy, frame) {
    const sym = scene.symbols.find(s => s.id === inst.symbolId)
    if (sym) {
        const aabb = getSymbolLocalAABB(sym)
        if (aabb.minX !== Infinity) {
            const inv = invertMat3(worldMat)
            if (inv) {
                const local = applyMat3(inv, wx, wy)
                if (local.x >= aabb.minX && local.x <= aabb.maxX &&
                    local.y >= aabb.minY && local.y <= aabb.maxY) return true
            }
        }
    }
    for (const child of scene.instances.filter(i => i.parentId === inst.id)) {
        const childWorld = composeMat3(worldMat, instanceLocalMat(child, frame, false, null))
        if (_subtreeHitsPoint(child, childWorld, wx, wy, frame)) return true
    }
    return false
}

// Returns direct children of contextId whose subtree contains (wx, wy),
// sorted front-to-back (highest draw order first).
function _getContextHits(wx, wy, contextId) {
    const frame    = scene.timeline.currentFrame
    const children = scene.instances
        .filter(i => (i.parentId ?? null) === contextId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const hits = []
    for (const inst of children) {
        const worldMat = getInstanceWorldMat(inst, frame)
        if (_subtreeHitsPoint(inst, worldMat, wx, wy, frame)) hits.push(inst)
    }
    hits.reverse()   // highest order (front) first
    return hits
}

// ── Drag state ────────────────────────────────────────────────────────────

let isDragging          = false
let dragInstanceId      = null
let dragStartWorld      = null
let dragStartTransforms = new Map()   // selId → { x, y } at drag start
let dragStartClientX    = 0
let dragStartClientY    = 0

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

// ── Tool state ────────────────────────────────────────────────────────────

function _setActive(id) {
    _activeId = id
    if (id != null) _selection.add(id)
    document.dispatchEvent(new CustomEvent('twist:selectionChanged'))
    viewport.markDirty()
}

function _startTool(e) {
    if (_externalToolActive) return
    const rect = canvas.getBoundingClientRect()
    const sx   = e.clientX - rect.left
    const sy   = e.clientY - rect.top
    const wx   = (sx - cssW / 2 - view.x) / view.zoom
    const wy   = (sy - cssH / 2 - view.y) / view.zoom

    dragStartClientX = e.clientX
    dragStartClientY = e.clientY

    const shift    = e.shiftKey
    const sameSpot = _cycleScreenXY &&
        Math.hypot(sx - _cycleScreenXY.x, sy - _cycleScreenXY.y) < _CYCLE_RADIUS_PX

    if (sameSpot && _cycleIds.length > 1 && !shift) {
        _cycleIndex = (_cycleIndex + 1) % _cycleIds.length
        _activeId   = _cycleIds[_cycleIndex]
        _selection.clear(); _selection.add(_activeId)
    } else {
        const hits = _getContextHits(wx, wy, _selectionCtx)
        _cycleIds  = hits.map(i => i.id)
        _cycleIndex = 0
        const picked = _cycleIds[0] ?? null

        if (shift && picked) {
            // Shift+click: toggle in/out of selection, update active
            if (_selection.has(picked)) {
                _selection.delete(picked)
                _activeId = [..._selection].at(-1) ?? null
            } else {
                _selection.add(picked)
                _activeId = picked
            }
        } else if (picked) {
            _selection.clear()
            _selection.add(picked)
            _activeId = picked
            _cycleScreenXY = { x: sx, y: sy }

            // Auto-enter pure containers (no own geometry) — skip to selectable content
            for (let depth = 0; depth < 6 && _activeId; depth++) {
                const cand = scene.instances.find(i => i.id === _activeId)
                if (!cand || _hasOwnGeometry(cand)) break
                if (!scene.instances.some(i => i.parentId === _activeId)) break
                _ctxStack.push(_selectionCtx)
                _selectionCtx = _activeId
                const inner = _getContextHits(wx, wy, _selectionCtx)
                if (!inner.length) { _selectionCtx = _ctxStack.pop(); break }
                _cycleIds      = inner.map(i => i.id)
                _cycleIndex    = 0
                _cycleScreenXY = { x: sx, y: sy }
                _selection.clear()
                _activeId = _cycleIds[0]
                _selection.add(_activeId)
            }
        } else {
            // Miss — clear selection and exit context
            _selection.clear()
            _activeId      = null
            _selectionCtx  = null
            _ctxStack      = []
            _cycleIds      = []
            _cycleScreenXY = null
        }
    }

    document.dispatchEvent(new CustomEvent('twist:selectionChanged'))

    // Drag all selected instances together
    if (_activeId) {
        isDragging     = true
        dragInstanceId = _activeId
        dragStartWorld = { x: wx, y: wy }
        dragStartTransforms.clear()
        for (const selId of _selection) {
            const selInst = scene.instances.find(i => i.id === selId)
            if (selInst) dragStartTransforms.set(selId, { x: selInst.transform.x, y: selInst.transform.y })
        }
        canvas.setPointerCapture(e.pointerId)
    } else {
        isDragging = false
    }

    viewport.markDirty()
}

// Double-click: enter the active instance (descend one level)
canvas.addEventListener('dblclick', e => {
    if (_externalToolActive || !_activeId) return
    const hasChildren = scene.instances.some(i => i.parentId === _activeId)
    if (!hasChildren) return
    _ctxStack.push(_selectionCtx)
    _selectionCtx  = _activeId
    _cycleIds      = []
    _cycleScreenXY = null
    // Pick immediately at the same cursor position
    const rect = canvas.getBoundingClientRect()
    const sx   = e.clientX - rect.left
    const sy   = e.clientY - rect.top
    const wx   = (sx - cssW / 2 - view.x) / view.zoom
    const wy   = (sy - cssH / 2 - view.y) / view.zoom
    const hits = _getContextHits(wx, wy, _selectionCtx)
    if (hits.length) {
        _selection.clear(); _selection.add(hits[0].id)
        _activeId      = hits[0].id
        _cycleIds      = hits.map(i => i.id)
        _cycleScreenXY = { x: sx, y: sy }
    }
    document.dispatchEvent(new CustomEvent('twist:selectionChanged'))
    viewport.markDirty()
})

// Escape (when no modal tool active): walk up one context level
window.addEventListener('keydown', e => {
    if (_externalToolActive) return
    if (e.code !== 'Escape' && e.code !== 'AltLeft' && e.code !== 'AltRight') return
    if (e.code === 'Escape' || e.code === 'AltLeft' || e.code === 'AltRight') {
        if (_selectionCtx === null) return
        e.preventDefault()
        const parent   = _ctxStack.pop() ?? null
        const wasCtx   = _selectionCtx
        _selectionCtx  = parent
        _cycleIds      = []
        _cycleScreenXY = null
        // Re-select the instance we were inside
        _selection.clear(); _selection.add(wasCtx)
        _activeId = wasCtx
        document.dispatchEvent(new CustomEvent('twist:selectionChanged'))
        viewport.markDirty()
    }
})

function _moveTool(e) {
    if (!isDragging) return
    const rect = canvas.getBoundingClientRect()
    const wx  = (e.clientX - rect.left - cssW / 2 - view.x) / view.zoom
    const wy  = (e.clientY - rect.top  - cssH / 2 - view.y) / view.zoom
    const dwx = wx - dragStartWorld.x
    const dwy = wy - dragStartWorld.y
    for (const [id, startPos] of dragStartTransforms) {
        const inst = scene.instances.find(i => i.id === id)
        if (!inst) continue
        if (inst.parentId) {
            const ld = _worldDeltaToLocal(inst.parentId, dwx, dwy)
            inst.transform.x = startPos.x + ld.x
            inst.transform.y = startPos.y + ld.y
        } else {
            inst.transform.x = startPos.x + dwx
            inst.transform.y = startPos.y + dwy
        }
    }
    viewport.markDirty()
}

function _stopTool(e) {
    if (!isDragging) return
    canvas.releasePointerCapture(e.pointerId)

    const moved = Math.hypot(e.clientX - dragStartClientX, e.clientY - dragStartClientY)
    if (moved > 3) {
        const changes = []
        for (const [id, oldPos] of dragStartTransforms) {
            const inst = scene.instances.find(i => i.id === id)
            if (inst) changes.push({ inst, newX: inst.transform.x, newY: inst.transform.y, oldX: oldPos.x, oldY: oldPos.y })
        }
        if (changes.length) {
            journal.push({
                execute: () => { for (const c of changes) { c.inst.transform.x = c.newX; c.inst.transform.y = c.newY } },
                undo:    () => { for (const c of changes) { c.inst.transform.x = c.oldX; c.inst.transform.y = c.oldY } }
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

// ── GL state ──────────────────────────────────────────────────────────────

let _prog        = null
let _uniforms    = null

// _symbolVaos: symId → array of render groups
//   plain group:  { type:'plain',  vaos: [vaoEntry, ...] }
//   masked group: { type:'masked', maskVaos:[{vao,vertexCount},...], contentVaos:[vaoEntry,...] }
//
// vaoEntry: { fillType, color?, stopCount?, stopOffsets?, stopColors?, gradientMatInv?, vao, vertexCount }
const _symbolVaos = new Map()
const _edgeVaos   = new Map()

// Compositor hover highlight — null | { instId, maskId? }
let _hoverHighlight = null
const _HIGHLIGHT_INST = new Float32Array([0.0, 0.85, 1.0, 0.30])   // cyan
const _HIGHLIGHT_MASK = new Float32Array([1.0, 0.20, 0.85, 0.55])   // magenta

let _showEdges = false

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

// ── Checkerboard background ───────────────────────────────────────────────

const checker = { enabled: true, scale: 20, opacity: 0.55 }

let _checkerProg    = null
let _checkerScale   = null
let _checkerOpacity = null
let _checkerVao     = null

// ── Viewport object ───────────────────────────────────────────────────────

const viewport = {
    gl, canvas, overlay, ctx2d,
    view, worldToScreen, screenToWorld, fitCamera,

    get cssWidth()     { return cssW },
    get cssHeight()    { return cssH },
    get selectedId()   { return _activeId },           // backward compat (transform-tool)
    get activeId()     { return _activeId },
    get selectionIds() { return _selection },           // Set — read-only by convention
    isSelected(id)     { return _selection.has(id) },
    setSelected(id) {
        _selection.clear()
        _activeId = id ?? null
        if (id != null) _selection.add(id)
        _selectionCtx = null; _ctxStack = []; _cycleIds = []; _cycleScreenXY = null
        document.dispatchEvent(new CustomEvent('twist:selectionChanged'))
        this.markDirty()
    },
    // Add or remove from multi-selection without clearing the rest.
    toggleSelected(id) {
        if (_selection.has(id)) {
            _selection.delete(id)
            if (_activeId === id) _activeId = [..._selection].at(-1) ?? null
        } else {
            _selection.add(id)
            _activeId = id
        }
        document.dispatchEvent(new CustomEvent('twist:selectionChanged'))
        this.markDirty()
    },
    setToolActive(v)  { _externalToolActive = v },
    addOverlayHook(fn){ _overlayHooks.push(fn) },

    getWorldOrigin(instId) {
        const inst = scene.instances.find(i => i.id === instId)
        if (!inst) return null
        const m = getInstanceWorldMat(inst, scene.timeline.currentFrame)
        return { x: m[6], y: m[7] }
    },

    worldDeltaToLocal(parentInstId, wdx, wdy) {
        return _worldDeltaToLocal(parentInstId, wdx, wdy)
    },

    setHoverHighlight(instId, maskId = null) {
        _hoverHighlight = instId ? { instId, maskId } : null
        this.markDirty()
    },

    dirty:          true,
    _lastTimestamp: 0,
    _playAccum:     0,

    markDirty() { this.dirty = true },

    clearSymbolVaos() {
        for (const groups of _symbolVaos.values()) {
            for (const group of groups) {
                const entries = group.type === 'plain'
                    ? group.vaos
                    : [...group.maskVaos, ...group.contentVaos]
                for (const e of entries) gl.deleteVertexArray(e.vao)
            }
        }
        for (const contours of _edgeVaos.values())
            for (const { vao } of contours) gl.deleteVertexArray(vao)
        _symbolVaos.clear()
        _edgeVaos.clear()
    },

    buildSymbolVaos(symId) {
        if (_symbolVaos.has(symId)) return
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

        function meshToEntry(mesh) {
            const base = makeVao(mesh.vertices)
            if (mesh.fillType === 0) {
                return { fillType: 0, color: new Float32Array(mesh.color), ...base }
            }
            return {
                fillType:       mesh.fillType,
                gradientMatInv: mesh.gradientMatInv,
                stopCount:      mesh.stopCount,
                stopOffsets:    mesh.stopOffsets,
                stopColors:     mesh.stopColors,
                ...base,
            }
        }

        if (sym.renderGroups?.length) {
            _symbolVaos.set(sym.id, sym.renderGroups.map(g => {
                if (g.type === 'plain') {
                    return { type: 'plain', order: g.order ?? 0, vaos: g.meshes.map(meshToEntry) }
                }
                return {
                    type:        'masked',
                    order:       g.order ?? 0,
                    maskId:      g.maskId,
                    maskVaos:    g.maskMeshes.map(m => makeVao(m.vertices)),
                    contentVaos: g.contentMeshes.map(meshToEntry),
                }
            }))
        } else if (sym.meshes?.length) {
            // Legacy flat mesh array — wrap in a single plain group
            _symbolVaos.set(sym.id, [{
                type: 'plain',
                vaos: sym.meshes.map(m => ({
                    fillType: 0,
                    color:    new Float32Array(m.color),
                    ...makeVao(m.vertices),
                }))
            }])
        } else if (sym.vertices) {
            // Legacy bare single-mesh symbol (test scene)
            _symbolVaos.set(sym.id, [{
                type: 'plain',
                vaos: [{ fillType: 0, color: new Float32Array(sym.color ?? [0,0,0,1]), ...makeVao(sym.vertices) }]
            }])
        }

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
        if (!_prog) return

        gl.useProgram(_prog)
        gl.uniformMatrix3fv(_uniforms.viewMatrix, false, worldToClipMatrix())
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

        const childrenOf = new Map()
        for (const inst of scene.instances) {
            const pid = inst.parentId ?? null
            if (!childrenOf.has(pid)) childrenOf.set(pid, [])
            childrenOf.get(pid).push(inst)
        }
        for (const children of childrenOf.values())
            children.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

        const frame = scene.timeline.currentFrame

        // Draw a single mesh entry — handles solid and gradient fills.
        const drawEntry = (entry, worldMat) => {
            gl.uniformMatrix3fv(_uniforms.modelMatrix, false, worldMat)
            if (entry.fillType === 0) {
                gl.uniform1i(_uniforms.fillType, 0)
                gl.uniform4fv(_uniforms.color, entry.color)
            } else {
                gl.uniform1i(_uniforms.fillType, entry.fillType)
                gl.uniformMatrix3fv(_uniforms.gradMatInv, false, entry.gradientMatInv)
                gl.uniform1i(_uniforms.stopCount, entry.stopCount)
                gl.uniform1fv(_uniforms.stopOffsets, entry.stopOffsets)
                gl.uniform4fv(_uniforms.stopColors, entry.stopColors)
            }
            gl.bindVertexArray(entry.vao)
            gl.drawArrays(gl.TRIANGLES, 0, entry.vertexCount)
        }

        // Stencil depth — supports nested masks via INCR/DECR (one counter per frame).
        let stencilDepth = 0

        // Push a mask: INCR stencil where mask shape is, inside the current parent mask.
        const pushMask = (group, worldMat) => {
            if (stencilDepth === 0) gl.enable(gl.STENCIL_TEST)
            gl.colorMask(false, false, false, false)
            gl.stencilFunc(gl.EQUAL, stencilDepth, 0xFF)
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR)
            gl.uniformMatrix3fv(_uniforms.modelMatrix, false, worldMat)
            gl.uniform1i(_uniforms.fillType, 0)
            gl.uniform4fv(_uniforms.color, _WHITE)
            for (const mv of group.maskVaos) {
                gl.bindVertexArray(mv.vao)
                gl.drawArrays(gl.TRIANGLES, 0, mv.vertexCount)
            }
            gl.colorMask(true, true, true, true)
            stencilDepth++
            gl.stencilFunc(gl.EQUAL, stencilDepth, 0xFF)
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP)
        }

        // Pop a mask: DECR stencil back where the mask shape was, restoring parent mask.
        const popMask = (group, worldMat) => {
            gl.colorMask(false, false, false, false)
            gl.stencilFunc(gl.EQUAL, stencilDepth, 0xFF)
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.DECR)
            gl.uniformMatrix3fv(_uniforms.modelMatrix, false, worldMat)
            gl.uniform1i(_uniforms.fillType, 0)
            gl.uniform4fv(_uniforms.color, _WHITE)
            for (const mv of group.maskVaos) {
                gl.bindVertexArray(mv.vao)
                gl.drawArrays(gl.TRIANGLES, 0, mv.vertexCount)
            }
            gl.colorMask(true, true, true, true)
            stencilDepth--
            if (stencilDepth === 0) {
                gl.disable(gl.STENCIL_TEST)
            } else {
                gl.stencilFunc(gl.EQUAL, stencilDepth, 0xFF)
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP)
            }
        }

        // Draw an instance and its full subtree.
        // Children with maskId matching one of the parent symbol's mask groups
        // are drawn inside that stencil; all others are drawn normally after.
        const drawInstTree = (inst, worldMat) => {
            const groups = _symbolVaos.get(inst.symbolId)

            // Partition this instance's children by which mask group (if any) clips them.
            const maskedByGroup = new Map()   // maskId → [child, ...]
            const unmaskedKids  = []
            const knownMaskIds  = new Set(
                groups?.filter(g => g.type === 'masked').map(g => g.maskId) ?? []
            )
            for (const child of (childrenOf.get(inst.id) ?? [])) {
                const mk = child.maskId
                if (mk != null && knownMaskIds.has(mk)) {
                    if (!maskedByGroup.has(mk)) maskedByGroup.set(mk, [])
                    maskedByGroup.get(mk).push(child)
                } else {
                    unmaskedKids.push(child)
                }
            }

            // Merge render groups and unmasked children into one draw sequence,
            // sorted by order so layer-stack position is respected.
            // Masked children are still drawn inside their mask group, not here.
            const drawSeq = []
            for (const group of (groups ?? []))
                drawSeq.push({ isGroup: true,  group, order: group.order ?? 0 })
            for (const child of unmaskedKids)
                drawSeq.push({ isGroup: false, child, order: child.order ?? 0 })
            drawSeq.sort((a, b) => a.order - b.order)

            for (const item of drawSeq) {
                if (item.isGroup) {
                    const group = item.group
                    if (group.type === 'plain') {
                        for (const entry of group.vaos) drawEntry(entry, worldMat)
                    } else {
                        const maskedKids = maskedByGroup.get(group.maskId) ?? []
                        pushMask(group, worldMat)
                        for (const cv of group.contentVaos) drawEntry(cv, worldMat)
                        for (const kid of maskedKids) {
                            const kidMat = composeMat3(worldMat, instanceLocalMat(kid, frame, isDragging, dragInstanceId))
                            drawInstTree(kid, kidMat)
                        }
                        popMask(group, worldMat)
                    }
                } else {
                    const childMat = composeMat3(worldMat, instanceLocalMat(item.child, frame, isDragging, dragInstanceId))
                    drawInstTree(item.child, childMat)
                }
            }
        }

        for (const inst of (childrenOf.get(null) ?? [])) {
            drawInstTree(inst, instanceLocalMat(inst, frame, isDragging, dragInstanceId))
        }

        // ── Compositor hover highlight pass ──────────────────────────────
        if (_hoverHighlight) {
            const inst = scene.instances.find(i => i.id === _hoverHighlight.instId)
            if (inst) {
                gl.disable(gl.STENCIL_TEST)
                gl.enable(gl.BLEND)
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
                gl.uniform1i(_uniforms.fillType, 0)

                const worldMat = getInstanceWorldMat(inst, frame)
                gl.uniformMatrix3fv(_uniforms.modelMatrix, false, worldMat)

                const groups = _symbolVaos.get(inst.symbolId)

                if (_hoverHighlight.maskId != null) {
                    // Highlight just the mask shape for this mask group
                    const group = groups?.find(g => g.type === 'masked' && g.maskId === _hoverHighlight.maskId)
                    if (group) {
                        gl.uniform4fv(_uniforms.color, _HIGHLIGHT_MASK)
                        for (const mv of group.maskVaos) {
                            gl.bindVertexArray(mv.vao)
                            gl.drawArrays(gl.TRIANGLES, 0, mv.vertexCount)
                        }
                    }
                } else {
                    // Highlight all geometry for this instance's symbol
                    gl.uniform4fv(_uniforms.color, _HIGHLIGHT_INST)
                    if (groups) {
                        for (const group of groups) {
                            const vaos = group.type === 'plain'
                                ? group.vaos
                                : [...group.maskVaos, ...group.contentVaos]
                            for (const v of vaos) {
                                gl.bindVertexArray(v.vao)
                                gl.drawArrays(gl.TRIANGLES, 0, v.vertexCount)
                            }
                        }
                    }
                }
            }
        }

        // ── Edge overlay pass ────────────────────────────────────────────
        if (_showEdges) {
            const SEL_COLOR = new Float32Array([1.0, 0.85, 0.1, 1.0])
            const _dimColor = new Float32Array(4)

            const drawEdgeSubtree = (parentId, parentWorldMat) => {
                for (const inst of (childrenOf.get(parentId) ?? [])) {
                    const localMat  = instanceLocalMat(inst, frame, isDragging, dragInstanceId)
                    const worldMat  = composeMat3(parentWorldMat, localMat)
                    const contours  = _edgeVaos.get(inst.symbolId)
                    const isSelected = inst.id === selectedId

                    if (contours?.length) {
                        gl.uniformMatrix3fv(_uniforms.modelMatrix, false, worldMat)
                        gl.uniform1i(_uniforms.fillType, 0)
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

    _renderPassepartout() {
        if (!_passeProg) return
        const cam = scene.camera
        const tl  = worldToScreen(cam.x - cam.width  / 2, cam.y - cam.height / 2)
        const br  = worldToScreen(cam.x + cam.width  / 2, cam.y + cam.height / 2)
        const nx0 = (tl.x / cssW) * 2 - 1,  ny0 = 1 - (tl.y / cssH) * 2
        const nx1 = (br.x / cssW) * 2 - 1,  ny1 = 1 - (br.y / cssH) * 2
        // prettier-ignore
        const v = new Float32Array([
            -1,  1,   1,  1,  nx1,ny0,   -1,  1,  nx1,ny0,  nx0,ny0,
             1,  1,   1, -1,  nx1,ny1,    1,  1,  nx1,ny1,  nx1,ny0,
             1, -1,  -1, -1,  nx0,ny1,    1, -1,  nx0,ny1,  nx1,ny1,
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

        const tl = worldToScreen(cam.x - cam.width  / 2, cam.y - cam.height / 2)
        const br = worldToScreen(cam.x + cam.width  / 2, cam.y + cam.height / 2)
        const fw = br.x - tl.x,  fh = br.y - tl.y
        ctx2d.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx2d.lineWidth   = 1
        ctx2d.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(fw), Math.round(fh))

        // ── Selection boxes ──────────────────────────────────────────────
        const frame = scene.timeline.currentFrame

        function drawSelBox(instId, isActive) {
            const inst = scene.instances.find(i => i.id === instId)
            const sym  = inst && scene.symbols.find(s => s.id === inst.symbolId)
            if (!inst || !sym) return
            const worldMat = getInstanceWorldMat(inst, frame)
            const aabb     = getSymbolLocalAABB(sym)
            if (aabb.minX === Infinity) return
            const corners = [
                { x: aabb.minX, y: aabb.minY }, { x: aabb.maxX, y: aabb.minY },
                { x: aabb.maxX, y: aabb.maxY }, { x: aabb.minX, y: aabb.maxY },
            ].map(c => { const w = applyMat3(worldMat, c.x, c.y); return worldToScreen(w.x, w.y) })

            ctx2d.beginPath()
            ctx2d.moveTo(corners[0].x, corners[0].y)
            for (let i = 1; i < corners.length; i++) ctx2d.lineTo(corners[i].x, corners[i].y)
            ctx2d.closePath()
            ctx2d.strokeStyle = isActive ? 'rgba(255,200,50,0.9)' : 'rgba(255,140,30,0.65)'
            ctx2d.lineWidth   = isActive ? 1.5 : 1
            ctx2d.stroke()

            if (isActive && _cycleIds.length > 1) {
                // Cycle badge — pill background for legibility
                const label  = `${_cycleIndex + 1} / ${_cycleIds.length}`
                const ox = corners[1].x + 6
                const oy = corners[1].y - 3
                ctx2d.font = 'bold 11px monospace'
                const tw   = ctx2d.measureText(label).width
                ctx2d.fillStyle = 'rgba(0,0,0,0.7)'
                ctx2d.beginPath()
                ctx2d.roundRect(ox - 3, oy - 12, tw + 6, 15, 3)
                ctx2d.fill()
                ctx2d.fillStyle = 'rgba(255,200,50,1)'
                ctx2d.fillText(label, ox, oy)
            }
        }

        // Draw non-active selected (orange) first so yellow active draws on top
        for (const id of _selection) {
            if (id !== _activeId) drawSelBox(id, false)
        }
        if (_activeId !== null) drawSelBox(_activeId, true)

        // ── Context breadcrumb ───────────────────────────────────────────
        if (_selectionCtx !== null) {
            const ctxInst  = scene.instances.find(i => i.id === _selectionCtx)
            const ctxLabel = ctxInst?.label ?? ctxInst?.id ?? '?'
            const crumb    = `▸ ${ctxLabel}  (Esc to exit)`
            ctx2d.font      = '11px monospace'
            const tw        = ctx2d.measureText(crumb).width
            ctx2d.fillStyle = 'rgba(0,0,0,0.65)'
            ctx2d.fillRect(10, 36, tw + 12, 18)
            ctx2d.fillStyle = 'rgba(255,180,40,0.9)'
            ctx2d.fillText(crumb, 16, 49)
        }

        ctx2d.restore()

        for (const hook of _overlayHooks) hook(ctx2d, cssW, cssH)
    },

    _renderClear() {
        gl.viewport(0, 0, canvas.width, canvas.height)
        const [r, g, b] = cssVarToGL('--bg-base')
        gl.clearColor(r, g, b, 1.0)
        gl.clearStencil(0)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    },

    _renderCheckerboard() {
        if (!checker.enabled || !_checkerProg) return
        gl.useProgram(_checkerProg)
        gl.uniform1f(_checkerScale,   checker.scale)
        gl.uniform1f(_checkerOpacity, checker.opacity)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.bindVertexArray(_checkerVao)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        gl.bindVertexArray(null)
    },

    _render() {
        if (!this.dirty) return
        this.dirty = false
        this._renderClear()
        this._renderCheckerboard()
        this._renderScene()
        this._renderPassepartout()
        this._renderOverlay()
    },

    init() {
        _prog     = createProgram(gl, VERT_SCENE, FRAG_SCENE)
        _uniforms = {
            viewMatrix:  gl.getUniformLocation(_prog, 'uViewMatrix'),
            modelMatrix: gl.getUniformLocation(_prog, 'uModelMatrix'),
            color:       gl.getUniformLocation(_prog, 'uColor'),
            fillType:    gl.getUniformLocation(_prog, 'uFillType'),
            gradMatInv:  gl.getUniformLocation(_prog, 'uGradMatInv'),
            stopCount:   gl.getUniformLocation(_prog, 'uStopCount'),
            stopOffsets: gl.getUniformLocation(_prog, 'uStopOffsets'),
            stopColors:  gl.getUniformLocation(_prog, 'uStopColors'),
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

        // Checkerboard — fullscreen quad, static VBO
        _checkerProg    = createProgram(gl, VERT_PASSE, FRAG_CHECKER)
        _checkerScale   = gl.getUniformLocation(_checkerProg, 'uScale')
        _checkerOpacity = gl.getUniformLocation(_checkerProg, 'uOpacity')
        _checkerVao     = gl.createVertexArray()
        const _checkerVbo = gl.createBuffer()
        gl.bindVertexArray(_checkerVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, _checkerVbo)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1,  1,-1,  -1,1,
             1,-1,  1, 1,  -1,1,
        ]), gl.STATIC_DRAW)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
        gl.bindVertexArray(null)

        // ── Viewport header bar ───────────────────────────────────────────
        const header = document.createElement('div')
        header.id    = 'vp-header'
        header.style.cssText = [
            'position:absolute', 'top:0', 'left:0', 'right:0', 'height:28px',
            'display:flex', 'align-items:center', 'justify-content:flex-end',
            'padding:0 6px', 'gap:4px',
            'background:rgba(18,18,22,0.72)',
            'backdrop-filter:blur(6px)',
            '-webkit-backdrop-filter:blur(6px)',
            'border-bottom:1px solid rgba(255,255,255,0.07)',
            'z-index:10', 'pointer-events:all', 'user-select:none',
            'font:11px/1 var(--font-mono,monospace)', 'color:rgba(255,255,255,0.65)',
        ].join(';')

        const extrasBtn = document.createElement('button')
        extrasBtn.textContent = 'Extras ▾'
        extrasBtn.style.cssText = [
            'background:rgba(255,255,255,0.06)', 'border:1px solid rgba(255,255,255,0.12)',
            'color:rgba(255,255,255,0.7)', 'font:11px/1 var(--font-mono,monospace)',
            'padding:3px 8px', 'border-radius:4px', 'cursor:pointer',
        ].join(';')

        const dropdown = document.createElement('div')
        dropdown.style.cssText = [
            'position:absolute', 'top:29px', 'right:6px',
            'background:rgba(18,18,22,0.92)',
            'border:1px solid rgba(255,255,255,0.1)',
            'border-radius:6px', 'padding:10px 12px',
            'display:none', 'flex-direction:column', 'gap:8px',
            'z-index:20', 'min-width:190px',
            'font:11px/1.6 var(--font-mono,monospace)', 'color:rgba(255,255,255,0.65)',
        ].join(';')
        dropdown.innerHTML = `
            <div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;
                        color:rgba(255,255,255,0.3);margin-bottom:2px">Background</div>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="ck-enable" ${checker.enabled ? 'checked' : ''}>
                Show checkerboard
            </label>
            <label style="display:flex;align-items:center;gap:6px">
                Scale
                <input type="range" id="ck-scale" min="8" max="64" step="4"
                       value="${checker.scale}" style="flex:1;accent-color:var(--accent,#a88)">
            </label>
            <label style="display:flex;align-items:center;gap:6px">
                Opacity
                <input type="range" id="ck-opacity" min="0" max="1" step="0.05"
                       value="${checker.opacity}" style="flex:1;accent-color:var(--accent,#a88)">
            </label>`

        extrasBtn.addEventListener('click', e => {
            e.stopPropagation()
            const open = dropdown.style.display === 'flex'
            dropdown.style.display = open ? 'none' : 'flex'
        })
        document.addEventListener('click', () => { dropdown.style.display = 'none' })
        dropdown.addEventListener('click', e => e.stopPropagation())

        header.appendChild(extrasBtn)
        header.appendChild(dropdown)
        container.appendChild(header)

        dropdown.querySelector('#ck-enable').addEventListener('change', e => {
            checker.enabled = e.target.checked; this.markDirty()
        })
        dropdown.querySelector('#ck-scale').addEventListener('input', e => {
            checker.scale = parseFloat(e.target.value); this.markDirty()
        })
        dropdown.querySelector('#ck-opacity').addEventListener('input', e => {
            checker.opacity = parseFloat(e.target.value); this.markDirty()
        })

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

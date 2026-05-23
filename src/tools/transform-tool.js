// Modal transform tool — Blender-style G (grab), R (rotate), S (scale).
//
// Decoupled from viewport: only imports viewport for canvas ref, markDirty,
// setToolActive, addOverlayHook, and the coordinate helpers.
// Does NOT write to the journal (experimental posing, no undo yet).
//
// Flow:
//   1. Select instance (click in viewport — existing behaviour)
//   2. Press G / R / S
//   3. Move mouse to apply transform
//   4. Click / Enter to confirm   •   Right-click / Escape to cancel
//   5. After confirming G/R, press X or Y to constrain axis (restarts delta)

import scene    from '../scene/scene.js'
import viewport from '../ui/viewport.js'

// ── State ─────────────────────────────────────────────────────────────────

let _active         = false
let _mode           = null    // 'g' | 'r' | 's'
let _axis           = null    // null | 'x' | 'y'
let _instanceId     = null
let _startTransform = null    // snapshot taken at activation
let _refScreen      = null    // screen-px reference point (resets on axis change)
let _currentValue   = null    // display string shown in overlay

// ── rawMatrix decomposition ───────────────────────────────────────────────
// FLA-imported instances store a Flash affine matrix [a,b,c,d,tx,ty]
// instead of TRS. Convert to TRS in-place so the transform tool can work.

function _decomposeRawMatrix(inst) {
    if (!inst.rawMatrix) return
    const [a, b, c, d, tx, ty] = inst.rawMatrix
    inst.transform.x        = tx
    inst.transform.y        = ty
    inst.transform.rotation = Math.atan2(b, a)
    inst.transform.scaleX   = Math.sqrt(a * a + b * b)
    inst.transform.scaleY   = Math.sqrt(c * c + d * d)
    inst.rawMatrix = null
}

// ── Activation / deactivation ─────────────────────────────────────────────

function _activate(mode) {
    const id = viewport.selectedId
    if (!id) return

    const inst = scene.instances.find(i => i.id === id)
    if (!inst) return

    _decomposeRawMatrix(inst)

    _active         = true
    _mode           = mode
    _axis           = null
    _instanceId     = id
    _startTransform = { ...inst.transform }
    _refScreen      = null    // capture on first pointermove
    _currentValue   = ''
    // Get world origin now (before any transform changes) for R/S pivot.
    _pivotWorld     = viewport.getWorldOrigin(id) ?? { x: inst.transform.x, y: inst.transform.y }

    viewport.setToolActive(true)
    viewport.canvas.style.cursor = 'crosshair'
    viewport.markDirty()
}

function _confirm() {
    if (!_active) return
    _active = false; _pivotWorld = null
    viewport.setToolActive(false)
    viewport.canvas.style.cursor = ''
    viewport.markDirty()
}

function _cancel() {
    if (!_active) return
    const inst = scene.instances.find(i => i.id === _instanceId)
    if (inst) Object.assign(inst.transform, _startTransform)
    _active = false; _pivotWorld = null
    viewport.setToolActive(false)
    viewport.canvas.style.cursor = ''
    viewport.markDirty()
}

// ── Coordinate helper ─────────────────────────────────────────────────────

function _canvasXY(e) {
    const rect = viewport.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

// ── Apply transform ───────────────────────────────────────────────────────

// Cache world origin of the active instance for use across modes.
// Computed once at activation and kept current during the operation.
let _pivotWorld = null   // { x, y } world coords of instance origin

function _apply(cur) {
    if (!_refScreen) { _refScreen = cur; return }

    const inst = scene.instances.find(i => i.id === _instanceId)
    if (!inst) return

    if (_mode === 'g') {
        const startW = viewport.screenToWorld(_refScreen.x, _refScreen.y)
        const curW   = viewport.screenToWorld(cur.x, cur.y)
        let wdx = curW.x - startW.x
        let wdy = curW.y - startW.y
        // Axis constraint is applied in world space (matches screen axes).
        if (_axis === 'x') wdy = 0
        if (_axis === 'y') wdx = 0
        // For child instances transform.x/y is in parent-local space, so we
        // must convert the world-space delta through the parent's inverse matrix.
        if (inst.parentId) {
            const ld = viewport.worldDeltaToLocal(inst.parentId, wdx, wdy)
            wdx = ld.x;  wdy = ld.y
        }
        inst.transform.x = _startTransform.x + wdx
        inst.transform.y = _startTransform.y + wdy
        _currentValue = _axis
            ? `${_axis.toUpperCase()}: ${(_axis === 'x' ? wdx : wdy).toFixed(1)}`
            : `Δ ${wdx.toFixed(1)}, ${wdy.toFixed(1)}`

    } else if (_mode === 'r') {
        // Pivot = instance's world-space origin (registration point from Flash).
        const pivotW = _pivotWorld ?? { x: _startTransform.x, y: _startTransform.y }
        const pivotS = viewport.worldToScreen(pivotW.x, pivotW.y)
        const a0 = Math.atan2(_refScreen.y - pivotS.y, _refScreen.x - pivotS.x)
        const a1 = Math.atan2(cur.y      - pivotS.y, cur.x       - pivotS.x)
        const delta = a1 - a0
        inst.transform.rotation = _startTransform.rotation + delta
        _currentValue = `${(delta * 180 / Math.PI).toFixed(1)}°`

    } else if (_mode === 's') {
        const pivotW = _pivotWorld ?? { x: _startTransform.x, y: _startTransform.y }
        const pivotS = viewport.worldToScreen(pivotW.x, pivotW.y)
        const d0 = Math.hypot(_refScreen.x - pivotS.x, _refScreen.y - pivotS.y)
        if (d0 < 1) return
        const d1     = Math.hypot(cur.x - pivotS.x, cur.y - pivotS.y)
        const factor = d1 / d0
        if (_axis === 'x') {
            inst.transform.scaleX = _startTransform.scaleX * factor
        } else if (_axis === 'y') {
            inst.transform.scaleY = _startTransform.scaleY * factor
        } else {
            inst.transform.scaleX = _startTransform.scaleX * factor
            inst.transform.scaleY = _startTransform.scaleY * factor
        }
        _currentValue = _axis
            ? `${_axis.toUpperCase()}: ×${factor.toFixed(3)}`
            : `×${factor.toFixed(3)}`
    }

    viewport.markDirty()
}

// ── Overlay hook ──────────────────────────────────────────────────────────

const _AXIS_COLOR = { x: 'rgba(220,60,60,0.75)', y: 'rgba(60,200,80,0.75)' }

function _drawOverlay(ctx, w, h) {
    if (!_active) return
    const dpr = window.devicePixelRatio || 1

    ctx.save()
    ctx.scale(dpr, dpr)

    // ── Axis constraint line ─────────────────────────────────────────────
    if (_axis && _pivotWorld) {
        const pivotS  = viewport.worldToScreen(_pivotWorld.x, _pivotWorld.y)
        const color   = _AXIS_COLOR[_axis]
        ctx.save()
        ctx.strokeStyle = color
        ctx.lineWidth   = 1
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        if (_axis === 'x') {
            // horizontal line through pivot
            ctx.moveTo(0,  pivotS.y)
            ctx.lineTo(w,  pivotS.y)
        } else {
            // vertical line through pivot
            ctx.moveTo(pivotS.x, 0)
            ctx.lineTo(pivotS.x, h)
        }
        ctx.stroke()
        ctx.setLineDash([])

        // Axis label near pivot
        ctx.font      = 'bold 11px monospace'
        ctx.fillStyle = color
        const lx = _axis === 'x' ? w - 22 : pivotS.x + 6
        const ly = _axis === 'x' ? pivotS.y - 5 : 16
        ctx.fillText(_axis.toUpperCase(), lx, ly)
        ctx.restore()
    }

    // ── Status HUD (bottom-right) ────────────────────────────────────────
    const modeLabel = { g: 'GRAB', r: 'ROTATE', s: 'SCALE' }[_mode]
    const axisLabel = _axis ? ` · ${_axis.toUpperCase()}` : ''
    const header    = modeLabel + axisLabel
    const value     = _currentValue || '…'

    ctx.font = 'bold 13px monospace'
    const pad  = 8
    const tw   = Math.max(ctx.measureText(header).width, ctx.measureText(value).width)
    const bx   = w - tw - pad * 2 - 12
    const by   = h - 52

    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.beginPath()
    ctx.roundRect(bx, by, tw + pad * 2, 42, 4)
    ctx.fill()

    ctx.fillStyle = _axis ? _AXIS_COLOR[_axis] : 'rgba(255,200,50,0.95)'
    ctx.fillText(header, bx + pad, by + 16)
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = '12px monospace'
    ctx.fillText(value, bx + pad, by + 33)

    // Hint bar
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '10px monospace'
    ctx.fillText('Click/Enter confirm   Esc/RMB cancel   X/Y constrain', 12, h - 10)

    ctx.restore()
}

// ── Event handlers ────────────────────────────────────────────────────────

function _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

    if (!_active) {
        if (e.key === 'g' || e.key === 'G') { e.preventDefault(); _activate('g') }
        if (e.key === 'r' || e.key === 'R') { e.preventDefault(); _activate('r') }
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); _activate('s') }
        return
    }

    if (e.key === 'x' || e.key === 'X') {
        _axis = (_axis === 'x') ? null : 'x'
        _refScreen = null    // restart delta from current mouse pos
        viewport.markDirty()
    }
    if (e.key === 'y' || e.key === 'Y') {
        _axis = (_axis === 'y') ? null : 'y'
        _refScreen = null
        viewport.markDirty()
    }
    if (e.key === 'Escape') { e.preventDefault(); _cancel() }
    if (e.key === 'Enter')  { e.preventDefault(); _confirm() }
}

function _onPointerMove(e) {
    if (!_active) return
    _apply(_canvasXY(e))
}

function _onPointerDown(e) {
    if (!_active) return
    e.stopImmediatePropagation()    // prevent viewport _startTool from re-selecting
    if (e.button === 0) _confirm()
    if (e.button === 2) { e.preventDefault(); _cancel() }
}

// ── Init ──────────────────────────────────────────────────────────────────

function init() {
    const canvas = viewport.canvas
    window.addEventListener('keydown', _onKeyDown)
    // Capture phase so we can stopImmediatePropagation before viewport sees the click
    canvas.addEventListener('pointermove', _onPointerMove)
    canvas.addEventListener('pointerdown', _onPointerDown, { capture: true })
    viewport.addOverlayHook(_drawOverlay)
}

export { init }

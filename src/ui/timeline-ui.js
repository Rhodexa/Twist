// Timeline panel — canvas dopesheet.
//
// Layout:
//   [ play | frame/dur | fps ]   ← .tl-bar (HTML)
//   [ canvas ..................]  ← fills the rest of #timeline-panel
//
// Canvas columns:
//   LEFT_W px  — instance labels (fixed)
//   rest       — frame area: ruler row + one row per instance
//
// Scrubbing: click/drag anywhere in the ruler row or frame area sets the frame.
// Zooming:   mouse wheel on the canvas scales px-per-frame.

import scene    from '../scene/scene.js'
import viewport from './viewport.js'

// ── Layout constants ──────────────────────────────────────────────────────

const LEFT_W    = 160   // label column width (px)
const ROW_H     = 20    // height per instance row (px)
const RULER_H   = 24    // height of the frame ruler (px)
const MIN_PPF   = 1     // minimum px per frame (zoom out limit)
const MAX_PPF   = 40    // maximum px per frame (zoom in limit)
const KF_RADIUS = 3     // keyframe diamond half-size (px)

// ── State ─────────────────────────────────────────────────────────────────

let _canvas   = null
let _ctx      = null
let _ppf      = 6        // px per frame — current zoom
let _scrollX  = 0        // horizontal scroll offset in the frame area (px)
let _rows     = []       // { id, label, frames: number[] }
let _dragging = false

// ── Data extraction ───────────────────────────────────────────────────────

function _keyframesFor(inst) {
    // FLA-imported: use compressed matrix track frame positions.
    if (inst._matrixTrack?.length) return inst._matrixTrack.map(kf => kf.frame)

    // Native Twist: union of all TRS track frame positions.
    const frames = new Set()
    for (const track of Object.values(inst.tracks ?? {}))
        for (const kf of track) frames.add(kf.frame)
    return [...frames].sort((a, b) => a - b)
}

function _buildRows() {
    _rows = scene.instances
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(inst => ({
            id:     inst.id,
            label:  inst.label || inst.symbolId || inst.id,
            frames: _keyframesFor(inst),
            depth:  _depth(inst),
        }))
}

function _depth(inst) {
    let d = 0
    let cur = inst
    while (cur.parentId) {
        cur = scene.instances.find(i => i.id === cur.parentId) ?? { parentId: null }
        d++
    }
    return d
}

// ── Coordinate helpers ────────────────────────────────────────────────────

function _frameToX(f) {
    return LEFT_W + f * _ppf - _scrollX
}

function _xToFrame(x) {
    return Math.round((x - LEFT_W + _scrollX) / _ppf)
}

function _rowY(rowIdx) {
    return RULER_H + rowIdx * ROW_H
}

// ── Rendering ─────────────────────────────────────────────────────────────

const C = {
    bg:        '#181818',
    bgLabel:   '#1c1c1c',
    border:    'rgba(255,255,255,0.07)',
    ruler:     '#141414',
    rulerText: 'rgba(255,255,255,0.35)',
    rulerMaj:  'rgba(255,255,255,0.18)',
    rulerMin:  'rgba(255,255,255,0.07)',
    rowAlt:    'rgba(255,255,255,0.025)',
    rowHover:  'rgba(255,255,255,0.05)',
    label:     'rgba(255,255,255,0.7)',
    labelDim:  'rgba(255,255,255,0.35)',
    kf:        '#c89fff',
    playhead:  '#ff6060',
}

function _render() {
    if (!_canvas || !_ctx) return

    const dpr = window.devicePixelRatio || 1
    const W   = _canvas.width  / dpr
    const H   = _canvas.height / dpr
    const dur = scene.timeline.duration
    const cur = scene.timeline.currentFrame

    _ctx.save()
    _ctx.scale(dpr, dpr)
    _ctx.clearRect(0, 0, W, H)

    // ── Background ────────────────────────────────────────────────────────
    _ctx.fillStyle = C.bg
    _ctx.fillRect(0, 0, W, H)

    // ── Label column background ───────────────────────────────────────────
    _ctx.fillStyle = C.bgLabel
    _ctx.fillRect(0, 0, LEFT_W, H)

    // ── Ruler ─────────────────────────────────────────────────────────────
    _ctx.fillStyle = C.ruler
    _ctx.fillRect(0, 0, W, RULER_H)

    _ctx.font = `10px monospace`
    _ctx.textBaseline = 'middle'

    // Tick interval: choose a step that keeps ticks ≥ 3px apart visually.
    const steps = [1, 2, 5, 10, 24, 48, 96]
    const majorStep = steps.find(s => s * _ppf >= 40) ?? 96
    const minorStep = steps.find(s => s * _ppf >= 6)  ?? majorStep

    const firstFrame = Math.floor(_scrollX / _ppf)
    const lastFrame  = Math.ceil((_scrollX + W - LEFT_W) / _ppf)

    for (let f = firstFrame; f <= Math.min(lastFrame, dur); f++) {
        const x = _frameToX(f)
        if (x < LEFT_W) continue

        const isMajor = (f % majorStep === 0)
        const isMinor = (f % minorStep === 0)
        if (!isMajor && !isMinor) continue

        _ctx.strokeStyle = isMajor ? C.rulerMaj : C.rulerMin
        _ctx.lineWidth = 1
        _ctx.beginPath()
        _ctx.moveTo(x + 0.5, isMajor ? 0 : RULER_H * 0.6)
        _ctx.lineTo(x + 0.5, RULER_H)
        _ctx.stroke()

        if (isMajor) {
            _ctx.fillStyle = C.rulerText
            _ctx.textAlign = 'left'
            _ctx.fillText(String(f), x + 2, RULER_H / 2)
        }
    }

    // ── Row area ──────────────────────────────────────────────────────────
    const clipTop = RULER_H
    _ctx.save()
    _ctx.beginPath()
    _ctx.rect(0, clipTop, W, H - clipTop)
    _ctx.clip()

    for (let i = 0; i < _rows.length; i++) {
        const row = _rows[i]
        const y   = _rowY(i)

        // Row background (alternating)
        if (i % 2 === 1) {
            _ctx.fillStyle = C.rowAlt
            _ctx.fillRect(0, y, W, ROW_H)
        }

        // Row separator line
        _ctx.strokeStyle = C.border
        _ctx.lineWidth = 1
        _ctx.beginPath()
        _ctx.moveTo(0, y + ROW_H - 0.5)
        _ctx.lineTo(W, y + ROW_H - 0.5)
        _ctx.stroke()

        // Instance label
        const indent = row.depth * 12
        _ctx.fillStyle = row.depth === 0 ? C.label : C.labelDim
        _ctx.font = `${row.depth === 0 ? '11' : '10'}px sans-serif`
        _ctx.textAlign = 'left'
        _ctx.textBaseline = 'middle'
        _ctx.fillText(row.label, 6 + indent, y + ROW_H / 2, LEFT_W - 10 - indent)

        // Keyframe diamonds
        _ctx.fillStyle = C.kf
        for (const f of row.frames) {
            const kx = _frameToX(f)
            if (kx < LEFT_W || kx > W) continue
            const ky = y + ROW_H / 2
            _ctx.beginPath()
            _ctx.moveTo(kx,           ky - KF_RADIUS)
            _ctx.lineTo(kx + KF_RADIUS, ky)
            _ctx.lineTo(kx,           ky + KF_RADIUS)
            _ctx.lineTo(kx - KF_RADIUS, ky)
            _ctx.closePath()
            _ctx.fill()
        }
    }

    _ctx.restore()

    // ── Label / frame area separator ──────────────────────────────────────
    _ctx.strokeStyle = C.border
    _ctx.lineWidth = 1
    _ctx.beginPath()
    _ctx.moveTo(LEFT_W + 0.5, 0)
    _ctx.lineTo(LEFT_W + 0.5, H)
    _ctx.stroke()

    // ── Playhead ──────────────────────────────────────────────────────────
    const px = _frameToX(cur)
    if (px >= LEFT_W && px <= W) {
        _ctx.strokeStyle = C.playhead
        _ctx.lineWidth = 1
        _ctx.beginPath()
        _ctx.moveTo(px + 0.5, 0)
        _ctx.lineTo(px + 0.5, H)
        _ctx.stroke()

        // Playhead head (triangle)
        _ctx.fillStyle = C.playhead
        _ctx.beginPath()
        _ctx.moveTo(px - 5, 0)
        _ctx.lineTo(px + 5, 0)
        _ctx.lineTo(px + 0.5, 8)
        _ctx.closePath()
        _ctx.fill()
    }

    _ctx.restore()
}

// ── Resize ────────────────────────────────────────────────────────────────

function _resize() {
    if (!_canvas) return
    const dpr = window.devicePixelRatio || 1
    const w   = _canvas.clientWidth
    const h   = _canvas.clientHeight
    _canvas.width  = Math.round(w * dpr)
    _canvas.height = Math.round(h * dpr)
    _render()
}

// ── Seek / scrub ──────────────────────────────────────────────────────────

function _seek(x) {
    if (x < LEFT_W) return
    const f = Math.max(0, Math.min(scene.timeline.duration - 1, _xToFrame(x)))
    scene.timeline.currentFrame = f
    document.dispatchEvent(new CustomEvent('twist:frameChange'))
    viewport.markDirty()
}

// ── Public API ────────────────────────────────────────────────────────────

export function togglePlay() {
    scene.timeline.playing = !scene.timeline.playing
    const btn = document.getElementById('tw-play')
    if (btn) btn.textContent = scene.timeline.playing ? '⏸' : '▶'
    if (scene.timeline.playing) viewport.markDirty()
}

export function initTimelineUI() {
    const panel = document.getElementById('timeline-panel')

    // ── Top bar (HTML) ────────────────────────────────────────────────────
    const bar = document.createElement('div')
    bar.className = 'tl-bar'
    bar.innerHTML = `
        <button class="tl-btn" id="tw-play">▶</button>
        <span class="tl-frame" id="tw-frame">0</span>
        <span class="tl-dur" id="tw-dur">/ ${scene.timeline.duration}</span>
        <span class="tl-fps" id="tw-fps">${scene.timeline.fps} fps</span>
    `
    panel.appendChild(bar)

    document.getElementById('tw-play').addEventListener('click', togglePlay)

    // ── Canvas ────────────────────────────────────────────────────────────
    _canvas = document.createElement('canvas')
    _canvas.style.cssText = 'flex:1;display:block;width:100%;height:0;min-height:0;cursor:crosshair'
    panel.appendChild(_canvas)
    _ctx = _canvas.getContext('2d')

    // ── Mouse: scrub ──────────────────────────────────────────────────────
    _canvas.addEventListener('pointerdown', e => {
        _dragging = true
        _canvas.setPointerCapture(e.pointerId)
        _seek(e.offsetX)
    })
    _canvas.addEventListener('pointermove', e => {
        if (_dragging) _seek(e.offsetX)
    })
    _canvas.addEventListener('pointerup', () => { _dragging = false })

    // ── Mouse: zoom (wheel) ───────────────────────────────────────────────
    _canvas.addEventListener('wheel', e => {
        e.preventDefault()
        const pivotFrame = _xToFrame(e.offsetX)
        _ppf = Math.max(MIN_PPF, Math.min(MAX_PPF, _ppf * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
        // Keep pivot frame under cursor after zoom.
        _scrollX = pivotFrame * _ppf - (e.offsetX - LEFT_W)
        _scrollX = Math.max(0, _scrollX)
        _render()
    }, { passive: false })

    // ── Resize ────────────────────────────────────────────────────────────
    const ro = new ResizeObserver(_resize)
    ro.observe(_canvas)

    // ── Events ────────────────────────────────────────────────────────────
    document.addEventListener('twist:sceneChanged', () => {
        _buildRows()
        const dur = scene.timeline.duration
        document.getElementById('tw-dur').textContent  = `/ ${dur}`
        document.getElementById('tw-fps').textContent  = `${scene.timeline.fps} fps`
        _render()
    })

    document.addEventListener('twist:frameChange', () => {
        const f   = scene.timeline.currentFrame
        const dur = scene.timeline.duration
        document.getElementById('tw-frame').textContent = f
        document.getElementById('tw-play').textContent  = scene.timeline.playing ? '⏸' : '▶'
        // Auto-scroll to keep playhead visible.
        const px = _frameToX(f)
        const W  = _canvas.clientWidth
        if (px < LEFT_W + 20)           _scrollX = Math.max(0, f * _ppf - 20)
        else if (px > W - 20)           _scrollX = f * _ppf - (W - LEFT_W) + 20
        _render()
    })

    _buildRows()
    _resize()
}

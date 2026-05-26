// Viewport stats overlay — reads scene data, never touches the render pipeline.
// All numbers are derived from scene.symbols / scene.instances after tessellation.
// Updates on twist:sceneChanged (fires on frame change, import, scene edits).
// Toggle with backtick (`).

import scene from '../scene/scene.js'

const _container = document.getElementById('viewport-container')
let   _el        = null
let   _visible   = true

// ── Stats computation ─────────────────────────────────────────────────────
// Walks scene.symbols to count GPU-side data (tessellated Float32Arrays) and
// source-side data (raw bezier commands). Both are already in memory.

function _compute() {
    let verts    = 0
    let tris     = 0
    let curves   = 0  // Q-type bezier commands in source paths
    let lineSegs = 0  // L-type commands in source paths
    let regions  = 0  // fill + stroke regions

    for (const sym of scene.symbols) {
        // GPU stats from tessellated meshes.
        if (sym.renderGroups) {
            for (const g of sym.renderGroups) {
                const meshes = g.type === 'plain'
                    ? g.meshes
                    : [...(g.maskMeshes ?? []), ...(g.contentMeshes ?? [])]
                for (const m of meshes) {
                    verts += m.vertices.length / 2   // xy pairs
                    tris  += m.vertices.length / 6   // 3 verts × 2 floats
                }
            }
        }

        // Source stats from raw bezier groups.
        if (sym._groups) {
            for (const g of sym._groups) {
                const regs = g.type === 'plain'
                    ? (g.regions ?? [])
                    : [...(g.maskRegions ?? []), ...(g.contentRegions ?? [])]
                regions += regs.length
                for (const r of regs) {
                    for (const seg of r.segs) {
                        // seg[0] is the start point (M); seg[1..] are L or Q commands.
                        for (let i = 1; i < seg.length; i++) {
                            if      (seg[i].type === 'Q') curves++
                            else if (seg[i].type === 'L') lineSegs++
                        }
                    }
                }
            }
        }
    }

    return {
        instances: scene.instances.length,
        symbols:   scene.symbols.length,
        regions,
        verts:     Math.round(verts),
        tris:      Math.round(tris),
        curves,
        lineSegs,
    }
}

// ── DOM ───────────────────────────────────────────────────────────────────

function _fmt(n) {
    return n.toLocaleString()
}

function _makeEl() {
    const el = document.createElement('div')
    el.id = 'stats-overlay'
    _container.appendChild(el)
    return el
}

function _row(label, value, dimLabel = false) {
    const row = document.createElement('div')
    row.className = 'stats-row'

    const k = document.createElement('span')
    k.className   = 'stats-key' + (dimLabel ? ' stats-key-dim' : '')
    k.textContent = label

    const v = document.createElement('span')
    v.className   = 'stats-val'
    v.textContent = _fmt(value)

    row.append(k, v)
    return row
}

function _sep() {
    const el = document.createElement('div')
    el.className = 'stats-sep'
    return el
}

function _section(label) {
    const el = document.createElement('div')
    el.className   = 'stats-section'
    el.textContent = label
    return el
}

function _update() {
    if (!_visible || !_el) return

    const s = _compute()

    _el.innerHTML = ''
    _el.append(
        _row('Verts',  s.verts),
        _row('Tris',   s.tris),
        _section('Source'),
        _row('Curves Q', s.curves),
        _row('Lines L',  s.lineSegs),
        _row('Regions',  s.regions),
        _section('Scene'),
        _row('Instances', s.instances),
        _row('Symbols',   s.symbols),
    )
}

// ── Public API ────────────────────────────────────────────────────────────

function toggle() {
    _visible = !_visible
    if (_visible) {
        if (!_el) _el = _makeEl()
        _el.style.display = ''
        _update()
    } else if (_el) {
        _el.style.display = 'none'
    }
}

function initStats() {
    _el = _makeEl()
    document.addEventListener('twist:sceneChanged', _update)
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
        if (e.key === '`') toggle()
    })
}

export { initStats }

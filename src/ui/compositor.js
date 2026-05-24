// Compositor tree panel — mirrors viewport's drawInstTree traversal exactly.
// Shows the render hierarchy: instances, symbol render groups (plain/masked),
// and which children are masked by which group vs. left unmasked.
// Use this to diagnose mask issues: if an instance is missing from under its
// expected ◈ group, the bug is in import.js maskId resolution or
// in the symbol's renderGroups mask detection.

import scene    from '../scene/scene.js'
import viewport from './viewport.js'

const _panel    = document.getElementById('panel-left')
const _collapsed = new Set()
let   _tree      = null

// ── DOM helpers ────────────────────────────────────────────────────────────

function _row(cls, icon, label, detail) {
    const el = document.createElement('div')
    el.className = 'ct-row ' + cls

    const ico = document.createElement('span')
    ico.className   = 'ct-icon'
    ico.textContent = icon

    const lbl = document.createElement('span')
    lbl.className   = 'ct-label'
    lbl.textContent = label

    el.append(ico, lbl)

    if (detail != null) {
        const det = document.createElement('span')
        det.className   = 'ct-detail'
        det.textContent = detail
        el.appendChild(det)
    }
    return el
}

// ── Tree builder ───────────────────────────────────────────────────────────

// Build the DOM subtree for one instance and its children.
// Mirrors viewport.js drawInstTree logic exactly — same child partitioning.
function _renderInst(inst, childrenOf) {
    const sym    = scene.symbols.find(s => s.id === inst.symbolId)
    const groups = sym?.renderGroups ?? []

    // Partition children into masked groups vs. unmasked — identical to viewport.
    const knownMaskIds = new Set(
        groups.filter(g => g.type === 'masked').map(g => g.maskId)
    )
    const maskedByGroup = new Map()
    const unmaskedKids  = []
    for (const child of (childrenOf.get(inst.id) ?? [])) {
        const mk = child.maskId
        if (mk != null && knownMaskIds.has(mk)) {
            if (!maskedByGroup.has(mk)) maskedByGroup.set(mk, [])
            maskedByGroup.get(mk).push(child)
        } else {
            unmaskedKids.push(child)
        }
    }

    const hasKids = childrenOf.has(inst.id)
    const hasBody = groups.length > 0 || hasKids
    const isOpen  = hasBody && !_collapsed.has(inst.id)

    const node = document.createElement('div')
    node.className = 'ct-node'

    // Instance header row
    const maskTag = inst.maskId != null ? `→ ${inst.maskId}` : null
    const instRow = _row(
        'ct-inst',
        hasBody ? (isOpen ? '▾' : '▸') : '·',
        inst.label || sym?.label || inst.symbolId,
        maskTag
    )
    if (maskTag) instRow.querySelector('.ct-detail').classList.add('ct-detail-mask')
    if (hasBody) {
        instRow.addEventListener('click', () => {
            _collapsed.has(inst.id) ? _collapsed.delete(inst.id) : _collapsed.add(inst.id)
            refresh()
        })
    }
    instRow.addEventListener('mouseenter', () => viewport.setHoverHighlight(inst.id))
    instRow.addEventListener('mouseleave', () => viewport.setHoverHighlight(null))
    node.appendChild(instRow)

    if (!isOpen) return node

    const body = document.createElement('div')
    body.className = 'ct-body'

    // Render groups — in order, same as viewport draws them.
    for (const g of groups) {
        if (g.type === 'plain') {
            const n   = g.meshes?.length ?? 0
            const row = _row('ct-group-plain', '▪', 'plain', `${n} mesh${n !== 1 ? 'es' : ''}`)
            if (n === 0) row.classList.add('ct-warn')
            body.appendChild(row)
        } else {
            const mk   = g.maskMeshes?.length   ?? 0
            const ck   = g.contentMeshes?.length ?? 0
            const kids = maskedByGroup.get(g.maskId) ?? []
            const row  = _row(
                'ct-group-masked',
                '◈',
                `mask  ${g.maskId}`,
                `${mk}m · ${ck}c · ${kids.length}i`
            )
            // Warn if no mask geometry — mask will be invisible (nothing clips)
            if (mk === 0) row.classList.add('ct-warn')
            row.addEventListener('mouseenter', () => viewport.setHoverHighlight(inst.id, g.maskId))
            row.addEventListener('mouseleave', () => viewport.setHoverHighlight(null))
            body.appendChild(row)

            // Masked children drawn inside this stencil region
            for (const kid of kids)
                body.appendChild(_renderInst(kid, childrenOf))
        }
    }

    // Unmasked children — drawn after all groups
    for (const kid of unmaskedKids)
        body.appendChild(_renderInst(kid, childrenOf))

    node.appendChild(body)
    return node
}

// ── Refresh ────────────────────────────────────────────────────────────────

function _collapseAll() {
    _collapsed.clear()
    for (const inst of scene.instances) {
        if (scene.instances.some(i => i.parentId === inst.id))
            _collapsed.add(inst.id)
    }
    refresh()
}

function refresh() {
    if (!_tree) return

    const childrenOf = new Map()
    for (const inst of scene.instances) {
        const pid = inst.parentId ?? null
        if (!childrenOf.has(pid)) childrenOf.set(pid, [])
        childrenOf.get(pid).push(inst)
    }
    for (const ch of childrenOf.values())
        ch.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

    const frag = document.createDocumentFragment()
    for (const root of (childrenOf.get(null) ?? []))
        frag.appendChild(_renderInst(root, childrenOf))
    _tree.replaceChildren(frag)
}

// ── Init ───────────────────────────────────────────────────────────────────

function initCompositor() {
    const header = document.createElement('div')
    header.className = 'ct-header'
    header.textContent = 'Compositor'

    _tree = document.createElement('div')
    _tree.id = 'compositor-tree'

    _panel.appendChild(header)
    _panel.appendChild(_tree)

    // ── Resize handle ────────────────────────────────────────────────────
    const handle = document.getElementById('resize-handle-left')
    if (handle) {
        let dragging = false
        let startX   = 0
        let startW   = 0

        handle.addEventListener('pointerdown', e => {
            dragging = true
            startX   = e.clientX
            startW   = _panel.getBoundingClientRect().width
            handle.classList.add('dragging')
            handle.setPointerCapture(e.pointerId)
            e.preventDefault()
        })

        handle.addEventListener('pointermove', e => {
            if (!dragging) return
            const w = Math.max(120, Math.min(600, startW + (e.clientX - startX)))
            document.documentElement.style.setProperty('--left-panel-w', w + 'px')
        })

        handle.addEventListener('pointerup', () => {
            dragging = false
            handle.classList.remove('dragging')
        })
    }

    document.addEventListener('twist:sceneChanged', _collapseAll)
    document.addEventListener('twist:flaImported',  _collapseAll)
    _collapseAll()
}

export { initCompositor }

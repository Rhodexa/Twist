// Outliner — scene instance tree panel (right panel).
// Rebuilds from scene.instances on 'twist:sceneChanged' and selection changes.

import scene    from '../scene/scene.js'
import viewport from './viewport.js'

const panel = document.getElementById('panel-right')

// ── State ──────────────────────────────────────────────────────────────────

const collapsed = new Set()   // instance IDs that are collapsed in the UI

// ── Rendering ─────────────────────────────────────────────────────────────

function buildChildrenMap() {
    const map = new Map()   // parentId|null → [instance, ...]
    for (const inst of scene.instances) {
        const pid = inst.parentId ?? null
        if (!map.has(pid)) map.set(pid, [])
        map.get(pid).push(inst)
    }
    for (const children of map.values())
        children.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    return map
}

function symbolLabel(inst) {
    // Use instance label if set, otherwise fall back to symbol name
    if (inst.label) return inst.label
    const sym = scene.symbols.find(s => s.id === inst.symbolId)
    return sym?.label ?? sym?.name ?? inst.symbolId
}

function buildRows(childrenOf, parentId, depth, rows) {
    for (const inst of (childrenOf.get(parentId) ?? [])) {
        const hasChildren = (childrenOf.get(inst.id) ?? []).length > 0
        rows.push({ inst, depth, hasChildren })
        if (hasChildren && !collapsed.has(inst.id))
            buildRows(childrenOf, inst.id, depth + 1, rows)
    }
}

function render() {
    const selId      = viewport.selectedId
    const childrenOf = buildChildrenMap()
    const rows       = []
    buildRows(childrenOf, null, 0, rows)

    const frag = document.createDocumentFragment()

    for (const { inst, depth, hasChildren } of rows) {
        const row = document.createElement('div')
        row.className = 'outliner-row' + (inst.id === selId ? ' selected' : '')
        row.dataset.id = inst.id

        // Indent
        const indent = document.createElement('span')
        indent.className = 'outliner-indent'
        indent.style.width = `${depth * 14}px`
        row.appendChild(indent)

        // Expand / collapse triangle
        const arrow = document.createElement('span')
        arrow.className = 'outliner-arrow'
        if (hasChildren) {
            arrow.textContent = collapsed.has(inst.id) ? '▶' : '▼'
            arrow.addEventListener('click', e => {
                e.stopPropagation()
                collapsed.has(inst.id) ? collapsed.delete(inst.id) : collapsed.add(inst.id)
                render()
            })
        } else {
            arrow.textContent = '●'
            arrow.style.opacity = '0.35'
        }
        row.appendChild(arrow)

        // Label
        const label = document.createElement('span')
        label.className = 'outliner-label'
        label.textContent = symbolLabel(inst)
        row.appendChild(label)

        // Click → select
        row.addEventListener('click', () => {
            viewport.setSelected(inst.id)
            render()
        })

        frag.appendChild(row)
    }

    tree.replaceChildren(frag)
}

// ── DOM setup ─────────────────────────────────────────────────────────────

const header = document.createElement('div')
header.className = 'outliner-header'
header.textContent = 'Scene'

const tree = document.createElement('div')
tree.id = 'outliner-tree'

panel.appendChild(header)
panel.appendChild(tree)

// ── Lifecycle ──────────────────────────────────────────────────────────────

function initOutliner() {
    document.addEventListener('twist:sceneChanged',    render)
    document.addEventListener('twist:selectionChanged', render)
    render()
}

export { initOutliner, render as refreshOutliner }

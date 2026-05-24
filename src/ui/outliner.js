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

// Collapse every node that has children. Called on init and scene reload.
function collapseAll() {
    const childrenOf = buildChildrenMap()
    collapsed.clear()
    for (const pid of childrenOf.keys())
        if (pid !== null) collapsed.add(pid)
    render()
}

function symbolLabel(inst) {
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
    const activeId = viewport.activeId
    const sel      = viewport.selectionIds   // Set

    const childrenOf = buildChildrenMap()
    const rows       = []
    buildRows(childrenOf, null, 0, rows)

    const frag = document.createDocumentFragment()
    let activeRow = null

    for (const { inst, depth, hasChildren } of rows) {
        const isActive   = inst.id === activeId
        const isSelected = sel.has(inst.id)

        const row = document.createElement('div')
        row.className  = 'outliner-row'
        row.dataset.id = inst.id

        if (isActive) {
            row.style.background = 'rgba(255,200,50,0.22)'
            row.style.color      = 'rgba(255,200,50,1)'
            row.style.outline    = '1px solid rgba(255,200,50,0.5)'
            row.style.outlineOffset = '-1px'
            activeRow = row
        } else if (isSelected) {
            row.style.background = 'rgba(255,140,30,0.18)'
            row.style.color      = 'rgba(255,160,50,0.9)'
        }

        // Indent
        const indent = document.createElement('span')
        indent.className   = 'outliner-indent'
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
            arrow.textContent  = '●'
            arrow.style.opacity = '0.35'
        }
        row.appendChild(arrow)

        // Label
        const label = document.createElement('span')
        label.className   = 'outliner-label'
        label.textContent = symbolLabel(inst)
        row.appendChild(label)

        // Click: normal = setSelected, Shift = toggle in/out of multi-selection
        row.addEventListener('click', e => {
            if (e.shiftKey) viewport.toggleSelected(inst.id)
            else            viewport.setSelected(inst.id)
        })

        frag.appendChild(row)
    }

    tree.replaceChildren(frag)

    // Scroll active row into view without jarring jumps
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' })
}

// ── DOM setup ─────────────────────────────────────────────────────────────

const header = document.createElement('div')
header.className   = 'outliner-header'
header.style.cssText = 'display:flex;align-items:center;justify-content:space-between'

const headerTitle = document.createElement('span')
headerTitle.textContent = 'Scene'
header.appendChild(headerTitle)

const collapseBtn = document.createElement('button')
collapseBtn.textContent = '⊟'
collapseBtn.title = 'Collapse all'
collapseBtn.style.cssText = [
    'background:none', 'border:none', 'cursor:pointer',
    'color:var(--text-secondary)', 'font-size:13px',
    'padding:0 2px', 'line-height:1', 'opacity:0.7',
].join(';')
collapseBtn.addEventListener('mouseenter', () => { collapseBtn.style.opacity = '1' })
collapseBtn.addEventListener('mouseleave', () => { collapseBtn.style.opacity = '0.7' })
collapseBtn.addEventListener('click', collapseAll)
header.appendChild(collapseBtn)

const tree = document.createElement('div')
tree.id = 'outliner-tree'

panel.appendChild(header)
panel.appendChild(tree)

// ── Lifecycle ──────────────────────────────────────────────────────────────

function initOutliner() {
    document.addEventListener('twist:sceneChanged',     collapseAll)
    document.addEventListener('twist:selectionChanged', render)
    collapseAll()   // start collapsed
}

export { initOutliner, render as refreshOutliner }

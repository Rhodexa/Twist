// Entry point. Wires up modules. Owns startup order.

import journal  from './journal/journal.js'
import scene    from './scene/scene.js'
import viewport from './ui/viewport.js'
import          './input/input.js'    // side-effect import: registers Ctrl+Z / Y / S

// ── Viewport ──────────────────────────────────────────────────────────────

viewport.init()

// ── App-level keyboard shortcuts ──────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

    // F — fit the scene camera into the viewport
    if (e.key === 'f' || e.key === 'F') viewport.fitCamera()
})

// ── Save (Ctrl+S) ─────────────────────────────────────────────────────────

document.addEventListener('twist:save', () => {
    console.log('[twist] save — not yet implemented')
})

// ── Title bar reflects unsaved changes ────────────────────────────────────

journal.on('change', () => {
    document.title = `Twist — untitled${journal.canUndo() ? ' •' : ''}`
})

// ── Dev helpers (accessible from DevTools console) ────────────────────────

window._journal  = journal
window._scene    = scene
window._viewport = viewport

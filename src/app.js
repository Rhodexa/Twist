// Entry point. Wires up modules. Owns startup order.

import journal                    from './journal/journal.js'
import scene                      from './scene/scene.js'
import viewport                   from './ui/viewport.js'
import { initTimelineUI, togglePlay } from './ui/timeline-ui.js'
import                                 './input/input.js'   // registers Ctrl+Z / Y / S

// ── Startup ───────────────────────────────────────────────────────────────

viewport.init()
initTimelineUI()

// ── App-level keyboard shortcuts ──────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

    switch (e.key) {
        case 'f':
        case 'F':
            viewport.fitCamera()
            break

        // Enter — toggle play / pause
        case 'Enter':
            e.preventDefault()
            togglePlay()
            break

        // K — set keyframe for the selected instance at the current frame
        case 'k':
        case 'K': {
            const id   = viewport.selectedId
            const inst = scene.instances.find(i => i.id === id)
            if (!inst) break

            const frame  = scene.timeline.currentFrame
            const props  = ['x', 'y', 'rotation', 'scaleX', 'scaleY']

            // One journal command per property so each can be individually undone.
            // Capture the old keyframe (if any) for undo.
            for (const prop of props) {
                const value   = inst.transform[prop]
                const track   = inst.tracks[prop]
                const oldIdx  = track.findIndex(kf => kf.frame === frame)
                const oldKf   = oldIdx >= 0 ? { ...track[oldIdx] } : null

                journal.push({
                    execute: () => {
                        const idx = inst.tracks[prop].findIndex(kf => kf.frame === frame)
                        if (idx >= 0) inst.tracks[prop][idx].value = value
                        else {
                            inst.tracks[prop].push({ frame, value })
                            inst.tracks[prop].sort((a, b) => a.frame - b.frame)
                        }
                        viewport.markDirty()
                    },
                    undo: () => {
                        const idx = inst.tracks[prop].findIndex(kf => kf.frame === frame)
                        if (oldKf)  inst.tracks[prop][idx].value = oldKf.value
                        else if (idx >= 0) inst.tracks[prop].splice(idx, 1)
                        viewport.markDirty()
                    }
                })
            }
            break
        }
    }
})

// ── Save (Ctrl+S) ─────────────────────────────────────────────────────────

document.addEventListener('twist:save', () => {
    console.log('[twist] save — not yet implemented')
})

// ── Title reflects unsaved changes ────────────────────────────────────────

journal.on('change', () => {
    document.title = `Twist — untitled${journal.canUndo() ? ' •' : ''}`
})

// ── Dev helpers ───────────────────────────────────────────────────────────

window._journal  = journal
window._scene    = scene
window._viewport = viewport

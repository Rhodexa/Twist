// Entry point. Wires up modules. Owns startup order.

import journal                    from './journal/journal.js'
import scene                      from './scene/scene.js'
import viewport                   from './ui/viewport.js'
import { initTimelineUI, togglePlay } from './ui/timeline-ui.js'
import { importFla }              from './fla/import.js'
import { initOutliner }          from './ui/outliner.js'
import                                 './input/input.js'   // registers Ctrl+Z / Y / S

// ── Startup ───────────────────────────────────────────────────────────────

viewport.init()
initTimelineUI()
initOutliner()

// ── App-level keyboard shortcuts ──────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

    switch (e.key) {
        case 'f':
        case 'F':
            viewport.fitCamera()
            break

        // O — open a .fla file and dump its structure to the console (debug)
        case 'o':
        case 'O':
            window.twist.openFla().then(result => {
                if (!result) return
                if (result.error) { console.error('[fla] open failed:', result.error); return }
                console.log('[fla] path:', result.path)
                console.log('[fla] entries (%d total):', result.entries.length, result.entries)
                console.log('[fla] library symbols (%d):', result.libEntries.length, result.libEntries)
                if (result.dom) {
                    console.log('[fla] DOMDocument.xml (first 4000 chars):\n', result.dom.slice(0, 4000))
                }
                if (result.libXmls) {
                    const keys = Object.keys(result.libXmls)
                    console.log('[fla] library XMLs loaded:', keys.length)
                    for (const k of keys.slice(0, 3)) {
                        console.log(`\n[fla] ${k} (first 2000 chars):\n`, result.libXmls[k].slice(0, 2000))
                    }
                }
            })
            break

        // I — import a .fla file into the scene
        case 'i':
        case 'I':
            importFla()
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

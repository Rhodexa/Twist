// Entry point. Wires up modules. Owns startup order.

import journal                    from './journal/journal.js'
import scene                      from './scene/scene.js'
import viewport                   from './ui/viewport.js'
import { initTimelineUI, togglePlay } from './ui/timeline-ui.js'
import { importFla, scrubToFrame } from './fla/import.js'
import { initOutliner }          from './ui/outliner.js'
import { initCompositor }        from './ui/compositor.js'
import { initStats }             from './ui/stats.js'
import                                 './input/input.js'   // registers Ctrl+Z / Y / S
import { init as initTransformTool }  from './tools/transform-tool.js'

// ── Startup ───────────────────────────────────────────────────────────────

viewport.init()
initTimelineUI()
initOutliner()
initCompositor()
initTransformTool()    // G / R / S modal transform tool
initStats()            // backtick to toggle

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

// ── FLA frame scrubber ────────────────────────────────────────────────────
// Lives between the viewport and the timeline panel. Created on first import,
// updated if a new file is opened. Hidden when frameCount === 1.

let _scrubberEl   = null
let _flaPlaying   = false
let _flaPlayRaf   = null
let _flaFrame     = 0
let _flaFrameCount = 0
let _flaLastTime  = 0

function _flaPlayTick(now) {
    if (!_flaPlaying) return
    const elapsed = now - _flaLastTime
    if (elapsed >= 1000 / 24) {   // ~24 fps scrub playback
        _flaLastTime = now
        _flaFrame = (_flaFrame + 1) % _flaFrameCount
        _flaPlayUpdate(_flaFrame)
    }
    _flaPlayRaf = requestAnimationFrame(_flaPlayTick)
}

function _flaPlayUpdate(f) {
    const slider  = _scrubberEl?.querySelector('input[type=range]')
    const counter = _scrubberEl?.querySelector('.fla-counter')
    if (slider)  slider.value     = f
    if (counter) counter.textContent = `${f} / ${_flaFrameCount - 1}`
    scrubToFrame(f)
}

function _flaTogglePlay(playBtn) {
    _flaPlaying = !_flaPlaying
    playBtn.textContent = _flaPlaying ? '⏹' : '▶'
    if (_flaPlaying) {
        _flaLastTime = performance.now()
        _flaPlayRaf  = requestAnimationFrame(_flaPlayTick)
    } else {
        cancelAnimationFrame(_flaPlayRaf)
    }
}

document.addEventListener('twist:flaImported', e => {
    const { frameCount } = e.detail
    const panelCenter   = document.getElementById('panel-center')
    const timelinePanel = document.getElementById('timeline-panel')

    // Stop any running playback from a previous file
    _flaPlaying = false
    cancelAnimationFrame(_flaPlayRaf)
    if (_scrubberEl) { _scrubberEl.remove(); _scrubberEl = null }
    if (frameCount <= 1) return

    _flaFrame      = 0
    _flaFrameCount = frameCount

    _scrubberEl = document.createElement('div')
    _scrubberEl.id = 'fla-scrubber-bar'
    _scrubberEl.style.cssText = [
        'display:flex', 'align-items:center', 'gap:12px',
        'padding:6px 14px', 'flex-shrink:0',
        'background:var(--bg-panel,#181818)',
        'border-top:1px solid var(--border,rgba(255,255,255,0.08))',
        'border-bottom:1px solid var(--border,rgba(255,255,255,0.08))',
        'font:12px/1 monospace', 'color:rgba(255,255,255,0.55)',
        'user-select:none',
    ].join(';')

    const tag = document.createElement('span')
    tag.textContent = 'FLA'
    tag.style.cssText = 'font-size:10px;font-weight:bold;letter-spacing:.06em;color:rgba(255,255,255,0.3)'

    const playBtn = document.createElement('button')
    playBtn.textContent = '▶'
    playBtn.style.cssText = [
        'background:rgba(255,255,255,0.08)', 'border:1px solid rgba(255,255,255,0.15)',
        'color:#fff', 'font-size:11px', 'padding:2px 8px', 'border-radius:4px',
        'cursor:pointer', 'flex-shrink:0',
    ].join(';')
    playBtn.addEventListener('click', () => _flaTogglePlay(playBtn))

    const slider = document.createElement('input')
    slider.type  = 'range'
    slider.min   = '0'
    slider.max   = String(frameCount - 1)
    slider.value = '0'
    slider.style.cssText = 'flex:1;height:16px;cursor:pointer;accent-color:#c89fff'

    const counter = document.createElement('span')
    counter.className = 'fla-counter'
    counter.style.cssText = 'font-variant-numeric:tabular-nums;color:#fff;min-width:52px;text-align:right'
    counter.textContent = `0 / ${frameCount - 1}`

    slider.addEventListener('input', () => {
        _flaFrame = parseInt(slider.value)
        counter.textContent = `${_flaFrame} / ${frameCount - 1}`
        scrubToFrame(_flaFrame)
    })

    _scrubberEl.append(tag, playBtn, slider, counter)
    panelCenter.insertBefore(_scrubberEl, timelinePanel)
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

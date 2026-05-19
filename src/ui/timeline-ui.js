// Minimal timeline panel: play/pause, frame counter, scrubber.
// HTML-based first pass — replace with canvas dope sheet when needed.

import scene    from '../scene/scene.js'
import viewport from './viewport.js'

export function initTimelineUI() {
    const panel = document.getElementById('timeline-panel')

    panel.innerHTML = `
        <div class="tl-bar">
            <button class="tl-btn" id="tw-play">▶</button>
            <span class="tl-frame" id="tw-frame">0</span>
            <input class="tl-scrub" id="tw-scrub"
                   type="range" min="0" max="${scene.timeline.duration - 1}" value="0" step="1">
            <span class="tl-dur">/ ${scene.timeline.duration}</span>
        </div>
    `

    const btnPlay = document.getElementById('tw-play')
    const frameEl = document.getElementById('tw-frame')
    const scrubEl = document.getElementById('tw-scrub')

    // Play / pause button
    btnPlay.addEventListener('click', () => togglePlay())

    // Scrubbing — update frame and redraw immediately
    scrubEl.addEventListener('input', () => {
        scene.timeline.currentFrame = parseInt(scrubEl.value)
        frameEl.textContent = scrubEl.value
        viewport.markDirty()
    })

    // Keep the UI in sync when playback advances frames
    document.addEventListener('twist:frameChange', () => {
        const f = scene.timeline.currentFrame
        scrubEl.value       = f
        frameEl.textContent = f
        btnPlay.textContent = scene.timeline.playing ? '⏸' : '▶'
    })
}

export function togglePlay() {
    scene.timeline.playing = !scene.timeline.playing
    const btnPlay = document.getElementById('tw-play')
    if (btnPlay) btnPlay.textContent = scene.timeline.playing ? '⏸' : '▶'
    if (scene.timeline.playing) viewport.markDirty()
}

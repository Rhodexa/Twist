// All keyboard and pointer input lives here.
// Imports journal to dispatch undo/redo. Does not touch gl or DOM directly.

import journal from '../journal/journal.js'

// ── Keyboard shortcuts ────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey

    if (mod && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) journal.redo()
        else            journal.undo()
        return
    }

    if (mod && e.key === 'y') {
        e.preventDefault()
        journal.redo()
        return
    }

    if (mod && e.key === 's') {
        e.preventDefault()
        // Save is handled by app.js listening on journal events.
        // Dispatch a custom event so save logic stays out of input.js.
        document.dispatchEvent(new CustomEvent('twist:save'))
        return
    }
})

// ── Pointer events (canvas) ───────────────────────────────────────────────
// Set up in app.js once the viewport is ready, not at module load time.

function attachPointerEvents(canvas, handlers = {}) {
    canvas.addEventListener('pointerdown', e => {
        canvas.setPointerCapture(e.pointerId)
        handlers.down?.(normalise(e))
    })

    canvas.addEventListener('pointermove', e => {
        handlers.move?.(normalise(e))
    })

    canvas.addEventListener('pointerup', e => {
        canvas.releasePointerCapture(e.pointerId)
        handlers.up?.(normalise(e))
    })

    canvas.addEventListener('pointercancel', e => {
        canvas.releasePointerCapture(e.pointerId)
        handlers.cancel?.(normalise(e))
    })
}

function normalise(e) {
    return {
        x:         e.clientX,
        y:         e.clientY,
        pressure:  e.pressure,
        tiltX:     e.tiltX,
        tiltY:     e.tiltY,
        isPen:     e.pointerType === 'pen',
        isMouse:   e.pointerType === 'mouse',
        isTouch:   e.pointerType === 'touch',
        buttons:   e.buttons,
        raw:       e
    }
}

export { attachPointerEvents }

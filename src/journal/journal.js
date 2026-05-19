// THE SPINE. Every user action goes through here. No UI, no WebGL, no DOM.

const journal = {
    stack:  [],
    cursor: -1,

    push(command) {
        // discard any redo history ahead of cursor
        this.stack = this.stack.slice(0, this.cursor + 1)
        command.execute()
        this.stack.push(command)
        this.cursor++
        this._emit('change')
    },

    undo() {
        if (this.cursor < 0) return
        this.stack[this.cursor].undo()
        this.cursor--
        this._emit('change')
    },

    redo() {
        if (this.cursor >= this.stack.length - 1) return
        this.cursor++
        this.stack[this.cursor].execute()
        this._emit('change')
    },

    canUndo() { return this.cursor >= 0 },
    canRedo() { return this.cursor < this.stack.length - 1 },

    clear() {
        this.stack  = []
        this.cursor = -1
        this._emit('change')
    },

    // Minimal event bus so the UI can react to stack changes
    // without the Journal knowing anything about the UI.
    _listeners: {},

    on(event, fn) {
        (this._listeners[event] ??= []).push(fn)
    },

    off(event, fn) {
        this._listeners[event] = (this._listeners[event] ?? []).filter(f => f !== fn)
    },

    _emit(event) {
        for (const fn of (this._listeners[event] ?? [])) fn()
    }
}

export default journal

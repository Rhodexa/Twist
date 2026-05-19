# CLAUDE.md — Twist

> "Just a tool to make cartoons fast, for fun, without fighting software."

---

## What Is Twist

Twist is a personal vector puppet animation tool — a Digital Graphics Workstation (DGW) — built for 2.5D cartoon animation in the style of MLP: Friendship is Magic. Think Flash/Toon Boom Harmony's workflow, but with a node-based compositor instead of a flat layer stack, proper symbol nesting, and no Adobe or Toon Boom involved.

It is **not** trying to be Blender. It is not trying to be famous. It is a fast, personal, MIT-licensed tool for making cartoons without fighting software.

---

## License

**MIT. Everything. No exceptions.**

---

## Stack — Final, No Debates

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** | Real window, real filesystem, WebGL2 just works, no Wayland fights |
| UI | **Vanilla JS** | No framework friction, fast to build, nobody else uses this app |
| Rendering | **WebGL2** | GPU compositor, shader execution, FBO management |
| Input | **Pointer Events API** | Pen tablet pressure + tilt, built into Electron's Chromium |
| Export | **FFMPEG** | Called as child_process, never bundled |
| Language | **JavaScript** | For everything at this stage |

No React. No Vue. No Solid. No Qt. No ImGui. No Godot. No Synfig. No Inkscape. Vanilla JS + WebGL2 + Electron. That's it.

---

## Project Structure

```
twist/
├── CLAUDE.md               ← you are here
├── package.json
├── main.js                 ← Electron main process, window management only
├── preload.js              ← Electron preload, exposes safe Node APIs to renderer
├── index.html              ← app shell, panel layout
├── src/
│   ├── journal/
│   │   └── journal.js      ← THE SPINE. Built first. Everything goes through here.
│   ├── compositor/
│   │   └── compositor.js   ← WebGL2 node-based compositor
│   ├── scene/
│   │   └── scene.js        ← scene graph, symbol library, rig trees
│   ├── timeline/
│   │   └── timeline.js     ← playback, frame resolution, nested timelines
│   ├── ui/
│   │   ├── viewport.js     ← the WebGL canvas, pan/zoom/rotate
│   │   ├── nodeeditor.js   ← composition node graph UI
│   │   ├── timeline-ui.js  ← dope sheet UI
│   │   └── library-ui.js   ← symbol library panel
│   └── input/
│       └── input.js        ← pointer events, pen tablet, keyboard
├── shaders/
│   ├── composite.frag      ← region compositing shader
│   ├── picking.frag        ← GPU object picking
│   └── effects/            ← built-in effect shaders
└── assets/
    └── icons/
```

---

## The Journal — Build This First

The Journal is the spine of the entire application. Every single user action goes through it. Without the Journal there is no undo, no crash recovery, no reliable state. Do not build anything else before the Journal works.

### How It Works

Every action is a command object with two functions:

```js
// journal.js

const journal = {
    stack:   [],    // all executed commands
    cursor:  -1,    // current position in stack

    push(command) {
        // discard any commands ahead of cursor (redo history)
        this.stack = this.stack.slice(0, this.cursor + 1)
        
        // execute the command
        command.execute()
        
        // store it
        this.stack.push(command)
        this.cursor++
    },

    undo() {
        if (this.cursor < 0) return
        this.stack[this.cursor].undo()
        this.cursor--
    },

    redo() {
        if (this.cursor >= this.stack.length - 1) return
        this.cursor++
        this.stack[this.cursor].execute()
    }
}
```

### What A Command Looks Like

```js
// example: moving a symbol instance
journal.push({
    execute: () => {
        scene.setNodeTransform(nodeId, newTransform)
    },
    undo: () => {
        scene.setNodeTransform(nodeId, oldTransform)  // captured at push time
    }
})
```

The undo parameters are **captured at push time**, not at undo time. If you cannot write the undo function, you do not yet understand your own action. The Journal enforces correctness by design.

### Rules
- Every user action goes through the Journal. No exceptions.
- Never mutate scene state directly from UI code. Always via Journal.
- The Journal does not know about WebGL, the DOM, or anything else. Pure state logic only.
- Keep it ugly. Keep it honest.

---

## Symbols — The Core Data Model

Everything in Twist is a Symbol. The scene itself is the root Symbol.

```js
// A Symbol definition (lives in the library)
{
    id:       "wing_L",
    name:     "Wing Left",
    geometry: [],           // array of paths (bezier curves)
    timeline: {
        duration:  12,      // frames
        loop:      true,
        keyframes: []
    },
    children: []            // child symbol definitions (nested symbols)
}

// A Symbol Instance (lives in the scene/rig tree)
{
    id:         "wing_L_instance_0",
    symbolId:   "wing_L",          // references library symbol
    transform:  { x, y, rotation, scaleX, scaleY },
    timeOffset: 2,                 // start flapping 2 frames late for natural feel
    override:   null,              // or { frame, symbolId, hideChildren }
    children:   []                 // child instances
}
```

### Symbol Rules
- Symbols are **defined once** in the library, **instanced** anywhere in the scene
- Editing a symbol definition affects ALL instances everywhere
- Every symbol has its own timeline — loops, offsets, independent of parents
- The scene root is just a symbol with no parent
- Symbols can be nested arbitrarily deep

### Symbol Overrides (Important)
You can swap any symbol instance for a different symbol on any frame range:

```js
// Replace hand with fist for frames 42-45
{
    nodeId:       "hand_R_instance",
    frameStart:   42,
    frameEnd:     45,
    symbolId:     "fist_symbol",
    hideChildren: true    // suppress finger rig while override active
}
```

The original symbol and its children still exist and keep animating underneath. They just aren't rendered while the override is active. When the override ends, everything snaps back exactly where it would have been.

---

## The Compositor — Node-Based, Not Layer-Based

Twist does NOT use a flat layer stack. It uses a **node graph** where each node is a compositing operation.

### Key Nodes

**SplitNode** — the most important node. Takes a source texture and a mask, outputs two textures:
```
SplitNode
  inputs:  source_texture, mask
  outputs: inside  (masked region)
           outside (inverse masked region)
```
Wire `inside` above the torso, `outside` below. The arm crosses the torso correctly. No layer splitting. No duplicated assets.

**LayerNode** — ordered compositor. Takes N inputs, renders back-to-front. Simple painter's algorithm within its subgraph.

**BlendNode** — blend modes (multiply, screen, add, etc.)

**EffectNode** — runs a GLSL fragment shader. Built-in effects: blur, glow, color correction, drop shadow.

**SwitchNode** — swaps between symbol variants. Used for mouth shapes, eye states, etc.

**CustomCodeNode** — user-provided GLSL. Interface:
```glsl
uniform sampler2D uInput0;
uniform sampler2D uInput1;
uniform float     uTime;
uniform int       uFrame;

vec4 lumiEffect(vec2 uv) {
    // user writes this
    return texture(uInput0, uv);
}
```

### Compositor Performance Rules
- Every node caches its output in an FBO
- Nodes track a content hash of their inputs + parameters
- If hash unchanged since last frame: return cached FBO, skip render
- Only dirty nodes execute. A frame where only the mouth switched redraws ~3 nodes out of 200.
- FBOs are trimmed to content bounds — a small mouth cel gets a small texture, not a full 1920x1080 FBO
- Shaders compile once, cached by graph hash forever

---

## Regions — UI Dirty Flagging

The UI is divided into regions. Each region owns one FBO. Regions only redraw when dirty.

```js
const regions = {
    viewport:   { dirty: true,  fbo: null },
    timeline:   { dirty: false, fbo: null },
    nodeEditor: { dirty: false, fbo: null },
    library:    { dirty: false, fbo: null },
}

// only viewport redraws during playback
function onPlaybackTick() {
    regions.viewport.dirty = true
}

// only timeline + viewport redraw when keyframe edited
function onKeyframeEdited() {
    regions.timeline.dirty = true
    regions.viewport.dirty = true
}
```

Regions are composited to screen as textured quads each frame. Clean regions are a single blit — essentially free.

---

## Input

Use the **Pointer Events API** for all input. Not mouse events.

```js
canvas.addEventListener('pointermove', e => {
    const x        = e.clientX
    const y        = e.clientY
    const pressure = e.pressure       // 0.0 - 1.0, works for pen tablets
    const tiltX    = e.tiltX          // -90 to 90
    const tiltY    = e.tiltY
    const isPen    = e.pointerType === 'pen'
    const isMouse  = e.pointerType === 'mouse'
})
```

Input capture: once a drag starts, call `canvas.setPointerCapture(e.pointerId)`. All subsequent events route to the canvas regardless of where the cursor goes. Release on pointerup.

---

## Viewport

The viewport is a WebGL2 canvas. It has its own view transform independent of the UI:

```js
const viewTransform = {
    x:        0,      // pan
    y:        0,
    zoom:     1.0,
    rotation: 0.0    // viewport rotation for pen tablet use
}
```

Screen → world and world → screen are just matrix inversions of viewTransform. Always use these, never hardcode coordinate assumptions.

---

## GPU Object Picking

When the user clicks in the viewport, use GPU picking to identify what was clicked:

1. Render the scene into an offscreen FBO where each object is a flat color encoding its ID
2. Read the pixel at the click position with `gl.readPixels`
3. Decode the ID from the RGBA value
4. Look up the object in the scene graph

This is pixel-perfect — transparent areas never register as hits.

---

## Export

Call FFMPEG as a child process. Never bundle it.

```js
const { execFile } = require('child_process')

execFile('ffmpeg', [
    '-framerate', '24',
    '-i',         'frame_%04d.png',
    '-c:v',       'libx264',
    '-pix_fmt',   'yuv420p',
    'output.mp4'
], callback)
```

Export formats: PNG sequence, WebM, MP4 (via FFMPEG), APNG.

---

## What To Build First — In Order

1. **Journal** — test it with fake commands before touching anything else
2. **Electron window** — main.js, index.html, preload.js, nothing fancy
3. **WebGL2 context** — get a cleared canvas on screen
4. **One region** — the viewport, with dirty flag, redraws when marked dirty
5. **One symbol** — hardcoded, draw a shape in the viewport
6. **One keyframe** — move the shape, set two keyframes, play it back
7. **The rest** — only build what actually hurts

Do not skip step 1. Do not build UI before the Journal exists.

---

## What NOT To Do

- Do not add React, Vue, Solid, or any JS framework
- Do not use Canvas2D for the compositor (use WebGL2)
- Do not build a UI toolkit (use HTML/CSS for panels)
- Do not add C++ yet (bolt it on if and when something actually hurts)
- Do not rename it again (it's Twist, it was always Twist)
- Do not open Toon Boom Harmony "just to check something"

---

## Names

| Name | What |
|---|---|
| **Twist** | This app |
| **Trixie** | The DAW (separate project) |
| **Bonbon** | Probably the first test character |

All MIT. All MLP. All good. 🎬

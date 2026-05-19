# RENDERING.md — Twist Rendering & Compositor Architecture

> Second design session. Read CLAUDE.md first for project context.
> This document covers geometry, compositing, frame evaluation, and puppet organization decisions.

---

## Geometry — How Vector Gets To Pixels

### The Honest Answer: It's Still Triangles

GPUs are triangle machines. Everything becomes triangles eventually. The "smoothness" of vector graphics is not magic — it's a choice about **when** you triangulate.

Bézier curves are stored as mathematical descriptions (control points). To draw them, you tessellate into triangles at the current zoom level. The trick is **adaptive tessellation** — subdivide until the error between triangle edge and true curve is below one pixel on screen.

```
zoomed out: curve is 50px on screen  → 8 triangles, imperceptible error
zoomed in:  curve is 2000px on screen → 300 triangles, still imperceptible error
```

Result: always looks smooth. Zoom changes trigger retessellation. Between zoom changes, cached triangle meshes draw for free.

### Strokes — Per Vertex Width

Strokes are ribbon meshes, not lines. Each vertex pair defines left and right edges:

```
control points:  P0   P1   P2   P3
stroke widths:   w0   w1   w2   w3

tessellated:
    L0---L1---L2---L3
    |  X |  X |  X |
    R0---R1---R2---R3
```

L and R are offset from centerline by `width/2` along the normal. This gives tapered lines natively. Width is animatable per control point — keyframe it like position.

### Fills

Use **earcut** (MIT, tiny) for fill triangulation. Fill mesh draws before stroke mesh (painter's order: fill first, stroke on top).

### Viewport vs Render Quality

Same geometry data, different tessellation threshold:

```
Viewport:  pixelThreshold = 1.0px  → fast, looks fine at work size
Render:    pixelThreshold = 0.1px  → slow, perfect for export
```

Retessellate at render resolution before export pass. User never notices the difference in viewport.

### When To Retessellate

- Geometry edited by user
- Zoom crosses a threshold (doubled or halved)
- Render pass begins

Never retessellate every frame. Cache VBOs aggressively.

### Instanced Rendering

Puppet animation reuses symbols constantly. Same symbol, many instances with different transforms:

```
gl.drawArraysInstanced(...)
```

One draw call renders 20 background ponies. GPU handles the transform variation. A crowd scene is not 20x the cost — closer to 1.2x.

### SVG Import

Browser parses SVG natively. Extract path `d` attributes, convert SVG path commands (M, L, C, Z) to internal Bézier format. No library needed.

```js
const svg = new DOMParser().parseFromString(svgText, 'image/svg+xml')
const paths = svg.querySelectorAll('path')
// extract d attributes → convert to Bezier control points
```

This enables: draw in Inkscape → export SVG → import into Twist → rig → animate.

### Raster Support

Rasters slot into the compositor as RasterNode. Backgrounds, prebaked effects, imported video — all just textures by the time compositing happens.

```js
// HTML video element decodes frames, upload as texture each frame
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement)
```

Vector and raster are unified at the compositor level. The node graph doesn't care how a texture was produced.

---

## Frame Evaluation — What A Frame Actually Is

### Frames Are Computed, Not Stored

A frame is never stored explicitly. It is derived from the timeline at render time:

```
frame 42 = evaluate every track at t=42
```

You store "these things change at these times." You derive what frame 42 looks like on demand.

### The Evaluation Walk

```js
function evaluateFrame(scene, frame) {
    return resolveNode(scene.root, frame)
}

function resolveNode(node, frame) {
    return {
        symbolId:  node.symbolId,
        transform: resolveTransform(node, frame),   // where is it
        variant:   resolveVariant(node, frame),     // which drawing
        animation: resolveAnimation(node, frame),   // which clip is playing
        visible:   resolveVisibility(node, frame),  // is it on
        children:  node.children.map(c => resolveNode(c, frame))
    }
}
```

Result is a plain tree of resolved states. No timeline logic remains. Just "draw this, here, looking like this."

### Clean Separation

```
Timeline tracks  → WHAT state everything is in at frame N
Node graph       → HOW those things composite together
```

Frame evaluation is pure data. Compositing is pure rendering. They never mix.

---

## Puppet Organization — Folders, Not Hierarchies

### A Puppet Is A Folder

```
Sweetie_Drops/
├── Side/
│   ├── Body
│   ├── Head
│   ├── Legs
│   └── Wings
├── Front/
│   ├── Body
│   ├── Head
│   └── ...
├── Above/
│   └── ...
└── Custom/
    └── frame_42_arm_reach    ← one-off drawing for a specific moment
```

No enforced nesting philosophy. The folder is organization. The timeline references by path.

### The Frankenstein Frame Is A Feature

MLP used different puppets per angle, combined per shot. A frame might be:

```
Sweetie_Drops/Side/Body    ← side view body
Sweetie_Drops/Front/Head   ← front view head (she's turning)
Sweetie_Drops/Side/Mouth   ← side mouth
Custom/frame_42_arm_reach  ← one-off hand drawing
```

The timeline references anything from any folder freely. Folder structure is findable organization, not a constraint.

### Copy On Import

Importing a puppet creates a **copy** in the current project. Not a link.

- Copy: this shot owns its assets. Predictable, safe, no surprise changes.
- Link (future): copy that knows its origin, can optionally pull updates. Like a git fork. Not now.

---

## Symbol Structure

### A Symbol Contains

```js
{
    id: "wings",
    geometry: { ... },          // the drawings

    variants: {                 // WHAT IT LOOKS LIKE
        "open":   { ... },
        "half":   { ... },
        "closed": { ... }
    },

    animations: {               // HOW IT MOVES (named reusable clips)
        "flap_cycle": {
            duration: 12,
            loop: true,
            tracks: [ ... ]
        },
        "fold_in": {
            duration: 8,
            loop: false,
            tracks: [ ... ]
        }
    }
}
```

Variants = visual states. Animations = named movement clips. Separate concerns.

### Symbol Instances In The Scene

```js
{
    id:         "wings_L_inst",
    symbolId:   "Sweetie_Drops/Side/Wings",
    transform:  { x, y, rotation, scaleX, scaleY },
    timeOffset: 2,              // start 2 frames late for natural asymmetry
    override:   null,           // or a frame-range symbol swap
    children:   []
}
```

### Symbol Overrides

Swap any symbol instance for any other symbol on any frame range:

```js
{
    nodeId:       "hand_R_inst",
    frameStart:   42,
    frameEnd:     45,
    symbolId:     "Custom/frame_42_arm_reach",
    hideChildren: true    // suppress child rig while override active
}
```

Original symbol and children keep animating underneath. Invisible while override active. Snap back exactly when it ends. Fully undoable via Journal.

---

## The Two Editors

### Symbol Editor
- You are inside a symbol
- Edit geometry, define variants, author named animation clips
- Full context of just that symbol
- Like Flash's "enter symbol" but intentional

### Scene / NLA Editor
- Top level view
- Reference symbols, place animation clips on timeline
- See all tracks simultaneously

```
Scene NLA timeline:
    wings_L  [--flap_cycle--][--flap_cycle--][fold_in-]
    wings_R  [--flap_cycle--][--flap_cycle--][fold_in-]
    head     [--------idle_look_left---------][snap_fwd]
```

Each bar is a **clip reference** — a pointer to a named animation with a start frame and playback speed. Not a copy.

### NLA Clip Operations
- **Stack** — blend two clips simultaneously
- **Scale** — stretch a 12-frame clip to run slower without re-authoring
- **Offset** — start right wing 2 frames after left
- **Loop** — repeat flap_cycle for any duration
- **Transition** — crossfade between clips

---

## Compositor Node Graph

### Core Nodes

**SplitNode** — the most important node.
```
inputs:  source_texture, mask
outputs: inside  (masked region)
         outside (inverse masked region)
```
Wire inside above the torso, outside below. Arm crosses torso correctly. No layer splitting. No duplicated assets. Mask is reusable — wire same mask to shadows, rim lights, glow, anything.

**LayerNode** — ordered compositor. N inputs, back-to-front. Painter's algorithm within subgraph.

**BlendNode** — blend modes (multiply, screen, add, overlay, etc.)

**SwitchNode** — swaps symbol variants. Mouth shapes, eye states, angle swaps.

**EffectNode** — built-in GLSL effects: blur, glow, color correction, drop shadow.

**RasterNode** — images, video, PNG sequences. Feeds into compositor like any other texture.

**CustomCodeNode** — user GLSL. Interface:
```glsl
uniform sampler2D uInput0;
uniform sampler2D uInput1;
uniform float     uTime;
uniform int       uFrame;

vec4 twistEffect(vec2 uv) {
    // user writes this
    return texture(uInput0, uv);
}
```

**FlashLayerNode** — flat layer stack compositor. Painter's algorithm, per-layer blend modes. Used for importing Flash/Animate puppets without converting their layering logic to a proper node graph.

### Compositor Performance

Every node caches output in a trimmed FBO (trimmed to content bounds — a small mouth cel gets a small texture, not a full canvas FBO).

Nodes track a **content hash** of inputs + parameters:

```js
// hash unchanged = return cached FBO, skip render entirely
if (hash === node.contentHash && node.fbo) {
    return node.fbo   // free
}
```

A frame where only the mouth variant switched redraws ~3 nodes out of 200. Everything else returns cached FBOs.

Shaders compile once, cached by graph hash forever. Mid-timeline material switches use already-compiled shaders after first scrub-through.

### Composition Materials

A named, saveable node tree configuration:

```js
{
    id:     "magic_halo",
    name:   "Magic Halo Effect",
    root:   { /* node graph */ },
    shader: compiledAndCached
}
```

Keyframe material switches on the timeline. Switch at frame 48, compositor fetches already-compiled shader. No recompilation mid-playback.

---

## GPU Object Picking

Click in viewport → need to know what was clicked.

1. Render scene into offscreen FBO, each object as flat color encoding its ID
2. `gl.readPixels` at click position
3. Decode RGBA → object ID
4. Look up in scene graph

```glsl
// picking.frag
uniform uint uObjectID;
out vec4 fragColor;
void main() {
    fragColor = vec4(
        float((uObjectID >>  0) & 0xFF) / 255.0,
        float((uObjectID >>  8) & 0xFF) / 255.0,
        float((uObjectID >> 16) & 0xFF) / 255.0,
        1.0
    );
}
```

Pixel-perfect. Transparent areas never register as hits. One extra render pass only on click, not every frame.

---

## Export Pipeline

```
render frame to FBO
    ↓
gl.readPixels → Uint8Array (CPU)
    ↓
write to FFMPEG stdin
    ↓
FFMPEG encodes video
```

FFMPEG called as child_process, never bundled. ~8MB per 1080p frame, ~190MB/s to FFMPEG at 24fps. Fine.

Export formats: PNG sequence, WebM, MP4, APNG.

---

## Animatic / Frame-By-Frame

Animatics live outside Twist. Draw rough elsewhere (Krita, tablet app, napkin), export PNG sequence, import as RasterNode. Professional workflow anyway.

Frame-by-frame hand-drawn effects (sparkles, one-off custom limbs) are a **FrameByFrameSymbol**:

```js
{
    type: "framebyfame",
    frames: {
        0: textureA,
        1: textureB,
        2: textureC
    }
}
```

Cycles through textures on timeline. In compositor it's just a RasterNode that knows which texture to show. Draw frames externally, import them. Simple paint tool inside Twist is a future maybe, not now.

---

## Flash / Animate Importer (Future)

FLA files are ZIP archives containing XML. XFL is already-extracted XML folders. Both are parseable without Adobe tools.

```
MyPonyRig.xfl/
├── DOMDocument.xml     ← scene structure
├── LIBRARY/
│   ├── Body.xml        ← symbol definitions
│   ├── Head.xml
│   └── ...
└── bin/                ← embedded bitmaps
```

Conversion target: FLA/XFL symbol → Twist symbol (copy, not link). Flash curve format → Bézier control points. Flash layer stack → FlashLayerNode (renders identically, convert to proper node graph later if desired).

Spine format (JSON) is even easier if assets happen to be in that format.

---

## What Does Not Belong In This Document

- Journal architecture → see CLAUDE.md
- Window / panel layout → see CLAUDE.md  
- Input handling → see CLAUDE.md
- Build setup → see CLAUDE.md

// Twist document serialization — TwistDocument ↔ JSON.
//
// Serialized format stores:
//   camera, timeline, instances, and symbol bezier-path geometry (_groups).
//
// NOT serialized (reconstructed at load time):
//   renderGroups  — tessellated on first display
//   edgeContours  — re-derived from _groups
//
// This keeps the file format geometry-resolution-independent: you can load
// a .twist file and tessellate at whatever quality you need.

import { extractEdgeContours } from '../fla/tessellate.js'

const FORMAT_VERSION = '0.1'

// ── Serialize ─────────────────────────────────────────────────────────────

function serializeSymbol(sym) {
    return {
        id:     sym.id,
        name:   sym.name,
        label:  sym.label,
        groups: sym._groups,   // bezier paths — plain JSON, no Float32Arrays
    }
}

function serializeInstance(inst) {
    return {
        id:        inst.id,
        symbolId:  inst.symbolId,
        label:     inst.label,
        parentId:  inst.parentId,
        order:     inst.order,
        rawMatrix: inst.rawMatrix,
        maskId:    inst.maskId,
        transform: { ...inst.transform },
        tracks:    {
            x:        inst.tracks.x.map(kf => ({ ...kf })),
            y:        inst.tracks.y.map(kf => ({ ...kf })),
            rotation: inst.tracks.rotation.map(kf => ({ ...kf })),
            scaleX:   inst.tracks.scaleX.map(kf => ({ ...kf })),
            scaleY:   inst.tracks.scaleY.map(kf => ({ ...kf })),
        },
    }
}

/**
 * Serialize the live scene to a plain JSON-safe object.
 * Pass the result to JSON.stringify to write a .twist file.
 * @param {import('./scene.js').default} scene
 * @returns {import('./types.js').TwistDocument}
 */
function toJSON(scene) {
    return {
        version:   FORMAT_VERSION,
        camera:    { ...scene.camera, output: { ...scene.camera.output } },
        timeline:  {
            duration: scene.timeline.duration,
            fps:      scene.timeline.fps,
        },
        symbols:   scene.symbols.map(serializeSymbol),
        instances: scene.instances.map(serializeInstance),
    }
}

// ── Deserialize ───────────────────────────────────────────────────────────

function deserializeSymbol(data) {
    const groups = data.groups ?? []

    // Re-derive edgeContours from the stored bezier paths.
    const allRegions = groups.flatMap(g =>
        g.type === 'plain'
            ? g.regions
            : [...(g.maskRegions ?? []), ...(g.contentRegions ?? [])]
    )

    return {
        id:           data.id,
        name:         data.name,
        label:        data.label,
        _groups:      groups,
        edgeContours: extractEdgeContours(allRegions),
        renderGroups: null,   // tessellated on first display
    }
}

function deserializeInstance(data) {
    return {
        id:        data.id,
        symbolId:  data.symbolId,
        label:     data.label ?? '',
        parentId:  data.parentId ?? null,
        order:     data.order ?? 0,
        rawMatrix: data.rawMatrix ?? null,
        maskId:    data.maskId ?? null,
        transform: {
            x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
            ...data.transform,
        },
        tracks: {
            x:        data.tracks?.x        ?? [],
            y:        data.tracks?.y        ?? [],
            rotation: data.tracks?.rotation ?? [],
            scaleX:   data.tracks?.scaleX   ?? [],
            scaleY:   data.tracks?.scaleY   ?? [],
        },
    }
}

/**
 * Restore a scene from a deserialized .twist JSON object.
 * Populates scene.symbols, scene.instances, scene.camera, and scene.timeline.
 * Does NOT tessellate — that happens on first display.
 * @param {object} data — parsed JSON (from JSON.parse)
 * @param {import('./scene.js').default} scene
 */
function fromJSON(data, scene) {
    if (!data?.version) throw new Error('[twist] missing version field')

    const cam = data.camera ?? {}
    scene.camera.x      = cam.x      ?? scene.camera.x
    scene.camera.y      = cam.y      ?? scene.camera.y
    scene.camera.width  = cam.width  ?? scene.camera.width
    scene.camera.height = cam.height ?? scene.camera.height
    if (cam.output) {
        scene.camera.output.w = cam.output.w ?? scene.camera.output.w
        scene.camera.output.h = cam.output.h ?? scene.camera.output.h
    }

    const tl = data.timeline ?? {}
    scene.timeline.duration     = tl.duration ?? scene.timeline.duration
    scene.timeline.fps          = tl.fps      ?? scene.timeline.fps
    scene.timeline.currentFrame = 0
    scene.timeline.playing      = false

    scene.symbols.length   = 0
    scene.instances.length = 0
    for (const s of data.symbols   ?? []) scene.symbols.push(deserializeSymbol(s))
    for (const i of data.instances ?? []) scene.instances.push(deserializeInstance(i))
}

export { toJSON, fromJSON }

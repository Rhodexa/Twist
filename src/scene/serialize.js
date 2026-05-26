// Twist document serialization — scene ↔ TwistProject JSON.
//
// toProject(scene)   — serialize current runtime scene to project format
// fromProject(data)  — thin alias: calls loader.loadProject (kept here for
//                      import symmetry — the heavy lifting is in loader.js)
//
// Serialized format stores:
//   camera, timeline, symbols (bezier-path geometry only), stage instances.
//
// NOT serialized (reconstructed at load):
//   renderGroups  — tessellated on first display
//   edgeContours  — re-derived from _groups

import { loadProject } from './loader.js'

const FORMAT_VERSION = '0.1'

// ── Symbol decompose helpers ───────────────────────────────────────────────

// Runtime sym._groups is a flat BezierGroup[] for the active frame.
// When saving, we wrap it in a single-keyframe timeline so the project
// format is forward-compatible with multi-frame symbols.
function _wrapGroupsAsTimeline(groups) {
    return {
        duration: 1,
        layers: [
            {
                name:             'shape',
                type:             'normal',
                parentLayerIndex: null,
                keyframes: [
                    {
                        index:    0,
                        duration: 1,
                        groups:   groups,
                        elements: [],
                    }
                ],
            }
        ],
    }
}

// ── Instance decompose helpers ─────────────────────────────────────────────

// Derive affine matrix from runtime transform (lossy only for skew, but
// runtime already carries rawMatrix if skew was present on import).
function _instanceToMatrix(inst) {
    if (inst.rawMatrix) return [...inst.rawMatrix]
    const { x, y, rotation, scaleX, scaleY } = inst.transform
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)
    return [scaleX * cos, scaleX * sin, -scaleY * sin, scaleY * cos, x, y]
}

// ── Serialize ─────────────────────────────────────────────────────────────

function _serializeSymbol(sym) {
    return {
        id:       sym.id,
        name:     sym.name,
        label:    sym.label,
        timeline: _wrapGroupsAsTimeline(sym._groups ?? []),
    }
}

function _serializeInstance(inst) {
    return {
        id:          inst.id,
        symbolRef:   inst.symbolId,
        label:       inst.label,
        parentId:    inst.parentId  ?? null,
        order:       inst.order     ?? 0,
        maskId:      inst.maskId    ?? null,
        frameIn:     inst.frameIn   ?? 0,
        frameOut:    inst.frameOut  === Infinity ? null : (inst.frameOut ?? null),
        loop:        inst.loop      ?? 'loop',
        firstFrame:  inst.firstFrame ?? 0,
        matrix:      _instanceToMatrix(inst),
        tracks: {
            x:        (inst.tracks?.x        ?? []).map(kf => ({ ...kf })),
            y:        (inst.tracks?.y        ?? []).map(kf => ({ ...kf })),
            rotation: (inst.tracks?.rotation ?? []).map(kf => ({ ...kf })),
            scaleX:   (inst.tracks?.scaleX   ?? []).map(kf => ({ ...kf })),
            scaleY:   (inst.tracks?.scaleY   ?? []).map(kf => ({ ...kf })),
        },
        matrixTrack: (inst._matrixTrack ?? []).map(kf => ({ ...kf, mat: [...kf.mat] })),
    }
}

/**
 * Serialize the live scene to a TwistProject object.
 * Pass to JSON.stringify (or main.js saveProject IPC) to write a .twist folder.
 *
 * Note: for FLA-imported scenes this saves a snapshot — symbol geometry is
 * the current frame's _groups only, and _matrixTrack is preserved for reload.
 * Full multi-frame symbol fidelity requires the FLA importer refactor.
 *
 * @param {import('./scene.js').default} scene
 * @returns {import('./types.js').TwistProject}
 */
function toProject(scene) {
    // Only serialize root-level instances (no parentId) as stage instances.
    // Children are encoded inside their parent symbol's elements — but since
    // the current runtime model holds children as flat scene.instances, we
    // serialise ALL instances here and let the loader rebuild parentId links.
    return {
        version:  FORMAT_VERSION,
        name:     document.title.replace(/^Twist — /, '').replace(/ •$/, '') || 'untitled',
        camera: {
            x:      scene.camera.x,
            y:      scene.camera.y,
            width:  scene.camera.width,
            height: scene.camera.height,
            output: { ...scene.camera.output },
        },
        timeline: {
            duration: scene.timeline.duration,
            fps:      scene.timeline.fps,
        },
        symbols: scene.symbols.map(_serializeSymbol),
        stage:   { instances: scene.instances.map(_serializeInstance) },
    }
}

/**
 * Load a TwistProject into the scene.
 * Delegates to loader.js — kept here for import symmetry.
 * @param {object} data — parsed TwistProject JSON
 */
function fromProject(data) {
    loadProject(data)
}

// ── Legacy flat serializer (kept for reference) ───────────────────────────
// The old toJSON/fromJSON used a flat runtime snapshot. Replaced by
// toProject/fromProject. Remove once fully migrated.

export { toProject, fromProject }

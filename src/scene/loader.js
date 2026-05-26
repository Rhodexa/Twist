// Twist project loader — TwistProject → runtime scene.
//
// Translates the on-disk project format into the flat symbol + instance
// arrays the renderer uses. This is the clean boundary between authoring
// data and runtime data. The FLA importer will eventually call this too.
//
// Single entry point: loadProject(projectData)
// projectData is the assembled JSON object (main.js reads project.json +
// all library/*.json files and merges them before sending to the renderer).

import scene    from './scene.js'
import viewport from '../ui/viewport.js'
import { tessellateGroups, extractEdgeContours, QUALITY_VIEWPORT } from '../fla/tessellate.js'

// ── Matrix helpers ────────────────────────────────────────────────────────

// Decompose affine matrix to TRS for UI display. Lossless storage is in
// rawMatrix; this is just the display/authoring representation.
function _matToTransform([a, b, c, d, tx, ty]) {
    const det = a * d - b * c
    return {
        x:        tx,
        y:        ty,
        rotation: Math.atan2(b, a),
        scaleX:   Math.sqrt(a * a + b * b),
        scaleY:   (det < 0 ? -1 : 1) * Math.sqrt(c * c + d * d),
    }
}

// ── Symbol geometry extraction ────────────────────────────────────────────

// Find the keyframe span covering `frame` on a given layer.
function _activeKeyframe(keyframes, frame) {
    let best = null
    for (const kf of keyframes) {
        if (kf.index <= frame) {
            if (frame < kf.index + kf.duration) return kf
            best = kf
        }
    }
    return best
}

// Collect BezierGroups visible at `frame` from a project symbol.
// Combines groups from all non-guide layers in back-to-front order.
function _extractGroupsAtFrame(symData, frame) {
    const groups = []
    for (const layer of (symData.timeline?.layers ?? [])) {
        if (layer.type === 'guide' || layer.type === 'folder') continue
        const kf = _activeKeyframe(layer.keyframes ?? [], frame)
        if (!kf) continue
        for (const g of (kf.groups ?? [])) groups.push(g)
    }
    return groups
}

// Collect element placements visible at `frame` from a project symbol.
function _extractElementsAtFrame(symData, frame) {
    const elements = []
    for (const layer of (symData.timeline?.layers ?? [])) {
        if (layer.type === 'guide' || layer.type === 'folder') continue
        const kf = _activeKeyframe(layer.keyframes ?? [], frame)
        if (!kf) continue
        for (const el of (kf.elements ?? [])) elements.push(el)
    }
    return elements
}

// ── Recursive instance builder ────────────────────────────────────────────

// Builds runtime TwistInstance objects from TwistSceneInstance or TwistElement
// data. Recurses into symbol elements to produce the full flat list.
//
// stageInsts  — array of TwistSceneInstance (from project.stage.instances)
// symbolMap   — Map<symbolId, TwistProjectSymbol>
// out         — accumulator (runtime instances)
// forcedParentId — when building from elements, override parentId

function _buildInstances(stageInsts, symbolMap, out, forcedParentId = null) {
    for (const data of stageInsts) {
        const mat = data.matrix ?? [1, 0, 0, 1, 0, 0]

        const inst = {
            id:           data.id,
            symbolId:     data.symbolRef ?? data.symbolId,
            label:        data.label ?? '',
            parentId:     forcedParentId ?? data.parentId ?? null,
            order:        data.order     ?? 0,
            maskId:       data.maskId    ?? null,
            rawMatrix:    [...mat],
            frameIn:      data.frameIn   ?? 0,
            frameOut:     data.frameOut  ?? Infinity,
            loop:         data.loop      ?? 'loop',
            firstFrame:   data.firstFrame ?? 0,
            transform:    _matToTransform(mat),
            tracks: {
                x:        data.tracks?.x        ?? [],
                y:        data.tracks?.y        ?? [],
                rotation: data.tracks?.rotation ?? [],
                scaleX:   data.tracks?.scaleX   ?? [],
                scaleY:   data.tracks?.scaleY   ?? [],
            },
            _matrixTrack: data.matrixTrack ?? [],
        }
        out.push(inst)

        // Recurse into child elements defined in the symbol's timeline.
        const symData = symbolMap.get(inst.symbolId)
        if (symData) {
            const elements = _extractElementsAtFrame(symData, 0)
            const childInsts = elements.map((el, i) => ({
                id:        el.id ?? `${inst.id}_el${i}`,
                symbolRef: el.symbolRef,
                label:     el.label   ?? '',
                order:     el.order   ?? (i + 1),
                maskId:    el.maskId  ?? null,
                frameIn:   0,
                frameOut:  Infinity,
                loop:      el.loop       ?? 'loop',
                firstFrame: el.firstFrame ?? 0,
                matrix:    el.matrix ?? [1, 0, 0, 1, 0, 0],
                tracks:    { x: [], y: [], rotation: [], scaleX: [], scaleY: [] },
                matrixTrack: [],
            }))
            _buildInstances(childInsts, symbolMap, out, inst.id)
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Load a TwistProject into the live scene.
 * projectData is the assembled object returned by main.js's twist:openProject.
 * @param {import('./types.js').TwistProject} projectData
 */
export function loadProject(projectData) {
    if (!projectData?.version) throw new Error('[loader] missing version field')

    // ── Camera ────────────────────────────────────────────────────────────
    const cam = projectData.camera ?? {}
    scene.camera.x      = cam.x      ?? 0
    scene.camera.y      = cam.y      ?? 0
    scene.camera.width  = cam.width  ?? 1920
    scene.camera.height = cam.height ?? 1080
    if (cam.output) {
        scene.camera.output.w = cam.output.w ?? 1920
        scene.camera.output.h = cam.output.h ?? 1080
    }

    // ── Timeline ──────────────────────────────────────────────────────────
    const tl = projectData.timeline ?? {}
    scene.timeline.duration     = tl.duration ?? 120
    scene.timeline.fps          = tl.fps      ?? 24
    scene.timeline.currentFrame = 0
    scene.timeline.playing      = false

    // ── Symbol map ────────────────────────────────────────────────────────
    const symbolMap = new Map()
    for (const sym of (projectData.symbols ?? [])) symbolMap.set(sym.id, sym)

    // ── Clear GPU state ───────────────────────────────────────────────────
    viewport.clearSymbolVaos()
    scene.symbols.length   = 0
    scene.instances.length = 0

    // ── Build runtime symbols ─────────────────────────────────────────────
    for (const symData of symbolMap.values()) {
        const groups = _extractGroupsAtFrame(symData, 0)
        const allRegions = groups.flatMap(g =>
            g.type === 'plain'
                ? (g.regions ?? [])
                : [...(g.maskRegions ?? []), ...(g.contentRegions ?? [])]
        )
        scene.symbols.push({
            id:           symData.id,
            name:         symData.name,
            label:        symData.label,
            _groups:      groups,
            edgeContours: extractEdgeContours(allRegions),
            renderGroups: tessellateGroups(groups, QUALITY_VIEWPORT),
        })
    }

    // ── Build runtime instances ───────────────────────────────────────────
    _buildInstances(
        projectData.stage?.instances ?? [],
        symbolMap,
        scene.instances
    )

    // ── Upload VAOs ───────────────────────────────────────────────────────
    for (const sym of scene.symbols) viewport.buildSymbolVaos(sym.id)

    viewport.fitCamera()
    viewport.markDirty()
    document.dispatchEvent(new CustomEvent('twist:sceneChanged'))
}

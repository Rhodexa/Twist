// FLA import pipeline — tracks-based, hierarchical mode.
//
// Import converts the full FLA hierarchy into a flat instance list where each
// unique hierarchy position is ONE instance, not one-per-frame. Animation data
// lives in _matrixTrack: sparse raw-matrix keyframes in PARENT-LOCAL frame space.
//
// inst.rawMatrix is updated each scrub — no decompose/recompose, no lossy math.
// inst.tracks stays empty so the renderer reads rawMatrix directly. When the
// authoring pipeline adds user keyframes they populate inst.tracks instead.
//
// Memory profile:
//   XML DOM              → released after import (GC)
//   Symbol bezier paths  → compact, permanent (re-tessellate on demand)
//   Instance list        → one entry per unique position in hierarchy
//   _matrixTrack         → sparse: only keyframes at actual matrix changes
//
// Scrub cost: O(instances) tree traversal + matrix keyframe lookup — no XML.

import { buildSymbolMap, parseHierarchy, collectDirectRegions } from './parser.js'
import { tessellateGroups, extractEdgeContours }                            from './tessellate.js'
import scene    from '../scene/scene.js'
import viewport from '../ui/viewport.js'

const XFL_NS = 'http://ns.adobe.com/xfl/2008/'

// ── Module state ──────────────────────────────────────────────────────────

let _importCounter = 0
let _instances     = []          // flat list — one entry per unique hierarchy position

// Persist across scrubs. Cleared on new import.
const _symbolIds      = new Map()   // "name@@fn" → stable uid
const _symbolObjs     = new Map()   // uid → { id, name, label, _groups, edgeContours, renderGroups }
const _symFrameCounts = new Map()   // symbolName → frameCount (for childFrame resolution)

// ── Stable identity ───────────────────────────────────────────────────────

function _stableId(key) {
    if (!_symbolIds.has(key)) _symbolIds.set(key, `fla_${++_importCounter}`)
    return _symbolIds.get(key)
}

// ── Symbol registration (bezier paths, lazy tessellation) ─────────────────

function _registerSymbol(uid, name, groups) {
    if (_symbolObjs.has(uid)) return
    for (const g of groups) {
        if (g.type === 'masked' && !g.maskId) g.maskId = `mask_fla_${++_importCounter}`
    }
    const allRegions = groups.flatMap(g =>
        g.type === 'plain'
            ? g.regions
            : [...(g.maskRegions ?? []), ...(g.contentRegions ?? [])]
    )
    _symbolObjs.set(uid, {
        id:           uid,
        name,
        label:        name.split('/').pop().replace(/^~/, ''),
        _groups:      groups,
        edgeContours: extractEdgeContours(allRegions),
        renderGroups: null,
    })
}

function _ensureGpu(uid) {
    const sym = _symbolObjs.get(uid)
    if (!sym || sym.renderGroups) return sym
    const tessGroups = tessellateGroups(sym._groups)
    for (const g of tessGroups) {
        if (g.type !== 'masked') continue
        const src = sym._groups.find(sg => sg.type === 'masked' && sg.maskLayerIdx === g.maskLayerIdx)
        if (src) g.maskId = src.maskId
    }
    sym.renderGroups = tessGroups
    return sym
}

// ── Matrix keyframe helpers ───────────────────────────────────────────────

const _MAT_EPS = 0.001

function _matsEqual(a, b) {
    for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > _MAT_EPS) return false
    return true
}

// Add a matrix keyframe only when the matrix diverges from linear extrapolation
// of the existing track. Compresses linear motion tweens to exactly 2 keyframes.
function _addMatrixKf(track, frame, mat) {
    if (!track.length) { track.push({ frame, mat: [...mat] }); return }

    const last = track[track.length - 1]
    if (_matsEqual(last.mat, mat)) return  // no change

    if (track.length >= 2) {
        const prev = track[track.length - 2]
        const df1  = last.frame - prev.frame
        const df2  = frame      - prev.frame
        if (df1 > 0 && df2 > 0) {
            // Check if all 6 components are collinear with last two keyframes.
            let collinear = true
            for (let i = 0; i < 6; i++) {
                const predicted = prev.mat[i] + (last.mat[i] - prev.mat[i]) * (df2 / df1)
                if (Math.abs(predicted - mat[i]) > _MAT_EPS) { collinear = false; break }
            }
            if (collinear) {
                last.frame = frame          // extend: this point is on the same line
                last.mat   = [...mat]
                return
            }
        }
    }
    track.push({ frame, mat: [...mat] })
}

// Evaluate a matrix track at a given frame (linear interpolation between keyframes).
function _evalMatrixTrack(track, frame) {
    if (!track.length) return null
    if (track.length === 1) return track[0].mat

    let before = null, after = null
    for (const kf of track) {
        if (kf.frame <= frame) before = kf
        else if (!after) after = kf
    }
    if (!before) return track[0].mat
    if (!after)  return before.mat

    const t   = (frame - before.frame) / (after.frame - before.frame)
    const out = new Array(6)
    for (let i = 0; i < 6; i++) out[i] = before.mat[i] + (after.mat[i] - before.mat[i]) * t
    return out
}

// ── Child-frame resolution ────────────────────────────────────────────────

function _resolveChildFrame(inst, parentFrame) {
    if (inst.loop === 'single frame') return inst.firstFrame
    const elapsed = parentFrame - inst.frameStart
    const raw     = inst.firstFrame + elapsed
    const total   = _symFrameCounts.get(inst._symbolName) ?? 1
    if (inst.loop === 'loop') return ((raw % total) + total) % total
    return Math.min(raw, total - 1)   // 'play once' — clamp
}

// ── Timeline builder (one-time at import) ─────────────────────────────────
//
// Calls parseHierarchy for every scene frame and reconciles the resulting
// instance trees by stable path. Each unique hierarchy position produces
// exactly one instance; animation data accumulates into _matrixTrack.
//
// Future optimisation: read keyframe spans directly from XML (O(keyframes)).

function _buildTimeline(symbolMap, rootName, frameCount) {
    _instances = []

    // Pre-compute frame counts from XML while symbolMap is still available.
    for (const name of symbolMap.keys()) {
        _symFrameCounts.set(name, _getDocFrameCount(symbolMap.get(name)))
    }

    const instByPath    = new Map()   // path → inst
    const seenParentFrs = new Map()   // instId → Set<parentLocalFrame>

    for (let f = 0; f < frameCount; f++) {
        const { symbolGeometry, rootNode } = parseHierarchy(rootName, symbolMap, f)

        // Register symbols.
        const symIdMap = new Map()
        for (const [key, groups] of symbolGeometry) {
            const uid = _stableId(key)
            symIdMap.set(key, uid)
            const [name] = key.split('@@')
            _registerSymbol(uid, name, groups)
        }

        // Walk the instance tree and reconcile.
        // parentLocalFrame: frame number in the PARENT symbol's local timeline.
        function walk(node, parentInstId, parentPath, parentLocalFrame) {
            const elemKey = `${node.symbolName}@${node.order}:${node.elemIdx ?? 0}`
            const path    = `${parentPath}/${elemKey}`

            let inst = instByPath.get(path)
            if (!inst) {
                inst = {
                    id:           `inst_fla_${++_importCounter}`,
                    _symbolName:  node.symbolName,
                    symbolId:     symIdMap.get(`${node.symbolName}@@${node.frameNum ?? 0}`) ?? null,
                    label:        node.label,
                    parentId:     parentInstId,
                    order:        node.order,
                    maskId:       null,   // resolved after all instances built
                    _maskedByLayerIdx: node.maskedByLayerIdx ?? null,
                    _parentInstId:     parentInstId,
                    // Graphic-symbol loop metadata — fixed per placement.
                    loop:       node.loop       ?? 'play once',
                    firstFrame: node.firstFrame ?? 0,
                    frameStart: node.frameStart ?? 0,
                    // Visibility span in parent-local-frame space.
                    frameIn:  parentLocalFrame,
                    frameOut: parentLocalFrame + 1,
                    // rawMatrix is set each scrub by _applyFrame.
                    rawMatrix: [...node.rawMatrix],
                    transform: {
                        x: node.rawMatrix[4], y: node.rawMatrix[5],
                        rotation: 0, scaleX: node.rawMatrix[0], scaleY: node.rawMatrix[3],
                    },
                    // Empty tracks — renderer uses rawMatrix. Authoring pipeline
                    // populates tracks when the user adds keyframes.
                    tracks: { x: [], y: [], rotation: [], scaleX: [], scaleY: [] },
                    // Internal sparse matrix track (FLA import only).
                    _matrixTrack: [],
                }
                instByPath.set(path, inst)
                _instances.push(inst)
                seenParentFrs.set(inst.id, new Set())
            } else {
                inst.frameOut = parentLocalFrame + 1
            }

            // Add matrix keyframe at this parent-local frame (deduplicated).
            const seen = seenParentFrs.get(inst.id)
            if (!seen.has(parentLocalFrame)) {
                seen.add(parentLocalFrame)
                _addMatrixKf(inst._matrixTrack, parentLocalFrame, node.rawMatrix)
            }

            // Recurse: children's parent-local frame = this node's resolved childFrame.
            for (const child of node.children) {
                walk(child, inst.id, path, node.frameNum ?? 0)
            }
        }

        walk(rootNode, null, '', f)
    }

    // Resolve maskIds.
    for (const inst of _instances) {
        const layerIdx  = inst._maskedByLayerIdx
        const parentInst = _instances.find(i => i.id === inst._parentInstId)
        if (layerIdx == null || !parentInst) {
            inst.maskId = null
        } else {
            const parentSym = _symbolObjs.get(parentInst.symbolId)
            const g = parentSym?._groups?.find(
                g => g.type === 'masked' && g.maskLayerIdx === layerIdx
            )
            inst.maskId = g?.maskId ?? null
        }
        delete inst._maskedByLayerIdx
        delete inst._parentInstId
    }

    seenParentFrs.clear()
}

// Frame count from XML (used while symbolMap is still alive).
function _getDocFrameCount(doc) {
    const layersElem = doc?.getElementsByTagNameNS(XFL_NS, 'layers')[0]
    if (!layersElem) return 1
    let max = 1
    for (const layer of layersElem.children) {
        for (const child of layer.children) {
            if (child.localName !== 'frames') continue
            for (const f of child.children) {
                if (f.localName !== 'DOMFrame') continue
                const idx = parseInt(f.getAttribute('index') ?? '0')
                const dur = parseInt(f.getAttribute('duration') ?? '1')
                max = Math.max(max, idx + dur)
            }
        }
    }
    return max
}

// ── DOMDocument parser ────────────────────────────────────────────────────
// Reads the Flash stage document (DOMDocument.xml) to extract:
//   - canvas dimensions and frame rate
//   - the actual symbol instances placed on visible stage layers
// This is the proper entry point — no heuristics about library symbol names.

const _stageParser = new DOMParser()

function parseDomDocument(domXml) {
    const doc  = _stageParser.parseFromString(domXml, 'application/xml')
    const root = doc.documentElement

    const width  = parseFloat(root.getAttribute('width')     ?? '864')
    const height = parseFloat(root.getAttribute('height')    ?? '486')
    const fps    = parseFloat(root.getAttribute('frameRate') ?? '24')

    // Stage timeline duration — max(index + duration) across all DOMFrames
    let stageDuration = 1
    for (const frame of doc.getElementsByTagNameNS(XFL_NS, 'DOMFrame')) {
        const idx = parseInt(frame.getAttribute('index')    ?? '0')
        const dur = parseInt(frame.getAttribute('duration') ?? '1')
        stageDuration = Math.max(stageDuration, idx + dur)
    }

    // Collect symbol instances from visible, non-guide stage layers.
    const entries = []
    for (const layer of doc.getElementsByTagNameNS(XFL_NS, 'DOMLayer')) {
        const ltype   = layer.getAttribute('layerType') ?? 'normal'
        const visible = layer.getAttribute('visible') !== 'false'
        if (ltype === 'guide' || ltype === 'folder' || !visible) continue

        const layerName = layer.getAttribute('name') ?? 'Layer'
        for (const inst of layer.getElementsByTagNameNS(XFL_NS, 'DOMSymbolInstance')) {
            const symbolName = inst.getAttribute('libraryItemName')
            if (!symbolName) continue
            entries.push({
                layerName,
                symbolName,
                loop:       inst.getAttribute('loop') ?? 'loop',
                firstFrame: parseInt(inst.getAttribute('firstFrame') ?? '0'),
            })
        }
    }

    return { width, height, fps, stageDuration, entries }
}

// ── Stage entry selection dialog ──────────────────────────────────────────

function _promptStageEntry(entries) {
    return new Promise(resolve => {
        const mask = document.createElement('div')
        mask.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:9999',
            'background:rgba(0,0,0,0.65)',
            'display:flex', 'align-items:center', 'justify-content:center',
        ].join(';')

        const box = document.createElement('div')
        box.style.cssText = [
            'background:#1e1e1e', 'border:1px solid rgba(255,255,255,0.12)',
            'border-radius:8px', 'padding:20px 24px',
            'min-width:280px', 'max-width:480px', 'max-height:80vh', 'overflow-y:auto',
            'font:13px/1.5 monospace', 'color:#ccc',
        ].join(';')

        const title = document.createElement('div')
        title.textContent = 'Select scene entry'
        title.style.cssText = 'font-size:14px;font-weight:bold;margin-bottom:14px;color:#fff'
        box.appendChild(title)

        for (const entry of entries) {
            const label = entry.layerName
                ? `${entry.layerName}  →  ${entry.symbolName}`
                : entry.symbolName
            const btn = document.createElement('button')
            btn.textContent = label
            btn.title       = entry.symbolName
            btn.style.cssText = [
                'display:block', 'width:100%', 'margin-bottom:6px',
                'padding:8px 12px', 'text-align:left',
                'background:rgba(255,255,255,0.06)', 'border:1px solid rgba(255,255,255,0.1)',
                'border-radius:5px', 'color:#ddd', 'font:13px/1 monospace', 'cursor:pointer',
            ].join(';')
            btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.14)' })
            btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.06)' })
            btn.addEventListener('click', () => { document.body.removeChild(mask); resolve(entry) })
            box.appendChild(btn)
        }

        mask.appendChild(box)
        document.body.appendChild(mask)
    })
}

// ── Apply a frame ─────────────────────────────────────────────────────────
// Tree traversal: resolves each instance's childFrame from parent-local frame,
// evaluates its _matrixTrack and sets inst.rawMatrix. No decompose/recompose.

function _applyFrame(frameNum, resetView = false) {
    if (!_instances.length) return

    const childrenOf = new Map()
    for (const inst of _instances) {
        const pid = inst.parentId ?? null
        if (!childrenOf.has(pid)) childrenOf.set(pid, [])
        childrenOf.get(pid).push(inst)
    }

    const visibleIds = new Set()

    function resolve(inst, parentLocalFrame) {
        // Evaluate matrix track at parent-local frame → set rawMatrix directly.
        const mat = _evalMatrixTrack(inst._matrixTrack, parentLocalFrame)
        if (mat) {
            inst.rawMatrix    = mat
            inst.transform.x  = mat[4]
            inst.transform.y  = mat[5]
        }

        // Resolve which frame of the child symbol to show.
        const childFrame = _resolveChildFrame(inst, parentLocalFrame)
        const key        = `${inst._symbolName}@@${childFrame}`
        inst.symbolId    = _stableId(key)
        _ensureGpu(inst.symbolId)
        visibleIds.add(inst.id)

        // Recurse into children visible at childFrame (parent-local-frame space).
        for (const child of (childrenOf.get(inst.id) ?? [])) {
            if (childFrame >= child.frameIn && childFrame < child.frameOut) {
                resolve(child, childFrame)
            }
        }
    }

    for (const root of (childrenOf.get(null) ?? [])) {
        if (frameNum >= root.frameIn && frameNum < root.frameOut) {
            resolve(root, frameNum)
        }
    }

    // Sync scene — only visible instances and their required symbols.
    scene.symbols.length   = 0
    scene.instances.length = 0

    for (const inst of _instances) {
        if (!visibleIds.has(inst.id)) continue
        const sym = _symbolObjs.get(inst.symbolId)
        if (sym && !scene.symbols.some(s => s.id === sym.id)) {
            scene.symbols.push(sym)
            viewport.buildSymbolVaos(sym.id)
        }
        scene.instances.push(inst)
    }

    scene.timeline.currentFrame = frameNum
    if (resetView) viewport.fitCamera()
    viewport.markDirty()
    document.dispatchEvent(new CustomEvent('twist:sceneChanged'))
}

// ── Public API ────────────────────────────────────────────────────────────

async function importFla() {
    const result = await window.twist.openFla()
    if (!result) return
    if (result.error) { console.error('[fla import]', result.error); return }

    if (!result.dom) {
        console.error('[fla import] DOMDocument.xml missing from FLA'); return
    }
    const libXmls = result.libXmls
    if (!libXmls || !Object.keys(libXmls).length) {
        console.error('[fla import] no library XMLs returned'); return
    }

    // Parse the stage document — this is the real entry point.
    const stage = parseDomDocument(result.dom)
    console.log(`[fla import] stage: ${stage.width}×${stage.height} @${stage.fps}fps, ${stage.stageDuration} frames, ${stage.entries.length} stage entr${stage.entries.length === 1 ? 'y' : 'ies'}`)

    if (!stage.entries.length) {
        console.error('[fla import] no symbol instances found on stage'); return
    }

    // Let user pick if multiple visible entries on stage.
    const entry = stage.entries.length === 1
        ? stage.entries[0]
        : await _promptStageEntry(stage.entries)
    if (!entry) return

    console.log(`[fla import] building symbol map from ${Object.keys(libXmls).length} library entries…`)
    const symbolMap = buildSymbolMap(libXmls)
    console.log(`[fla import] ${symbolMap.size} symbols`)

    viewport.clearSymbolVaos()
    _symbolIds.clear()
    _symbolObjs.clear()
    _symFrameCounts.clear()

    // Stage duration drives the timeline. Root symbol may have more frames
    // internally but we only animate what the stage shows.
    const frameCount = stage.stageDuration
    console.log(`[fla import] building timeline — ${frameCount} frame(s), root: "${entry.symbolName}"…`)

    _buildTimeline(symbolMap, entry.symbolName, frameCount)

    // All bezier-path geometry stored. Flash XML is no longer referenced —
    // dropping the local reference lets the GC collect all DOM documents.
    console.log(`[fla import] done — ${_instances.length} instances, ${_symbolIds.size} symbol keys`)

    // Apply stage dimensions to camera.
    scene.camera.width  = stage.width
    scene.camera.height = stage.height
    scene.timeline.fps      = stage.fps
    scene.timeline.duration = frameCount
    _applyFrame(0, true)

    document.dispatchEvent(new CustomEvent('twist:flaImported', { detail: { frameCount } }))
}

function scrubToFrame(frameNum) {
    _applyFrame(frameNum, false)
}

// Sync scene on playback advance and manual timeline scrub.
document.addEventListener('twist:frameChange', () => {
    if (_instances.length) _applyFrame(scene.timeline.currentFrame, false)
})

export { importFla, scrubToFrame }

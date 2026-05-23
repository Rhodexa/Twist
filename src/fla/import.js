// FLA import pipeline — hierarchical mode.
// Produces one scene.symbol per unique FLA symbol (geometry in local space)
// and a tree of scene.instances mirroring the FLA symbol hierarchy.
//
// Pre-caches ALL frames at import time so scrubbing never retessellates.
// Each unique (symbolName, frameNum) combo gets a stable ID; VAOs are uploaded
// once and reused across frames.

import { buildSymbolMap, findRoots, parseHierarchy } from './parser.js'
import { tessellateAll, extractEdgeContours } from './tessellate.js'
import scene    from '../scene/scene.js'
import viewport from '../ui/viewport.js'

// ── Module state ──────────────────────────────────────────────────────────

let _importCounter  = 0
let _frameSnapshots = []        // [{symbols, instances}] indexed by frame number

// Persistent across scrubs within the same file. Reset on new file open.
const _symbolIds  = new Map()   // "symbolName@@frameNum" → stable uid
const _symbolObjs = new Map()   // uid → scene.symbol (tessellated once, shared across frames)

// ── Stable identity helpers ───────────────────────────────────────────────

// Same (symbolName, frameNum) always gets the same uid within a file session.
function _stableId(key) {
    if (!_symbolIds.has(key)) _symbolIds.set(key, `fla_${++_importCounter}`)
    return _symbolIds.get(key)
}

// Tessellate + cache. Returns an existing symbol object if already built.
function _getSymbol(key, regions) {
    const uid = _stableId(key)
    if (!_symbolObjs.has(uid)) {
        const name = key.split('@@')[0]
        _symbolObjs.set(uid, {
            id:           uid,
            name,
            label:        name.split('/').pop().replace(/^~/, ''),
            meshes:       tessellateAll(regions),
            edgeContours: extractEdgeContours(regions),
        })
    }
    return _symbolObjs.get(uid)
}

// ── Frame snapshot builder ────────────────────────────────────────────────

// Parse and tessellate a single frame. Reuses cached symbol objects.
function _buildSnapshot(symbolMap, rootName, frameNum) {
    const { symbolGeometry, rootNode } = parseHierarchy(rootName, symbolMap, frameNum)

    const symbols  = []
    const symIdMap = new Map()   // "symbolName@@fn" → uid, for instance lookup

    for (const [key, regions] of symbolGeometry) {
        const sym = _getSymbol(key, regions)
        if (!symbols.some(s => s.id === sym.id)) {
            symbols.push(sym)
            if (!sym.meshes?.length)
                console.warn(`[fla] no geometry: ${key}`)
        }
        symIdMap.set(key, sym.id)
    }

    const instances = []
    function flattenNode(node, parentInstId) {
        const symId = symIdMap.get(`${node.symbolName}@@${node.frameNum ?? 0}`)
        if (!symId) return
        const instId = `inst_fla_${++_importCounter}`
        instances.push({
            id:        instId,
            symbolId:  symId,
            label:     node.label,
            parentId:  parentInstId,
            order:     node.order,
            rawMatrix: node.rawMatrix,
            transform: {
                x: node.rawMatrix[4],  y: node.rawMatrix[5],
                rotation: 0,  scaleX: node.rawMatrix[0],  scaleY: node.rawMatrix[3],
            },
            tracks: { x: [], y: [], rotation: [], scaleX: [], scaleY: [] },
        })
        for (const child of node.children) flattenNode(child, instId)
    }
    flattenNode(rootNode, null)

    return { symbols, instances }
}

// ── Frame count ───────────────────────────────────────────────────────────

function getSymbolFrameCount(symbolName, symbolMap) {
    const XFL_NS = 'http://ns.adobe.com/xfl/2008/'
    const doc = symbolMap.get(symbolName)
    if (!doc) return 1
    const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
    if (!layersElem) return 1
    let maxFrame = 1
    for (const layer of layersElem.children) {
        for (const child of layer.children) {
            if (child.localName !== 'frames') continue
            for (const f of child.children) {
                if (f.localName !== 'DOMFrame') continue
                const idx = parseInt(f.getAttribute('index') ?? '0')
                const dur = parseInt(f.getAttribute('duration') ?? '1')
                maxFrame = Math.max(maxFrame, idx + dur)
            }
        }
    }
    return maxFrame
}

// ── Root selection dialog ─────────────────────────────────────────────────

function _promptRoot(roots) {
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
        title.textContent = 'Select root symbol'
        title.style.cssText = 'font-size:14px;font-weight:bold;margin-bottom:14px;color:#fff'
        box.appendChild(title)

        // Tilde (composite) roots first, then alphabetical
        const sorted = [...roots].sort((a, b) => {
            const at = a.split('/').pop().startsWith('~') ? 0 : 1
            const bt = b.split('/').pop().startsWith('~') ? 0 : 1
            return at - bt || a.localeCompare(b)
        })

        for (const name of sorted) {
            const short = name.split('/').pop().replace(/^~/, '')
            const btn = document.createElement('button')
            btn.textContent = short
            btn.title = name
            btn.style.cssText = [
                'display:block', 'width:100%', 'margin-bottom:6px',
                'padding:8px 12px', 'text-align:left',
                'background:rgba(255,255,255,0.06)', 'border:1px solid rgba(255,255,255,0.1)',
                'border-radius:5px', 'color:#ddd', 'font:13px/1 monospace', 'cursor:pointer',
            ].join(';')
            btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.14)' })
            btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.06)' })
            btn.addEventListener('click', () => { document.body.removeChild(mask); resolve(name) })
            box.appendChild(btn)
        }

        mask.appendChild(box)
        document.body.appendChild(mask)
    })
}

// ── Apply a cached frame to the scene ─────────────────────────────────────

function _applyFrame(frameNum, resetView = false) {
    const snap = _frameSnapshots[frameNum]
    if (!snap) return

    scene.symbols.length   = 0
    scene.instances.length = 0

    for (const sym of snap.symbols) {
        scene.symbols.push(sym)
        viewport.buildSymbolVaos(sym.id)   // no-op if already uploaded
    }
    for (const inst of snap.instances) scene.instances.push(inst)

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

    const libXmls = result.libXmls
    if (!libXmls || !Object.keys(libXmls).length) {
        console.error('[fla import] no library XMLs returned'); return
    }

    console.log(`[fla import] building symbol map from ${Object.keys(libXmls).length} entries…`)
    const symbolMap = buildSymbolMap(libXmls)
    console.log(`[fla import] ${symbolMap.size} symbols`)

    const roots = findRoots(symbolMap)
    if (!roots.length) { console.error('[fla import] empty symbol map'); return }

    const rootName = roots.length > 1 ? await _promptRoot(roots) : roots[0]
    if (!rootName) return

    // Release previous file's GPU data and caches
    viewport.clearSymbolVaos()
    _symbolIds.clear()
    _symbolObjs.clear()
    _frameSnapshots = []

    const frameCount = getSymbolFrameCount(rootName, symbolMap)
    console.log(`[fla import] pre-caching ${frameCount} frame(s)…`)

    for (let f = 0; f < frameCount; f++) {
        _frameSnapshots.push(_buildSnapshot(symbolMap, rootName, f))
    }

    console.log(`[fla import] ready — ${_symbolObjs.size} unique symbols across ${frameCount} frame(s)`)

    scene.timeline.duration = frameCount
    _applyFrame(0, true)

    document.dispatchEvent(new CustomEvent('twist:flaImported', { detail: { frameCount } }))
}

// Scrub to a pre-cached frame. Does NOT reset the view.
function scrubToFrame(frameNum) {
    _applyFrame(frameNum, false)
}

export { importFla, scrubToFrame }

// FLA import pipeline — hierarchical mode.
// Produces one scene.symbol per unique FLA symbol (geometry in local space)
// and a tree of scene.instances mirroring the FLA symbol hierarchy.

import { buildSymbolMap, findRoots, parseHierarchy } from './parser.js'
import { tessellateRegions }                          from './tessellate.js'
import scene    from '../scene/scene.js'
import viewport from '../ui/viewport.js'

let _importCounter = 0

function _pickRoot(roots, symbolMap) {
    if (!roots.length) return null
    // DHX naming: composites start with ~. Among ~ roots, prefer the one
    // referencing the most instances (most complete character rig).
    const tildeRoots = roots.filter(r => r.split('/').pop().startsWith('~'))
    const pool = tildeRoots.length ? tildeRoots : roots
    if (pool.length === 1) return pool[0]
    return pool.reduce((best, name) => {
        const refs  = symbolMap.get(name)?.getElementsByTagNameNS('http://ns.adobe.com/xfl/2008/', 'DOMSymbolInstance').length ?? 0
        const brefs = symbolMap.get(best)?.getElementsByTagNameNS('http://ns.adobe.com/xfl/2008/', 'DOMSymbolInstance').length ?? 0
        return refs > brefs ? name : best
    })
}

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

    const roots    = findRoots(symbolMap)
    const rootName = _pickRoot(roots, symbolMap)
    if (!rootName) { console.error('[fla import] empty symbol map'); return }

    console.log(`[fla import] parsing hierarchy from "${rootName}"…`)
    const { symbolGeometry, rootNode } = parseHierarchy(rootName, symbolMap, 0)
    console.log(`[fla import] ${symbolGeometry.size} unique symbols`)

    // ── Build scene.symbols ────────────────────────────────────────────────
    // One scene.symbol per unique FLA symbol name, geometry in LOCAL space.
    const symIdMap = new Map()   // FLA symbol name → scene.symbol.id

    for (const [name, regions] of symbolGeometry) {
        const uid      = `fla_${++_importCounter}`
        const submeshes = tessellateRegions(regions)
        scene.symbols.push({
            id:       uid,
            name,
            label:    name.split('/').pop().replace(/^~/, ''),
            submeshes,   // empty [] for pure-composite symbols (no direct shapes)
        })
        symIdMap.set(name, uid)
        viewport.buildSymbolVaos(uid)
    }

    // ── Flatten instance tree into scene.instances ─────────────────────────
    // parentId: null = top level; rawMatrix = Flash affine [a,b,c,d,tx,ty].
    const baseInst = scene.instances.length

    function flattenNode(node, parentInstId) {
        const symId = symIdMap.get(node.symbolName)
        if (!symId) return

        const instId = `inst_fla_${++_importCounter}`
        scene.instances.push({
            id:        instId,
            symbolId:  symId,
            label:     node.label,
            parentId:  parentInstId,
            order:     node.order,
            rawMatrix: node.rawMatrix,          // [a,b,c,d,tx,ty] from FLA
            transform: {                        // TRS approximation for keyframing
                x: node.rawMatrix[4], y: node.rawMatrix[5],
                rotation: 0, scaleX: node.rawMatrix[0], scaleY: node.rawMatrix[3],
            },
            tracks: { x: [], y: [], rotation: [], scaleX: [], scaleY: [] },
        })

        for (const child of node.children) flattenNode(child, instId)
    }

    flattenNode(rootNode, null)

    const added = scene.instances.length - baseInst
    console.log(`[fla import] ${added} instances — done`)

    viewport.fitCamera()
    viewport.markDirty()
    document.dispatchEvent(new CustomEvent('twist:sceneChanged'))
}

export { importFla }

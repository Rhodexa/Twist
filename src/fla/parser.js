// XFL/FLA parser — JS port of FLA-RE's fla_inspect.py core.
// Produces fill regions (colored segment lists) from a symbol hierarchy.
// No SVG output — caller tessellates and uploads to GPU.

const XFL_NS = 'http://ns.adobe.com/xfl/2008/'
const _domParser = new DOMParser()

function parseXml(str) {
    return _domParser.parseFromString(str, 'application/xml')
}

// ── Direct-child helpers ───────────────────────────────────────────────────
// getElementsByTagNameNS is recursive; for structure navigation we want
// direct children only.

function childByLocalName(elem, name) {
    for (const c of elem.children) if (c.localName === name) return c
    return null
}

function childrenByLocalName(elem, name) {
    return Array.from(elem.children).filter(c => c.localName === name)
}

// ── Matrix ─────────────────────────────────────────────────────────────────

const IDENTITY = [1, 0, 0, 1, 0, 0]

function readMatrix(elem) {
    if (!elem) return IDENTITY
    const mc = childByLocalName(elem, 'matrix')
    if (!mc) return IDENTITY
    const m  = childByLocalName(mc, 'Matrix')
    if (!m)  return IDENTITY
    return [
        parseFloat(m.getAttribute('a')  ?? '1'),
        parseFloat(m.getAttribute('b')  ?? '0'),
        parseFloat(m.getAttribute('c')  ?? '0'),
        parseFloat(m.getAttribute('d')  ?? '1'),
        parseFloat(m.getAttribute('tx') ?? '0'),
        parseFloat(m.getAttribute('ty') ?? '0'),
    ]
}

function composeMat([pa, pb, pc, pd, ptx, pty], [ca, cb, cc, cd, ctx, cty]) {
    return [
        pa*ca + pc*cb,          pb*ca + pd*cb,
        pa*cc + pc*cd,          pb*cc + pd*cd,
        pa*ctx + pc*cty + ptx,  pb*ctx + pd*cty + pty,
    ]
}

function applyMat([a, b, c, d, tx, ty], x, y) {
    return [a*x + c*y + tx, b*x + d*y + ty]
}

function isIdentity(m) {
    return m[0]===1 && m[1]===0 && m[2]===0 && m[3]===1 && m[4]===0 && m[5]===0
}

function matsEqual(a, b) {
    for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 0.0001) return false
    return true
}

// ── Edge parsing ───────────────────────────────────────────────────────────

function decodeHex(tok) {
    const s = tok.slice(1)
    const dot = s.indexOf('.')
    const ih = dot < 0 ? s : s.slice(0, dot)
    const fh = dot < 0 ? '0' : s.slice(dot + 1)
    let v = parseInt(ih, 16)
    if (v >= 0x800000) v -= 0x1000000   // 24-bit two's complement
    return v + parseInt(fh, 16) / 256.0
}

// Matches Flash edge string tokens: commands, Sn selectors, #hex, decimals.
const TOK_RE = /[!|[]|S\d+|#[0-9A-Fa-f]+(?:\.[0-9A-Fa-f]+)?|[-+]?\d+(?:\.\d+)?/g

function parseEdgeStr(s) {
    const tokens = s.match(TOK_RE) || []
    const cmds   = []
    let i = 0

    function num() {
        const tok = tokens[i++]
        const raw = tok.startsWith('#') ? decodeHex(tok) : parseFloat(tok)
        return raw / 20.0   // twips → pixels
    }

    while (i < tokens.length) {
        const tok = tokens[i++]
        if      (tok === '!') { const x = num(), y = num(); cmds.push({ type: 'M', x, y }) }
        else if (tok === '|') { const x = num(), y = num(); cmds.push({ type: 'L', x, y }) }
        else if (tok === '[') {
            const cx = num(), cy = num(), x = num(), y = num()
            cmds.push({ type: 'Q', cx, cy, x, y })
        }
        // 'S' style tokens: already consumed by regex, drop them
    }
    return cmds
}

// ── Segment operations ─────────────────────────────────────────────────────

function splitSegs(cmds) {
    const segs = []
    let cur = []
    for (const c of cmds) {
        if (c.type === 'M') { if (cur.length > 1) segs.push(cur); cur = [c] }
        else cur.push(c)
    }
    if (cur.length > 1) segs.push(cur)
    return segs
}

// Reverse a segment so fill-right (fillStyle1) becomes fill-left.
// Control point is kept in place (known approximation — correct later per REFACTOR).
function reverseSeg(seg) {
    if (seg.length < 2) return seg
    const steps = []
    let cx = seg[0].x, cy = seg[0].y
    for (let i = 1; i < seg.length; i++) {
        const c = seg[i]
        steps.push({ fx: cx, fy: cy, cmd: c })
        if (c.type === 'L') { cx = c.x; cy = c.y }
        else if (c.type === 'Q') { cx = c.x; cy = c.y }
    }
    const result = [{ type: 'M', x: cx, y: cy }]
    for (let i = steps.length - 1; i >= 0; i--) {
        const { fx, fy, cmd } = steps[i]
        if (cmd.type === 'L') result.push({ type: 'L', x: fx, y: fy })
        else result.push({ type: 'Q', cx: cmd.cx, cy: cmd.cy, x: fx, y: fy })
    }
    return result
}

// Apply matrix to every coordinate in a segment.
function applyMatToSeg(mat, seg) {
    if (isIdentity(mat)) return seg
    return seg.map(c => {
        if (c.type === 'M' || c.type === 'L') {
            const [x, y] = applyMat(mat, c.x, c.y)
            return { type: c.type, x, y }
        } else {
            const [cx, cy] = applyMat(mat, c.cx, c.cy)
            const [x,  y ] = applyMat(mat, c.x,  c.y)
            return { type: 'Q', cx, cy, x, y }
        }
    })
}

// ── Fill color ─────────────────────────────────────────────────────────────

function hexColorToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    return [r, g, b, alpha]
}

function getFillColor(shapeElem, idx) {
    for (const fs of shapeElem.getElementsByTagNameNS(XFL_NS, 'FillStyle')) {
        if (fs.getAttribute('index') !== String(idx)) continue
        const sc = childByLocalName(fs, 'SolidColor')
        if (sc) {
            const color = sc.getAttribute('color') ?? '#000000'
            const alpha = parseFloat(sc.getAttribute('alpha') ?? '1')
            return hexColorToRgba(color, alpha)
        }
        // Gradient — placeholder color for now
        if (childByLocalName(fs, 'LinearGradient')) return [0.53, 0.67, 1.0, 1.0]
        if (childByLocalName(fs, 'RadialGradient')) return [1.0, 0.67, 0.53, 1.0]
    }
    return [0, 0, 0, 1]
}

// ── Stroke style ───────────────────────────────────────────────────────────

function getStrokeStyle(shapeElem, idx) {
    for (const ss of shapeElem.getElementsByTagNameNS(XFL_NS, 'StrokeStyle')) {
        if (ss.getAttribute('index') !== String(idx)) continue
        const sol = childByLocalName(ss, 'SolidStroke')
        if (!sol) continue
        const width = parseFloat(sol.getAttribute('weight') ?? '2')
        const fillEl = childByLocalName(sol, 'fill')
        if (fillEl) {
            const sc = childByLocalName(fillEl, 'SolidColor')
            if (sc) {
                const color = sc.getAttribute('color') ?? '#000000'
                const alpha = parseFloat(sc.getAttribute('alpha') ?? '1')
                return { color: hexColorToRgba(color, alpha), width }
            }
        }
        return { color: [0, 0, 0, 1], width }
    }
    return { color: [0, 0, 0, 1], width: 2 }
}

// ── Shape → fill + stroke region segments ──────────────────────────────────

// Fills: Map<fillIdx, {color, segs}>  (segments in worldMat space)
// Strokes: Map<strokeIdx, {color, width, segs}>
function shapeToRegions(shapeElem, worldMat, fillMap, strokeMap) {
    if (!fillMap)   fillMap   = new Map()
    if (!strokeMap) strokeMap = new Map()

    for (const edgeElem of shapeElem.getElementsByTagNameNS(XFL_NS, 'Edge')) {
        const es = edgeElem.getAttribute('edges')?.trim()
        if (!es) continue
        let cmds
        try { cmds = parseEdgeStr(es) } catch { continue }
        const segs = splitSegs(cmds)
        if (!segs.length) continue

        const f0s = edgeElem.getAttribute('fillStyle0')
        const f1s = edgeElem.getAttribute('fillStyle1')
        const sss = edgeElem.getAttribute('strokeStyle')

        if (f0s) {
            const idx = parseInt(f0s)
            if (!fillMap.has(idx)) fillMap.set(idx, { color: getFillColor(shapeElem, idx), segs: [] })
            for (const s of segs) fillMap.get(idx).segs.push(applyMatToSeg(worldMat, s))
        }
        if (f1s) {
            const idx = parseInt(f1s)
            if (!fillMap.has(idx)) fillMap.set(idx, { color: getFillColor(shapeElem, idx), segs: [] })
            for (const s of segs) fillMap.get(idx).segs.push(applyMatToSeg(worldMat, reverseSeg(s)))
        }
        if (sss) {
            const idx = parseInt(sss)
            if (!strokeMap.has(idx)) strokeMap.set(idx, { ...getStrokeStyle(shapeElem, idx), segs: [] })
            for (const s of segs) strokeMap.get(idx).segs.push(applyMatToSeg(worldMat, s))
        }
    }
    return { fillMap, strokeMap }
}

// Legacy fill-only wrapper (used by flat-mode traversal paths).
function shapeToFillRegions(shapeElem, worldMat, fillMap) {
    return shapeToRegions(shapeElem, worldMat, fillMap ?? new Map(), new Map()).fillMap
}

// ── Active frame ────────────────────────────────────────────────────────────

// Returns the DOMFrame active at frameNum, implementing Flash's "hold last keyframe"
// rule: a keyframe's content persists past its explicit duration until the next
// keyframe starts. This matches Flash's default layer behaviour for static geometry.
function activeFrame(layerElem, frameNum) {
    const framesElem = childByLocalName(layerElem, 'frames')
    if (!framesElem) return null
    let best = null
    for (const f of framesElem.children) {
        if (f.localName !== 'DOMFrame') continue
        const idx = parseInt(f.getAttribute('index') ?? '0')
        const dur = parseInt(f.getAttribute('duration') ?? '1')
        if (idx <= frameNum && frameNum < idx + dur) return f   // exact match
        if (idx <= frameNum) best = f                           // last keyframe before frameNum
    }
    return best
}

// ── Group traversal ────────────────────────────────────────────────────────

function collectGroupRegions(groupElem, parentMat, symbolMap, frameNum, visited, fillMap) {
    const groupMat = readMatrix(groupElem)
    const effMat   = isIdentity(groupMat) ? parentMat : composeMat(parentMat, groupMat)
    const members  = childByLocalName(groupElem, 'members')
    if (!members) return

    for (const child of members.children) {
        const ln = child.localName
        if (ln === 'DOMShape') {
            const shapeMat  = readMatrix(child)
            const suppress  = matsEqual(shapeMat, groupMat)
            const shapeMat2 = suppress ? effMat : composeMat(effMat, shapeMat)
            shapeToFillRegions(child, shapeMat2, fillMap)
        } else if (ln === 'DOMGroup') {
            collectGroupRegions(child, effMat, symbolMap, frameNum, visited, fillMap)
        } else if (ln === 'DOMSymbolInstance') {
            const cName = child.getAttribute('libraryItemName')
            if (cName && !visited.has(cName)) {
                const ff    = parseInt(child.getAttribute('firstFrame') ?? '0')
                const iMat  = readMatrix(child)
                const wMat  = isIdentity(iMat) ? effMat : composeMat(effMat, iMat)
                collectSymbolRegions(cName, symbolMap, ff, wMat, new Set(visited), fillMap)
            }
        }
    }
}

// ── Symbol traversal ───────────────────────────────────────────────────────

// Traverses the symbol hierarchy from `name`, accumulating fill regions
// (segments already in world / root-local space via mat).
// Uses a flat Map<fillIdx, {color, segs}> to accumulate across all shapes —
// separate fills per shape to preserve distinct colors.
// Actually: each shape has its own fill indices that are local to that shape.
// Two shapes can both have fillStyle0="1" but different colors.
// So we can't use a single Map keyed by fillIdx across shapes.
// Instead we collect an array of {color, segs} entries.

function collectSymbolRegions(name, symbolMap, frameNum, mat, visited, out) {
    if (visited.has(name)) return
    visited.add(name)

    const doc = symbolMap.get(name)
    if (!doc) return

    const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
    if (!layersElem) return

    // Flash XML: layer 0 = topmost. Reverse to accumulate back-to-front.
    for (const layer of Array.from(layersElem.children).reverse()) {
        const ltype = layer.getAttribute('layerType') ?? 'normal'
        // Skip non-rendered layer types. Mask layers skipped for now (no stencil yet).
        if (ltype === 'guide' || ltype === 'folder' || ltype === 'mask') continue
        if (layer.getAttribute('visible') === 'false') continue

        const frame = activeFrame(layer, frameNum)
        if (!frame) continue
        const elements = childByLocalName(frame, 'elements')
        if (!elements) continue

        for (const elem of elements.children) {
            const ln = elem.localName
            if (ln === 'DOMShape') {
                const shapeMat  = readMatrix(elem)
                const effectMat = isIdentity(shapeMat) ? mat : composeMat(mat, shapeMat)
                // Each shape gets its own fill map so fill indices don't collide across shapes
                const fillMap = new Map()
                shapeToFillRegions(elem, effectMat, fillMap)
                for (const { color, segs } of fillMap.values()) {
                    if (segs.length) out.push({ color, segs })
                }
            } else if (ln === 'DOMGroup') {
                // Groups also get their own fill accumulator per shape inside
                const groupOut = []
                collectGroupRegionsFlat(elem, mat, symbolMap, frameNum, visited, groupOut)
                out.push(...groupOut)
            } else if (ln === 'DOMSymbolInstance') {
                const cName = elem.getAttribute('libraryItemName')
                if (!cName || visited.has(cName)) continue
                const ff   = parseInt(elem.getAttribute('firstFrame') ?? '0')
                const iMat = readMatrix(elem)
                const wMat = isIdentity(iMat) ? mat : composeMat(mat, iMat)
                collectSymbolRegions(cName, symbolMap, ff, wMat, new Set(visited), out)
            }
        }
    }
}

// Group traversal variant that pushes to a flat array (one entry per shape fill region).
function collectGroupRegionsFlat(groupElem, parentMat, symbolMap, frameNum, visited, out) {
    const groupMat = readMatrix(groupElem)
    const effMat   = isIdentity(groupMat) ? parentMat : composeMat(parentMat, groupMat)
    const members  = childByLocalName(groupElem, 'members')
    if (!members) return

    for (const child of members.children) {
        const ln = child.localName
        if (ln === 'DOMShape') {
            const shapeMat = readMatrix(child)
            const suppress = matsEqual(shapeMat, groupMat)
            const sMat     = suppress ? effMat : composeMat(effMat, shapeMat)
            const fillMap  = new Map()
            shapeToFillRegions(child, sMat, fillMap)
            for (const { color, segs } of fillMap.values()) {
                if (segs.length) out.push({ color, segs })
            }
        } else if (ln === 'DOMGroup') {
            collectGroupRegionsFlat(child, effMat, symbolMap, frameNum, visited, out)
        } else if (ln === 'DOMSymbolInstance') {
            const cName = child.getAttribute('libraryItemName')
            if (cName && !visited.has(cName)) {
                const ff   = parseInt(child.getAttribute('firstFrame') ?? '0')
                const iMat = readMatrix(child)
                const wMat = isIdentity(iMat) ? effMat : composeMat(effMat, iMat)
                collectSymbolRegions(cName, symbolMap, ff, wMat, new Set(visited), out)
            }
        }
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

// Build a symbol map from the {path: xmlString} object returned by fla:open.
function buildSymbolMap(libXmls) {
    const map = new Map()
    for (const xmlStr of Object.values(libXmls)) {
        const doc  = parseXml(xmlStr)
        const root = doc.documentElement
        if (!root) continue
        const name = root.getAttribute('name')
        if (name) map.set(name, doc)
    }
    return map
}

// Find root symbols: not referenced by any other symbol.
function findRoots(symbolMap) {
    const referenced = new Set()
    for (const doc of symbolMap.values()) {
        for (const inst of doc.getElementsByTagNameNS(XFL_NS, 'DOMSymbolInstance')) {
            const n = inst.getAttribute('libraryItemName')
            if (n) referenced.add(n)
        }
    }
    return [...symbolMap.keys()].filter(n => !referenced.has(n)).sort()
}

// Compose a symbol hierarchy at frameNum, returning a flat array of
// { color: [r,g,b,a], segs: Seg[] } — one entry per fill region per shape.
// All segment coordinates are in the root symbol's local space.
function composeFillRegions(rootName, symbolMap, frameNum = 0) {
    const out = []
    collectSymbolRegions(rootName, symbolMap, frameNum, IDENTITY, new Set(), out)
    return out
}

// ── Direct-geometry collector ──────────────────────────────────────────────
// Like collectSymbolRegions but stops at DOMSymbolInstance boundaries.
// Returns only the fill regions from shapes/groups directly in the symbol's
// own layers — child instances are left to the hierarchy builder.
// Layers are iterated back-to-front so the resulting array is painter-ordered.

// regions: ordered array of { type:'fill'|'stroke', color, segs, width? }
// Fills and strokes are interleaved per-shape to preserve Flash paint order.
function collectGroupDirect(groupElem, parentMat, regions) {
    const groupMat = readMatrix(groupElem)
    const effMat   = isIdentity(groupMat) ? parentMat : composeMat(parentMat, groupMat)
    const members  = childByLocalName(groupElem, 'members')
    if (!members) return
    for (const child of members.children) {
        const ln = child.localName
        if (ln === 'DOMShape') {
            const sm       = readMatrix(child)
            const suppress = matsEqual(sm, groupMat)
            const sMat     = suppress ? effMat : composeMat(effMat, sm)
            const { fillMap, strokeMap } = shapeToRegions(child, sMat)
            // fills before strokes within each shape — matches Flash/SVG paint order
            for (const { color, segs }        of fillMap.values())   if (segs.length) regions.push({ type: 'fill',   color, segs })
            for (const { color, width, segs } of strokeMap.values()) if (segs.length) regions.push({ type: 'stroke', color, width, segs })
        } else if (ln === 'DOMGroup') {
            collectGroupDirect(child, effMat, regions)
        }
        // DOMSymbolInstance inside a group: skip — becomes a child instance
    }
}

// Returns an ordered array of { type, color, segs, width? } — fills and strokes
// interleaved per shape so the caller can tessellate in correct paint order.
function collectDirectRegions(doc, frameNum) {
    const regions    = []
    const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
    if (!layersElem) return regions

    // Reverse = back-to-front (XML order is front-to-back)
    for (const layer of Array.from(layersElem.children).reverse()) {
        const ltype = layer.getAttribute('layerType') ?? 'normal'
        if (ltype === 'guide' || ltype === 'folder' || ltype === 'mask') continue
        if (layer.getAttribute('visible') === 'false') continue
        const frame = activeFrame(layer, frameNum)
        if (!frame) continue
        const elements = childByLocalName(frame, 'elements')
        if (!elements) continue

        for (const elem of elements.children) {
            const ln = elem.localName
            if (ln === 'DOMShape') {
                const shapeMat = readMatrix(elem)
                const { fillMap, strokeMap } = shapeToRegions(elem, shapeMat)
                for (const { color, segs }        of fillMap.values())   if (segs.length) regions.push({ type: 'fill',   color, segs })
                for (const { color, width, segs } of strokeMap.values()) if (segs.length) regions.push({ type: 'stroke', color, width, segs })
            } else if (ln === 'DOMGroup') {
                collectGroupDirect(elem, IDENTITY, regions)
            }
            // DOMSymbolInstance: skip — child instances are built by parseHierarchy
        }
    }
    return regions
}

// ── Hierarchy builder ──────────────────────────────────────────────────────
// Walks the FLA symbol tree depth-first, collecting:
//   symbolGeometry — Map<symbolName, regions[]> (geometry in each symbol's local space)
//   rootNode       — InstanceNode tree (mirrors the FLA instance hierarchy)
//
// InstanceNode: { symbolName, rawMatrix, order, label, children }
//   rawMatrix — the Flash affine matrix [a,b,c,d,tx,ty] on this instance
//   order     — render order within siblings (ascending = back-to-front)
//   label     — short display name for the outliner

let _hierarchyIdCounter = 0

function parseHierarchy(rootName, symbolMap, frameNum = 0) {
    const symbolGeometry = new Map()

    function ensureGeometry(name, fn) {
        const key = `${name}@@${fn}`
        if (symbolGeometry.has(key)) return
        const doc = symbolMap.get(name)
        symbolGeometry.set(key, doc ? collectDirectRegions(doc, fn) : [])
    }

    function buildNode(symbolName, rawMatrix, order, label, visited, fn) {
        ensureGeometry(symbolName, fn)
        if (visited.has(symbolName)) return { symbolName, frameNum: fn, rawMatrix, order, label, children: [] }
        visited = new Set(visited)
        visited.add(symbolName)

        const doc = symbolMap.get(symbolName)
        if (!doc) return { symbolName, rawMatrix, order, label, children: [] }

        const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
        if (!layersElem) return { symbolName, rawMatrix, order, label, children: [] }

        const allLayers = Array.from(layersElem.children)
        const children  = []

        // Collect DOMSymbolInstances from elements, recursing into DOMGroups.
        // groupAccMat: accumulated group matrix (group local → symbol local).
        function collectInstances(elems, groupAccMat, renderOrder) {
            for (const elem of elems) {
                if (elem.localName === 'DOMSymbolInstance') {
                    const childName = elem.getAttribute('libraryItemName')
                    if (!childName) continue
                    const iMat     = readMatrix(elem)
                    // Compose: group chain first, then instance placement.
                    const finalMat = isIdentity(groupAccMat) ? iMat : composeMat(groupAccMat, iMat)
                    const ff       = parseInt(elem.getAttribute('firstFrame') ?? '0')
                    const lbl      = childName.split('/').pop().replace(/^~/, '')
                    children.push(buildNode(childName, finalMat, renderOrder, lbl, visited, ff))
                } else if (elem.localName === 'DOMGroup') {
                    const gMat    = readMatrix(elem)
                    const newAcc  = isIdentity(gMat) ? groupAccMat : composeMat(groupAccMat, gMat)
                    const members = childByLocalName(elem, 'members')
                    if (members) collectInstances(Array.from(members.children), newAcc, renderOrder)
                }
            }
        }

        for (let i = 0; i < allLayers.length; i++) {
            const layer = allLayers[i]
            const ltype = layer.getAttribute('layerType') ?? 'normal'
            if (ltype === 'guide' || ltype === 'folder' || ltype === 'mask') continue
            if (layer.getAttribute('visible') === 'false') continue
            const frame = activeFrame(layer, frameNum)
            if (!frame) continue
            const elements = childByLocalName(frame, 'elements')
            if (!elements) continue

            // FLA layer 0 = topmost; renderOrder ascending = back-to-front
            const renderOrder = allLayers.length - i
            collectInstances(Array.from(elements.children), IDENTITY, renderOrder)
        }

        children.sort((a, b) => a.order - b.order)
        return { symbolName, frameNum: fn, rawMatrix, order, label, children }
    }

    const rootLabel = rootName.split('/').pop().replace(/^~/, '')
    const rootNode  = buildNode(rootName, IDENTITY, 0, rootLabel, new Set(), frameNum)
    return { symbolGeometry, rootNode }
}

export { buildSymbolMap, findRoots, composeFillRegions, parseHierarchy }

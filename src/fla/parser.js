// XFL/FLA parser — JS port of FLA-RE's fla_inspect.py core.
// Produces fill regions (colored segment lists) from a symbol hierarchy.
// No SVG output — caller tessellates and uploads to GPU.

const XFL_NS = 'http://ns.adobe.com/xfl/2008/'
const _domParser = new DOMParser()

function parseXml(str) {
    return _domParser.parseFromString(str, 'application/xml')
}

// ── Direct-child helpers ───────────────────────────────────────────────────

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

// ── Motion tween interpolation ─────────────────────────────────────────────

function _decomposeMatrix([a, b, c, d, tx, ty]) {
    return {
        tx, ty,
        scaleX:   Math.sqrt(a*a + b*b),
        scaleY:   Math.sqrt(c*c + d*d),
        rotation: Math.atan2(b, a),
    }
}

function _recomposeMatrix({ tx, ty, scaleX, scaleY, rotation }) {
    const cos = Math.cos(rotation), sin = Math.sin(rotation)
    return [scaleX*cos, scaleX*sin, -scaleY*sin, scaleY*cos, tx, ty]
}

function _lerpAngle(a, b, t) {
    let d = b - a
    while (d >  Math.PI) d -= 2*Math.PI
    while (d < -Math.PI) d += 2*Math.PI
    return a + d*t
}

function _lerpMatrix(m0, m1, t) {
    const d0 = _decomposeMatrix(m0), d1 = _decomposeMatrix(m1)
    const lerp = (a, b) => a + (b - a)*t
    return _recomposeMatrix({
        tx:       lerp(d0.tx,       d1.tx),
        ty:       lerp(d0.ty,       d1.ty),
        scaleX:   lerp(d0.scaleX,   d1.scaleX),
        scaleY:   lerp(d0.scaleY,   d1.scaleY),
        rotation: _lerpAngle(d0.rotation, d1.rotation, t),
    })
}

// Cubic bezier on 1-D control points (for CustomEase y given param u)
function _cubicBezier(p0, p1, p2, p3, u) {
    const mu = 1 - u
    return mu*mu*mu*p0 + 3*mu*mu*u*p1 + 3*mu*u*u*p2 + u*u*u*p3
}

// Build eased-t function from a DOMFrame's <tweens> / <CustomEase> element.
// Returns null if no custom ease is present (caller uses raw linear t).
function _buildEaseFn(frameElem) {
    const tweens = childByLocalName(frameElem, 'tweens')
    if (!tweens) return null
    const ce = childByLocalName(tweens, 'CustomEase')
    if (!ce) return null
    const pts = Array.from(ce.children).map(pt => ({
        x: parseFloat(pt.getAttribute('x') ?? '0'),
        y: parseFloat(pt.getAttribute('y') ?? '0'),
    }))
    if (pts.length < 4) return null
    return (t) => {
        // Binary-search for bezier parameter u whose x ≈ t, then return y(u).
        let lo = 0, hi = 1
        for (let i = 0; i < 20; i++) {
            const mid = (lo + hi) / 2
            if (_cubicBezier(pts[0].x, pts[1].x, pts[2].x, pts[3].x, mid) < t) lo = mid
            else hi = mid
        }
        const u = (lo + hi) / 2
        return _cubicBezier(pts[0].y, pts[1].y, pts[2].y, pts[3].y, u)
    }
}

// ── Edge parsing ───────────────────────────────────────────────────────────

function decodeHex(tok) {
    const s = tok.slice(1)
    const dot = s.indexOf('.')
    const ih = dot < 0 ? s : s.slice(0, dot)
    const fh = dot < 0 ? '0' : s.slice(dot + 1)
    let v = parseInt(ih, 16)
    if (v >= 0x800000) v -= 0x1000000
    return v + parseInt(fh, 16) / 256.0
}

const TOK_RE = /[!|[]|S\d+|#[0-9A-Fa-f]+(?:\.[0-9A-Fa-f]+)?|[-+]?\d+(?:\.\d+)?/g

function parseEdgeStr(s) {
    const tokens = s.match(TOK_RE) || []
    const cmds   = []
    let i = 0

    function num() {
        const tok = tokens[i++]
        const raw = tok.startsWith('#') ? decodeHex(tok) : parseFloat(tok)
        return raw / 20.0
    }

    while (i < tokens.length) {
        const tok = tokens[i++]
        if      (tok === '!') { const x = num(), y = num(); cmds.push({ type: 'M', x, y }) }
        else if (tok === '|') { const x = num(), y = num(); cmds.push({ type: 'L', x, y }) }
        else if (tok === '[') {
            const cx = num(), cy = num(), x = num(), y = num()
            cmds.push({ type: 'Q', cx, cy, x, y })
        }
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

// ── Fill style ─────────────────────────────────────────────────────────────
// Returns a fill descriptor:
//   { type: 'solid', color: [r,g,b,a] }
//   { type: 'linear'|'radial', stops: [{offset, color}], matrix: [a,b,c,d,tx,ty] }
// The matrix maps gradient space → shape local space (same convention as Flash / FLA-RE).

function hexColorToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    return [r, g, b, alpha]
}

function getFill(shapeElem, idx) {
    for (const fs of shapeElem.getElementsByTagNameNS(XFL_NS, 'FillStyle')) {
        if (fs.getAttribute('index') !== String(idx)) continue

        const sc = childByLocalName(fs, 'SolidColor')
        if (sc) {
            const color = sc.getAttribute('color') ?? '#000000'
            const alpha = parseFloat(sc.getAttribute('alpha') ?? '1')
            return { type: 'solid', color: hexColorToRgba(color, alpha) }
        }

        for (const [tag, fillType] of [['LinearGradient', 'linear'], ['RadialGradient', 'radial']]) {
            const grad = childByLocalName(fs, tag)
            if (!grad) continue

            const matrix = readMatrix(grad)   // gradient space → shape local (pixels)
            const stops  = []
            for (const entry of childrenByLocalName(grad, 'GradientEntry')) {
                const offset = parseFloat(entry.getAttribute('ratio') ?? '0')  // 0.0 – 1.0
                const color  = entry.getAttribute('color') ?? '#000000'
                const alpha  = parseFloat(entry.getAttribute('alpha') ?? '1')
                stops.push({ offset, color: hexColorToRgba(color, alpha) })
            }

            return { type: fillType, stops, matrix }
        }
    }
    return { type: 'solid', color: [0, 0, 0, 1] }
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
// Fills:   Map<fillIdx, { fill, segs }>   — fill descriptor + segments in worldMat space
// Strokes: Map<strokeIdx, { color, width, segs }>

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
            if (!fillMap.has(idx)) {
                const fill = getFill(shapeElem, idx)
                // Compose gradient matrix with worldMat so it lives in the same
                // coordinate space as the tessellated vertices.
                if (fill.type !== 'solid' && !isIdentity(worldMat)) {
                    fill.matrix = composeMat(worldMat, fill.matrix)
                }
                fillMap.set(idx, { fill, segs: [] })
            }
            for (const s of segs) fillMap.get(idx).segs.push(applyMatToSeg(worldMat, s))
        }
        if (f1s) {
            const idx = parseInt(f1s)
            if (!fillMap.has(idx)) {
                const fill = getFill(shapeElem, idx)
                if (fill.type !== 'solid' && !isIdentity(worldMat)) {
                    fill.matrix = composeMat(worldMat, fill.matrix)
                }
                fillMap.set(idx, { fill, segs: [] })
            }
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

// ── Active frame ────────────────────────────────────────────────────────────

function activeFrame(layerElem, frameNum) {
    const framesElem = childByLocalName(layerElem, 'frames')
    if (!framesElem) return null
    let best = null
    for (const f of framesElem.children) {
        if (f.localName !== 'DOMFrame') continue
        const idx = parseInt(f.getAttribute('index') ?? '0')
        const dur = parseInt(f.getAttribute('duration') ?? '1')
        if (idx <= frameNum && frameNum < idx + dur) return f
        if (idx <= frameNum) best = f
    }
    return best
}

// Returns the DOMFrame immediately following currentFrame in the same layer.
function nextKeyframe(layerElem, currentFrame) {
    const framesElem = childByLocalName(layerElem, 'frames')
    if (!framesElem) return null
    const curIdx = parseInt(currentFrame.getAttribute('index') ?? '0')
    for (const f of framesElem.children) {
        if (f.localName !== 'DOMFrame') continue
        if (parseInt(f.getAttribute('index') ?? '0') > curIdx) return f
    }
    return null
}

// Total frame count for a parsed symbol document (cached by doc object identity).
const _frameCountCache = new WeakMap()
function _getDocFrameCount(doc) {
    if (_frameCountCache.has(doc)) return _frameCountCache.get(doc)
    const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
    let max = 1
    if (layersElem) {
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
    }
    _frameCountCache.set(doc, max)
    return max
}

// ── Group traversal (direct geometry only) ────────────────────────────────

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
            for (const { fill, segs }         of fillMap.values())   if (segs.length) regions.push({ type: 'fill',   fill, segs })
            for (const { color, width, segs } of strokeMap.values()) if (segs.length) regions.push({ type: 'stroke', color, width, segs })
        } else if (ln === 'DOMGroup') {
            collectGroupDirect(child, effMat, regions)
        }
    }
}

// ── Direct-geometry collector ──────────────────────────────────────────────
// Returns an array of render groups preserving mask layer relationships.
//
// Each group is one of:
//   { type: 'plain',  regions: [...] }
//   { type: 'masked', maskRegions: [...], contentRegions: [...] }
//
// Groups are in back-to-front (painter's) order.
// Mask layer relationship is determined via parentLayerIndex (same as FLA-RE).

function collectDirectRegions(doc, frameNum, symbolMap) {
    const regions    = []
    const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
    if (!layersElem) return []

    const symName  = doc.documentElement?.getAttribute('name') ?? '?'
    const allLayers = Array.from(layersElem.children)

    // Build mask group mappings — mirrors FLA-RE's mask_groups / consumed sets.
    // maskGroups: maskLayerIndex → [maskedLayerIndex, ...] (front-to-back order)
    const maskGroups = new Map()
    const consumed   = new Set()
    for (let i = 0; i < allLayers.length; i++) {
        const ps = allLayers[i].getAttribute('parentLayerIndex')
        if (ps === null) continue
        const pi = parseInt(ps)
        if (allLayers[pi]?.getAttribute('layerType') === 'mask') {
            if (!maskGroups.has(pi)) maskGroups.set(pi, [])
            maskGroups.get(pi).push(i)
            consumed.add(i)
        }
    }

    // Recursively flatten a symbol's geometry into parentMat's coordinate space.
    // Used for DOMSymbolInstances that appear directly on mask/content layers —
    // these must contribute geometry inline rather than as hierarchy children.
    function collectSymFlat(instName, parentMat, firstFrame, out, visited = new Set()) {
        if (!symbolMap || visited.has(instName)) return
        visited = new Set(visited)
        visited.add(instName)
        const symDoc = symbolMap.get(instName)
        if (!symDoc) return
        const layersEl = symDoc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
        if (!layersEl) return
        for (const layer of Array.from(layersEl.children).reverse()) {
            const ltype = layer.getAttribute('layerType') ?? 'normal'
            if (ltype === 'guide' || ltype === 'folder' || ltype === 'mask') continue
            const frame = activeFrame(layer, firstFrame)
            if (!frame) continue
            const elements = childByLocalName(frame, 'elements')
            if (!elements) continue
            for (const elem of elements.children) {
                const ln = elem.localName
                if (ln === 'DOMShape') {
                    const shapeMat = readMatrix(elem)
                    const effMat   = isIdentity(parentMat) ? shapeMat
                        : isIdentity(shapeMat)  ? parentMat
                        : composeMat(parentMat, shapeMat)
                    const { fillMap, strokeMap } = shapeToRegions(elem, effMat)
                    for (const { fill, segs }         of fillMap.values())   if (segs.length) out.push({ type: 'fill',   fill, segs })
                    for (const { color, width, segs } of strokeMap.values()) if (segs.length) out.push({ type: 'stroke', color, width, segs })
                } else if (ln === 'DOMGroup') {
                    collectGroupDirect(elem, parentMat, out)
                } else if (ln === 'DOMSymbolInstance') {
                    const childName  = elem.getAttribute('libraryItemName')
                    if (!childName) continue
                    const childMat   = readMatrix(elem)
                    const childFirst = parseInt(elem.getAttribute('firstFrame') ?? '0')
                    const finalMat   = isIdentity(parentMat) ? childMat : composeMat(parentMat, childMat)
                    collectSymFlat(childName, finalMat, childFirst, out, visited)
                }
            }
        }
    }

    // Collect all direct regions from a single layer frame.
    // flattenInstances=true: DOMSymbolInstances are recursively flattened into
    //   geometry — used for mask layers whose shapes may be library symbols.
    // flattenInstances=false (default): symbol instances are skipped because
    //   they become separate hierarchy children and must not be double-rendered.
    function layerRegions(layer, flattenInstances = false) {
        const frame = activeFrame(layer, frameNum)
        if (!frame) return []
        const elements = childByLocalName(frame, 'elements')
        if (!elements) return []
        const out = []
        for (const elem of elements.children) {
            const ln = elem.localName
            if (ln === 'DOMShape') {
                const shapeMat = readMatrix(elem)
                const { fillMap, strokeMap } = shapeToRegions(elem, shapeMat)
                for (const { fill, segs }         of fillMap.values())   if (segs.length) out.push({ type: 'fill',   fill, segs })
                for (const { color, width, segs } of strokeMap.values()) if (segs.length) out.push({ type: 'stroke', color, width, segs })
            } else if (ln === 'DOMGroup') {
                collectGroupDirect(elem, IDENTITY, out)
            } else if (ln === 'DOMSymbolInstance' && flattenInstances) {
                const instName  = elem.getAttribute('libraryItemName')
                if (!instName) continue
                const instMat   = readMatrix(elem)
                const instFirst = parseInt(elem.getAttribute('firstFrame') ?? '0')
                collectSymFlat(instName, instMat, instFirst, out)
            }
        }
        return out
    }

    const groups     = []
    let plainRegions = []
    // Tracks the frontmost (lowest) layer index that contributed to the current
    // plain batch — used to assign an order value comparable to child instance orders.
    let plainFrontI  = -1

    // Iterate layers back-to-front (reversed from Flash's front-to-back XML order).
    for (let i = allLayers.length - 1; i >= 0; i--) {
        const layer = allLayers[i]
        const ltype = layer.getAttribute('layerType') ?? 'normal'
        if (ltype === 'guide' || ltype === 'folder') continue
        if (consumed.has(i)) continue   // handled inside its mask group below

        if (ltype === 'mask' && maskGroups.has(i)) {
            // Finalize any accumulated plain regions before the mask group.
            if (plainRegions.length) {
                groups.push({ type: 'plain', regions: plainRegions, order: allLayers.length - plainFrontI })
                plainRegions = []
                plainFrontI  = -1
            }

            const maskRegions    = layerRegions(layer, true)  // flatten symbol instances into mask geometry
            const contentRegions = []
            // Masked layers are front-to-back in maskGroups; reverse for back-to-front rendering.
            for (const mi of [...maskGroups.get(i)].reverse()) {
                contentRegions.push(...layerRegions(allLayers[mi]))
            }

            const maskName    = allLayers[i].getAttribute('name') ?? i
            const contentIdxs = maskGroups.get(i).join(',')
            if (maskRegions.length) {
                // Keep masked group even if contentRegions is empty — hierarchy children
                // tagged with maskedByLayerIdx will be drawn inside this mask at render time.
                console.log(`[mask] ${symName} — layer "${maskName}" (${i}) → ${maskRegions.length} mask regions, ${contentRegions.length} content regions  [content layers: ${contentIdxs}]`)
                groups.push({ type: 'masked', maskRegions, contentRegions, maskLayerIdx: i, order: allLayers.length - i })
            } else {
                console.warn(`[mask] ${symName} — layer "${maskName}" (${i}) DEGENERATE (no mask geometry): contentR=${contentRegions.length} — rendering unmasked  [content layers: ${contentIdxs}]`)
                plainRegions.push(...contentRegions)
                if (contentRegions.length) plainFrontI = i
            }
        } else {
            const regs = layerRegions(layer)
            if (regs.length) {
                plainRegions.push(...regs)
                plainFrontI = i   // loop decreases → this stays at the minimum (frontmost) i
            }
        }
    }

    if (plainRegions.length) groups.push({ type: 'plain', regions: plainRegions, order: allLayers.length - plainFrontI })
    return groups
}

// ── Legacy flat traversal (unused by hierarchy importer, kept for completeness) ──

function shapeToFillRegions(shapeElem, worldMat, fillMap) {
    return shapeToRegions(shapeElem, worldMat, fillMap ?? new Map(), new Map()).fillMap
}

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
            for (const { fill, segs } of fillMap.values()) {
                if (segs.length) out.push({ fill, segs })
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

function collectSymbolRegions(name, symbolMap, frameNum, mat, visited, out) {
    if (visited.has(name)) return
    visited.add(name)

    const doc = symbolMap.get(name)
    if (!doc) return

    const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
    if (!layersElem) return

    for (const layer of Array.from(layersElem.children).reverse()) {
        const ltype = layer.getAttribute('layerType') ?? 'normal'
        if (ltype === 'guide' || ltype === 'folder' || ltype === 'mask') continue

        const frame = activeFrame(layer, frameNum)
        if (!frame) continue
        const elements = childByLocalName(frame, 'elements')
        if (!elements) continue

        for (const elem of elements.children) {
            const ln = elem.localName
            if (ln === 'DOMShape') {
                const shapeMat  = readMatrix(elem)
                const effectMat = isIdentity(shapeMat) ? mat : composeMat(mat, shapeMat)
                const fillMap   = new Map()
                shapeToFillRegions(elem, effectMat, fillMap)
                for (const { fill, segs } of fillMap.values()) {
                    if (segs.length) out.push({ fill, segs })
                }
            } else if (ln === 'DOMGroup') {
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

function composeFillRegions(rootName, symbolMap, frameNum = 0) {
    const out = []
    collectSymbolRegions(rootName, symbolMap, frameNum, IDENTITY, new Set(), out)
    return out
}

// ── Public API ─────────────────────────────────────────────────────────────

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

// ── Hierarchy builder ──────────────────────────────────────────────────────

let _hierarchyIdCounter = 0

function parseHierarchy(rootName, symbolMap, frameNum = 0) {
    const symbolGeometry = new Map()

    function ensureGeometry(name, fn) {
        const key = `${name}@@${fn}`
        if (symbolGeometry.has(key)) return
        const doc = symbolMap.get(name)
        symbolGeometry.set(key, doc ? collectDirectRegions(doc, fn, symbolMap) : [])
    }

    function buildNode(symbolName, rawMatrix, order, label, visited, fn, maskedByLayerIdx = null) {
        ensureGeometry(symbolName, fn)
        if (visited.has(symbolName)) return { symbolName, frameNum: fn, rawMatrix, order, label, children: [], maskedByLayerIdx }
        visited = new Set(visited)
        visited.add(symbolName)

        const doc = symbolMap.get(symbolName)
        if (!doc) return { symbolName, rawMatrix, order, label, children: [], maskedByLayerIdx }

        const layersElem = doc.getElementsByTagNameNS(XFL_NS, 'layers')[0]
        if (!layersElem) return { symbolName, rawMatrix, order, label, children: [], maskedByLayerIdx }

        const allLayers = Array.from(layersElem.children)
        const children  = []

        // Build content-layer → mask-layer-index mapping (mirrors collectDirectRegions).
        const maskGroupOf = new Map()  // contentLayerIdx → maskLayerIdx
        for (let i = 0; i < allLayers.length; i++) {
            const ps = allLayers[i].getAttribute('parentLayerIndex')
            if (ps === null) continue
            const pi = parseInt(ps)
            if (allLayers[pi]?.getAttribute('layerType') === 'mask') maskGroupOf.set(i, pi)
        }

        // frameStart: the DOMFrame's own index attribute (when this keyframe begins).
        // tweenNextElems: array of DOMSymbolInstances from the next keyframe (for matrix lerp), or null.
        // tweenT: interpolation factor [0,1] with easing applied.
        function collectInstances(elems, groupAccMat, renderOrder, layerMaskIdx, frameStart, tweenNextInsts, tweenT) {
            let instIdx = 0
            for (const elem of elems) {
                if (elem.localName === 'DOMSymbolInstance') {
                    const childName = elem.getAttribute('libraryItemName')
                    if (!childName) continue

                    // Matrix — interpolate if inside a motion tween span.
                    let iMat = readMatrix(elem)
                    if (tweenNextInsts && tweenT > 0) {
                        const peer = tweenNextInsts[instIdx]
                        if (peer) iMat = _lerpMatrix(iMat, readMatrix(peer), tweenT)
                    }
                    instIdx++

                    const finalMat = isIdentity(groupAccMat) ? iMat : composeMat(groupAccMat, iMat)

                    // Child frame — respects graphic symbol loop mode.
                    const loop       = elem.getAttribute('loop') ?? 'loop'
                    const firstFrame = parseInt(elem.getAttribute('firstFrame') ?? '0')
                    let childFn
                    if (loop === 'single frame') {
                        childFn = firstFrame
                    } else {
                        const elapsed   = fn - frameStart
                        const raw       = firstFrame + elapsed
                        const childDoc  = symbolMap.get(childName)
                        const total     = childDoc ? _getDocFrameCount(childDoc) : 1
                        if (loop === 'loop') {
                            childFn = ((raw % total) + total) % total
                        } else {
                            // 'play once' — clamp at last frame
                            childFn = Math.min(raw, total - 1)
                        }
                    }

                    const lbl   = childName.split('/').pop().replace(/^~/, '')
                    const child = buildNode(childName, finalMat, renderOrder, lbl, visited, childFn, layerMaskIdx)
                    // Expose placement metadata so the importer can build tracks.
                    child.loop       = loop
                    child.firstFrame = firstFrame
                    child.frameStart = frameStart
                    child.elemIdx    = instIdx - 1   // 0-based index within layer elements
                    children.push(child)
                } else if (elem.localName === 'DOMGroup') {
                    const gMat    = readMatrix(elem)
                    const newAcc  = isIdentity(gMat) ? groupAccMat : composeMat(groupAccMat, gMat)
                    const members = childByLocalName(elem, 'members')
                    if (members) collectInstances(Array.from(members.children), newAcc, renderOrder, layerMaskIdx, frameStart, tweenNextInsts, tweenT)
                }
            }
        }

        for (let i = 0; i < allLayers.length; i++) {
            const layer = allLayers[i]
            const ltype = layer.getAttribute('layerType') ?? 'normal'
            if (ltype === 'guide' || ltype === 'folder' || ltype === 'mask') continue
            const frame = activeFrame(layer, fn)
            if (!frame) continue
            const elements = childByLocalName(frame, 'elements')
            if (!elements) continue

            const renderOrder  = allLayers.length - i
            const layerMaskIdx = maskGroupOf.get(i) ?? null
            const frameStart   = parseInt(frame.getAttribute('index') ?? '0')

            // Motion tween: collect next-keyframe instances and compute eased t.
            let tweenNextInsts = null, tweenT = 0
            if (frame.getAttribute('tweenType') === 'motion') {
                const nextFrame = nextKeyframe(layer, frame)
                if (nextFrame) {
                    const nextIdx   = parseInt(nextFrame.getAttribute('index') ?? '0')
                    const rawT      = (fn - frameStart) / (nextIdx - frameStart)
                    const easeFn    = _buildEaseFn(frame)
                    tweenT          = Math.max(0, Math.min(1, easeFn ? easeFn(rawT) : rawT))
                    const nextElems = childByLocalName(nextFrame, 'elements')
                    tweenNextInsts  = nextElems
                        ? Array.from(nextElems.children).filter(e => e.localName === 'DOMSymbolInstance')
                        : []
                }
            }

            collectInstances(Array.from(elements.children), IDENTITY, renderOrder, layerMaskIdx, frameStart, tweenNextInsts, tweenT)
        }

        children.sort((a, b) => a.order - b.order)
        return { symbolName, frameNum: fn, rawMatrix, order, label, children, maskedByLayerIdx }
    }

    const rootLabel = rootName.split('/').pop().replace(/^~/, '')
    const rootNode  = buildNode(rootName, IDENTITY, 0, rootLabel, new Set(), frameNum)
    return { symbolGeometry, rootNode }
}

export { buildSymbolMap, composeFillRegions, parseHierarchy, collectDirectRegions }

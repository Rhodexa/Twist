// Tessellate FLA fill regions into triangle meshes for WebGL.
// Pipeline: segments → closed contours (chain-stitched) → earcut triangulation.
// Bezier curves are subdivided adaptively based on geometric flatness.

import earcut from '../../node_modules/earcut/src/earcut.js'

// Flatness thresholds for adaptive bezier subdivision (world-space pixels).
// A bezier is split only when its control-point deviates from the chord midpoint
// by more than this value. Smaller = smoother curves = more vertices.
export const QUALITY_VIEWPORT = 0.5   // ~half-pixel, fast interactive display
export const QUALITY_RENDER   = 0.15  // ~quarter-pixel, final / export quality

const STITCH_EPS  = 0.05  // px — endpoint matching tolerance
const MAX_STOPS   = 16    // Flash gradient stop limit
const MITER_LIMIT = 4.0
const CAP_STEPS   = 8

// ── Bezier subdivision ─────────────────────────────────────────────────────
// Recursive midpoint halving. Only splits when the control-point distance from
// the chord midpoint exceeds `f2` (flatness², avoids a sqrt). Depth cap of 8
// (max 256 output points per bezier) prevents blowup on degenerate inputs.
// Flash artwork is full of near-straight beziers — the common path emits a
// single endpoint immediately, making this far cheaper than fixed-step loops.

function _subdiv(x0, y0, cx, cy, x1, y1, f2, out, d) {
    const mx = (x0 + x1) * 0.5
    const my = (y0 + y1) * 0.5
    const dx = cx - mx
    const dy = cy - my
    if (d < 8 && dx * dx + dy * dy > f2) {
        const lx = (x0 + cx) * 0.5, ly = (y0 + cy) * 0.5
        const rx = (cx + x1) * 0.5, ry = (cy + y1) * 0.5
        const hx = (lx + rx) * 0.5, hy = (ly + ry) * 0.5
        _subdiv(x0, y0, lx, ly, hx, hy, f2, out, d + 1)
        _subdiv(hx, hy, rx, ry, x1, y1, f2, out, d + 1)
    } else {
        out.push(x1, y1)
    }
}

// ── Contour stitching ──────────────────────────────────────────────────────

// Numeric key from (x, y) — avoids string allocation on every endpoint lookup.
// KSCALE = 1 / STITCH_EPS = 20; coordinates are rounded to eps-sized buckets.
// KCOL must exceed 2 × max(|round(coord × KSCALE)|).
// Flash world coords typically fit in ±50 000 units → max ix ≈ ±1 000 000.
// Using a prime KCOL prevents collisions: ix1*KCOL+iy1 ≠ ix2*KCOL+iy2 when
// |iy| < KCOL/2, which holds since 1 000 000 < 2 000 003 / 2 = 1 000 001.
const _KSCALE  = 1 / STITCH_EPS          // 20
const _KCOL    = 2_000_003               // prime, main stitch eps
const _KSCALE2 = _KSCALE * 0.5          // 10  (= 1 / mergeEps)
const _KCOL2   = 1_000_003              // prime, merge eps (2× stitch eps)

function _key(x, y) {
    return Math.round(x * _KSCALE) * _KCOL + Math.round(y * _KSCALE)
}
function _key2(x, y) {
    return Math.round(x * _KSCALE2) * _KCOL2 + Math.round(y * _KSCALE2)
}

// Convert a chain of seg indices to a flat [x,y,...] point array.
function _chainToPoints(chain, segs, f2) {
    const pts = []
    for (let k = 0; k < chain.length; k++) {
        const seg = segs[chain[k]]
        if (k === 0) pts.push(seg[0].x, seg[0].y)
        for (let j = 1; j < seg.length; j++) {
            const c  = seg[j]
            const px = pts[pts.length - 2]
            const py = pts[pts.length - 1]
            if (c.type === 'L') {
                pts.push(c.x, c.y)
            } else {
                _subdiv(px, py, c.cx, c.cy, c.x, c.y, f2, pts, 0)
            }
        }
    }
    return pts
}

function stitchContours(segs, f2) {
    if (!segs.length) return []

    // Build start-point index: numeric key → [seg indices].
    const startIdx = new Map()
    for (let i = 0; i < segs.length; i++) {
        const s0 = segs[i][0]
        const k  = _key(s0.x, s0.y)
        let bucket = startIdx.get(k)
        if (!bucket) { bucket = []; startIdx.set(k, bucket) }
        bucket.push(i)
    }

    // Uint8Array is cache-friendly and avoids Set object overhead.
    const visited = new Uint8Array(segs.length)
    const chains  = []

    // Phase 1: greedy forward chain building (O(n) average via hash map).
    for (let seed = 0; seed < segs.length; seed++) {
        if (visited[seed]) continue
        const chain = [seed]
        visited[seed] = 1

        for (;;) {
            const lastSeg = segs[chain[chain.length - 1]]
            const lc      = lastSeg[lastSeg.length - 1]
            const ex = lc.x, ey = lc.y

            const fstSeg = segs[chain[0]]
            const sx = fstSeg[0].x, sy = fstSeg[0].y
            if (chain.length > 1 &&
                Math.abs(ex - sx) <= STITCH_EPS &&
                Math.abs(ey - sy) <= STITCH_EPS) break

            const bucket = startIdx.get(_key(ex, ey))
            if (!bucket) break
            let next = -1
            for (let b = 0; b < bucket.length; b++) {
                if (!visited[bucket[b]]) { next = bucket[b]; break }
            }
            if (next === -1) break
            visited[next] = 1
            chain.push(next)
        }
        chains.push(chain)
    }

    // Phase 2: merge open chains using an end-point lookup map.
    // Each merge step is O(1) — no nested loop scanning.
    const mergeEps = STITCH_EPS * 2
    const endMap   = new Map()  // endKey → chain index

    for (let i = 0; i < chains.length; i++) {
        const ch = chains[i]
        const ls = segs[ch[ch.length - 1]]
        const lc = ls[ls.length - 1]
        const fs = segs[ch[0]]
        if (Math.abs(lc.x - fs[0].x) > mergeEps || Math.abs(lc.y - fs[0].y) > mergeEps)
            endMap.set(_key2(lc.x, lc.y), i)
    }

    let changed = true
    while (changed) {
        changed = false
        for (let i = 0; i < chains.length; i++) {
            if (!chains[i].length) continue
            const chi  = chains[i]
            const fsi  = segs[chi[0]]
            const sx   = fsi[0].x, sy = fsi[0].y
            const lsi  = segs[chi[chi.length - 1]]
            const lci  = lsi[lsi.length - 1]
            if (Math.abs(lci.x - sx) <= mergeEps && Math.abs(lci.y - sy) <= mergeEps) continue

            const j = endMap.get(_key2(sx, sy))
            if (j === undefined || j === i || !chains[j].length) continue

            const chj = chains[j]
            const lsj = segs[chj[chj.length - 1]]
            const lcj = lsj[lsj.length - 1]

            endMap.delete(_key2(lcj.x, lcj.y))  // j's old end
            endMap.delete(_key2(lci.x, lci.y))  // i's end (being absorbed)

            for (let k = 0; k < chi.length; k++) chj.push(chi[k])
            chains[i] = []

            // j's new end is i's old end — re-register if still open.
            const fsj = segs[chj[0]]
            if (Math.abs(lci.x - fsj[0].x) > mergeEps || Math.abs(lci.y - fsj[0].y) > mergeEps)
                endMap.set(_key2(lci.x, lci.y), j)

            changed = true
        }
    }

    return chains
        .filter(c => c.length > 0)
        .map(chain => _chainToPoints(chain, segs, f2))
}

// ── Earcut tessellation ────────────────────────────────────────────────────

// Shoelace signed area. Positive = CW in screen space (Y-down) = outer.
function signedArea(pts) {
    let a = 0
    const n = pts.length / 2
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        a += pts[i*2] * pts[j*2+1] - pts[j*2] * pts[i*2+1]
    }
    return a / 2
}

// Ray-cast point-in-polygon on a flat [x,y,...] array.
function pointInPolygon(px, py, pts) {
    let inside = false
    const n = pts.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = pts[i*2], yi = pts[i*2+1]
        const xj = pts[j*2], yj = pts[j*2+1]
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            inside = !inside
    }
    return inside
}

function tessellateContours(contours) {
    if (!contours.length) return null

    if (contours.length === 1) {
        if (contours[0].length < 6) return null
        const idx = earcut(contours[0], null, 2)
        if (!idx.length) return null
        const tris = new Float32Array(idx.length * 2)
        for (let i = 0; i < idx.length; i++) {
            tris[i*2]   = contours[0][idx[i]*2]
            tris[i*2+1] = contours[0][idx[i]*2+1]
        }
        return tris
    }

    // Multiple contours: group into (outer + holes) clusters, then earcut each.
    const byArea = contours
        .filter(c => c.length >= 6)
        .map(pts => ({ pts, absArea: Math.abs(signedArea(pts)) }))
        .sort((a, b) => b.absArea - a.absArea)

    const allTris = []
    const used    = new Uint8Array(byArea.length)

    for (let i = 0; i < byArea.length; i++) {
        if (used[i]) continue
        used[i] = 1
        const outerPts = byArea[i].pts

        const holes = []
        for (let j = i + 1; j < byArea.length; j++) {
            if (used[j]) continue
            if (pointInPolygon(byArea[j].pts[0], byArea[j].pts[1], outerPts)) {
                holes.push(byArea[j].pts)
                used[j] = 1
            }
        }

        const verts      = outerPts.slice()
        const holeStarts = []
        for (const h of holes) {
            holeStarts.push(verts.length / 2)
            for (let k = 0; k < h.length; k++) verts.push(h[k])
        }

        const idx = earcut(verts, holeStarts.length ? holeStarts : null, 2)
        for (const k of idx) allTris.push(verts[k*2], verts[k*2+1])
    }

    return allTris.length ? new Float32Array(allTris) : null
}

// ── Gradient helpers ───────────────────────────────────────────────────────

// Invert a 2D affine matrix [a,b,c,d,tx,ty]. Returns null if singular.
function invertMat6([a, b, c, d, tx, ty]) {
    const det = a*d - b*c
    if (Math.abs(det) < 1e-10) return null
    return [
         d / det,              -b / det,
        -c / det,               a / det,
        (c*ty - d*tx) / det,  (b*tx - a*ty) / det,
    ]
}

// Convert [a,b,c,d,tx,ty] to a column-major GL mat3 Float32Array.
function mat6ToGLMat3([a, b, c, d, tx, ty]) {
    return new Float32Array([a, b, 0,  c, d, 0,  tx, ty, 1])
}

// Pack gradient stops into pre-sized GPU arrays (MAX_STOPS slots).
function packGradientStops(stops) {
    const count      = Math.min(stops.length, MAX_STOPS)
    const offsets    = new Float32Array(MAX_STOPS)
    const colors     = new Float32Array(MAX_STOPS * 4)
    for (let i = 0; i < count; i++) {
        offsets[i]    = stops[i].offset
        colors[i*4]   = stops[i].color[0]
        colors[i*4+1] = stops[i].color[1]
        colors[i*4+2] = stops[i].color[2]
        colors[i*4+3] = stops[i].color[3]
    }
    return { count, offsets, colors }
}

// ── Tessellate regions ─────────────────────────────────────────────────────

// Input:  [{ type:'fill'|'stroke', fill?:{type,color?,stops?,matrix?}, color?, segs, width? }]
// Output: [{ fillType, color?, stopCount?, stopOffsets?, stopColors?, gradientMatInv?, vertices }]
function tessellateAll(regions, flatness = QUALITY_RENDER) {
    const f2     = flatness * flatness
    const meshes = []
    for (const r of regions) {
        let verts
        if (r.type === 'fill') {
            const contours = stitchContours(r.segs, f2)
            verts = contours.length ? tessellateContours(contours) : null
        } else {
            verts = tessellateStroke(r.segs, r.width, f2)
        }
        if (!verts || verts.length < 6) continue

        if (r.type === 'stroke') {
            meshes.push({ fillType: 0, color: r.color, vertices: verts })
        } else if (r.fill?.type === 'solid') {
            meshes.push({ fillType: 0, color: r.fill.color, vertices: verts })
        } else if (r.fill?.type === 'linear' || r.fill?.type === 'radial') {
            const fillType   = r.fill.type === 'linear' ? 1 : 2
            const invMat6    = invertMat6(r.fill.matrix)
            const glMat      = invMat6 ? mat6ToGLMat3(invMat6) : mat6ToGLMat3([1,0,0,1,0,0])
            const { count, offsets, colors } = packGradientStops(r.fill.stops)
            meshes.push({
                fillType,
                gradientMatInv: glMat,
                stopCount:      count,
                stopOffsets:    offsets,
                stopColors:     colors,
                vertices:       verts,
            })
        }
    }
    return meshes
}

// Tessellate an array of render groups (as produced by collectDirectRegions).
// Input:  [{ type:'plain'|'masked', regions?, maskRegions?, contentRegions? }]
// Output: [{ type:'plain', meshes } | { type:'masked', maskMeshes, contentMeshes }]
function tessellateGroups(groups, flatness = QUALITY_RENDER) {
    const result = []
    for (const g of groups) {
        if (g.type === 'plain') {
            const meshes = tessellateAll(g.regions, flatness)
            if (meshes.length) result.push({ type: 'plain', meshes, order: g.order ?? 0 })
        } else {
            const maskMeshes    = tessellateAll(g.maskRegions, flatness)
            const contentMeshes = tessellateAll(g.contentRegions, flatness)
            if (maskMeshes.length)  // keep even when contentMeshes is empty — hierarchy children provide content
                result.push({ type: 'masked', maskMeshes, contentMeshes, maskLayerIdx: g.maskLayerIdx, order: g.order ?? 0 })
        }
    }
    return result
}

// Edge overlay: LINE_LOOP contours from fill regions only (debug wireframe).
// Input:  flat regions array [{ type, fill?, color?, segs, ... }]
// Output: [{ color: [r,g,b,a], vertices: Float32Array }]
function extractEdgeContours(regions) {
    const f2     = QUALITY_VIEWPORT * QUALITY_VIEWPORT
    const result = []
    for (const r of regions) {
        if (r.type !== 'fill') continue
        const color = r.fill?.type === 'solid'
            ? r.fill.color
            : (r.fill?.stops?.[0]?.color ?? [0.5, 0.5, 0.5, 1.0])
        const contours = stitchContours(r.segs, f2)
        for (const pts of contours) {
            if (pts.length >= 4) result.push({ color, vertices: new Float32Array(pts) })
        }
    }
    return result
}

// ── Stroke tessellation ────────────────────────────────────────────────────

function addRoundCap(tris, cx, cy, nx, ny, capDx, capDy, halfWidth) {
    for (let k = 0; k < CAP_STEPS; k++) {
        const a0 = Math.PI *  k      / CAP_STEPS
        const a1 = Math.PI * (k + 1) / CAP_STEPS
        tris.push(
            cx, cy,
            cx + (nx * Math.cos(a0) + capDx * Math.sin(a0)) * halfWidth,
            cy + (ny * Math.cos(a0) + capDy * Math.sin(a0)) * halfWidth,
            cx + (nx * Math.cos(a1) + capDx * Math.sin(a1)) * halfWidth,
            cy + (ny * Math.cos(a1) + capDy * Math.sin(a1)) * halfWidth,
        )
    }
}

function expandPolyline(pts, halfWidth, closed = false) {
    const n = pts.length / 2
    if (n < 2) return []

    const edgeCount = closed ? n : n - 1

    const enx = new Float32Array(edgeCount)
    const eny = new Float32Array(edgeCount)
    for (let i = 0; i < edgeCount; i++) {
        const j  = (i + 1) % n
        const dx = pts[j*2]   - pts[i*2]
        const dy = pts[j*2+1] - pts[i*2+1]
        const len = Math.sqrt(dx*dx + dy*dy)
        if (len > 1e-6) { enx[i] = -dy / len; eny[i] = dx / len }
    }

    const vlx = new Float32Array(n), vly = new Float32Array(n)
    const vrx = new Float32Array(n), vry = new Float32Array(n)

    for (let i = 0; i < n; i++) {
        const px = pts[i*2], py = pts[i*2+1]

        let n1x, n1y, n2x, n2y
        if (closed) {
            const pe = (i - 1 + edgeCount) % edgeCount
            n1x = enx[pe]; n1y = eny[pe]
            n2x = enx[i % edgeCount]; n2y = eny[i % edgeCount]
        } else if (i === 0) {
            n1x = enx[0]; n1y = eny[0]; n2x = enx[0]; n2y = eny[0]
        } else if (i === n - 1) {
            n1x = enx[edgeCount-1]; n1y = eny[edgeCount-1]
            n2x = enx[edgeCount-1]; n2y = eny[edgeCount-1]
        } else {
            n1x = enx[i-1]; n1y = eny[i-1]
            n2x = enx[i];   n2y = eny[i]
        }

        let mx = n1x + n2x, my = n1y + n2y
        const mlen = Math.sqrt(mx*mx + my*my)

        let scale
        if (mlen < 1e-6) {
            mx = n2x; my = n2y; scale = halfWidth
        } else {
            mx /= mlen; my /= mlen
            const cosHalf = mx * n2x + my * n2y
            scale = cosHalf > 1e-4
                ? Math.min(halfWidth / cosHalf, halfWidth * MITER_LIMIT)
                : halfWidth * MITER_LIMIT
        }

        vlx[i] = px + mx * scale;  vly[i] = py + my * scale
        vrx[i] = px - mx * scale;  vry[i] = py - my * scale
    }

    const tris = []

    if (!closed) {
        addRoundCap(tris, pts[0], pts[1], enx[0], eny[0], -eny[0], enx[0], halfWidth)
        const e = edgeCount - 1
        addRoundCap(tris,
            pts[(n-1)*2], pts[(n-1)*2+1],
            enx[e], eny[e],
            eny[e], -enx[e],
            halfWidth)
    }

    for (let i = 0; i < edgeCount; i++) {
        const j = (i + 1) % n
        tris.push(
            vlx[i], vly[i],  vrx[i], vry[i],  vlx[j], vly[j],
            vlx[j], vly[j],  vrx[i], vry[i],  vrx[j], vry[j],
        )
    }
    return tris
}

function isClosedPolyline(pts) {
    const n = pts.length / 2
    if (n < 3) return false
    const dx = pts[0] - pts[(n-1)*2]
    const dy = pts[1] - pts[(n-1)*2+1]
    return dx*dx + dy*dy <= STITCH_EPS * STITCH_EPS * 4
}

function tessellateStroke(segs, widthPx, f2) {
    const hw     = widthPx / 2
    const chains = stitchContours(segs, f2)
    const tris   = []
    for (const pts of chains) {
        const closed = isClosedPolyline(pts)
        for (const v of expandPolyline(pts, hw, closed)) tris.push(v)
    }
    return tris.length ? new Float32Array(tris) : null
}

export { tessellateAll, tessellateGroups, extractEdgeContours }

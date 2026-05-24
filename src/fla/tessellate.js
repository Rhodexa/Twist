// Tessellate FLA fill regions into triangle meshes for WebGL.
// Pipeline: segments → closed contours (chain-stitched) → earcut triangulation.
// Quadratic bezier curves are subdivided into line segments before tessellation.

import earcut from '../../node_modules/earcut/src/earcut.js'

const BEZIER_STEPS = 8   // segments per quadratic bezier curve
const STITCH_EPS   = 0.05 // px — endpoint matching tolerance
const MAX_STOPS    = 16   // Flash gradient stop limit

// ── Bezier subdivision ─────────────────────────────────────────────────────

function subdivideBezier(x0, y0, cx, cy, x1, y1, steps, out) {
    for (let i = 1; i <= steps; i++) {
        const t  = i / steps
        const mt = 1 - t
        out.push(mt*mt*x0 + 2*mt*t*cx + t*t*x1)
        out.push(mt*mt*y0 + 2*mt*t*cy + t*t*y1)
    }
}

// ── Contour stitching ──────────────────────────────────────────────────────
// Port of Python's _segs_to_svg_d, but produces flat [x,y,...] point arrays.

function segStartXY(seg) { return [seg[0].x, seg[0].y] }
function segEndXY(seg) {
    const c = seg[seg.length - 1]
    return c.type === 'Q' ? [c.x, c.y] : [c.x, c.y]
}

function close(ax, ay, bx, by, eps) {
    return Math.abs(ax - bx) <= eps && Math.abs(ay - by) <= eps
}

function stitchKey(x, y, eps) {
    return `${Math.round(x / eps)},${Math.round(y / eps)}`
}

// Convert a chain of segments to a flat [x,y,...] point array, subdividing beziers.
function chainToPoints(chain, segs) {
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
            } else if (c.type === 'Q') {
                subdivideBezier(px, py, c.cx, c.cy, c.x, c.y, BEZIER_STEPS, pts)
            }
        }
    }
    return pts
}

function stitchContours(segs) {
    if (!segs.length) return []

    // Build start-point index: key → [seg indices]
    const startIdx = new Map()
    for (let i = 0; i < segs.length; i++) {
        const k = stitchKey(...segStartXY(segs[i]), STITCH_EPS)
        if (!startIdx.has(k)) startIdx.set(k, [])
        startIdx.get(k).push(i)
    }

    const visited = new Set()
    const chains  = []

    // Phase 1: greedy chain building
    for (let seed = 0; seed < segs.length; seed++) {
        if (visited.has(seed)) continue
        const chain = [seed]
        visited.add(seed)

        while (true) {
            const [ex, ey] = segEndXY(segs[chain[chain.length - 1]])
            const [sx, sy] = segStartXY(segs[chain[0]])
            if (chain.length > 1 && close(ex, ey, sx, sy, STITCH_EPS)) break
            const cands = (startIdx.get(stitchKey(ex, ey, STITCH_EPS)) || [])
                .filter(i => !visited.has(i))
            if (!cands.length) break
            visited.add(cands[0])
            chain.push(cands[0])
        }
        chains.push(chain)
    }

    // Phase 2: merge open chains (handles degenerate gap-patch segments)
    const mergeEps = STITCH_EPS * 2
    for (let pass = 0; pass < chains.length; pass++) {
        let merged = false
        const open = chains.map((ch, i) => i).filter(i => chains[i].length > 0)
        for (const i of open) {
            const chi = chains[i]
            const [eix, eiy] = segEndXY(segs[chi[chi.length - 1]])
            const [six, siy] = segStartXY(segs[chi[0]])
            if (close(eix, eiy, six, siy, mergeEps)) continue  // already closed
            for (const j of open) {
                if (j === i) continue
                const chj = chains[j]
                const [sjx, sjy] = segStartXY(segs[chj[0]])
                if (close(eix, eiy, sjx, sjy, mergeEps)) {
                    chains[i] = [...chi, ...chj]
                    chains[j] = []
                    merged = true
                    break
                }
            }
            if (merged) break
        }
        if (!merged) break
    }

    return chains.filter(c => c.length > 0).map(chain => chainToPoints(chain, segs))
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
    const used    = new Array(byArea.length).fill(false)

    for (let i = 0; i < byArea.length; i++) {
        if (used[i]) continue
        used[i] = true
        const outerPts = byArea[i].pts

        const holes = []
        for (let j = i + 1; j < byArea.length; j++) {
            if (used[j]) continue
            if (pointInPolygon(byArea[j].pts[0], byArea[j].pts[1], outerPts)) {
                holes.push(byArea[j].pts)
                used[j] = true
            }
        }

        const verts      = [...outerPts]
        const holeStarts = []
        for (const h of holes) {
            holeStarts.push(verts.length / 2)
            for (const v of h) verts.push(v)
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
function tessellateAll(regions) {
    const meshes = []
    for (const r of regions) {
        let verts
        if (r.type === 'fill') {
            const contours = stitchContours(r.segs)
            verts = contours.length ? tessellateContours(contours) : null
        } else {
            verts = tessellateStroke(r.segs, r.width)
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
function tessellateGroups(groups) {
    const result = []
    for (const g of groups) {
        if (g.type === 'plain') {
            const meshes = tessellateAll(g.regions)
            if (meshes.length) result.push({ type: 'plain', meshes })
        } else {
            const maskMeshes    = tessellateAll(g.maskRegions)
            const contentMeshes = tessellateAll(g.contentRegions)
            if (maskMeshes.length || contentMeshes.length)
                result.push({ type: 'masked', maskMeshes, contentMeshes })
        }
    }
    return result
}

// Edge overlay: LINE_LOOP contours from fill regions only (debug wireframe).
// Input:  flat regions array [{ type, fill?, color?, segs, ... }]
// Output: [{ color: [r,g,b,a], vertices: Float32Array }]
function extractEdgeContours(regions) {
    const result = []
    for (const r of regions) {
        if (r.type !== 'fill') continue
        // Use solid fill colour; for gradients use the first stop as a stand-in.
        const color = r.fill?.type === 'solid'
            ? r.fill.color
            : (r.fill?.stops?.[0]?.color ?? [0.5, 0.5, 0.5, 1.0])
        const contours = stitchContours(r.segs)
        for (const pts of contours) {
            if (pts.length >= 4) result.push({ color, vertices: new Float32Array(pts) })
        }
    }
    return result
}

// ── Stroke tessellation ───────────────────────────────────────────────────
// (unchanged from previous implementation)

const MITER_LIMIT = 4.0
const CAP_STEPS   = 8

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

function tessellateStroke(segs, widthPx) {
    const hw = widthPx / 2
    const chains = stitchContours(segs)
    const tris = []
    for (const pts of chains) {
        const closed = isClosedPolyline(pts)
        for (const v of expandPolyline(pts, hw, closed)) tris.push(v)
    }
    return tris.length ? new Float32Array(tris) : null
}

export { tessellateAll, tessellateGroups, extractEdgeContours }

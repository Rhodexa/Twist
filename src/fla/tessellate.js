// Tessellate FLA fill regions into triangle meshes for WebGL.
// Pipeline: segments → closed contours (chain-stitched) → earcut triangulation.
// Quadratic bezier curves are subdivided into line segments before tessellation.

import earcut from '../../node_modules/earcut/src/earcut.js'

const BEZIER_STEPS = 8   // segments per quadratic bezier curve
const STITCH_EPS   = 0.05 // px — endpoint matching tolerance

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
// Negative = CCW in screen space = hole. Earcut fixes winding internally.
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

    // Single contour: trivial path, no nesting needed.
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
    // Sort by absolute area descending so the largest contour is processed first.
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

        // Any unused contour whose first vertex is inside this outer → hole.
        const holes = []
        for (let j = i + 1; j < byArea.length; j++) {
            if (used[j]) continue
            if (pointInPolygon(byArea[j].pts[0], byArea[j].pts[1], outerPts)) {
                holes.push(byArea[j].pts)
                used[j] = true
            }
        }

        // Concatenate outer + holes for earcut, recording hole start indices.
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

// ── Public API ─────────────────────────────────────────────────────────────

// Tessellate an ordered regions array into GPU meshes, preserving paint order.
// Input:  [{ type:'fill'|'stroke', color, segs, width? }]
// Output: [{ color: Float32Array, vertices: Float32Array }]  (same order)
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
        if (verts && verts.length >= 6) meshes.push({ color: r.color, vertices: verts })
    }
    return meshes
}

// Edge overlay: LINE_LOOP contours from fill regions only (debug wireframe).
// Input:  [{ type, color, segs, ... }]
// Output: [{ color: [r,g,b,a], vertices: Float32Array }]
function extractEdgeContours(regions) {
    const result = []
    for (const r of regions) {
        if (r.type !== 'fill') continue
        const contours = stitchContours(r.segs)
        for (const pts of contours) {
            if (pts.length >= 4) result.push({ color: r.color, vertices: new Float32Array(pts) })
        }
    }
    return result
}

// ── Stroke tessellation ───────────────────────────────────────────────────
// Expands a flat [x,y,...] polyline into triangle vertices using per-vertex
// miter normals for smooth, gap-free joins.
//
// At each interior vertex the offset direction is the bisector of the two
// adjacent edge normals, scaled by 1/cos(θ/2) so the stroke width is
// preserved perpendicular to each edge.  The scale is clamped to MITER_LIMIT
// to prevent runaway spikes at near-180° kinks; beyond that limit the inner
// edge self-intersection risk is zero and the outer simply gets a flat cap.
//
// closed=true wraps end→start so a closed stroke outline has no seam.

const MITER_LIMIT = 4.0

function expandPolyline(pts, halfWidth, closed = false) {
    const n = pts.length / 2
    if (n < 2) return []

    const edgeCount = closed ? n : n - 1

    // Per-edge left-facing unit normals.
    const enx = new Float32Array(edgeCount)
    const eny = new Float32Array(edgeCount)
    for (let i = 0; i < edgeCount; i++) {
        const j  = (i + 1) % n
        const dx = pts[j*2]   - pts[i*2]
        const dy = pts[j*2+1] - pts[i*2+1]
        const len = Math.sqrt(dx*dx + dy*dy)
        if (len > 1e-6) { enx[i] = -dy / len; eny[i] = dx / len }
    }

    // Per-vertex miter offset (left and right world-space points).
    const vlx = new Float32Array(n), vly = new Float32Array(n)
    const vrx = new Float32Array(n), vry = new Float32Array(n)

    for (let i = 0; i < n; i++) {
        const px = pts[i*2], py = pts[i*2+1]

        // Which edges are adjacent?
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

        // Bisector of the two normals.
        let mx = n1x + n2x, my = n1y + n2y
        const mlen = Math.sqrt(mx*mx + my*my)

        let scale
        if (mlen < 1e-6) {
            // ~180° reversal — use outgoing normal, no amplification needed.
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

    // Build two triangles per edge.
    const tris = []
    for (let i = 0; i < edgeCount; i++) {
        const j = (i + 1) % n
        tris.push(
            vlx[i], vly[i],  vrx[i], vry[i],  vlx[j], vly[j],
            vlx[j], vly[j],  vrx[i], vry[i],  vrx[j], vry[j],
        )
    }
    return tris
}

// Returns true when the first and last points of a polyline are the same
// vertex (within tolerance), meaning the contour closes on itself.
function isClosedPolyline(pts) {
    const n = pts.length / 2
    if (n < 3) return false
    const dx = pts[0] - pts[(n-1)*2]
    const dy = pts[1] - pts[(n-1)*2+1]
    return dx*dx + dy*dy <= STITCH_EPS * STITCH_EPS * 4
}

// Tessellate stroke segments into triangle meshes with proper miter joins.
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

// Input:  [{ color: [r,g,b,a], width: px, segs: Seg[] }]
// Output: [{ color: [r,g,b,a], vertices: Float32Array }]
function tessellateStrokes(strokeRegions) {
    const result = []
    for (const { color, width, segs } of strokeRegions) {
        const verts = tessellateStroke(segs, width)
        if (verts && verts.length >= 6) result.push({ color, vertices: verts })
    }
    return result
}

export { tessellateAll, extractEdgeContours }

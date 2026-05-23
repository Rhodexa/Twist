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
// Expands a flat [x,y,...] polyline into a quad strip (thick line segments).

function expandPolyline(pts, halfWidth) {
    const tris = []
    const n = pts.length / 2
    for (let i = 0; i < n - 1; i++) {
        const x0 = pts[i*2],     y0 = pts[i*2+1]
        const x1 = pts[(i+1)*2], y1 = pts[(i+1)*2+1]
        const dx = x1 - x0, dy = y1 - y0
        const len = Math.sqrt(dx*dx + dy*dy)
        if (len < 1e-6) continue
        const nx = -dy / len * halfWidth
        const ny =  dx / len * halfWidth
        tris.push(
            x0+nx, y0+ny,  x0-nx, y0-ny,  x1+nx, y1+ny,
            x1+nx, y1+ny,  x0-nx, y0-ny,  x1-nx, y1-ny,
        )
    }
    return tris
}

// Tessellate stroke segments into quad-strip triangles.
// Strokes don't need to form closed contours — stitchContours is still used
// to chain connected segments for smooth joins, but open chains are fine.
function tessellateStroke(segs, widthPx) {
    const hw = widthPx / 2
    const chains = stitchContours(segs)
    const tris = []
    for (const pts of chains) {
        for (const v of expandPolyline(pts, hw)) tris.push(v)
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

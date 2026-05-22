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

function tessellateContours(contours) {
    if (!contours.length) return null

    // earcut: flat vertex array + hole start indices
    const verts = []
    const holes = []
    for (let i = 0; i < contours.length; i++) {
        if (i > 0) holes.push(verts.length / 2)
        for (let j = 0; j < contours[i].length; j++) verts.push(contours[i][j])
    }

    const indices = earcut(verts, holes.length ? holes : null, 2)
    if (!indices.length) return null

    const tris = new Float32Array(indices.length * 2)
    for (let i = 0; i < indices.length; i++) {
        tris[i * 2]     = verts[indices[i] * 2]
        tris[i * 2 + 1] = verts[indices[i] * 2 + 1]
    }
    return tris
}

// ── Public API ─────────────────────────────────────────────────────────────

// Tessellate one fill region (array of segments) → Float32Array of triangle verts.
function tessellateRegion(segs) {
    const contours = stitchContours(segs)
    if (!contours.length) return null
    return tessellateContours(contours)
}

// Tessellate all fill regions from composeFillRegions().
// Input:  [{ color: [r,g,b,a], segs: Seg[] }]
// Output: [{ color: [r,g,b,a], vertices: Float32Array }]
function tessellateRegions(regions) {
    const submeshes = []
    for (const { color, segs } of regions) {
        const verts = tessellateRegion(segs)
        if (verts && verts.length >= 6) submeshes.push({ color, vertices: verts })
    }
    return submeshes
}

export { tessellateRegions, tessellateRegion }

// Keyframe evaluation — pure functions, no side effects.
// Called every render frame; keep it tight.

// Returns the interpolated value for a single track at a given frame.
// Returns null if the track has no keyframes (caller uses instance.transform fallback).
function evaluateTrack(keyframes, frame) {
    if (keyframes.length === 0) return null
    if (keyframes.length === 1) return keyframes[0].value

    // Find the keyframes immediately before and after `frame`
    let before = null
    let after  = null
    for (const kf of keyframes) {
        if (kf.frame <= frame) before = kf
        else if (after === null) after = kf
    }

    if (!before) return keyframes[0].value   // before the first keyframe — clamp
    if (!after)  return before.value          // after the last keyframe — clamp

    const t = (frame - before.frame) / (after.frame - before.frame)
    return before.value + t * (after.value - before.value)
}

// Returns a resolved transform for an instance at a given scene frame.
// Each property falls back to instance.transform[prop] when its track is empty.
function evaluateInstance(instance, frame) {
    const props = ['x', 'y', 'rotation', 'scaleX', 'scaleY']
    const out   = {}
    for (const prop of props) {
        const tracked = evaluateTrack(instance.tracks[prop], frame)
        out[prop] = tracked !== null ? tracked : instance.transform[prop]
    }
    return out
}

export { evaluateTrack, evaluateInstance }

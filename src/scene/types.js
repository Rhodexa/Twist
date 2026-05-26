// Twist core data model — factory functions and JSDoc typedefs.
//
// Every module that creates or inspects scene objects should go through
// these factories so the shape is defined exactly once.
//
// GPU-only fields (_groups, renderGroups, edgeContours) live on symbols but
// are not part of the serialized format — they are reconstructed at load time.

// ── Typedefs (JSDoc only — no runtime cost) ───────────────────────────────

/**
 * @typedef {[number,number,number,number,number,number]} AffineMatrix
 * Column-major 2-D affine: [a, b, c, d, tx, ty]
 */

/**
 * @typedef {{ frame: number, value: number, ease?: any }} Keyframe
 */

/**
 * @typedef {{ x: Keyframe[], y: Keyframe[], rotation: Keyframe[], scaleX: Keyframe[], scaleY: Keyframe[] }} TrackSet
 * Each property track is an array of Keyframe objects, sorted by frame.
 */

/**
 * @typedef {{ x: number, y: number, rotation: number, scaleX: number, scaleY: number }} Transform
 */

/**
 * @typedef {{ type:'solid', color:[number,number,number,number] }
 *          |{ type:'linear'|'radial', stops:{offset:number,color:[number,number,number,number]}[], matrix:AffineMatrix }
 * } FillDescriptor
 */

/**
 * @typedef {{ type:'fill',   fill:FillDescriptor, segs:object[][] }
 *          |{ type:'stroke', color:[number,number,number,number], width:number, segs:object[][] }
 * } Region
 */

/**
 * @typedef {{ type:'plain',  regions:Region[], order:number }
 *          |{ type:'masked', maskRegions:Region[], contentRegions:Region[],
 *             maskId:string, maskLayerIdx:number, order:number }
 * } BezierGroup
 * Raw bezier-path render group — source of truth for geometry.
 * Compact and permanent; used to (re-)tessellate on demand.
 */

/**
 * @typedef {{ type:'plain',  meshes:object[], order:number }
 *          |{ type:'masked', maskMeshes:object[], contentMeshes:object[],
 *             maskId:string, maskLayerIdx:number, order:number }
 * } RenderGroup
 * Tessellated render group — GPU-ready triangles.
 * Derived from BezierGroup; evictable (set to null to free VRAM budget).
 */

/**
 * @typedef {{ color:[number,number,number,number], vertices:Float32Array }} EdgeContour
 * Wire-frame overlay contour (fill outlines for debug view).
 */

/**
 * @typedef {{
 *   id:           string,
 *   name:         string,
 *   label:        string,
 *   _groups:      BezierGroup[],
 *   edgeContours: EdgeContour[],
 *   renderGroups: RenderGroup[]|null,
 * }} TwistSymbol
 * Runtime geometry container. renderGroups is null until first display.
 * _groups holds bezier paths for the current active frame.
 */

/**
 * @typedef {{
 *   id:           string,
 *   symbolId:     string,
 *   label:        string,
 *   parentId:     string|null,
 *   order:        number,
 *   rawMatrix:    AffineMatrix|null,
 *   maskId:       string|null,
 *   frameIn:      number,
 *   frameOut:     number,
 *   loop:         'loop'|'play once'|'single frame',
 *   firstFrame:   number,
 *   transform:    Transform,
 *   tracks:       TrackSet,
 *   _matrixTrack: {frame:number, mat:AffineMatrix}[],
 * }} TwistInstance
 * Runtime instance. rawMatrix / _matrixTrack carry FLA-imported animation.
 */

/**
 * @typedef {{
 *   x:      number,
 *   y:      number,
 *   width:  number,
 *   height: number,
 *   output: { w:number, h:number },
 * }} TwistCamera
 */

/**
 * @typedef {{
 *   currentFrame: number,
 *   duration:     number,
 *   fps:          number,
 *   playing:      boolean,
 * }} TwistTimeline
 */

// ── Project-format typedefs ───────────────────────────────────────────────
// These describe the on-disk / serialized format, not the runtime objects.

/**
 * @typedef {{
 *   symbolRef:  string,
 *   matrix:     AffineMatrix,
 *   loop:       'loop'|'play once'|'single frame',
 *   firstFrame: number,
 *   label?:     string,
 *   maskId?:    string,
 *   order?:     number,
 *   id?:        string,
 * }} TwistElement
 * A child symbol placement inside a symbol keyframe span.
 * Equivalent to Flash's DOMSymbolInstance on a layer.
 */

/**
 * @typedef {{
 *   index:     number,
 *   duration:  number,
 *   groups:    BezierGroup[],
 *   elements:  TwistElement[],
 * }} TwistSymbolKeyframe
 * One keyframe span on a symbol layer — holds geometry AND child placements.
 */

/**
 * @typedef {{
 *   name:            string,
 *   type:            'normal'|'mask'|'guide',
 *   parentLayerIndex: number|null,
 *   keyframes:       TwistSymbolKeyframe[],
 * }} TwistSymbolLayer
 */

/**
 * @typedef {{
 *   id:       string,
 *   name:     string,
 *   label:    string,
 *   timeline: { duration:number, layers:TwistSymbolLayer[] },
 * }} TwistProjectSymbol
 * On-disk symbol definition. No tessellated data — geometry is bezier paths only.
 */

/**
 * @typedef {{
 *   id:          string,
 *   symbolRef:   string,
 *   label:       string,
 *   parentId:    string|null,
 *   order:       number,
 *   maskId:      string|null,
 *   frameIn:     number,
 *   frameOut:    number,
 *   loop:        'loop'|'play once'|'single frame',
 *   firstFrame:  number,
 *   matrix:      AffineMatrix,
 *   tracks:      TrackSet,
 *   matrixTrack: {frame:number, mat:AffineMatrix}[],
 * }} TwistSceneInstance
 * On-disk instance. Uses AffineMatrix (lossless) instead of TRS.
 */

/**
 * @typedef {{
 *   version:  string,
 *   name:     string,
 *   camera:   TwistCamera,
 *   timeline: { duration:number, fps:number },
 *   symbols:  TwistProjectSymbol[],
 *   stage:    { instances: TwistSceneInstance[] },
 * }} TwistProject
 * Root on-disk document. Assembled by main.js from project.json + library/*.json.
 */

// ── Runtime document (legacy, kept for reference) ─────────────────────────

/**
 * @typedef {{
 *   version:   string,
 *   camera:    TwistCamera,
 *   timeline:  TwistTimeline,
 *   symbols:   TwistSymbol[],
 *   instances: TwistInstance[],
 * }} TwistDocument
 * @deprecated Use TwistProject. This flat runtime-snapshot format is kept
 * for backward compatibility with old serialize.js toJSON/fromJSON.
 */

// ── Factories ─────────────────────────────────────────────────────────────

/** @returns {TwistSymbol} */
function makeSymbol({ id, name, label, _groups = [], edgeContours = [], renderGroups = null } = {}) {
    return { id, name, label, _groups, edgeContours, renderGroups }
}

/** @returns {TwistInstance} */
function makeInstance({
    id, symbolId, label,
    parentId    = null,
    order       = 0,
    rawMatrix   = null,
    maskId      = null,
    frameIn     = 0,
    frameOut    = Infinity,
    loop        = 'loop',
    firstFrame  = 0,
    transform   = {},
    tracks      = {},
    _matrixTrack = [],
} = {}) {
    return {
        id, symbolId, label,
        parentId,
        order,
        rawMatrix,
        maskId,
        frameIn,
        frameOut,
        loop,
        firstFrame,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, ...transform },
        tracks:    { x: [], y: [], rotation: [], scaleX: [], scaleY: [], ...tracks },
        _matrixTrack,
    }
}

/** @returns {TwistCamera} */
function makeCamera({
    x = 0, y = 0, width = 856, height = 480,
    output = { w: 1920, h: 1080 },
} = {}) {
    return { x, y, width, height, output }
}

/** @returns {TwistTimeline} */
function makeTimeline({ currentFrame = 0, duration = 120, fps = 24, playing = false } = {}) {
    return { currentFrame, duration, fps, playing }
}

/** @returns {Keyframe} */
function makeKeyframe(frame, value, ease = null) {
    const kf = { frame, value }
    if (ease !== null) kf.ease = ease
    return kf
}

export { makeSymbol, makeInstance, makeCamera, makeTimeline, makeKeyframe }

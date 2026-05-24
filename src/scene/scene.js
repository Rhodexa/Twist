// Scene graph root. Camera, symbol library, instances, and timeline live here.

const scene = {
    camera: {
        x:      0,
        y:      0,
        width:  856,
        height: 480,
        output: { w: 1920, h: 1080 }
    },

    // Symbol definitions — geometry shared across all instances.
    // Vertices are flat x,y pairs in LOCAL space, centred at (0,0).
    symbols: [
        {
            id:       'sym_0',
            name:     'Test Shape',
            color:    [0.42, 0.38, 0.72, 1.0],
            vertices: new Float32Array([
                -200, -150,    200, -150,    200,  150,
                -200, -150,    200,  150,   -200,  150,
            ])
        }
    ],

    // Symbol instances — placed in the scene with a world-space transform.
    // tracks: keyframe data on the scene timeline, keyed by property name.
    // Each track is an array of { frame: Number, value: Number }, sorted by frame.
    instances: [
        {
            id:        'inst_0',
            symbolId:  'sym_0',
            label:     'Test Shape',
            parentId:  null,     // null = top-level; string = child of that instance
            order:     0,        // render order within siblings (ascending = back-to-front)
            rawMatrix: null,     // [a,b,c,d,tx,ty] Flash affine — null = use TRS transform
            transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
            tracks:    { x: [], y: [], rotation: [], scaleX: [], scaleY: [] }
        }
    ],

    // Scene-level playback state.
    timeline: {
        currentFrame: 0,
        duration:     120,
        fps:          24,
        playing:      false
    }
}

export default scene

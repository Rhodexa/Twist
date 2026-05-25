// Scene graph root. Camera, symbol library, instances, and timeline live here.

const scene = {
    camera: {
        x:      0,
        y:      0,
        width:  1920,
        height: 1080,
        output: { w: 1920, h: 1080 }
    },

    symbols:   [],
    instances: [],

    timeline: {
        currentFrame: 0,
        duration:     120,
        fps:          24,
        playing:      false
    }
}

export default scene

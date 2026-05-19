// Scene graph root. Everything visible in the world lives here.
// Starting with just the camera — symbols, rigs, and timelines come later.

const scene = {
    // The render camera defines WHAT region of world space gets exported.
    // width/height are in world units, NOT pixels.
    // output is the pixel resolution of the exported file.
    // Keeping these independent means you can change resolution without
    // moving or rescaling anything in the scene.
    camera: {
        x:      0,      // world-space centre of the camera frame
        y:      0,        
        width:  1920,   // frame size in world units
        height: 1080,
        output: { w: 1920, h: 1080 }   // pixels in the exported file
    },

    // How many output pixels equal one world unit.
    // At defaults: 1 world unit = 1 output pixel.
    // Scale camera.width to zoom the camera out without touching scene geometry.
    pixelsPerUnit() {
        return this.camera.output.w / this.camera.width
    }
}

export default scene

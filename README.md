# Twist

A personal vector puppet animation workstation, built for 2.5D cartoon animation in the style of *My Little Pony: Friendship is Magic*.

Think Flash or Toon Boom Harmony's workflow — symbol libraries, rig hierarchies, per-symbol timelines — but without Adobe or Toon Boom involved. MIT licensed, built for fun, not for fame.

---

## The MLP Challenge

To push Twist early and hard, we decided the best stress test would be loading actual production animation assets from the show: the official DHX Media FLA character rigs used to animate MLP:FiM.

These rigs are complex. Nested symbol hierarchies dozens of levels deep, hundreds of instances per character, fill regions with holes, strokes interleaved with fills, per-instance frame offsets, drawing objects inside groups — the full messiness of real production Flash files.

To understand the FLA format before writing a line of Twist's importer, we built **FLA-RE** — a small Python toolkit for reverse-engineering XFL/FLA files. FLA-RE reads the raw XML, reconstructs fill regions by stitching edge segments, tessellates them, and renders characters to SVG. It became the ground truth reference the Twist importer was built and debugged against.

Getting Twilight Sparkle and Rainbow Dash rendering correctly in a custom WebGL2 renderer turned out to be a pretty good way to shake out an importer.

IMPORTANT:
Check ../FLA-RE/ for reference.
The python tools in there, render frames to almost* perfection for all .fla we have tried. Making it a source of absolute truth regarding how to parse FLA files. If you are ever in doubt about how to implement any specific functionality about .fla, check there.

(To the best of our knowledge, this tool actually _does_ perfection, but we haven't tried edge cases outside of the .fla files found in ../FLA-RE/fla/ those files however, render to perfection by our measures.)

---

*Twist is a personal project. It is not trying to be Blender. It is not trying to be famous. It is a fast, honest tool for making cartoons without fighting software.*

--- 
Director:
I will be here to help you, and you can ask me any question or to help you debug stuff at any time.


Twist is MIT-licensed and MUST include only MIT-compatible libs.
# Twist

A personal vector puppet animation workstation, built for 2.5D cartoon animation in the style of *My Little Pony: Friendship is Magic*.

Think Flash or Toon Boom Harmony's workflow — symbol libraries, rig hierarchies, per-symbol timelines — but without Adobe or Toon Boom involved. MIT licensed, built for fun, not for fame.

---

## The MLP Challenge

To push Twist early and hard, we decided the best stress test would be loading actual production animation assets from the show: the official DHX Media FLA character rigs used to animate MLP:FiM.

These rigs are complex. Nested symbol hierarchies dozens of levels deep, hundreds of instances per character, fill regions with holes, strokes interleaved with fills, per-instance frame offsets, drawing objects inside groups — the full messiness of real production Flash files.

To understand the FLA format before writing a line of Twist's importer, we built **FLA-RE** — a small Python toolkit for reverse-engineering XFL/FLA files. FLA-RE reads the raw XML, reconstructs fill regions by stitching edge segments, tessellates them, and renders characters to SVG. It became the ground truth reference the Twist importer was built and debugged against.

Getting Twilight Sparkle and Rainbow Dash rendering correctly in a custom WebGL2 renderer turned out to be a pretty good way to shake out an importer.

---

*Twist is a personal project. It is not trying to be Blender. It is not trying to be famous. It is a fast, honest tool for making cartoons without fighting software.*

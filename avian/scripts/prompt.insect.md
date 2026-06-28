# Insect illustration prompt

Standalone kachō-e prompt for crickets & katydids (Orthoptera). The bird
prompt in `prompt.template.md` is intentionally left untouched. Placeholders:

- `{sci_name}` - binomial Latin name, e.g. `Pterophylla camellifolia`
- `{com_name}` - English common name, e.g. `Common True Katydid`
- `{pose}` - `at rest in side profile` (pose 1) or `in side profile with wings slightly raised` (pose 2)

`pregen.py` attaches ONE reference image: IMAGE 1, a Wikipedia photo of the
target species (anatomy + color only). No style image; kachō-e technique is
described in text. Edo-period insect prints (Utamaro's insect books, Hokusai)
are the stylistic lineage.

---

## Prompt

Generate a {pose} {com_name} ({sci_name}) in the style of an Edo-period Japanese kachō-e woodblock print, in the tradition of Utamaro's insect studies. Render it with VERY FEW MARKS: a few flat color zones with sharp, confident boundaries and clean ink outlines. No iridescent shading, no photographic micro-texture, no stippling. The whole insect should read as maybe 25-30 confident brush and ink strokes - the body as flat color, the wings as one or two translucent washes with a few vein strokes, the legs as single confident lines.

Confident sumi-e ink linework with soft watercolor washes. Restrained palette appropriate to the species - leaf-greens for katydids, warm browns and umbers for field crickets, with the diagnostic coloring of {com_name}. Flat painted paper, not a shiny 3D carapace. Antennae and legs are crisp single ink strokes; the eye is a small confident dark mark.

The insect sits on a CONSISTENT WARM CREAM tonal background - aged Japanese mulberry paper, a soft warm buff cream filling the entire frame. This is the only background element: NO leaf, NO stem, NO grass, NO branch, NO foliage, NO scenery. Only the insect floating against the cream paper ground. NO border or frame, NO text or signature.

Composition: the insect (including its long antennae) occupies one-third to one-half of the frame with generous cream negative space around it. The ENTIRE insect must fit within the frame - head, all six legs, both antennae, the full length of the wings and abdomen. Do NOT crop the antennae, legs, or wingtips at the edge. Leave generous padding on all sides.

### Reference handling

- IMAGE 1 (positive, target species) IS {com_name}. Match its proportions, color, wing shape, antenna length, and body segmentation. Render the most diagnostic, recognizable form.
- Treat IMAGE 1 for anatomy and color ONLY. The output is a flat woodblock print, not a photograph.

### Anatomy

- This is an INSECT (a cricket or katydid) - NOT a bird, NOT a mammal. NO beak, NO feathers, NO fur, NO four-legged vertebrate body.
- EXACTLY SIX legs, with the rear pair noticeably enlarged (the jumping femurs). EXACTLY TWO antennae - long and thread-like, often as long as or longer than the body (especially katydids). A body in three clear parts: head, thorax, abdomen.
- Wings folded along/over the back at rest, tent-like or flat; for katydids the forewings look like a leaf. Render wings as one or two flat translucent zones with a few clean vein strokes - NOT a dense vein mesh.
- Match color and proportions to IMAGE 1 / {com_name}. Katydids are typically leaf-green; field crickets brown to black - render the species' actual coloring.

### Pose

- AT REST (pose 1): standing in clean side profile, all six legs planted, wings folded over the back, antennae sweeping back and up. A calm, classic specimen-in-profile silhouette.
- WINGS SLIGHTLY RAISED (pose 2): same side profile but with the wings lifted a little as if about to sing or move, hind leg cocked - a touch more dynamic. Still a side view; do NOT attempt full open-winged flight.

### Output

Render at high resolution on a fully transparent background. Cut the insect out cleanly. No shadow, no paper texture, no caption.

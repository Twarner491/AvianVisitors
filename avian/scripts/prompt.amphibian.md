# Amphibian illustration prompt

Standalone kachō-e prompt for frogs & toads (the bird prompt in
`prompt.template.md` is intentionally left untouched). Same three text
placeholders are substituted per request:

- `{sci_name}` - binomial Latin name, e.g. `Lithobates catesbeianus`
- `{com_name}` - English common name, e.g. `American Bullfrog`
- `{pose}` - `sitting alert` (pose 1) or `mid-leap with hind legs extended` (pose 2)

`pregen.py` attaches ONE reference image for non-birds: IMAGE 1, a Wikipedia
photo of the target species (anatomy + color only). No style image is
attached, so the kachō-e technique is described in text below.

---

## Prompt

Generate a {pose} {com_name} ({sci_name}) in the style of an Edo-period Japanese kachō-e woodblock print. Render it with VERY FEW MARKS: the body is essentially 2-4 flat color zones with sharp, confident boundaries. Almost no internal texture - no scale-by-scale or wart-by-wart rendering, no pen-line stippling, no gradient shading. The whole animal should look like it was painted with maybe 30 brush strokes total: a few flat color zones, a few confident outline strokes, an accent stroke or two for the major markings, and that's it.

Confident sumi-e ink linework with soft watercolor washes. Earthy, restrained palette appropriate to the species - mossy and olive greens, ochre, umber, with the diagnostic colors of {com_name}. The body should look like flat painted paper, not a glossy or wet 3D surface. If the skin has fine mottling or spotting, ABSTRACT it into 2-3 broad zones or a few dabs rather than rendering every mark. The eyes, nostrils, and mouth-line are drawn with crisp dark ink - these are the only places where confident dark line is appropriate.

The animal sits on a CONSISTENT WARM CREAM tonal background - like aged Japanese mulberry paper, a soft warm buff cream color filling the entire frame. This is the only background element: NO lily pad, NO water, NO reeds, NO rock, NO leaves, NO foliage, NO substrate, NO scenery. Only the frog or toad floating against the cream paper ground. NO border or frame, NO text or signature.

Composition: the animal occupies one-third to one-half of the frame, with generous negative space (just the cream ground) around it. Sparse and confident, not packed with detail. The ENTIRE animal must fit within the frame - head, all four legs, both feet - do NOT crop any body part at the edge. Leave generous padding on all sides.

### Reference handling

- IMAGE 1 (positive, target species) IS {com_name}. Match its proportions, skin color and pattern, eye color and placement, and overall body shape. Render the most diagnostic, recognizable adult form of the species.
- Treat IMAGE 1 for anatomy and color information ONLY - not as a style or composition reference. The output is a flat woodblock print, not a photograph.

### Anatomy

- This is a FROG or TOAD (an amphibian) - NOT a bird, NOT a mammal, NOT a reptile. NO beak, NO wings, NO feathers, NO fur, NO shell.
- EXACTLY FOUR legs: two short front legs and two large, muscular hind legs built for jumping. EXACTLY ONE head, with TWO prominent eyes set high on the head and a wide mouth-line. NO TAIL (adult frogs and toads are tailless).
- Toads: drier, bumpier skin and a squatter, shorter-legged build. Frogs: smoother, moister-looking skin, longer hind legs, often webbed hind feet. Match whichever the reference shows.
- Match color, pattern, and proportions to IMAGE 1 / {com_name}. Do NOT default to generic green: render the species' actual coloring (many are brown, gray, or patterned).

### Pose

- SITTING ALERT (pose 1): squatting upright on all fours, front legs straight and propping up the head, hind legs folded at the sides ready to spring. Seen from a front-three-quarter or side angle. All four feet visible.
- MID-LEAP (pose 2): caught in a jump, body stretched horizontally, the powerful hind legs extended straight back and the front legs reaching forward. A dynamic, airborne silhouette.

### Output

Render at high resolution on a fully transparent background. Cut the animal out cleanly. No shadow, no paper texture, no caption.

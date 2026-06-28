# Mammal illustration prompt

Standalone kachō-e prompt for small mammals (squirrels, chipmunks, canids).
The bird prompt in `prompt.template.md` is intentionally left untouched.
Placeholders:

- `{sci_name}` - binomial Latin name, e.g. `Sciurus carolinensis`
- `{com_name}` - English common name, e.g. `Eastern Gray Squirrel`
- `{pose}` - `sitting upright and alert` (pose 1) or `standing in profile on all fours` (pose 2)

`pregen.py` attaches ONE reference image: IMAGE 1, a Wikipedia photo of the
target species (anatomy + color only). No style image; the kachō-e technique
is described in text. Edo-period prints of hares, foxes, and squirrels are
the stylistic lineage.

---

## Prompt

Generate a {pose} {com_name} ({sci_name}) in the style of an Edo-period Japanese kachō-e woodblock print. Render it with VERY FEW MARKS: the body as 2-4 flat color zones with sharp, confident boundaries. NO strand-by-strand fur rendering, no stippling, no gradient shading. The whole animal should read as maybe 30 confident strokes - flat color masses, a clean outline, and a few accent strokes for the major fur boundaries (belly, tail, face markings). The fur texture is implied by a few feathered edge-strokes at the silhouette, NOT drawn hair by hair.

Confident sumi-e ink linework with soft watercolor washes. Earthy, restrained palette with the diagnostic coloring of {com_name} - warm grays, browns, ochres, rufous as appropriate. Flat painted paper, not shaded 3D volume. The eye, nose, and claws are crisp dark ink; whiskers are a few fine confident strokes.

The animal sits on a CONSISTENT WARM CREAM tonal background - aged Japanese mulberry paper, a soft warm buff cream filling the entire frame. This is the only background element: NO branch, NO tree, NO ground line, NO leaves, NO acorn, NO foliage, NO scenery. Only the animal floating against the cream paper ground. NO border or frame, NO text or signature.

Composition: the animal occupies one-third to one-half of the frame with generous cream negative space around it. The ENTIRE animal must fit within the frame - head, all four legs, both feet, ears, and the full tail. Do NOT crop the tail, paws, or ears at the edge. Leave generous padding on all sides.

### Reference handling

- IMAGE 1 (positive, target species) IS {com_name}. Match its proportions, fur color and markings, ear shape, and tail shape (e.g. a squirrel's big bushy tail). Render the most diagnostic, recognizable form.
- Treat IMAGE 1 for anatomy and color ONLY. The output is a flat woodblock print, not a photograph.

### Anatomy

- This is a MAMMAL - NOT a bird, NOT an insect. NO beak, NO wings, NO feathers, NO scales.
- EXACTLY FOUR legs, EXACTLY ONE head, TWO ears, EXACTLY ONE tail. Fur rendered as flat color zones, not individual hairs.
- Match the species' build: squirrels and chipmunks have a large bushy or full tail, prominent eye, small rounded ears; canids (coyote/wolf) have a longer muzzle, upright ears, and a bushy tail. Match color and proportions to IMAGE 1 / {com_name}.

### Pose

- SITTING UPRIGHT (pose 1): perched up on the haunches, forepaws held together at the chest, tail curving up behind (the classic alert squirrel posture). Seen from a front-three-quarter angle.
- ON ALL FOURS (pose 2): standing in clean side profile on all four legs, head level or slightly raised, tail extended - a calm walking/standing silhouette.

### Output

Render at high resolution on a fully transparent background. Cut the animal out cleanly. No shadow, no paper texture, no caption.

(function (global) {
  "use strict";

  // Derived from Avian Visitors v1.1's production collage engine. The
  // silhouette packing and label-planning functions below intentionally stay
  // in sync with avian/frontend/apt.js; only the DOM/data adapter is local.
  var DIMS = Object.create(null);
  var MASKS = Object.create(null);
  // Tunables - Galliformes-poster-inspired. Raster-mask nesting.
  //
  // Layout discipline: tile areas are NORMALISED against a viewport
  // budget (sum of areas ≈ packingBudgetFrac × vpArea) rather than
  // each tile being clamped to a per-tile maxArea. The old per-tile
  // cap made every loud bird look identical (Anna n=398, Crow n=31
  // and Phoebe n=26 all hit ceiling and rendered the same size) AND
  // it allowed total area to overflow narrow viewports so birds got
  // dropped off-screen. Normalising fixes both - relative size
  // tracks the relative call ratio, and total area can never exceed
  // what the iterative shrink loop is willing to scale into the
  // viewport.
  function tuning(n) {
    return {
      // Soft area budget the whole cluster aims to fill, as a
      // fraction of viewport area. Lower = sparser collage with more
      // breathing room (and more headroom for packing efficiency).
      // Steps down as species count grows so a busy plate doesn't
      // try to claim the entire viewport.
      packingBudgetFrac: n <= 4 ? 0.46 :
        n <= 12 ? 0.40 :
          n <= 24 ? 0.34 :
            0.28,
      // Count -> area exponent. ~0.65 keeps the visual hierarchy
      // legible (n=400 reads ~5× bigger than n=30) without the
      // loudest bird drowning everything else.
      countExp: 0.65,
      // Floor: every species in the dataset must be visible, even
      // n=1. Tracks species count so a tiny rare bird stays
      // recognisable on a crowded plate.
      minTileAreaFrac: n <= 8 ? 0.0100 :
        n <= 20 ? 0.0075 :
          0.0055,
      // Wider clusters for landscape viewports, more so as n grows.
      ellipseAspectBias: 2.1,
    };
  }
  var GRID_STRIDE = 4; // viewport px per occupancy cell; smaller = slower
  var COLLAGE_PAD = 3; // breathing room (grid cells) around each bird;
  // eased on narrow screens where birds are smaller.
  // The lettering is thin ink and already carries LABEL_GAP of its own, so it
  // does not need the silhouette's full dilation. A neighbour may nest close to
  // a name without reading as crowded - decoupling this from COLLAGE_PAD keeps
  // the bird-to-bird gap the collage was tuned on while stopping a label from
  // reserving a bird-sized moat of empty paper around itself.
  var COLLAGE_LABEL_PAD = 1;
  // Decode and cache each mask once. Sparse cell-list form (only "on"
  // cells) makes collision tests linear in opaque area, not total area.
  var maskCache = {};
  var labelPathSeq = 0;   // unique ids for the label textPath targets

  // The lettering is filtered so it reads as ink laid into the print rather
  // than type set on top of it (see .gtile-label text in styles.css). One
  // filter serves every label: feTurbulence is generated in user space and
  // each label's svg carries its own viewBox origin, so the names come out
  // with different grain without a seed apiece. Injected on the first label
  // drawn rather than shipped in the markup, because labels are off by
  // default and nothing else in the page refers to it.
  // Three filters, not one. The displacement is a fixed count of user-space
  // pixels, so a single scale that reads as paper tooth on 21px type is 12% of
  // the em on 9px type, which is not wear but blur: the smallest names came out
  // soft and only resolved when a tile scaled up on hover and the browser
  // re-rasterised them. Wear has to be a constant share of the letter, so the
  // scale tracks the size, and the alpha ramp lifts as the type shrinks to hold
  // contrast where there is less ink to carry it.
  function inkFilter(id, disp, slope, intercept) {
    return '<filter id="' + id + '" x="-6%" y="-16%" width="112%" height="132%"' +
      ' color-interpolation-filters="sRGB">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="2"' +
        ' seed="17" result="tooth"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="tooth" scale="' + disp + '"' +
        ' xChannelSelector="R" yChannelSelector="G" result="edge"/>' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.25 0.55" numOctaves="3"' +
        ' seed="5" result="pool"/>' +
        '<feComponentTransfer in="pool" result="dens">' +
          '<feFuncA type="linear" slope="' + slope + '" intercept="' + intercept + '"/>' +
        '</feComponentTransfer>' +
        '<feComposite in="edge" in2="dens" operator="in"/>' +
      '</filter>';
  }
  var LABEL_INK_DEFS =
    '<svg class="avbc-label-defs" width="0" height="0" aria-hidden="true">' +
      inkFilter('avbc-ink-s', '0.45', '0.24', '0.68') +
      inkFilter('avbc-ink-m', '0.75', '0.34', '0.55') +
      inkFilter('avbc-ink-l', '1.10', '0.42', '0.42') +
    '</svg>';
  // Which bucket a name falls in. Kept as a function so the render site and
  // any future caller agree on the boundaries.
  function inkBucket(px) { return px <= 12 ? 's' : px <= 17 ? 'm' : 'l'; }
  var labelInkAdded = false;
  function addLabelInk() {
    if (labelInkAdded) return;
    labelInkAdded = true;
    document.body.insertAdjacentHTML('beforeend', LABEL_INK_DEFS);
  }
  function loadMask(slug) {
    if (maskCache[slug]) return maskCache[slug];
    var rec = MASKS[slug];
    if (!rec) return null;
    var bytes = atob(rec.bits);
    var w = rec.w, h = rec.h;
    var cells = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var b = bytes.charCodeAt(i >> 3);
        if ((b >> (7 - (i & 7))) & 1) cells.push([x, y]);
      }
    }
    return (maskCache[slug] = { w: w, h: h, cells: cells });
  }

  function slugify(sci) {
    return sci.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function aspect(sci) {
    var d = DIMS[slugify(sci)];
    return d ? d[0] / d[1] : 1.4;
  }

  // ---- Collage labels ----
  // Optional handwritten name for each bird, always set along a path. The
  // name rides a run of the bird's own outline - a back, a belly line, the
  // leading edge of a wing - so it reads as part of the drawing rather than
  // a caption parked beneath it. Type is sized from the tile and never from
  // the run, so a short edge can still carry a long name: the lettering
  // simply carries on past the bird into open paper along the line that edge
  // established, which is how a name gets written beside a small drawing.
  // Where a bird offers no run worth writing along at all, the name goes on
  // a line drawn tangent to the silhouette, which exists for every shape, so
  // no bird is left bare. Nothing is ever set level in the paper a bird
  // leaves inside itself: that clearing is where the packer wants to nest
  // the next bird. The whole em band of the lettering is proved clear of the
  // silhouette before it is accepted, so no name ends up threaded through a
  // bird's own feet. The lettering's box is what the packer reserves. On by
  // default; saved on this device like the theme. ?labels=1|0 overrides both
  // (that is how the frame's shoot can force them without localStorage).
  // Two quantities that used to be one number. LABEL_NEAR is the paper the
  // eye reads between the silhouette and the letters; LABEL_GAP is what the
  // packer keeps clear around the lettering so a neighbour does not nest into
  // the word. They were the same constant, so bringing the name closer to its
  // own bird also let neighbours closer to the name, which is not what was
  // asked for. Only LABEL_NEAR moved.
  var LABEL_GAP = 3;        // px the packer reserves around the lettering
  var LABEL_NEAR = 2;       // px of paper between silhouette and letters
  var LABEL_MIN_PX = 9;     // below this the handwriting stops reading
  var LABEL_MAX_PX = 21;
  var LABEL_ASC = 0.80;     // Caveat's inked em band, above the baseline
  var LABEL_DESC = 0.25;    // and below it
  // Most ink one letter-width of a name may sit on: a shade above nothing.
  // Small enough that one sample of one row across one letter refuses the
  // placement, and not zero only because a bare equality on a floating-point
  // sum is not a tolerance. The old 0.03 was set when refusing a placement
  // left a bird bare; now that a name may run on past its edge, and a
  // supporting line waits below that, there is always somewhere cleaner to
  // go, and grazing costs 0.2% of the library's placements to forbid.
  var LABEL_INK = 0.0025;
  var LABEL_BOW = 0.06;     // how far a run may bow off its own chord
  var LABEL_DEG = 55;       // lean at which a letter stops reading as upright
  // How far past the end of its run the lettering may carry, per side, in em.
  // The type is sized from the tile rather than from the run, so a short edge
  // on a small bird still gets the whole name at a readable size: what a run
  // has to do is point, not contain. Three ems is six or seven letters, which
  // sounds a lot and is what a tall narrow heron or a round owl needs before
  // it can be named at all. Raising it further keeps buying placements across
  // the library, but the reserved box grows with it and the packer pays.
  var LABEL_EXT = 3.0;
  // Shortest run worth writing along, in em of the type being set. Below this
  // the name is riding a tangent rather than an edge, and the tangent tier
  // below does that job better than a stub of outline does.
  var LABEL_RUN = 1.25;
  // Steepest a supporting line may be drawn at. Well under LABEL_DEG: a line
  // the bird did not draw has nothing to justify a rake, so it should read as
  // level type set against the profile.
  var LABEL_TAN = 30;
  // Longest a name on a supporting line may be set, as a multiple of the
  // tile's longer side. An edge label's overrun is bounded by LABEL_EXT
  // either side of a run; a supporting line has no run, so without this a
  // five-syllable name on a small bird would reserve most of a tile of open
  // paper at each end and the packer would pay for all of it.
  var LABEL_REACH = 1.15;
  // A contributor may supply a valid but pathologically long common name.
  // Keep that exact value on the image for accessibility, but do not let the
  // decorative, aria-hidden handwriting reserve enough paper to evict a bird
  // from the six-specimen preview. Ordinary bird names stay byte-for-byte
  // unchanged; only the visual copy is shortened, using measured font width.
  var LABEL_VISUAL_MAX_EM = 16;
  var LABEL_ADHERE = 0.9;   // of the supported span that must have ink beside it
  // What a lean costs, as the share of an upright line a letter at the ceiling
  // is still worth. It used to be a cliff: free below 40 degrees and worthless
  // at 55, which priced a 54 degree run at a fifteenth of a level one. Every
  // bird the owner holds up as right finishes between 44 and 50 degrees of
  // letter lean, so the whole approved band was being sold at a discount, and
  // a bird's steep back could never outscore a flat stub off its crown however
  // much more of the name the back had beside it. The ceiling has not moved.
  var LABEL_LEAN = 0.5;
  // What a run bowed all the way to LABEL_BOW is worth against a dead straight
  // one, in the final choice. A bow past that is refused outright either way.
  var LABEL_BEND = 0.5;
  // How hard attachment pushes: the power the finished share is raised to.
  // Counted once it is worth less than a few degrees of tilt, and the
  // difference between a name two thirds beside its bird and one wholly beside
  // it is the whole complaint. Swept over 2 to 6 on the live set: at 2 the
  // hummingbird stays on its crown and from 3 up it takes the back, so this
  // sits inside the plateau rather than on its edge, and 3 and 4 give the same
  // census bird for bird.
  var LABEL_ATT = 4;
  // What a run that cannot hold the whole name is still worth, as a share of
  // one that can. Coverage ranks the shortlist, where its job is to keep stubs
  // out; in the final choice it is mostly a second, worse measurement of what
  // attachment now measures directly, so it is demoted rather than dropped.
  var LABEL_HOLD = 0.4;
  // Leading between the lines of a broken name, in em. Exactly Caveat's inked
  // band, so the lower line's ascenders come up to where the upper line's
  // descenders stop. Every extra em pushes the outer line another em off the
  // bird, which is the thing wrapping exists to avoid.
  var LABEL_LEAD = 1.05;
  // Evenest break wins, and a break leaving less than this share of the longer
  // line on the shorter one is refused: two lines of a length read as one
  // written name, a long line and a stub read as a line that ran out of room.
  var LABEL_EVEN = 0.40;
  // What a broken name has to beat one line by. A second line can only sit
  // further off the bird than the first, so breaking has to pay for itself.
  var LABEL_KEEP = 0.94;
  // A plain placement this snug against the bird, reserving no more than this
  // share of a tile of fresh paper, is taken as it stands and nothing else is
  // tried. Set where the shipped census separates the birds the owner approved
  // from the ones he objected to, with nothing of his sitting near either line.
  var LABEL_SNUG = 0.85;
  var LABEL_ROOM = 0.25;
  // Reach, in em, at which a finished label is asked how much of it still has
  // bird beside it. Fixed, so a name pushed further out is charged for being
  // further from the drawing rather than measured on its own terms.
  var LABEL_BESIDE = 2.0;
  // How many runs the second pass weighs. Pass one keeps the full shortlist,
  // because its job is to find somewhere a bird with busy feet can go; pass two
  // has the list in best-possible order and laying a name out on a run is the
  // expensive part of the whole engine, so it stops once the tail cannot win.
  // Extra clearance, in em, when a try lands on ink. Fine at the bottom and
  // coarse at the top, because most refusals are a graze - one sample of one
  // row of the band catching a claw - and a single coarse first step is what
  // spends the whole of LABEL_NEAR back: a third of an em is six pixels at the
  // largest type, so a name pushed off a hair of a bird ends up further out
  // than it started. The steps below the old first one are the point of the
  // ladder; the top of it is where the shipped one started. Each rung is three
  // times the one below, so a bird pays roughly what it needs rather than the
  // next third of an em: at the largest type the first step is half a pixel.
  // Five rungs is where it stops paying - a finer ladder set the lettering no
  // closer and cost time, a coarser one left a graze in the census.
  var LABEL_LIFT = [0, 0.02, 0.06, 0.18, 0.45];
  // How much bird a run has to have under it to be worth writing along, as a
  // share of the deepest run on the SAME bird. A hummingbird's bill is dead
  // level and longer than its back, so it wins on run length and on lean at
  // once, and the name ends up a caption suspended over the bird's head. What
  // rules it out is that there is nothing beneath it: an edge is worth writing
  // along because the drawing continues underneath the letters.
  //
  // Measured against the bird's own shortlist rather than against a depth in
  // pixels, because a heron is thin from bill to foot: the deepest run a heron
  // offers is four and a half pixels, thinner in absolute terms than the bill
  // this is meant to refuse, so an absolute floor takes away every run it has
  // and drops it to a level tangent line - a placement the owner has already
  // approved. Relative, all three of the heron's runs price at 1.000 and it
  // does not move at all.
  //
  // Swept over the live set from 0.05 to 0.80: every value from 0.05 to 0.65
  // gives the identical twenty-three, and Northern Mockingbird is the first
  // approved bird to move, at 0.70.
  var LABEL_SEAT = 0.35;
  // Share of its own name a bird has to be able to lay along its edge, at the
  // ordinary lean ceiling, before the overrun is allowed to curl.
  //
  // Measured over the live set as the outline the chosen run can grow into
  // while a letter standing on it still reads upright, against the longest
  // line it has to carry. Woodhouse's Scrub-Jay reaches 1.38 of its name that
  // way, House Sparrow 0.98, Lesser Goldfinch 1.03, and the tightest bird that
  // is already right, American Robin, 0.41. The three that read as lying
  // across the head reach 0.32, 0.31 and 0.25. The two sets do not overlap and
  // the gate sits in the gap: a bird with an edge keeps the straight overrun it
  // was approved on, and only a bird with no edge to speak of is offered the
  // curl. Swept: below 0.33 the Blackbird and Anna's stop being reached, at
  // 0.41 the Robin starts to curl.
  var LABEL_LEDGE = 0.36;
  // Steepest the overrun may follow the bird round when that gate opens. Past
  // LABEL_DEG on purpose: these are the birds whose back is steeper than a
  // letter may stand, so the choice is between leaning further and leaving the
  // back, and the owner has settled that one - hugging it may lean the name.
  //
  // Swept from 55 to 80 on the three birds it reaches, and it is a straight
  // trade the whole way: the further the letters are allowed to lean, the
  // further round the bird they get and the flatter their gap to it holds.
  // At 68 the Blackbird holds 0.35 to 0.38 em from its first letter to its
  // last, which is the profile of the birds he holds up as right, and Anna's
  // falls from 0.41-1.24 to 0.29-0.79. This is the lowest ceiling that answers
  // all three complaints; 72 and 74 flatten the Black-chinned further, at 68
  // and 72 degrees of lean. Set here because the owner has approved leaning for
  // the sake of hugging but has only ever seen it at 50, so this spends as
  // little of that permission as the complaint allows.
  var LABEL_CURL = 68;
  // Bundle previews always show names. The station's preference and URL
  // override deliberately do not leak into the public catalog.
  function labelsOn() { return true; }
  var labelCtx = document.createElement('canvas').getContext('2d');
  var edgeFitCache = {};
  var tangentFieldCache = {};
  // Widths in em, because advance is exactly linear in font-size and the
  // same few strings get asked for at a dozen sizes each per pack.
  var labelEmCache = {};
  function textEm(s) {
    if (labelEmCache[s] === undefined) {
      labelCtx.font = '600 100px Hand, cursive';
      labelEmCache[s] = labelCtx.measureText(s).width / 100;
    }
    return labelEmCache[s];
  }

  function visualLabelName(name) {
    if (textEm(name) <= LABEL_VISUAL_MAX_EM) return name;
    var points = Array.from(name);
    var suffix = '…';
    var low = 0, high = points.length;
    while (low < high) {
      var mid = Math.ceil((low + high) / 2);
      if (textEm(points.slice(0, mid).join('') + suffix) <= LABEL_VISUAL_MAX_EM) low = mid;
      else high = mid - 1;
    }
    var prefix = points.slice(0, low).join('').replace(/\s+$/, '');
    return (prefix || points[0] || '') + suffix;
  }
  // Label widths are measured against the real face, so the first pack
  // has to wait for it. Otherwise the collage lays out to the fallback's
  // metrics and re-flows a moment later, which the frame's shoot can
  // catch mid-swap.
  var labelFontReady = false;
  var labelFontPromise = null;
  function ensureLabelFont() {
    if (labelFontReady) return Promise.resolve();
    if (labelFontPromise) return labelFontPromise;
    var load = document.fonts && document.fonts.load
      ? document.fonts.load('600 16px Hand') : Promise.resolve();
    labelFontPromise = Promise.resolve(load).catch(function () {})
      .then(function () {
        labelEmCache = {};
        labelFontReady = true;
      });
    return labelFontPromise;
  }

  // One cap for every bird so none shouts louder than another; where the
  // name lands decides how far below that it sits. Keyed on the side of the
  // equal-area square rather than the width alone, which is what stops a
  // heron 37 across and 98 tall being refused a name before a placement is
  // even sought. Keying on the longer side instead would let that same
  // heron take larger type than a dove twice its area.
  function labelCap(W, H) {
    return Math.round(Math.min(LABEL_MAX_PX, Math.sqrt(W * H) * 0.16));
  }

  // Trace the silhouette's outline in order (Moore boundary walk). A
  // per-column profile cannot see a wing's edge, which is exactly where a
  // flying bird's longest straight run lives. Cached per slug: the trace
  // is in mask space, so one result serves the tile at any size.
  function outline(slug, mask) {
    if (edgeFitCache[slug]) return edgeFitCache[slug];
    var w = mask.w, h = mask.h, g = new Uint8Array(w * h), i;
    for (i = 0; i < mask.cells.length; i++) g[mask.cells[i][1] * w + mask.cells[i][0]] = 1;
    var at = function (x, y) { return (x < 0 || y < 0 || x >= w || y >= h) ? 0 : g[y * w + x]; };
    var sx = -1, sy = -1, x, y;
    for (y = 0; y < h && sx < 0; y++) for (x = 0; x < w; x++) if (g[y * w + x]) { sx = x; sy = y; break; }
    if (sx < 0) { edgeFitCache[slug] = false; return false; }
    var NB = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];  // clockwise from west
    var idxOf = function (dx, dy) {
      for (var k = 0; k < 8; k++) if (NB[k][0] === dx && NB[k][1] === dy) return k;
      return 0;
    };
    var pts = [[sx, sy]], bx = sx, by = sy, cx = sx - 1, cy = sy, guard = 0;
    while (guard++ < 20000) {
      var k0 = idxOf(cx - bx, cy - by), found = false;
      for (var t = 1; t <= 8; t++) {
        var j = (k0 + t) % 8, nx = bx + NB[j][0], ny = by + NB[j][1];
        if (at(nx, ny)) {
          cx = bx + NB[(j + 7) % 8][0]; cy = by + NB[(j + 7) % 8][1];
          bx = nx; by = ny; found = true; break;
        }
      }
      if (!found) break;
      if (bx === sx && by === sy && pts.length > 2) break;
      pts.push([bx, by]);
    }
    if (pts.length < 20) { edgeFitCache[slug] = false; return false; }
    // even spacing, then a light smooth so single-pixel stair-steps do not
    // read as curvature
    var rs = [pts[0]], acc = 0;
    for (i = 1; i < pts.length; i++) {
      acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc >= 1.2) { rs.push(pts[i]); acc = 0; }
    }
    var n = rs.length, sm = [];
    for (i = 0; i < n; i++) {
      var ax = 0, ay = 0;
      for (var d = -2; d <= 2; d++) { var q = rs[(i + d + n) % n]; ax += q[0]; ay += q[1]; }
      sm.push([ax / 5, ay / 5]);
    }
    // The cells come along because the tangent tier needs how far the
    // silhouette really reaches in a given direction, and the traced boundary
    // is not that: the trace follows one connected edge, and the smoothing
    // above pulls it a fraction inside the ink it came from.
    edgeFitCache[slug] = { pts: sm, w: w, h: h, at: at, cells: mask.cells };
    return edgeFitCache[slug];
  }

  // What makes an edge worth writing along, as one number in 0..1. Three
  // things break the illusion that the name belongs to the drawing: too
  // little of the name actually riding the bird, a baseline that visibly
  // bows, and a baseline that rakes uphill across the bird. Each is
  // normalised on its own and the three multiplied, so a run has to be
  // respectable at all three rather than buy its way in on one - which is
  // what the old additive score let a big steep label do.
  //
  // Coverage is the share of the name the edge itself carries, and it
  // saturates at one: past the point where the edge holds the whole name,
  // more edge buys nothing. That is what stops a bird's long tail underside
  // beating the shorter, flatter line of its back, which is the reading the
  // owner objected to. Straightness is chord over arc: 0.85 reads as a curve,
  // 0.97 as a line.
  //
  // Lean is a cost, not a cliff. It used to pay out from 40 degrees down and
  // nothing at all at the ceiling, so a run at 54 degrees was worth a fifteenth
  // of a level one and a bird's own back could not outscore a flat stub off its
  // crown at any amount of extra bird beside the name. Every bird the owner
  // approves finishes at 44 to 50 degrees of letter lean, so that curve was
  // pricing the reading he wants at a fraction of the reading he objected to.
  // The ceiling is unchanged: baselineOk still refuses anything past LABEL_DEG.
  //
  // Called with cover 1 it returns the run's shape alone, which is what bounds
  // a finished placement's worth from above.
  function edgeQuality(cover, straight, tilt) {
    var s = (straight - 0.85) / 0.12; if (s < 0) s = 0; if (s > 1) s = 1;
    var l = 1 - (1 - LABEL_LEAN) * tilt / LABEL_DEG; if (l < 0) l = 0;
    return (cover > 1 ? 1 : cover) * s * l;
  }

  // How much bird there is under one point of its own outline: how far a probe
  // pushed inward along the normal stays in ink. A bill, a leg and a tail tip
  // read a few pixels where a mantle reads tens.
  //
  // The inward side is found by probing both ways rather than taken from the
  // winding, because outline() traces from wherever the first ink cell falls
  // and so the sign is not fixed. A short break in the ink is stepped over: at
  // roughly one mask cell per tile pixel a diagonal edge stair-steps, and
  // stopping at the first miss would read every slope in the library as thin.
  function inkDepth(out, W, H, p, tx, ty, cap) {
    var nx = ty, ny = -tx, s, d, miss;
    for (s = 1; s >= -1; s -= 2) {
      if (!out.at(Math.round((p[0] + nx * s * 1.5) / W * out.w),
                  Math.round((p[1] + ny * s * 1.5) / H * out.h))) continue;
      miss = 0;
      for (d = 1.5; d <= cap; d += 0.5) {
        if (out.at(Math.round((p[0] + nx * s * d) / W * out.w),
                   Math.round((p[1] + ny * s * d) / H * out.h))) miss = 0;
        else if (++miss > 4) break;
      }
      return d - miss * 0.5;
    }
    return 0;
  }

  // Rank the runs the name could sit on, best first. Every (start, length)
  // is scored, but only the best run out of each stretch of outline is kept,
  // so the caller gets a handful of genuinely different edges rather than
  // twenty shuffles of one. It needs several because whether a run is clear
  // of the bird's own feet cannot be known until the lettering has been laid
  // out on it.
  //
  // Type size comes from the tile, so a run's length is no longer what sets
  // it: a run that cannot hold the whole name lets the lettering carry on
  // past its ends instead. Length is cashed in for size only when even that
  // overrun would exceed LABEL_EXT, at which point the largest type the run
  // can aim is len / (nameEm - 2 * LABEL_EXT). A name shorter than the
  // overrun budget on both sides has no such limit at all.
  //
  // `minPx` is the smallest type the caller will ever set on these runs, and
  // it is what admits a run to the list; the caller re-checks each run
  // against the size it is actually trying. Admitting at the largest size
  // instead would hide short runs from the very retries that exist to use
  // them.
  //
  // `fitEm` is the shortest line the name might break into, and it too only
  // admits: a run a broken name could ride has to be in the list to be scored
  // at all, or the break is refused before it has been considered. Ranking
  // still uses the whole name, so a bird whose name does not break comes out
  // on exactly the run it was on before.
  //
  // Straightness is measured against the run's own chord, not by summing
  // per-step turning: the outline is resampled every 1.2px and smoothed, so
  // that sum is mostly sampling noise and reads a dead straight back as a
  // curve. Chord over arc catches a run that wanders; the bow at the quarter
  // points catches the S that wanders back and would otherwise pass.
  function pickEdge(out, W, H, nameEm, fitEm, maxPx, minPx) {
    var P = out.pts.map(function (q) { return [q[0] / out.w * W, q[1] / out.h * H]; });
    var n = P.length, seg = [], i, k;
    for (i = 0; i < n; i++) {
      var a = P[i], b = P[(i + 1) % n];
      seg.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    // How steeply a single letter would lean at each point of the outline. On
    // a textPath a glyph stands on the LOCAL tangent, so a run whose chord is
    // level can still finish with letters lying on their side; the chord
    // angle alone was only ever a proxy for the thing the eye objects to.
    // Measured over one letter's width, which is the stretch a glyph really
    // sits on, and read back as a running maximum while each run grows, so
    // the scan stays linear.
    //
    // The width is converted to outline samples rather than used in pixels
    // directly, and never drops below one sample each way. The outline is
    // resampled in MASK space, so on a tile drawn several times its mask a
    // letter is narrower than one segment, and asking for the heading across
    // less than a segment reads the resampling and not the bird - which is
    // what refused a 120px-wide heron a name that an 80px-wide one got.
    var lean = [], hoop = 0;
    for (i = 0; i < n; i++) hoop += seg[i];
    var half = Math.max(3, 0.45 * maxPx) / 2 / (hoop / n);
    var arm = Math.max(1, Math.min(Math.round(n / 4), Math.round(half)));
    for (i = 0; i < n; i++) {
      var q0 = P[(i - arm + n) % n], q1 = P[(i + arm) % n];
      var lv = Math.abs(Math.atan2(q1[1] - q0[1], q1[0] - q0[0]) * 180 / Math.PI);
      lean.push(lv > 90 ? 180 - lv : lv);
    }
    var slack = 2 * LABEL_EXT, minRun = LABEL_RUN * minPx;
    var slot = Math.max(1, Math.round(n * 0.025)), pot = [];
    for (i = 0; i < n; i++) {
      var len = 0, tilt = lean[i];
      for (var L = 0; L < n * 0.62; L++) {
        len += seg[(i + L) % n];
        if (lean[(i + L) % n] > tilt) tilt = lean[(i + L) % n];
        // The running maximum only grows, so a run past the ceiling can never
        // come back under it and neither can anything longer starting here.
        if (tilt >= LABEL_DEG) break;
        if (L < 3) continue;                   // too few samples to have a shape
        var a0 = P[i], a1 = P[(i + L) % n];
        var cx = a1[0] - a0[0], cy = a1[1] - a0[1], chord = Math.hypot(cx, cy);
        // Wrapped so far round the bird that its ends face each other, and
        // nothing longer from this start can be one edge either. Tested from
        // the third sample rather than from the shortest run worth using, so
        // that where the scan gives up is a fact about the bird and not about
        // how large the collage happens to be drawing it: the old order let a
        // heron 120 wide be refused a name that the same heron at 80 was given.
        if (chord < len * 0.5) break;
        // Wandering, but not necessarily for good - a rounded crown ahead of a
        // straight bill dips here and recovers a few samples later.
        if (chord < len * 0.85 || len < minRun) continue;
        // Admitted on the shortest line the name could break into and ranked
        // on the whole name, so a run only half a name could ride reaches the
        // scorer without changing where an unbroken name lands.
        var px = fitEm <= slack ? maxPx
          : Math.min(maxPx, Math.floor(len / (fitEm - slack)));
        if (px < LABEL_MIN_PX) continue;
        var cover = len / (nameEm * px);
        var q = edgeQuality(cover, chord / len, tilt);
        if (q <= 0) continue;
        var g = (i / slot) | 0;
        if (pot[g] && q <= pot[g].q) continue;
        var bow = 0;
        for (k = 1; k <= 3; k++) {
          var m = P[(i + Math.round(L * k / 4)) % n];
          var t = ((m[0] - a0[0]) * cx + (m[1] - a0[1]) * cy) / (chord * chord);
          var d = Math.hypot(m[0] - a0[0] - cx * t, m[1] - a0[1] - cy * t) / chord;
          if (d > bow) bow = d;
        }
        if (bow > LABEL_BOW) continue;
        // shape is the run without its coverage: straight and not raking, and
        // it is what a finished placement's worth is bounded by, since every
        // other term of that worth is a share and cannot exceed one.
        //
        // Straightness here is the BOW, not the chord over the arc that ranks
        // the shortlist. Chord over arc sums the trace's own sampling noise, so
        // a short run is charged twice: once for being short, and again for the
        // noise that being short buys it. On Anna's Hummingbird the nape reads
        // 0.92 by that measure - nominally a curve - while its worst departure
        // from its own chord is two percent of it, which is a line. The
        // shortlist keeps chord over arc because it is the only term there that
        // grows with length and so the only thing holding long runs up; the
        // final choice, which has attachment to judge runs by, does not need it.
        var bend = 1 - (1 - LABEL_BEND) * bow / LABEL_BOW;
        pot[g] = { q: q, i: i, L: L, len: len, deg: tilt, cover: cover,
                   shape: bend * edgeQuality(1, 1, tilt) };
      }
    }
    var list = [];
    for (k = 0; k < pot.length; k++) if (pot[k]) list.push(pot[k]);
    // How far the outline carries on past a run before a letter standing on it
    // would lean past `ceil`, in both directions and capped at `cap`. The run
    // itself is where the scan stopped at LABEL_DEG, so at that ceiling this
    // only recovers what the shortlist's own de-duplication and its
    // straightness test gave up; above it, it is the rest of the bird's back.
    function follow(i0, L0, ceil, cap) {
      var wrap = function (v) { return ((v % n) + n) % n; };
      var a = i0, b = i0 + L0, len = 0, fwd = 0, back = 0, pts = [], k, s;
      for (k = 0; k <= L0; k++) len += seg[wrap(i0 + k)];
      while (len < cap) {
        var okF = lean[wrap(b + 1)] <= ceil, okB = lean[wrap(a - 1)] <= ceil;
        if (!okF && !okB) break;
        // Whichever side has grown the less, so the lettering stays centred on
        // the run that was chosen for it rather than sliding along the bird as
        // one side runs out of edge before the other.
        if (okF && (!okB || fwd <= back)) { s = seg[wrap(b)]; b++; fwd += s; }
        else { a--; s = seg[wrap(a)]; back += s; }
        len += s;
      }
      for (k = a; k <= b; k++) pts.push(P[wrap(k)]);
      return { pts: pts, len: len };
    }
    list.sort(function (x, y) { return y.q - x.q; });
    // Deep enough that a bird with busy feet still has somewhere to go after
    // its best few runs are refused. Building the point list for a run that
    // never gets tried is the only cost, and the search stops at the first
    // run the lettering actually clears.
    list = list.slice(0, 16);
    list.forEach(function (c) {
      c.run = [];
      for (var m = 0; m <= c.L; m++) c.run.push(P[(c.i + m) % n]);
      // What this bird could lay along its own edge if the run were free to
      // grow, which is what says whether it has an edge at all.
      c.ledge = follow(c.i, c.L, LABEL_DEG, nameEm * maxPx).len;
      // Grown to order rather than once and for all: how far the overrun has
      // to reach is a property of the line of the name that ends up riding it,
      // and a curl longer than that only gives the span somewhere to slide to.
      c.grow = function (cap, ceil) { return follow(c.i, c.L, ceil, cap); };
    });
    // Price down the runs that lie along a thin protrusion. A bill is the
    // flattest stretch a hummingbird offers, so it beats the bird's own back on
    // lean and on length at once and the name comes out as a level caption hung
    // over the drawing. The factor goes into the run's shape rather than into a
    // gate of its own: shape is what merit is built from AND what the search's
    // early break bounds a run by, so one multiplication is consistent in both,
    // and a bird whose every edge is thin - a heron, a stilt - is scaled
    // against its own best run and keeps the shortlist it had.
    //
    // Priced rather than filtered because the shortlist is also where a bird
    // with busy feet goes when its good runs are refused: removing the thin
    // runs outright doubled the number of library silhouettes that fell through
    // to a supporting line. Priced this way a bill is still there to be used
    // and is no longer worth using.
    //
    // Depth is held per outline sample and shared between runs that overlap,
    // which is what keeps this off the profile: the probe is the expensive part
    // and there are only ever as many probes as there are samples.
    var dep = [], cap = W > H ? W : H, deep = 0, dsort, m2, sit;
    function depAt(idx) {
      if (dep[idx] === undefined) {
        var a = P[(idx - 1 + n) % n], b = P[(idx + 1) % n];
        var dx = b[0] - a[0], dy = b[1] - a[1], dL = Math.hypot(dx, dy) || 1;
        dep[idx] = inkDepth(out, W, H, P[idx], dx / dL, dy / dL, cap);
      }
      return dep[idx];
    }
    for (k = 0; k < list.length; k++) {
      // The median rather than the mean, because a run that leaves the body for
      // its last two samples is still a run along the body.
      dsort = [];
      for (m2 = 0; m2 <= list[k].L; m2++) dsort.push(depAt((list[k].i + m2) % n));
      dsort.sort(function (x, y) { return x - y; });
      list[k].seat = dsort[dsort.length >> 1];
      if (list[k].seat > deep) deep = list[k].seat;
    }
    for (k = 0; k < list.length; k++) {
      sit = deep > 0 ? list[k].seat / (LABEL_SEAT * deep) : 1;
      list[k].shape *= sit > 1 ? 1 : sit;
    }
    return list;
  }


  // How much silhouette a run of lettering would sit on, as the worst single
  // letter-width window along it. The mean is no use as a gate: one claw
  // through one letter ruins the name while barely moving the average.
  // Sampling the baseline alone is worse than useless - a bird's legs are
  // thinner than the spacing between outline points, so they fall between
  // samples - so this walks the arc and sweeps the whole em band across the
  // LOCAL normal, which is where the glyphs really sit: on a textPath they
  // turn with the path, so a glyph's "up" is the path normal and not the
  // screen's.
  //
  // Both step sizes come from the mask's own resolution rather than being
  // fixed. A tile 52px wide carries a mask 60 cells across, so it is finer
  // than one sample per tile pixel, and a band of 11 rows over 16 cells of
  // mask steps straight over a claw. Undersampling here does not read as
  // noise, it reads as a clean name with a foot drawn through it.
  //
  // Along the arc the rate is doubled, because out.at rounds to the nearest
  // cell and one sample per cell can round two neighbours onto the same cell
  // and skip the one between. Across the band it is not: a claw is long down
  // the page and thin across it, so the rows meet it whatever the spacing,
  // and doubling them costs a third of the time here for nothing.
  function bandInk(out, pts, px, W, H) {
    var res = Math.max(out.w / W, out.h / H);   // mask cells per tile pixel
    var ROWS = Math.max(11, Math.ceil((LABEL_ASC + LABEL_DESC) * px * res) + 1);
    var step = Math.min(1, 1 / (2 * res)), hits = [], i, j, r;
    for (i = 1; i < pts.length; i++) {
      var ax = pts[i - 1][0], ay = pts[i - 1][1];
      var dx = pts[i][0] - ax, dy = pts[i][1] - ay, d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;
      var ux = dx / d, uy = dy / d, n = Math.max(1, Math.round(d / step));
      for (j = 0; j < n; j++) {
        var qx = ax + dx * j / n, qy = ay + dy * j / n, hit = 0;
        for (r = 0; r < ROWS; r++) {
          var e = -LABEL_DESC + (LABEL_ASC + LABEL_DESC) * r / (ROWS - 1);
          if (out.at(Math.round((qx + uy * e * px) / W * out.w),
                     Math.round((qy - ux * e * px) / H * out.h))) hit++;
        }
        hits.push(hit / ROWS);
      }
    }
    if (!hits.length) return 1;               // no geometry is not clean geometry
    var win = Math.max(2, Math.round(px * 0.45 / step)), sum = 0, worst = 0;
    if (hits.length <= win) {
      for (i = 0; i < hits.length; i++) sum += hits[i];
      return sum / hits.length;
    }
    for (i = 0; i < hits.length; i++) {
      sum += hits[i];
      if (i >= win) sum -= hits[i - win];
      if (i >= win - 1 && sum / win > worst) worst = sum / win;
      // Every caller only ever asks whether this exceeds LABEL_INK, and the
      // answer can only get worse as the sweep goes on, so a name laid across
      // a body is answered in its first few letters instead of its last.
      if (worst > LABEL_INK) return worst;
    }
    return worst;
  }

  // How much of the lettering still has the bird beside it. Clearing ink by
  // pushing the name further out has an end state where it floats free of the
  // drawing and has stopped belonging to it, and nothing in the ink test can
  // tell that apart from a good placement, because open paper reads clean
  // either way. Probed along each letter's own normal, which is the direction
  // the glyphs stand in on a textPath, and to both sides, since which side
  // the bird is on is not this test's business.
  function hugShare(out, pts, px, W, H, reachEm) {
    var reach = px * reachEm + LABEL_NEAR, near = 0, all = 0, i, j, d;
    for (i = 1; i < pts.length; i++) {
      var ax = pts[i - 1][0], ay = pts[i - 1][1];
      var dx = pts[i][0] - ax, dy = pts[i][1] - ay, L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      var nx = -dy / L, ny = dx / L, n = Math.max(1, Math.round(L));
      for (j = 0; j < n; j++) {
        var x = ax + dx * j / n, y = ay + dy * j / n;
        all++;
        for (d = 0; d <= reach; d += 2) {
          if (out.at(Math.round((x + nx * d) / W * out.w), Math.round((y + ny * d) / H * out.h)) ||
              out.at(Math.round((x - nx * d) / W * out.w), Math.round((y - ny * d) / H * out.h))) {
            near++; break;
          }
        }
      }
    }
    return all ? near / all : 0;
  }

  // Push the run off the silhouette, every point along its own outward
  // normal so a curving edge keeps an even gap instead of drifting into the
  // ink at its ends. Letters grow upward from the baseline, so where the
  // normal points down (the name sits under the bird) that growth heads back
  // into the silhouette and the baseline has to clear a whole ascender;
  // pointing up it only has to clear the descenders. The steepest point of
  // the run sets the gap for all of it, so no letter dips in. `lift` buys
  // extra clearance when a first try landed on ink.
  //
  // Which way is out is settled by which side carries less ink over the depth
  // the lettering will occupy, summed down the whole run. Probing one side at
  // one fixed depth reads a heron's bill - thinner than the probe is long -
  // as open underneath, and lays the name back down through the bird's neck.
  //
  // The normal is read over about half an em of outline rather than over a
  // fixed number of samples, because samples are spaced by the mask's
  // resolution, which has nothing to do with how far the run is about to be
  // pushed: on a small bird a two-sample window turns with every wobble in
  // the trace and the offset line folds back through itself.
  //
  // `under` says the lettering ended up below the bird, which is what the
  // caller needs in order to stack a second line further out rather than back
  // through the drawing.
  function offsetRun(run, out, W, H, px, lift) {
    var n = run.length, nx = [], ny = [], plus = 0, minus = 0, down = 0, i, d, arc = 0;
    for (i = 1; i < n; i++)
      arc += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
    var win = Math.max(2, Math.round(px * 0.6 * (n - 1) / (arc || 1)));
    for (i = 0; i < n; i++) {
      var a = run[Math.max(0, i - win)], b = run[Math.min(n - 1, i + win)];
      var vx = -(b[1] - a[1]), vy = (b[0] - a[0]), L = Math.hypot(vx, vy) || 1;
      nx.push(vx / L); ny.push(vy / L);
      for (d = 1; d <= 3; d++) {
        var probe = d * px * 0.35;
        if (out.at(Math.round((run[i][0] + vx / L * probe) / W * out.w),
                   Math.round((run[i][1] + vy / L * probe) / H * out.h))) plus++;
        if (out.at(Math.round((run[i][0] - vx / L * probe) / W * out.w),
                   Math.round((run[i][1] - vy / L * probe) / H * out.h))) minus++;
      }
    }
    var side = plus <= minus ? 1 : -1, lean = 0;
    for (i = 0; i < n; i++) {
      if (ny[i] * side > down) down = ny[i] * side;
      lean += ny[i] * side;
    }
    var gap = LABEL_NEAR + px * (LABEL_DESC + (LABEL_ASC - LABEL_DESC) * down + (lift || 0));
    var outp = [];
    for (i = 0; i < n; i++)
      outp.push([run[i][0] + nx[i] * side * gap, run[i][1] + ny[i] * side * gap]);
    return { pts: outp, under: lean > 0 };
  }

  // Total length of a polyline, which is what decides whether a span has to
  // be extended at all and how much of it the edge itself supports.
  function arcLen(pts) {
    var total = 0, i;
    for (i = 1; i < pts.length; i++)
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return total;
  }

  // Cut the span centred on the run's arc midpoint, exactly as long as the
  // name, carrying on in a straight ray past either end when the edge is
  // shorter. Centring on the edge is what stops a name sitting off at one end
  // of a long wing.
  //
  // Both rays run along the run's own chord, which is the line the edge
  // draws. Aiming them by the tangent at each end instead - by the final pair
  // of points, or by the chord of the last stretch - reads the resampling and
  // splays the two ends apart, and multiplying that by an extension several
  // times the run's own length is what once sent a name hundreds of pixels
  // off a small tile. Measured over the library, the chord beats every
  // partial tangent on placement, on ink and on how far a name wanders.
  //
  // `toward` is the middle of the tile, and it only does anything when the
  // name is longer than the edge. In that case every offset within the
  // overrun still leaves the WHOLE edge underneath the lettering, so which
  // one is taken cannot cost the name any of its bird; and the offset that
  // sits over the tile rather than over the run's own midpoint is worth
  // taking, because the packer reserves the lettering and paper claimed out
  // past a bird's corner is paper a neighbour cannot nest into. Where the
  // edge is the longer of the two there is no slack and the span is centred
  // on the edge, which is what stops a name sitting off at one end of a wing.
  function centredSpan(pts, want, toward) {
    var seg = [], total = 0, i;
    for (i = 1; i < pts.length; i++) {
      var d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d); total += d;
    }
    if (total <= 0) return pts;
    function on(t) {
      if (t <= 0) return pts[0];
      var acc = 0;
      for (var k = 0; k < seg.length; k++) {
        if (acc + seg[k] >= t) {
          var f = (t - acc) / seg[k];
          return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f,
                  pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f];
        }
        acc += seg[k];
      }
      return pts[pts.length - 1];
    }
    var head = pts[0], tail = pts[pts.length - 1];
    var cx = tail[0] - head[0], cy = tail[1] - head[1];
    var cL = Math.hypot(cx, cy) || 1;
    var at = function (t) {
      if (t < 0) return [head[0] + cx / cL * t, head[1] + cy / cL * t];
      if (t > total) return [tail[0] + cx / cL * (t - total), tail[1] + cy / cL * (t - total)];
      return on(t);
    };
    var mid = total / 2, half = want / 2, outp = [];
    if (toward && want > total) {
      var slack = (want - total) / 2;
      var u = ((toward[0] - head[0]) * cx + (toward[1] - head[1]) * cy) / (cL * cL) * total;
      mid = Math.max(mid - slack, Math.min(mid + slack, u));
    }
    var steps = Math.max(2, Math.round(want / 6));
    for (i = 0; i <= steps; i++) outp.push(at(mid - half + want * i / steps));
    // What the browser measures is this polyline, and its chords cut the
    // corners of the arc they were sampled from, so where the run curves
    // inside the span it comes out shorter than the length asked for. A path
    // even a third of a pixel short of its string silently drops a glyph off
    // the end, so the two ends are pushed out along their own headings until
    // the polyline is as long as the name was told it would be.
    var got = arcLen(outp), pad = (want - got) / 2;
    if (pad > 0 && outp.length > 1) {
      outp[0] = nudge(outp[0], outp[1], pad);
      outp[outp.length - 1] = nudge(outp[outp.length - 1], outp[outp.length - 2], pad);
    }
    return outp;
  }

  // One point moved `d` further away from another, along the line between
  // them. Used to make a sampled span up to its full length.
  function nudge(from, toward, d) {
    var dx = from[0] - toward[0], dy = from[1] - toward[1];
    var L = Math.hypot(dx, dy) || 1;
    return [from[0] + dx / L * d, from[1] + dy / L * d];
  }

  // A finished baseline pushed `d` further off the bird, which is how every
  // line of a broken name after the one against the silhouette is made.
  // Derived from the line the run itself carries rather than from a second
  // offset of the run: two offsets of a traced outline are not one curve twice
  // over, and where the outline bends tightly the same point of the bird lands
  // in different places on them, which slides the lines of a name apart.
  //
  // Each vertex moves along the bisector of the two segments meeting there,
  // and far enough along it that both segments end up the full d from the ones
  // they came from. Pushing every point along an averaged normal instead
  // leaves the segments closer than d wherever the line bends, and the lower
  // line's ascenders come up into the upper line's descenders.
  function stack(base, away, d, want) {
    var n = base.length, outp = [], nx = [], ny = [], i, dx, dy, L, mx, my, m;
    for (i = 1; i < n; i++) {
      dx = base[i][0] - base[i - 1][0]; dy = base[i][1] - base[i - 1][1];
      L = Math.hypot(dx, dy) || 1;
      nx.push(dy / L * away); ny.push(-dx / L * away);
    }
    for (i = 0; i < n; i++) {
      var j = i ? i - 1 : 0, k = i < n - 1 ? i : n - 2;
      mx = nx[j] + nx[k]; my = ny[j] + ny[k];
      L = Math.hypot(mx, my) || 1;
      mx /= L; my /= L;
      // The baseline may not turn as far as LABEL_DEG in one step, so the
      // reach along the bisector never exceeds d by more than about a tenth
      // and needs no mitre limit; the floor is there for arithmetic, not art.
      m = mx * nx[j] + my * ny[j];
      if (m < 0.5) m = 0.5;
      outp.push([base[i][0] + mx * d / m, base[i][1] + my * d / m]);
    }
    // A bend stretches the outside of itself and squeezes the inside, so the
    // pushed line comes back a little longer or shorter than the line it came
    // from. A path even a third of a pixel short of its string silently drops
    // a glyph off the end.
    var pad = (want - arcLen(outp)) / 2;
    if (pad > 0 && n > 1) {
      outp[0] = nudge(outp[0], outp[1], pad);
      outp[n - 1] = nudge(outp[n - 1], outp[n - 2], pad);
    }
    return outp;
  }

  // Is this baseline fit to set a name on? Two ways it is not, both properties
  // of what will be drawn rather than of the run it came from, which is why
  // neither can be settled while ranking edges.
  //
  // A segment leaning past LABEL_DEG lays a letter on its side, and one
  // turning that far from the segment before it puts a chevron in the middle
  // of the word - two letters either side of the limit are each upright enough
  // on their own. The run's own lean does not settle either: pushing the run
  // clear of the silhouette sharpens the curves that turn in on themselves.
  //
  // A segment running backwards along the span's own chord stacks letters on
  // top of one another. Offsetting a run whose edge curls tightly crosses
  // neighbouring normals over each other and the polyline folds; the fold is
  // short, so it barely moves any average, and it wrecks the word.
  //
  // The span is cut into six-pixel steps, near enough one letter at these
  // sizes, so each segment stands for a letter.
  function baselineOk(pts, ceil) {
    var ax = pts[pts.length - 1][0] - pts[0][0], ay = pts[pts.length - 1][1] - pts[0][1];
    var aL = Math.hypot(ax, ay) || 1, i, dx, dy, d, was = null;
    if (!ceil) ceil = LABEL_DEG;
    for (i = 1; i < pts.length; i++) {
      dx = pts[i][0] - pts[i - 1][0]; dy = pts[i][1] - pts[i - 1][1];
      if ((dx * ax + dy * ay) / aL <= 0) return false;
      d = Math.atan2(dy, dx) * 180 / Math.PI;
      if (was !== null && Math.abs(d - was) >= LABEL_DEG) return false;
      was = d;
      if (d > 90) d = 180 - d; else if (d < -90) d = -180 - d;
      if (Math.abs(d) >= ceil) return false;
    }
    return true;
  }

  // Last resort, and the reason no bird is left bare: a straight line drawn
  // tangent to the silhouette. Every shape has one at every angle on both
  // sides, so this always yields somewhere to write, and because the whole em
  // band sits outside the supporting line the lettering is clear of ink by
  // construction rather than by test. That is what makes the coverage a
  // property of the rule: a silhouette added to the library in a year cannot
  // go unnamed because its geometry happened to defeat the search.
  //
  // Angle and side are chosen for how much of the name ends up with the bird
  // beside it, divided down as the line rakes, so a line the bird half-hugs
  // at the level beats one it hugs all along on a slope. A supporting line is
  // not a line the bird drew, so it has nothing to justify a rake with.
  function tangentSpan(out, W, H, px, want) {
    var cells = out.cells, sx = W / out.w, sy = H / out.h, i, k, s, best = null;
    var cx = 0, cy = 0;
    for (i = 0; i < cells.length; i++) { cx += cells[i][0]; cy += cells[i][1]; }
    cx = cx / cells.length * sx; cy = cy / cells.length * sy;
    for (k = -LABEL_TAN; k <= LABEL_TAN; k += 5) {
      var th = k * Math.PI / 180, ux = Math.cos(th), uy = Math.sin(th);
      var nx = uy, ny = -ux;                  // where the ascenders point
      var hi = -Infinity, lo = Infinity;
      for (i = 0; i < cells.length; i++) {
        var dd = cells[i][0] * sx * nx + cells[i][1] * sy * ny;
        if (dd > hi) hi = dd;
        if (dd < lo) lo = dd;
      }
      // out.at rounds a tile point to the nearest mask cell, so a cell's ink
      // reaches half a cell past its own centre along each axis.
      var half = Math.abs(nx) * sx / 2 + Math.abs(ny) * sy / 2;
      var t = cx * ux + cy * uy;
      for (s = 0; s < 2; s++) {
        // Above the bird only the descenders reach back towards it; below it
        // the whole ascender does, which is why a name set under a bird takes
        // the deeper offset to keep its letters out of the feet.
        var c = s ? hi + half + LABEL_NEAR + LABEL_DESC * px
                  : lo - half - LABEL_NEAR - LABEL_ASC * px;
        var pts = [[c * nx + (t - want / 2) * ux, c * ny + (t - want / 2) * uy],
                   [c * nx + (t + want / 2) * ux, c * ny + (t + want / 2) * uy]];
        var score = hugShare(out, pts, px, W, H, 1.3) / (1 + Math.abs(k) / LABEL_TAN);
        if (!best || score > best.score) best = { score: score, deg: Math.abs(k), pts: pts };
      }
    }
    return best;
  }

  // The production outline walker starts at the first ink cell. That is right
  // for the station's connected cutouts, but a gestural preview can carry a
  // tiny detached stroke above the bird. If that first component is too short
  // to trace, retain the production guarantee by giving its final tangent tier
  // a field made from the complete mask. This does not invent a contour or
  // perturb successful plans; it only supplies the silhouette lookup and cells
  // tangentSpan already uses.
  function tangentField(slug, mask) {
    if (tangentFieldCache[slug]) return tangentFieldCache[slug];
    var width = mask.w, height = mask.h;
    var grid = new Uint8Array(width * height);
    for (var i = 0; i < mask.cells.length; i++) {
      grid[mask.cells[i][1] * width + mask.cells[i][0]] = 1;
    }
    var field = {
      w: width,
      h: height,
      cells: mask.cells,
      at: function (x, y) {
        return x < 0 || y < 0 || x >= width || y >= height
          ? 0 : grid[y * width + x];
      },
    };
    tangentFieldCache[slug] = field;
    return field;
  }

  function tangentPlan(out, name, W, H, maxPx) {
    var nameEm = textEm(name);
    var tanPx = Math.max(LABEL_MIN_PX,
                         Math.min(maxPx, Math.floor(LABEL_REACH * W / nameEm)));
    var tan = tangentSpan(out, W, H, tanPx, nameEm * tanPx + 4);
    return tan ? { px: tanPx, rows: [{ pts: tan.pts, text: name }], q: 0, deg: tan.deg }
               : null;
  }

  // How much of a whole label still has the bird beside it, over however many
  // lines it takes, each line counting for its own length. This is what the
  // owner reads as the name belonging to the drawing, and what a name that
  // overruns its edge in both directions fails: the middle has bird under it
  // and the two ends are out over open paper.
  function hugRows(out, rows, px, W, H, reachEm) {
    var near = 0, all = 0, i, L;
    for (i = 0; i < rows.length; i++) {
      L = arcLen(rows[i].pts);
      near += hugShare(out, rows[i].pts, px, W, H, reachEm) * L;
      all += L;
    }
    return all ? near / all : 0;
  }

  // Where a name may break. Two lines are not a caption stacked in a clearing:
  // both ride the same edge, one further out along the same normals. What
  // breaking buys is that half a name needs half the run, so a bird whose only
  // long edge is shorter than its own name can hold the whole thing beside
  // itself instead of trailing it off both ends.
  //
  // Breaks are offered at the spaces only, and the evenest wins. Not at the
  // hyphens: a hyphen in a bird's name sits inside a compound the name is built
  // from, so breaking there gives "Great Black- / backed Gull" and "American
  // Three- / toed Woodpecker", which read as a line that ran out of room rather
  // than as a name written on two. Measured on the real face over the names
  // outside this collage, a hyphen break is always the evener one, so shading it
  // against the spaces cannot settle it; only refusing it does. A name with no
  // space does not break at all, which is right: there is no reading of Mallard
  // on two lines. Returns the whole name first and the break second, so a caller
  // that wants one line takes the head of the list.
  function breakName(name) {
    var lays = [{ rows: [name], em: textEm(name) }];
    var best = null, i, a, b, ea, eb, even;
    for (i = 1; i < name.length - 1; i++) {
      if (name.charAt(i) !== ' ') continue;
      a = name.slice(0, i); b = name.slice(i + 1);
      ea = textEm(a); eb = textEm(b);
      even = ea < eb ? ea / eb : eb / ea;
      if (even < LABEL_EVEN) continue;
      if (!best || even > best.even)
        best = { even: even, rows: [a, b], em: ea > eb ? ea : eb };
    }
    if (best) lays.push({ rows: best.rows, em: best.em });
    return lays;
  }

  // Choose the line this bird's name rides, and hand back the baselines to set
  // it on. Runs of the bird's own outline are tried best first, and nothing is
  // accepted until the lettering has been proved clear of the ink and still
  // beside the bird. If every run fails, the whole list is retried smaller, a
  // point at a time: smaller type sits closer in, sweeps a shallower band and
  // needs less run to carry it, which is usually all a bird with busy feet
  // needs. Only when no run works at any size does the name go on a
  // supporting line instead, so a bird that has an edge always gets the edge.
  //
  // Two passes, and the first one is the search this engine has always done:
  // the whole name on one line, on the best run that will take it. Where that
  // comes out snug against the bird and reserving little paper, it is taken and
  // nothing else is tried, which is what keeps the birds already approved
  // exactly where they are - weighing edges against each other and breaking a
  // name are answers to problems those birds do not have.
  //
  // The second pass is for the birds the first one fails: a name that took a
  // short level stretch off a crown and then overran it in both directions, so
  // the drawing is only under its middle. Every run is laid out in full and the
  // FINISHED lettering is scored, on how much of it has bird beside it above
  // all. That can only be measured once the name is set; ranking runs by their
  // own shape and length, as the first pass does, is a guess at it, and it is
  // the guess that put those names on the crown.
  function planLabel(out, name, W, H, maxPx) {
    var lays = breakName(name), nameEm = lays[0].em, i, j, px, rode, best;
    // Four points is as far as the type will give ground to find an edge.
    // Further down it is conceding more than being on the bird's own line is
    // worth, and a supporting line at full size reads better than a contour
    // at half of it.
    var floorPx = Math.max(LABEL_MIN_PX, maxPx - 4);
    var cands = pickEdge(out, W, H, nameEm, lays[lays.length - 1].em, maxPx, floorPx);
    var mid = [W / 2, H / 2], slack = 2 * LABEL_EXT;
    // How far the lettering's own box reaches past the tile.
    function spill(rows, px) {
      var b = labelBounds(rows, px);
      return Math.max(-b.dx0, -b.dy0, b.dx1 - W, b.dy1 - H);
    }
    // Open paper the lettering reserves outside its own tile, as a share of the
    // tile. The worst edge decides how far a neighbour is pushed away; the area
    // is what the packer actually loses, and it is the only one of the two that
    // can say whether breaking a name paid, since a break trades a deeper box
    // for a much narrower one.
    function lost(rows, px) {
      var b = labelBounds(rows, px);
      var ox = Math.max(0, Math.min(b.dx1, W) - Math.max(b.dx0, 0));
      var oy = Math.max(0, Math.min(b.dy1, H) - Math.max(b.dy0, 0));
      return ((b.dx1 - b.dx0) * (b.dy1 - b.dy0) - ox * oy) / (W * H);
    }
    // Lay one setting of the name out on one run and hand back the lettering
    // with the two things it is judged on: how much of it has bird beside it,
    // and how much open paper it reserves off the tile.
    function set(c, px, lay, ceil) {
      var n = lay.rows.length, want = [], ranks = [], wide = 0, k, m, r, em;
      if (!ceil) ceil = LABEL_DEG;
      for (r = 0; r < n; r++) {
        em = textEm(lay.rows[r]);
        want.push(em * px + 4);
        if (want[r] > want[wide]) wide = r;
      }
      for (k = 0; k < LABEL_LIFT.length; k++) {
        // Rank counts outwards from the line against the bird, which is the
        // first line where the name sits under the bird - its ascenders are
        // what has to clear the ink - and the last line where it sits above.
        var off = offsetRun(c.run, out, W, H, px, LABEL_LIFT[k]);
        for (r = 0; r < n; r++) ranks[r] = off.under ? r : n - 1 - r;
        // The widest line is the one the run carries, at whatever clearance the
        // silhouette forces at its own rank; the shorter lines are stacked off
        // it. So it is the long line that follows the bird most closely, rather
        // than whichever line happens to be written first.
        var p = ranks[wide] ? offsetRun(c.run, out, W, H, px,
                                        LABEL_LIFT[k] + ranks[wide] * LABEL_LEAD).pts
                            : off.pts;
        if (p[p.length - 1][0] < p[0][0]) p = p.slice().reverse();   // read left to right
        var arc = arcLen(p), away = off.under ? -1 : 1;
        // Every line is cut out of the widest line's own span before it is
        // pushed, so the lines are centred on each other by construction
        // whatever each one's overrun is, and a short line can never run past
        // a long one.
        // A function expression rather than a declaration: this sits inside the
        // clearance loop and closes over that rung's own ranks and side, and a
        // declaration in a block is not ES5.
        var spread = function (base) {
          var rows = [], r2, d, core;
          for (r2 = 0; r2 < n; r2++) {
            d = (ranks[r2] - ranks[wide]) * LABEL_LEAD * px;
            core = r2 === wide ? base : centredSpan(base, want[r2]);
            rows.push({ pts: d ? stack(core, away, d, want[r2]) : core,
                        text: lay.rows[r2] });
          }
          return rows;
        };
        var try2 = [spread(centredSpan(p, want[wide]))];
        // Where the name is longer than its edge, the tile-centred offset is
        // worth trying ahead of the edge-centred one when it reaches less far
        // past the tile. It is not always the tighter of the two: sliding
        // along a tilted chord trades reach sideways for reach above or
        // below, and a bird's own corner is sometimes the nearest thing to
        // the middle of its tile. Whichever loses is still tried, because
        // being tighter does not make it clear of the bird's feet.
        if (want[wide] > arc) {
          var alt = spread(centredSpan(p, want[wide], mid));
          if (spill(alt, px) < spill(try2[0], px)) try2.unshift(alt);
          else try2.push(alt);
        }
        for (m = 0; m < try2.length; m++) {
          var rows = try2[m], good = true;
          for (r = 0; r < n && good; r++) {
            if (!baselineOk(rows[r].pts, ceil)) { good = false; break; }
            if (bandInk(out, rows[r].pts, px, W, H) > LABEL_INK) { good = false; break; }
            // Only the stretch the edge itself supports is asked to hug the
            // bird. Past that the lettering is out in open paper on purpose,
            // and charging it for that would refuse a name to every bird whose
            // edges are shorter than its own name. Where the run is the longer
            // of the two this is the line itself, exactly as before.
            // A line that sits further out by construction - because it was
            // lifted off ink, or because it is stacked off the line that was -
            // is judged against a reach that grows the same way.
            if (hugShare(out, centredSpan(rows[r].pts, Math.min(want[r], arc)),
                         px, W, H, 1.3 + LABEL_LIFT[k] + ranks[r] * LABEL_LEAD) < LABEL_ADHERE)
              good = false;
          }
          if (good)
            return { rows: rows, att: hugRows(out, rows, px, W, H, LABEL_BESIDE),
                     lost: lost(rows, px) };
        }
      }
      return null;
    }
    // What a finished placement is worth. Attachment is the term that answers
    // the complaint, and it is raised to a power: counted once, the difference
    // between a name two thirds beside its bird and one wholly beside it is
    // worth less than a few degrees of tilt, which is how a level stub off a
    // crown kept beating a back edge. Coverage is demoted rather than dropped -
    // at full weight it is a second, worse measurement of what attachment now
    // measures directly, and it is what bounded the back edges out of
    // contention. Attachment, the paper term and the wrapping handicap are all
    // shares that can only bring a plan down, so shape times coverage bounds the
    // whole thing from above, which is what lets the search stop early.
    function merit(c, lay, got) {
      var hold = LABEL_HOLD + (1 - LABEL_HOLD) * (c.cover > 1 ? 1 : c.cover);
      return c.shape * hold * Math.pow(got.att, LABEL_ATT) / (1 + got.lost) *
             (lay.rows.length > 1 ? LABEL_KEEP : 1);
    }
    // The run and the setting come along so that the last look below can offer
    // the same run a different overrun; the packer reads only px and rows.
    function planned(c, lay, px, got) {
      return { px: px, rows: got.rows, q: c.q, deg: c.deg, att: got.att,
               lost: got.lost, merit: merit(c, lay, got), cand: c, lay: lay };
    }
    function fits(c, lay, px, broken) {
      if (c.len < LABEL_RUN * px) return false;
      // A name that can be written across its own drawing is not broken. The
      // second line can only sit further off the bird than the first, so there
      // has to be something one line cannot do before that is worth paying for.
      if (broken && nameEm * px <= W) return false;
      // Length is cashed in for size only where even the overrun budget cannot
      // cover the shortfall, and a broken name has a shorter line to answer for
      // than the whole name does.
      return !(lay.em > slack && c.len < (lay.em - slack) * px);
    }
    // The last look at whichever plan won. A bird whose own edge cannot carry
    // LABEL_LEDGE of its name has a name that leaves the drawing whichever way
    // it is aimed - the run points, and three quarters of the word is a
    // straight ray off its ends that the bird curves away from - so following
    // the bird round is the only reading left in it. Every bird with an edge
    // keeps the straight overrun it was approved on, untouched.
    //
    // Offered to the run already chosen and to nothing else, and taken only if
    // the lettering comes out legal and no further off the bird than it was, so
    // this can lose the search nothing: what it cannot improve it leaves alone.
    // Judged AFTER the choice rather than during it, because a run's ledge is a
    // fact about the bird and the choice is not: gating the search itself let a
    // curl on a run that was never going to win change which run did.
    function hug(p) {
      if (!p || !p.cand || !p.cand.grow) return p;
      var wide = 0, r, em;
      for (r = 0; r < p.lay.rows.length; r++) {
        em = textEm(p.lay.rows[r]);
        if (em > textEm(p.lay.rows[wide])) wide = r;
      }
      var want = textEm(p.lay.rows[wide]) * p.px + 4;
      if (p.cand.ledge >= LABEL_LEDGE * want) return p;
      // The shallowest ceiling that gets the whole line onto the bird. Lean is
      // what the reach costs, so it is spent a degree at a time and stops being
      // spent the moment the edge is long enough: a back that carries its name
      // at sixty-seven is not tipped to sixty-eight for the sake of a constant.
      // Growing walks lengths already measured, so the ladder costs a loop and
      // the one setting it leads to. Across the library it takes 41 placements
      // back under sixty degrees and changes nothing else, and on the live set
      // it is the Blackbird, which needs 67 and is charged 67.
      var ceil = LABEL_DEG, grown, got;
      do { ceil++; grown = p.cand.grow(want, ceil); } while (grown.len < want && ceil < LABEL_CURL);
      got = set({ run: grown.pts }, p.px, p.lay, ceil);
      // A ceiling long enough to carry the line is not the same as one the
      // lettering will take. Where the shallow rung is refused the full curl is
      // still there to be tried, so the ladder can only ever save lean and
      // never cost a bird its curl.
      if ((!got || got.att < p.att) && ceil < LABEL_CURL) {
        ceil = LABEL_CURL;
        got = set({ run: p.cand.grow(want, ceil).pts }, p.px, p.lay, ceil);
      }
      if (!got || got.att < p.att) return p;
      p.rows = got.rows; p.att = got.att; p.lost = got.lost;
      return p;
    }
    // Snug against the bird and reserving little paper beside it. Nothing a
    // second line or another edge could fix, so the search stops on it.
    function done(p) {
      return p && p.att >= LABEL_SNUG && p.lost <= LABEL_ROOM;
    }
    // Best a run could possibly finish at: attachment, the paper it reserves and
    // the wrapping handicap are all shares that can only bring it down. Pass two
    // walks the runs in this order and stops the moment the standing plan beats
    // what is left, which is exact - the same plan comes out as scoring all
    // sixteen - and is what keeps the second pass affordable.
    var order = cands.map(function (c, k) { return k; });
    function bound(c) {
      return c.shape * (LABEL_HOLD + (1 - LABEL_HOLD) * (c.cover > 1 ? 1 : c.cover));
    }
    order.sort(function (a, b) { return bound(cands[b]) - bound(cands[a]); });
    for (px = maxPx; px >= floorPx; px--) {
      best = null;
      // Cleared for the whole list rather than as the loop goes, because the
      // loop stops at its winner and the runs past it would keep a mark left
      // over from the size before.
      for (i = 0; i < cands.length; i++) cands[i].plain = false;
      for (i = 0; i < cands.length; i++) {
        if (!fits(cands[i], lays[0], px, false)) continue;
        cands[i].plain = true;
        rode = set(cands[i], px, lays[0]);
        if (rode) { best = planned(cands[i], lays[0], px, rode); break; }
      }
      if (done(best)) return hug(best);
      // Otherwise the name is trailing off its edge, or reserving a corner of
      // the collage to do it, and every run is looked at again with the name
      // free to break in two. Runs ahead of the one the plain setting took are
      // not offered one line again, having just refused it.
      //
      // Whatever comes back may not have LESS of the name beside the bird than
      // the plain setting already had. Without that floor the second look sells
      // attachment back for a straighter run, which is the whole defect in
      // reverse. Once attachment is good enough there is nothing left to
      // protect, so the floor stops at LABEL_SNUG and a name may still give a
      // little of it up to stop reserving open paper.
      var floor = best ? Math.min(LABEL_SNUG, best.att) : 0;
      for (i = 0; i < order.length && !done(best); i++) {
        var c = cands[order[i]];
        // Nothing left in the list can beat what is standing.
        if (best && bound(c) <= best.merit) break;
        for (j = 0; j < lays.length; j++) {
          // One line has already been offered to every run pass one reached,
          // and refused by all of them but the one whose result is standing.
          if (!j && c.plain) continue;
          if (!fits(c, lays[j], px, j > 0)) continue;
          rode = set(c, px, lays[j]);
          if (!rode || rode.att < floor) continue;
          if (!best || merit(c, lays[j], rode) > best.merit)
            best = planned(c, lays[j], px, rode);
        }
      }
      if (best) return hug(best);
    }
    // Keyed on the tile's WIDTH, because a supporting line is near enough
    // level and so the name runs across the bird rather than up it. Keyed on
    // the longer side instead, a treecreeper drawn 110 across and 260 tall
    // takes type sized for the 260 and reserves ninety pixels of open paper
    // at each end of itself.
    return tangentPlan(out, name, W, H, maxPx);
  }

  // Reserve what the glyphs really cover, so the packer keeps neighbours off
  // the lettering as well as off the bird. The band is swept the way the
  // glyphs stand on it - perpendicular to the local heading - because on a
  // tilted run the ascenders lean out sideways past the baseline's own box,
  // and boxing the baseline alone lets a neighbour nest into them. Taken over
  // every line of the name at once: a broken name is one label to the packer,
  // and reserving its lines separately leaves the leading between them open
  // for a neighbour to nest into.
  function labelBounds(rows, px) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, r, i, s;
    for (r = 0; r < rows.length; r++) {
      var pts = rows[r].pts;
      for (i = 0; i < pts.length; i++) {
        var j = i ? i - 1 : 1, dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
        if (i === 0) { dx = -dx; dy = -dy; }
        var L = Math.hypot(dx, dy) || 1, nx = dy / L, ny = -dx / L;
        for (s = -1; s <= 1; s += 2) {
          var e = s < 0 ? -LABEL_DESC : LABEL_ASC;
          var bx = pts[i][0] + nx * e * px, by = pts[i][1] + ny * e * px;
          if (bx < x0) x0 = bx; if (bx > x1) x1 = bx;
          if (by < y0) y0 = by; if (by > y1) y1 = by;
        }
      }
    }
    return { dx0: x0 - LABEL_GAP, dx1: x1 + LABEL_GAP,
             dy0: y0 - LABEL_GAP, dy1: y1 + LABEL_GAP };
  }

  // The ascender/descender sweep of one stretch of a baseline (points
  // [start..end]), boxed and gapped the same way labelBounds does the whole
  // run. Shared by labelBounds' finer sibling below.
  function sweepBox(pts, start, end, px) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, i, s;
    for (i = start; i <= end; i++) {
      var j = i ? i - 1 : 1, dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      if (i === 0) { dx = -dx; dy = -dy; }
      var L = Math.hypot(dx, dy) || 1, nx = dy / L, ny = -dx / L;
      for (s = -1; s <= 1; s += 2) {
        var e = s < 0 ? -LABEL_DESC : LABEL_ASC;
        var bx = pts[i][0] + nx * e * px, by = pts[i][1] + ny * e * px;
        if (bx < x0) x0 = bx; if (bx > x1) x1 = bx;
        if (by < y0) y0 = by; if (by > y1) y1 = by;
      }
    }
    return { dx0: x0 - LABEL_GAP, dx1: x1 + LABEL_GAP,
             dy0: y0 - LABEL_GAP, dy1: y1 + LABEL_GAP };
  }
  // The same swept band as labelBounds, but broken into a handful of sub-boxes
  // that follow the baseline instead of one axis-aligned box spanning the whole
  // run. A tilted or two-line name then reserves only its lettering and frees
  // the corners of its bounding box, so a neighbour nests into them the way it
  // does against the bird itself - which is what stops a label from opening a
  // bird-sized gap the packer can't close. The on-screen bounds and the label
  // SVG still use the single labelBounds box; only the packer reads these.
  var LABEL_CHUNK = 4;   // baseline points per sub-box; fewer hugs a curve closer
  function labelCells(rows, px) {
    var cells = [], r, n, start, end;
    for (r = 0; r < rows.length; r++) {
      var pts = rows[r].pts;
      n = pts.length;
      if (n === 0) continue;
      if (n === 1) { cells.push(sweepBox(pts, 0, 0, px)); continue; }
      // Overlapping stretches (each starts on the previous one's last point)
      // so consecutive boxes share an edge and leave no gap in the band.
      for (start = 0; start < n - 1; start += LABEL_CHUNK) {
        end = Math.min(n - 1, start + LABEL_CHUNK);
        cells.push(sweepBox(pts, start, end, px));
      }
    }
    return cells;
  }

  function assignLabels(tiles) {
    // Recomputed before every pack: the shrink loop rescales tiles, and the
    // placement has to be re-measured against the new silhouette size.
    var on = labelsOn();
    tiles.forEach(function (t) {
      t.labelBox = null; t.labelRows = null; t.labelPx = 0; t.labelCells = null;
      if (!on) return;
      var name = t.data.com || t.data.sci;
      if (!name) return;
      name = visualLabelName(name);
      // A quiet bird may have a very small tile, but names-on still means
      // every bird is named. The tangent fallback can carry readable type
      // beyond the silhouette, and the packer reserves that whole label.
      var maxPx = Math.max(LABEL_MIN_PX, labelCap(t.fullW, t.fullH));
      var out = outline(t.slug, t.mask);
      var plan = out
        ? planLabel(out, name, t.fullW, t.fullH, maxPx)
        : tangentPlan(tangentField(t.slug, t.mask), name, t.fullW, t.fullH, maxPx);
      if (!plan) return;
      t.labelPx = plan.px;
      t.labelRows = plan.rows;
      t.labelBox = labelBounds(plan.rows, plan.px);       // overall bbox: render + bounds
      t.labelCells = labelCells(plan.rows, plan.px);      // sub-boxes: the packer
    });
  }

  // Mask-aware nester. tiles: { fullW, fullH, mask, data }. Returns the
  // same tiles with .x, .y assigned (top-left in viewport coords).
  function maskPack(tiles, W, H, xBias, yBias, pad) {
    var GW = Math.ceil(W / GRID_STRIDE) + 2;
    var GH = Math.ceil(H / GRID_STRIDE) + 2;
    var grid = new Uint8Array(GW * GH);

    function cellRange(tile, tx, ty, c) {
      // For mask cell (c[0], c[1]), return [gx0, gy0, gx1, gy1] (inclusive)
      // in grid coords, clamped to the grid.
      var sx = tile.fullW / tile.mask.w;
      var sy = tile.fullH / tile.mask.h;
      var x0 = (tx + c[0] * sx) / GRID_STRIDE | 0;
      var y0 = (ty + c[1] * sy) / GRID_STRIDE | 0;
      var x1 = (tx + (c[0] + 1) * sx) / GRID_STRIDE | 0;
      var y1 = (ty + (c[1] + 1) * sy) / GRID_STRIDE | 0;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 >= GW) x1 = GW - 1; if (y1 >= GH) y1 = GH - 1;
      return [x0, y0, x1, y1];
    }
    function boxRange(b, tx, ty) {
      // Grid-space rect for a tile-local box (dx0..dx1, dy0..dy1), mirroring
      // cellRange's truncate + clamp. Used for each of the label's sub-boxes,
      // which may sit above, below or beyond the silhouette.
      var x0 = (tx + b.dx0) / GRID_STRIDE | 0;
      var y0 = (ty + b.dy0) / GRID_STRIDE | 0;
      var x1 = (tx + b.dx1) / GRID_STRIDE | 0;
      var y1 = (ty + b.dy1) / GRID_STRIDE | 0;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 >= GW) x1 = GW - 1; if (y1 >= GH) y1 = GH - 1;
      return [x0, y0, x1, y1];
    }
    function collides(tile, tx, ty) {
      var cells = tile.mask.cells;
      for (var i = 0; i < cells.length; i++) {
        var r = cellRange(tile, tx, ty, cells[i]);
        for (var gy = r[1]; gy <= r[3]; gy++) {
          var off = gy * GW;
          for (var gx = r[0]; gx <= r[2]; gx++) {
            if (grid[off + gx]) return true;
          }
        }
      }
      var lc = tile.labelCells;
      if (lc) {
        for (var li = 0; li < lc.length; li++) {
          var lr = boxRange(lc[li], tx, ty);
          for (var ly = lr[1]; ly <= lr[3]; ly++) {
            var loff = ly * GW;
            for (var lx = lr[0]; lx <= lr[2]; lx++) {
              if (grid[loff + lx]) return true;
            }
          }
        }
      }
      return false;
    }
    function stamp(tile, tx, ty) {
      var cells = tile.mask.cells;
      for (var i = 0; i < cells.length; i++) {
        var r = cellRange(tile, tx, ty, cells[i]);
        // Dilate the stamped footprint by `pad` cells so the next bird can't
        // pack right up against this one - a uniform gap around every
        // silhouette. collides() stays unpadded, so the gap is added once.
        var gy0 = r[1] - pad, gy1 = r[3] + pad;
        var gx0 = r[0] - pad, gx1 = r[2] + pad;
        if (gy0 < 0) gy0 = 0; if (gx0 < 0) gx0 = 0;
        if (gy1 >= GH) gy1 = GH - 1; if (gx1 >= GW) gx1 = GW - 1;
        for (var gy = gy0; gy <= gy1; gy++) {
          var off = gy * GW;
          for (var gx = gx0; gx <= gx1; gx++) grid[off + gx] = 1;
        }
      }
      var lc = tile.labelCells;
      if (lc) {
        // Each label sub-box gets a lighter dilation than the silhouette:
        // neighbours keep their distance from the lettering, but only a hair of
        // it, so the name reserves its glyphs and not a moat.
        var lpad = Math.min(pad, COLLAGE_LABEL_PAD);
        for (var li2 = 0; li2 < lc.length; li2++) {
          var lr2 = boxRange(lc[li2], tx, ty);
          var ly0 = lr2[1] - lpad, ly1 = lr2[3] + lpad;
          var lx0 = lr2[0] - lpad, lx1 = lr2[2] + lpad;
          if (ly0 < 0) ly0 = 0; if (lx0 < 0) lx0 = 0;
          if (ly1 >= GH) ly1 = GH - 1; if (lx1 >= GW) lx1 = GW - 1;
          for (var gy2 = ly0; gy2 <= ly1; gy2++) {
            var off2 = gy2 * GW;
            for (var gx2 = lx0; gx2 <= lx1; gx2++) grid[off2 + gx2] = 1;
          }
        }
      }
    }
    function offGrid(tile, tx, ty) {
      // True if the rendered tile bbox, or any of its label run, leaves
      // the viewport.
      var b = tile.labelBox;
      if (tx < 0 || ty < 0 || tx + tile.fullW > W || ty + tile.fullH > H) return true;
      if (!b) return false;
      return tx + b.dx0 < 0 || ty + b.dy0 < 0 ||
        tx + b.dx1 > W || ty + b.dy1 > H;
    }

    var cx = W / 2, cy = H / 2;
    // Largest first so the cluster grows around the anchor.
    tiles.sort(function (a, b) { return (b.fullW * b.fullH) - (a.fullW * a.fullH); });
    var placed = [];
    // Seeded PRNG keeps the layout stable across resizes.
    var seed = 0x9E3779B9;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var tx, ty;
      if (i === 0) {
        tx = cx - t.fullW / 2;
        ty = cy - t.fullH / 2;
        t.x = tx; t.y = ty;
        stamp(t, tx, ty);
        placed.push(t);
        continue;
      }
      // Spiral outward. Stop the first ring that yields any non-colliding
      // position - that ring is the tightest possible distance from
      // centre. Within the ring, pick the position closest to the centre
      // of mass of already-placed tiles (so cluster grows organically,
      // not in fixed directions).
      var comX = 0, comY = 0, comW = 0;
      placed.forEach(function (p) {
        var a = p.fullW * p.fullH;
        comX += (p.x + p.fullW / 2) * a;
        comY += (p.y + p.fullH / 2) * a;
        comW += a;
      });
      comX /= comW; comY /= comW;

      var best = null, bestCost = Infinity;
      var step = Math.max(GRID_STRIDE, Math.min(t.fullW, t.fullH) * 0.05);
      var maxR = Math.max(W, H);
      var foundRing = -1;
      var phase = rand() * Math.PI * 2;
      for (var r = 0; r <= maxR; r += step) {
        if (foundRing >= 0 && r > foundRing + step * 2) break;
        var samples = Math.max(36, Math.floor(r / 1.6));
        for (var k = 0; k < samples; k++) {
          var theta = phase + (k / samples) * Math.PI * 2;
          // Elliptical ring - stretched per axis: xBias>yBias gives a wide
          // (landscape) cluster, yBias>xBias a tall (portrait) one.
          var px = cx + r * xBias * Math.cos(theta) - t.fullW / 2;
          var py = cy + r * yBias * Math.sin(theta) - t.fullH / 2;
          if (offGrid(t, px, py)) continue;
          if (collides(t, px, py)) continue;
          // Distance to existing cluster centre of mass + small noise.
          var dxx = (px + t.fullW / 2 - comX);
          var dyy = (py + t.fullH / 2 - comY);
          var cost = Math.hypot(dxx / xBias, dyy / yBias) + rand() * step * 0.5;
          if (cost < bestCost) { bestCost = cost; best = { x: px, y: py }; }
        }
        if (best && foundRing < 0) foundRing = r;
      }
      if (best) {
        t.x = best.x; t.y = best.y;
        stamp(t, best.x, best.y);
        placed.push(t);
      } else {
        // Couldn't fit anywhere - hide off-screen rather than overlap.
        t.x = -99999; t.y = -99999;
        placed.push(t);
      }
    }
    return placed;
  }

  // ---- Public bundle-preview adapter ----
  // The production collage above owns station state, endpoints, hover targets,
  // and view navigation. This adapter supplies only the data the layout needs:
  // six direct image URLs plus geometry generated from those exact pixels.
  var DEFAULT_GEOMETRY_URL = '/catalog/bundle-preview-geometry-v1.json';
  var geometryRequests = Object.create(null);
  var mounted = typeof WeakMap === 'function' ? new WeakMap() : null;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var HOSTED_GEOMETRY_MAX_BYTES = 64 * 1024;
  var HOSTED_RENDER_MAX_BYTES = 4 * 1024 * 1024;
  var PREVIEW_MASK_MAX = 93;
  var PREVIEW_RENDER_MAX = 960;
  var SCIENTIFIC_NAME_MAX = 163;
  var PREVIEW_MASK_ENCODING = 'msb-first-row-major-base64';

  function finitePositive(value) {
    value = Number(value);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function approvedHostedUrl(value, pattern) {
    if (typeof value !== 'string') return '';
    try {
      var url = new URL(value, global.location && global.location.origin || 'https://avianvisitors.com');
      var host = url.hostname;
      var approved = url.origin === (global.location && global.location.origin) ||
        (url.protocol === 'https:' && !url.port && (host === 'avianvisitors.com' ||
          host === 'www.avianvisitors.com' || host === 'assets.avianvisitors.com'));
      var match = url.pathname.match(pattern);
      return approved && !url.username && !url.password && !url.search && !url.hash && match
        ? match[1] : '';
    } catch (_) {
      return '';
    }
  }

  function hostedPreviewDigest(value) {
    return approvedHostedUrl(value, /^\/api\/bundles\/objects\/([0-9a-f]{64})\.png$/);
  }

  function hostedGeometryDigest(value) {
    return approvedHostedUrl(value, /^\/api\/bundles\/preview-geometry\/([0-9a-f]{64})\.json$/);
  }

  function localPreviewUrl(value) {
    return typeof value === 'string' &&
      /^\/assets\/bundle-catalog\/bundle-previews\/[a-z0-9/_.-]+\.png$/.test(value) &&
      value.indexOf('..') < 0;
  }

  function validPreviewUrl(value) {
    return localPreviewUrl(value) || !!hostedPreviewDigest(value);
  }

  function hasLoneSurrogate(value) {
    for (var index = 0; index < value.length; index += 1) {
      var unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        var next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    }
    return false;
  }

  function codePointSlice(value, max) {
    if (typeof value !== 'string' || hasLoneSurrogate(value)) return '';
    return Array.from(value).slice(0, max).join('');
  }

  function normaliseBird(record) {
    record = record && typeof record === 'object' ? record : {};
    var url = String(record.url || record.src || '');
    var hostedDigest = hostedPreviewDigest(url);
    return {
      url: url,
      key: hostedDigest || url,
      hostedDigest: hostedDigest,
      com: codePointSlice(record.commonName || record.common_name || '', 100),
      sci: codePointSlice(record.scientificName || record.scientific_name || '', SCIENTIFIC_NAME_MAX),
      n: finitePositive(record.weight || record.n) || 1,
    };
  }

  function exactKeys(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(value).every(function (key) { return allowed.indexOf(key) >= 0; });
  }

  function decodeMask(mask) {
    if (!mask || !exactKeys(mask, ['w', 'h', 'encoding', 'bits', 'sha256']) ||
        !Number.isInteger(mask.w) || !Number.isInteger(mask.h) ||
        mask.w < 1 || mask.h < 1 || mask.w > PREVIEW_MASK_MAX || mask.h > PREVIEW_MASK_MAX ||
        mask.encoding !== PREVIEW_MASK_ENCODING ||
        typeof mask.bits !== 'string' || mask.bits.length < 4 || mask.bits.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(mask.bits) ||
        !/^[0-9a-f]{64}$/.test(String(mask.sha256 || ''))) {
      throw new Error('invalid bundle preview mask');
    }
    var binary;
    try { binary = atob(mask.bits); } catch (_) { throw new Error('invalid bundle preview mask'); }
    if (typeof btoa === 'function' && btoa(binary) !== mask.bits) {
      throw new Error('invalid bundle preview mask');
    }
    var expectedBytes = Math.ceil(mask.w * mask.h / 8);
    if (binary.length !== expectedBytes) throw new Error('invalid bundle preview mask length');
    var bytes = new Uint8Array(binary.length);
    var any = false;
    for (var index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
      if (bytes[index]) any = true;
    }
    if (!any) throw new Error('empty bundle preview mask');
    var unused = bytes.length * 8 - mask.w * mask.h;
    if (unused && (bytes[bytes.length - 1] & ((1 << unused) - 1))) {
      throw new Error('invalid bundle preview mask padding');
    }
    return bytes;
  }

  function hashBytes(bytes) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error('preview checksum support unavailable'));
    }
    return global.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
      return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  function registerGeometry(key, item, maskBytes) {
    var dims = item.dims;
    var mask = item.mask;
    var existingDims = DIMS[key];
    var existingMask = MASKS[key];
    if (existingDims && (existingDims[0] !== dims[0] || existingDims[1] !== dims[1] ||
        !existingMask || existingMask.w !== mask.w || existingMask.h !== mask.h ||
        existingMask.bits !== mask.bits)) {
      throw new Error('conflicting bundle preview geometry');
    }
    DIMS[key] = [dims[0], dims[1]];
    MASKS[key] = { w: mask.w, h: mask.h, bits: mask.bits };
    item._renderUrl = item.render_url;
    item._maskBytes = maskBytes;
  }

  function validateGeometryItem(key, item, hosted) {
    var allowed = hosted
      ? ['render_url', 'render_sha256', 'render_bytes', 'source_sha256',
        'scientific_name', 'common_name', 'dims', 'mask']
      : ['render_url', 'dims', 'mask', 'sha256'];
    var dims = item && item.dims;
    var mask = item && item.mask;
    var renderDigest = hostedPreviewDigest(item && item.render_url);
    if (!exactKeys(item, allowed) || !Array.isArray(dims) || dims.length !== 2 ||
        dims.some(function (value) {
          return !Number.isInteger(value) || value < 1 || value > PREVIEW_RENDER_MAX;
        }) || !mask || (hosted
          ? (!/^[0-9a-f]{64}$/.test(key) || renderDigest !== key || item.render_sha256 !== key ||
            !/^[0-9a-f]{64}$/.test(String(item.source_sha256 || '')) ||
            !Number.isInteger(item.render_bytes) || item.render_bytes < 8 ||
            item.render_bytes > HOSTED_RENDER_MAX_BYTES)
          : (!localPreviewUrl(key) || !localPreviewUrl(item.render_url) ||
            !/^[0-9a-f]{64}$/.test(String(item.sha256 || ''))))) {
      throw new Error('invalid bundle preview geometry item');
    }
    var bytes = decodeMask(mask);
    return hashBytes(bytes).then(function (digest) {
      if (digest !== mask.sha256) throw new Error('bundle preview mask checksum mismatch');
      registerGeometry(key, item, bytes);
      return item;
    });
  }

  function acceptGeometry(payload, expectedGeometryDigest, expectedManifestSha256) {
    if (!payload || payload.format !== 'avian-bundle-preview-geometry' ||
        payload.format_version !== 1 || !payload.items ||
        typeof payload.items !== 'object' || Array.isArray(payload.items)) {
      throw new Error('invalid bundle preview geometry');
    }
    var hosted = !!expectedGeometryDigest;
    if (hosted) {
      if (!exactKeys(payload, ['format', 'format_version', 'source_manifest_sha256',
        'derivation', 'alpha_threshold', 'mask_max', 'render_max', 'cover',
        'example_order', 'items']) ||
          !/^[0-9a-f]{64}$/.test(String(expectedManifestSha256 || '')) ||
          payload.source_manifest_sha256 !== expectedManifestSha256 ||
          payload.derivation !== 'alpha127-tightcrop-lanczos-v1' ||
          payload.alpha_threshold !== 127 || payload.mask_max !== PREVIEW_MASK_MAX ||
          payload.render_max !== PREVIEW_RENDER_MAX || !Array.isArray(payload.example_order) ||
          payload.example_order.length > 6 ||
          Object.keys(payload.items).length !== payload.example_order.length ||
          !exactKeys(payload.cover, ['render_url', 'render_sha256', 'render_bytes',
            'source_sha256', 'scientific_name', 'common_name', 'dims']) ||
          hostedPreviewDigest(payload.cover.render_url) !== payload.cover.render_sha256 ||
          !/^[0-9a-f]{64}$/.test(String(payload.cover.source_sha256 || '')) ||
          !Number.isInteger(payload.cover.render_bytes) || payload.cover.render_bytes < 8 ||
          payload.cover.render_bytes > HOSTED_RENDER_MAX_BYTES ||
          !Array.isArray(payload.cover.dims) || payload.cover.dims.length !== 2 ||
          payload.cover.dims.some(function (value) {
            return !Number.isInteger(value) || value < 1 || value > PREVIEW_RENDER_MAX;
          })) {
        throw new Error('invalid hosted bundle preview geometry');
      }
      var order = payload.example_order;
      if (new Set(order).size !== order.length || order.some(function (digest) {
        return !/^[0-9a-f]{64}$/.test(String(digest || '')) ||
          digest === payload.cover.render_sha256 ||
          !Object.prototype.hasOwnProperty.call(payload.items, digest);
      })) throw new Error('invalid hosted bundle preview order');
    }
    var keys = hosted ? payload.example_order : Object.keys(payload.items);
    return Promise.all(keys.map(function (key) {
      return validateGeometryItem(key, payload.items[key], hosted);
    })).then(function () { return payload.items; });
  }

  function loadGeometry(url, expectedManifestSha256) {
    var hostedDigest = hostedGeometryDigest(url);
    if (url !== DEFAULT_GEOMETRY_URL && !hostedDigest) {
      return Promise.reject(new Error('unapproved bundle preview geometry URL'));
    }
    if (hostedDigest && !/^[0-9a-f]{64}$/.test(String(expectedManifestSha256 || ''))) {
      return Promise.reject(new Error('hosted preview manifest checksum is required'));
    }
    var requestKey = hostedDigest ? url + '#' + expectedManifestSha256 : url;
    if (geometryRequests[requestKey]) return geometryRequests[requestKey];
    if (!hostedDigest && url === DEFAULT_GEOMETRY_URL && global.AVIAN_BUNDLE_PREVIEW_GEOMETRY) {
      geometryRequests[requestKey] = Promise.resolve()
        .then(function () { return acceptGeometry(global.AVIAN_BUNDLE_PREVIEW_GEOMETRY, '', ''); })
        .catch(function (error) {
          delete geometryRequests[requestKey];
          throw error;
        });
      return geometryRequests[requestKey];
    }
    geometryRequests[requestKey] = fetch(url, {
      cache: hostedDigest ? 'force-cache' : 'no-cache',
      credentials: 'same-origin'
    })
      .then(function (response) {
        if (!response || !response.ok) throw new Error('bundle preview geometry unavailable');
        if (!hostedDigest) return response.json().then(function (payload) {
          return acceptGeometry(payload, '', '');
        });
        var declared = Number(response.headers && response.headers.get('content-length') || 0);
        if (declared > HOSTED_GEOMETRY_MAX_BYTES) {
          throw new Error('bundle preview geometry is too large');
        }
        return response.arrayBuffer().then(function (raw) {
          if (raw.byteLength > HOSTED_GEOMETRY_MAX_BYTES) {
            throw new Error('bundle preview geometry is too large');
          }
          return hashBytes(raw).then(function (digest) {
            if (digest !== hostedDigest) throw new Error('bundle preview geometry checksum mismatch');
            var text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
            catch (_) { throw new Error('bundle preview geometry is not UTF-8'); }
            var payload;
            try { payload = JSON.parse(text); }
            catch (_) { throw new Error('bundle preview geometry is not JSON'); }
            return acceptGeometry(payload, hostedDigest, expectedManifestSha256);
          });
        });
      }).catch(function (error) {
        delete geometryRequests[requestKey];
        throw error;
      });
    return geometryRequests[requestKey];
  }

  function clusterBounds(arr) {
    var L = Infinity, R = -Infinity, T = Infinity, B = -Infinity;
    arr.forEach(function (tile) {
      if (tile.x < -1000) return;
      var box = tile.labelBox;
      var x0 = tile.x + (box ? Math.min(0, box.dx0) : 0);
      var x1 = tile.x + tile.fullW + (box ? Math.max(0, box.dx1 - tile.fullW) : 0);
      var y0 = tile.y + (box ? Math.min(0, box.dy0) : 0);
      var y1 = tile.y + tile.fullH + (box ? Math.max(0, box.dy1 - tile.fullH) : 0);
      if (x0 < L) L = x0;
      if (x1 > R) R = x1;
      if (y0 < T) T = y0;
      if (y1 > B) B = y1;
    });
    return { L: L, R: R, T: T, B: B };
  }

  function makeTiles(birds, geometry, width, height) {
    var T = tuning(birds.length);
    var viewportArea = width * height;
    var budget = viewportArea * T.packingBudgetFrac;
    var minimumArea = viewportArea * T.minTileAreaFrac;
    var tiles = birds.map(function (bird) {
      var item = geometry[bird.key];
      var mask = item ? loadMask(bird.key) : null;
      var dims = item && DIMS[bird.key];
      if (!mask || !dims || (bird.hostedDigest &&
          hostedPreviewDigest(item._renderUrl) !== bird.hostedDigest)) return null;
      return {
        mask: mask,
        data: bird,
        slug: bird.key,
        renderUrl: item._renderUrl,
        renderRevision: bird.hostedDigest ? '' : item.sha256,
        intrinsicWidth: dims[0],
        intrinsicHeight: dims[1],
        ar: dims[0] / dims[1],
        score: Math.pow(Math.max(1, bird.n), T.countExp),
      };
    }).filter(Boolean);
    if (!tiles.length) return [];

    var sumScore = tiles.reduce(function (sum, tile) { return sum + tile.score; }, 0) || 1;
    tiles.forEach(function (tile) {
      tile.area = Math.max(minimumArea, budget * tile.score / sumScore);
    });
    var sumArea = tiles.reduce(function (sum, tile) { return sum + tile.area; }, 0);
    if (sumArea > budget) {
      var fixedSum = tiles.filter(function (tile) { return tile.area <= minimumArea + 1e-9; })
        .reduce(function (sum, tile) { return sum + tile.area; }, 0);
      var flexibleSum = sumArea - fixedSum;
      var flexibleBudget = Math.max(0, budget - fixedSum);
      var shrink = flexibleSum > 0 ? Math.min(1, flexibleBudget / flexibleSum) : 1;
      tiles.forEach(function (tile) {
        if (tile.area > minimumArea + 1e-9) tile.area *= shrink;
      });
    }
    tiles.forEach(function (tile) {
      tile.fullW = Math.sqrt(tile.area * tile.ar);
      tile.fullH = tile.fullW / tile.ar;
    });

    var narrow = width <= 700;
    var xBias = narrow ? 1 : T.ellipseAspectBias;
    var yBias = narrow ? 1.7 : 1;
    var pad = narrow ? Math.max(1, COLLAGE_PAD - 1) : COLLAGE_PAD;
    assignLabels(tiles);
    var placed = maskPack(tiles, width, height, xBias, yBias, pad);
    var bounds = clusterBounds(placed);
    for (var iteration = 0; iteration < 10; iteration++) {
      var missing = placed.some(function (tile) { return tile.x < -1000; });
      var overflow = bounds.L < 0 || bounds.T < 0 || bounds.R > width || bounds.B > height;
      if (!missing && !overflow) break;
      var scale = 0.93;
      if (overflow) {
        var clusterWidth = bounds.R - bounds.L;
        var clusterHeight = bounds.B - bounds.T;
        var sx = (width * 0.96) / Math.max(clusterWidth, width * 0.96);
        var sy = (height * 0.94) / Math.max(clusterHeight, height * 0.94);
        scale = Math.min(scale, sx, sy);
      }
      tiles.forEach(function (tile) { tile.fullW *= scale; tile.fullH *= scale; });
      assignLabels(tiles);
      placed = maskPack(tiles, width, height, xBias, yBias, pad);
      bounds = clusterBounds(placed);
    }
    if (!Number.isFinite(bounds.L)) return [];
    var dx = width / 2 - (bounds.L + bounds.R) / 2;
    var dy = height / 2 - (bounds.T + bounds.B) / 2;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      placed.forEach(function (tile) {
        if (tile.x > -1000) { tile.x += dx; tile.y += dy; }
      });
    }
    return placed.filter(function (tile) { return tile.x > -1000; });
  }

  function svgElement(name) {
    return document.createElementNS(SVG_NS, name);
  }

  function appendLabel(tile, host) {
    if (!tile.labelRows || !tile.labelBox) return;
    addLabelInk();
    var bounds = tile.labelBox;
    var width = Math.max(1, Math.ceil(bounds.dx1 - bounds.dx0));
    var height = Math.max(1, Math.ceil(bounds.dy1 - bounds.dy0));
    var svg = svgElement('svg');
    svg.setAttribute('class', 'avbc-label');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', [bounds.dx0.toFixed(1), bounds.dy0.toFixed(1), width, height].join(' '));
    svg.style.left = bounds.dx0.toFixed(1) + 'px';
    svg.style.top = bounds.dy0.toFixed(1) + 'px';
    svg.style.width = width + 'px';
    svg.style.height = height + 'px';
    tile.labelRows.forEach(function (row) {
      var id = 'avbc-lp-' + (labelPathSeq++);
      var path = svgElement('path');
      path.setAttribute('id', id);
      path.setAttribute('fill', 'none');
      path.setAttribute('d', row.pts.map(function (point, index) {
        return (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1);
      }).join(' '));
      var text = svgElement('text');
      text.setAttribute('data-ink', inkBucket(tile.labelPx));
      text.style.font = '600 ' + tile.labelPx + 'px Hand, cursive';
      var textPath = svgElement('textPath');
      textPath.setAttribute('href', '#' + id);
      textPath.setAttribute('startOffset', '50%');
      textPath.setAttribute('text-anchor', 'middle');
      textPath.textContent = row.text;
      text.appendChild(textPath);
      svg.append(path, text);
    });
    host.appendChild(svg);
  }

  var ENTRANCE_SPREAD_MS = 520;
  var ENTRANCE_DURATION_MS = 420;

  function imageReady(image) {
    if (image && typeof image.decode === 'function') {
      return image.decode().catch(function () {});
    }
    if (!image || image.complete || typeof image.addEventListener !== 'function') {
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    });
  }

  function clearEntrance(state) {
    state.revealGeneration += 1;
    if (state.revealTimer) clearTimeout(state.revealTimer);
    state.revealTimer = 0;
    state.container.removeAttribute('data-reveal-pending');
    state.container.removeAttribute('data-revealing');
  }

  // Match the station collage: hold the six eagerly requested images on the
  // paper until they are decoded, then bloom them from the visual centre out.
  // The assets still start fetching immediately; only their presentation is
  // coordinated, so a cold cache never paints as a network-order scan.
  function queueEntrance(state, birds, images) {
    clearEntrance(state);
    var generation = state.revealGeneration;
    var cx = state.container.clientWidth / 2;
    var cy = state.container.clientHeight / 2;
    var maxDistance = birds.reduce(function (maximum, bird) {
      var distance = Math.hypot(
        bird._tile.x + bird._tile.fullW / 2 - cx,
        bird._tile.y + bird._tile.fullH / 2 - cy
      );
      bird._entranceDistance = distance;
      return Math.max(maximum, distance);
    }, 1);
    birds.forEach(function (bird) {
      bird.style.animationDelay = Math.round(
        bird._entranceDistance / maxDistance * ENTRANCE_SPREAD_MS
      ) + 'ms';
      delete bird._tile;
      delete bird._entranceDistance;
    });
    state.container.setAttribute('data-reveal-pending', '');
    Promise.all(images.map(imageReady)).then(function () {
      if (state.destroyed || generation !== state.revealGeneration ||
          (mounted && mounted.get(state.container) !== state.controller)) return;
      // Commit the pending hidden state before beginning the animation. This
      // also makes a cached reopen replay instead of flashing fully visible.
      void state.container.offsetWidth;
      state.container.removeAttribute('data-reveal-pending');
      state.container.setAttribute('data-revealing', '');
      state.revealTimer = setTimeout(function () {
        if (generation !== state.revealGeneration) return;
        state.container.removeAttribute('data-revealing');
        birds.forEach(function (bird) { bird.style.animationDelay = ''; });
        state.revealTimer = 0;
      }, ENTRANCE_SPREAD_MS + ENTRANCE_DURATION_MS + 100);
      if (state.revealTimer && typeof state.revealTimer.unref === 'function') {
        state.revealTimer.unref();
      }
    });
  }

  function draw(state, reveal) {
    if (state.destroyed || (mounted && mounted.get(state.container) !== state.controller)) {
      return { rendered: 0, destroyed: true };
    }
    var width = state.container.clientWidth;
    var height = state.container.clientHeight;
    if (!(width > 0 && height > 0)) return { rendered: 0, pending: true };
    var placed = makeTiles(state.birds, state.geometry, width, height);
    var fragment = document.createDocumentFragment();
    var renderedBirds = [];
    var renderedImages = [];
    placed.forEach(function (tile) {
      var bird = document.createElement('div');
      bird.className = 'avbc-bird';
      bird.style.left = tile.x + 'px';
      bird.style.top = tile.y + 'px';
      bird.style.width = tile.fullW + 'px';
      bird.style.height = tile.fullH + 'px';
      var image = document.createElement('img');
      // The gallery is created only when its disclosure opens, so these six
      // visible cutouts should start immediately rather than waiting for a
      // second lazy-loading intersection pass.
      image.loading = 'eager';
      image.decoding = 'async';
      image.width = tile.intrinsicWidth;
      image.height = tile.intrinsicHeight;
      image.src = tile.renderUrl + (tile.renderRevision ? '?v=' + tile.renderRevision : '');
      image.alt = tile.data.com || tile.data.sci || 'Example bird';
      bird.appendChild(image);
      appendLabel(tile, bird);
      bird._tile = tile;
      renderedBirds.push(bird);
      renderedImages.push(image);
      fragment.appendChild(bird);
    });
    state.container.replaceChildren(fragment);
    state.lastWidth = width;
    state.lastHeight = height;
    state.renderCount += 1;
    if (reveal) queueEntrance(state, renderedBirds, renderedImages);
    else clearEntrance(state);
    return { rendered: placed.length, width: width, height: height };
  }

  function mount(container, birds, geometryUrl, expectedManifestSha256) {
    if (!container || typeof container.replaceChildren !== 'function') {
      throw new TypeError('AvianBundleCollage.mount requires a container element');
    }
    if (mounted && mounted.has(container)) mounted.get(container).destroy();
    var state = {
      container: container,
      birds: Array.isArray(birds) ? birds.slice(0, 6).map(normaliseBird).filter(function (bird) {
        return validPreviewUrl(bird.url) &&
          (bird.hostedDigest ? bird.key === bird.hostedDigest : bird.key === bird.url);
      }) : [],
      geometry: null,
      destroyed: false,
      observer: null,
      frame: 0,
      lastWidth: -1,
      lastHeight: -1,
      renderCount: 0,
      revealGeneration: 0,
      revealTimer: 0,
      controller: null,
    };
    container.classList.add('avbc-collage');

    function repack() {
      return state.ready.then(function () {
        if (state.destroyed) return { rendered: 0, destroyed: true };
        return draw(state, false);
      });
    }

    function schedule() {
      if (state.destroyed || state.frame) return;
      var raf = global.requestAnimationFrame || function (callback) { return setTimeout(callback, 16); };
      state.frame = raf(function () {
        state.frame = 0;
        if (state.destroyed) return;
        var width = state.container.clientWidth;
        var height = state.container.clientHeight;
        if (width === state.lastWidth && height === state.lastHeight) return;
        repack().catch(function () {});
      });
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      clearEntrance(state);
      if (state.observer) state.observer.disconnect();
      if (state.frame) {
        var cancel = global.cancelAnimationFrame || clearTimeout;
        cancel(state.frame);
        state.frame = 0;
      }
      if (!mounted || mounted.get(container) === state.controller) {
        container.replaceChildren();
        container.classList.remove('avbc-collage');
        if (mounted) mounted.delete(container);
      }
    }

    var controller = { ready: null, repack: repack, destroy: destroy };
    state.controller = controller;
    if (mounted) mounted.set(container, controller);
    if (typeof global.ResizeObserver === 'function') {
      state.observer = new global.ResizeObserver(schedule);
      state.observer.observe(container);
    }
    var selectedGeometryUrl = geometryUrl || DEFAULT_GEOMETRY_URL;
    var hasHostedBird = state.birds.some(function (bird) { return !!bird.hostedDigest; });
    var hasLocalBird = state.birds.some(function (bird) { return !bird.hostedDigest; });
    var geometryKindMismatch = (hasHostedBird && !hostedGeometryDigest(selectedGeometryUrl)) ||
      (hasLocalBird && selectedGeometryUrl !== DEFAULT_GEOMETRY_URL) ||
      (hasHostedBird && !/^[0-9a-f]{64}$/.test(String(expectedManifestSha256 || '')));
    state.ready = Promise.all([
      geometryKindMismatch
        ? Promise.reject(new Error('preview images and geometry source do not match'))
        : loadGeometry(selectedGeometryUrl, hasHostedBird ? expectedManifestSha256 : ''),
      ensureLabelFont(),
    ]).then(function (values) {
      state.geometry = values[0];
      if (state.destroyed || (mounted && mounted.get(container) !== controller)) {
        return { rendered: 0, destroyed: true };
      }
      return draw(state, true);
    });
    controller.ready = state.ready;
    return controller;
  }

  global.AvianBundleCollage = Object.freeze({ mount: mount });
})(typeof window !== "undefined" ? window : globalThis);

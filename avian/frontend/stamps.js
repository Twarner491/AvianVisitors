document.documentElement.setAttribute('data-stamps-js', 'r325');
window.addEventListener('error', function (event) {
  document.documentElement.setAttribute('data-stamps-error', String(event.message || event.error || 'script error'));
}, { once:true });
/* ============================================================
   stamps.js - the Avian Atlas stamp system.

   Every species in the life list is printed as a postage stamp. Which
   design a bird gets is decided by its FAMILY, not by the individual
   species, so a family reads as one issue: all corvids share a design,
   all hummingbirds share another. Colour therefore means taxonomy.

   Three parts live here:
     1. FX      - real pixel treatments (cyanotype, halftone, low-poly,
                  engraving) run on a canvas over the bird's cutout.
     2. TPL     - the stamp designs. Markup only; their CSS is stamps.css.
     3. STAMPS  - family lookup + markup builder used by renderAtlas.
   ============================================================ */
/* fx.js: real canvas image treatments for AvianVisitors stamps.
   Each treatment processes actual pixels of the dropped-in bird (same-origin,
   so the canvas isn't tainted). Usage:
     <canvas class="fxc" data-fx="cyanotype" data-src="URL" data-opt='{"pad":0.06}'></canvas>
   then FX.run(root) after the markup is in the DOM. */
window.FX = (function () {
  function load(src) {
    return new Promise(function (res, rej) {
      var im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = function () { res(im); }; im.onerror = function () { rej(new Error('img')); };
      im.src = src;
    });
  }
  function fit(im, W, H, pad) {
    pad = pad || 0; var aw = W - 2 * pad, ah = H - 2 * pad;
    var s = Math.min(aw / im.width, ah / im.height);
    var dw = im.width * s, dh = im.height * s;
    return { dw: dw, dh: dh, ox: (W - dw) / 2, oy: (H - dh) / 2 };
  }
  var lum = function (r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; };
  function offscreen(W, H) { var c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
  function hex2rgb(h) {
    h = h.replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgb2hsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0, s = 0, l = (mx + mn) / 2;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [h, s, l];
  }
  function hsl2rgb(c) {
    var h = c[0], s = c[1], l = c[2];
    var ch = (1 - Math.abs(2 * l - 1)) * s, x = ch * (1 - Math.abs((h / 60) % 2 - 1)), m = l - ch / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = ch; g = x; }
    else if (h < 120) { r = x; g = ch; }
    else if (h < 180) { g = ch; b = x; }
    else if (h < 240) { g = x; b = ch; }
    else if (h < 300) { r = x; b = ch; }
    else { r = ch; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
  // Perceptual colour distance for source-to-ink matching. RGB distance makes
  // dark greens, browns and violets collapse unpredictably; OKLab keeps the
  // nearest limited-palette ink aligned with how the source patch is seen.
  function rgb2oklab(c) {
    function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    var r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
    var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    l = Math.cbrt(l); m = Math.cbrt(m); s = Math.cbrt(s);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
  }
  // tight bounding box of the non-transparent bird, in normalised [x0,y0,x1,y1]
  function birdBox(im) {
    if (im._bb) return im._bb;
    var s = 200, w = s, hh = Math.max(1, Math.round(s * im.height / im.width));
    var c = offscreen(w, hh), cc = c.getContext('2d');
    cc.drawImage(im, 0, 0, w, hh);
    var p; try { p = cc.getImageData(0, 0, w, hh).data; } catch (e) { return (im._bb = [0, 0, 1, 1]); }
    var x0 = w, y0 = hh, x1 = 0, y1 = 0, found = false;
    for (var y = 0; y < hh; y++) for (var x = 0; x < w; x++) {
      if (p[(y * w + x) * 4 + 3] > 24) { found = true; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (!found) return (im._bb = [0, 0, 1, 1]);
    return (im._bb = [x0 / w, y0 / hh, (x1 + 1) / w, (y1 + 1) / hh]);
  }
  // draw the bird into oc at WxH; fit:'bird' zooms to the alpha bounding box,
  // head:<frac> crops to the top portion (head + shoulders), cover fills instead of contains
  function drawBird(oc, im, W, H, o) {
    o = o || {}; var pad = (o.pad != null ? o.pad : 0.05);
    var scale = (o.scale != null ? o.scale : 1);
    var rotate = (o.rotate || 0) * Math.PI / 180;
    var transformed = scale !== 1 || rotate !== 0;
    if (transformed) {
      oc.save();
      oc.translate(W / 2, H / 2);
      oc.rotate(rotate);
      oc.scale(scale, scale);
      oc.translate(-W / 2, -H / 2);
    }
    if (o.fit === 'bird' || o.head) {
      var b = birdBox(im);
      var bx0 = b[0], by0 = b[1], bx1 = b[2], by1 = b[3];
      if (o.head) {
        var hf = (typeof o.head === 'number' ? o.head : 0.58);
        by1 = by0 + (by1 - by0) * hf;               // keep only the top fraction (head + shoulders)
        var cw = bx1 - bx0, cx = (bx0 + bx1) / 2, nw = cw * (o.headw || 0.86);
        bx0 = cx - nw / 2; bx1 = cx + nw / 2;        // narrow a touch toward centre
      }
      var sx = bx0 * im.width, sy = by0 * im.height, sw = (bx1 - bx0) * im.width, sh = (by1 - by0) * im.height;
      var pw = W * (1 - 2 * pad), ph = H * (1 - 2 * pad);
      var sc = o.cover ? Math.max(pw / sw, ph / sh) : Math.min(pw / sw, ph / sh);
      var dw = sw * sc, dh = sh * sc;
      oc.drawImage(im, sx, sy, sw, sh,
        (W - dw) / 2 + (o.offsetX || 0) * W,
        (H - dh) / 2 + (o.offsetY || 0) * H, dw, dh);
    } else {
      var f = fit(im, W, H, pad * Math.min(W, H));
      oc.drawImage(im, f.ox + (o.offsetX || 0) * W, f.oy + (o.offsetY || 0) * H, f.dw, f.dh);
    }
    if (transformed) oc.restore();
  }
  // uneven "chemical" mottle: sparse soft radial blobs, light and dark
  function seededNoise(seed) {
    seed = (seed >>> 0) || 1;
    return function () {
      seed += 0x6D2B79F5;
      var z = seed;
      z = Math.imul(z ^ (z >>> 15), z | 1);
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mottle(cx, W, H, n, alpha, rand) {
    rand = rand || Math.random;
    for (var k = 0; k < n; k++) {
      var x = rand() * W, y = rand() * H, r = (0.12 + rand() * 0.4) * Math.min(W, H);
      var light = rand() > 0.5;
      var g = cx.createRadialGradient(x, y, 0, x, y, r);
      var col = light ? '255,255,255' : '4,16,40';
      g.addColorStop(0, 'rgba(' + col + ',' + (alpha * (0.5 + rand() * 0.5)).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + col + ',0)');
      cx.fillStyle = g; cx.fillRect(0, 0, W, H);
    }
  }
  function grain(cx, W, H, amt, rand) {
    rand = rand || Math.random;
    var id = cx.getImageData(0, 0, W, H), p = id.data;
    for (var i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 4) continue;
      var n = (rand() - 0.5) * amt * 255;
      p[i] += n; p[i + 1] += n; p[i + 2] += n;
    }
    cx.putImageData(id, 0, 0);
  }
  function sharpen(cx, W, H, amount) {
    if (!amount) return;
    var src = cx.getImageData(0, 0, W, H), dst = cx.createImageData(W, H);
    var a = Math.max(0, Math.min(0.5, amount)), s = src.data, d = dst.data;
    d.set(s);
    for (var y = 1; y < H - 1; y++) for (var x = 1; x < W - 1; x++) {
      var i = (y * W + x) * 4;
      for (var c = 0; c < 3; c++) {
        var edge = 4 * s[i + c] - s[i - 4 + c] - s[i + 4 + c] - s[i - W * 4 + c] - s[i + W * 4 + c];
        d[i + c] = Math.max(0, Math.min(255, s[i + c] + a * edge));
      }
    }
    cx.putImageData(dst, 0, 0);
  }

  var T = {
    // ---- WAX CUTOUT: remove an opaque scanned-paper backdrop without
    // erasing pale plumage. A flood starts at the four image edges and may
    // travel only through pixels close to the sampled paper colour. Unlike a
    // luminance key, this keeps the waxwing's cream belly and leaves a true
    // transparent silhouette for the postal keyline to follow around the beak.
    waxCutout: function (cx, W, H, im, o) {
      o = o || {};
      var off = offscreen(W, H), oc = off.getContext('2d');
      var f = fit(im, W, H, (o.pad != null ? o.pad : 0.038) * Math.min(W, H));
      oc.imageSmoothingEnabled = true;
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(im, f.ox, f.oy, f.dw, f.dh);
      var src = oc.getImageData(0, 0, W, H), s = src.data;
      var x0 = Math.max(0, Math.min(W - 1, Math.floor(f.ox + 2)));
      var y0 = Math.max(0, Math.min(H - 1, Math.floor(f.oy + 2)));
      var x1 = Math.max(0, Math.min(W - 1, Math.ceil(f.ox + f.dw - 3)));
      var y1 = Math.max(0, Math.min(H - 1, Math.ceil(f.oy + f.dh - 3)));
      var samples = [[x0,y0],[x1,y0],[x0,y1],[x1,y1]];
      var br = 0, bg = 0, bb = 0;
      for (var si = 0; si < samples.length; si++) {
        var spi = (samples[si][1] * W + samples[si][0]) * 4;
        br += s[spi]; bg += s[spi + 1]; bb += s[spi + 2];
      }
      br /= samples.length; bg /= samples.length; bb /= samples.length;
      var threshold = o.threshold != null ? o.threshold : 68;
      var threshold2 = threshold * threshold;
      var seen = new Uint8Array(W * H);
      var queue = new Int32Array(W * H), head = 0, tail = 0;
      function add(x, y) {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        var p = y * W + x;
        if (seen[p]) return;
        var i = p * 4;
        if (s[i + 3] < 8) { seen[p] = 1; queue[tail++] = p; return; }
        var dr = s[i] - br, dg = s[i + 1] - bg, db = s[i + 2] - bb;
        if (dr * dr + dg * dg + db * db <= threshold2 && lum(s[i], s[i + 1], s[i + 2]) > 142) {
          seen[p] = 1; queue[tail++] = p;
        }
      }
      for (var x = 0; x < W; x++) { add(x, 0); add(x, H - 1); }
      for (var y = 1; y < H - 1; y++) { add(0, y); add(W - 1, y); }
      while (head < tail) {
        var p = queue[head++], qx = p % W, qy = (p / W) | 0;
        add(qx - 1, qy); add(qx + 1, qy); add(qx, qy - 1); add(qx, qy + 1);
      }
      var out = cx.createImageData(W, H), d = out.data;
      /* A second, deliberately tighter colour key removes islands of the
         photographed stock that the edge flood cannot reach (between toes,
         under the bill, etc.). Keeping this threshold well below the flood
         threshold protects pale plumage while removing the source rectangle. */
      /* The bill is a narrow cream wedge enclosed by only a few dark source
         pixels. A broad global key can mistake that light interior for stock
         and square the tip off. Keep the island cleanup conservative; the
         edge flood still removes the large photographed sheet. */
      var islandThreshold = threshold * 0.32;
      var islandThreshold2 = islandThreshold * islandThreshold;
      for (var i = 0, pi = 0; i < s.length; i += 4, pi++) {
        if (seen[pi]) continue;
        var idr = s[i] - br, idg = s[i + 1] - bg, idb = s[i + 2] - bb;
        if (idr * idr + idg * idg + idb * idb <= islandThreshold2 &&
            lum(s[i], s[i + 1], s[i + 2]) > 160) continue;
        d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3];
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
      if (o.sharpen) sharpen(cx, W, H, o.sharpen);
    },

    // Build the postal keyline from the already-cleaned specimen rather than
    // from a CSS filter. The two-pass alpha dilation has room inside the
    // registration canvas even when the original scan touches an edge at a
    // narrow extremity (the Waxwing bill), so the cream line cannot clip.
    // A circular structuring element keeps that narrow bill tip tapered;
    // separable horizontal/vertical dilation leaves a visibly square cap.
    waxHalo: function (cx, W, H, im, o) {
      o = o || {};
      var clean = offscreen(W, H), cc = clean.getContext('2d');
      T.waxCutout(cc, W, H, im, o);
      var src = cc.getImageData(0, 0, W, H).data;
      var radius = Math.max(2, Math.round(Math.min(W, H) * (o.radius || 0.012)));
      var expanded = new Uint8Array(W * H);
      var x, y, dx, dy, p, a;
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        a = 0;
        for (dy = -radius; dy <= radius; dy++) {
          if (y + dy < 0 || y + dy >= H) continue;
          var span = Math.floor(Math.sqrt(radius * radius - dy * dy));
          for (dx = -span; dx <= span; dx++) {
            if (x + dx < 0 || x + dx >= W) continue;
            a = Math.max(a, src[((y + dy) * W + x + dx) * 4 + 3]);
          }
        }
        expanded[y * W + x] = a;
      }
      var cream = hex2rgb(o.cream || '#eee9de');
      var out = cx.createImageData(W, H), d = out.data;
      for (p = 0; p < expanded.length; p++) {
        a = expanded[p];
        if (a < 10) continue;
        var i = p * 4;
        d[i] = cream[0]; d[i + 1] = cream[1]; d[i + 2] = cream[2]; d[i + 3] = a;
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- INK STAMP: a one-colour tonal separation, like an engraved or
    // brushed plate pressed into absorbent matte stock. Source luminance
    // decides where ink is carried; a real paper scan only modulates density.
    // Unlike a distress/noise filter, this preserves feather structure and
    // lets pale plumage resolve as the paper itself.
    inkStamp: function (cx, W, H, im, o) {
      o = o || {};
      var off = offscreen(W, H), oc = off.getContext('2d');
      drawBird(oc, im, W, H, {
        fit: (o.fit || 'bird'), pad: (o.pad != null ? o.pad : 0.01),
        scale: (o.scale != null ? o.scale : 1),
        offsetX: o.offsetX || 0, offsetY: o.offsetY || 0
      });
      var src = oc.getImageData(0, 0, W, H), s = src.data;
      var paper = offscreen(W, H), pc = paper.getContext('2d');
      if (o.paperImage) pc.drawImage(o.paperImage, 0, 0, W, H);
      else { pc.fillStyle = '#b8b8b8'; pc.fillRect(0, 0, W, H); }
      var tooth = pc.getImageData(0, 0, W, H).data;
      var out = cx.createImageData(W, H), d = out.data;
      var ink = hex2rgb(o.ink || '#18221d');
      var lift = o.lift != null ? o.lift : 0.1;
      var contrast = o.contrast != null ? o.contrast : 1.2;
      for (var i = 0; i < s.length; i += 4) {
        var alpha = s[i + 3] / 255;
        if (alpha < 0.018) continue;
        var light = lum(s[i], s[i + 1], s[i + 2]) / 255;
        // Continuous ink density keeps the plate photographic/engraved. The
        // mild toe removes the illustration's cream ground without turning
        // transitions into digital steps.
        var density = Math.max(0, Math.min(1, ((1 - light) - lift) * contrast));
        density = Math.pow(density, 0.82);
        // The actual fibre scan varies absorption continuously; it never cuts
        // artificial holes through the subject.
        var p = lum(tooth[i], tooth[i + 1], tooth[i + 2]) / 255;
        var absorption = 0.88 + (0.5 - p) * 0.42;
        var a = Math.max(0, Math.min(1, alpha * density * absorption));
        d[i] = ink[0]; d[i + 1] = ink[1]; d[i + 2] = ink[2]; d[i + 3] = Math.round(a * 255);
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },
    // ---- CYANOTYPE: blue-toned duotone photo + chemical mottle. Fills the
    // whole canvas (transparent -> the deep-blue ground), so bird + field are
    // one print. ----
    cyanotype: function (cx, W, H, im, o) {
      o = o || {};
      var rand = o.seed ? seededNoise(o.seed) : Math.random;
      // deep Prussian-blue shadow, near-white cyan highlight -> luminous specimen
      var sh = o.shadow || [8, 30, 66], hi = o.hi || [226, 238, 236];
      var gamma = o.gamma || 0.72, gl = o.groundL != null ? o.groundL : 0.055;
      cx.clearRect(0, 0, W, H);
      // zoom in on the bird (like the halftone) unless told otherwise
      drawBird(cx, im, W, H, {
        fit: (o.fit || 'bird'),
        pad: (o.pad != null ? o.pad : 0.1),
        offsetX: o.offsetX || 0,
        offsetY: o.offsetY || 0
      });
      var id = cx.getImageData(0, 0, W, H), p = id.data;
      var gr0 = sh[0] + (hi[0] - sh[0]) * gl, gr1 = sh[1] + (hi[1] - sh[1]) * gl, gr2 = sh[2] + (hi[2] - sh[2]) * gl;
      for (var i = 0; i < p.length; i += 4) {
        var a = p[i + 3], r, g, b;
        if (a < 6) { r = gr0; g = gr1; b = gr2; }
        else {
          var l = Math.pow(lum(p[i], p[i + 1], p[i + 2]) / 255, gamma);
          var br = sh[0] + (hi[0] - sh[0]) * l, bg = sh[1] + (hi[1] - sh[1]) * l, bb = sh[2] + (hi[2] - sh[2]) * l;
          var t = a / 255; // feather the cut edge into the ground, no speckle
          r = gr0 + (br - gr0) * t; g = gr1 + (bg - gr1) * t; b = gr2 + (bb - gr2) * t;
        }
        p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = 255;
      }
      cx.putImageData(id, 0, 0);
      // Restore contact-edge and feather definition before the physical
      // process layers are added; sharpening after grain would digitise the
      // paper tooth instead of clarifying the specimen.
      sharpen(cx, W, H, o.sharpen || 0);
      // subtle chemical wash + fine grain, kept gentle so edges stay calm
      mottle(cx, W, H, o.mottle || 5, o.mottleAlpha != null ? o.mottleAlpha : 0.045, rand);
      grain(cx, W, H, o.grain != null ? o.grain : 0.024, rand);
      var vg = cx.createRadialGradient(W / 2, H * 0.46, H * 0.3, W / 2, H * 0.5, H * 0.84);
      vg.addColorStop(0, 'rgba(6,20,44,0)'); vg.addColorStop(1, 'rgba(4,15,36,0.28)');
      cx.fillStyle = vg; cx.fillRect(0, 0, W, H);
    },

    // ---- HALFTONE: real dot screen; dot radius grows with darkness ----
    halftone: function (cx, W, H, im, o) {
      o = o || {};
      var dot = (o.dot || 0.014) * W, ink = o.ink || '#181818', paper = o.paper || '#efe9db';
      var off = offscreen(W, H), oc = off.getContext('2d');
      if (o.crop) { // crop tight to a normalized box [x,y,w,h] of the image
        var c = o.crop; oc.drawImage(im, c[0] * im.width, c[1] * im.height, c[2] * im.width, c[3] * im.height, 0, 0, W, H);
      } else { drawBird(oc, im, W, H, { fit: (o.fit || 'full'), pad: (o.pad != null ? o.pad : 0.03), head: o.head, headw: o.headw, cover: o.cover }); }
      var d = oc.getImageData(0, 0, W, H).data;
      cx.fillStyle = paper; cx.fillRect(0, 0, W, H); cx.fillStyle = ink;
      for (var y = dot / 2; y < H; y += dot) for (var x = dot / 2; x < W; x += dot) {
        var idx = ((y | 0) * W + (x | 0)) * 4, al = d[idx + 3] / 255;
        if (al < 0.4) continue;
        var l = lum(d[idx], d[idx + 1], d[idx + 2]) / 255;
        var r = (1 - l) * dot * 0.7 * al;
        if (r > 0.35) { cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.fill(); }
      }
    },

    // ---- LOW-POLY: Delaunay facets coloured from the bird ("geode") ----
    lowpoly: function (cx, W, H, im, o) {
      o = o || {};
      // A seed gives reviewable, repeatable facets instead of changing the
      // composition on every render. Unseeded callers retain the old motion.
      var seed = (o.seed >>> 0) || 0;
      var rand = seed ? function () {
        seed += 0x6D2B79F5;
        var z = seed;
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
      } : Math.random;
      var drawO = {
        fit: (o.fit || 'bird'), pad: (o.pad != null ? o.pad : 0.06),
        head: o.head, headw: o.headw, cover: o.cover,
        offsetX: o.offsetX, offsetY: o.offsetY,
        scale: o.scale, rotate: o.rotate
      };
      var off = offscreen(W, H), oc = off.getContext('2d');
      drawBird(oc, im, W, H, drawO);
      var d = oc.getImageData(0, 0, W, H).data;
      var A = function (x, y) { return d[(((y | 0) * W) + (x | 0)) * 4 + 3]; };
      var C = function (x, y) { var i = (((y | 0) * W) + (x | 0)) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      var L = function (x, y) { var i = (((y | 0) * W) + (x | 0)) * 4; return lum(d[i], d[i + 1], d[i + 2]) / 255; };
      var total = [0, 0, 0], totalN = 0, mass = 0;
      var momentX = 0, momentY = 0, momentXX = 0, momentXY = 0, momentYY = 0;
      var alphaMinX = W, alphaMinY = H, alphaMaxX = 0, alphaMaxY = 0;
      for (var di = 0; di < d.length; di += 4) if (d[di + 3] > 50) {
        var pixel = di / 4, py0 = Math.floor(pixel / W), px0 = pixel - py0 * W;
        var weight = d[di + 3] / 255;
        total[0] += d[di]; total[1] += d[di + 1]; total[2] += d[di + 2]; totalN++;
        mass += weight; momentX += px0 * weight; momentY += py0 * weight;
        momentXX += px0 * px0 * weight; momentXY += px0 * py0 * weight; momentYY += py0 * py0 * weight;
        if (px0 < alphaMinX) alphaMinX = px0; if (px0 > alphaMaxX) alphaMaxX = px0;
        if (py0 < alphaMinY) alphaMinY = py0; if (py0 > alphaMaxY) alphaMaxY = py0;
      }
      var global = totalN ? [total[0] / totalN, total[1] / totalN, total[2] / totalN] : [140, 112, 76];
      var globalH = rgb2hsl(global)[0];
      var centreX = mass ? momentX / mass : W / 2, centreY = mass ? momentY / mass : H / 2;
      var covXX = mass ? momentXX / mass - centreX * centreX : 1;
      var covXY = mass ? momentXY / mass - centreX * centreY : 0;
      var covYY = mass ? momentYY / mass - centreY * centreY : 1;
      var flowAngle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
      if (o.flowAligned && o.flowOffset) flowAngle += o.flowOffset * Math.PI / 180;
      // The source alpha is useful evidence, but its tiny feather and scan
      // irregularities should not become the finished stamp silhouette. Trace
      // the main connected boundary and simplify it into a deliberate polygon.
      // A lower tolerance around the leftmost quarter protects a narrow beak
      // while the head, body, wing and tail resolve into much harder vertices.
      var clipLayer = off;
      if (o.polygonOutline) {
        var threshold = o.outlineAlpha || 50, edges = [], starts = Object.create(null);
        function opaque(xx, yy) { return xx >= 0 && yy >= 0 && xx < W && yy < H && A(xx, yy) >= threshold; }
        function edge(ax, ay, bx, by) {
          var item = { a:[ax, ay], b:[bx, by], used:false }, key = ax + ',' + ay;
          edges.push(item); (starts[key] || (starts[key] = [])).push(item);
        }
        for (var oy = 0; oy < H; oy++) for (var ox = 0; ox < W; ox++) if (opaque(ox, oy)) {
          if (!opaque(ox, oy - 1)) edge(ox, oy, ox + 1, oy);
          if (!opaque(ox + 1, oy)) edge(ox + 1, oy, ox + 1, oy + 1);
          if (!opaque(ox, oy + 1)) edge(ox + 1, oy + 1, ox, oy + 1);
          if (!opaque(ox - 1, oy)) edge(ox, oy + 1, ox, oy);
        }
        var loops = [];
        for (var ei0 = 0; ei0 < edges.length; ei0++) if (!edges[ei0].used) {
          var firstEdge = edges[ei0], loop = [firstEdge.a], currentEdge = firstEdge, guard = 0;
          while (currentEdge && !currentEdge.used && guard++ < edges.length + 2) {
            currentEdge.used = true; loop.push(currentEdge.b);
            if (currentEdge.b[0] === loop[0][0] && currentEdge.b[1] === loop[0][1]) break;
            var nextList = starts[currentEdge.b[0] + ',' + currentEdge.b[1]] || [], nextEdge = null;
            for (var ne = 0; ne < nextList.length; ne++) if (!nextList[ne].used) { nextEdge = nextList[ne]; break; }
            currentEdge = nextEdge;
          }
          if (loop.length > 8 && loop[loop.length - 1][0] === loop[0][0] && loop[loop.length - 1][1] === loop[0][1]) loops.push(loop.slice(0, -1));
        }
        function loopArea(points) {
          var area = 0;
          for (var ai = 0; ai < points.length; ai++) {
            var aj = (ai + 1) % points.length;
            area += points[ai][0] * points[aj][1] - points[aj][0] * points[ai][1];
          }
          return Math.abs(area / 2);
        }
        loops.sort(function (a, b) { return loopArea(b) - loopArea(a); });
        if (loops.length) {
          var rawLoop = loops[0], minI = 0, maxI = 0;
          for (var li = 1; li < rawLoop.length; li++) {
            if (rawLoop[li][0] < rawLoop[minI][0]) minI = li;
            if (rawLoop[li][0] > rawLoop[maxI][0]) maxI = li;
          }
          function chain(from, to) {
            var out = [rawLoop[from]], ci = from;
            while (ci !== to && out.length <= rawLoop.length + 1) { ci = (ci + 1) % rawLoop.length; out.push(rawLoop[ci]); }
            return out;
          }
          function segmentDistance(p, a, b) {
            var dx = b[0] - a[0], dy = b[1] - a[1];
            if (!dx && !dy) { dx = p[0] - a[0]; dy = p[1] - a[1]; return Math.sqrt(dx * dx + dy * dy); }
            var q = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
            var px1 = a[0] + q * dx, py1 = a[1] + q * dy;
            dx = p[0] - px1; dy = p[1] - py1; return Math.sqrt(dx * dx + dy * dy);
          }
          var outlineEpsilon = (o.outlineTolerance || 0.018) * W;
          var beakLimit = rawLoop[minI][0] + (rawLoop[maxI][0] - rawLoop[minI][0]) * (o.beakProtect || 0.28);
          /* Keep the beak's tip and full span, but reject the tiny alpha-mask
             wobbles between them. Its top and bottom should read as a few long
             cut-paper edges while the head and body retain more low-poly turns. */
          var beakSimplify = o.beakSimplify == null ? 0.86 : o.beakSimplify;
          function simplifyLine(points) {
            if (points.length <= 2) return points.slice();
            var a = points[0], b = points[points.length - 1], best = 0, bestI = -1;
            for (var si = 1; si < points.length - 1; si++) {
              var localEpsilon = points[si][0] <= beakLimit ? outlineEpsilon * beakSimplify : outlineEpsilon;
              var score = segmentDistance(points[si], a, b) / localEpsilon;
              if (score > best) { best = score; bestI = si; }
            }
            if (best <= 1 || bestI < 0) return [a, b];
            var left = simplifyLine(points.slice(0, bestI + 1));
            var right = simplifyLine(points.slice(bestI));
            return left.slice(0, -1).concat(right);
          }
          var upper = simplifyLine(chain(minI, maxI));
          var lower = simplifyLine(chain(maxI, minI));
          var outline = upper.slice(0, -1).concat(lower.slice(0, -1));
          if (outline.length >= 3) {
            var polygon = offscreen(W, H), pcx = polygon.getContext('2d');
            pcx.fillStyle = '#fff'; pcx.lineJoin = 'miter';
            pcx.beginPath(); pcx.moveTo(outline[0][0], outline[0][1]);
            for (var oi0 = 1; oi0 < outline.length; oi0++) pcx.lineTo(outline[oi0][0], outline[oi0][1]);
            pcx.closePath(); pcx.fill(); clipLayer = polygon;
          }
        }
      }
      // Bigger facets = lower-poly / lower-res. Hummingbirds use a stable
      // staggered lattice: it is identical on every render and leaves the
      // image-derived edge anchors below, not random jitter, to explain where
      // extra vertices appear.
      var step = (o.step || 0.11) * W, pts = [];
      if (o.structured) {
        var row = 0, rowStep = step * 0.8660254;
        var radius = Math.sqrt(W * W + H * H), ca = Math.cos(flowAngle), sa = Math.sin(flowAngle);
        for (var v = -radius; v <= radius; v += rowStep, row++) {
          var phase = (row % 2) * step * 0.5;
          for (var u = -radius + phase; u <= radius; u += step) {
            var alignedX = centreX + u * ca - v * sa;
            var alignedY = centreY + u * sa + v * ca;
            if (alignedX >= -step && alignedX <= W + step && alignedY >= -step && alignedY <= H + step) {
              pts.push([alignedX, alignedY]);
            }
          }
        }
      } else {
        for (var y0 = -step; y0 <= H + step; y0 += step) for (var x0 = -step; x0 <= W + step; x0 += step) {
          pts.push([x0 + (rand() - 0.5) * step * 0.62, y0 + (rand() - 0.5) * step * 0.62]);
        }
      }
      // Edge-aware seed placement follows the established low-poly pipeline:
      // Sobel-like gradient detection, cell-wise sparsification, then Delaunay.
      // This concentrates triangles on real plumage/silhouette transitions
      // instead of fragmenting the bird uniformly or with arbitrary patches.
      if (o.edgeAware) {
        var px = function (xx, yy) {
          xx = Math.max(0, Math.min(W - 1, xx | 0)); yy = Math.max(0, Math.min(H - 1, yy | 0));
          var ii = (yy * W + xx) * 4, al = d[ii + 3] / 255;
          return [d[ii], d[ii + 1], d[ii + 2], al, lum(d[ii], d[ii + 1], d[ii + 2]) / 255 * al];
        };
        var edgeScore = function (xx, yy) {
          var mid = px(xx, yy); if (mid[3] < 0.08) return 0;
          var tl = px(xx - 1, yy - 1), tc = px(xx, yy - 1), trp = px(xx + 1, yy - 1);
          var ml = px(xx - 1, yy), mr = px(xx + 1, yy);
          var bl = px(xx - 1, yy + 1), bc = px(xx, yy + 1), br = px(xx + 1, yy + 1);
          // The source alpha already clips the finished mesh exactly. Ignore
          // boundary gradients here so fine beaks and feet stay intact without
          // accumulating a necklace of tiny edge triangles.
          if (o.edgeAlpha === false && Math.min(tc[3], ml[3], mr[3], bc[3]) < 0.72) return 0;
          var gx = -tl[4] + trp[4] - 2 * ml[4] + 2 * mr[4] - bl[4] + br[4];
          var gy = -tl[4] - 2 * tc[4] - trp[4] + bl[4] + 2 * bc[4] + br[4];
          var sobel = Math.sqrt(gx * gx + gy * gy) / 5.66;
          var chroma = (Math.abs(mr[0] - ml[0]) + Math.abs(mr[1] - ml[1]) + Math.abs(mr[2] - ml[2]) +
            Math.abs(bc[0] - tc[0]) + Math.abs(bc[1] - tc[1]) + Math.abs(bc[2] - tc[2])) / 1530;
          var alphaEdge = (Math.abs(mr[3] - ml[3]) + Math.abs(bc[3] - tc[3])) / 2;
          return sobel * 0.58 + chroma * 0.74 + (o.edgeAlpha === false ? 0 : alphaEdge * 0.32);
        };
        var edgeCell = step * (o.edgeCell || 0.5), candidates = [];
        var scan = Math.max(2, Math.round(Math.min(W, H) / 90));
        for (var ecy = 1; ecy < H - 1; ecy += edgeCell) for (var ecx = 1; ecx < W - 1; ecx += edgeCell) {
          var bx = 0, by = 0, bs = 0;
          for (var ey = ecy; ey < Math.min(H - 1, ecy + edgeCell); ey += scan) {
            for (var ex = ecx; ex < Math.min(W - 1, ecx + edgeCell); ex += scan) {
              var es = edgeScore(ex, ey); if (es > bs) { bs = es; bx = ex; by = ey; }
            }
          }
          if (bs >= (o.edgeThreshold || 0.115)) candidates.push([bx, by, bs]);
        }
        candidates.sort(function (a, b) { return b[2] - a[2]; });
        var edgePts = [], maxEdge = o.edgePoints || 22, minEdge = step * (o.edgeMin || 0.25);
        for (var ci = 0; ci < candidates.length && edgePts.length < maxEdge; ci++) {
          var can = candidates[ci], clear = true;
          for (var ep = 0; ep < edgePts.length; ep++) {
            var dx = can[0] - edgePts[ep][0], dy = can[1] - edgePts[ep][1];
            if (dx * dx + dy * dy < minEdge * minEdge) { clear = false; break; }
          }
          if (clear) { edgePts.push(can); pts.push([can[0], can[1]]); }
        }
      }
      // One denser patch can follow a meaningful plumage transition (the
      // hummingbird's gorget) while the rest of the body keeps broad planes.
      if (o.focus && o.focus.length >= 4) {
        var fx = o.focus[0] * W, fy = o.focus[1] * H, frx = o.focus[2] * W, fry = o.focus[3] * H;
        var fs = step * (o.focusStep || 0.48);
        for (var fv = -fry; fv <= fry; fv += fs) for (var fu = -frx; fu <= frx; fu += fs) {
          var ex = fu / frx, ey = fv / fry;
          if (ex * ex + ey * ey <= 1) {
            if (o.focusAligned && o.structured) pts.push([fx + fu * ca - fv * sa, fy + fu * sa + fv * ca]);
            else pts.push([fx + fu, fy + fv]);
          }
        }
      }
      var tris = delaunay(pts, W, H);
      // vibrant "geode" bands, dark -> light; each facet snaps to one (split into proper colours)
      var vibrant = o.vibrant !== false;
      var pal = (o.palette || ['#2a0b4e', '#5b1f9c', '#9b1fa6', '#d61f6a', '#f0552a', '#f8a51b', '#f6e37a']).map(hex2rgb);
      var palLabs = pal.map(rgb2oklab), palHsl = pal.map(rgb2hsl);
      function nearestInkIndex(rgb) {
        var targetLab = rgb2oklab(rgb), targetHsl = rgb2hsl(rgb), nearest = 0, nearestScore = Infinity;
        if (o.vibrantBirdMap && pal.length >= 7) {
          var redBias = rgb[0] - (rgb[1] + rgb[2]) * 0.5;
          var greenBias = rgb[1] * 2 - rgb[0] - rgb[2];
          var greenSlope = (rgb[1] - rgb[2]) - (rgb[0] - rgb[1]);
          // The aged plate compresses olive wing feathers into the same HSL
          // hue as the brown breast. Relative channel bias recovers the visual
          // distinction: magenta head, green wing, warm breast/tail.
          if (redBias > 30 && (targetHsl[0] < 22 || targetHsl[0] > 335)) return targetHsl[2] < 0.31 ? 0 : (targetHsl[2] > 0.44 ? 1 : 2);
          if (greenBias > 7 || greenSlope > 6) return targetHsl[2] < 0.25 ? 6 : 5;
          return targetHsl[2] < 0.28 ? 3 : 4;
        }
        if (o.huePalette && targetHsl[1] < 0.11) targetHsl[0] = globalH;
        for (var ni = 0; ni < palLabs.length; ni++) {
          var distance;
          if (o.huePalette) {
            var hueDistance = Math.abs(targetHsl[0] - palHsl[ni][0]);
            hueDistance = Math.min(hueDistance, 360 - hueDistance) / 180;
            distance = hueDistance * 1.18 + Math.abs(targetHsl[2] - palHsl[ni][2]) * 0.30 + Math.abs(targetHsl[1] - palHsl[ni][1]) * 0.05;
          } else {
            var dl = (targetLab[0] - palLabs[ni][0]) * 1.12;
            var da = targetLab[1] - palLabs[ni][1], db = targetLab[2] - palLabs[ni][2];
            distance = dl * dl + da * da + db * db;
          }
          if (distance < nearestScore) { nearestScore = distance; nearest = ni; }
        }
        return nearest;
      }
      function inside(px, py, tr) {
        var ax = tr[0][0], ay = tr[0][1], bx = tr[1][0], by = tr[1][1], cx0 = tr[2][0], cy0 = tr[2][1];
        var e0 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
        var e1 = (px - cx0) * (by - cy0) - (bx - cx0) * (py - cy0);
        var e2 = (px - ax) * (cy0 - ay) - (cx0 - ax) * (py - ay);
        return (e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0);
      }
      function sourceFacet(tr) {
        var x0 = Math.max(0, Math.floor(Math.min(tr[0][0], tr[1][0], tr[2][0])));
        var y0 = Math.max(0, Math.floor(Math.min(tr[0][1], tr[1][1], tr[2][1])));
        var x1 = Math.min(W - 1, Math.ceil(Math.max(tr[0][0], tr[1][0], tr[2][0])));
        var y1 = Math.min(H - 1, Math.ceil(Math.max(tr[0][1], tr[1][1], tr[2][1])));
        var stride = Math.max(2, Math.round(Math.min(W, H) * 0.012));
        var sum = [0, 0, 0], n = 0;
        var inkVotes = o.paletteVote && palLabs.length ? pal.map(function () { return 0; }) : null;
        for (var sy = y0; sy <= y1; sy += stride) for (var sx = x0; sx <= x1; sx += stride) {
          if (!inside(sx, sy, tr) || A(sx, sy) < 50) continue;
          var cc = C(sx, sy); sum[0] += cc[0]; sum[1] += cc[1]; sum[2] += cc[2]; n++;
          if (inkVotes) inkVotes[nearestInkIndex(cc)]++;
        }
        var avg = n ? [sum[0] / n, sum[1] / n, sum[2] / n] : global;
        // A large facet can cover two feather fields. Averaging those colours
        // makes an invented muddy third colour; a per-pixel palette vote keeps
        // the plane tied to the dominant real plumage beneath it and produces
        // the clean, decisive colour separations of the rooster reference.
        if (inkVotes && n) {
          var winningInk = 0;
          for (var iv = 1; iv < inkVotes.length; iv++) if (inkVotes[iv] > inkVotes[winningInk]) winningInk = iv;
          return pal[winningInk];
        }
        var hsl = rgb2hsl(avg);
        // Paper-white feathers become a quiet species-derived tone so white
        // is reserved exclusively for the silhouette keyline.
        if (hsl[1] < 0.12 && hsl[2] > 0.72) { hsl[0] = globalH; hsl[1] = 0.28; hsl[2] = 0.64; }
        else {
          hsl[1] = Math.min(0.76, Math.max(hsl[2] > 0.26 ? 0.24 : 0.06, hsl[1] * 1.32));
          hsl[2] = Math.min(0.68, Math.max(0.20, hsl[2] * 0.92));
        }
        var tuned = hsl2rgb(hsl);
        // A reference-derived print palette keeps the source hue layout while
        // collapsing photographic variation into a few decisive ink colours.
        if (o.quantizeSource && pal.length) {
          var th = rgb2hsl(tuned), best = pal[0], bestScore = Infinity;
          if (o.perceptualPalette) {
            // Every facet is assigned from the opaque pixels directly beneath
            // that triangle. Snap the resulting average to the nearest print
            // ink in perceptual space; no positional or random colour choice.
            var targetLab = rgb2oklab(avg);
            for (var oi = 0; oi < pal.length; oi++) {
              var inkLab = palLabs[oi];
              var dl = (targetLab[0] - inkLab[0]) * 1.12;
              var da = targetLab[1] - inkLab[1], db = targetLab[2] - inkLab[2];
              var distance = dl * dl + da * da + db * db;
              if (distance < bestScore) { bestScore = distance; best = pal[oi]; }
            }
            return best;
          }
          if (o.birdPalette && pal.length >= 7) {
            if (th[1] < 0.14) return th[2] < 0.34 ? pal[6] : (th[2] > 0.58 ? pal[5] : pal[4]);
            if (th[0] >= 330 || th[0] < 8) return pal[0];
            if (th[0] < 35) return th[2] > 0.46 ? pal[1] : pal[0];
            if (th[0] < 43) return th[2] > 0.52 ? pal[4] : pal[5];
            if (th[0] < 78) return pal[2];
            if (th[0] < 135) return th[2] > 0.44 ? pal[2] : pal[3];
            if (th[0] < 178) return pal[3];
            if (th[0] >= 285) return th[2] > 0.42 ? pal[0] : pal[6];
            return pal[6];
          }
          // The five-ink Hummingbird issue has semantic bands: red/coral
          // gorget, green plumage, ochre underside and violet shadow. Keep
          // those relationships stronger than literal photographic value.
          if (pal.length === 5) {
            if (th[1] < 0.16) return th[2] < 0.34 ? pal[4] : pal[3];
            if (th[0] >= 330 || th[0] < 8) return pal[0];
            if (th[0] < 38) return th[2] > 0.48 ? pal[1] : pal[0];
            if (th[0] < 58) return th[2] > 0.52 ? pal[3] : pal[2];
            if (th[0] < 178) return pal[2];
            if (th[0] >= 285) return th[2] > 0.42 ? pal[0] : pal[4];
            return pal[4];
          }
          for (var pi = 0; pi < pal.length; pi++) {
            var ph = rgb2hsl(pal[pi]);
            var hd = Math.abs(th[0] - ph[0]); hd = Math.min(hd, 360 - hd) / 180;
            var score = hd * 0.62 + Math.abs(th[1] - ph[1]) * 0.16 + Math.abs(th[2] - ph[2]) * 0.72;
            if (score < bestScore) { bestScore = score; best = pal[pi]; }
          }
          return best;
        }
        return tuned;
      }
      function semanticHummingbird() {
        var bw = Math.max(1, alphaMaxX - alphaMinX), bh = Math.max(1, alphaMaxY - alphaMinY);
        var facesLeft = centreX - alphaMinX >= alphaMaxX - centreX;
        function uvPoint(x, y) {
          return [(facesLeft ? x - alphaMinX : alphaMaxX - x) / bw, (y - alphaMinY) / bh];
        }
        function xyPoint(p) {
          return [facesLeft ? alphaMinX + p[0] * bw : alphaMaxX - p[0] * bw, alphaMinY + p[1] * bh];
        }
        function inZone(p, poly) {
          var insideZone = false;
          for (var i0 = 0, j0 = poly.length - 1; i0 < poly.length; j0 = i0++) {
            var xi = poly[i0][0], yi = poly[i0][1], xj = poly[j0][0], yj = poly[j0][1];
            if (((yi > p[1]) !== (yj > p[1])) && p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-8) + xi) insideZone = !insideZone;
          }
          return insideZone;
        }
        // Canonical left-facing hummingbird regions. These are expressed in
        // the detected silhouette bounds, so the same topology follows Anna's,
        // Costa's, Rufous, Ruby-throated and Black-chinned source plates.
        var zones = {
          tail: [[0.48,0.42],[1.08,0.36],[1.08,1.08],[0.44,1.08]],
          wing: [[0.47,0.19],[0.79,0.19],[0.99,0.67],[0.78,0.80],[0.56,0.55]],
          breast: [[0.30,0.28],[0.54,0.26],[0.68,0.59],[0.80,0.84],[0.53,0.75],[0.35,0.53]],
          neck: [[0.27,0.18],[0.56,0.16],[0.59,0.37],[0.47,0.47],[0.30,0.36]],
          headUpper: [[0.24,-0.02],[0.52,-0.02],[0.62,0.18],[0.48,0.23],[0.27,0.13]],
          headLower: [[0.25,0.09],[0.50,0.10],[0.56,0.25],[0.38,0.31],[0.27,0.22]],
          beak: [[-0.05,0.035],[0.32,0.035],[0.34,0.16],[-0.05,0.16]]
        };
        function sampledInk(poly, fallback) {
          var votes = pal.map(function () { return 0; }), stride = Math.max(2, Math.round(Math.min(W, H) / 105));
          for (var yy0 = alphaMinY; yy0 <= alphaMaxY; yy0 += stride) for (var xx0 = alphaMinX; xx0 <= alphaMaxX; xx0 += stride) {
            if (A(xx0, yy0) < 50 || !inZone(uvPoint(xx0, yy0), poly)) continue;
            votes[nearestInkIndex(C(xx0, yy0))]++;
          }
          var winner = fallback;
          for (var vi = 0; vi < votes.length; vi++) if (votes[vi] > votes[winner]) winner = vi;
          return winner;
        }
        function siblingInk(index, avoid) {
          var family = index <= 2 ? [0,1,2] : (index <= 4 ? [3,4] : [5,6]);
          for (var fi = 0; fi < family.length; fi++) if (family[fi] === index) {
            for (var fj = 1; fj <= family.length; fj++) {
              var candidate = family[(fi + fj) % family.length];
              if (candidate !== avoid) return candidate;
            }
          }
          return index;
        }
        var inks = {
          tail: sampledInk(zones.tail, 6),
          wing: sampledInk(zones.wing, 5),
          breast: sampledInk(zones.breast, 3),
          neck: sampledInk(zones.neck, 2),
          headUpper: sampledInk(zones.headUpper, 0),
          headLower: sampledInk(zones.headLower, 1),
          beak: sampledInk(zones.beak, 3)
        };
        if (inks.wing === inks.tail) inks.tail = siblingInk(inks.tail, inks.wing);
        if (inks.breast === inks.wing) inks.breast = siblingInk(inks.breast, inks.wing);
        if (inks.headLower === inks.headUpper) inks.headLower = siblingInk(inks.headLower, inks.headUpper);
        if (inks.neck === inks.headLower) inks.neck = siblingInk(inks.neck, inks.headLower);
        var sem = offscreen(W, H), sc = sem.getContext('2d');
        sc.fillStyle = 'rgb(' + pal[inks.tail].join(',') + ')'; sc.fillRect(0, 0, W, H);
        function paintZone(poly, ink) {
          var first = xyPoint(poly[0]); sc.fillStyle = 'rgb(' + pal[ink].join(',') + ')';
          sc.beginPath(); sc.moveTo(first[0], first[1]);
          for (var zi = 1; zi < poly.length; zi++) { var point = xyPoint(poly[zi]); sc.lineTo(point[0], point[1]); }
          sc.closePath(); sc.fill();
        }
        paintZone(zones.wing, inks.wing);
        paintZone(zones.breast, inks.breast);
        paintZone(zones.neck, inks.neck);
        paintZone(zones.headUpper, inks.headUpper);
        paintZone(zones.headLower, inks.headLower);
        paintZone(zones.beak, inks.beak);
        sc.globalCompositeOperation = 'destination-in'; sc.drawImage(clipLayer, 0, 0);
        return sem;
      }
      cx.clearRect(0, 0, W, H);
      cx.lineJoin = 'round';
      if (o.semanticHummingbird) {
        cx.drawImage(semanticHummingbird(), 0, 0);
      } else for (var t = 0; t < tris.length; t++) {
        var tr = tris[t];
        var mx = (tr[0][0] + tr[1][0] + tr[2][0]) / 3, my = (tr[0][1] + tr[1][1] + tr[2][1]) / 3;
        if (mx < 0 || my < 0 || mx >= W || my >= H) continue;
        var col;
        if (o.sourcePalette) {
          col = sourceFacet(tr);
        } else if (vibrant) {
          var l = L(mx, my);
          l = Math.min(1, Math.max(0, (l - 0.06) / 0.86)); // stretch tones across the bands
          var idx = Math.round(l * (pal.length - 1));
          var pc = pal[idx];
          var jit = (o.jitter != null ? o.jitter : 22); // 0 = clean colour bands (less fragmented)
          var j = (rand() - 0.5) * jit;
          col = [pc[0] + j, pc[1] + j, pc[2] + j];
        } else { col = C(mx, my); }
        var cs = 'rgb(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ')';
        cx.fillStyle = cx.strokeStyle = cs;
        cx.lineWidth = 1; // stroke same colour closes hairline gaps
        cx.beginPath(); cx.moveTo(tr[0][0], tr[0][1]); cx.lineTo(tr[1][0], tr[1][1]); cx.lineTo(tr[2][0], tr[2][1]); cx.closePath();
        cx.fill(); cx.stroke();
      }
      // Clip the facets back to the bird's true silhouette. The triangles
      // straddle the edge, so without this the outline comes out ragged and
      // the species is unreadable; keeping only pixels inside the alpha gives
      // an accurate outline with a low-poly interior.
      cx.globalCompositeOperation = 'destination-in';
      cx.drawImage(clipLayer, 0, 0);
      // Expand the original alpha behind the facets to create the white
      // keyline in the Argentine rooster reference. The colour planes stay
      // clipped to the real bird silhouette.
      if (o.keyline !== false) {
        var key = offscreen(W, H), kx = key.getContext('2d');
        kx.drawImage(clipLayer, 0, 0);
        kx.globalCompositeOperation = 'source-in';
        kx.fillStyle = o.keyline || '#fff';
        kx.fillRect(0, 0, W, H);
        var kr = (o.keylineWidth != null ? o.keylineWidth : 0.014) * W;
        cx.globalCompositeOperation = 'destination-over';
        for (var ka = 0; ka < 24; ka++) {
          var aa = ka / 24 * Math.PI * 2;
          if (o.keylineBottom === false && Math.sin(aa) > 0.05) continue;
          cx.drawImage(key, Math.cos(aa) * kr, Math.sin(aa) * kr);
        }
        cx.drawImage(key, 0, 0);
      }
      cx.globalCompositeOperation = 'source-over';
    },

    // ---- POSTER DITHER: one-ink ordered screen for vintage survey plates.
    // A small Bayer matrix turns both opaque photographs and transparent
    // species cutouts into the same deterministic two-ink material. ----
    posterDither: function (cx, W, H, im, o) {
      o = o || {};
      var off = offscreen(W, H), oc = off.getContext('2d');
      if (o.cover) {
        var scale = Math.max(W / im.width, H / im.height);
        var dw = im.width * scale, dh = im.height * scale;
        var px = o.posX != null ? o.posX : 0.5, py = o.posY != null ? o.posY : 0.5;
        oc.drawImage(im, (W - dw) * px, (H - dh) * py, dw, dh);
      } else {
        drawBird(oc, im, W, H, {
          fit: (o.fit || 'bird'), pad: (o.pad != null ? o.pad : 0.02),
          offsetX: o.offsetX || 0, offsetY: o.offsetY || 0,
          scale: o.scale || 1, rotate: o.rotate || 0
        });
      }
      var d = oc.getImageData(0, 0, W, H).data;
      var bayer = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
      var cell = Math.max(1, Math.round((o.cell || 0.012) * W));
      var contrast = o.contrast != null ? o.contrast : 1.15;
      var bias = o.bias != null ? o.bias : 0.16;
      cx.clearRect(0, 0, W, H);
      cx.fillStyle = o.ink || '#e8dfc5';
      for (var y = 0, gy = 0; y < H; y += cell, gy++) for (var x = 0, gx = 0; x < W; x += cell, gx++) {
        var sx = Math.min(W - 1, x + (cell >> 1)), sy = Math.min(H - 1, y + (cell >> 1));
        var i = (sy * W + sx) * 4, a = d[i + 3] / 255;
        if (a < 0.08) continue;
        var l = lum(d[i], d[i + 1], d[i + 2]) / 255;
        var tone = Math.max(0, Math.min(1, (l - 0.5) * contrast + 0.5 + bias)) * a;
        var threshold = (bayer[(gy & 3) * 4 + (gx & 3)] + 0.5) / 16;
        if (tone > threshold) cx.fillRect(x, y, Math.min(cell, W - x), Math.min(cell, H - y));
      }
    },

    // ---- INTAGLIO PLATE: coherent, tone-driven engraving screens. ----
    // A Bayer screen breaks a bird into unrelated pixels. This treatment
    // starts with one readable cream exposure, then removes long green hatch
    // lines according to the source luminance. A second angled screen appears
    // only in deep shadow, so eyes, facial discs and feathers gain structure
    // without sacrificing the silhouette. The same two-ink logic is used for
    // the landscape, which makes the Owl issue feel printed from one plate.
    intaglio: function (cx, W, H, im, o) {
      o = o || {};
      var src = offscreen(W, H), sc = src.getContext('2d');
      if (o.cover) {
        var cs = Math.max(W / im.width, H / im.height);
        var cdw = im.width * cs, cdh = im.height * cs;
        var cpx = o.posX != null ? o.posX : 0.5, cpy = o.posY != null ? o.posY : 0.5;
        sc.drawImage(im, (W - cdw) * cpx, (H - cdh) * cpy, cdw, cdh);
      } else {
        drawBird(sc, im, W, H, {
          fit: o.fit || 'bird', pad: (o.pad != null ? o.pad : 0.015),
          offsetX: o.offsetX || 0, offsetY: o.offsetY || 0,
          scale: o.scale || 1, rotate: o.rotate || 0
        });
      }

      var sd = sc.getImageData(0, 0, W, H).data;
      var out = cx.createImageData(W, H), od = out.data;
      var cream = hex2rgb(o.ink || '#e8dfc5');
      var gap = Math.max(5, Math.round((o.gap || 0.018) * W));
      var thin = Math.max(1, Math.round(gap * 0.16));
      var seed = +o.seed || 17, scene = o.mode === 'scene';
      var contrast = o.contrast != null ? o.contrast : 1.12;
      var bias = o.bias != null ? o.bias : 0;
      function frac(v) { return v - Math.floor(v); }
      function hash(x, y) {
        return frac(Math.sin((x + seed * 13.1) * 12.9898 + (y + seed * 7.7) * 78.233) * 43758.5453);
      }
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4, alpha = sd[i + 3] / 255;
        if (alpha < 0.07) continue;
        var light = lum(sd[i], sd[i + 1], sd[i + 2]) / 255;
        light = Math.max(0, Math.min(1, (light - 0.5) * contrast + 0.5 + bias));
        var dark = 1 - light;

        // Opaque photographs need a silhouette threshold so the sky remains
        // the green field. Transparent bird cutouts already supply the mask.
        if (scene) {
          var ridgeBase = o.ridge != null ? o.ridge : 0.14;
          var ridge = ridgeBase + 0.025 * Math.sin(x * 0.019 + seed);
          if (dark < ridge) continue;
          alpha = Math.min(1, (dark - ridge) * 3.4 + 0.34);
        }

        // Slight phase drift prevents the screen from looking mechanically
        // perfect while retaining the long, legible engraving strokes.
        var driftA = Math.sin(x * 0.021 + seed * 0.7) * 0.7;
        var driftB = Math.sin(y * 0.018 + seed * 0.31) * 0.65;
        var screenA = ((y + x * 0.105 + driftA + gap * 20) % gap) < thin;
        var gapB = gap * 1.42;
        var screenB = ((x - y * 0.86 + driftB + gapB * 20) % gapB) < thin;
        var screenC = ((x + y * 0.28 + gap * 20) % (gap * 0.72)) < thin;
        var cut = (screenA && dark > 0.19) ||
                  (screenB && dark > 0.50) ||
                  (screenC && dark > 0.78);

        // Sparse fibre/ink dropout weathers the plate without turning the
        // subject back into digital noise.
        var dropout = hash(x >> 1, y >> 1);
        if (o.dropout !== false && (dropout > 0.991 || (dark > 0.72 && dropout < 0.012))) cut = true;
        if (cut) continue;
        od[i] = cream[0]; od[i + 1] = cream[1]; od[i + 2] = cream[2];
        od[i + 3] = Math.round(255 * alpha);
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- LINE ENGRAVING: one-ink contour plate for definitive issues. ----
    // Unlike `intaglio`, this does not expose the whole subject as a pale
    // silhouette. The outside contour, feather transitions, eye and bill are
    // found from alpha/luminance gradients, then dark plumage receives a few
    // long directional cuts. The result behaves like the cream architectural
    // drawing on a single-colour Swiss definitive rather than a pasted photo.
    lineEngraving: function (cx, W, H, im, o) {
      o = o || {};
      var src = offscreen(W, H), sc = src.getContext('2d');
      drawBird(sc, im, W, H, {
        fit: o.fit || 'bird', pad: (o.pad != null ? o.pad : 0.012),
        offsetX: o.offsetX || 0, offsetY: o.offsetY || 0,
        scale: o.scale || 1, rotate: o.rotate || 0
      });

      var sd = sc.getImageData(0, 0, W, H).data;
      var out = cx.createImageData(W, H), od = out.data;
      var ink = hex2rgb(o.ink || '#f1e4cf');
      var edgeThreshold = o.edgeThreshold != null ? o.edgeThreshold : 0.075;
      var hatchGap = Math.max(7, Math.round((o.gap || 0.026) * W));
      var hatchStrength = Math.max(0.7, Math.min(1.55, o.hatchStrength || 1));
      var hatchWidth = Math.max(1, Math.round(hatchGap * 0.15 * hatchStrength));
      var lineRadius = Math.max(1, Math.round((o.lineWidth || 0.0048) * W));
      var seed = +o.seed || 31;
      var smoothRadius = Math.max(1, Math.min(3, Math.round(o.smoothRadius || 2)));
      var rangeSigma = Math.max(0.025, o.rangeSigma || 0.115);
      var luma = new Float32Array(W * H);
      var alpha = new Float32Array(W * H);
      var smooth = new Float32Array(W * H);
      for (var si = 0; si < W * H; si++) {
        var sp = si * 4;
        alpha[si] = sd[sp + 3] / 255;
        luma[si] = lum(sd[sp], sd[sp + 1], sd[sp + 2]) / 255;
      }

      // Smooth tonal chatter without softening the silhouette. This is a
      // compact bilateral pass: nearby pixels only influence each other when
      // their luminance is already similar. The contour plate therefore keeps
      // the eye, bill and major feather boundaries, but drops JPEG/feather
      // micro-noise before the engraving lines are selected.
      for (var sy = 0; sy < H; sy++) for (var sx = 0; sx < W; sx++) {
        var sn = sy * W + sx;
        if (alpha[sn] < 0.025) { smooth[sn] = luma[sn]; continue; }
        var centre = luma[sn], weighted = 0, weights = 0;
        for (var oy = -smoothRadius; oy <= smoothRadius; oy++) {
          var yy = Math.max(0, Math.min(H - 1, sy + oy));
          for (var ox = -smoothRadius; ox <= smoothRadius; ox++) {
            var xx = Math.max(0, Math.min(W - 1, sx + ox));
            var qn = yy * W + xx;
            if (alpha[qn] < 0.025) continue;
            var delta = luma[qn] - centre;
            var spatial = 1 / (1 + ox * ox + oy * oy);
            var tonal = Math.exp(-(delta * delta) / (2 * rangeSigma * rangeSigma));
            var weight = spatial * tonal * alpha[qn];
            weighted += luma[qn] * weight;
            weights += weight;
          }
        }
        smooth[sn] = weights ? weighted / weights : centre;
      }
      function sample(x, y) {
        x = Math.max(0, Math.min(W - 1, x));
        y = Math.max(0, Math.min(H - 1, y));
        var i = y * W + x;
        return { a: alpha[i], l: smooth[i], raw: luma[i] };
      }
      function frac(v) { return v - Math.floor(v); }
      function noise(x, y) {
        return frac(Math.sin((x + seed * 5.3) * 12.9898 + (y + seed * 9.1) * 78.233) * 43758.5453);
      }

      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var p = sample(x, y);
        if (p.a < 0.045) continue;
        var xm = sample(x - lineRadius, y), xp = sample(x + lineRadius, y);
        var ym = sample(x, y - lineRadius), yp = sample(x, y + lineRadius);
        var broadRadius = lineRadius * 2;
        var bxm = sample(x - broadRadius, y), bxp = sample(x + broadRadius, y);
        var bym = sample(x, y - broadRadius), byp = sample(x, y + broadRadius);
        var gx = xp.l * xp.a - xm.l * xm.a;
        var gy = yp.l * yp.a - ym.l * ym.a;
        var lumaEdge = Math.sqrt(gx * gx + gy * gy);
        var broadGX = bxp.l * bxp.a - bxm.l * bxm.a;
        var broadGY = byp.l * byp.a - bym.l * bym.a;
        var broadEdge = Math.sqrt(broadGX * broadGX + broadGY * broadGY);
        var alphaEdge = Math.max(Math.abs(xp.a - xm.a), Math.abs(yp.a - ym.a));
        var dark = 1 - p.l;

        // A coherent 18-degree plate follows the long body/wing direction.
        // A second, wider plate is reserved for the deepest plumage only.
        var phaseA = (y + x * 0.32 + Math.sin(y * 0.031 + seed) * 0.7 + hatchGap * 20) % hatchGap;
        var phaseB = (x - y * 0.72 + hatchGap * 30) % (hatchGap * 1.48);
        var phaseC = (y - x * 0.16 + hatchGap * 14) % (hatchGap * 1.82);
        var hatchA = phaseA < hatchWidth && dark > (o.hatchThreshold != null ? o.hatchThreshold : 0.22);
        var hatchB = o.crossHatch !== false && phaseB < hatchWidth && dark > 0.48;
        var hatchC = o.deepHatch !== false && phaseC < Math.max(1, hatchWidth - 1) && dark > 0.74;
        var localDetail = Math.abs(p.raw - p.l);
        var detailThreshold = o.detailThreshold != null ? o.detailThreshold : 0.145;
        var edge = alphaEdge > 0.12 || lumaEdge > edgeThreshold || broadEdge > edgeThreshold * 1.7 || localDetail > detailThreshold;
        var print = edge || hatchA || hatchB || hatchC;
        if (!print) continue;

        // Fibre dropout is restrained and shared across neighbouring pixels;
        // this reads as imperfect pressure, not digital salt-and-pepper noise.
        if (o.dropout !== false && noise(x >> 2, y >> 2) > 0.986) continue;
        var i = (y * W + x) * 4;
        od[i] = ink[0]; od[i + 1] = ink[1]; od[i + 2] = ink[2];
        od[i + 3] = Math.round(255 * Math.min(1, p.a * (edge ? 1 : 0.88)));
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- HORIZONTAL RELIEF: a one-colour scanline plate for Mimidae. ----
    // The plate is made exclusively from straight horizontal bands. A compact
    // sliding window samples source tone and controls band weight only. The
    // baseline never bends: eyes, bills and feather changes are described by
    // thicker and thinner passages in the same continuous ruled linework,
    // with no contour, keyline or second detail drawing underneath.
    horizontalRelief: function (cx, W, H, im, o) {
      o = o || {};
      var src = offscreen(W, H), sc = src.getContext('2d');
      drawBird(sc, im, W, H, {
        fit: o.fit || 'bird', pad: (o.pad != null ? o.pad : 0.015),
        offsetX: o.offsetX || 0, offsetY: o.offsetY || 0,
        scale: o.scale || 1, rotate: o.rotate || 0
      });
      var sd = sc.getImageData(0, 0, W, H).data;
      var out = cx.createImageData(W, H), od = out.data;
      var ink = hex2rgb(o.ink || '#cf2929');
      var gap = Math.max(4, Math.round((o.gap || 0.023) * W));
      var contrast = o.contrast != null ? o.contrast : 1.1;
      var toneGamma = o.toneGamma != null ? o.toneGamma : 0.88;
      var minLine = o.minLine != null ? o.minLine : 0.06;
      var maxLine = o.maxLine != null ? o.maxLine : 0.82;
      var smoothRadius = Math.max(1, Math.round(o.smoothRadius != null ? o.smoothRadius : 3));
      var alpha = new Float32Array(W * H), luma = new Float32Array(W * H);
      var toneHistogram = new Uint32Array(256), tonePixels = 0;
      for (var p = 0; p < W * H; p++) {
        var pi = p * 4;
        alpha[p] = sd[pi + 3] / 255;
        var light = lum(sd[pi], sd[pi + 1], sd[pi + 2]) / 255;
        luma[p] = light;
        if (alpha[p] > 0.08) {
          toneHistogram[Math.max(0, Math.min(255, Math.round(light * 255)))]++;
          tonePixels++;
        }
      }
      function percentileTone(fraction) {
        var target = tonePixels * fraction, total = 0;
        for (var bucket = 0; bucket < 256; bucket++) {
          total += toneHistogram[bucket];
          if (total >= target) return bucket / 255;
        }
        return fraction;
      }
      // Stretch the useful photographic range before converting tone to band
      // weight. This prevents mid-toned plumage from collapsing into one blob
      // while keeping the ruled baselines themselves perfectly straight.
      var toneLow = percentileTone(o.toneLow != null ? o.toneLow : 0.08);
      var toneHigh = percentileTone(o.toneHigh != null ? o.toneHigh : 0.92);
      var toneRange = Math.max(0.08, toneHigh - toneLow);
      for (var lp = 0; lp < luma.length; lp++) {
        var stretched = Math.max(0, Math.min(1, (luma[lp] - toneLow) / toneRange));
        luma[lp] = Math.max(0, Math.min(1, (stretched - 0.5) * contrast + 0.5));
      }
      function read(arr, x, y) {
        x = Math.max(0, Math.min(W - 1, x));
        y = Math.max(0, Math.min(H - 1, y));
        return arr[y * W + x];
      }
      function stampPixel(x, y, strength) {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        var n = y * W + x, a = alpha[n];
        if (a < 0.045) return;
        var i = n * 4, aa = Math.round(255 * Math.min(1, a * strength));
        if (aa <= od[i + 3]) return;
        od[i] = ink[0]; od[i + 1] = ink[1]; od[i + 2] = ink[2]; od[i + 3] = aa;
      }

      // Each stripe first gathers a compact sliding-window tone field. The
      // field is smoothed horizontally so pressure changes read as deliberate
      // printed passages instead of noisy pixel-by-pixel modulation.
      for (var cy = Math.round(gap * 0.55); cy < H; cy += gap) {
        var rowA = new Float32Array(W), rowL = new Float32Array(W);
        var sampleRadius = Math.max(2, Math.round(gap * 0.58));
        for (var x = 0; x < W; x++) {
          var sampleA = 0, sampleL = 0, samples = 0;
          for (var sy = -sampleRadius; sy <= sampleRadius; sy++) {
            var sa = read(alpha, x, cy + sy);
            if (sa < 0.045) continue;
            sampleA += sa; sampleL += read(luma, x, cy + sy) * sa; samples++;
          }
          if (!samples || sampleA < 0.06) continue;
          rowA[x] = sampleA / samples;
          rowL[x] = sampleL / Math.max(0.001, sampleA);
        }
        for (var x2 = 0; x2 < W; x2++) {
          if (rowA[x2] < 0.045) continue;
          var smoothL = 0, smoothA = 0;
          for (var sx = -smoothRadius; sx <= smoothRadius; sx++) {
            var xx = Math.max(0, Math.min(W - 1, x2 + sx));
            var sw = (smoothRadius + 1 - Math.abs(sx)) * rowA[xx];
            smoothL += rowL[xx] * sw; smoothA += sw;
          }
          var meanA = rowA[x2];
          var meanL = smoothA ? smoothL / smoothA : rowL[x2];
          var dark = Math.pow(Math.max(0, Math.min(1, 1 - meanL)), toneGamma);
          var width = gap * (minLine + (maxLine - minLine) * dark);

          var centre = cy;
          var y0 = Math.floor(centre - width * 0.5), y1 = Math.ceil(centre + width * 0.5);
          for (var yy = y0; yy <= y1; yy++) {
            var coverage = Math.min(1, width * 0.5 + 0.7 - Math.abs(yy - centre));
            if (coverage > 0) stampPixel(x2, yy, Math.max(0.48, coverage) * meanA);
          }
        }
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- DUOTONE CUTOUT: full-resolution two-ink tonal mapping. ----
    // A hard threshold makes feathers, eyes and petal folds break into blocky
    // islands. A photographic duotone instead maps source luminance onto one
    // continuous ramp between the two selected inks. Percentile endpoints
    // keep the result useful across differently exposed source images, while
    // the untouched source alpha retains the exact high-resolution contour.
    // Optional AM screens belong only to the printed artwork plate. Each dot
    // samples one tone at its cell centre, as a real halftone separation does,
    // instead of adding a synthetic sine wave to every pixel. A faint second
    // plate is rotated and translated by a fraction of a cell: the resulting
    // registration beat reads like editorial offset print / restrained moire
    // while the surrounding stock, type, and unprinted field stay untouched.
    duotoneCutout: function (cx, W, H, im, o) {
      o = o || {};
      var src = offscreen(W, H), sc = src.getContext('2d');
      drawBird(sc, im, W, H, {
        fit: o.fit || 'bird', pad: (o.pad != null ? o.pad : 0.012),
        offsetX: o.offsetX || 0, offsetY: o.offsetY || 0,
        scale: o.scale || 1, rotate: o.rotate || 0
      });

      var source = sc.getImageData(0, 0, W, H), sd = source.data;
      var hist = new Uint32Array(256), total = 0;
      for (var h = 0; h < W * H; h++) {
        var hi = h * 4, ha = sd[hi + 3];
        if (ha < 12) continue;
        hist[Math.max(0, Math.min(255, Math.round(lum(sd[hi], sd[hi + 1], sd[hi + 2]))))]++;
        total++;
      }

      function percentile(q) {
        var target = total * q, n = 0;
        for (var i = 0; i < 256; i++) {
          n += hist[i];
          if (n >= target) return i / 255;
        }
        return q;
      }
      var lo = o.blackPoint != null ? o.blackPoint : percentile(o.lowCut != null ? o.lowCut : 0.025);
      var high = o.whitePoint != null ? o.whitePoint : percentile(o.highCut != null ? o.highCut : 0.975);
      if (high - lo < 0.08) { lo = Math.max(0, lo - 0.04); high = Math.min(1, high + 0.04); }
      var gamma = Math.max(0.1, o.gamma != null ? o.gamma : 0.92);
      var contrast = o.contrast != null ? o.contrast : 1.04;
      var shadow = hex2rgb(o.shadow || '#686a51');
      var light = hex2rgb(o.ink || '#e3d6b7');
      var screenOn = !!o.screen;
      var screenPeriod = Math.max(4, o.screenPeriod || 12.8);
      var screenStrength = Math.max(0, Math.min(1, o.screenStrength != null ? o.screenStrength : 0.72));
      var screenA = (o.screenAngleA != null ? o.screenAngleA : 18) * Math.PI / 180;
      var screenB = (o.screenAngleB != null ? o.screenAngleB : 24.5) * Math.PI / 180;
      var ghostStrength = Math.max(0, Math.min(0.55, o.screenGhost != null ? o.screenGhost : 0.22));
      var screenSoftness = Math.max(0.35, o.screenSoftness != null ? o.screenSoftness : 0.82);
      var screenJitter = Math.max(0, Math.min(0.16, o.screenJitter != null ? o.screenJitter : 0.035));
      var screenAspect = Math.max(0.45, Math.min(2.5, o.screenAspect != null ? o.screenAspect : 1));
      var out = cx.createImageData(W, H), od = out.data;

      function clamp01(v) { return Math.max(0, Math.min(1, v)); }
      function toneAt(x, y) {
        x = Math.max(0, Math.min(W - 1, Math.round(x)));
        y = Math.max(0, Math.min(H - 1, Math.round(y)));
        var i = (y * W + x) * 4;
        var value = (lum(sd[i], sd[i + 1], sd[i + 2]) / 255 - lo) / Math.max(0.001, high - lo);
        value = clamp01((value - 0.5) * contrast + 0.5);
        value = Math.pow(value, gamma);
        return value * value * (3 - 2 * value);
      }
      function hashCell(x, y, seed) {
        var n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
        return n - Math.floor(n);
      }
      function plateDot(x, y, angle, offsetX, offsetY, seed) {
        var ca = Math.cos(angle), sa = Math.sin(angle);
        var rx = (x + offsetX) * ca + (y + offsetY) * sa;
        var ry = -(x + offsetX) * sa + (y + offsetY) * ca;
        var cellX = Math.floor(rx / screenPeriod), cellY = Math.floor(ry / screenPeriod);
        var jitterX = (hashCell(cellX, cellY, seed) - 0.5) * screenPeriod * screenJitter;
        var jitterY = (hashCell(cellX, cellY, seed + 11) - 0.5) * screenPeriod * screenJitter;
        var centerRX = (cellX + 0.5) * screenPeriod + jitterX;
        var centerRY = (cellY + 0.5) * screenPeriod + jitterY;
        var centerX = centerRX * ca - centerRY * sa - offsetX;
        var centerY = centerRX * sa + centerRY * ca - offsetY;
        var cellTone = toneAt(centerX, centerY);
        // Dark ink coverage follows sqrt(ink amount), the area-to-radius
        // relationship for a round AM dot. Slight overlap gives the soft,
        // inky joins seen in scanned editorial print rather than pixel noise.
        var radius = screenPeriod * 0.62 * Math.sqrt(Math.max(0, 1 - cellTone));
        var dx = rx - centerRX, dy = ry - centerRY;
        // Keep circular AM dots as the default. An area-preserving aspect
        // ratio turns the same sampled separation into an engraved dash/line
        // screen for the directional proof without changing its tonal mass.
        var distance = Math.sqrt((dx / screenAspect) * (dx / screenAspect) +
                                 (dy * screenAspect) * (dy * screenAspect));
        return clamp01((radius + screenSoftness - distance) / (screenSoftness * 2));
      }

      for (var p = 0; p < W * H; p++) {
        var pi = p * 4, alpha = sd[pi + 3] / 255;
        if (alpha < 0.01) continue;
        var t = (lum(sd[pi], sd[pi + 1], sd[pi + 2]) / 255 - lo) / Math.max(0.001, high - lo);
        t = Math.max(0, Math.min(1, (t - 0.5) * contrast + 0.5));
        t = Math.pow(t, gamma);
        // Gentle shoulder/toe compression retains fine source detail without
        // letting a few highlights or shadows dominate the two-ink range.
        t = t * t * (3 - 2 * t);
        if (screenOn) {
          var x = p % W, y = (p / W) | 0;
          var primaryDot = plateDot(x, y, screenA, 0, 0, 3);
          var ghostDot = plateDot(x, y, screenB, screenPeriod * 0.115, -screenPeriod * 0.075, 19);
          var inkCoverage = 1 - (1 - primaryDot) * (1 - ghostDot * ghostStrength);
          var screenedTone = 1 - inkCoverage;
          // Retain a small amount of continuous source tone so eyes, feather
          // breaks, and petal folds survive at stamp size; the dots still
          // carry the dominant visual rhythm.
          t = clamp01(t * (1 - screenStrength) + screenedTone * screenStrength);
        }
        od[pi] = Math.round(shadow[0] + (light[0] - shadow[0]) * t);
        od[pi + 1] = Math.round(shadow[1] + (light[1] - shadow[1]) * t);
        od[pi + 2] = Math.round(shadow[2] + (light[2] - shadow[2]) * t);
        od[pi + 3] = Math.round(alpha * 255);
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- TWO-TONE CUTOUT: clean relief-print construction. ----
    // The source is reduced to large cream and green masses before any paper
    // texture is considered. Transparent bird art keeps its exact silhouette;
    // opaque landscape photographs are separated from the sky by luminance.
    // Sampling a softly reduced classifier removes photographic chatter while
    // preserving the high-resolution outer edge and major anatomical marks.
    twoToneCutout: function (cx, W, H, im, o) {
      o = o || {};
      var src = offscreen(W, H), sc = src.getContext('2d');
      if (o.cover) {
        var cropY0 = Math.max(0, Math.min(0.95, o.cropY0 || 0));
        var cropY1 = Math.max(cropY0 + 0.01, Math.min(1, o.cropY1 != null ? o.cropY1 : 1));
        var sourceY = im.height * cropY0, sourceH = im.height * (cropY1 - cropY0);
        var s = Math.max(W / im.width, H / sourceH);
        var dw = im.width * s, dh = sourceH * s;
        var px = o.posX != null ? o.posX : 0.5, py = o.posY != null ? o.posY : 0.5;
        sc.drawImage(im, 0, sourceY, im.width, sourceH, (W - dw) * px, (H - dh) * py, dw, dh);
      } else {
        drawBird(sc, im, W, H, {
          fit: o.fit || 'bird', pad: (o.pad != null ? o.pad : 0.012),
          offsetX: o.offsetX || 0, offsetY: o.offsetY || 0,
          scale: o.scale || 1, rotate: o.rotate || 0
        });
      }

      // Opaque flower photographs can still participate in the same two-ink
      // separation as transparent bird cutouts. The mask is derived from the
      // source colour field before classification, so the resulting blossom
      // is a real photographic silhouette rather than a decorative vector.
      if (o.subjectMask) {
        var masked = sc.getImageData(0, 0, W, H), md = masked.data;
        for (var mi = 0; mi < md.length; mi += 4) {
          var mr = md[mi] / 255, mg = md[mi + 1] / 255, mb = md[mi + 2] / 255;
          var mmax = Math.max(mr, mg, mb), mmin = Math.min(mr, mg, mb);
          var msat = mmax ? (mmax - mmin) / mmax : 0;
          var ml = (md[mi] * 0.299 + md[mi + 1] * 0.587 + md[mi + 2] * 0.114) / 255;
          var keep = 0;
          if (o.subjectMask === 'magenta') {
            var magenta = ((mr + mb) * 0.5) - mg;
            keep = Math.max(0, Math.min(1, (msat - 0.19) * 7.5)) *
                   Math.max(0, Math.min(1, (magenta - 0.025) * 10));
          } else if (o.subjectMask === 'darkBackground') {
            keep = Math.max(0, Math.min(1, (ml - 0.065) * 9.5));
          }
          md[mi + 3] = Math.round(md[mi + 3] * keep);
        }
        sc.putImageData(masked, 0, 0);
      }

      var sd = sc.getImageData(0, 0, W, H).data;
      var divisor = Math.max(1, Math.round(o.simplify || 5));
      var sw = Math.max(1, Math.ceil(W / divisor)), sh = Math.max(1, Math.ceil(H / divisor));
      var small = offscreen(sw, sh), sm = small.getContext('2d');
      sm.imageSmoothingEnabled = true;
      sm.drawImage(src, 0, 0, sw, sh);
      var bd = sm.getImageData(0, 0, sw, sh).data;
      var out = cx.createImageData(W, H), od = out.data;
      var cream = hex2rgb(o.ink || '#e8dfc5');
      var shadow = hex2rgb(o.shadow || '#16432a');
      var threshold = o.threshold != null ? o.threshold : 0.49;
      var scene = o.mode === 'scene';
      var softness = Math.max(0.004, o.softness != null ? o.softness : 0.075);
      var sceneDark = o.sceneDark != null ? o.sceneDark : 0.31;

      // A screen-printed specimen is built as two registered solid plates,
      // not a photograph quantised into square cells.  Upscale the reduced
      // classifier with interpolation, then clean only tiny isolated islands;
      // the full-resolution source alpha continues to define the silhouette.
      var plate = null;
      if (o.screenPrint) {
        var up = offscreen(W, H), uc = up.getContext('2d');
        uc.imageSmoothingEnabled = true;
        uc.imageSmoothingQuality = 'high';
        uc.drawImage(small, 0, 0, W, H);
        var ud = uc.getImageData(0, 0, W, H).data;
        var valid = new Uint8Array(W * H);
        plate = new Uint8Array(W * H);
        // A compact bilateral pass follows the established edge-preserving
        // stylisation model: flatten low-contrast feather chatter while
        // retaining high-contrast anatomy such as the eye and bill seam.
        var edgeLum = null;
        if (o.edgePreserve) {
          var rawLum = new Float32Array(W * H);
          edgeLum = new Float32Array(W * H);
          for (var ep = 0; ep < W * H; ep++) {
            var ei = ep * 4;
            rawLum[ep] = lum(sd[ei], sd[ei + 1], sd[ei + 2]) / 255;
          }
          var er = Math.max(1, Math.round(o.edgeRadius || 2));
          var es = Math.max(0.025, o.edgeSigma || 0.1);
          var es2 = 2 * es * es;
          for (var ey = 0; ey < H; ey++) for (var ex = 0; ex < W; ex++) {
            ep = ey * W + ex;
            if (sd[ep * 4 + 3] < 9) continue;
            var centerLum = rawLum[ep], weightedLum = 0, weightSum = 0;
            for (var ej = -er; ej <= er; ej++) for (var ek = -er; ek <= er; ek++) {
              var enx = ex + ek, eny = ey + ej;
              if (enx < 0 || eny < 0 || enx >= W || eny >= H) continue;
              var enp = eny * W + enx;
              if (sd[enp * 4 + 3] < 9) continue;
              var deltaLum = rawLum[enp] - centerLum;
              var spatialWeight = 1 / (1 + ek * ek + ej * ej);
              var rangeWeight = Math.exp(-(deltaLum * deltaLum) / es2);
              var edgeWeight = spatialWeight * rangeWeight;
              weightedLum += rawLum[enp] * edgeWeight;
              weightSum += edgeWeight;
            }
            edgeLum[ep] = weightSum ? weightedLum / weightSum : centerLum;
          }
        }

        var p, pi, ul;
        for (p = 0; p < W * H; p++) {
          pi = p * 4;
          if (sd[pi + 3] < 9) continue;
          valid[p] = 1;
          ul = lum(ud[pi], ud[pi + 1], ud[pi + 2]) / 255;
          if (edgeLum) ul = ul * (1 - o.edgePreserve) + edgeLum[p] * o.edgePreserve;
          if (o.lowerLift) {
            var lowerY = ((p / W) | 0) / H;
            if (lowerY > 0.64) ul = Math.min(1, ul + o.lowerLift * ((lowerY - 0.64) / 0.36));
          }
          plate[p] = ul >= threshold ? 1 : 0;
        }

        // One conservative majority pass closes single-pixel pinholes and
        // clips stray one-pixel filaments without rounding the outer bird.
        var clean = new Uint8Array(plate);
        for (var cy = 1; cy < H - 1; cy++) for (var cxp = 1; cxp < W - 1; cxp++) {
          p = cy * W + cxp;
          if (!valid[p]) continue;
          var votes = 0, neighbours = 0;
          for (var my = -1; my <= 1; my++) for (var mx = -1; mx <= 1; mx++) {
            var mp = (cy + my) * W + cxp + mx;
            if (!valid[mp]) continue;
            neighbours++;
            votes += plate[mp];
          }
          if (neighbours >= 7 && votes <= 2) clean[p] = 0;
          else if (neighbours >= 7 && votes >= neighbours - 2) clean[p] = 1;
        }
        plate = clean;

        // Remove disconnected flecks in either ink. Components touching the
        // alpha boundary are preserved so narrow beaks, claws, and tail tips
        // never disappear; only interior dust is collapsed into its surround.
        var seen = new Uint8Array(W * H);
        var stack = new Int32Array(W * H);
        var component = new Int32Array(W * H);
        var minIsland = Math.max(12, Math.round((o.minIsland || 0.00065) * W * H));
        // Eyes and other compact dark anatomy are legitimate isolated marks,
        // not press debris. Keep a much smaller cleanup floor for the dark
        // plate while still deleting one-pixel dust.
        var minDarkIsland = Math.max(4, Math.round((o.minDarkIsland || 0.000055) * W * H));
        for (p = 0; p < W * H; p++) {
          if (!valid[p] || seen[p]) continue;
          var tone = plate[p], sp = 0, cp = 0, touchesEdge = false;
          stack[sp++] = p;
          seen[p] = 1;
          while (sp) {
            var q = stack[--sp], qx = q % W, qy = (q / W) | 0;
            component[cp++] = q;
            if (qx === 0 || qy === 0 || qx === W - 1 || qy === H - 1) touchesEdge = true;
            var n0 = q - 1, n1 = q + 1, n2 = q - W, n3 = q + W;
            if (qx > 0 && valid[n0] && !seen[n0] && plate[n0] === tone) { seen[n0] = 1; stack[sp++] = n0; }
            if (qx < W - 1 && valid[n1] && !seen[n1] && plate[n1] === tone) { seen[n1] = 1; stack[sp++] = n1; }
            if (qy > 0 && valid[n2] && !seen[n2] && plate[n2] === tone) { seen[n2] = 1; stack[sp++] = n2; }
            if (qy < H - 1 && valid[n3] && !seen[n3] && plate[n3] === tone) { seen[n3] = 1; stack[sp++] = n3; }
          }
          var islandFloor = tone ? minIsland : minDarkIsland;
          if (!touchesEdge && cp < islandFloor) for (var ci = 0; ci < cp; ci++) plate[component[ci]] = tone ? 0 : 1;
        }
      }

      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4, alpha = sd[i + 3] / 255;
        if (!scene && alpha < 0.035) continue;
        var bx = Math.min(sw - 1, Math.floor(x / divisor));
        var by = Math.min(sh - 1, Math.floor(y / divisor));
        var bi = (by * sw + bx) * 4;
        var light = lum(bd[bi], bd[bi + 1], bd[bi + 2]) / 255;
        var amount, rr, gg, bb;
        if (scene) {
          // The bright sky drops out. Mountain planes are cream, while the
          // deepest valleys print solid green so the ridge remains legible.
          if (light > threshold + softness) continue;
          var ridgeAlpha = Math.max(0, Math.min(1, (threshold + softness - light) / (softness * 2)));
          var lightPlane = Math.max(0, Math.min(1, (light - sceneDark + softness) / (softness * 2)));
          rr = shadow[0] * (1 - lightPlane) + cream[0] * lightPlane;
          gg = shadow[1] * (1 - lightPlane) + cream[1] * lightPlane;
          bb = shadow[2] * (1 - lightPlane) + cream[2] * lightPlane;
          alpha = ridgeAlpha;
        } else {
          // Light plumage is cream; dark markings are their own solid green
          // ink rather than transparency, so the bird stays readable over a
          // cream mountain or ground plane.
          if (plate) {
            amount = plate[y * W + x];
            // A one-device-pixel trap softens only the registered boundary
            // between the two solid inks. It removes staircase chatter while
            // preserving the flat screen-print plates and crisp outer alpha.
            if (o.plateFeather) {
              var fp = y * W + x, fsum = amount * 4, fw = 4;
              for (var fy = -1; fy <= 1; fy++) for (var fx = -1; fx <= 1; fx++) {
                if (!fx && !fy) continue;
                var fnx = x + fx, fny = y + fy;
                if (fnx < 0 || fny < 0 || fnx >= W || fny >= H) continue;
                var fpi = fny * W + fnx;
                if (!valid[fpi]) continue;
                var fweight = (!fx || !fy) ? 2 : 1;
                fsum += plate[fpi] * fweight;
                fw += fweight;
              }
              amount = fsum / fw;
            }
          } else amount = o.hard ? (light >= threshold ? 1 : 0) :
            Math.max(0, Math.min(1, (light - threshold + softness) / (softness * 2)));
          rr = shadow[0] * (1 - amount) + cream[0] * amount;
          gg = shadow[1] * (1 - amount) + cream[1] * amount;
          bb = shadow[2] * (1 - amount) + cream[2] * amount;
        }
        od[i] = Math.round(rr); od[i + 1] = Math.round(gg); od[i + 2] = Math.round(bb);
        od[i + 3] = Math.round(255 * alpha);
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- DUOTONE SCENE: a real photograph reduced to a stable relief plate. ----
    // Unlike the transparent specimen renderer, this preserves every tree and
    // depth plane in the source. Three continuous ink bands keep the forest
    // photographic without importing unrelated colour into the issue.
    duotoneScene: function (cx, W, H, im, o) {
      o = o || {};
      var src = offscreen(W, H), sc = src.getContext('2d');
      var scale = Math.max(W / im.width, H / im.height);
      var dw = im.width * scale, dh = im.height * scale;
      var px = o.posX != null ? o.posX : 0.5, py = o.posY != null ? o.posY : 0.5;
      sc.imageSmoothingEnabled = true;
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(im, (W - dw) * px, (H - dh) * py, dw, dh);
      var sd = sc.getImageData(0, 0, W, H).data;
      var out = cx.createImageData(W, H), od = out.data;
      var deep = hex2rgb(o.deep || '#0b301c');
      var mid = hex2rgb(o.mid || '#285d38');
      var cream = hex2rgb(o.cream || '#e8dfc5');
      var contrast = o.contrast != null ? o.contrast : 1.45;
      var lift = o.lift != null ? o.lift : 0.015;
      for (var i = 0; i < sd.length; i += 4) {
        var l = lum(sd[i], sd[i + 1], sd[i + 2]) / 255;
        l = Math.max(0, Math.min(1, (l - 0.5) * contrast + 0.5 + lift));
        var a, b, t;
        if (l < 0.48) { a = deep; b = mid; t = l / 0.48; }
        else { a = mid; b = cream; t = (l - 0.48) / 0.52; }
        // A slight S curve keeps snow and bark separate at thumbnail size.
        t = t * t * (3 - 2 * t);
        od[i] = Math.round(a[0] + (b[0] - a[0]) * t);
        od[i + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
        od[i + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
        od[i + 3] = 255;
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- TREELINE CUTOUT: retain a photographed canopy, drop only its sky. ----
    // The silhouette is derived from source luminance, so the upper boundary
    // remains the real irregular tree line. The meadow lifts toward cream at
    // the foot, reserving natural copy space without adding a label rectangle.
    treelineCutout: function (cx, W, H, im, o) {
      o = o || {};
      var src = offscreen(W, H), sc = src.getContext('2d');
      var scale = Math.max(W / im.width, H / im.height);
      var dw = im.width * scale, dh = im.height * scale;
      var px = o.posX != null ? o.posX : 0.5, py = o.posY != null ? o.posY : 0.5;
      sc.imageSmoothingEnabled = true;
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(im, (W - dw) * px, (H - dh) * py, dw, dh);
      var sd = sc.getImageData(0, 0, W, H).data;
      var out = cx.createImageData(W, H), od = out.data;
      var deep = hex2rgb(o.deep || '#0b301c');
      var mid = hex2rgb(o.mid || '#285d38');
      var cream = hex2rgb(o.cream || '#e8dfc5');
      var cut = o.cut != null ? o.cut : 0.49;
      var fade = o.fade != null ? o.fade : 0.13;
      var dither = !!o.dither;
      var errors = dither ? new Float32Array(W * H) : null;
      var split = o.split != null ? o.split : 0.54;
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        var l = lum(sd[i], sd[i + 1], sd[i + 2]) / 255;
        var ny = y / Math.max(1, H - 1);
        var alpha = Math.max(0, Math.min(1, (cut - l) / fade));
        // Below the horizon the source is meadow rather than sky, so the
        // plate becomes fully opaque while still retaining photographic tone.
        if (ny > 0.48) alpha = Math.max(alpha, Math.min(1, (ny - 0.48) / 0.14));
        if (o.opaque && alpha > 0.04) alpha = 1;
        if (alpha < 0.015) continue;
        var groundLift = Math.max(0, Math.min(1, (ny - 0.64) / 0.36));
        var groundAmount = o.groundLift != null ? o.groundLift : 0.82;
        var tone = Math.max(0, Math.min(1, l * 1.12 + groundLift * groundAmount));
        if (dither) {
          // Floyd-Steinberg diffusion behaves like a coarse photographic
          // plate rather than a tiled screen. The real canopy edge remains
          // untouched; only its continuous tones separate into two inks.
          var ti = y * W + x;
          var corrected = Math.max(0, Math.min(1, tone + errors[ti]));
          var bit = corrected >= split ? 1 : 0;
          var quant = corrected - bit;
          if (x + 1 < W) errors[ti + 1] += quant * 7 / 16;
          if (y + 1 < H) {
            if (x > 0) errors[ti + W - 1] += quant * 3 / 16;
            errors[ti + W] += quant * 5 / 16;
            if (x + 1 < W) errors[ti + W + 1] += quant / 16;
          }
          var plate = bit ? cream : mid;
          od[i] = plate[0]; od[i + 1] = plate[1]; od[i + 2] = plate[2];
        } else {
          var a, b, t;
          if (tone < 0.45) { a = deep; b = mid; t = tone / 0.45; }
          else { a = mid; b = cream; t = (tone - 0.45) / 0.55; }
          t = t * t * (3 - 2 * t);
          od[i] = Math.round(a[0] + (b[0] - a[0]) * t);
          od[i + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
          od[i + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
        }
        od[i + 3] = Math.round(alpha * 255);
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- OWL ENGRAVING: a species-robust, one-colour green plate. Source
    // luminance controls three green inks, a small ordered matrix separates
    // intermediate tones, and long diagonal hatch runs preserve feather
    // direction without turning the specimen into a grey photograph. ----
    owlEngrave: function (cx, W, H, im, o) {
      o = o || {};
      var off = offscreen(W, H), oc = off.getContext('2d');
      drawBird(oc, im, W, H, {
        fit: 'bird', pad: (o.pad != null ? o.pad : 0.02),
        scale: (o.scale != null ? o.scale : 1),
        offsetX: o.offsetX || 0, offsetY: o.offsetY || 0
      });
      var src = oc.getImageData(0, 0, W, H), s = src.data;
      var out = cx.createImageData(W, H), d = out.data;
      var deep = hex2rgb(o.deep || '#0d4b2c');
      var mid = hex2rgb(o.mid || '#65a36e');
      var pale = hex2rgb(o.pale || '#edf2d8');
      var bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
      var hatchGap = Math.max(5, Math.round(W * 0.013));
      var hatchWidth = Math.max(1, Math.round(hatchGap * 0.24));
      function sourceLum(x, y) {
        x = Math.max(0, Math.min(W - 1, x));
        y = Math.max(0, Math.min(H - 1, y));
        var i = (y * W + x) * 4;
        return lum(s[i], s[i + 1], s[i + 2]) / 255;
      }
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4, alpha = s[i + 3] / 255;
        if (alpha < 0.025) continue;
        var l = lum(s[i], s[i + 1], s[i + 2]) / 255;
        var lL = sourceLum(x - 1, y), lR = sourceLum(x + 1, y);
        var lU = sourceLum(x, y - 1), lD = sourceLum(x, y + 1);
        var edge = Math.abs(lR - lL) + Math.abs(lD - lU);
        // A small unsharp separation before quantization preserves the facial
        // disc and feather boundaries without introducing a CSS/raster blur.
        var local = (lL + lR + lU + lD) * 0.25;
        l = Math.max(0, Math.min(1, l + (l - local) * 1.15));
        var threshold = (bayer[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        var hatch = ((x + Math.round(y * 0.34)) % hatchGap) < hatchWidth;
        var c;
        if (edge > 0.21 && l < 0.62) c = deep;
        else if (l > 0.57 && edge > 0.075) c = pale;
        else if (hatch && l < 0.74) c = deep;
        else if (l < 0.34) c = threshold < 0.72 ? deep : mid;
        else if (l < 0.68) c = threshold < (0.74 - l * 0.42) ? mid : pale;
        else c = threshold < 0.18 ? mid : pale;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
        d[i + 3] = Math.round(alpha * 255);
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- OWL HABITAT: the real forest is separated with the same family of
    // ordered screens and directional hatch marks as the specimen. Keeping
    // the sky transparent lets the green field remain quiet, while each tree
    // is rebuilt with the specimen's same three inks and hatch rhythm instead
    // of reading as a filtered photograph behind a separately drawn bird. ----
    owlHabitat: function (cx, W, H, im, o) {
      o = o || {};
      var off = offscreen(W, H), oc = off.getContext('2d');
      var scale = Math.max(W / im.width, H / im.height) * (o.scale || 1.12);
      var dw = im.width * scale, dh = im.height * scale;
      var ox = (W - dw) / 2 + (o.offsetX || 0) * W;
      var oy = (H - dh) / 2 + (o.offsetY != null ? o.offsetY : -0.125) * H;
      oc.drawImage(im, ox, oy, dw, dh);
      var src = oc.getImageData(0, 0, W, H), s = src.data;
      var out = cx.createImageData(W, H), d = out.data;
      var deep = hex2rgb(o.deep || '#0d4b2c');
      var mid = hex2rgb(o.mid || '#4d9a5d');
      var pale = hex2rgb(o.pale || '#b8d3a5');
      var bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
      var hatchGap = Math.max(5, Math.round(W * 0.013));
      var hatchWidth = Math.max(1, Math.round(hatchGap * 0.24));
      function sourceLum(x, y) {
        x = Math.max(0, Math.min(W - 1, x));
        y = Math.max(0, Math.min(H - 1, y));
        var i = (y * W + x) * 4;
        return lum(s[i], s[i + 1], s[i + 2]) / 255;
      }
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        var l = lum(s[i], s[i + 1], s[i + 2]) / 255;
        var dark = Math.max(0, Math.min(1, 1 - l));
        var edge = Math.abs(sourceLum(x + 1, y) - sourceLum(x - 1, y)) +
          Math.abs(sourceLum(x, y + 1) - sourceLum(x, y - 1));
        // Source-derived mask: clear sky drops out, while photographed trees
        // keep their jagged crown and internal tonal detail.
        var tree = Math.max(0, Math.min(1, (dark - 0.245) / 0.34 + edge * 1.8));
        if (tree < 0.075) continue;
        var threshold = (bayer[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        var hatch = ((x + Math.round(y * 0.34)) % hatchGap) < hatchWidth;
        var c;
        if (edge > 0.19 || (hatch && l < 0.74)) c = deep;
        else if (l < 0.34) c = threshold < 0.72 ? deep : mid;
        else if (l < 0.68) c = threshold < (0.74 - l * 0.42) ? mid : pale;
        else c = threshold < 0.18 ? mid : pale;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
        d[i + 3] = Math.round(Math.min(0.94, Math.max(0.28, tree)) * (edge > 0.19 ? 255 : 232));
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    },

    // ---- ENGRAVE: horizontal scan lines whose thickness tracks darkness ----
    engrave: function (cx, W, H, im, o) {
      o = o || {};
      var ink = o.ink || '#20351f', paper = o.paper || 'transparent', gap = (o.gap || 0.011) * H;
      var off = offscreen(W, H), oc = off.getContext('2d');
      var f = fit(im, W, H, (o.pad || 0.04) * Math.min(W, H));
      oc.drawImage(im, f.ox, f.oy, f.dw, f.dh);
      var d = oc.getImageData(0, 0, W, H).data;
      cx.clearRect(0, 0, W, H);
      if (paper !== 'transparent') { cx.fillStyle = paper; cx.fillRect(0, 0, W, H); }
      cx.strokeStyle = ink; cx.lineCap = 'round';
      for (var y = gap; y < H; y += gap) {
        var run = false, sx = 0;
        for (var x = 0; x <= W; x++) {
          var idx = (((y | 0) * W) + x) * 4, on = false;
          if (x < W && d[idx + 3] > 60) { var l = lum(d[idx], d[idx + 1], d[idx + 2]) / 255; on = (1 - l) > 0.18; }
          if (on && !run) { run = true; sx = x; }
          else if (!on && run) {
            run = false;
            var yy = y; cx.lineWidth = Math.max(0.4, gap * 0.6);
            cx.beginPath(); cx.moveTo(sx, yy); cx.lineTo(x, yy); cx.stroke();
          }
        }
      }
    }
  };

  // Bowyer-Watson Delaunay triangulation (small point sets)
  function delaunay(points, W, H) {
    var st = [[-W * 3, -H * 2], [W * 4, -H * 2], [W / 2, H * 5]];
    var tris = [[st[0], st[1], st[2]]];
    function circum(a, b, c) {
      var ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
      var dd = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(dd) < 1e-9) return null;
      var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / dd;
      var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / dd;
      return { x: ux, y: uy, r2: (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy) };
    }
    for (var i = 0; i < points.length; i++) {
      var pt = points[i], bad = [];
      for (var t = 0; t < tris.length; t++) {
        var cc = circum(tris[t][0], tris[t][1], tris[t][2]);
        if (cc && (pt[0] - cc.x) * (pt[0] - cc.x) + (pt[1] - cc.y) * (pt[1] - cc.y) < cc.r2 + 1e-6) bad.push(tris[t]);
      }
      var edges = [];
      for (var bi = 0; bi < bad.length; bi++) for (var e = 0; e < 3; e++) {
        var a = bad[bi][e], b = bad[bi][(e + 1) % 3], shared = false;
        for (var bj = 0; bj < bad.length && !shared; bj++) {
          if (bj === bi) continue;
          for (var f = 0; f < 3; f++) {
            var c = bad[bj][f], dd = bad[bj][(f + 1) % 3];
            if ((a === c && b === dd) || (a === dd && b === c)) { shared = true; break; }
          }
        }
        if (!shared) edges.push([a, b]);
      }
      tris = tris.filter(function (x) { return bad.indexOf(x) < 0; });
      for (var ei = 0; ei < edges.length; ei++) tris.push([edges[ei][0], edges[ei][1], pt]);
    }
    return tris.filter(function (x) { return st.indexOf(x[0]) < 0 && st.indexOf(x[1]) < 0 && st.indexOf(x[2]) < 0; });
  }

  function apply(cv) {
    var fx = cv.dataset.fx, src = cv.dataset.src;
    if (!src || cv._done) return;
    /* getBoundingClientRect() includes the stamp's fit transform.  Using that
       value for the backing store rendered a 65%-scale issue at 65% of its
       real resolution, then made the browser resample it a second time.  Base
       the plate on its untransformed CSS box instead and oversample that box.
       `?quality=4` is the proof route; normal atlas pages keep a 3x floor. */
    var rect = cv.getBoundingClientRect();
    var requested = '3';
    try { requested = new URLSearchParams(location.search).get('quality') || '3'; } catch (e) { }
    var requestedScale = requested === 'high' ? 5 : parseFloat(requested);
    if (!isFinite(requestedScale)) requestedScale = 4;
    var detailPlate = /(?:amline|line|engrave|halftone|dither|screen|moire)/i.test(fx || '');
    var dpr = Math.min(8, Math.max(detailPlate ? 5 : 4, requestedScale, window.devicePixelRatio || 1));
    var cssW = cv.offsetWidth || cv.clientWidth || rect.width;
    var cssH = cv.offsetHeight || cv.clientHeight || rect.height;
    // Bail WITHOUT latching _done if the element has not been laid out yet
    // (hidden view, fonts still loading). Latching here is what produced a
    // 2x2 backing store stretched across the card - a blurred smear.
    if (cssW < 8 || cssH < 8) return;
    cv._done = 1;
    var W = Math.min(4096, Math.round(cssW * dpr));
    var H = Math.min(4096, Math.round(cssH * dpr));
    cv.width = W; cv.height = H;
    cv._paintCssW = cssW;
    cv._paintCssH = cssH;
    cv._paintDpr = dpr;
    var cx = cv.getContext('2d'), opt = {};
    cx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in cx) cx.imageSmoothingQuality = 'high';
    try { opt = JSON.parse(cv.dataset.opt || '{}'); } catch (e) { }
    var paperSrc = cv.dataset.paper;
    var loads = [load(src)];
    if (paperSrc) loads.push(load(paperSrc));
    Promise.all(loads).then(function (images) {
      if (images[1]) opt.paperImage = images[1];
      (T[fx] || T.cyanotype)(cx, W, H, images[0], opt);
    })
      .catch(function () { cv._done = 0; });
  }
  // Paint only what is near the viewport, so an atlas of hundreds of stamps
  // does not rasterise every canvas up front.
  var io = null;
  function observer() {
    if (io || !window.IntersectionObserver) return io;
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { apply(e.target); if (e.target._done) io.unobserve(e.target); }
      });
    }, { rootMargin: '600px 0px' });
    return io;
  }
  /* The live issue and its edge silhouette intentionally share the same
     perforation mask, but several families use bespoke face proportions and
     padding.  Recomputing the silhouette from --ar therefore creates a small
     second rectangle behind those issues.  Mirror the live issue's actual
     untransformed border box instead.  ResizeObserver keeps the two layers
     locked when fonts, responsive CSS, or a different species change it. */
  var fringeRO = null;
  function copyFringeGeometry(stamp, edge) {
    var cs = window.getComputedStyle(stamp);
    var ink = edge.firstElementChild;
    if (!ink) return;
    /* Fit a whole number of perforations to each used edge. Static repeat
       intervals leave a partial final hole whenever a family has a custom
       aspect ratio, which crowds one corner and opens the opposite one. The
       fitted intervals keep the intended density while giving every corner
       the same half-step of paper. */
    var desiredStep = parseFloat(cs.getPropertyValue('--ps')) || 12;
    var borderWidth = parseFloat(cs.width);
    var borderHeight = parseFloat(cs.height);
    if (cs.boxSizing !== 'border-box') {
      borderWidth += parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
        parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      borderHeight += parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    }
    var countX = Math.max(3, Math.round(borderWidth / desiredStep));
    var countY = Math.max(3, Math.round(borderHeight / desiredStep));
    stamp.style.setProperty('--psx', (borderWidth / countX).toFixed(4) + 'px');
    stamp.style.setProperty('--psy', (borderHeight / countY).toFixed(4) + 'px');
    cs = window.getComputedStyle(stamp);
    /* Preserve the fractional used border-box. offsetWidth/offsetHeight round
       to whole CSS pixels; on a scaled issue that creates the faint doubled
       grey edge the review grid exposed. Matching the computed content box
       and padding keeps every perforation centre on the same device pixel. */
    edge.style.boxSizing = cs.boxSizing;
    edge.style.width = cs.width;
    edge.style.height = cs.height;
    edge.style.paddingTop = cs.paddingTop;
    edge.style.paddingRight = cs.paddingRight;
    edge.style.paddingBottom = cs.paddingBottom;
    edge.style.paddingLeft = cs.paddingLeft;
    edge.style.borderRadius = cs.borderRadius;
    /* Hidden paper-color stencil: the unmasked wrapper's filter suppresses
       this child graphic and emits only its perforation-following contour. */
    edge.style.backgroundColor = 'transparent';
    edge.style.webkitMask = 'none';
    edge.style.mask = 'none';
    ink.style.borderRadius = cs.borderRadius;
    /* Paint the stencil with the issue's own paper color. Texture bitmaps are
       deliberately excluded: multiplying a grey paper scan into this hidden
       source made cream issues (notably Rock Pigeon) grow a grey contour.
       Structural CSS gradients are safe and preserve genuinely split stock. */
    ink.style.backgroundColor = cs.backgroundColor;
    var paperImage = cs.backgroundImage;
    var structuralGradient = paperImage && paperImage !== 'none' &&
      paperImage.indexOf('url(') === -1 && paperImage.indexOf('gradient(') !== -1;
    ink.style.backgroundImage = structuralGradient ? paperImage : 'none';
    ink.style.backgroundSize = cs.backgroundSize;
    ink.style.backgroundPosition = cs.backgroundPosition;
    ink.style.backgroundRepeat = cs.backgroundRepeat;
    ink.style.backgroundOrigin = cs.backgroundOrigin;
    ink.style.backgroundClip = cs.backgroundClip;
    edge.style.setProperty('--pr', cs.getPropertyValue('--pr'));
    edge.style.setProperty('--ps', cs.getPropertyValue('--ps'));
    edge.style.setProperty('--psx', cs.getPropertyValue('--psx'));
    edge.style.setProperty('--psy', cs.getPropertyValue('--psy'));
    /* Copy the resolved mask rather than rebuilding it from family defaults.
       This keeps custom padding, pearl/saw spacing and the four edge layers
       pixel-identical to the live stamp at every responsive size. */
    ink.style.webkitMaskImage = cs.webkitMaskImage;
    ink.style.webkitMaskPosition = cs.webkitMaskPosition;
    ink.style.webkitMaskSize = cs.webkitMaskSize;
    ink.style.webkitMaskRepeat = cs.webkitMaskRepeat;
    ink.style.webkitMaskComposite = cs.webkitMaskComposite;
    ink.style.maskImage = cs.maskImage;
    ink.style.maskPosition = cs.maskPosition;
    ink.style.maskSize = cs.maskSize;
    ink.style.maskRepeat = cs.maskRepeat;
    ink.style.maskComposite = cs.maskComposite;
  }
  function syncFringe(root) {
    var fits = (root || document).querySelectorAll('.stamp-fit');
    if (!fringeRO && window.ResizeObserver) {
      fringeRO = new ResizeObserver(function (entries) {
        entries.forEach(function (entry) {
          var stamp = entry.target;
          var fit = stamp.parentElement;
          var edge = fit && fit.querySelector('.stamp-fringe-outline');
          if (!edge) return;
          copyFringeGeometry(stamp, edge);
        });
      });
    }
    for (var i = 0; i < fits.length; i++) {
      var stamp = fits[i].querySelector('.stamp');
      var edge = fits[i].querySelector('.stamp-fringe-outline');
      if (!stamp || !edge) continue;
      copyFringeGeometry(stamp, edge);
      if (fringeRO && !stamp._fringeObserved) {
        stamp._fringeObserved = 1;
        fringeRO.observe(stamp);
      }
    }
  }
  function run(root) {
    if (window.STAMPS && typeof window.STAMPS.syncFringe === 'function') {
      window.STAMPS.syncFringe(root);
    }
    var list = (root || document).querySelectorAll('canvas.fxc[data-fx]');
    document.documentElement.setAttribute('data-stamp-fx-run', String(list.length));
    var ob = observer();
    for (var i = 0; i < list.length; i++) {
      var cv = list[i];
      if (cv._done) continue;
      try {
        apply(cv);                                 // in view + laid out: paint now
        cv.setAttribute('data-fx-state', cv._done ? 'painting' : 'deferred');
      } catch (err) {
        cv.setAttribute('data-fx-state', 'error');
        cv.setAttribute('data-fx-error', String(err && err.message || err));
      }
      if (!cv._done && ob && !cv._obs) { cv._obs = 1; ob.observe(cv); }
    }
  }

  // Chromium changes its effective device scale as the page is zoomed. A
  // line-screen canvas that was sharp at the old scale otherwise remains a
  // stale bitmap and develops false seams or soft dots. Repaint only visible
  // plates whose backing scale or CSS box is no longer sufficient.
  var scaleRefresh = 0;
  function refreshScaleSensitivePlates() {
    scaleRefresh = 0;
    var viewScale = window.visualViewport && window.visualViewport.scale || 1;
    var effective = Math.min(8, Math.max(4, (window.devicePixelRatio || 1) * viewScale));
    document.querySelectorAll('canvas.fxc[data-fx]').forEach(function (cv) {
      var r = cv.getBoundingClientRect();
      if (r.bottom < -40 || r.top > innerHeight + 40 || r.right < -40 || r.left > innerWidth + 40) return;
      var cssW = cv.offsetWidth || cv.clientWidth || r.width;
      var cssH = cv.offsetHeight || cv.clientHeight || r.height;
      var detail = /(?:amline|line|engrave|halftone|dither|screen|moire)/i.test(cv.dataset.fx || '');
      var wanted = Math.max(detail ? 5 : 4, effective);
      if (Math.abs((cv._paintCssW || 0) - cssW) > .75 ||
          Math.abs((cv._paintCssH || 0) - cssH) > .75 ||
          (cv._paintDpr || 0) + .2 < wanted) {
        cv._done = 0;
        apply(cv);
      }
    });
  }
  function queueScaleRefresh() {
    clearTimeout(scaleRefresh);
    scaleRefresh = setTimeout(refreshScaleSensitivePlates, 40);
  }
  window.addEventListener('resize', queueScaleRefresh, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueScaleRefresh, { passive: true });
  return { run: run, apply: apply, syncFringe: syncFringe, T: T };
})();
document.documentElement.setAttribute('data-stamps-stage', 'fx-ready');

/* Canvas plates are inserted after this file loads on the review page and in
   several app views.  Keep the renderer attached to the document lifecycle so
   late template insertion cannot leave a default 300x150 blank canvas behind. */
(function () {
  var queued = 0;
  function paintInsertedPlates() {
    queued = 0;
    if (window.FX) window.FX.run(document);
  }
  function queuePaint() {
    if (queued) return;
    queued = 1;
    requestAnimationFrame(paintInsertedPlates);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', queuePaint, { once: true });
  } else {
    queuePaint();
  }
  window.addEventListener('load', queuePaint, { once: true });
  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) {
          queuePaint();
          break;
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();

(function () {
  "use strict";
  var TPL = {};
  var TPL_LIST = [{"id":"field","title":"Field Guide","ar":0.78,"perf":"scallop","html":"<div class=\"face paper vig field\" style=\"--face:linear-gradient(180deg,#e4dcc6,#d3c9ab)\"><div class=\"fld-t\">{{NAME}}</div><div class=\"fld-win\"><img class=\"fld-b\" src=\"{{SRC}}\"></div><div class=\"fld-i\">{{INDEX}}</div><div class=\"fld-r\"><b>{{PROJECT}}</b><br>{{ORDER}} \u00b7 N\u00ba {{INDEX}}</div></div>"},{"id":"flock","title":"Cyanotype Specimen","ar":0.8,"perf":"scallop","html":"<div class=\"face tpl-flock\" style=\"--face:#0b284e\"><canvas class=\"fxc cy-cv\" data-fx=\"cyanotype\" data-src=\"{{SRC}}\" data-opt='{\"pad\":0.05}'></canvas><div class=\"cy-org\">AvianVisitors</div><div class=\"cy-no\">N\u00ba {{INDEX}}</div><div class=\"cy-cap\"><div class=\"cy-name\">{{NAME}}</div><div class=\"cy-sci\">{{SCI}}</div></div><div class=\"cy-grain\"></div></div>"},{"id":"dither","title":"Halftone Museum","ar":0.72,"perf":"pearl","html":"<div class=\"face paper vig tpl-dither\" style=\"--face:#f1efe8\"><span class=\"dth-kick\">{{PROJECT}} \u00b7 {{FAMILY}}</span><h3 class=\"dth-title\">{{NAME}}</h3><div class=\"dth-num\"><span class=\"no\">N\u00ba</span>{{INDEX}}</div><div class=\"dth-sci\">{{SCI}}</div><div class=\"dth-panel\"><canvas class=\"fxc\" data-fx=\"halftone\" data-src=\"{{SRC}}\" data-opt='{\"dot\":0.019,\"ink\":\"#191713\",\"paper\":\"#f1efe8\",\"head\":0.62,\"pad\":0.03,\"cover\":true}'></canvas></div></div>"},{"id":"geo","title":"Geode \u2014 mid-century geometric (Argentina)","ar":0.78,"perf":"scallop","html":"<div class=\"face paper tpl-geo\" style=\"--face:#a8bd60\"><canvas class=\"fxc geo-art\" data-fx=\"lowpoly\" data-src=\"{{SRC}}\" data-opt='{\"step\":0.145,\"pad\":0.04,\"jitter\":7,\"palette\":[\"#2b1e66\",\"#cc2b7e\",\"#f0663a\",\"#f6c945\"]}'></canvas><div class=\"geo-spine\">{{ORDER}}</div><div class=\"geo-den\"><small>N\u00ba</small>{{INDEX}}</div><div class=\"geo-name\">{{NAME}}</div><div class=\"geo-credit\"><span class=\"gsci\">{{SCI}}</span><span class=\"gproj\">\u00a0\u00b7 AvianVisitors</span></div></div>"},{"id":"mono","title":"Mono \u2014 Modernist Black","ar":0.76,"perf":"pearl","html":"<div class=\"face paper tpl-mono\" style=\"--face:#070707\"><span class=\"sil m-bird\" style=\"--src:url('{{SRC}}');--c:#f2efe6\"></span><div class=\"m-head\"><div class=\"m-name\">{{NAME}}</div><div class=\"m-bar\"></div><div class=\"m-meta\">{{FAMILY}} \u00b7 {{ORDER}}</div></div><div class=\"m-num\"><span class=\"m-den\">N\u00ba</span>{{INDEX}}</div><div class=\"m-proj\">{{PROJECT}}</div><div class=\"m-sci\">{{SCI}}</div></div>"},{"id":"bundespost","title":"Bundespost Poster","ar":0.84,"perf":"scallop","html":"<div class=\"face paper vig tpl-bundespost\" style=\"--face:#f4efe4\">\n  <span class=\"sil bp-bird\" style=\"--src:url('{{SRC}}');--c:#d8241d\"></span>\n  <div class=\"bp-num\"><i>N\u00ba</i>{{INDEX}}</div>\n  <div class=\"bp-edge bp-l\">{{ORDER}}</div>\n  <div class=\"bp-edge bp-r\">AVIANVISITORS</div>\n  <div class=\"bp-band\">\n    <span class=\"bp-name\">{{NAME}}</span>\n    <span class=\"bp-sci\">{{SCI}}</span>\n  </div>\n</div>"},{"id":"zurichpink","title":"Z\u00fcrich Rose \u2014 Swiss Halftone","ar":0.8,"perf":"scallop","html":"<div class=\"face tpl-zurichpink paper vig\" style=\"--face:#f4b7ce\">\n  <canvas class=\"fxc zp-c\" data-fx=\"halftone\" data-src=\"{{SRC}}\" data-opt='{\"paper\":\"#f4b7ce\",\"ink\":\"#e23a52\",\"dot\":0.015,\"fit\":\"bird\",\"pad\":0.13}'></canvas>\n  <div class=\"zp-brand\">{{PROJECT}}</div>\n  <div class=\"zp-no\"><i>N\u00ba</i><b>{{INDEX}}</b></div>\n  <div class=\"zp-name\"><b>{{NAME}}</b><i>{{SCI}}</i></div>\n  <div class=\"zp-fam\">{{FAMILY}}</div>\n</div>"},{"id":"mexico","title":"Mexico Exporta","ar":1.5,"perf":"scallop","html":"<div class=\"face paper tpl-mexico\" style=\"--face:#f8f2e1\">\n  <div class=\"mx-bird\"><span class=\"mx-sil\" style=\"--src:url('{{SRC}}')\"></span><span class=\"mx-tex\" style=\"--src:url('{{SRC}}')\"></span></div>\n  <div class=\"mx-name\"><b>{{NAME}}</b><i>{{SCI}}</i></div>\n  <div class=\"mx-badge\">\n    <svg viewBox=\"0 0 100 100\" class=\"mx-disc\" xmlns=\"http://www.w3.org/2000/svg\">\n      <defs><path id=\"mxTop{{INDEX}}\" d=\"M15,50 A35,35 0 0 1 85,50\"/><path id=\"mxBot{{INDEX}}\" d=\"M17,50 A33,33 0 0 0 83,50\"/></defs>\n      <circle cx=\"50\" cy=\"50\" r=\"48\" fill=\"var(--mx-ink)\"/>\n      <circle cx=\"50\" cy=\"50\" r=\"44\" fill=\"none\" stroke=\"var(--mx-paper)\" stroke-width=\"0.8\" opacity=\"0.85\"/>\n      <circle cx=\"50\" cy=\"50\" r=\"27.5\" fill=\"none\" stroke=\"var(--mx-paper)\" stroke-width=\"0.7\" opacity=\"0.5\"/>\n      <text class=\"mx-arc mx-arc-t\"><textPath href=\"#mxTop{{INDEX}}\" startOffset=\"50%\">AVIAN VISITORS</textPath></text>\n      <text class=\"mx-arc mx-arc-b\"><textPath href=\"#mxBot{{INDEX}}\" startOffset=\"50%\">{{FAMILY}}</textPath></text>\n      <circle cx=\"13\" cy=\"50\" r=\"1.1\" fill=\"var(--mx-paper)\"/><circle cx=\"87\" cy=\"50\" r=\"1.1\" fill=\"var(--mx-paper)\"/>\n    </svg>\n    <span class=\"mx-emblem\" style=\"--src:url('{{SRC}}')\"></span>\n  </div>\n  <div class=\"mx-den\"><span class=\"mx-no\">N\u00ba</span><span class=\"mx-num\">{{INDEX}}</span></div>\n</div>"},{"id":"kieler","title":"Kieler \u2014 inset riso marine panel, cut-paper waves","ar":0.78,"perf":"pearl","html":"<div class=\"face paper vig tpl-kieler\" style=\"--face:#f1ebdd\">\n  <div class=\"k-field\">\n    <div class=\"k-tex\" aria-hidden=\"true\"></div>\n    <div class=\"k-sea\" aria-hidden=\"true\">\n        <svg viewBox=\"0 0 200 250\" preserveAspectRatio=\"none\">\n          <path class=\"w-back\" d=\"M-10.0,155.1 L-6.0,152.2 L-2.0,148.9 L2.0,145.8 L6.0,143.7 L10.0,143.0 L14.0,143.9 L18.0,146.2 L22.0,149.4 L26.0,152.7 L30.0,155.4 L34.0,156.9 L38.0,156.7 L42.0,155.1 L46.0,152.2 L50.0,148.9 L54.0,145.8 L58.0,143.7 L62.0,143.0 L66.0,143.9 L70.0,146.2 L74.0,149.4 L78.0,152.7 L82.0,155.4 L86.0,156.9 L90.0,156.7 L94.0,155.1 L98.0,152.2 L102.0,148.9 L106.0,145.8 L110.0,143.7 L114.0,143.0 L118.0,143.9 L122.0,146.2 L126.0,149.4 L130.0,152.7 L134.0,155.4 L138.0,156.9 L142.0,156.7 L146.0,155.1 L150.0,152.2 L154.0,148.9 L158.0,145.8 L162.0,143.7 L166.0,143.0 L170.0,143.9 L174.0,146.2 L178.0,149.4 L182.0,152.7 L186.0,155.4 L190.0,156.9 L194.0,156.7 L198.0,155.1 L202.0,152.2 L206.0,148.9 L210.0,145.8 L210,270 L-10,270 Z\"/>\n          <path class=\"w-mid\" d=\"M-10.0,175.0 L-6.0,171.7 L-2.0,170.1 L2.0,170.6 L6.0,173.1 L10.0,176.9 L14.0,181.0 L18.0,184.3 L22.0,185.9 L26.0,185.4 L30.0,182.9 L34.0,179.1 L38.0,175.0 L42.0,171.7 L46.0,170.1 L50.0,170.6 L54.0,173.1 L58.0,176.9 L62.0,181.0 L66.0,184.3 L70.0,185.9 L74.0,185.4 L78.0,182.9 L82.0,179.1 L86.0,175.0 L90.0,171.7 L94.0,170.1 L98.0,170.6 L102.0,173.1 L106.0,176.9 L110.0,181.0 L114.0,184.3 L118.0,185.9 L122.0,185.4 L126.0,182.9 L130.0,179.1 L134.0,175.0 L138.0,171.7 L142.0,170.1 L146.0,170.6 L150.0,173.1 L154.0,176.9 L158.0,181.0 L162.0,184.3 L166.0,185.9 L170.0,185.4 L174.0,182.9 L178.0,179.1 L182.0,175.0 L186.0,171.7 L190.0,170.1 L194.0,170.6 L198.0,173.1 L202.0,176.9 L206.0,181.0 L210.0,184.3 L210,270 L-10,270 Z\"/>\n          <path class=\"w-front\" d=\"M-10.0,199.0 L-6.0,200.1 L-2.0,203.1 L2.0,207.0 L6.0,210.6 L10.0,212.7 L14.0,212.7 L18.0,210.6 L22.0,207.0 L26.0,203.1 L30.0,200.1 L34.0,199.0 L38.0,200.1 L42.0,203.1 L46.0,207.0 L50.0,210.6 L54.0,212.7 L58.0,212.7 L62.0,210.6 L66.0,207.0 L70.0,203.1 L74.0,200.1 L78.0,199.0 L82.0,200.1 L86.0,203.1 L90.0,207.0 L94.0,210.6 L98.0,212.7 L102.0,212.7 L106.0,210.6 L110.0,207.0 L114.0,203.1 L118.0,200.1 L122.0,199.0 L126.0,200.1 L130.0,203.1 L134.0,207.0 L138.0,210.6 L142.0,212.7 L146.0,212.7 L150.0,210.6 L154.0,207.0 L158.0,203.1 L162.0,200.1 L166.0,199.0 L170.0,200.1 L174.0,203.1 L178.0,207.0 L182.0,210.6 L186.0,212.7 L190.0,212.7 L194.0,210.6 L198.0,207.0 L202.0,203.1 L206.0,200.1 L210.0,199.0 L210,270 L-10,270 Z\"/>\n        </svg>\n      </div>\n    <span class=\"sil k-bird k-bird-b\" style=\"--src:url('{{SRC}}');--c:#8fb0e0\"></span><span class=\"sil k-bird k-bird-f\" style=\"--src:url('{{SRC}}');--c:var(--k-cream)\"></span>\n  </div>\n  <div class=\"k-cap\">\n    <div class=\"k-name\">{{NAME}}</div>\n    <div class=\"k-meta\"><span>N\u00ba {{INDEX}}</span><span>AvianVisitors</span></div>\n  </div>\n</div>"},{"id":"linescreen","title":"Line-Screen Plate","ar":1.75,"perf":"scallop","html":"<div class=\"face paper tpl-linescreen\" style=\"--face:#38659f\"><div class=\"ls-panel\"><canvas class=\"ls-eng fxc\" data-fx=\"engrave\" data-src=\"{{SRC}}\" data-opt='{\"ink\":\"#eef3f8\",\"paper\":\"#38659f\",\"gap\":0.028,\"pad\":0.05}'></canvas></div><div class=\"ls-col\"><div class=\"ls-head\"><div class=\"ls-name\">{{NAME}}</div><div class=\"ls-fam\">{{FAMILY}}</div></div><div class=\"ls-mid\"><div class=\"ls-idxbox\"><span class=\"ls-no\">N\u00ba</span><span class=\"ls-idx\">{{INDEX}}</span></div><div class=\"ls-tag\"><b>LIFE</b><b>LIST</b></div></div><div class=\"ls-foot\"><div class=\"ls-sci\">{{SCI}}</div><div class=\"ls-mark\"><span class=\"ls-proj\">{{PROJECT}}</span><span class=\"ls-ord\">{{ORDER}}</span></div></div></div></div>"},{"id":"terraplana","title":"Terraplana \u2014 screen-print grid","ar":0.78,"perf":"flat","html":"<div class=\"face paper tpl-terraplana\" style=\"--face:#e9e2d2\">\n  <div class=\"tp-rule tp-rule-h\"></div>\n  <div class=\"tp-rule tp-rule-v\"></div>\n  <div class=\"tp-kick\">{{PROJECT}}</div>\n  <div class=\"tp-fam\">{{FAMILY}}</div>\n  <div class=\"tp-num\">{{INDEX}}</div>\n  <div class=\"tp-panel\"><canvas class=\"fxc\" data-fx=\"halftone\" data-src=\"{{SRC}}\" data-opt='{\"dot\":0.021,\"ink\":\"#1f4f52\",\"paper\":\"#e9e2d2\",\"fit\":\"bird\",\"pad\":0.05}'></canvas></div>\n  <div class=\"tp-cap\"><b>{{NAME}}</b><i>{{SCI}}</i></div>\n</div>"},{"id":"opart","title":"Op-Art Line-Field Maxicard","ar":0.7,"perf":"flat","html":"<div class=\"face paper vig tpl-opart\" style=\"--face:#efe9db\"><div class=\"op-plate\"><div class=\"op-field\"></div><div class=\"op-sil\" style=\"--src:url('{{SRC}}')\"></div><div class=\"op-fig\" style=\"--src:url('{{SRC}}')\"></div></div><div class=\"op-stamp\"><div class=\"st-den\"><sup>N\u00ba</sup><b>{{INDEX}}</b></div><div class=\"st-eng\"><div class=\"st-fig\" style=\"--src:url('{{SRC}}')\"></div></div><div class=\"st-country\">{{PROJECT}}</div></div><div class=\"op-mark\"><svg viewBox=\"0 0 100 100\" aria-hidden=\"true\"><circle class=\"mk-ring\" cx=\"50\" cy=\"50\" r=\"47\" style=\"stroke-width:2\"/><text class=\"mk-big\" x=\"50\" y=\"50\" text-anchor=\"middle\" dominant-baseline=\"central\">{{INDEX}}</text></svg></div><div class=\"op-cap\"><span class=\"cp-idx\">{{PROJECT}}</span><span class=\"cp-name\">{{NAME}}</span><span class=\"cp-sci\">{{SCI}}</span></div></div>"},{"id":"nzplate","title":"New Zealand Plate \u2014 1970 definitive specimen","ar":0.8,"perf":"scallop","html":"<div class=\"face paper vig tpl-nzplate\" style=\"--face:#c0942e\"><div class=\"nz-head\"><div class=\"nz-mast\">Avian<br>Visitors</div><div class=\"nz-val\"><span class=\"nz-no\">N\u00ba</span><span class=\"nz-num\">{{INDEX}}</span></div></div><div class=\"nz-spec\"><img class=\"bird\" src=\"{{SRC}}\" alt=\"{{NAME}}\"></div><div class=\"nz-cap\"><div class=\"nz-name\">{{NAME}}</div><div class=\"nz-sci\">{{SCI}}</div></div><div class=\"nz-imp\">{{PROJECT}}</div></div>"},{"id":"editorial","title":"Editorial \u2014 serif masthead over a vermillion specimen band","ar":0.52,"perf":"scallop","html":"<div class=\"face paper tpl-editorial\" style=\"--face:#f4efe4\"><div class=\"ed-top\"><h1 class=\"ed-title\">{{NAME}}</h1><p class=\"ed-cap\">{{SCI}}</p></div><div class=\"ed-denom\"><span class=\"ed-val\">N\u00ba {{INDEX}}</span><span class=\"ed-tax\"><span class=\"ed-ord\">{{ORDER}}</span><span class=\"ed-fam\">{{FAMILY}}</span></span></div><div class=\"ed-credit\"><span class=\"ed-proj\">{{PROJECT}}</span><span class=\"ed-rep\">{{NAME}}</span></div><div class=\"ed-band\"><svg class=\"ed-swatch\" viewBox=\"0 0 176 159\" preserveAspectRatio=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><defs><filter id=\"ed-cream-{{INDEX}}\" color-interpolation-filters=\"sRGB\" x=\"-2%\" y=\"-2%\" width=\"104%\" height=\"104%\"><feColorMatrix type=\"matrix\" values=\"0 0 0 0 0.957  0 0 0 0 0.925  0 0 0 0 0.839  0 0 0 1 0\"/></filter><pattern id=\"ed-pat-{{INDEX}}\" patternUnits=\"userSpaceOnUse\" width=\"58\" height=\"120\"><image href=\"{{SRC}}\" x=\"6\" y=\"6\" width=\"46\" height=\"48\" preserveAspectRatio=\"xMidYMid meet\" filter=\"url(#ed-cream-{{INDEX}})\"/><image href=\"{{SRC}}\" x=\"35\" y=\"66\" width=\"46\" height=\"48\" preserveAspectRatio=\"xMidYMid meet\" filter=\"url(#ed-cream-{{INDEX}})\"/><image href=\"{{SRC}}\" x=\"-23\" y=\"66\" width=\"46\" height=\"48\" preserveAspectRatio=\"xMidYMid meet\" filter=\"url(#ed-cream-{{INDEX}})\"/></pattern></defs><rect width=\"176\" height=\"159\" fill=\"url(#ed-pat-{{INDEX}})\"/></svg></div></div>"},{"id":"minimal","title":"Gold Rising Sun","ar":1,"perf":"scallop","html":"<div class=\"face paper tpl-minimal\" style=\"--face:#ece8dc\"><span class=\"mn-disc mn-l\"></span><span class=\"mn-disc mn-r\"></span><span class=\"mn-bird\" style=\"--src:url('{{SRC}}')\"></span><div class=\"mn-head\"><p class=\"mn-name\">{{NAME}}</p><div class=\"mn-no\">N\u00ba {{INDEX}}</div></div><div class=\"mn-foot\"><span class=\"mn-proj\">{{PROJECT}}</span><span class=\"mn-sci\">{{SCI}}</span></div><div class=\"mn-fam\">{{FAMILY}}</div></div>"}];
  // Hawks use a natural-history field plate rather than the generic fallback:
  // a source-colour specimen sits inside an ochre observation diagram while
  // the oversized common name borrows the editorial weight of the Star Field
  // issue. The paper scan crosses art, type and stock as one printed object.
  var raptorIssue = {
    id: 'raptor',
    title: 'Raptor Field Notes',
    ar: 0.82,
    perf: 'scallop',
    html:
      '<div class="face field tpl-fieldguide" style="--face:#d7b46d">' +
        '<div class="fg-plate">' +
          '<div class="fg-register"><span>FIELD OBSERVATION</span><span>PLATE {{INDEX}}</span></div>' +
          '<svg class="fg-flight" viewBox="0 0 160 160" preserveAspectRatio="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
            '<g class="fg-flight-lines">' +
              '<circle cx="28" cy="91" r="4"/><circle cx="28" cy="91" r="15"/><circle cx="28" cy="91" r="28"/>' +
              '<path d="M28 91L6 42M28 91L13 16M28 91L46 22M28 91L80 14M28 91L105 44M28 91L118 78M28 91L93 119M28 91L57 146M28 91L12 143"/>' +
              '<path d="M4 115C35 97 68 84 113 80M46 151C64 123 92 100 148 83"/>' +
              '<path d="M107 23v14m-7-7h14M136 52v11m-5.5-5.5h11M92 132v10m-5-5h10"/>' +
            '</g>' +
            '<g class="fg-flight-dots"><circle cx="13" cy="16" r="1.6"/><circle cx="80" cy="14" r="1.6"/><circle cx="105" cy="44" r="1.6"/><circle cx="118" cy="78" r="1.6"/><circle cx="93" cy="119" r="1.6"/><circle cx="57" cy="146" r="1.6"/></g>' +
          '</svg>' +
          '<div class="fg-scale"><span>0</span><i></i><span>5</span><i></i><span>10</span><i></i><span>15</span></div>' +
          '<div class="fg-specimen" style="--src:url(\'{{SRC}}\')">' +
            '<span class="fg-registration sil" aria-hidden="true"></span>' +
            '<img class="fg-bird" src="{{SRC}}" alt="{{NAME}}">' +
          '</div>' +
          '<div class="fg-plate-mark"><b>{{INDEX}}</b><span>ACCIPITRIDAE</span></div>' +
        '</div>' +
        '<div class="fg-caption">' +
          '<div class="fg-name">{{NAME_STACK}}</div>' +
          '<div class="fg-meta"><b>AVIAN<br>VISITORS</b><span class="fg-sci">{{SCI_STACK}}</span></div>' +
        '</div>' +
        '<span class="fg-paper" aria-hidden="true"></span>' +
      '</div>'
  };
  TPL_LIST.push(raptorIssue);
  // Herons are one full-sheet contact print: specimen and postal copy share
  // the same sensitised paper. The bird stays tonal and darker than the
  // masked type, while deterministic wash/fibre filters soften the copy like
  // a transparency held against real cyanotype paper.
  var flockIssue = TPL_LIST.filter(function (t) { return t.id === 'flock'; })[0];
  if (flockIssue) {
    flockIssue.title = 'Full-Sheet Cyanotype';
    flockIssue.html = '<div class="face paper tpl-flock" style="--face:#08265d">' +
      '<canvas class="fxc cy-cv" data-fx="cyanotype" data-src="{{SRC}}" data-opt=\'{"pad":0.065,"offsetX":0.028,"offsetY":-0.006,"seed":{{INDEX}},"shadow":[4,24,65],"hi":[126,174,187],"gamma":0.72,"groundL":0.012,"mottle":8,"mottleAlpha":0.05,"grain":0.032,"sharpen":0.2}\'></canvas>' +
      '<svg class="cy-chem" viewBox="0 0 168 210" preserveAspectRatio="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
        '<defs>' +
          '<filter id="cy-wash-{{INDEX}}" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">' +
            '<feTurbulence type="fractalNoise" baseFrequency=".014 .052" numOctaves="3" seed="{{INDEX}}" stitchTiles="stitch" result="coat"/>' +
            '<feColorMatrix in="coat" type="matrix" values="0 0 0 0 .66  0 0 0 0 .78  0 0 0 0 .83  0 0 0 .46 -.17" result="wash"/>' +
            '<feGaussianBlur in="wash" stdDeviation="1.15"/>' +
          '</filter>' +
          '<filter id="cy-fiber-{{INDEX}}" x="-4%" y="-4%" width="108%" height="108%" color-interpolation-filters="sRGB">' +
            '<feTurbulence type="fractalNoise" baseFrequency=".49 .15" numOctaves="2" seed="{{INDEX}}" stitchTiles="stitch" result="tooth"/>' +
            '<feColorMatrix in="tooth" type="matrix" values="0 0 0 0 .78  0 0 0 0 .87  0 0 0 0 .84  0 0 0 .28 -.12"/>' +
          '</filter>' +
          '<filter id="cy-type-{{INDEX}}" x="-4%" y="-8%" width="108%" height="116%" color-interpolation-filters="sRGB">' +
            '<feTurbulence type="fractalNoise" baseFrequency=".68 .24" numOctaves="1" seed="{{INDEX}}" stitchTiles="stitch" result="contact"/>' +
            '<feDisplacementMap in="SourceGraphic" in2="contact" scale=".62" xChannelSelector="R" yChannelSelector="G" result="shifted"/>' +
            '<feColorMatrix in="contact" type="luminanceToAlpha" result="contact-alpha"/>' +
            '<feComponentTransfer in="contact-alpha" result="contact-mask"><feFuncA type="table" tableValues=".78 .9 1"/></feComponentTransfer>' +
            '<feComposite in="shifted" in2="contact-mask" operator="in"/>' +
          '</filter>' +
        '</defs>' +
        '<rect class="cy-wash" width="168" height="210" filter="url(#cy-wash-{{INDEX}})"/>' +
        '<rect class="cy-fiber" width="168" height="210" filter="url(#cy-fiber-{{INDEX}})"/>' +
      '</svg>' +
      '<div class="cy-copy" style="filter:url(#cy-type-{{INDEX}})">' +
        '<div class="cy-family" aria-label="{{ORDER}}">{{ORDER_PAIRS}}</div>' +
        '<div class="cy-no">{{INDEX}}</div>' +
        '<div class="cy-species"><div class="cy-name">{{NAME_STACK}}</div><div class="cy-sci">{{SCI_STACK}}</div></div>' +
        '<div class="cy-brand">{{PROJECT_STACK}}</div>' +
      '</div>' +
    '</div>';
  }
  // Hummingbirds use the Argentine geometric reference: a complete silhouette,
  // broad source-aware planes snapped to seven vivid inks, and a cream keyline.
  var geoIssue = TPL_LIST.filter(function (t) { return t.id === 'geo'; })[0];
  if (geoIssue) geoIssue.html = geoIssue.html.replace(
    '{"step":0.145,"pad":0.04,"jitter":7,"palette":["#2b1e66","#cc2b7e","#f0663a","#f6c945"]}',
    '{"step":0.21,"pad":0.055,"jitter":0,"seed":1972,"structured":true,"flowAligned":true,"flowOffset":12,"polygonOutline":true,"outlineTolerance":0.018,"beakProtect":0.30,"beakSimplify":0.86,"semanticHummingbird":true,"sourcePalette":true,"quantizeSource":true,"perceptualPalette":true,"huePalette":true,"vibrantBirdMap":true,"paletteVote":true,"birdPalette":true,"edgeAware":true,"edgeAlpha":false,"edgeCell":0.68,"edgePoints":10,"edgeMin":0.48,"edgeThreshold":0.12,"palette":["#a94759","#c75b70","#d36b50","#d38a43","#c4a947","#719553","#3e7d70"],"offsetX":-0.012,"offsetY":0.055,"scale":0.94,"rotate":6,"keyline":"#f2e7d2","keylineWidth":0.022}'
  );
  // The static screen construction follows the multiplied, slightly rotated
  // texture model used by robinhouston/a8cc2a0ac03809be0c0f and glfx.js's
  // dot-screen filter. Inline SVG keeps it deterministic and dependency-free.
  var geoMoire = '<svg class="geo-moire" viewBox="0 0 200 250" preserveAspectRatio="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
      '<pattern id="gm-a-{{INDEX}}" width="4.15" height="4.15" patternUnits="userSpaceOnUse" patternTransform="rotate(14)"><circle cx="2.075" cy="2.075" r="0.62" fill="#304827"/></pattern>' +
      '<pattern id="gm-b-{{INDEX}}" width="4.55" height="4.55" patternUnits="userSpaceOnUse" patternTransform="rotate(17.25)"><circle cx="2.275" cy="2.275" r="0.52" fill="#586b32"/></pattern>' +
      '<filter id="gm-paper-{{INDEX}}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.34 0.58" numOctaves="3" seed="{{INDEX}}" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0.13  0 0 0 0 0.19  0 0 0 0 0.10  0 0 0 .72 0"/></filter>' +
    '</defs>' +
    '<rect class="gm-a" width="200" height="250" fill="url(#gm-a-{{INDEX}})"/>' +
    '<rect class="gm-b" width="200" height="250" fill="url(#gm-b-{{INDEX}})"/>' +
    '<rect class="gm-fiber" width="200" height="250" filter="url(#gm-paper-{{INDEX}})"/>' +
  '</svg>';
  if (geoIssue) geoIssue.html = geoIssue.html
    .replace('<div class="face paper tpl-geo" style="--face:#a8bd60">', '<div class="face paper tpl-geo" style="--face:#f2e7d2;--geo-field:#c6d79a"><div class="geo-field">')
    .replace(/<\/div>$/, geoMoire + '</div></div>')
    .replace('<div class="geo-spine">{{ORDER}}</div>', '<div class="geo-spine">{{ORDER}} · AvianVisitors</div>')
    .replace('<span class="gproj">\u00a0· AvianVisitors</span>', '');
  // Corvids follow the black Australian/Canadian modernist issues: the black
  // stock itself owns the perforated edge, and a strict five-label grid avoids
  // repeating the display group alongside the taxonomic family.
  var monoIssue = TPL_LIST.filter(function (t) { return t.id === 'mono'; })[0];
  if (monoIssue) {
    monoIssue.perf = 'scallop';
    var monoMaterial = '<svg class="m-material" viewBox="0 0 180 230" preserveAspectRatio="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<pattern id="mm-weave-{{INDEX}}" width="34" height="34" patternUnits="userSpaceOnUse" patternTransform="rotate(45 90 115)">' +
          '<rect width="17" height="17" fill="#08090a"/><rect x="17" width="17" height="17" fill="#232527"/>' +
          '<rect y="17" width="17" height="17" fill="#2a2c2e"/><rect x="17" y="17" width="17" height="17" fill="#0c0d0e"/>' +
          '<path d="M17 0V34M0 17H34" stroke="#dedfd9" stroke-opacity=".055" stroke-width=".55"/>' +
        '</pattern>' +
        '<filter id="mm-cloud-{{INDEX}}" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">' +
          '<feTurbulence type="fractalNoise" baseFrequency=".016 .027" numOctaves="3" seed="{{INDEX}}" stitchTiles="stitch" result="noise"/>' +
          '<feColorMatrix in="noise" type="matrix" values="0 0 0 0 .73  0 0 0 0 .74  0 0 0 0 .72  .48 0 0 0 -.17" result="mist"/>' +
          '<feGaussianBlur in="mist" stdDeviation="3.2"/>' +
        '</filter>' +
      '</defs>' +
      '<rect class="mm-weave" width="180" height="230" fill="url(#mm-weave-{{INDEX}})"/>' +
      '<rect class="mm-cloud" width="180" height="230" filter="url(#mm-cloud-{{INDEX}})"/>' +
    '</svg>';
    monoIssue.html = monoIssue.html.replace(
      '<div class="m-head"><div class="m-name">{{NAME}}</div><div class="m-bar"></div><div class="m-meta">{{FAMILY}} · {{ORDER}}</div></div>',
      '<div class="m-head"><div class="m-family">{{ORDER}}</div><div class="m-name">{{NAME}}</div></div>'
    ).replace('<span class="m-den">Nº</span>{{INDEX}}', '{{INDEX}}')
      .replace('<span class="sil m-bird"', monoMaterial + '<span class="sil m-bird"')
      .replace('</span><div class="m-head">', '</span><span class="m-gloss" aria-hidden="true"></span><div class="m-head">');
  }
  // Waterfowl follow the compact Japanese line-screen issue: the blue stock
  // runs through the perforations, while the specimen is a true knockout in
  // one continuous field of fine rules. The inline SVG dilates each source
  // alpha before laying the blue specimen back over it, so every Waterfowl
  // cutout receives the same genuinely continuous white keyline.
  var lineIssue = TPL_LIST.filter(function (t) { return t.id === 'linescreen'; })[0];
  if (lineIssue) lineIssue.html =
    '<div class="face tpl-linescreen" style="--face:#3d68a5">' +
      '<div class="ls-panel" aria-hidden="true">' +
        '<div class="ls-field">' +
          '<svg class="ls-birdmark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
            '<defs>' +
              '<filter id="ls-key-{{INDEX}}" x="-8%" y="-8%" width="116%" height="116%" color-interpolation-filters="sRGB">' +
                '<feMorphology in="SourceAlpha" operator="dilate" radius="1" result="spread"/>' +
                '<feFlood flood-color="#fff" result="white"/>' +
                '<feComposite in="white" in2="spread" operator="in"/>' +
              '</filter>' +
              '<filter id="ls-fill-{{INDEX}}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' +
                '<feFlood flood-color="#3d68a5" result="blue"/>' +
                '<feComposite in="blue" in2="SourceAlpha" operator="in"/>' +
              '</filter>' +
            '</defs>' +
            '<image href="{{SRC}}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" filter="url(#ls-key-{{INDEX}})"/>' +
            '<image href="{{SRC}}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" filter="url(#ls-fill-{{INDEX}})"/>' +
          '</svg>' +
        '</div>' +
      '</div>' +
      '<div class="ls-col">' +
        '<div class="ls-head">{{LS_NAME_LINES}}<svg class="ls-sci" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="{{SCI}}"><text x="0" y="8" textLength="100" lengthAdjust="spacingAndGlyphs">{{SCI}}</text></svg></div>' +
        '<div class="ls-mid"><div class="ls-idx" style="font-size:{{LS_INDEX_SIZE}}cqw">{{INDEX}}</div><div class="ls-life"><span>Life</span><span>List</span></div></div>' +
        '<div class="ls-foot"><div class="ls-fam">{{ORDER_HALVES}}</div><div class="ls-proj">{{PROJECT_STACK}}</div></div>' +
      '</div>' +
      '<span class="ls-paper" aria-hidden="true"></span>' +
    '</div>';
  // Owls follow the simpler Gilbert & Ellice definitive hierarchy: a pale
  // perforated stock, one rectangular green picture field, denomination at
  // upper left, family medallion at upper right, vertical taxonomy, dominant
  // specimen, and an oversized condensed species title along the foot. The
  // habitat is a real forest photograph and the owl keeps its photographic
  // anatomy; material texture is applied only after that structure reads.
  var owlIssue = TPL_LIST.filter(function (t) { return t.id === 'opart'; })[0];
  if (owlIssue) {
    owlIssue.title = 'Night Forest Definitive';
    owlIssue.ar = 0.62;
    owlIssue.perf = 'scallop';
    owlIssue.html =
      '<div class="face tpl-opart" style="--face:#fffef8">' +
        '<div class="ow-field">' +
          '<canvas class="fxc ow-forest-plate" data-fx="owlHabitat" data-src="./assets/stamp/owl-pale-treeline.jpg" data-opt=\'{"scale":1.12,"offsetY":-0.125,"deep":"#0d4b2c","mid":"#4d9a5d","pale":"#b8d3a5"}\' aria-hidden="true"></canvas>' +
          '<span class="ow-atmosphere" aria-hidden="true"></span>' +
          '<canvas class="fxc ow-specimen" data-fx="owlEngrave" data-src="{{SRC}}" data-opt=\'{"pad":0.02,"scale":1.01,"offsetY":0.006,"deep":"#0d4b2c","mid":"#65a36e","pale":"#edf2d8"}\' aria-label="{{NAME}}"></canvas>' +
          '<div class="ow-value"><b>{{INDEX}}</b></div>' +
          '<div class="ow-brand"><b>AVIANVISITORS</b><span>{{ORDER}}</span></div>' +
          '<div class="ow-taxonomy">{{SCI}}</div>' +
          '<div class="ow-title">{{NAME}}</div>' +
        '</div>' +
        '<span class="ow-paper" aria-hidden="true"></span>' +
      '</div>';
  }
  TPL_LIST.forEach(function (t) { TPL[t.id] = t; });

  /* ---- genus -> approved family issue. BirdNET reports a binomial, so the
     genus is enough to place a bird in its reviewed issue. Unknown genera use
     one deliberate shared issue; they never hash into retired experiments. ---- */
  var GENUS_GROUP = {
    // hummingbirds
    Calypte:'Hummingbirds', Archilochus:'Hummingbirds', Selasphorus:'Hummingbirds',
    Eugenes:'Hummingbirds', Amazilia:'Hummingbirds',
    // crows, jays, magpies
    Corvus:'Crows & Jays', Aphelocoma:'Crows & Jays', Cyanocitta:'Crows & Jays',
    Pica:'Crows & Jays', Gymnorhinus:'Crows & Jays', Nucifraga:'Crows & Jays',
    // herons, egrets, bitterns
    Ardea:'Herons', Egretta:'Herons', Butorides:'Herons', Nycticorax:'Herons',
    Botaurus:'Herons', Nyctanassa:'Herons',
    // waterfowl
    Anas:'Waterfowl', Aix:'Waterfowl', Branta:'Waterfowl', Anser:'Waterfowl',
    Aythya:'Waterfowl', Bucephala:'Waterfowl', Mergus:'Waterfowl',
    Lophodytes:'Waterfowl', Oxyura:'Waterfowl', Cygnus:'Waterfowl', Spatula:'Waterfowl',
    Mareca:'Waterfowl',
    // owls
    Bubo:'Owls', Tyto:'Owls', Strix:'Owls', Megascops:'Owls', Athene:'Owls', Asio:'Owls',
    // hawks, eagles, falcons, vultures
    Buteo:'Hawks', Accipiter:'Hawks', Haliaeetus:'Hawks', Circus:'Hawks',
    Falco:'Hawks', Cathartes:'Hawks', Elanus:'Hawks', Pandion:'Hawks',
    // gulls and terns
    Larus:'Gulls', Chroicocephalus:'Gulls', Sterna:'Gulls', Hydroprogne:'Gulls',
    // kingfishers
    Megaceryle:'Kingfishers',
    Charadrius:'Gulls', Actitis:'Gulls', Numenius:'Gulls', Calidris:'Gulls',
    // sandpipers and allies
    Tringa:'Shorebirds', Limnodromus:'Shorebirds',
    Himantopus:'Gulls', Recurvirostra:'Gulls', Pelecanus:'Gulls',
    Phalacrocorax:'Gulls', Nannopterum:'Gulls',
    // sparrows and towhees
    Zonotrichia:'Sparrows', Passer:'Sparrows', Melospiza:'Sparrows',
    Passerella:'Sparrows', Pipilo:'Sparrows', Melozone:'Sparrows',
    Junco:'Sparrows', Spizella:'Sparrows', Chondestes:'Sparrows', Ammodramus:'Sparrows',
    Passerculus:'Sparrows',
    // finches and allies
    Haemorhous:'Finches', Spinus:'Finches', Carduelis:'Finches',
    Loxia:'Finches', Pinicola:'Finches', Coccothraustes:'Finches',
    // doves and pigeons
    Zenaida:'Doves & Pigeons', Columba:'Doves & Pigeons', Streptopelia:'Doves & Pigeons',
    Columbina:'Doves & Pigeons', Patagioenas:'Doves & Pigeons',
    // thrushes and bluebirds
    Turdus:'Thrushes', Catharus:'Thrushes', Sialia:'Thrushes', Ixoreus:'Thrushes',
    // tyrant flycatchers
    Sayornis:'Flycatchers', Tyrannus:'Flycatchers', Empidonax:'Flycatchers',
    Contopus:'Flycatchers', Myiarchus:'Flycatchers',
    // mockingbirds and thrashers
    Mimus:'Mockingbirds & Thrashers', Toxostoma:'Mockingbirds & Thrashers',
    Oreoscoptes:'Mockingbirds & Thrashers',
    // waxwings, silky-flycatchers
    Bombycilla:'Waxwings', Phainopepla:'Waxwings',
    // blackbirds, orioles, meadowlarks, starlings
    Agelaius:'Blackbirds & Orioles', Icterus:'Blackbirds & Orioles',
    Euphagus:'Blackbirds & Orioles', Quiscalus:'Blackbirds & Orioles',
    Molothrus:'Blackbirds & Orioles', Sturnella:'Blackbirds & Orioles',
    Sturnus:'Blackbirds & Orioles', Xanthocephalus:'Blackbirds & Orioles',
    // chickadees, titmice, bushtits, nuthatches, wrens, kinglets
    Baeolophus:'Chickadees & Titmice', Poecile:'Chickadees & Titmice',
    Psaltriparus:'Chickadees & Titmice', Sitta:'Chickadees & Titmice',
    Troglodytes:'Chickadees & Titmice', Thryomanes:'Chickadees & Titmice',
    Catherpes:'Chickadees & Titmice', Regulus:'Chickadees & Titmice',
    Corthylio:'Chickadees & Titmice', Chamaea:'Chickadees & Titmice',
    // treecreepers
    Certhia:'Treecreepers',
    // swallows
    Hirundo:'Swallows', Tachycineta:'Swallows', Stelgidopteryx:'Swallows',
    Petrochelidon:'Swallows',
    // warblers, vireos, tanagers, grosbeaks, woodpeckers, quail
    Setophaga:'Warblers & Vireos', Geothlypis:'Warblers & Vireos',
    Cardellina:'Warblers & Vireos', Vireo:'Warblers & Vireos',
    Piranga:'Warblers & Vireos', Pheucticus:'Warblers & Vireos',
    Passerina:'Warblers & Vireos', Cardinalis:'Warblers & Vireos',
    Colaptes:'Warblers & Vireos',
    Picoides:'Warblers & Vireos', Dryobates:'Warblers & Vireos',
    Melanerpes:'Warblers & Vireos', Callipepla:'Warblers & Vireos',
    Zenaidura:'Doves & Pigeons'
  };

  /* Latin family per group, for the small taxonomic line some designs print. */
  var GROUP_LATIN = {
    'Hummingbirds':'Trochilidae', 'Crows & Jays':'Corvidae', 'Herons':'Ardeidae',
    'Waterfowl':'Anatidae', 'Owls':'Strigidae', 'Hawks':'Accipitridae',
    'Gulls':'Laridae', 'Sparrows':'Passerellidae', 'Finches':'Fringillidae',
    'Doves & Pigeons':'Columbidae', 'Thrushes':'Turdidae', 'Flycatchers':'Tyrannidae',
    'Mockingbirds & Thrashers':'Mimidae', 'Waxwings':'Bombycillidae',
    'Blackbirds & Orioles':'Icteridae', 'Chickadees & Titmice':'Paridae',
    'Warblers & Vireos':'Parulidae', 'Kingfishers':'Alcedinidae',
    'Shorebirds':'Scolopacidae', 'Swallows':'Hirundinidae',
    'Treecreepers':'Certhiidae'
  };

  /* ---- One design language per family, so a family reads as one issue.
     Families without an issue of their own use the final shared issue,
     with one approved core issue kept only as its load-failure fallback. ---- */
  var GROUP_STYLE = {
    'Hummingbirds':'geo',                 // low-poly geode
    'Crows & Jays':'mono',                // modernist black
    'Herons':'flock',                     // cyanotype
    'Gulls':'kieler',                     // cut-paper waves
    'Finches':'editorial',                // serif masthead
    'Doves & Pigeons':'minimal',          // gold rising sun
    'Thrushes':'mexico',                  // exporta seal
    'Flycatchers':'zurichpink',           // swiss rose halftone
    'Mockingbirds & Thrashers':'bundespost',
    'Blackbirds & Orioles':'dither',      // halftone museum
    'Chickadees & Titmice':'terraplana',  // screen-print grid
    'Waxwings':'nzplate',                 // full-colour gold plate
    'Owls':'opart',                       // op-art line field
    'Waterfowl':'linescreen',             // engraved plate, in the duck-stamp tradition
    'Sparrows':'field',
    'Hawks':'raptor',
    'Warblers & Vireos':'field'
  };
  function groupFor(sci) {
    var genus = String(sci || '').split(' ')[0];
    if (GENUS_GROUP[genus]) return GENUS_GROUP[genus];
    return null;
  }
  function styleFor(sci) {
    var g = groupFor(sci);
    if (g && GROUP_STYLE[g] && TPL[GROUP_STYLE[g]]) return TPL[GROUP_STYLE[g]];
    // Batch C registers the final shared issue before apt.js renders the Atlas.
    // If that asset fails, keep the species visible on the approved core geo
    // issue rather than reviving a retired template or assigning by hash.
    return TPL.ribbonbird || TPL.geo || null;
  }
  function familyOf(sci) { return groupFor(sci) || 'Other'; }
  function latinOf(sci) {
    var g = groupFor(sci);
    return (g && GROUP_LATIN[g]) || '';
  }

  /* ---- Every design is drawn at ONE natural width, because each one's
     type sizes are tuned in px at that width; re-laying a design out
     narrower just overflows its text. To normalise the album we scale the
     finished stamp instead, so a landscape issue is never wildly bigger
     than a portrait one and every design survives intact. ---- */
  var NAT_W = 188;                 // the width every template is tuned at
  var BOX_W = 188, BOX_H = 236;    // the album slot each stamp is fitted into
  var TARGET_A = 36000;            // the visual weight every stamp aims for
  function boxFor(ar) {
    var natH = NAT_W / ar;
    // Aim for equal printed AREA, so a tall issue is not visually heavier
    // than a wide one, then clamp into the album slot.
    var scale = Math.sqrt(TARGET_A / (NAT_W * natH));
    scale = Math.min(scale, BOX_W / NAT_W, BOX_H / natH, 1);
    return { w: Math.round(NAT_W * scale), h: Math.round(natH * scale), scale: scale };
  }

  function enc(s) { return encodeURIComponent(s).replace(/'/g, '%27'); }
  function stackName(s) {
    return String(s == null ? '' : s).trim().split(/\s+/).map(function (word) {
      return '<span>' + esc(word) + '</span>';
    }).join('');
  }
  function splitName(s) {
    var parts = String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: '', rest: '' };
    return {
      first: parts[0],
      rest: parts.slice(1).join(' ')
    };
  }

  function fittedType(s, ideal, floor, capacity) {
    var length = String(s == null ? '' : s).replace(/\s+/g, '').length || 1;
    return Math.max(floor, Math.min(ideal, capacity / length)).toFixed(2);
  }

  function triennaleName(s) {
    var parts = String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return '<text class="ti-name-single" x="0" y="28" textLength="100" lengthAdjust="spacingAndGlyphs">' + esc(parts[0] || '') + '</text>';
    }
    return '<text class="ti-name-first" x="0" y="16" textLength="100" lengthAdjust="spacingAndGlyphs">' + esc(parts[0]) + '</text>' +
      '<text class="ti-name-rest" x="0" y="27.5" textLength="100" lengthAdjust="spacingAndGlyphs">' + esc(parts.slice(1).join(' ')) + '</text>';
  }
  function stackPairs(s) {
    var letters = String(s == null ? '' : s).replace(/[^a-z]/gi, '').toUpperCase();
    return (letters.match(/.{1,2}/g) || []).map(function (pair) {
      return '<span>' + esc(pair) + '</span>';
    }).join('');
  }
  function stackProject(s) {
    return stackName(String(s == null ? '' : s).replace(/([a-z])([A-Z])/g, '$1 $2'));
  }
  function flycatcherName(s) {
    var words = String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.join('').length <= 15) {
      return '<span>' + esc(words.join(' ')) + '</span>';
    }
    var best = 1, bestScore = Infinity;
    for (var i = 1; i < words.length; i++) {
      var a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      var score = Math.abs(a.length - b.length) + Math.max(a.length, b.length) * .08;
      if (score < bestScore) { best = i; bestScore = score; }
    }
    return '<span>' + esc(words.slice(0, best).join(' ')) + '</span>' +
      '<span>' + esc(words.slice(best).join(' ')) + '</span>';
  }
  function stackMuseumName(s) {
    var parts = String(s == null ? '' : s).trim().split(/\s+/), lines = [];
    for (var i = 0; i < parts.length; i++) {
      var hyphen = parts[i].indexOf('-');
      if (hyphen > 0 && hyphen < parts[i].length - 1) {
        lines.push(parts[i].slice(0, hyphen + 1));
        lines.push(parts[i].slice(hyphen + 1));
      } else if (/bird$/i.test(parts[i]) && parts[i].length > 4) {
        lines.push(parts[i].slice(0, -4));
        lines.push('BIRD');
      } else lines.push(parts[i]);
    }
    return lines.map(function (line) { return '<span>' + esc(line) + '</span>'; }).join('');
  }
  function stackHalves(s) {
    var letters = String(s == null ? '' : s).replace(/[^a-z]/gi, '').toUpperCase();
    var mid = Math.ceil(letters.length / 2);
    return '<span>' + esc(letters.slice(0, mid)) + '</span>' +
           '<span>' + esc(letters.slice(mid)) + '</span>';
  }

  /* The Gull issue uses one optical type size for species, family, and issue.
     Allocate horizontal room by label weight, then let SVG textLength fit each
     label without shrinking its cap height. This keeps the postal baseline
     full and balanced for short and long species names alike. */
  function gullMetaLayout(sci, order) {
    var copyWidth = 166;
    var sciWeight = Math.max(8, String(sci == null ? '' : sci).replace(/\s+/g, '').length);
    var orderWeight = Math.max(5, String(order == null ? '' : order).replace(/\s+/g, '').length);
    var sciWidth = Math.round(copyWidth * sciWeight / (sciWeight + orderWeight));
    var orderX = sciWidth + 5;
    return { sciWidth: sciWidth, orderX: orderX, orderWidth: 171 - orderX };
  }

  /* Preserve the approved Line-Screen cap height for short labels, then
     reduce only enough to keep longer waterfowl names and three-digit issue
     numbers inside their fixed postal columns. */
  function lineScreenType(common, index) {
    var label = String(common == null ? '' : common).replace(/\s+/g, '');
    var digits = String(index == null ? '' : index).length;
    return {
      nameSize: Math.min(10.25, 72 / Math.max(1, label.length)).toFixed(2),
      indexSize: (digits > 2 ? 14.2 : 18.5).toFixed(2)
    };
  }

  function lineScreenName(common) {
    var parts = String(common == null ? '' : common).trim().split(/\s+/).filter(Boolean);
    var compact = parts.join('');
    if (parts.length < 2 || compact.length <= 9) {
      return '<svg class="ls-name ls-name-one" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label="' + esc(common) + '"><text x="0" y="16" textLength="100" lengthAdjust="spacingAndGlyphs">' + esc(common) + '</text></svg>';
    }
    var split = Math.ceil(parts.length / 2);
    return '<svg class="ls-name ls-name-two" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="' + esc(common) + '">' +
      '<text x="0" y="12" textLength="100" lengthAdjust="spacingAndGlyphs">' + esc(parts.slice(0, split).join(' ')) + '</text>' +
      '<text x="0" y="27" textLength="100" lengthAdjust="spacingAndGlyphs">' + esc(parts.slice(split).join(' ')) + '</text></svg>';
  }

  /* Review and atlas cards are assembled as HTML strings. Schedule the FX
     pass from the same API that assembles them so late insertion cannot leave
     the canvas at its browser-default 300x150 backing store. */
  var canvasPaintQueued = false;
  function scheduleCanvasPaint() {
    if (canvasPaintQueued) return;
    canvasPaintQueued = true;
    requestAnimationFrame(function () {
      canvasPaintQueued = false;
      if (window.FX && typeof window.FX.run === 'function') window.FX.run(document);
    });
  }

  /* The outline is rendered as its own alpha-only sibling so its edge filter
     never rasterises the visible stamp.  Give that sibling the exact natural
     border box up front.  Family sheets intentionally vary both padding and
     aspect ratio, so relying on an empty element's intrinsic height produces
     the offset 12px rail that used to sit behind several issues. */
  function fringeGeometry(styleId, fallbackAr) {
    var geometry = {
      geo:[.78,6,3.2,10], mono:[.76,6,3.2,10], flock:[.8,0,3.2,10],
      linescreen:[1.75,0,3.2,10], opart:[.62,6,2.65,9.5], raptor:[.69,3,1.95,7.5],
      kieler:[.78,5,3,10], sparrowGuide:[.74,4,2.45,8.4],
      'finch-editorial':[.52,0,3,10], 'dove-flight':[.78,0,3.15,10],
      thrushFlora:[1.68,5,2.8,9.4], flyRose:[.8,14,3.15,10.2],
      mimicLine:[1,4,3.4,10.5], waxBotanical:[.78,7,4.1,12],
      squaretone:[.72,0,5.25,14], triennale:[.58,6,2.7,9.2],
      ribbonbird:[1.08,0,3.05,10]
    }[styleId] || [fallbackAr,6,3.2,10];
    var ar = geometry[0], pad = geometry[1];
    return {
      ar:ar,
      pad:pad,
      height:((NAT_W - pad * 2) / ar + pad * 2).toFixed(4),
      pr:geometry[2],
      ps:geometry[3]
    };
  }

  /* Keep edge rendering separate from the stamp contents.  Filtering the
     whole issue forces Chromium to cache type and artwork as one bitmap;
     filtering this hidden silhouette gives us a real perforation-following
     stroke while all visible content remains independently rasterised. */
  function ensureFringeFilters() {
    if (!document.body || document.getElementById('stampFringeFilterDefs')) return;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'stampFringeFilterDefs';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none';
    svg.innerHTML = '<defs>' +
      '<filter id="stampFringeLight" x="-18%" y="-18%" width="136%" height="136%" color-interpolation-filters="sRGB">' +
        '<feMorphology in="SourceGraphic" operator="dilate" radius="0.38" result="expanded"/>' +
        '<feComposite in="expanded" in2="SourceAlpha" operator="out" result="ring"/>' +
        '<feComponentTransfer in="ring" result="stroke">' +
          '<feFuncR type="linear" slope="0.90"/><feFuncG type="linear" slope="0.90"/><feFuncB type="linear" slope="0.90"/><feFuncA type="linear" slope="0.42"/>' +
        '</feComponentTransfer>' +
        '<feMerge><feMergeNode in="stroke"/></feMerge>' +
      '</filter>' +
      '<filter id="stampFringeDark" x="-18%" y="-18%" width="136%" height="136%" color-interpolation-filters="sRGB">' +
        '<feMorphology in="SourceGraphic" operator="dilate" radius="0.38" result="expanded"/>' +
        '<feComposite in="expanded" in2="SourceAlpha" operator="out" result="ring"/>' +
        '<feComponentTransfer in="ring" result="stroke">' +
          '<feFuncR type="linear" slope="0.90"/><feFuncG type="linear" slope="0.90"/><feFuncB type="linear" slope="0.90"/><feFuncA type="linear" slope="0.42"/>' +
        '</feComponentTransfer>' +
        '<feMerge><feMergeNode in="stroke"/></feMerge>' +
      '</filter>' +
      '<filter id="stampFringeContrast" x="-18%" y="-18%" width="136%" height="136%" color-interpolation-filters="sRGB">' +
        '<feMorphology in="SourceGraphic" operator="dilate" radius="0.42" result="expanded"/>' +
        '<feComposite in="expanded" in2="SourceAlpha" operator="out" result="ring"/>' +
        '<feComponentTransfer in="ring" result="stroke">' +
          '<feFuncR type="linear" slope="0.84"/><feFuncG type="linear" slope="0.84"/><feFuncB type="linear" slope="0.84"/><feFuncA type="linear" slope="0.50"/>' +
        '</feComponentTransfer>' +
        '<feMerge><feMergeNode in="stroke"/></feMerge>' +
      '</filter>' +
    '</defs>';
    document.body.appendChild(svg);
  }

  /* Resolve a requested illustration pose without coupling stamp templates to
     the active bird bundle.  Live/generated cutouts use `?pose=2`, while the
     bundled review plates use a `-2` filename suffix.  Normalising an existing
     suffix also keeps repeated render passes from producing `-2-2.png`. */
  function sourceForPose(source, pose) {
    var raw = String(source || '');
    var requested = +pose || 1;
    if (!raw || requested <= 1) return raw;
    if (/\/api\/cutout\.php(?:\?|$)/i.test(raw)) {
      if (/([?&])pose=/i.test(raw)) {
        return raw.replace(/([?&]pose=)[^&#]*/i, '$1' + requested);
      }
      var hashAt = raw.indexOf('#');
      var hash = hashAt >= 0 ? raw.slice(hashAt) : '';
      var base = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
      return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'pose=' + requested + hash;
    }
    var match = raw.match(/^([^?#]*?)(?:-\d+)?(\.[a-z0-9]+)([?#].*)?$/i);
    return match ? match[1] + '-' + requested + match[2] + (match[3] || '') : raw;
  }

  /* bird: {sci, com, index, count} -> the stamp's outer HTML */
  function markup(bird, cutoutUrl, template) {
    if (!bird) return '';
    /* A saved/generated bird may explicitly carry the approved family issue.
       Prefer that over a fresh taxonomy lookup so a cached stamp and its live
       preview can never silently drift into a different design family. */
    var directTemplate = template && template.id && template.html && template.ar
      ? template : null;
    var t = directTemplate || (bird.template && TPL[bird.template]) || styleFor(bird.sci);
    if (!t) return '';
    var box = boxFor(t.ar);
    var fam = bird.family || familyOf(bird.sci), lat = bird.latin || latinOf(bird.sci);
    var commonParts = splitName(bird.com || bird.sci);
    var gullMeta = gullMetaLayout(bird.sci, lat);
    var lineType = lineScreenType(bird.com || bird.sci, bird.index);
    var commonName = bird.com || bird.sci;
    var placeholderArt = !!bird.placeholder;
    /* Optical fit, not a fixed font size.  These capacities are deliberately
       conservative: the review matrix contains the longest names we ship and
       is the contract for every future illustration bundle. */
    var geoNameSize = fittedType(commonName, 20.4, 10.15, 249);
    var monoNameSize = fittedType(commonName, 19.6, 11.2, 218);
    if (/^Yellow-billed Magpie$/i.test(commonName)) monoNameSize = fittedType(commonName, 20.65, 14.5, 260);
    var flyNameSize = fittedType(commonName, 10.25, 3.72, 136);
    var flySciSize = fittedType(bird.sci, 4.02, 2.75, 75);
    var waxRotate = /phainopepla/i.test(commonName + ' ' + bird.sci) ? 8 : 0;
    // encodeURIComponent leaves an apostrophe raw, and a species like
    // "Woodhouse's Scrub-Jay" would then close the url('...') of a CSS mask
    // early - the bird silhouette renders as a solid block. Encode it.
    /* Gulls and Columbidae are flight-composed issues.  They must always use
       the flight plate, no matter whether the source comes from the bundled
       woodblock set, another user-selected illustration pack, or the dynamic
       cutout endpoint. */
    var primarySource = !placeholderArt && fam === 'Doves & Pigeons'
      ? sourceForPose(cutoutUrl, 2)
      : String(cutoutUrl);
    var safeSrc = primarySource.replace(/'/g, '%27');
    // A missing bird uses the same egg-nest artwork in every template slot.
    // In particular, never turn nest-eggs.webp into a nonexistent pose file for
    // the family issues that normally force an in-flight plate.
    var safeSrcAlt = (placeholderArt ? primarySource : sourceForPose(primarySource, 2)).replace(/'/g, '%27');
    var safeSrcCutout = /\/illustrations\//.test(safeSrc)
      ? safeSrc.replace('/illustrations/', '/cutouts/').replace(/-2(?=\.[a-z0-9]+(?:\?.*)?$)/i, '')
      : safeSrc;
    var html = t.html
      .replace(/\{\{SRC\}\}/g, safeSrc)
      .replace(/\{\{SRC_ALT\}\}/g, safeSrcAlt)
      .replace(/\{\{SRC_CUTOUT\}\}/g, safeSrcCutout)
      .replace(/\{\{NAME\}\}/g, esc(bird.com || bird.sci))
      .replace(/\{\{NAME_FIRST\}\}/g, esc(commonParts.first))
      .replace(/\{\{NAME_REST\}\}/g, esc(commonParts.rest))
      .replace(/\{\{SCI\}\}/g, esc(bird.sci))
      .replace(/\{\{NAME_STACK\}\}/g, stackName(bird.com || bird.sci))
      .replace(/\{\{NAME_MUSEUM\}\}/g, stackMuseumName(bird.com || bird.sci))
      .replace(/\{\{FLY_NAME\}\}/g, flycatcherName(commonName))
      .replace(/\{\{SCI_STACK\}\}/g, stackName(bird.sci))
      .replace(/\{\{INDEX\}\}/g, bird.index)
      .replace(/\{\{FAMILY\}\}/g, esc(fam))
      .replace(/\{\{ORDER\}\}/g, esc(lat))
      .replace(/\{\{ORDER_PAIRS\}\}/g, stackPairs(lat))
      .replace(/\{\{ORDER_HALVES\}\}/g, stackHalves(lat))
      .replace(/\{\{GF_SCI_W\}\}/g, gullMeta.sciWidth)
      .replace(/\{\{GF_ORDER_X\}\}/g, gullMeta.orderX)
      .replace(/\{\{GF_ORDER_W\}\}/g, gullMeta.orderWidth)
      .replace(/\{\{LS_NAME_SIZE\}\}/g, lineType.nameSize)
      .replace(/\{\{LS_INDEX_SIZE\}\}/g, lineType.indexSize)
      .replace(/\{\{LS_NAME_LINES\}\}/g, lineScreenName(commonName))
      .replace(/\{\{GEO_NAME_SIZE\}\}/g, geoNameSize)
      .replace(/\{\{MONO_NAME_SIZE\}\}/g, monoNameSize)
      .replace(/\{\{WAX_ROTATE\}\}/g, waxRotate)
      .replace(/\{\{TRIENNALE_NAME\}\}/g, triennaleName(commonName))
      .replace(/\{\{PROJECT_STACK\}\}/g, stackProject('AvianVisitors'))
      .replace(/\{\{PROJECT\}\}/g, 'AvianVisitors');
    var perf = (t.perf === 'pearl' || t.perf === 'flat' || t.perf === 'saw') ? t.perf : 'scallop';
    var fringe = fringeGeometry(t.id, t.ar);
    var placeholderAttr = placeholderArt ? ' data-placeholder-art="true"' : '';
    var issue = '<div class="stamp-fit"' + placeholderAttr + ' data-family="' + esc(fam) + '" data-common="' + esc(commonName) + '" style="width:' + box.w + 'px;height:' + box.h + 'px">' +
           '<span class="stamp-fringe-outline" aria-hidden="true" data-perf="' + perf + '" data-style="' + t.id + '"' +
           ' style="--ar:' + fringe.ar + ';--w:' + NAT_W + 'px;width:' + NAT_W + 'px;height:' + fringe.height + 'px;padding:' + fringe.pad + 'px;--pr:' + fringe.pr + 'px;--ps:' + fringe.ps + 'px;--scale:' + box.scale.toFixed(4) + '"><i></i></span>' +
           '<figure class="stamp"' + placeholderAttr + ' data-perf="' + perf + '" data-style="' + t.id + '" data-family="' + esc(fam) + '" data-common="' + esc(commonName) + '"' +
           ' style="--ar:' + t.ar + ';--w:' + NAT_W + 'px;width:' + NAT_W + 'px;--scale:' + box.scale.toFixed(4) +
           ';--geo-name-size:' + geoNameSize + 'px;--mono-name-size:' + monoNameSize + 'px;--fly-name-size:' + flyNameSize + 'px;--fly-sci-size:' + flySciSize + 'px;--wax-rotate:' + waxRotate + 'deg">' +
           html + '</figure></div>';
    scheduleCanvasPaint();
    return issue;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.STAMPS = {
    markup: markup, styleFor: styleFor, familyOf: familyOf, latinOf: latinOf,
    boxFor: boxFor, BOX_W: BOX_W, BOX_H: BOX_H, NAT_W: NAT_W, TPL: TPL,
    GROUP_STYLE: GROUP_STYLE, GROUP_LATIN: GROUP_LATIN,
    syncFringe: function (root) {
      ensureFringeFilters();
      if (window.FX && typeof window.FX.syncFringe === 'function') {
        window.FX.syncFringe(root || document);
      }
    }
  };
})();

/* ============================================================
   Sticking a stamp down.

   A single rotateX of the whole rectangle reads as a card being flipped,
   not as paper being applied, because a flat element has no contact line:
   every point of it shares one plane, so nothing ever touches down. On a
   real stamp the part already in contact lies flat while the rest is
   still standing, and the boundary between them travels across the sheet.

   So the stamp is rebuilt as a chain of horizontal strips, each one a
   CHILD of the strip above it, so their rotations compound into a
   polyline that approximates a curve. Curvature is concentrated at the
   contact line and relaxes away from it - the shape a held sheet
   actually takes - and one perspective on the parent gives true
   foreshortening, so the near edge widens and the silhouette bows.

   Each strip is then tinted by its own accumulated tilt (a surface
   catching a key light, not a highlight sliding over a flat plane), with
   a short exponential darkening just past the contact line for the
   crease, and the cast shadow tightens from tall and soft to a hairline
   as the sheet meets the page.
   ============================================================ */
(function () {
  'use strict';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var KEY = 26 * Math.PI / 180;              // key light, off the page normal
  var FLAT_LUM = Math.cos(KEY);
  function lumAt(th) { return Math.cos(th - KEY) / FLAT_LUM; }   // 1.0 when flat
  function tint(l) {
    return l >= 1
      ? 'rgba(255,252,244,' + Math.min(0.5, (l - 1) * 0.85).toFixed(3) + ')'
      : 'rgba(38,26,14,' + Math.min(0.62, (1 - l) * 0.62).toFixed(3) + ')';
  }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  /* The contact line is a physical traverse across the sheet, not a UI state
     change: it wants to ease in and out but spend real time in the middle.
     An ease-out alone puts it at 66% of the way down by the first third of
     the duration, so the curl is over before the eye finds it. */
  function smoothstep(t) { return t * t * (3 - 2 * t); }

  /* Canvas pixels are not copied by cloneNode, so bake each one to an
     image the strip clones can all share. */
  function flattenCanvases(src, clone) {
    var a = src.querySelectorAll('canvas'), b = clone.querySelectorAll('canvas'), i;
    for (i = 0; i < b.length && i < a.length; i++) {
      var url;
      try { url = a[i].toDataURL('image/png'); } catch (e) { continue; }
      var img = document.createElement('img');
      img.src = url;
      img.className = b[i].className;
      img.setAttribute('style', b[i].getAttribute('style') || '');
      img.style.objectFit = 'fill';
      b[i].parentNode.replaceChild(img, b[i]);
    }
  }

  function roll(stamp, opts) {
    opts = opts || {};
    if (REDUCED) { stamp.style.visibility = ''; return Promise.resolve(); }

    var slot = stamp.parentElement;
    var H = Math.max(1, stamp.offsetHeight);
    var W = stamp.offsetWidth;
    var scale = parseFloat(getComputedStyle(stamp).getPropertyValue('--scale')) || 1;
    var tiltEnd = opts.tilt || 0;
    var dur = opts.duration || 1000;
    var step = opts.step || 11;                 // strip height, unscaled px
    var lambda = opts.lambda || 46;             // how fast the bend relaxes
    var liftDeg = opts.lift || 30;   // a sheet being pressed down barely stands up
    var POP = opts.pop != null ? opts.pop : 0.16;   // how much bigger it arrives

    var rig = document.createElement('div');
    rig.className = 'roll-rig';
    rig.style.width = W + 'px';
    rig.style.height = H + 'px';

    // Built from the BOTTOM up: strip 0 is the part already pressed to the
    // wall along the bottom edge, and every strip above it is a child of the
    // one below, hinged on their shared edge, so the rotations compound into
    // a curl that stands the top of the stamp off the page.
    var segs = [], host = rig, n = Math.ceil(H / step) + 1, i;
    for (i = 0; i < n; i++) {
      var seg = document.createElement('div');
      seg.className = 'roll-seg';
      var flat = document.createElement('div');
      flat.className = 'roll-flat';
      var clip = document.createElement('div');
      clip.className = 'roll-clip';
      var copy = stamp.cloneNode(true);
      copy.classList.add('roll-copy');
      copy.style.transform = 'none';
      copy.style.position = 'absolute';
      copy.style.left = '0';
      copy.style.width = W + 'px';
      copy.style.height = H + 'px';
      flattenCanvases(stamp, copy);
      clip.appendChild(copy);
      flat.appendChild(clip);
      var tn = document.createElement('div');
      tn.className = 'roll-tint';
      seg.appendChild(flat); seg.appendChild(tn);
      host.appendChild(seg);
      segs.push({ el: seg, clip: clip, copy: copy, tint: tn });
      host = seg;
    }

    // The cast shadow is its own plate under the sheet rather than a
    // drop-shadow on the rig: filtering a 3D-transformed subtree makes the
    // browser rasterise the whole thing and the result smears into a slab.
    var shade = document.createElement('div');
    shade.className = 'roll-shade';
    shade.style.width = W + 'px';
    shade.style.height = H + 'px';
    slot.appendChild(shade);
    slot.appendChild(rig);
    stamp.style.visibility = 'hidden';

    function finish() {
      if (shade.parentNode) shade.remove();
      if (!rig.parentNode) return;
      rig.remove();
      stamp.style.visibility = '';
    }

    function draw(p) {
        // The sticker arrives bigger than it lands - the pop - and shrinks
        // onto the wall. The contact line starts a beat later so the two
        // read as separate events: it lands, then it is pressed down.
        var pop = 1 - easeOutCubic(Math.min(1, p / 0.52));          // 1 -> 0
        var CONTACT_AT = 0.16;
        var cp = Math.max(0, (p - CONTACT_AT) / (1 - CONTACT_AT));
        var e = smoothstep(cp);

        var f = e * H;                    // stuck height, measured UP from the bottom
        var free = H - f;                 // what is still standing

        var relax = Math.max(0, (cp - 0.74) / 0.26);
        var theta = liftDeg * Math.PI / 180 * (1 - easeOutCubic(Math.min(1, relax)));
        var liftK = Math.max(Math.min(1, free / 80), pop);

        var sc = scale * (1 + POP * pop);
        rig.style.transform = 'translate(-50%,-50%) scale(' + sc.toFixed(4) +
          ') rotate(' + (tiltEnd * e).toFixed(2) + 'deg)';
        // shadow grows and softens with height off the wall, and tightens to
        // a hairline as the sheet seats
        shade.style.opacity = (0.05 + 0.16 * liftK).toFixed(3);
        shade.style.filter = 'blur(' + (2 + 12 * liftK).toFixed(1) + 'px)';
        shade.style.transform = 'translate(-50%,-50%) translateY(' +
          (3 + 11 * liftK).toFixed(1) + 'px) scale(' +
          (sc * (0.94 + 0.05 * liftK)).toFixed(4) + ')';

        var u = 0, cum = 0, prev = 0;
        for (var k = 0; k < segs.length; k++) {
          var s = segs[k], h, dTheta;
          if (k === 0) { h = f; dTheta = 0; }
          else {
            h = Math.max(0, Math.min(step, H - u));
            var cumEnd = theta * (1 - Math.exp(-(u - f + h) / lambda));
            dTheta = cumEnd - prev; prev = cumEnd;
          }
          cum += dTheta;
          s.el.style.height = (h + ((k && h > 0.01) ? 1 : 0)) + 'px';
          // strip 0 sits on the bottom edge; each one after stacks above it
          if (k === 0) { s.el.style.bottom = '0px'; s.el.style.top = 'auto'; }
          else { s.el.style.bottom = '100%'; s.el.style.top = 'auto'; }
          // hinge on the shared lower edge, and tilt the free (upper) edge
          // toward the viewer so the stamp curls off the wall
          s.el.style.transformOrigin = '50% 100%';
          s.el.style.transform = 'rotateX(' + (-dTheta * 180 / Math.PI).toFixed(3) + 'deg)';
          // Show the band of the stamp this strip covers, counting up from the
          // bottom. The clone root's mask, background and filter are disabled
          // in CSS because WebKit composites that full sheet before this clip
          // inside a preserve-3d chain; only the printed face belongs here.
          s.copy.style.top = (-(H - u - h)) + 'px';
          u += h;

          var ao0 = k ? Math.exp(-(u - h - f) / 9) * 0.30 * liftK : 0;
          var ao1 = k ? Math.exp(-(u - f) / 9) * 0.30 * liftK : 0;
          s.tint.style.background = 'linear-gradient(to top,' +
            tint(lumAt(cum - dTheta) - ao0) + ',' + tint(lumAt(cum) - ao1) + ')';
        }
    }

    if (opts.freeze != null) { draw(opts.freeze); return Promise.resolve(); }

    return new Promise(function (done) {
      var t0 = null, settled = false;
      function settle() {
        if (settled) return; settled = true;
        finish();
        stamp.animate([{ transform: 'translate(-50%,-50%) scale(' + (scale * 1.012) + ') rotate(' + tiltEnd + 'deg)' },
                       { transform: '' }],
                      { duration: 150, easing: 'cubic-bezier(.22,1,.36,1)' });
        done();
      }
      var guard = setTimeout(settle, dur + 2500);
      function frame(ts) {
        if (settled) return;
        if (t0 === null) t0 = ts;
        var p = Math.min(1, (ts - t0) / dur);
        draw(p);
        if (p < 1) { requestAnimationFrame(frame); return; }
        clearTimeout(guard);
        settle();
      }
      requestAnimationFrame(frame);
    });
  }

  /* Stick a run of stamps down one at a time, oldest arrival first. */
  function stickSequence(stamps, opts) {
    opts = opts || {};
    var gap = opts.stagger || 185;
    var i = 0;
    stamps.forEach(function (el) { el.style.visibility = 'hidden'; });
    (function next() {
      if (i >= stamps.length) { if (opts.done) opts.done(); return; }
      var el = stamps[i++];
      var jitter = (Math.random() * 80 - 40);
      // land on the angle the stamp actually rests at, or it snaps on finish
      var rest = parseFloat(getComputedStyle(el).getPropertyValue('--tilt')) || 0;
      roll(el, { tilt: rest, duration: 950 + Math.random() * 90 });
      setTimeout(next, Math.max(90, gap + jitter));
    })();
  }

  window.STAMPS.roll = roll;
  window.STAMPS.stickSequence = stickSequence;
})();

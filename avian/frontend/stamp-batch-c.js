/* Batch C: dedicated issues for Blackbirds, Chickadees and Warblers.
   Loaded after stamps.js: the public template tables are intentionally
   mutable so an issue can be art-directed without touching the renderer. */
(function () {
  'use strict';

  var S = window.STAMPS;
  if (!S) return;

  /* Batch C markup and CSS are one release unit. If the stylesheet is
     missing or an older cached copy is still active, do not register markup
     that the core stamp sheet cannot style. Unknown families then remain on
     the complete geo issue supplied by stamps.js. The readiness marker is
     the final rule in stamp-batch-c.css so a partial response cannot opt in. */
  var batchCssReady = false;
  try {
    batchCssReady = window.getComputedStyle(document.documentElement)
      .getPropertyValue('--avian-stamp-batch-c-ready').trim() === '1';
  } catch (e) { }
  if (!batchCssReady) {
    document.documentElement.setAttribute('data-stamp-batch-c', 'css-missing');
    return;
  }
  document.documentElement.setAttribute('data-stamp-batch-c', 'ready');

  /* The Triennale plate is generated from the real species cutout, not from
     a generic bird icon. A broad blur turns local plumage into three smooth
     ink regions; the original pixels are then brought back only for the eye,
     bill and silhouette edge. The lightest region is a paper knockout with a
     single diagonal screen, echoing the striped white vessel in the 1951
     issue without making the bird look photographic or pixelated. */
  if (window.FX && window.FX.T) {
    window.FX.T.triennaleAbstract = function (cx, W, H, im, opt) {
      opt = opt || {};
      var ink = opt.ink || '#171a18';
      var mid = opt.mid || '#60645f';
      var paper = opt.paper || '#e7e0cf';
      var pad = Math.max(0, opt.pad == null ? 0.025 : opt.pad);
      var source = document.createElement('canvas');
      source.width = W; source.height = H;
      var sx = source.getContext('2d', { willReadFrequently: true });
      var aw = W * (1 - pad * 2), ah = H * (1 - pad * 2);
      var scale = Math.min(aw / im.width, ah / im.height) * (opt.scale || 1);
      var dw = im.width * scale, dh = im.height * scale;
      sx.imageSmoothingEnabled = true;
      sx.imageSmoothingQuality = 'high';
      sx.save();
      sx.translate(W / 2 + (opt.offsetX || 0) * W, H / 2 + (opt.offsetY || 0) * H);
      sx.rotate((opt.rotate || 0) * Math.PI / 180);
      sx.drawImage(im, -dw / 2, -dh / 2, dw, dh);
      sx.restore();

      var soft = document.createElement('canvas');
      soft.width = W; soft.height = H;
      var bx = soft.getContext('2d', { willReadFrequently: true });
      bx.filter = 'blur(' + Math.max(2, Math.round(Math.min(W, H) * 0.017)) + 'px)';
      bx.drawImage(source, 0, 0);
      bx.filter = 'none';

      var raw = sx.getImageData(0, 0, W, H).data;
      var blurred = bx.getImageData(0, 0, W, H).data;
      var values = [];
      for (var i = 0; i < raw.length; i += 4) {
        if (raw[i + 3] > 42) {
          values.push(0.299 * blurred[i] + 0.587 * blurred[i + 1] + 0.114 * blurred[i + 2]);
        }
      }
      values.sort(function (a, b) { return a - b; });
      function quantile(q, fallback) {
        return values.length ? values[Math.min(values.length - 1, Math.floor(values.length * q))] : fallback;
      }
      var darkCut = quantile(0.34, 102);
      var lightCut = quantile(0.69, 172);
      var out = cx.createImageData(W, H);
      var data = out.data;
      function rgb(hex) {
        hex = hex.replace('#', '');
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
      }
      var ci = rgb(ink), cm = rgb(mid), cp = rgb(paper);
      var pitch = Math.max(8, Math.round(Math.min(W, H) * 0.019));
      var stripe = Math.max(1, Math.round(pitch * 0.22));
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var p = (y * W + x) * 4;
          var a = raw[p + 3];
          if (a < 36) continue;
          var l = 0.299 * blurred[p] + 0.587 * blurred[p + 1] + 0.114 * blurred[p + 2];
          var detail = 0.299 * raw[p] + 0.587 * raw[p + 1] + 0.114 * raw[p + 2];
          var col;
          if (detail < 52 || l <= darkCut) col = ci;
          else if (l < lightCut) col = cm;
          else col = (((x + y * 2) % pitch) < stripe) ? ci : cp;
          data[p] = col[0]; data[p + 1] = col[1]; data[p + 2] = col[2]; data[p + 3] = a;
        }
      }
      cx.clearRect(0, 0, W, H);
      cx.putImageData(out, 0, 0);
    };
  }

  /* Warblers use a circular two-ink screen rather than the Triennale stripe
     split. The source bundle still supplies the silhouette and tonal values;
     only the print interpretation changes. The solid underprint keeps the
     species readable at small sizes while the dots retain plumage identity. */
  if (window.FX && window.FX.T) {
    window.FX.T.dotDuotone = function (cx, W, H, im, opt) {
      opt = opt || {};
      var src = document.createElement('canvas'); src.width = W; src.height = H;
      var sx = src.getContext('2d', {willReadFrequently:true});
      var pad = (opt.pad == null ? .05 : opt.pad);
      var scale = Math.min(W * (1 - pad * 2) / im.width, H * (1 - pad * 2) / im.height) * (opt.scale || 1);
      var dw = im.width * scale, dh = im.height * scale;
      sx.save(); sx.translate(W/2 + (opt.offsetX||0)*W,H/2 + (opt.offsetY||0)*H); sx.rotate((opt.rotate||0)*Math.PI/180);
      sx.drawImage(im,-dw/2,-dh/2,dw,dh); sx.restore();
      var d = sx.getImageData(0,0,W,H).data;
      cx.clearRect(0,0,W,H);
      cx.save(); cx.globalCompositeOperation='source-over'; cx.globalAlpha=1; cx.fillStyle=opt.mid||'#5d625f';
      if (opt.solid) {
        var mask = sx.getImageData(0,0,W,H);
        for (var mi=3; mi<mask.data.length; mi+=4) {
          var ma=mask.data[mi];
          mask.data[mi] = ma < 24 ? 0 : (ma < 104 ? Math.min(255,(ma-24)*3.2) : 255);
        }
        sx.putImageData(mask,0,0);
      }
      cx.drawImage(src,0,0); cx.globalCompositeOperation='source-in'; cx.fillRect(0,0,W,H); cx.restore();
      var pitch = Math.max(3, Math.round(opt.pitch || Math.min(W,H)*.018));
      cx.fillStyle=opt.ink||'#3d423f';
      for(var y=pitch/2,row=0;y<H;y+=pitch,row++) for(var x=pitch/2+(row%2)*pitch/2;x<W;x+=pitch){
        var ix=Math.max(0,Math.min(W-1,x|0)), iy=Math.max(0,Math.min(H-1,y|0)), p=(iy*W+ix)*4;
        if(d[p+3]<38) continue;
        var lum=(.299*d[p]+.587*d[p+1]+.114*d[p+2])/255;
        var r=pitch*(.07+(1-lum)*.18);
        cx.beginPath(); cx.arc(x,y,r,0,Math.PI*2); cx.fill();
      }
    };
  }

  /* A square, ordered screen rather than the circular newspaper halftone.
     The source alpha determines the outline; a Bayer threshold converts the
     plumage beneath every cell into the different-size printed squares. */
  if (window.FX && window.FX.T) {
    window.FX.T.squareDither = function (cx, W, H, im, opt) {
      opt = opt || {};
      var cells = Math.max(18, opt.cells || 31);
      var sample = document.createElement('canvas');
      sample.width = cells;
      sample.height = cells;
      var sx = sample.getContext('2d', { willReadFrequently: true });
      var pad = Math.max(0, opt.pad == null ? 0.035 : opt.pad) * cells;
      var bleedRightBottom = !!opt.bleedRightBottom;
      sx.imageSmoothingEnabled = true;
      sx.imageSmoothingQuality = 'high';
      if (opt.upperBody) {
        /* The museum issue uses a portrait crop rather than a tiny full-body
           cutout. A square source window keeps the bird undistorted while the
           head, eye and shoulder occupy enough cells to read at stamp size. */
        /* Locate the actual transparent cutout first.  Source bundles use
           different canvas margins, so cropping image coordinates directly
           makes otherwise identical family issues jump around. */
        var scan = document.createElement('canvas');
        scan.width = im.width; scan.height = im.height;
        var scx = scan.getContext('2d', { willReadFrequently: true });
        scx.drawImage(im, 0, 0);
        var scanData = scx.getImageData(0, 0, im.width, im.height).data;
        var minX = im.width, minY = im.height, maxX = 0, maxY = 0;
        for (var ay = 0; ay < im.height; ay += 2) {
          for (var ax = 0; ax < im.width; ax += 2) {
            if (scanData[(ay * im.width + ax) * 4 + 3] > 28) {
              if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
              if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
            }
          }
        }
        if (minX > maxX) { minX = 0; minY = 0; maxX = im.width; maxY = im.height; }
        var bw = maxX - minX, bh = maxY - minY;
        var cropScale = Math.max(0.5, Math.min(1, opt.cropScale == null ? 0.78 : opt.cropScale));
        var cropSize = Math.max(bw, bh * .68) * cropScale;
        var focusX = opt.focusX == null ? .5 : opt.focusX;
        var requestedCropX = opt.cropX == null
          ? minX + bw * focusX - cropSize * .5
          : opt.cropX * im.width;
        var requestedCropY = opt.cropY == null ? minY : opt.cropY * im.height;
        var cropX = Math.max(0, Math.min(im.width - cropSize, requestedCropX));
        var cropY = Math.max(0, Math.min(im.height - cropSize, requestedCropY));
        sx.drawImage(im, cropX, cropY, cropSize, cropSize,
          pad + (opt.offsetX || 0) * cells, pad + (opt.offsetY || 0) * cells,
          bleedRightBottom ? cells + pad * 0.35 : cells - pad * 2,
          bleedRightBottom ? cells + pad * 0.35 : cells - pad * 2);
      } else {
        var scale = Math.min((cells - pad * 2) / im.width, (cells - pad * 2) / im.height);
        var dw = im.width * scale;
        var dh = im.height * scale;
        sx.drawImage(im, (cells - dw) / 2, (cells - dh) / 2, dw, dh);
      }
      var pixels = sx.getImageData(0, 0, cells, cells).data;
      var alphaMap = new Float32Array(cells * cells);
      var lightMap = new Float32Array(cells * cells);
      for (var pi = 0; pi < cells * cells; pi++) {
        alphaMap[pi] = pixels[pi * 4 + 3] / 255;
        lightMap[pi] = (0.299 * pixels[pi * 4] + 0.587 * pixels[pi * 4 + 1] +
          0.114 * pixels[pi * 4 + 2]) / 255;
      }
      var bayer = [
        0, 8, 2, 10,
        12, 4, 14, 6,
        3, 11, 1, 9,
        15, 7, 13, 5
      ];
      var paper = opt.paper || '#efefeb';
      var cw = W / cells;
      var ch = H / cells;
      cx.clearRect(0, 0, W, H);
      cx.fillStyle = '#121313';
      cx.fillRect(0, 0, W, H);
      for (var y = 0; y < cells; y++) {
        for (var x = 0; x < cells; x++) {
          var i = (y * cells + x) * 4;
          var mapIndex = y * cells + x;
          var alpha = alphaMap[mapIndex];
          if (alpha < 0.08) continue;
          var light = lightMap[mapIndex];
          var silhouetteEdge = false;
          var detailEdge = 0;
          var neighbours = [[-1,0],[1,0],[0,-1],[0,1]];
          for (var ni = 0; ni < neighbours.length; ni++) {
            var nx = x + neighbours[ni][0];
            var ny = y + neighbours[ni][1];
            if (nx < 0 || nx >= cells || ny < 0 || ny >= cells) {
              silhouetteEdge = true;
              continue;
            }
            var neighbourIndex = ny * cells + nx;
            if (alphaMap[neighbourIndex] < 0.08) silhouetteEdge = true;
            else detailEdge = Math.max(detailEdge, Math.abs(light - lightMap[neighbourIndex]));
          }
          /* A crisp alpha contour defines the portrait while local luminance
             changes retain the eye, bill and shoulder inside it. The body is
             not flooded solid, so it remains a portrait rather than a blob. */
          var exposure = silhouetteEdge ? 1 : Math.min(0.94,
            0.42 + light * 0.45 + detailEdge * 1.18 + alpha * 0.035);
          var threshold = (bayer[(y % 4) * 4 + (x % 4)] + 0.5) / 16;
          var on = exposure > threshold;
          var size = silhouetteEdge ? 0.95 : (on ? (threshold < exposure - 0.3 ? 0.88 : 0.67) : 0.34);
          var ox = (x + (1 - size) / 2) * cw;
          var oy = (y + (1 - size) / 2) * ch;
          if (on) {
            cx.globalAlpha = 1;
            cx.fillStyle = paper;
            cx.fillRect(ox, oy, Math.max(0.7, cw * size), Math.max(0.7, ch * size));
          }
        }
      }
      cx.globalAlpha = 1;
    };
  }

  S.TPL.squaretone = {
    id: 'squaretone',
    title: 'Square-Screen Museum',
    ar: 0.72,
    perf: 'scallop',
    html:
      '<div class="face tpl-squaretone" style="--face:#efefeb">' +
        '<div class="sq-meta"><span>{{SCI}}</span><span>{{ORDER}}</span><span>AVIANVISITORS</span></div>' +
        '<h3 class="sq-name">{{NAME_MUSEUM}}</h3>' +
        '<div class="sq-value">{{INDEX}}</div>' +
        '<div class="sq-panel">' +
          '<canvas class="fxc sq-bird" data-fx="squareDither" data-src="{{SRC}}" data-opt=\'{"cells":72,"pad":0.04,"upperBody":true,"bleedRightBottom":true,"cropScale":1,"focusX":0.5,"offsetX":0,"paper":"#efefeb"}\'></canvas>' +
        '</div>' +
        '<div class="sq-texture" aria-hidden="true"></div>' +
      '</div>'
  };

  S.TPL.triennale = {
    id: 'triennale',
    title: 'Triennale Abstract Birds',
    ar: 0.58,
    perf: 'scallop',
    html:
      '<div class="face tpl-triennale" style="--face:#aeb7aa">' +
        '<header class="ti-head">' +
          '<svg class="ti-binomial" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label="{{SCI}}"><text x="0" y="11.7" textLength="100" lengthAdjust="spacingAndGlyphs">{{SCI}}</text></svg>' +
          '<span>{{ORDER}}</span>' +
        '</header>' +
        '<div class="ti-gallery"><canvas class="fxc ti-bird" data-fx="triennaleAbstract" data-src="{{SRC}}" data-opt=\'{"pad":0.03,"scale":1.02,"rotate":5,"offsetX":0.006,"offsetY":0.02,"ink":"#171a18","mid":"#60645f","paper":"#e7e0cf"}\' aria-label="Abstract print of {{NAME}}"></canvas></div>' +
        '<footer class="ti-foot">' +
          '<svg class="ti-name" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label="{{NAME}}">{{TRIENNALE_NAME}}</svg>' +
          '<svg class="ti-denom" viewBox="0 0 100 45" preserveAspectRatio="none" role="img" aria-label="Issue {{INDEX}}, AvianVisitors"><text class="ti-index" x="0" y="27" textLength="100" lengthAdjust="spacingAndGlyphs">{{INDEX}}</text><text class="ti-brand" x="0" y="40" textLength="100" lengthAdjust="spacingAndGlyphs">AVIANVISITORS</text></svg>' +
        '</footer>' +
        '<div class="ti-texture" aria-hidden="true"></div>' +
      '</div>'
  };

  S.TPL.ribbonbird = {
    id: 'ribbonbird',
    title: 'Rainbow Conservation Issue',
    ar: 1.08,
    perf: 'scallop',
    html:
      '<div class="face tpl-ribbonbird" style="--face:#eeeae0">' +
        '<div class="wv-head">' +
          '<h3>{{NAME_STACK}}</h3>' +
          '<span class="wv-family">{{SCI}}</span>' +
          '<b class="wv-value">{{INDEX}}</b>' +
        '</div>' +
        '<div class="wv-stage">' +
          '<svg class="wv-ribbon wv-ribbon-back" viewBox="0 0 188 150" preserveAspectRatio="none" aria-hidden="true">' +
            '<path class="wv-r wv-r1" d="M-12 73 C32 80 46 28 96 35 C139 41 132 91 201 68"/>' +
            '<path class="wv-r wv-r2" d="M-12 79 C34 86 48 34 97 41 C138 47 134 97 201 74"/>' +
            '<path class="wv-r wv-r3" d="M-12 85 C35 92 50 40 98 47 C137 53 136 103 201 80"/>' +
            '<path class="wv-r wv-r4" d="M-12 91 C36 98 52 46 99 53 C136 59 138 109 201 86"/>' +
          '</svg>' +
          '<canvas class="fxc wv-bird-print" data-fx="dotDuotone" data-src="{{SRC}}" data-opt=\'{"pad":0.04,"scale":0.94,"rotate":2,"offsetX":0,"offsetY":0.01,"ink":"#adb0a6","mid":"#c6c6bd","paper":"#ded9ce","pitch":4.05,"solid":true}\' aria-label="Dot-screen print of {{NAME}}"></canvas>' +
        '</div>' +
        '<div class="wv-foot"><span>{{PROJECT}}</span><i>{{ORDER}}</i></div>' +
        '<div class="wv-texture" aria-hidden="true"></div>' +
      '</div>'
  };

  S.GROUP_STYLE['Blackbirds & Orioles'] = 'squaretone';
  S.GROUP_STYLE['Chickadees & Titmice'] = 'triennale';
  S.GROUP_STYLE['Warblers & Vireos'] = 'ribbonbird';
})();

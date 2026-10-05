(function () {
  'use strict';
  var S = window.STAMPS;
  if (!S) return;

  S.TPL.raptor = {
    id: 'raptor',
    title: 'Raptor Ink Issue',
    ar: 0.69,
    perf: 'pearl',
    html: '<div class="face tpl-hawkink" style="--face:#e8dec7">' +
      '<div class="hi-field">' +
        '<canvas class="fxc hi-bird" data-fx="inkStamp" data-src="{{SRC}}" data-paper="./assets/stamp/paper-texture-grey.png" data-opt=\'{"fit":"bird","pad":0.008,"scale":1.075,"offsetX":0.025,"offsetY":0.025,"ink":"#18221d","lift":0.105,"contrast":1.24}\' aria-label="{{NAME}}"></canvas>' +
        '<div class="hi-field-copy"><b>{{ORDER}}</b><span>{{SCI}}</span></div>' +
        '<strong class="hi-imprint">AVIANVISITORS</strong>' +
      '</div>' +
      '<aside class="hi-rail">' +
        '<strong class="hi-name">{{NAME}}</strong>' +
      '</aside>' +
      '<b class="hi-number">{{INDEX}}</b>' +
    '</div>'
  };

  function sparrowGuide(id, title, screen) {
    var base = {
      ink:'#e3d6b7', shadow:'#686a51', gamma:0.91, contrast:1.04,
      fit:'bird', pad:0.002, scale:1.02, screen:true,
      screenPeriod:6.2, screenStrength:0.54, screenGhost:0.08,
      screenJitter:0.01, screenSoftness:0.42,
      screenAngleA:18, screenAngleB:24.5, screenAspect:1
    };
    var flowerOpt = Object.assign({}, base, screen || {});
    var birdOpt = Object.assign({}, flowerOpt, {
      gamma:0.86, contrast:1.08, lowCut:0.018, highCut:0.985,
      pad:0.018, scale:1.025, offsetY:-0.004, rotate:-8
    });
    return {
      id: id,
      title: title,
      ar: 0.74,
      perf: 'pearl',
      html: '<div class="face tpl-sparrowguide" style="--face:#e3d6b7">' +
      '<div class="sg-field">' +
        '<canvas class="fxc sg-blossom sg-blossom-a" data-fx="duotoneCutout" data-src="./avian/assets/references/sparrow-blossom-single-v2.png" data-opt=\'' + JSON.stringify(flowerOpt) + '\' aria-hidden="true"></canvas>' +
        '<canvas class="fxc sg-blossom sg-blossom-b" data-fx="duotoneCutout" data-src="./avian/assets/references/sparrow-blossom-pair-v2.png" data-opt=\'' + JSON.stringify(flowerOpt) + '\' aria-hidden="true"></canvas>' +
        '<canvas class="fxc sg-bird" data-fx="duotoneCutout" data-src="{{SRC}}" data-opt=\'' + JSON.stringify(birdOpt) + '\' aria-label="{{NAME}}"></canvas>' +
        '<span class="sg-side sg-project">AVIANVISITORS</span>' +
        '<span class="sg-side sg-species">{{NAME}}</span>' +
        '<b class="sg-number">{{INDEX}}</b>' +
        '<footer class="sg-footer"><em>{{SCI}}</em><strong>{{ORDER}}</strong></footer>' +
      '</div>' +
      '</div>'
    };
  }

  /* The production issue uses proof C's crisp rosette separation. The review
     page keeps the alternate separations below at identical scale so the
     print behaviour remains easy to compare without changing composition. */
  S.TPL.sparrowGuide = sparrowGuide('sparrowGuide', 'C · Crisp rosette', {
    screenPeriod:7.6, screenStrength:0.78, screenGhost:0.22,
    screenJitter:0.008, screenSoftness:0.35,
    screenAngleA:15, screenAngleB:22.5
  });
  S.TPL.sparrowFine = sparrowGuide('sparrowFine', 'A · Fine AM screen', {
    screenPeriod:4.6, screenStrength:0.72, screenGhost:0,
    screenJitter:0, screenSoftness:0.35
  });
  S.TPL.sparrowRosette = sparrowGuide('sparrowRosette', 'C · Crisp rosette', {
    screenPeriod:7.6, screenStrength:0.78, screenGhost:0.22,
    screenJitter:0.008, screenSoftness:0.35,
    screenAngleA:15, screenAngleB:22.5
  });
  S.TPL.sparrowDirectional = sparrowGuide('sparrowDirectional', 'D · Directional screen', {
    screenPeriod:5.8, screenStrength:0.82, screenGhost:0,
    screenJitter:0, screenSoftness:0.35,
    screenAngleA:-18, screenAngleB:-12, screenAspect:2.35
  });
  /* Proofing is complete: the family review returns to one production stamp. */
  S.SPARROW_REVIEW = null;

  S.TPL.kieler = {
    id: 'kieler',
    title: 'Kieler Flight Issue',
    ar: 0.78,
    perf: 'pearl',
    html: '<div class="face tpl-gullflight" style="--face:#f4f7f8">' +
      '<div class="gf-field">' +
        '<svg class="gf-waves" viewBox="0 0 188 210" preserveAspectRatio="none" aria-hidden="true">' +
          '<path d="M-8 26C14 7 29 8 48 27S79 45 98 25s36-18 55 0 31 17 44 2v27c-17 15-31 15-47-1s-31-17-49 1-34 18-51 0S18 38-8 59Z"/>' +
          '<path d="M-8 78c23-18 39-18 58 1s33 18 51-1 34-18 52 1 31 18 44 3v27c-18 15-32 14-48-2s-31-16-48 1-34 17-51 0S18 94-8 113Z"/>' +
          '<path d="M-8 145c22-15 39-14 56 2s34 17 52-1 34-17 51 0 31 17 46 4v60H-8Z"/>' +
        '</svg>' +
        '<span class="gf-shadow" style="--src:url(\'{{SRC_ALT}}\')"></span>' +
        '<img class="gf-bird" src="{{SRC_ALT}}" alt="{{NAME}}">' +
        '<svg class="gf-seal" viewBox="0 0 100 100" aria-label="Avian Visitors registration seal">' +
          '<defs><path id="gf-seal-{{INDEX}}" d="M50 50m-28 0a28 28 0 1 1 56 0a28 28 0 1 1-56 0"/></defs>' +
          '<circle class="gf-seal-dot" cx="50" cy="50" r="38"/>' +
          '<text class="gf-seal-ring" textLength="172" lengthAdjust="spacing"><textPath href="#gf-seal-{{INDEX}}" startOffset="50%" text-anchor="middle">AVIAN · VISITORS · AVIAN · VISITORS ·</textPath></text>' +
          '<text class="gf-seal-number" x="50" y="61" text-anchor="middle" transform="rotate(7 50 50)">{{INDEX}}</text>' +
        '</svg>' +
      '</div>' +
      '<div class="gf-caption">' +
        '<svg class="gf-title" viewBox="0 0 171 25" preserveAspectRatio="none" aria-label="{{NAME}}"><text x="0" y="23" textLength="171" lengthAdjust="spacingAndGlyphs">{{NAME}}</text></svg>' +
        '<svg class="gf-meta" viewBox="0 0 171 15" preserveAspectRatio="none" aria-label="{{SCI}}, {{ORDER}}">' +
          '<text class="gf-sci" x="0" y="13" textLength="{{GF_SCI_W}}" lengthAdjust="spacingAndGlyphs">{{SCI}}</text>' +
          '<text class="gf-family" x="{{GF_ORDER_X}}" y="13" textLength="{{GF_ORDER_W}}" lengthAdjust="spacingAndGlyphs">{{ORDER}}</text>' +
        '</svg>' +
      '</div>' +
    '</div>'
  };

  S.GROUP_STYLE.Hawks = 'raptor';
  S.GROUP_STYLE.Gulls = 'kieler';
  S.GROUP_STYLE.Sparrows = 'sparrowGuide';
})();

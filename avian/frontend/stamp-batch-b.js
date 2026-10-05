/* Batch B family issues: loaded after stamps.js.  These templates deliberately
   live outside the core stamp system so each family can be art-directed without
   coupling its layout to another issue. */
(function () {
  'use strict';

  var S = window.STAMPS;
  if (!S || !S.TPL || !S.GROUP_STYLE) return;

  S.TPL.thrushFlora = {
    id: 'thrushFlora',
    title: 'German Robin Design Issue',
    ar: 1.68,
    perf: 'scallop',
    html: [
      '<div class="face tpl-thrush-flora" style="--face:#f5f6f3">',
        '<div class="tf-specimen">',
          '<canvas class="fxc tf-bird-plate" data-fx="inkStamp" data-src="{{SRC}}" data-paper="./assets/stamp/paper-texture-grey.png" data-opt=\'{"fit":"bird","pad":0.008,"scale":0.95,"offsetX":-0.028,"offsetY":0.006,"ink":"#343938","lift":0.038,"contrast":1.28}\' aria-label="{{NAME}}"></canvas>',
        '</div>',
        '<aside class="tf-rail">',
          '<div class="tf-value">',
            '<strong>{{INDEX}}</strong>',
          '</div>',
          '<div class="tf-spines">',
            '<span>{{ORDER}}</span>',
            '<span>{{SCI}}</span>',
            '<span>AvianVisitors</span>',
          '</div>',
        '</aside>',
        '<div class="tf-title">{{NAME}}</div>',
      '</div>'
    ].join('')
  };

  S.TPL.flyRose = {
    id: 'flyRose',
    title: 'Zürich Flycatcher Definitive',
    ar: 0.8,
    perf: 'scallop',
    html: [
      '<div class="face tpl-fly-rose" style="--face:#f4f0e7">',
        '<svg class="fr-screen" viewBox="0 0 160 200" preserveAspectRatio="none" aria-hidden="true" focusable="false">',
          '<defs>',
            '<pattern id="fr-screen-dot-field" width="1.1" height="1.1" patternUnits="userSpaceOnUse">',
              '<circle cx="0.55" cy="0.55" r="0.35" fill="#a51935"></circle>',
            '</pattern>',
          '</defs>',
          '<rect width="160" height="200" fill="#f4f0e7"></rect>',
          '<rect width="160" height="200" fill="#a41d37" opacity="0.018"></rect>',
          '<rect width="160" height="200" fill="url(#fr-screen-dot-field)" opacity="0.96"></rect>',
        '</svg>',
        '<div class="fr-value"><strong>{{INDEX}}</strong></div>',
        '<div class="fr-edge fr-name">{{FLY_NAME}}</div>',
        '<div class="fr-edge fr-sci">{{SCI}}</div>',
        '<div class="fr-edge fr-right">{{ORDER}} · AVIANVISITORS</div>',
        '<div class="fr-bird"><canvas class="fxc fr-bird-plate" data-fx="lineEngraving" data-src="{{SRC}}" data-opt=\'{"fit":"bird","pad":0.09,"scale":0.84,"rotate":6,"offsetX":0,"offsetY":0.018,"ink":"#f4f0e7","gap":0.019,"lineWidth":0.0038,"edgeThreshold":0.047,"detailThreshold":0.14,"hatchThreshold":0.22,"hatchStrength":0.86,"crossHatch":false,"deepHatch":false,"smoothRadius":2,"rangeSigma":0.1,"dropout":false,"seed":13}\' aria-label="{{NAME}}"></canvas></div>',
      '</div>'
    ].join('')
  };

  S.TPL.mimicLine = {
    id: 'mimicLine',
    title: 'Berlin Mimidae Line Issue',
    ar: 1,
    perf: 'pearl',
    html: [
      '<div class="face tpl-mimic-line" style="--face:#f3f6f5">',
        '<div class="ml-index"><b>{{INDEX}}</b></div>',
        '<div class="ml-spine ml-name">{{NAME}}</div>',
        '<div class="ml-spine ml-sci">{{SCI}}</div>',
        '<div class="ml-spine ml-right">{{ORDER}} · AVIANVISITORS</div>',
        '<div class="ml-art">',
        '<canvas class="fxc ml-bird-plate" data-fx="horizontalRelief" data-src="{{SRC}}" data-opt=\'{"fit":"bird","pad":0.07,"scale":0.76,"rotate":-8,"offsetX":-0.035,"offsetY":0.1,"ink":"#c92f31","gap":0.0175,"contrast":1.5,"toneGamma":1.08,"toneLow":0.12,"toneHigh":0.88,"smoothRadius":3,"minLine":0.11,"maxLine":0.7}\' aria-label="{{NAME}}"></canvas>',
        '</div>',
      '</div>'
    ].join('')
  };

  S.TPL.waxBotanical = {
    id: 'waxBotanical',
    title: 'Macau Waxwing Botanical',
    ar: 0.78,
    perf: 'scallop',
    html: [
      '<div class="face tpl-wax-botanical" style="--face:#f1eee6">',
        '<div class="wb-field">',
          '<div class="wb-mast"><span>AVIANVISITORS</span><b>{{INDEX}}</b></div>',
          '<svg class="wb-side" viewBox="0 0 32 116" role="img" aria-label="{{ORDER}}, {{SCI}}">',
            '<text class="wb-family" x="10.1" y="112" transform="rotate(-90 10.1 112)" textLength="104" lengthAdjust="spacing">{{ORDER}}</text>',
            '<text class="wb-scientific" x="21.2" y="112" transform="rotate(-90 21.2 112)" textLength="104" lengthAdjust="spacing">{{SCI}}</text>',
          '</svg>',
          '<div class="wb-bird"><canvas class="fxc wb-bird-plate wb-halo" data-fx="waxHalo" data-src="{{SRC}}" data-opt=\'{"pad":0.075,"threshold":68,"radius":0.011,"cream":"#eee9de"}\' aria-hidden="true"></canvas><canvas class="fxc wb-bird-plate" data-fx="waxCutout" data-src="{{SRC}}" data-opt=\'{"pad":0.075,"threshold":68,"sharpen":0.14}\' aria-label="{{NAME}}"></canvas></div>',
          '<div class="wb-caption"><strong>{{NAME}}</strong></div>',
        '</div>',
      '</div>'
    ].join('')
  };

  S.GROUP_STYLE.Thrushes = 'thrushFlora';
  S.GROUP_STYLE.Flycatchers = 'flyRose';
  S.GROUP_STYLE['Mockingbirds & Thrashers'] = 'mimicLine';
  S.GROUP_STYLE.Waxwings = 'waxBotanical';
})();

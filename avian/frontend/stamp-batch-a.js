/* Family issue refinements: Finches + Doves & Pigeons.
   Loaded after stamps.js so these issues can remain independently reviewable. */
(function () {
  'use strict';

  var S = window.STAMPS;
  if (!S || !S.TPL || !S.GROUP_STYLE) return;

  S.TPL['finch-editorial'] = {
    id: 'finch-editorial',
    title: 'Finch Field Notes',
    ar: 0.52,
    perf: 'scallop',
    html:
      '<div class="face tpl-finch-editorial" style="--face:#f4f5f2">' +
        '<header class="fe-head">' +
          '<h3 class="fe-name">{{NAME}}</h3>' +
          '<p class="fe-sci">{{SCI_STACK}}</p>' +
        '</header>' +
        '<div class="fe-postal">' +
          '<span class="fe-number"><small>N&ordm;</small><b>{{INDEX}}</b></span>' +
          '<span class="fe-taxonomy"><b>{{ORDER}}</b><span>{{PROJECT}}</span></span>' +
        '</div>' +
        '<div class="fe-garden" aria-hidden="true">' +
          '<svg viewBox="0 0 176 172" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
            '<defs>' +
              '<filter id="fe-cream-{{INDEX}}" color-interpolation-filters="sRGB" x="-5%" y="-5%" width="110%" height="110%">' +
                '<feColorMatrix type="matrix" values="0 0 0 0 .957  0 0 0 0 .961  0 0 0 0 .949  0 0 0 1 0"/>' +
              '</filter>' +
              '<symbol id="fe-bird-{{INDEX}}" viewBox="0 0 30 30" overflow="visible">' +
                '<image href="{{SRC}}" width="30" height="30" preserveAspectRatio="xMidYMid meet" filter="url(#fe-cream-{{INDEX}})"/>' +
              '</symbol>' +
            '</defs>' +
            '<g class="fe-bird-repeat">' +
              '<use href="#fe-bird-{{INDEX}}" x="-15" y="6" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="27" y="6" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="69" y="6" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="111" y="6" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="153" y="6" width="30" height="30"/>' +
              '<use href="#fe-bird-{{INDEX}}" x="6" y="38.5" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="48" y="38.5" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="90" y="38.5" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="132" y="38.5" width="30" height="30"/>' +
              '<use href="#fe-bird-{{INDEX}}" x="-15" y="71" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="27" y="71" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="69" y="71" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="111" y="71" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="153" y="71" width="30" height="30"/>' +
              '<use href="#fe-bird-{{INDEX}}" x="6" y="103.5" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="48" y="103.5" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="90" y="103.5" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="132" y="103.5" width="30" height="30"/>' +
              '<use href="#fe-bird-{{INDEX}}" x="-15" y="136" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="27" y="136" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="69" y="136" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="111" y="136" width="30" height="30"/><use href="#fe-bird-{{INDEX}}" x="153" y="136" width="30" height="30"/>' +
            '</g>' +
          '</svg>' +
        '</div>' +
        '<span class="fe-stock" aria-hidden="true"></span>' +
      '</div>'
  };

  S.TPL['dove-flight'] = {
    id: 'dove-flight',
    title: 'Two Suns / Dove in Flight',
    ar: 0.78,
    perf: 'scallop',
    html:
      '<div class="face tpl-dove-flight" style="--face:#f0e4cb">' +
        '<header class="dv-head">' +
          '<h3 class="dv-name">{{NAME}}</h3>' +
          '<span class="dv-number">{{INDEX}}</span>' +
        '</header>' +
        '<div class="dv-suns" aria-hidden="true"><i></i><i></i></div>' +
        '<div class="dv-specimen">' +
          '<canvas class="fxc dv-bird-screen" data-fx="posterDither" data-src="{{SRC}}" data-opt=\'{"ink":"#c7922e","cell":0.0068,"contrast":1.1,"bias":0.178,"fit":"bird","pad":0.012,"rotate":-2,"scale":1.02}\'></canvas>' +
        '</div>' +
        '<div class="dv-rule" aria-hidden="true"></div>' +
        '<footer class="dv-foot">' +
          '<div class="dv-id"><b>{{PROJECT}}</b><i>{{SCI}}</i></div>' +
          '<div class="dv-family">{{ORDER}}</div>' +
        '</footer>' +
        '<span class="dv-stock" aria-hidden="true"></span>' +
      '</div>'
  };

  S.GROUP_STYLE.Finches = 'finch-editorial';
  S.GROUP_STYLE['Doves & Pigeons'] = 'dove-flight';

}());

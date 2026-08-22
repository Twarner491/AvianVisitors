(function () {
  var PLACEHOLDER = [{ "sci": "Calypte anna", "com": "Anna's Hummingbird", "featured": true }, { "sci": "Passer domesticus", "com": "House Sparrow" }, { "sci": "Haemorhous mexicanus", "com": "House Finch" }, { "sci": "Turdus migratorius", "com": "American Robin" }, { "sci": "Zenaida macroura", "com": "Mourning Dove" }, { "sci": "Spinus psaltria", "com": "Lesser Goldfinch" }, { "sci": "Zonotrichia leucophrys", "com": "White-crowned Sparrow" }, { "sci": "Aphelocoma californica", "com": "California Scrub-Jay" }, { "sci": "Mimus polyglottos", "com": "Northern Mockingbird" }, { "sci": "Sayornis nigricans", "com": "Black Phoebe" }, { "sci": "Larus occidentalis", "com": "Western Gull" }, { "sci": "Corvus brachyrhynchos", "com": "American Crow" }];
  // Library-wide revision for a full offline sketch rebuild. One-species
  // corrections use ART_REVISIONS below.
  var SKETCH_VERSION = 'r12'; // r12: 84 eastern NA birds (PR #23) refined + re-cut. r11: full library restyle: every species
  // re-rendered (perched + flight) with clean cutouts.
  // Cache-bust for /avian/api/cutout.php. Bump only when every CF DC must
  // drop the full image library.
  // Cloudflare keys on the full URL incl. query, so bumping this is
  // equivalent to a global cache purge for /avian/api/cutout.php.
  // caches.default.delete() in the worker only affects one colo at a time,
  // so a versioned URL is the only reliable way to invalidate everywhere.
  var IMG_VERSION = 'r12'; // r12: 84 eastern NA birds (PR #23) refined + re-cut. r11: full library restyle: every species re-rendered
  // with clean cutouts, so drop every cached copy.
  // Keep table and one-off art revisions separate from the library-wide
  // versions above. A corrected species should not evict every bird image.
  var TABLE_VERSION = 'r13';
  var ART_REVISIONS = {
    'aphelocoma-woodhouseii': 'anatomy-1'
  };
  function artRevision(sci, fallback) {
    return ART_REVISIONS[slugify(String(sci || ''))] || fallback;
  }

  // ---- Sliding pill helper ----
  // Each segmented control has a single .seg-pill element that we move via
  // transform/width to whichever button currently has aria-current="true".
  // This gives an iOS-style smooth slide instead of a hard snap.
  function syncPill(container) {
    var pill = container.querySelector('.seg-pill');
    var active = container.querySelector('button[aria-current="true"]');
    if (!pill || !active) return;
    // offsetLeft is relative to the container (we set position:relative on it).
    pill.style.width = active.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }

  // Clicking the open space of a segmented toggle (not a specific option)
  // advances to the next available option, cycling. Clicking an option
  // still jumps straight to it - we just synthesize a click on the next
  // button so its existing handler runs.
  function wireToggleAdvance(container) {
    if (!container || container.__advanceWired) return;
    container.__advanceWired = true;
    container.addEventListener('click', function (ev) {
      var hit = ev.target.closest('button');
      var all = [].slice.call(container.querySelectorAll('button')).filter(function (b) {
        return !b.disabled && b.getAttribute('data-unavailable') !== 'true';
      });
      // With exactly two options the control reads as a switch, so pressing
      // the lit side should flip it rather than do nothing. With three or
      // more, pressing the current option is a deliberate no-op.
      if (hit) {
        if (all.length === 2 && hit.getAttribute('aria-current') === 'true') {
          // The theme and label segs hang their own handler off this same
          // container, registered after this one. Without stopping the rest
          // of the chain that handler runs on the original press and puts
          // the pill straight back where it was.
          ev.stopImmediatePropagation();
          (all[0] === hit ? all[1] : all[0]).click();
        }
        return;
      }
      var btns = [].slice.call(container.querySelectorAll('button')).filter(function (b) {
        return !b.disabled && b.getAttribute('data-unavailable') !== 'true';
      });
      if (btns.length < 2) return;
      var cur = -1;
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('aria-current') === 'true') { cur = i; break; }
      }
      btns[(cur + 1) % btns.length].click();
    }, true);
  }

  // ---- Slider ----
  var views = document.getElementById('views');
  var slider = document.getElementById('slider');
  var btns = [].slice.call(slider.querySelectorAll('button'));
  var winPick = document.getElementById('winPick');

  // Each view's title text. The shared static-head shows one of these
  // based on the current view; identical adjacent values mean the title
  // stays put with no fade (collage and stats both say Heard Recently).
  var VIEW_TITLES = ['Heard Recently', 'Heard Recently', 'Avian Atlas'];
  var EMPTY_WINDOW_COPY = 'no detections heard in this window';
  var staticHead = document.querySelector('.static-head');
  var staticTitle = document.getElementById('staticTitle');
  function applySiteName(value) {
    var name = typeof value === 'string' ? value.trim() : '';
    if (!name) name = 'BirdNET-Pi';
    document.querySelectorAll('[data-site-name]').forEach(function (element) {
      element.textContent = name;
    });
    document.title = name;
    return name;
  }
  function setTitleForView(i) {
    var next = VIEW_TITLES[i];
    if (!staticTitle || staticTitle.textContent === next) return;
    // Fade out -> swap text -> fade in. The opacity transition is 240ms;
    // we swap at ~half that so the eye doesn't catch the text change.
    staticHead.classList.add('swap-out');
    setTimeout(function () {
      staticTitle.textContent = next;
      // Force reflow before removing class so the transition restarts.
      void staticHead.offsetWidth;
      staticHead.classList.remove('swap-out');
    }, 220);
  }

  // The views slide horizontally over SLIDE_MS (see .views transition). For
  // stats + atlas we hold the load-in hidden until the slide has essentially
  // settled, so you watch the content populate *in* the view rather than it
  // finishing mid-slide. The lead is a touch under SLIDE_MS so the cascade
  // begins just as the view arrives - no dead pause, still snappy. Collage's
  // bloom reads fine mid-slide, so it starts immediately (no lead). Stats
  // reads as starting a hair slower than atlas, so it gets a shorter lead.
  var SLIDE_MS = 480;
  var SWITCH_LEAD = SLIDE_MS - 100;   // atlas
  var STATS_LEAD = SLIDE_MS - 200;    // stats - begin a touch sooner
  var VIEW_STORAGE_KEY = 'bird:view';
  function readSavedView() {
    var saved = parseInt(readLS(VIEW_STORAGE_KEY, '0'), 10);
    return saved >= 0 && saved < VIEW_TITLES.length ? saved : 0;
  }
  // Resolve the saved sheet before routing so refreshes land directly on
  // the view the visitor left, without briefly replaying the default view.
  var currentView = readSavedView();
  function go(i, options) {
    options = options || {};
    i = Math.max(0, Math.min(2, i));
    // Only a genuine view *switch* replays the entrance. go() also fires when
    // a card is expanded (it sets the #sci= hash, which routes through go(2))
    // while already on the atlas - that must not retrigger the load-in.
    var switching = (i !== currentView);
    currentView = i;
    if (options.persist !== false) writeLS(VIEW_STORAGE_KEY, String(i));
    views.style.transform = 'translateX(-' + (i * 100) + '%)';
    btns.forEach(function (b, j) { b.setAttribute('aria-current', j === i ? 'true' : 'false'); });
    syncPill(slider);
    setTitleForView(i);
    requestAnimationFrame(syncCompactHeader);
    if (!switching) return;
    // Replay the view's entrance animation on switch (collage bloom,
    // stats left-to-right, atlas row-by-row).
    if (i === 0) playCollageEntrance();
    else if (i === 1) playStatsEntrance(STATS_LEAD);
    else if (i === 2) playAtlasEntrance(SWITCH_LEAD);
  }
  btns.forEach(function (b) { b.addEventListener('click', function () { go(+b.dataset.i); }); });
  // Paint the restored sheet immediately. Pre-seeding the title avoids the
  // normal cross-view title transition during the initial page load.
  if (staticTitle) staticTitle.textContent = VIEW_TITLES[currentView];
  go(currentView, { persist: false });

  // The admin overlay's back link is intentionally stronger than ordinary
  // refresh persistence: "back to collage" should still mean collage.
  var returnToAtlas = document.getElementById('returnToAtlas');
  if (returnToAtlas) returnToAtlas.addEventListener('click', function () {
    writeLS(VIEW_STORAGE_KEY, '0');
  });

  // The only vertical motion in the primary experience happens inside the
  // individual view sheets. Collapse the shared masthead against the sheet
  // that is actually scrolling, with a little hysteresis so a trackpad does
  // not chatter around zero. Collage / stats only opt in when their content
  // genuinely exceeds the viewport.
  var stage = document.querySelector('.stage');
  var compactFrame = 0;
  function syncCompactHeader() {
    compactFrame = 0;
    var view = document.getElementById('v' + currentView);
    if (!stage || !view) return;
    var canScroll = view.scrollHeight > view.clientHeight + 3;
    var threshold = stage.classList.contains('is-compact') ? 8 : 26;
    stage.classList.toggle('is-compact', canScroll && view.scrollTop > threshold);
  }
  function queueCompactHeader() {
    if (compactFrame) return;
    compactFrame = requestAnimationFrame(syncCompactHeader);
  }
  // Safari will rubber-band an `overflow:auto` sheet even when its scroll
  // extent equals its viewport. Keep the Atlas axis physically closed until
  // the packed wall is genuinely taller, then opt it into the same contained
  // scroller used by the other long-form surfaces.
  var atlasOverflowFrame = 0;
  function syncAtlasOverflowState() {
    atlasOverflowFrame = 0;
    var view = document.getElementById('v2');
    if (!view) return;
    var scrollable = view.scrollHeight > view.clientHeight + 3;
    view.setAttribute('data-scrollable', scrollable ? 'true' : 'false');
    if (!scrollable && view.scrollTop) view.scrollTop = 0;
    queueCompactHeader();
  }
  function queueAtlasOverflowState() {
    if (atlasOverflowFrame) return;
    atlasOverflowFrame = requestAnimationFrame(syncAtlasOverflowState);
  }
  ['v0', 'v1', 'v2'].forEach(function (id) {
    var view = document.getElementById(id);
    if (view) view.addEventListener('scroll', queueCompactHeader, { passive: true });
  });
  window.addEventListener('resize', queueCompactHeader, { passive: true });
  var atlasViewForOverflow = document.getElementById('v2');
  if (atlasViewForOverflow && window.ResizeObserver) {
    new ResizeObserver(queueAtlasOverflowState).observe(atlasViewForOverflow);
  }
  queueAtlasOverflowState();

  // ---- Window picker ----
  // Persist selections across reloads so a returning visitor lands on the
  // same view they left. Keys are namespaced so a future schema change
  // can be invalidated by bumping the prefix.
  function readLS(k, fallback) { try { return localStorage.getItem(k) || fallback; } catch (e) { return fallback; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  // Atlas can either follow the shared collage/stats window or stay on the
  // complete life list. This is a browser preference, like theme and bird
  // names: it must never enter the Pi config save flow or restart services.
  var ATLAS_ALWAYS_ALL_KEY = 'bird:atlasAlwaysAll:v1';
  var sessionAtlasAlwaysAll = null;
  function atlasAlwaysAll() {
    if (sessionAtlasAlwaysAll !== null) return sessionAtlasAlwaysAll;
    return readLS(ATLAS_ALWAYS_ALL_KEY, 'off') === 'on';
  }
  function atlasWindowHours() {
    return atlasAlwaysAll() ? 1000000 : currentHours;
  }
  function syncAtlasAlwaysAll() {
    var on = atlasAlwaysAll();
    document.querySelectorAll('[data-atlas-always-all]').forEach(function (sw) {
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    // The all-time life list is already loaded for accession numbers and
    // totals, so changing this preference needs no second API request.
    if (DATA && DATA.lifelist) renderAtlas(false);
  }
  function applyAtlasAlwaysAll(on) {
    sessionAtlasAlwaysAll = !!on;
    writeLS(ATLAS_ALWAYS_ALL_KEY, on ? 'on' : 'off');
    syncAtlasAlwaysAll();
  }

  // The stamp wall remains the default Atlas. Classic cards are a local
  // display preference only, so choosing them never enters the station config
  // save path or changes filtering, sorting, recordings, or deep links.
  var ATLAS_STYLE_KEY = 'bird:atlasStyle:v1';
  var sessionAtlasStyle = null;
  function atlasStyle() {
    if (sessionAtlasStyle !== null) return sessionAtlasStyle;
    return readLS(ATLAS_STYLE_KEY, 'stamps') === 'classic' ? 'classic' : 'stamps';
  }
  function atlasUsesClassicCards() {
    return atlasStyle() === 'classic';
  }
  function syncAtlasStyle() {
    var classic = atlasUsesClassicCards();
    document.querySelectorAll('[data-atlas-classic]').forEach(function (sw) {
      sw.setAttribute('aria-checked', classic ? 'true' : 'false');
    });
    if (DATA && DATA.lifelist) renderAtlas(false);
  }
  function applyAtlasStyle(classic) {
    sessionAtlasStyle = classic ? 'classic' : 'stamps';
    writeLS(ATLAS_STYLE_KEY, sessionAtlasStyle);
    syncAtlasStyle();
  }

  // Remember the last confirmed illustration pose independently for each
  // species. Keep a validated in-memory copy so the preference still works
  // for this visit when storage is unavailable (private mode / quota errors).
  var POSTCARD_POSE_STORAGE_KEY = 'bird:postcardPoses:v1';
  function loadPostcardPosePreferences() {
    var preferences = Object.create(null);
    var raw = readLS(POSTCARD_POSE_STORAGE_KEY, '');
    if (!raw) return preferences;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return preferences;
      Object.keys(parsed).slice(0, 512).forEach(function (sci) {
        var name = sci.trim();
        var pose = +parsed[sci];
        if (name && (pose === 1 || pose === 2)) preferences[name] = pose;
      });
    } catch (e) { }
    return preferences;
  }
  var postcardPosePreferences = loadPostcardPosePreferences();
  function rememberedPostcardPose(sci) {
    return postcardPosePreferences[(sci || '').trim()] || 0;
  }
  function rememberPostcardPose(sci, pose) {
    var name = (sci || '').trim();
    pose = +pose;
    if (!name || (pose !== 1 && pose !== 2)) return;
    postcardPosePreferences[name] = pose;
    writeLS(POSTCARD_POSE_STORAGE_KEY, JSON.stringify(postcardPosePreferences));
  }

  // ---- Single-audio coordinator ----
  // Only one source plays at a time across the whole app: atlas-card
  // playback, modal recording playback, and the live stream each call
  // audioClaim(theirStopFn) the moment they start, which stops whatever
  // else was playing, and audioRelease(theirStopFn) when they stop on
  // their own. Keeps "start a new one -> the old one pauses" true even
  // across those three independent players.
  var __audioActiveStop = null;
  function audioClaim(stopSelf) {
    if (__audioActiveStop && __audioActiveStop !== stopSelf) {
      var prev = __audioActiveStop;
      __audioActiveStop = null;
      try { prev(); } catch (e) { }
    }
    __audioActiveStop = stopSelf;
  }
  function audioRelease(stopSelf) {
    if (__audioActiveStop === stopSelf) __audioActiveStop = null;
  }

  // ---- Theme (auto / light / charcoal dark) ----
  // Store the preference separately from the resolved theme on <html>.
  // New installs default to auto. Existing light and dark choices from the
  // legacy key are both preserved.
  var THEME_KEY = 'bird:theme:v2';
  var LEGACY_THEME_KEY = 'bird:theme';
  var THEME_QUERY = '(prefers-color-scheme: dark)';
  var sessionThemePreference = null;
  function themePreference() {
    if (sessionThemePreference) return sessionThemePreference;
    var pref = readLS(THEME_KEY, '');
    if (pref === 'auto' || pref === 'light' || pref === 'dark') return pref;
    var legacy = readLS(LEGACY_THEME_KEY, '');
    return (legacy === 'light' || legacy === 'dark') ? legacy : 'auto';
  }
  function systemTheme() {
    try {
      return window.matchMedia && window.matchMedia(THEME_QUERY).matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }
  function resolveTheme(pref) {
    return pref === 'light' || pref === 'dark' ? pref : systemTheme();
  }
  function refreshThemePaint() {
    document.querySelectorAll('.rec-spectro canvas, .bird-card .spectro-wrap canvas').forEach(function (canvas) {
      if (!canvas.__birdAudioBuffer) return;
      canvas.classList.remove('ready');
      var box = canvas.parentElement;
      if (box && box.clientWidth >= 32 && box.clientHeight >= 32) {
        paintSpectrogram(canvas, canvas.__birdAudioBuffer);
      }
    });
    document.querySelectorAll('.live-spectro').forEach(function (canvas) {
      if (typeof canvas.__refreshTheme === 'function') canvas.__refreshTheme();
    });
  }
  function syncTheme() {
    var pref = themePreference();
    document.documentElement.setAttribute('data-theme', resolveTheme(pref));
    document.querySelectorAll('[data-theme-seg]').forEach(function (seg) {
      seg.querySelectorAll('button[data-theme]').forEach(function (button) {
        button.setAttribute('aria-current', button.getAttribute('data-theme') === pref ? 'true' : 'false');
      });
      syncPill(seg);
    });
    refreshThemePaint();
  }
  function applyTheme(pref) {
    var next = (pref === 'light' || pref === 'dark') ? pref : 'auto';
    sessionThemePreference = next;
    writeLS(THEME_KEY, next);
    syncTheme();
  }
  syncTheme();

  // Follow system changes only while auto is selected. Keep the older
  // listener spelling for long-lived dashboards on older Safari releases.
  var themeMedia = null;
  try { themeMedia = window.matchMedia && window.matchMedia(THEME_QUERY); } catch (e) { }
  if (themeMedia) {
    var onSystemThemeChange = function () {
      if (themePreference() === 'auto') syncTheme();
    };
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', onSystemThemeChange);
    else if (themeMedia.addListener) themeMedia.addListener(onSystemThemeChange);
  }
  window.addEventListener('storage', function (ev) {
    if (ev.key === THEME_KEY || ev.key === LEGACY_THEME_KEY || ev.key === null) {
      sessionThemePreference = null;
      syncTheme();
    }
    if (ev.key === ATLAS_ALWAYS_ALL_KEY || ev.key === null) {
      sessionAtlasAlwaysAll = null;
      syncAtlasAlwaysAll();
    }
    if (ev.key === ATLAS_STYLE_KEY || ev.key === null) {
      sessionAtlasStyle = null;
      syncAtlasStyle();
    }
  });
  var winBtns = [].slice.call(winPick.querySelectorAll('button'));
  var currentHours = +readLS('bird:window', '24') || 24;
  winBtns.forEach(function (b) {
    b.setAttribute('aria-current', (+b.dataset.h === currentHours) ? 'true' : 'false');
  });
  winBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      winBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
      currentHours = +b.dataset.h;
      writeLS('bird:window', String(currentHours));
      syncPill(winPick);
      // Actual data refresh is wired below via refreshRecent().
    });
  });

  // Initial pill placement (after layout settles) + on resize.
  // Atlas sort segmented control - same pill-on-recess pattern.
  var atlasSortEl = document.getElementById('atlasSort');
  var atlasSortBtns = atlasSortEl ? [].slice.call(atlasSortEl.querySelectorAll('button')) : [];
  window.__atlasSort = readLS('bird:atlasSort', 'life');
  atlasSortBtns.forEach(function (b) {
    b.setAttribute('aria-current', (b.dataset.sort === window.__atlasSort) ? 'true' : 'false');
  });
  atlasSortBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      atlasSortBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
      window.__atlasSort = b.dataset.sort;
      writeLS('bird:atlasSort', window.__atlasSort);
      syncPill(atlasSortEl);
      // Keep existing issues on the sheet and let the FLIP pass carry them
      // into their new places. The row cascade belongs only to the Atlas's
      // first reveal, not to direct sort/filter changes.
      renderAtlas(false);
    });
  });

  // Open-space click advances these segmented toggles to the next option.
  wireToggleAdvance(slider);
  wireToggleAdvance(winPick);
  wireToggleAdvance(atlasSortEl);
  wireToggleAdvance(document.getElementById('modalPoseToggle'));
  function syncAllPills() {
    syncPill(slider); syncPill(winPick);
    if (atlasSortEl) syncPill(atlasSortEl);
    var cp = document.getElementById('chartPick');
    if (cp) syncPill(cp);
  }
  // The buttons size from text content; wait for fonts so width is correct.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncAllPills);
  }
  // Also sync after layout is definitely done.
  requestAnimationFrame(function () { requestAnimationFrame(syncAllPills); });
  var pillTimer;
  window.addEventListener('resize', function () {
    clearTimeout(pillTimer);
    pillTimer = setTimeout(syncAllPills, 80);
  });

  // ---- Raster-bitmask collage with bird-shaped nesting ----
  // Each species ships a low-res binary alpha mask (cutout_masks.ts) that
  // matches the bird's actual outline. The layout maintains an occupancy
  // grid at viewport resolution; for each tile we spiral outward from the
  // cluster centre and pick the closest position where the tile's mask
  // doesn't overlap any already-placed mask. Result: birds nest into each
  // other's concavities (wing arc cradles tail, etc.) with a small visual
  // gap baked into the mask via Python-side dilation. No bbox overlap, no
  // rectangles touching - actual polygon-aware packing.

  var collage = document.getElementById('collage');
  // DIMS[slug]=[w,h] (aspect) and MASKS[slug]={w,h,bits} (1-bit silhouette)
  // are built offline by scripts/build_masks.py and fetched from dims.json /
  // masks.json at load. They live in their own files (one key per line) so a
  // species-add is a clean diff and two contributors' additions don't collide,
  // instead of rewriting one ~800KB line and conflicting on every merge.
  var DIMS = {}, MASKS = {}, tablesReady = false;
  // Species drawn during this session. The atlas re-renders straight after a
  // generate and cutout.php sets a day of cache, so the fresh render needs its
  // own stamp to get past whatever the earlier 404 left behind.
  var justGenerated = {};
  function loadTables(bust) {
    // bust=true refetches past every cache - used after an on-Pi generate
    // adds a species, so its mask becomes drawable without a reload.
    var q = '?v=' + TABLE_VERSION + (bust ? '&t=' + Date.now() : '');
    return Promise.all([
      fetch('./dims.json' + q).then(function (r) { return r.json(); }),
      fetch('./masks.json' + q).then(function (r) { return r.json(); })
    ]).then(function (loaded) {
      DIMS = loaded[0];
      MASKS = loaded[1];
      maskCache = {};
      tablesReady = true;
      // renderCollage defers its first pack until the silhouettes exist (see
      // the tablesReady gate); render now that they are here. The atlas needs
      // the same nudge: which cards want a draw button is a question only
      // DIMS can answer, and it may have rendered before this landed.
      try { renderCollageFromData(); } catch (e) { }
      try { if (DATA.lifelist) renderAtlas(false); } catch (e) { }
      return true;
    }).catch(function (e) {
      // Leave tablesReady false so renderCollage keeps waiting rather than
      // packing with no silhouettes. The empty-nest state still renders.
      if (window.console) console.error('collage: dims/masks failed to load', e);
      return false;
    });
  }
  loadTables();

  function defaultCutoutSrc(sci, pose, version, commonName) {
    var base = './avian/api/cutout.php?sci=' + encodeURIComponent(sci);
    var species = (typeof DATA !== 'undefined' && DATA && DATA.lifelist && DATA.lifelist.species) || [];
    var sp = species
      .find(function (s) { return s.sci === sci; });
    var com = commonName || (sp ? (sp.com || '') : '');
    if (com) base += '&com=' + encodeURIComponent(com);
    if (+pose > 1) base += '&pose=' + (+pose);
    return base + '&v=' + artRevision(sci, version || SKETCH_VERSION);
  }

  function collageImageSrc(sci, pose, commonName) {
    return defaultCutoutSrc(sci, pose, IMG_VERSION, commonName);
  }

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
  var FLY_PROB = 0.15; // chance a bird shows in its flight pose (rare); perched
  // otherwise. Rolled once per window appearance.
  var collagePose = {}; // sci -> 1 perched | 2 flight, persisted across polls;
  // cleared when a bird leaves the window so it rerolls.

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
    '<svg class="gtile-label-defs" width="0" height="0" aria-hidden="true">' +
      inkFilter('lbl-ink-s', '0.45', '0.24', '0.68') +
      inkFilter('lbl-ink-m', '0.75', '0.34', '0.55') +
      inkFilter('lbl-ink-l', '1.10', '0.42', '0.42') +
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
  var labelParam = /[?&]labels=(1|0)\b/.exec(location.search);
  // Three layers, like the theme: ?labels=1|0 (how a frame's shoot forces a
  // value without localStorage), then this device's own choice, then the
  // station's COLLAGE_LABELS - which rides on the recent payload because this
  // page is anonymous and config.php is not. Absent means on, the historic
  // default, so a collage against an older station looks exactly as before.
  function siteLabels() {
    var r = DATA && DATA.recent;
    return (r && typeof r.labels === 'boolean') ? r.labels : true;
  }
  // 'site' | 'on' | 'off'. A device that never touched the switch has no key
  // and follows the site; one that did keeps its choice, because the old
  // handler only ever wrote on a click, so a stored value is a real decision.
  function labelPreference() {
    var v = readLS('bird:labels', 'site');
    return (v === 'on' || v === 'off') ? v : 'site';
  }
  function labelsOn() {
    if (labelParam) return labelParam[1] === '1';
    var pref = labelPreference();
    if (pref !== 'site') return pref === 'on';
    return siteLabels();
  }
  var labelCtx = document.createElement('canvas').getContext('2d');
  var edgeFitCache = {};
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
  // Label widths are measured against the real face, so the first pack
  // has to wait for it. Otherwise the collage lays out to the fallback's
  // metrics and re-flows a moment later, which the frame's shoot can
  // catch mid-swap.
  var labelFontReady = !labelsOn();
  if (!labelFontReady) {
    var fontDone = function () {
      if (labelFontReady) return;
      labelEmCache = {};        // anything measured so far was the fallback face
      labelFontReady = true;
      try { renderCollageFromData(); } catch (e) { }
    };
    if (document.fonts && document.fonts.load) {
      document.fonts.load('600 16px Hand').then(fontDone).catch(fontDone);
      setTimeout(fontDone, 3000);   // never block the collage on a slow face
    } else {
      labelFontReady = true;
    }
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
    var tanPx = Math.max(LABEL_MIN_PX,
                         Math.min(maxPx, Math.floor(LABEL_REACH * W / nameEm)));
    var tan = tangentSpan(out, W, H, tanPx, nameEm * tanPx + 4);
    return tan ? { px: tanPx, rows: [{ pts: tan.pts, text: name }], q: 0, deg: tan.deg }
               : null;
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
      var out = outline(t.slug, t.mask);
      if (!out) return;
      // A quiet bird may have a very small tile, but names-on still means
      // every bird is named. The tangent fallback can carry readable type
      // beyond the silhouette, and the packer reserves that whole label.
      var maxPx = Math.max(LABEL_MIN_PX, labelCap(t.fullW, t.fullH));
      var plan = planLabel(out, name, t.fullW, t.fullH, maxPx);
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

  function renderCollage(items, animate) {
    collage.innerHTML = '';
    // Drop the previous render's hit-test tiles up front so a click or hover on
    // the empty-nest state (or a collage that hasn't laid out yet) resolves to
    // nothing, not to a stale bird from the last populated render. The populated
    // path repopulates collagePlaced once the new tiles are placed.
    collagePlaced = [];
    collageHovered = null;
    if (!items.length) {
      // No birds heard yet: show an empty nest where the collage would be, with
      // the status line beneath it. The frame (shoot.py) overrides the .empty
      // text for the e-ink panel; the nest illustration is shared by both.
      collage.innerHTML = '<div class="empty-nest">' +
        '<img class="nest-img" src="nest.webp" alt="an empty nest" decoding="async">' +
        '<p class="empty window-empty">' + EMPTY_WINDOW_COPY + '</p></div>';
      // Bloom the nest in on the same cues as the collage (first load, window
      // change, view switch); a silent poll/resize renders without animate. The
      // class self-clears after the worst case so a throttled tab still ends
      // with the nest visible, mirroring the tile entrance's safety net.
      if (animate) {
        var enest = collage.firstChild;
        enest.classList.add('entering');
        clearTimeout(collageEntranceT);
        collageEntranceT = setTimeout(function () { enest.classList.remove('entering'); }, 900);
      }
      return;
    }
    // Silhouettes (DIMS/MASKS) load async from dims.json/masks.json; until
    // they arrive we cannot pack. Defer and retry, like the !W/!H case below.
    // (The empty-nest path above needs no silhouettes and already returned.)
    if (!tablesReady) { setTimeout(function () { renderCollage(items, animate); }, 80); return; }
    if (labelsOn() && !labelFontReady) { setTimeout(function () { renderCollage(items, animate); }, 60); return; }
    var W = collage.clientWidth, H = collage.clientHeight;
    if (!W || !H) { setTimeout(function () { renderCollage(items, animate); }, 80); return; }

    // Tuning depends on bird count - same viewport, very different
    // pack densities for 6 vs 48 birds.
    var T = tuning(items.length);
    var vpArea = W * H;
    var budget = vpArea * T.packingBudgetFrac;
    var minArea = vpArea * T.minTileAreaFrac;

    // Step 1: build tiles + assign each a count-weighted SCORE (not a
    // final area yet). area-from-count uses a sub-linear exponent so
    // a 400-detection bird is visibly larger than a 30-detection bird
    // without dwarfing it.
    var tiles = items.map(function (s) {
      var base = slugify(s.sci);
      var hasFlight = !!DIMS[base + '-2'];
      // Pose: perched by default, rarely flight (FLY_PROB), and only if a
      // flight render exists. Flight uses the <slug>-2 mask/aspect/image so
      // the wings-spread silhouette nests correctly.
      var pose = collagePose[s.sci];
      if (pose === undefined) {
        pose = (hasFlight && Math.random() < FLY_PROB) ? 2 : 1;
        collagePose[s.sci] = pose;
      }
      if (pose === 2 && !hasFlight) { pose = 1; collagePose[s.sci] = 1; }
      var slug = pose === 2 ? base + '-2' : base;
      var mask = loadMask(slug);
      if (!mask && pose === 2) { pose = 1; slug = base; mask = loadMask(slug); collagePose[s.sci] = 1; }
      if (!mask) return null;
      var d = DIMS[slug];
      var n = +s.n; if (!n || isNaN(n)) n = 1;
      return {
        mask: mask, data: s, pose: pose, slug: slug,
        ar: d ? d[0] / d[1] : 1.4,
        score: Math.pow(Math.max(1, n), T.countExp),
      };
    }).filter(Boolean);
    // Reroll on re-entry: forget pose choices for species no longer in window.
    var present = {}; items.forEach(function (s) { present[s.sci] = 1; });
    Object.keys(collagePose).forEach(function (k) { if (!present[k]) delete collagePose[k]; });

    // Step 2: normalise so sum(area) ≈ budget. Then floor each tile
    // at minArea so even a 1-call bird stays legible.
    var sumScore = tiles.reduce(function (a, t) { return a + t.score; }, 0) || 1;
    tiles.forEach(function (t) {
      t.area = Math.max(minArea, budget * t.score / sumScore);
    });
    // After flooring, total may exceed budget; squeeze the over-budget
    // remainder out of the LARGER tiles (the ones above minArea) so
    // the floor on rare birds stays intact.
    var sumA = tiles.reduce(function (a, t) { return a + t.area; }, 0);
    if (sumA > budget) {
      var fixedSum = tiles.filter(function (t) { return t.area <= minArea + 1e-9; })
        .reduce(function (a, t) { return a + t.area; }, 0);
      var flexSum = sumA - fixedSum;
      var flexBudget = Math.max(0, budget - fixedSum);
      var shrink = flexSum > 0 ? Math.min(1, flexBudget / flexSum) : 1;
      tiles.forEach(function (t) {
        if (t.area > minArea + 1e-9) t.area *= shrink;
      });
    }
    // Step 3: derive width/height from area + per-species aspect.
    tiles.forEach(function (t) {
      t.fullW = Math.sqrt(t.area * t.ar);
      t.fullH = t.fullW / t.ar;
    });

    // Width-responsive: wide screens get a horizontal ellipse at full padding;
    // narrow/portrait screens a vertical ellipse with slightly tighter padding.
    var narrow = W <= 700;
    var xBias = narrow ? 1 : T.ellipseAspectBias;
    var yBias = narrow ? 1.7 : 1;   // gentler than the desktop bias so the
    // portrait cluster stays a bit wider / less tall
    var pad = narrow ? Math.max(1, COLLAGE_PAD - 1) : COLLAGE_PAD;
    assignLabels(tiles);
    var placed = maskPack(tiles, W, H, xBias, yBias, pad);

    // Scale-to-fit: iterate shrink + repack until every tile lands on
    // screen. The old single-pass version dropped birds when one pass
    // wasn't enough (narrow viewports + many species). Capped at 10
    // iterations - by then the linear scale is ~0.5 of original, more
    // than enough headroom for any viewport.
    function clusterBounds(arr) {
      var L = Infinity, R = -Infinity, T2 = Infinity, B = -Infinity;
      arr.forEach(function (t) {
        if (t.x < -1000) return;
        // A label run can reach past the bbox on any side; the bounds
        // must cover it or re-centring pushes lettering off-screen.
        var b = t.labelBox;
        var lx0 = t.x + (b ? Math.min(0, b.dx0) : 0);
        var lx1 = t.x + t.fullW + (b ? Math.max(0, b.dx1 - t.fullW) : 0);
        var ly0 = t.y + (b ? Math.min(0, b.dy0) : 0);
        var ly1 = t.y + t.fullH + (b ? Math.max(0, b.dy1 - t.fullH) : 0);
        if (lx0 < L) L = lx0;
        if (lx1 > R) R = lx1;
        if (ly0 < T2) T2 = ly0;
        if (ly1 > B) B = ly1;
      });
      return { L: L, R: R, T: T2, B: B };
    }
    var b = clusterBounds(placed);
    for (var iter = 0; iter < 10; iter++) {
      var missing = placed.some(function (t) { return t.x < -1000; });
      var overflow = b.L < 0 || b.T < 0 || b.R > W || b.B > H;
      if (!missing && !overflow) break;
      // Base 0.93 linear shrink (≈ 0.86 area). If overflow, take the
      // tighter of cluster-to-viewport ratios so we converge fast.
      var scale = 0.93;
      if (overflow) {
        var clW = b.R - b.L, clH = b.B - b.T;
        var sx = (W * 0.96) / Math.max(clW, W * 0.96);
        var sy = (H * 0.94) / Math.max(clH, H * 0.94);
        scale = Math.min(scale, sx, sy);
      }
      tiles.forEach(function (t) { t.fullW *= scale; t.fullH *= scale; });
      assignLabels(tiles);   // font tracks the new tile widths
      placed = maskPack(tiles, W, H, xBias, yBias, pad);
      b = clusterBounds(placed);
    }

    // Re-centre the cluster in the viewport so a small cluster doesn't
    // drift to one side from the spiral's center-of-mass bias.
    var dx = W / 2 - (b.L + b.R) / 2;
    var dy = H / 2 - (b.T + b.B) / 2;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      placed.forEach(function (t) { if (t.x > -1000) { t.x += dx; t.y += dy; } });
    }

    placed.forEach(function (r) {
      var s = r.data;
      // com flows through so the worker's JIT Gemini job uses the right
      // common name in its prompt for a freshly-detected species.
      // The per-species revision busts corrected art without evicting the
      // rest of the illustration library from edge caches.
      var img = collageImageSrc(s.sci, r.pose, s.com);
      var btn = document.createElement('button');
      btn.className = 'gtile';
      btn.type = 'button';
      btn.setAttribute('data-sci', s.sci);
      btn.setAttribute('aria-label', s.com);
      // Fallback for keyboard / screen-reader users - the visible hover
      // pill below is the primary affordance for sighted mouse users.
      // "calls" (not "heard") because one bird can rack up dozens of
      // detections in a session; "heard" implies distinct individuals.
      var titleN = +s.n || 0;
      btn.title = (s.com || s.sci) + ' - ' + fmtN(titleN) + ' ' +
        (titleN === 1 ? 'call' : 'calls') + ' ' + windowLabel(currentHours);
      btn.style.left = r.x + 'px';
      btn.style.top = r.y + 'px';
      btn.style.width = r.fullW + 'px';
      btn.style.height = r.fullH + 'px';
      btn.innerHTML = '<img loading="lazy" decoding="async" src="' + img + '" alt="' + s.com + '">';
      if (r.labelRows) {
        addLabelInk();
        // One baseline per line of the name, each riding the line the planner
        // settled on, so every letter takes its own angle and height off the
        // bird's own geometry. A name that broke in two comes back as two rows
        // in reading order, the second stacked a leading further off the bird
        // along the first one's own normals. startOffset with text-anchor
        // centres each line on its span, which is cut to that line's own width.
        // The packer reserved the whole block, so none of it lands on a
        // neighbour.
        var body = r.labelRows.map(function (row) {
          var pid = 'lp' + (labelPathSeq++);
          return '<path id="' + pid + '" fill="none" d="' +
            row.pts.map(function (p, i) {
              return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
            }).join(' ') + '"/>' +
            '<text data-ink="' + inkBucket(r.labelPx) + '" style="font:600 ' + r.labelPx + 'px Hand, cursive">' +
            '<textPath href="#' + pid + '" startOffset="50%" text-anchor="middle">' +
            escHtml(row.text) + '</textPath></text>';
        }).join('');
        // The svg is sized to the lettering alone, not the whole tile:
        // a tile-sized overlay per bird makes the compositor repaint the
        // illustration underneath it, which shows up as half-drawn birds.
        // Path coordinates stay tile-local; the viewBox carries the offset.
        var lb = r.labelBox;
        var lw = Math.max(1, Math.ceil(lb.dx1 - lb.dx0));
        var lh = Math.max(1, Math.ceil(lb.dy1 - lb.dy0));
        btn.insertAdjacentHTML('beforeend',
          '<svg class="gtile-label" aria-hidden="true" style="left:' + lb.dx0.toFixed(1) +
          'px;top:' + lb.dy0.toFixed(1) + 'px;width:' + lw + 'px;height:' + lh + 'px"' +
          ' viewBox="' + lb.dx0.toFixed(1) + ' ' + lb.dy0.toFixed(1) + ' ' + lw + ' ' + lh + '">' +
          body + '</svg>');
      }
      r.el = btn;
      collage.appendChild(btn);
    });
    // Hover pill - created once per render so collage.innerHTML='' at
    // the top of this function doesn't strand a stale node. mousemove
    // populates its text from hit.data so the count is whatever the
    // current window's data says.
    var tip = document.createElement('div');
    tip.id = 'collageTip';
    tip.className = 'collage-tip';
    tip.setAttribute('aria-hidden', 'true');
    collage.appendChild(tip);
    // Stash the placed tiles so the alpha-mask hit-tester (below) can
    // resolve which silhouette the cursor is actually over.
    collagePlaced = placed.filter(function (t) { return t.x > -1000; });

    // Bloom the birds in from the centre outward, but only when asked
    // (first load, window change, view switch) - never on the silent 30s
    // poll or a resize, which render without the animate flag.
    if (animate) playCollageEntrance();
  }

  // Staggered centre-out entrance: each tile fades + scales in, delayed by
  // its distance from the collage centre, so the flock blooms from the
  // middle out. Re-applied with a reflow reset so it can replay on demand
  // (e.g. switching back to the collage view).
  var collageEntranceT = null;
  function playCollageEntrance() {
    var tiles = [].slice.call(collage.querySelectorAll('.gtile'));
    if (!tiles.length) return;
    var cx = collage.clientWidth / 2, cy = collage.clientHeight / 2;
    var maxD = 1;
    var info = tiles.map(function (t) {
      var d = Math.hypot((t.offsetLeft + t.offsetWidth / 2) - cx,
        (t.offsetTop + t.offsetHeight / 2) - cy);
      if (d > maxD) maxD = d;
      return { el: t, d: d };
    });
    var SPREAD = 520;   // ms from the centre bird to the outermost
    info.forEach(function (o) {
      o.el.classList.remove('entering');
      o.el.style.animationDelay = ((o.d / maxD) * SPREAD).toFixed(0) + 'ms';
    });
    void collage.offsetWidth;   // commit the reset so the animation replays
    info.forEach(function (o) { o.el.classList.add('entering'); });
    // Safety net: the keyframe starts the tiles hidden (backwards fill), so
    // if the animation never advances (a backgrounded/throttled tab where
    // CSS animation time is frozen), strip the class after the bloom's
    // worst-case duration so the birds always end visible. A no-op when the
    // animation ran normally - it's already at the base (visible) state.
    clearTimeout(collageEntranceT);
    collageEntranceT = setTimeout(function () {
      info.forEach(function (o) { o.el.classList.remove('entering'); o.el.style.animationDelay = ''; });
    }, SPREAD + 520);
  }

  // Atlas entrance: cards rise + fade in visual bands, top to bottom. Every
  // sort uses the painted masonry positions so the entrance follows the wall
  // visitors actually see rather than an underlying data order.
  var atlasEntranceT = null;
  // lead: ms to hold every card hidden before the cascade starts. On a view
  // switch this is set to ~the view-slide duration so the row-by-row load-in
  // begins as the view settles (not while it's still sliding in). The cards'
  // `backwards` fill keeps them hidden during the lead, so there's no flash.
  // In-place re-renders (sort change) pass no lead - they fire immediately.
  function playAtlasEntrance(lead) {
    lead = lead || 0;
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;
    var cards = [].slice.call(grid.querySelectorAll('.bird-card'));
    if (!cards.length) return;
    var rowOf = {};
    var uniqTops = cards.map(function (c) { return c.offsetTop; })
      .sort(function (a, b) { return a - b; })
      .filter(function (v, i, a) { return i === 0 || v !== a[i - 1]; });
    uniqTops.forEach(function (t, i) { rowOf[t] = i; });
    // Each row trails the one above by PER_ROW ms. At 90ms against the 480ms
    // card animation the rows clearly cascade top-to-bottom (a row starts when
    // the one above is ~1/5 in) instead of reading as one simultaneous fade.
    // MAX_ROW caps the stagger so a long lifelist's off-screen rows don't crawl.
    var PER_ROW = 90, MAX_ROW = 10;
    cards.forEach(function (c) {
      c.classList.remove('entering');
      var row = rowOf[c.offsetTop] || 0;
      c.style.animationDelay = (lead + Math.min(row, MAX_ROW) * PER_ROW) + 'ms';
    });
    void grid.offsetWidth;
    cards.forEach(function (c) { c.classList.add('entering'); });
    clearTimeout(atlasEntranceT);
    atlasEntranceT = setTimeout(function () {
      cards.forEach(function (c) { c.classList.remove('entering'); c.style.animationDelay = ''; });
    }, lead + MAX_ROW * PER_ROW + 540);
  }

  // Stats entrance: timeline columns fade in left -> right (by their x
  // position), with the side panel fading in just behind. Opacity only.
  var statsEntranceT = null;
  // lead: see playAtlasEntrance. On a view switch the whole graph is held
  // hidden until the slide settles, then populates left-to-right; in-place
  // re-renders (window-picker change) pass no lead and animate immediately.
  function playStatsEntrance(lead) {
    lead = lead || 0;
    var plot = document.querySelector('.stats-tl-plot');
    if (!plot) return;
    var SPREAD = 460;
    // The whole graph populates left-to-right: columns, gridlines and
    // x-ticks stagger by their x%; the y-axis leads (delay 0) and the side
    // panel trails. animationDelay carries the per-element offset.
    var items = [].slice.call(plot.querySelectorAll('.stats-tl-col, .stats-tl-gridline, .stats-tl-xtick'))
      .map(function (el) { return { el: el, d: ((parseFloat(el.style.left) || 0) / 100) * SPREAD }; });
    var yaxis = document.querySelector('.stats-tl-yaxis');
    if (yaxis) items.push({ el: yaxis, d: 0 });
    // Side panel loads in tandem: section headers + captions lead, then
    // their rows populate top-to-bottom over the same window as the graph.
    var side = document.querySelector('.stats-side');
    if (side) {
      [].slice.call(side.querySelectorAll('h3, small')).forEach(function (el) { items.push({ el: el, d: 40 }); });
      var rows = [].slice.call(side.querySelectorAll('li'));
      rows.forEach(function (el, i) { items.push({ el: el, d: 80 + (i / Math.max(1, rows.length - 1)) * SPREAD }); });
    }
    // The rhythm strip trails the side panel slightly, like a footnote.
    var rhy = document.querySelector('.stats-rhythm');
    if (rhy) {
      [].slice.call(rhy.querySelectorAll('h3, small')).forEach(function (el) { items.push({ el: el, d: 40 }); });
      var rhp = rhy.querySelector('.rh-plot');
      if (rhp) items.push({ el: rhp, d: 140 });
    }
    items.forEach(function (o) { o.el.classList.remove('entering'); o.el.style.animationDelay = Math.round(lead + o.d) + 'ms'; });
    void plot.offsetWidth;
    items.forEach(function (o) { o.el.classList.add('entering'); });
    clearTimeout(statsEntranceT);
    statsEntranceT = setTimeout(function () {
      items.forEach(function (o) { o.el.classList.remove('entering'); o.el.style.animationDelay = ''; });
    }, lead + SPREAD + 560);
  }

  // ---- Alpha-mask hover/click hit-testing ----
  // The .gtile buttons are rectangles and their bounding boxes overlap
  // (tight nesting). A plain :hover would light up whichever rectangle
  // is on top - often not the bird under the cursor. So we hit-test
  // the cursor against each tile's binary alpha mask and only the
  // genuinely-hit silhouette gets .is-hover / receives the click.
  var collagePlaced = [];
  var collageHovered = null;
  function maskHitTest(clientX, clientY) {
    var box = collage.getBoundingClientRect();
    var px = clientX - box.left, py = clientY - box.top;
    // Iterate topmost-first (later in DOM = painted on top).
    for (var i = collagePlaced.length - 1; i >= 0; i--) {
      var t = collagePlaced[i];
      if (px < t.x || py < t.y || px > t.x + t.fullW || py > t.y + t.fullH) continue;
      var mx = ((px - t.x) / t.fullW * t.mask.w) | 0;
      var my = ((py - t.y) / t.fullH * t.mask.h) | 0;
      // Build a fast lookup set once per mask.
      if (!t.mask._set) {
        var set = {};
        var cells = t.mask.cells;
        for (var c = 0; c < cells.length; c++) set[cells[c][0] + '|' + cells[c][1]] = 1;
        t.mask._set = set;
      }
      if (t.mask._set[mx + '|' + my]) return t;
    }
    return null;
  }
  collage.addEventListener('mousemove', function (ev) {
    var hit = maskHitTest(ev.clientX, ev.clientY);
    if (hit === collageHovered) return;
    if (collageHovered && collageHovered.el) collageHovered.el.classList.remove('is-hover');
    collageHovered = hit;
    if (hit && hit.el) hit.el.classList.add('is-hover');
    collage.style.cursor = hit ? 'pointer' : 'default';
    var tip = document.getElementById('collageTip');
    if (tip) {
      // With labels on, every bird already wears its name - the pill
      // would just say it twice.
      if (hit && !labelsOn()) {
        var s = hit.data;
        var n = +s.n || 0;
        var noun = (n === 1) ? 'call' : 'calls';
        tip.innerHTML = '<span class="ct-name">' + (s.com || s.sci) + '</span>'
          + '<span class="ct-w"> - </span>'
          + '<span class="ct-n">' + fmtN(n) + '</span>'
          + '<span class="ct-w"> ' + noun + ' ' + windowLabel(currentHours) + '</span>';
        tip.setAttribute('aria-hidden', 'false');
      } else {
        tip.setAttribute('aria-hidden', 'true');
      }
    }
  });
  collage.addEventListener('mouseleave', function () {
    if (collageHovered && collageHovered.el) collageHovered.el.classList.remove('is-hover');
    collageHovered = null;
    var tip = document.getElementById('collageTip');
    if (tip) tip.setAttribute('aria-hidden', 'true');
  });
  collage.addEventListener('click', function (ev) {
    var hit = maskHitTest(ev.clientX, ev.clientY);
    if (!hit) return;
    location.hash = '#sci=' + encodeURIComponent(hit.data.sci);
    go(2);
  });

  // Debug hook - call __layout({ slugs, weights, n }) from devtools to
  // re-render the collage with a custom item set. Lets us prove the
  // nester handles 6/12/24/48 birds and varied size hierarchies without
  // touching the source.
  window.__layout = function (opts) {
    opts = opts || {};
    var allSlugs = Object.keys({ "acanthis-flammea": [560, 372], "accipiter-cooperii": [558, 560], "accipiter-gentilis": [558, 560], "accipiter-striatus": [375, 560], "actitis-macularius": [560, 409], "aechmophorus-occidentalis": [525, 560], "aegolius-acadicus": [560, 558], "aeronautes-saxatalis": [560, 439], "agelaius-phoeniceus": [276, 560], "aix-sponsa": [560, 378], "ammodramus-savannarum": [560, 436], "amphispiza-bilineata": [560, 559], "anas-crecca": [560, 288], "anas-platyrhynchos": [558, 560], "anser-albifrons": [560, 439], "anthus-rubescens": [375, 560], "aphelocoma-californica": [560, 373], "aphelocoma-woodhouseii": [468, 560], "aquila-chrysaetos": [437, 560], "archilochus-alexandri": [560, 344], "ardea-alba": [560, 465], "ardea-herodias": [560, 373], "artemisiospiza-belli": [560, 435], "asio-flammeus": [560, 560], "asio-otus": [404, 560], "athene-cunicularia": [560, 373], "aythya-affinis": [560, 372], "aythya-americana": [560, 553], "aythya-collaris": [560, 373], "aythya-valisineria": [560, 373], "baeolophus-inornatus": [560, 311], "bombycilla-cedrorum": [339, 560], "bombycilla-garrulus": [560, 559], "branta-canadensis": [560, 559], "bubo-virginianus": [373, 560], "bubulcus-ibis": [267, 560], "bucephala-albeola": [560, 408], "bucephala-clangula": [560, 242], "buteo-jamaicensis": [560, 374], "buteo-lagopus": [560, 244], "buteo-lineatus": [463, 560], "buteo-regalis": [408, 560], "buteo-swainsoni": [560, 408], "butorides-virescens": [555, 560], "calamospiza-melanocorys": [560, 374], "calidris-alba": [560, 371], "calidris-alpina": [560, 374], "callipepla-californica": [560, 372], "calothorax-lucifer": [465, 560], "calypte-anna": [560, 344], "calypte-costae": [560, 409], "cardellina-pusilla": [560, 281], "cardellina-rubrifrons": [527, 560], "cathartes-aura": [376, 560], "catharus-guttatus": [560, 333], "catharus-ustulatus": [560, 408], "catherpes-mexicanus": [320, 560], "certhia-americana": [201, 560], "chaetura-vauxi": [560, 374], "charadrius-vociferus": [560, 408], "chondestes-grammacus": [560, 559], "chordeiles-minor": [560, 319], "cinclus-mexicanus": [560, 465], "circus-hudsonius": [372, 560], "cistothorus-palustris": [437, 560], "coccothraustes-vespertinus": [560, 466], "colaptes-auratus": [560, 560], "columba-livia": [560, 327], "columbina-passerina": [560, 559], "contopus-sordidulus": [560, 502], "coragyps-atratus": [560, 557], "corvus-brachyrhynchos": [560, 503], "corvus-corax": [343, 560], "cyanocitta-stelleri": [363, 560], "cygnus-buccinator": [560, 370], "cypseloides-niger": [560, 356], "dryobates-nuttallii": [560, 321], "dryobates-pubescens": [560, 558], "dryobates-villosus": [268, 560], "dryocopus-pileatus": [492, 560], "egretta-caerulea": [560, 321], "egretta-thula": [560, 374], "elanus-leucurus": [560, 378], "empidonax-difficilis": [268, 560], "empidonax-hammondii": [558, 560], "empidonax-oberholseri": [495, 560], "empidonax-traillii": [371, 560], "empidonax-wrightii": [560, 527], "eremophila-alpestris": [560, 529], "euphagus-cyanocephalus": [560, 371], "falco-columbarius": [560, 408], "falco-mexicanus": [349, 560], "falco-peregrinus": [465, 560], "falco-sparverius": [560, 370], "gavia-immer": [560, 374], "geothlypis-tolmiei": [560, 406], "geothlypis-trichas": [560, 316], "glaucidium-gnoma": [560, 560], "gymnogyps-californianus": [466, 560], "haemorhous-mexicanus": [523, 560], "haemorhous-purpureus": [560, 387], "haliaeetus-leucocephalus": [560, 434], "himantopus-mexicanus": [458, 560], "hirundo-rustica": [560, 410], "hydroprogne-caspia": [560, 373], "icteria-virens": [560, 293], "icterus-bullockii": [560, 214], "icterus-cucullatus": [391, 560], "icterus-galbula": [560, 528], "icterus-parisorum": [560, 266], "ixoreus-naevius": [560, 558], "junco-hyemalis": [560, 320], "lanius-ludovicianus": [408, 560], "larus-californicus": [560, 437], "larus-delawarensis": [560, 376], "larus-glaucescens": [560, 374], "larus-heermanni": [560, 436], "larus-occidentalis": [560, 412], "leiothlypis-celata": [522, 560], "leiothlypis-lucidae": [351, 560], "leucophaeus-atricilla": [560, 373], "leucophaeus-pipixcan": [560, 560], "leucosticte-tephrocotis": [560, 465], "limosa-fedoa": [560, 556], "lophodytes-cucullatus": [560, 409], "loxia-curvirostra": [560, 319], "mareca-americana": [560, 375], "mareca-strepera": [560, 372], "megaceryle-alcyon": [560, 409], "megascops-kennicottii": [560, 374], "melanerpes-formicivorus": [351, 560], "melanerpes-lewis": [372, 560], "meleagris-gallopavo": [560, 373], "melospiza-georgiana": [320, 560], "melospiza-lincolnii": [560, 245], "melospiza-melodia": [560, 352], "melozone-aberti": [560, 268], "melozone-crissalis": [560, 538], "melozone-fusca": [560, 495], "mergus-merganser": [560, 374], "mimus-polyglottos": [560, 310], "mniotilta-varia": [560, 351], "molothrus-ater": [560, 505], "myadestes-townsendi": [560, 436], "myiarchus-cinerascens": [560, 532], "nucifraga-columbiana": [560, 373], "numenius-americanus": [558, 560], "nycticorax-nycticorax": [560, 465], "oreothlypis-ruficapilla": [372, 560], "pandion-haliaetus": [560, 371], "passer-domesticus": [560, 444], "passerculus-sandwichensis": [560, 542], "passerella-iliaca": [560, 350], "passerina-amoena": [560, 465], "passerina-cyanea": [560, 560], "patagioenas-fasciata": [560, 500], "pelecanus-erythrorhynchos": [560, 316], "pelecanus-occidentalis": [560, 406], "perisoreus-canadensis": [560, 349], "petrochelidon-pyrrhonota": [558, 560], "phainopepla-nitens": [560, 464], "phalacrocorax-auritus": [490, 560], "phalaenoptilus-nuttallii": [560, 373], "phasianus-colchicus": [560, 409], "pheucticus-melanocephalus": [559, 560], "pica-nuttalli": [560, 320], "picoides-arcticus": [374, 560], "pinicola-enucleator": [560, 372], "pipilo-chlorurus": [560, 318], "pipilo-erythrophthalmus": [352, 560], "pipilo-maculatus": [443, 560], "piranga-ludoviciana": [293, 560], "piranga-rubra": [560, 495], "plegadis-chihi": [560, 372], "podiceps-nigricollis": [560, 374], "podilymbus-podiceps": [560, 374], "poecile-gambeli": [560, 350], "poecile-rufescens": [560, 339], "polioptila-caerulea": [560, 557], "pooecetes-gramineus": [560, 436], "progne-subis": [313, 560], "psaltriparus-minimus": [560, 428], "quiscalus-mexicanus": [560, 269], "recurvirostra-americana": [268, 560], "regulus-calendula": [496, 560], "regulus-satrapa": [464, 560], "riparia-riparia": [560, 494], "rynchops-niger": [560, 374], "salpinctes-obsoletus": [560, 465], "sayornis-nigricans": [308, 560], "sayornis-saya": [463, 560], "selasphorus-platycercus": [560, 497], "selasphorus-rufus": [560, 436], "selasphorus-sasin": [434, 560], "setophaga-coronata": [461, 560], "setophaga-magnolia": [560, 268], "setophaga-nigrescens": [560, 350], "setophaga-occidentalis": [560, 367], "setophaga-palmarum": [438, 560], "setophaga-petechia": [560, 268], "setophaga-ruticilla": [560, 293], "setophaga-townsendi": [560, 416], "sialia-currucoides": [558, 560], "sialia-mexicana": [560, 371], "sitta-canadensis": [560, 379], "sitta-carolinensis": [436, 560], "sitta-pygmaea": [560, 407], "spatula-clypeata": [560, 408], "spatula-discors": [560, 493], "sphyrapicus-ruber": [560, 558], "sphyrapicus-thyroideus": [374, 560], "spinus-lawrencei": [560, 373], "spinus-pinus": [560, 516], "spinus-psaltria": [560, 548], "spinus-tristis": [536, 560], "spizella-atrogularis": [246, 560], "spizella-breweri": [560, 557], "spizella-passerina": [560, 320], "spizelloides-arborea": [560, 436], "stelgidopteryx-serripennis": [558, 560], "sterna-forsteri": [560, 373], "sterna-hirundo": [560, 411], "streptopelia-decaocto": [560, 393], "strix-occidentalis": [560, 553], "sturnella-neglecta": [320, 560], "sturnus-vulgaris": [560, 545], "tachycineta-bicolor": [375, 560], "tachycineta-thalassina": [560, 435], "thalasseus-elegans": [560, 407], "thryomanes-bewickii": [560, 263], "toxostoma-redivivum": [560, 298], "tringa-semipalmata": [560, 464], "troglodytes-aedon": [560, 494], "troglodytes-pacificus": [560, 407], "turdus-migratorius": [560, 402], "tyrannus-verticalis": [559, 560], "tyrannus-vociferans": [495, 560], "tyto-alba": [560, 464], "urile-penicillatus": [296, 560], "vireo-bellii": [560, 559], "vireo-cassinii": [560, 319], "vireo-gilvus": [464, 560], "vireo-huttoni": [410, 560], "xanthocephalus-xanthocephalus": [293, 560], "zenaida-asiatica": [560, 558], "zenaida-macroura": [522, 560], "zonotrichia-atricapilla": [560, 238], "zonotrichia-leucophrys": [560, 313], "zonotrichia-querula": [560, 294] });
    var slugs = opts.slugs || allSlugs.slice(0, opts.n || 12);
    var weights = opts.weights;
    var items = slugs.map(function (slug, i) {
      // Recover a sci name from the slug - capitalize first segment.
      var parts = slug.split('-');
      var sci = parts.slice(0, 2).map(function (p, j) { return j === 0 ? p[0].toUpperCase() + p.slice(1) : p; }).join(' ');
      var n;
      if (weights === 'uniform') n = 10;
      else if (weights === 'extreme') n = i === 0 ? 500 : 1;
      else if (Array.isArray(weights)) n = weights[i] || 1;
      else n = Math.pow(0.55, i) * 100; // default hierarchy
      return { sci: sci, com: sci, n: n };
    });
    renderCollage(items);
    return { rendered: items.length, mode: weights || 'hierarchy' };
  };

  // Collage renders whatever is in DATA.recent.species. When the picker
  // changes, refreshRecent() refetches and re-renders. Empty state shows
  // the shared "no detections heard in this window" message.
  function renderCollageFromData(animate) {
    var items = (DATA.recent && DATA.recent.species) || [];
    renderCollage(items, animate);
  }
  var rTimer;
  window.addEventListener('resize', function () {
    clearTimeout(rTimer);
    rTimer = setTimeout(function () {
      renderCollageFromData();
      drawHistograms();
    }, 120);
  });

  // ---- Stats / Atlas data ----
  function setRow(id, label, val) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '<span>' + label + '</span><span>' + (val == null || val === '' ? '-' : val) + '</span>';
  }
  function liRow(yr, label, ct, sci) {
    var attr = sci ? ' data-sci="' + sci.replace(/"/g, '&quot;') + '"' : '';
    return '<li' + attr + '><span class="yr">' + yr + '</span><span>' + label + '</span><span class="ct">' + (ct == null ? '-' : ct) + '</span></li>';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtN(n) {
    if (n == null) return '-';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return n.toLocaleString();
  }
  // Compact count for atlas cards (1K, 1.2K); the modal keeps the exact number.
  function fmtNK(n) {
    if (n == null) return '-';
    return n < 1000 ? n.toLocaleString() : +(n / 1000).toFixed(1) + 'K';
  }
  // Human label for the current time-window picker selection - replaces
  // a bare "window" with the span it actually covers. Thresholds match
  // the winPick buttons (1H / 12H / 24H / 7D / ALL).
  function windowLabel(h) {
    if (h <= 1) return 'this hour';
    if (h <= 12) return 'past 12h';
    if (h <= 24) return 'today';
    if (h <= 168) return 'this week';
    return 'all time';
  }
  function statsWindowLabel(h) {
    if (!hourlyDate) return windowLabel(h);
    if (h <= 1) return 'selected hour';
    if (h <= 12) return 'final 12h';
    if (h <= 24) return 'selected day';
    if (h <= 168) return 'selected 7 days';
    return 'through selected day';
  }

  // ---- Live Pi data layer ----
  // All views read from this DATA object. Populated by fetchAll() on page
  // load and by refreshRecent() when the window picker changes.
  var STATS_DAYS = 30;
  var DATA = {
    stats: null,        // ./avian/api/birdnet-api.php?action=stats (totals/today/week/last_hour/started)
    lifelist: null,     // ./avian/api/birdnet-api.php?action=lifelist (every species ever detected)
    timeseries: null,   // ./avian/api/birdnet-api.php?action=timeseries (daily + hourly aggregates)
    firstseen: null,    // ./avian/api/birdnet-api.php?action=firstseen (newest lifelist additions)
    recent: null,       // ./avian/api/birdnet-api.php?action=recent&hours=N (refetched on picker change)
    statsRecent: null,  // same shape as recent, anchored by the Stats date pager
    rhythm: null,       // ./avian/api/birdnet-api.php?action=rhythm (selected pulse + prior-period average)
    hourly: null,       // ./avian/api/birdnet-api.php?action=hourly (species-by-hour ledger, one day)
    calendar: null,     // ./avian/api/birdnet-api.php?action=calendar (dates with detections)
  };

  // Derived chart arrays, backfilled so 30 buckets always exist.
  var STATS = {
    detPerDay: new Array(STATS_DAYS).fill(0), // [day] total detections
    specPerDay: new Array(STATS_DAYS).fill(0), // [day] unique species
    byHour: new Array(24).fill(0),         // [hour-of-day] detections
  };

  // Map sci -> all-time detection count, populated from lifelist for atlas.
  var speciesTotals = {};

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  function backfillDaily(daily, days) {
    // Build a continuous array of (days) length, ending today.
    var byDate = {};
    (daily || []).forEach(function (row) { byDate[row.date] = row; });
    var out = new Array(days).fill(null).map(function () { return { detections: 0, species: 0 }; });
    var today = new Date();
    for (var i = 0; i < days; i++) {
      var d = new Date(today);
      d.setDate(today.getDate() - (days - 1 - i));
      var key = d.toISOString().slice(0, 10);
      if (byDate[key]) {
        out[i].detections = +byDate[key].detections || 0;
        out[i].species = +byDate[key].species || 0;
      }
    }
    return out;
  }

  function recomputeDerived() {
    var ts = DATA.timeseries || { daily: [], by_hour: [] };
    var ll = DATA.lifelist || { species: [] };
    var rows = backfillDaily(ts.daily, STATS_DAYS);
    STATS.detPerDay = rows.map(function (r) { return r.detections; });
    STATS.specPerDay = rows.map(function (r) { return r.species; });
    var byHour = new Array(24).fill(0);
    (ts.by_hour || []).forEach(function (r) { byHour[+r.hour] = +r.detections; });
    STATS.byHour = byHour;
    speciesTotals = {};
    (ll.species || []).forEach(function (s) { speciesTotals[s.sci] = +s.n; });
  }

  // Editorial detection timeline. One evenly-spaced column per species,
  // ordered oldest -> newest by last detection (x = time). Each species
  // owns a cell, so the black squares never overlap and a square fills
  // its column width - neighbours touch at the shared gridline. The
  // square's height up the column encodes detection count; a small
  // rotated label (common + scientific name) sits at the column's
  // bottom, and each column carries its own timestamp on the x-axis.
  function drawHistograms(animate) {
    var tl = document.getElementById('statsTimeline');
    if (!tl) return;
    var all = ((DATA.statsRecent && DATA.statsRecent.species) || []).slice();
    if (!all.length) {
      tl.innerHTML = '<div class="stats-data-empty window-empty">' + EMPTY_WINDOW_COPY + '</div>';
      return;
    }

    // Discrete columns. On a phone the columns are fixed-width and wider
    // (legible squares + labels for touch) and the plot grows past the
    // viewport to scroll horizontally - so we show ALL species rather than
    // trimming. On desktop, cap to whatever fits the available width.
    var isMobile = (window.innerWidth || 800) <= 700;
    var containerW = Math.max(140, (tl.clientWidth || window.innerWidth || 800) - 34);
    var MIN_COL = isMobile ? 52 : 22;
    var cap = isMobile ? all.length : Math.max(3, Math.floor(containerW / MIN_COL));
    var trimmed = all.length > cap;
    var species = all.slice();
    if (trimmed) {
      species.sort(function (a, b) { return (+b.n || 0) - (+a.n || 0); });
      species = species.slice(0, cap);
    }
    // X-axis is time: order the chosen columns oldest -> newest.
    function parseTs(s) { return s ? Date.parse(s.replace(' ', 'T')) : NaN; }
    species.sort(function (a, b) {
      var ta = parseTs(a.last_seen), tb = parseTs(b.last_seen);
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return ta - tb;
    });

    var C = species.length;
    var maxN = species.reduce(function (m, s) { return Math.max(m, +s.n || 0); }, 1);
    // Mobile: fixed wide columns -> plot can exceed the viewport and scroll.
    // Desktop: columns split the available width evenly.
    var colW = isMobile ? MIN_COL : (containerW / C);
    var plotW = isMobile ? Math.max(containerW, C * colW) : containerW;
    // Square fills its column so adjacent squares touch at the shared
    // gridline; capped so a few species don't render as giant blocks.
    var sq = Math.max(6, Math.min(colW, isMobile ? 60 : 48));
    var LABEL_GAP = 6;       // px between a square's top and its label
    var SPAN = 0.55;         // squares occupy the bottom this fraction of
    // the plot by count (y = quantity); the
    // rotated label floats just above each square.

    // Y-axis quantity ticks: 0..maxN, with maxN pinned on the top tick.
    var ticks = [];
    if (maxN <= 8) {
      for (var v = 0; v <= maxN; v++) ticks.push(v);
    } else {
      var divs = 4;
      for (var di = 0; di <= divs; di++) ticks.push(Math.round(maxN * di / divs));
      ticks[ticks.length - 1] = maxN;
    }
    var yaxis = ticks.map(function (v) {
      return '<span class="stats-tl-ytick" style="bottom:' + ((v / maxN) * SPAN * 100).toFixed(1) + '%">' + v + '</span>';
    }).join('');

    // One timestamp under each column - format follows the window length.
    function fmtTs(ms) {
      if (isNaN(ms)) return '';
      var d = new Date(ms);
      var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
      if (currentHours <= 36) return p2(d.getHours()) + ':' + p2(d.getMinutes());
      if (currentHours <= 75 * 24) return (d.getMonth() + 1) + '/' + d.getDate();
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // Faint gridlines at every column boundary. Start at gi=1: the gi=0
    // line would sit on top of the y-axis rule (double line), so skip it.
    var gridlines = '';
    for (var gi = 1; gi <= C; gi++) {
      var pickClass = gi > C - 3 ? ' pick-clear' : (gi === C - 3 ? ' pick-approach' : '');
      gridlines += '<i class="stats-tl-gridline' + pickClass
        + '" style="left:' + (gi / C * 100).toFixed(3) + '%"></i>';
    }

    // A stamp under every column is unreadable: twenty of them in the space of
    // a chart run together into a grey band. Work out how many actually fit at
    // this width and show every Nth, always keeping the first and the last so
    // the axis still states its own range.
    var stampW = currentHours <= 36 ? 42 : 38;   // "07:45" against "Jul 21"
    var fits = Math.max(2, Math.floor(plotW / stampW));
    var stride = Math.max(1, Math.ceil(C / fits));

    var cols = '', xaxis = '';
    species.forEach(function (s, i) {
      var centerPct = (i + 0.5) / C * 100;
      var n = +s.n || 0;
      var bottomPct = (n / maxN) * SPAN * 100;   // square height = quantity
      cols += ''
        + '<div class="stats-tl-col" data-sci="' + s.sci + '" style="left:' + centerPct.toFixed(3) + '%;width:' + colW.toFixed(2) + 'px">'
        + '<div class="stats-tl-square" style="bottom:' + bottomPct.toFixed(1) + '%;width:' + sq.toFixed(1) + 'px;height:' + sq.toFixed(1) + 'px"></div>'
        + '<div class="stats-tl-label" style="bottom:calc(' + bottomPct.toFixed(1) + '% + ' + (sq + LABEL_GAP) + 'px)"><span class="com">' + (s.com || s.sci) + '</span><span class="sci">' + s.sci + '</span></div>'
        + '</div>';
      var showStamp = (i % stride === 0) || (i === C - 1);
      var lab = showStamp ? fmtTs(parseTs(s.last_seen)) : '';
      if (lab) xaxis += '<span class="stats-tl-xtick" style="left:' + centerPct.toFixed(3) + '%">' + lab + '</span>';
    });

    var note = trimmed
      ? '<div class="stats-tl-cap">' + C + ' most-heard of ' + all.length + '</div>'
      : '';
    tl.innerHTML =
      '<div class="stats-tl-yaxis">' + yaxis + '</div>'
      + '<div class="stats-tl-plot"' + (isMobile ? ' style="width:' + Math.round(plotW) + 'px"' : '') + '>'
      + gridlines + cols + xaxis
      + '</div>'
      + note;
    if (animate) playStatsEntrance();
  }

  // Cross-highlight between the timeline squares and the right-side
  // species lists. Delegated off the stats view so it survives the
  // periodic re-render of both halves.
  (function wireStatsHighlight() {
    var v1 = document.getElementById('v1');
    if (!v1) return;
    function setHi(sci, on) {
      if (!sci) return;
      var esc = sci.replace(/"/g, '\"');
      v1.querySelectorAll('.stats-tl-col[data-sci="' + esc + '"], .stats-side li[data-sci="' + esc + '"]')
        .forEach(function (el) { el.classList.toggle('sync-hi', on); });
    }
    v1.addEventListener('mouseover', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-sci]');
      if (el) setHi(el.getAttribute('data-sci'), true);
    });
    v1.addEventListener('mouseout', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-sci]');
      if (el) {
        // Only clear if we're actually leaving the element (not moving
        // to a child).
        var to = ev.relatedTarget;
        if (to && el.contains(to)) return;
        setHi(el.getAttribute('data-sci'), false);
      }
    });
  })();

  // ---- Side text lists (real Pi data) ----
  function renderStatsLists() {
    var stats = DATA.stats || {};
    var recent = DATA.statsRecent || { species: [] };
    var firstseen = DATA.firstseen || { species: [] };

    // By Period - pulled directly from ./avian/api/birdnet-api.php?action=stats so the numbers
    // are authoritative (BirdNET-Pi's own counts).
    var last_hour = (stats.last_hour && stats.last_hour.detections) || 0;
    var today_det = (stats.today && stats.today.detections) || 0;
    var week_det = (stats.week && stats.week.detections) || 0;
    var all_det = (stats.totals && stats.totals.detections) || 0;
    var past = stats.is_today === false;
    var byPeriodCap = document.getElementById('statsByPeriodCap');
    var firstSeenCap = document.getElementById('statsFirstSeenCap');
    if (byPeriodCap) byPeriodCap.textContent = past
      ? 'detections through ' + shortStatsDate(stats.date)
      : 'detections, grouped by recency';
    if (firstSeenCap) firstSeenCap.textContent = past
      ? 'life list as of ' + shortStatsDate(stats.date)
      : 'newest additions to the life list';
    document.getElementById('statsByPeriod').innerHTML =
      liRow(past ? 'HOUR' : 'NOW', past ? 'final hour' : 'last hour', fmtN(last_hour))
      + liRow(past ? 'DAY' : 'TODAY', past ? 'selected date' : 'today', fmtN(today_det))
      + liRow('7D', past ? 'through this date' : 'last 7 days', fmtN(week_det))
      + liRow('ALL', past ? 'through this date' : 'all time', fmtN(all_det));

    // Top Species - top 5 species in the current window. ./avian/api/birdnet-api.php?action=recent
    // already returns species sorted by last_seen DESC; re-sort by count.
    var ranked = (recent.species || [])
      .slice()
      .sort(function (a, b) { return (+b.n) - (+a.n); })
      .slice(0, 5);
    document.getElementById('statsTopSpec').innerHTML = ranked.length
      ? ranked.map(function (s, i) { return liRow(pad(i + 1), s.com, fmtN(+s.n), s.sci); }).join('')
      : '<li class="stats-window-empty"><span class="window-empty">' + EMPTY_WINDOW_COPY + '</span></li>';
    document.getElementById('statsTopSpecCap').textContent =
      'most-heard, ' + statsWindowLabel(currentHours);

    // First Detections - newest additions to the life list, with a
    // "Xd ago" label computed from first_seen.
    var fs = (firstseen.species || []).slice(0, 5);
    var anchor = stats.anchor ? Date.parse(stats.anchor.replace(' ', 'T')) : Date.now();
    var now = isNaN(anchor) ? Date.now() : anchor;
    document.getElementById('statsFirstSeen').innerHTML = fs.length
      ? fs.map(function (s) {
        var t = Date.parse((s.first_seen || '').replace(' ', 'T'));
        var label = '-';
        if (!isNaN(t)) {
          var daysAgo = Math.floor((now - t) / 86400000);
          label = daysAgo === 0 ? (past ? 'that day' : 'today') : daysAgo + (past ? 'd prior' : 'd ago');
        }
        return liRow(label, s.com, '', s.sci);
      }).join('')
      : liRow('-', 'no detections yet', '');
  }

  // ---- Day's Rhythm + hourly ledger ----
  // Two today-centric readings folded into the stats view: the rhythm
  // chart under the summary grid, the hourly table behind its own tab.
  // Same idiom as the rest of the view: innerHTML strings, mono ticks,
  // hairline rules; the SVG paths and heat cells carry class hooks so
  // styles.css owns every color in both themes.
  // Like adminEsc below, plus double-quote escaping - these names also
  // land inside attribute values (data-sci).
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function rhPath(pts) {
    return pts.map(function (p, i) {
      return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2);
    }).join(' ');
  }
  // Shared line-chart builder: series -> svg + ticks inside the .rh-plot.
  // series: array of {cls, vals} drawn back-to-front; x labels sparse.
  function rhLineChart(host, series, xLabels, yMax) {
    var W = 100, H = 42, PADB = 2;
    var grid = '', yt = '', xt = '';
    // Integer tick values (~4 of them) so low maxima never produce duplicate
    // labels; positioned in the same coordinate box as the SVG (which is
    // inset 26px left / 18px bottom for the axis strips).
    var step = Math.max(1, Math.ceil(yMax / 4));
    for (var v = step; v <= yMax; v += step) {
      var f = v / yMax;
      grid += '<path class="grid" d="M0 ' + ((H - PADB) * (1 - f)).toFixed(2) + ' H' + W + '"/>';
      yt += '<span class="rh-ytick" style="bottom:calc(18px + (100% - 18px) * ' +
        ((PADB + f * (H - PADB)) / H).toFixed(4) + ')">' + fmtN(v) + '</span>';
    }
    var snap = null;   // snap points for the series that marks track:true
    var trackY = fmtN;
    var paths = series.map(function (s) {
      var span = s.span || 1;   // fraction of the x-domain the series covers
      var pts = s.vals.map(function (v, i) {
        var fx = s.vals.length > 1 ? i / (s.vals.length - 1) : 0;
        return [fx * W * span, (H - PADB) * (1 - Math.min(1, v / yMax))];
      });
      // A series that asks to be tracked emits snap points in the SAME
      // geometry the path drew (x as a 0..1 fraction of the plot), so the
      // hover readout can never disagree with the line under the cursor.
      if (s.track) {
        trackY = s.fmtY || fmtN;
        snap = s.vals.map(function (v, i) {
          var fx = s.vals.length > 1 ? i / (s.vals.length - 1) : 0;
          return { x: fx * span, v: v, xLabel: s.fmtX(i) };
        });
      }
      return '<path class="' + s.cls + '" d="' + rhPath(pts) + '"/>';
    }).join('');
    xLabels.forEach(function (l) {
      xt += '<span class="rh-xtick" style="left:calc(26px + (100% - 26px) * ' + (l.f).toFixed(3) + ')">' + l.text + '</span>';
    });
    host.innerHTML =
      '<svg class="rh-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      grid + paths + '</svg>' + yt + xt;
    // Attach the hover crosshair only when a series opted in. The overlay is
    // generic; this passes it the same y-mapping the paths used so the guides
    // land exactly on the drawn line even through the stretched viewBox.
    if (snap) attachCrosshair(host, {
      svg: host.querySelector('.rh-svg'), points: snap,
      yMax: yMax, H: H, PADB: PADB, fmtY: trackY
    });
  }

  // Reusable hover/scrub crosshair for any rhLineChart-style plot. It knows
  // nothing about birds, only a model: { svg, points:[{x:0..1 fraction, v,
  // xLabel}], yMax, H, PADB, fmtY }. "Do this plot anywhere" = build that
  // model from any chart whose plot area is a box. The stretched
  // preserveAspectRatio=none viewBox is a non-issue because we never convert
  // through SVG user units - we map data fraction -> plot-box CSS pixels.
  function attachCrosshair(host, model) {
    // renderRhythm rewrites host.innerHTML on every 30s poll, wiping the
    // overlay but not the host. Build the overlay fresh each call, but bind
    // the pointer listeners once and let them read a mutable current model.
    var st = host._xh;
    if (!st) {
      st = host._xh = { model: model, box: null, raf: 0, px: 0, last: -1 };
      st.els = {};
      var yPix = function (v) {
        var m = st.model, b = st.box;
        var yUser = (m.H - m.PADB) * (1 - Math.min(1, v / m.yMax));
        return b.top + (yUser / m.H) * b.h;
      };
      var measure = function () {
        // The .rh-svg element's own box IS the plot area. hostVX caches the
        // host viewport x so the move stream turns clientX into a local x with
        // no rect read of its own.
        var pr = st.els.svg.getBoundingClientRect(), hr = host.getBoundingClientRect();
        st.box = { left: pr.left - hr.left, top: pr.top - hr.top, w: pr.width, h: pr.height, hostVX: hr.left };
        st.last = -1;   // geometry moved: force the next place() to repaint
      };
      var place = function (clientX) {
        if (!st.box) measure();
        var m = st.model, b = st.box, e = st.els;
        var frac = (clientX - b.hostVX - b.left) / b.w;
        if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
        // Snap to the nearest real point, never between - "the exact quantity
        // at a certain time". Linear scan so the helper works for uneven x too.
        var best = 0, bd = 2, i;
        for (i = 0; i < m.points.length; i++) {
          var d = Math.abs(m.points[i].x - frac);
          if (d < bd) { bd = d; best = i; }
        }
        if (best === st.last) return;   // still on this hour: nothing to repaint
        st.last = best;
        var p = m.points[best], px = b.left + p.x * b.w, py = yPix(p.v);
        // Only transforms/size/text change here, never a geometry read, so the
        // move stream forces no synchronous layout.
        e.v.style.transform = 'translate(' + px + 'px,' + py + 'px)';
        e.v.style.height = (b.top + b.h - py) + 'px';   // guide down to the x-axis
        e.h.style.transform = 'translate(' + b.left + 'px,' + py + 'px)';
        e.h.style.width = (px - b.left) + 'px';          // guide across to the y-axis
        e.dot.style.transform = 'translate(' + px + 'px,' + py + 'px)';
        e.rx.style.transform = 'translate(calc(' + px + 'px - 50%), 2px)';
        e.ry.style.transform = 'translate(0px, calc(' + py + 'px - 50%))';
        e.rx.textContent = p.xLabel;
        e.ry.textContent = st.model.fmtY(p.v);
      };
      var onMove = function (ev) {
        st.px = ev.clientX;
        if (st.raf) return;
        st.raf = requestAnimationFrame(function () { st.raf = 0; place(st.px); });
      };
      var arm = function (ev) {
        if (!st.els.ov) return;
        measure(); host.classList.add('rh-live'); st.els.ov.classList.add('on'); onMove(ev);
      };
      var disarm = function () {
        host.classList.remove('rh-live');
        if (st.els.ov) st.els.ov.classList.remove('on');
      };
      // Pointer events cover mouse/touch/pen alike; touch-action:pan-y on
      // .rh-plot lets a horizontal scrub own the chart while a vertical drag
      // still pages, and a touch pointer is implicitly captured to the target
      // so the scrub never bubbles into a page gesture.
      host.addEventListener('pointerenter', arm);
      host.addEventListener('pointerdown', arm);
      host.addEventListener('pointermove', onMove);
      host.addEventListener('pointerleave', disarm);
      host.addEventListener('pointercancel', disarm);
      window.addEventListener('resize', function () { st.box = null; });
    }
    st.model = model;
    st.box = null;   // geometry changed with the re-render; re-measure on arm
    var ov = document.createElement('div'); ov.className = 'rh-xhair';
    ov.innerHTML =
      '<div class="rh-xh-h"></div><div class="rh-xh-v"></div><div class="rh-xh-dot"></div>' +
      '<div class="rh-xh-rx"></div><div class="rh-xh-ry"></div>';
    host.appendChild(ov);
    st.els.ov = ov; st.els.svg = model.svg;
    st.els.v = ov.querySelector('.rh-xh-v'); st.els.h = ov.querySelector('.rh-xh-h');
    st.els.dot = ov.querySelector('.rh-xh-dot');
    st.els.rx = ov.querySelector('.rh-xh-rx'); st.els.ry = ov.querySelector('.rh-xh-ry');
  }
  function renderRhythm() {
    var host = document.getElementById('statsRhythm');
    if (!host) return;
    var r = DATA.rhythm;
    var title = document.getElementById('statsRhythmTitle');
    var cap = document.getElementById('statsRhythmCap');
    if (title && cap) {
      if (r && r.mode === 'week') {
        title.textContent = "Week's Rhythm";
        cap.textContent = 'average day in this 7-day window, over the previous 7 days';
      } else if (currentHours <= 1) {
        title.textContent = "Hour's Rhythm";
        cap.textContent = 'detections through the selected hour, over the prior week\'s average';
      } else if (!hourlyDate && DATA.stats && DATA.stats.is_today && currentHours < 1000000) {
        title.textContent = "Today's Rhythm";
        cap.textContent = currentHours <= 12
          ? 'detections through the current 12-hour window, over last week\'s average'
          : 'detections through the day, over last week\'s average';
      } else {
        title.textContent = "Day's Rhythm";
        cap.textContent = 'detections on the selected date, over the prior week\'s average';
      }
    }
    if (!r || (!(r.today || []).length && !(r.avg || []).length)) {
      host.innerHTML = '<div class="stats-data-empty window-empty">' + EMPTY_WINDOW_COPY + '</div>'; return;
    }
    // The day arrives minute by minute (slot 0..1439). Raw per-minute counts
    // are mostly 0 or 1 and read as noise, so the line is a Gaussian-smoothed
    // rate: birds call in bursts and lulls, and the smoothing is what turns
    // that into the continuous pulse the eye reads. The value is scaled to
    // detections per hour so the axis and readout stay in familiar numbers
    // rather than a fraction of a call per minute.
    var SLOTS = r.slots || 1440, LAST = SLOTS - 1;
    var rawToday = [], rawAvg = [], k;
    for (k = 0; k < SLOTS; k++) { rawToday[k] = 0; rawAvg[k] = 0; }
    (r.today || []).forEach(function (x) { rawToday[x.slot] = x.detections; });
    (r.avg || []).forEach(function (x) { rawAvg[x.slot] = x.avg; });
    var startS = Math.max(0, Math.min(LAST, +r.range_start_slot || 0));
    var endS = Math.max(startS, Math.min(LAST,
      typeof r.range_end_slot === 'number' ? r.range_end_slot : LAST));
    var sigma = currentHours <= 1 ? 4 : currentHours <= 12 ? 12 : 18;
    var todayRaw = rawToday.slice(startS, endS + 1);
    var avgRaw = rawAvg.slice(startS, endS + 1);
    var todaySum = todayRaw.reduce(function (a, b) { return a + b; }, 0);
    var today = rhSmooth(todayRaw, sigma), avg = rhSmooth(avgRaw, sigma);
    var yMax = Math.max(1, Math.max.apply(null, today.concat(avg)));
    // Draw the day's line only through the current minute; minutes that have
    // not happened yet are not zeros, they just have not happened. now_slot is
    // the station's own, and a past day reports the last minute so its line is
    // whole.
    var nowS = Math.max(startS, Math.min(endS,
      typeof r.now_slot === 'number' ? r.now_slot : endS));
    var domainLast = Math.max(1, endS - startS);
    var fmtMin = function (i) {
      var slot = startS + i;
      return pad(Math.floor(slot / 60)) + ':' + pad(slot % 60);
    };
    var fmtRate = function (v) { return Math.round(v) + '/hr'; };
    var ticks = [], tickCount = Math.min(4, domainLast);
    for (var ti = 0; ti <= tickCount; ti++) {
      var sl = startS + Math.round(domainLast * ti / tickCount);
      ticks.push({ f: (sl - startS) / domainLast, text: pad(Math.floor(sl / 60)) + ':' + pad(sl % 60) });
    }
    rhLineChart(host,
      [{ cls: 'ln-avg', vals: avg,
         track: todaySum === 0, fmtX: fmtMin, fmtY: fmtRate },
       { cls: 'ln-today', vals: today.slice(0, nowS - startS + 1),
         span: Math.max(0.001, (nowS - startS) / domainLast),
         track: todaySum > 0, fmtX: fmtMin, fmtY: fmtRate }],
      ticks,
      yMax);
  }
  // Gaussian smoothing of a per-minute series into a continuous rate, expressed
  // as detections per hour. A weighted local mean (normalised per point) keeps
  // the ends from sagging, and sigma sets how much the bursts merge: about 18
  // minutes reads as a pulse without flattening the morning peak.
  var rhKernels = {};
  function rhSmooth(a, sigma) {
    var n = a.length, sig = sigma || 18, rad = Math.ceil(sig * 3), i, j;
    var rhKernel = rhKernels[sig];
    if (!rhKernel) {
      rhKernel = rhKernels[sig] = [];
      for (i = -rad; i <= rad; i++) rhKernel.push(Math.exp(-(i * i) / (2 * sig * sig)));
    }
    var out = [];
    for (i = 0; i < n; i++) {
      var acc = 0, w = 0;
      for (j = -rad; j <= rad; j++) {
        var idx = i + j;
        if (idx < 0 || idx >= n) continue;
        var kw = rhKernel[j + rad];
        acc += a[idx] * kw; w += kw;
      }
      out[i] = w ? (acc / w) * 60 : 0;   // per-minute mean -> per hour
    }
    return out;
  }

  // ALL can anchor the Stats view to a historical date. The shorter windows
  // always stay live, while Collage and Atlas continue to follow their own
  // selected live window in either mode.
  var hourlyDate = null;
  var statsContextSeq = 0;
  function hourlyToday() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  // Which hours the ledger shows follows the window picker. In ALL, the date
  // pager owns the calendar, so this table never repeats the selected date.
  function hourlyRange() {
    var now = (DATA.hourly && typeof DATA.hourly.anchor_hour === 'number')
      ? DATA.hourly.anchor_hour
      : ((DATA.rhythm && typeof DATA.rhythm.now_hour === 'number') ? DATA.rhythm.now_hour : new Date().getHours());
    if (currentHours >= 24) return { from: 0, to: 23 };
    var span = Math.max(1, Math.min(24, currentHours));
    return { from: Math.max(0, now - span + 1), to: now };
  }
  function parseLocalDate(s) {
    var p = String(s || '').split('-');
    return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
  }
  function shortStatsDate(s) {
    var d = parseLocalDate(s);
    if (!d || isNaN(d.getTime())) return String(s || 'today');
    var opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  function stationToday() {
    return (DATA.stats && DATA.stats.station_date)
      || (DATA.hourly && DATA.hourly.station_date)
      || hourlyToday();
  }
  function statsDateOnScreen() {
    return hourlyDate || (DATA.stats && DATA.stats.date) || (DATA.hourly && DATA.hourly.date) || stationToday();
  }
  function updateStatsDateNav() {
    var nav = document.getElementById('statsDateNav');
    var label = document.getElementById('statsDateLabel');
    var next = document.getElementById('statsDateNext');
    if (!nav || !label || !next) return;
    var isAll = currentHours >= 1000000;
    nav.hidden = !isAll;
    if (!isAll) {
      closeStatsCalendar(false);
      return;
    }
    var date = statsDateOnScreen();
    var today = stationToday();
    label.textContent = date === today && !hourlyDate ? 'today' : shortStatsDate(date);
    label.setAttribute('aria-label', 'Choose stats date, ' + (date === today ? 'today' : shortStatsDate(date)));
    next.disabled = !hourlyDate || date >= today;
  }
  function isoLocalDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function shiftStatsDate(date, days) {
    var d = parseLocalDate(date);
    if (!d || isNaN(d.getTime())) d = parseLocalDate(stationToday());
    d.setDate(d.getDate() + days);
    return isoLocalDate(d);
  }
  function chooseStatsDate(date, returnFocus) {
    if (currentHours < 1000000 || !date || date > stationToday()) return;
    hourlyExpanded = false;
    hourlyDate = date >= stationToday() ? null : date;
    updateStatsDateNav();
    closeStatsCalendar(!!returnFocus);
    refreshStatsContext(true);
  }

  var statsCalendarMonth = null;
  function statsDateCounts() {
    var map = {};
    (((DATA.calendar || {}).days) || []).forEach(function (row) {
      map[row.date] = +row.detections || 0;
    });
    if (DATA.stats && DATA.stats.is_today && DATA.stats.today && DATA.stats.today.detections) {
      map[stationToday()] = +DATA.stats.today.detections;
    }
    return map;
  }
  function renderStatsCalendar() {
    var cal = document.getElementById('statsCalendar');
    var days = document.getElementById('statsCalendarDays');
    var title = document.getElementById('statsMonthTitle');
    var monthPrev = document.getElementById('statsMonthPrev');
    var monthNext = document.getElementById('statsMonthNext');
    var latest = document.getElementById('statsLatestDate');
    if (!cal || !days || !title || !monthPrev || !monthNext || !latest) return;
    var selected = statsDateOnScreen();
    var selectedDate = parseLocalDate(selected);
    if (!statsCalendarMonth || isNaN(statsCalendarMonth.getTime())) {
      statsCalendarMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    }
    var year = statsCalendarMonth.getFullYear();
    var month = statsCalendarMonth.getMonth();
    var first = new Date(year, month, 1);
    var total = new Date(year, month + 1, 0).getDate();
    var today = stationToday();
    var firstHeard = (DATA.calendar || {}).first_date || null;
    var lastHeard = (DATA.calendar || {}).last_date || null;
    var counts = statsDateCounts();
    title.textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var html = '';
    for (var blank = 0; blank < first.getDay(); blank++) html += '<span aria-hidden="true"></span>';
    for (var day = 1; day <= total; day++) {
      var date = isoLocalDate(new Date(year, month, day));
      var count = counts[date] || 0;
      var disabled = date > today || (firstHeard && date < firstHeard);
      var readable = new Date(year, month, day).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });
      var aria = readable + (count ? ', ' + count + ' detection' + (count === 1 ? '' : 's') : ', no detections');
      html += '<button type="button" role="gridcell" data-date="' + date + '"'
        + (count ? ' class="has-data' + (date === today ? ' is-today' : '') + '"' : (date === today ? ' class="is-today"' : ''))
        + ' aria-label="' + aria + '" aria-selected="' + (date === selected ? 'true' : 'false') + '"'
        + (disabled ? ' disabled' : '') + '>' + day + '</button>';
    }
    days.innerHTML = html;
    var monthKey = year * 12 + month;
    var todayDate = parseLocalDate(today);
    var todayKey = todayDate.getFullYear() * 12 + todayDate.getMonth();
    var firstDate = firstHeard ? parseLocalDate(firstHeard) : null;
    var firstKey = firstDate ? firstDate.getFullYear() * 12 + firstDate.getMonth() : todayKey;
    monthPrev.disabled = monthKey <= firstKey;
    monthNext.disabled = monthKey >= todayKey;
    latest.hidden = !lastHeard;
    latest.dataset.date = lastHeard || '';
  }
  function openStatsCalendar(withMotion) {
    var cal = document.getElementById('statsCalendar');
    var label = document.getElementById('statsDateLabel');
    if (!cal || !label) return;
    var selected = parseLocalDate(statsDateOnScreen());
    statsCalendarMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
    renderStatsCalendar();
    cal.classList.toggle('no-motion', !withMotion);
    cal.setAttribute('aria-hidden', 'false');
    label.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () {
      var chosen = cal.querySelector('[aria-selected="true"]');
      if (chosen) chosen.focus({ preventScroll: true });
    });
  }
  function closeStatsCalendar(returnFocus) {
    var cal = document.getElementById('statsCalendar');
    var label = document.getElementById('statsDateLabel');
    if (!cal || !label || cal.getAttribute('aria-hidden') === 'true') return;
    cal.setAttribute('aria-hidden', 'true');
    label.setAttribute('aria-expanded', 'false');
    if (returnFocus) label.focus({ preventScroll: true });
  }
  function focusStatsCalendarDate(date) {
    var d = parseLocalDate(date);
    if (!d || isNaN(d.getTime()) || date > stationToday()) return;
    statsCalendarMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderStatsCalendar();
    requestAnimationFrame(function () {
      var target = document.querySelector('#statsCalendarDays [data-date="' + date + '"]');
      if (target && !target.disabled) target.focus();
    });
  }
  function renderHourly() {
    var wrap = document.getElementById('heatmapWrap');
    if (!wrap) return;
    var d = DATA.hourly;
    var rng = hourlyRange();
    var list = (d && d.species) || [];
    if (!list.length) {
      wrap.innerHTML = '<div class="stats-data-empty window-empty">' + EMPTY_WINDOW_COPY + '</div>';
      return;
    }
    // One scale for the whole table so a cell's ink weight is comparable
    // across species and hours; the printed count stays the honest number.
    var maxN = 1;
    var rowsArr = list.map(function (s) {
      var hours = [], h;
      for (h = 0; h < 24; h++) hours[h] = 0;
      (s.hours || []).forEach(function (x) { hours[x.hour] = x.n; });
      var shown = 0;
      for (h = rng.from; h <= rng.to; h++) { shown += hours[h]; if (hours[h] > maxN) maxN = hours[h]; }
      return { sci: s.sci, com: s.com, total: shown, hours: hours };
    }).filter(function (s) { return s.total > 0; })
      .sort(function (a, b) { return b.total - a.total; });
    if (!rowsArr.length) {
      wrap.innerHTML = '<div class="stats-data-empty window-empty">' + EMPTY_WINDOW_COPY + '</div>';
      return;
    }
    var total = rowsArr.length;
    var hourCount = rng.to - rng.from + 1;
    var html = '<table class="heatmap-table' + (hourCount > 8 ? ' heatmap-compressed' : '') + '"><thead><tr><th class="heatmap-corner" aria-label="species"></th>';
    for (var hh = rng.from; hh <= rng.to; hh++) {
      var majorHour = hourCount <= 12 || hh % 3 === 0 || hh === rng.to;
      html += '<th class="heatmap-hour' + (majorHour ? ' heatmap-hour-major' : '') + '">' + pad(hh) + '</th>';
    }
    html += '<th class="heatmap-total">total</th></tr></thead><tbody>';
    rowsArr.forEach(function (s) {
      html += '<tr class="heatmap-row" data-sci="' + escHtml(s.sci) + '">'
        + '<td class="heatmap-name"><span class="com">' + escHtml(s.com) + '</span>'
        + '<span class="sci">' + escHtml(s.sci) + '</span></td>';
      for (var h = rng.from; h <= rng.to; h++) {
        var c = s.hours[h];
        if (c > 0) {
          // Ink weight mixed from the theme's ink variable; capped so
          // the count stays readable on the heaviest cell.
          var mix = Math.round(6 + 39 * (c / maxN));
          html += '<td style="background:color-mix(in srgb, var(--ink) ' + mix + '%, transparent)">' + c + '</td>';
        } else {
          html += '<td></td>';
        }
      }
      html += '<td class="heatmap-total">' + fmtN(s.total) + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '<button type="button" class="heatmap-trim" hidden></button>';
    wrap.innerHTML = html;
    var chart = wrap.closest('.stats-chart');
    var note = wrap.querySelector('.heatmap-trim');
    if (hourlyExpanded) {
      // Show every species and grow the column downward to the whole list, so
      // the page extends and the rhythm below moves down rather than the list
      // hiding behind a scrollbar. The header row stays put because it is the
      // table's own first row and the top of the column never moves; only the
      // bottom edge travels. The nested flex chain resists height:auto, so set
      // the height that fits outright, from the row count.
      note.hidden = false;
      note.textContent = 'Show less';
      wrap.removeAttribute('data-more');
      if (chart) {
        chart.classList.add('rh-grow');
        var probe = wrap.querySelector('.heatmap-row');
        var rowH = probe ? probe.getBoundingClientRect().height : 0;
        if (rowH < 22) rowH = 30;                 // compressed or unmeasured
        var HEAD = 40, NOTE = 26, PAD = 46;
        chart.style.height = Math.ceil(PAD + HEAD + rowH * total + NOTE) + 'px';
      }
    } else {
      if (chart) { chart.classList.remove('rh-grow'); chart.style.height = ''; }
      fitRows(wrap, total);
    }
  }
  // The ledger fits its slot by default and reveals the rest on demand. The
  // choice is per-render, reset when the window or day changes so a fresh view
  // starts tidy again.
  var hourlyExpanded = false;
  // Row height moves with the theme's serif metrics, so trim by measuring
  // what is actually on screen rather than guessing a pitch. The point of
  // this view is that the whole reading fits at once.
  function fitRows(wrap, total) {
    var body = wrap.querySelector('tbody');
    var note = wrap.querySelector('.heatmap-trim');
    if (!body) return;
    // How many rows fit the slot, worked out from the slot and one real row
    // rather than a measure-and-delete loop: the loop reads a height that is
    // momentarily stale right after a collapse, and left the list untrimmed.
    // The slot is the chart column's own height (the collapsed --chart-h).
    var chart = wrap.closest('.stats-chart');
    var slotH = chart ? chart.getBoundingClientRect().height : (wrap.clientHeight || 320);
    var probe = body.rows[0];
    var rowH = probe ? probe.getBoundingClientRect().height : 0;
    if (rowH < 22) rowH = 30;
    var HEAD = 40, NOTE = 26, PAD = 46;
    var room = slotH - PAD - HEAD;
    var fit = Math.max(3, Math.floor((room - NOTE) / rowH));
    if (fit >= total) { note.hidden = true; wrap.removeAttribute('data-more'); return; }
    while (body.rows.length > fit && body.rows.length > 1) {
      body.deleteRow(body.rows.length - 1);
    }
    note.hidden = false;
    note.textContent = 'Show more';
    // Fade the last visible row into paper so the cut edge reads as "more
    // below" rather than a hard stop; the styles.css mask keys off this.
    wrap.setAttribute('data-more', '1');
  }
  // Toggle the ledger between fitted and full, easing the column height between
  // the two rather than snapping. renderHourly lays out the destination
  // synchronously; we then pin the start height, force the transition to run
  // from there, and hand the height back to CSS (collapsed) or the computed
  // pixel value (expanded) once it settles.
  var hourlyAnim = null;
  function animateHourlyToggle() {
    var wrap = document.getElementById('heatmapWrap');
    var chart = wrap ? wrap.closest('.stats-chart') : null;
    if (!chart) { hourlyExpanded = !hourlyExpanded; renderHourly(); return; }
    if (hourlyAnim) { hourlyAnim.cancel(); hourlyAnim = null; }   // supersede a running one
    var fromH = chart.getBoundingClientRect().height;
    hourlyExpanded = !hourlyExpanded;
    renderHourly();                                   // destination layout + resting height
    var toH = chart.getBoundingClientRect().height;
    var settle = function () {
      hourlyAnim = null;
      chart.classList.remove('rh-anim');
      // Collapsed hands height back to --chart-h; expanded keeps the pixel
      // height renderHourly's rh-grow branch computed for the full list.
      chart.style.height = hourlyExpanded ? toH + 'px' : '';
    };
    // Explicit keyframes via the Web Animations API: it does not depend on the
    // reflow-flush timing a CSS transition needs to catch its start, so the
    // grow runs reliably. Overflow is clipped (rh-anim) so rows wipe in under
    // the growing edge, and the rhythm below rides down as the row resizes.
    if (Math.abs(toH - fromH) < 2 || typeof chart.animate !== 'function') { settle(); return; }
    chart.classList.add('rh-anim');
    hourlyAnim = chart.animate(
      [{ height: fromH + 'px' }, { height: toH + 'px' }],
      { duration: 340, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' });
    hourlyAnim.onfinish = settle;
    hourlyAnim.oncancel = function () { chart.classList.remove('rh-anim'); };
  }
  (function wireStatsDatePager() {
    var wrap = document.getElementById('heatmapWrap');
    var prev = document.getElementById('statsDatePrev');
    var next = document.getElementById('statsDateNext');
    var label = document.getElementById('statsDateLabel');
    var cal = document.getElementById('statsCalendar');
    var days = document.getElementById('statsCalendarDays');
    var monthPrev = document.getElementById('statsMonthPrev');
    var monthNext = document.getElementById('statsMonthNext');
    var latest = document.getElementById('statsLatestDate');
    var today = document.getElementById('statsTodayDate');
    if (!wrap || !prev || !next || !label || !cal || !days) return;
    prev.addEventListener('click', function () {
      chooseStatsDate(shiftStatsDate(statsDateOnScreen(), -1));
    });
    next.addEventListener('click', function () {
      if (next.disabled) return;
      chooseStatsDate(shiftStatsDate(statsDateOnScreen(), 1));
    });
    label.addEventListener('click', function (ev) {
      if (cal.getAttribute('aria-hidden') === 'false') closeStatsCalendar(false);
      else openStatsCalendar(ev.detail !== 0);
    });
    monthPrev.addEventListener('click', function () {
      if (monthPrev.disabled) return;
      statsCalendarMonth.setMonth(statsCalendarMonth.getMonth() - 1);
      renderStatsCalendar();
    });
    monthNext.addEventListener('click', function () {
      if (monthNext.disabled) return;
      statsCalendarMonth.setMonth(statsCalendarMonth.getMonth() + 1);
      renderStatsCalendar();
    });
    days.addEventListener('click', function (ev) {
      var day = ev.target.closest('[data-date]');
      if (day && !day.disabled) chooseStatsDate(day.dataset.date, ev.detail === 0);
    });
    days.addEventListener('keydown', function (ev) {
      var day = ev.target.closest('[data-date]');
      if (!day) return;
      var off = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
      if (!off) return;
      ev.preventDefault();
      focusStatsCalendarDate(shiftStatsDate(day.dataset.date, off));
    });
    if (latest) latest.addEventListener('click', function (ev) { chooseStatsDate(latest.dataset.date, ev.detail === 0); });
    if (today) today.addEventListener('click', function (ev) { chooseStatsDate(stationToday(), ev.detail === 0); });
    document.addEventListener('pointerdown', function (ev) {
      if (cal.getAttribute('aria-hidden') === 'false' && !ev.target.closest('#statsDateNav')) closeStatsCalendar(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && cal.getAttribute('aria-hidden') === 'false') {
        ev.preventDefault(); closeStatsCalendar(true);
      }
    });
    wrap.addEventListener('click', function (ev) {
      if (ev.target.closest('.heatmap-trim')) {
        animateHourlyToggle(); return;
      }
    });

    // Re-fit when the slot changes size: a taller page should reveal more
    // species, not just leave the old trim in place. Rebuild from the full
    // list (renderHourly re-trims), guarded by rAF so a burst of resize
    // callbacks collapses into one pass, and only while the ledger is up.
    if (window.ResizeObserver) {
      var raf = 0;
      var ro = new ResizeObserver(function () {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          if (statsHeatmapEl && statsHeatmapEl.style.display !== 'none' && !hourlyExpanded) renderHourly();
        });
      });
      ro.observe(wrap);
    }
  })();

  // Tab switch: summary (grid + rhythm) or the hourly ledger. Remembered
  // like the theme so the view reopens where you left it.
  // The timeline and the hourly ledger are two readings of the same
  // window sharing one slot; the icon pick swaps them while the side
  // panel and the rhythm stay put. Remembered like the theme.
  var chartPickEl = document.getElementById('chartPick');
  var statsTimelineEl = document.getElementById('statsTimeline');
  var statsHeatmapEl = document.getElementById('statsHeatmap');
  function setChart(name, save) {
    if (!chartPickEl) return;
    [].slice.call(chartPickEl.querySelectorAll('button')).forEach(function (b) {
      b.setAttribute('aria-current', b.dataset.chart === name ? 'true' : 'false');
    });
    statsTimelineEl.style.display = name === 'hourly' ? 'none' : '';
    statsHeatmapEl.style.display = name === 'hourly' ? 'flex' : 'none';
    if (save) writeLS('bird:chart', name);
    syncPill(chartPickEl);
    // Both charts size themselves from their own box, which reads 0
    // while hidden - redraw whichever one just came into the slot.
    if (name !== 'hourly') {
      // The timeline uses the resting --chart-h slot: shed any expanded-ledger
      // sizing left on the shared chart column so it doesn't render into a tall
      // box (and so a later collapse measures a clean height).
      var chart = statsHeatmapEl.closest('.stats-chart');
      if (chart) { chart.classList.remove('rh-grow', 'rh-anim'); chart.style.height = ''; }
      drawHistograms(false);
    } else renderHourly();
  }
  if (chartPickEl) {
    chartPickEl.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (b) setChart(b.dataset.chart, true);
    });
    wireToggleAdvance(chartPickEl);
    setChart(readLS('bird:chart', 'timeline'), false);
  }

  // ---- Atlas: field-guide card grid ----
  // eBird species codes for the bundled Atlas birds. eBird's URL scheme is
  // https://ebird.org/species/<code>/, where <code> is a stable 6-char
  // taxonomy code. Keep this in step with scripts/ebird.php so every
  // postcard opens its bird, never the generic Explore page.
  var EBIRD_CODES = {
    'Agelaius phoeniceus': 'rewbla',
    'Aix sponsa': 'wooduc',
    'Anas platyrhynchos': 'mallar3',
    'Aphelocoma californica': 'cowscj1',
    'Aphelocoma woodhouseii': 'wooscj2',
    'Archilochus alexandri': 'bkchum',
    'Ardea herodias': 'grbher3',
    'Baeolophus inornatus': 'oaktit',
    'Bombycilla cedrorum': 'cedwax',
    'Branta canadensis': 'cangoo',
    'Bubo virginianus': 'grhowl',
    'Buteo jamaicensis': 'rethaw',
    'Calypte anna': 'annhum',
    'Corvus brachyrhynchos': 'amecro',
    'Haemorhous mexicanus': 'houfin',
    'Larus occidentalis': 'wesgul',
    'Mimus polyglottos': 'normoc',
    'Passer domesticus': 'houspa',
    'Sayornis nigricans': 'blkpho',
    'Spinus psaltria': 'lesgol',
    'Turdus migratorius': 'amerob',
    'Zenaida macroura': 'moudov',
    'Zonotrichia leucophrys': 'whcspa'
  };

  function wikiUrl(sci) {
    return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(sci.replace(/ /g, '_'));
  }
  function ebirdUrl(sci) {
    var code = EBIRD_CODES[sci];
    return code ? 'https://ebird.org/species/' + code : '';
  }

  // Tiny inline icons - monochrome, ink-only, match the page palette.
  // Font Awesome Free 6 glyphs (icons CC BY 4.0), path data verbatim.
  var ICON_COPY = '<svg viewBox="0 0 448 512" fill="currentColor" aria-hidden="true"><path d="M384 336l-192 0c-8.8 0-16-7.2-16-16l0-256c0-8.8 7.2-16 16-16l140.1 0L400 115.9 400 320c0 8.8-7.2 16-16 16zM192 384l192 0c35.3 0 64-28.7 64-64l0-204.1c0-12.7-5.1-24.9-14.1-33.9L366.1 14.1c-9-9-21.2-14.1-33.9-14.1L192 0c-35.3 0-64 28.7-64 64l0 256c0 35.3 28.7 64 64 64zM64 128c-35.3 0-64 28.7-64 64L0 448c0 35.3 28.7 64 64 64l192 0c35.3 0 64-28.7 64-64l0-32-48 0 0 32c0 8.8-7.2 16-16 16L64 464c-8.8 0-16-7.2-16-16l0-256c0-8.8 7.2-16 16-16l32 0 0-48-32 0z"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 448 512" fill="currentColor" aria-hidden="true"><path d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"/></svg>';
  var ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.7 12s3.4-5.7 9.3-5.7 9.3 5.7 9.3 5.7-3.4 5.7-9.3 5.7S2.7 12 2.7 12z"/><circle cx="12" cy="12" r="2.5"/></svg>';
  var ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 3l18 18M10.7 6.4A10.9 10.9 0 0 1 12 6.3c5.9 0 9.3 5.7 9.3 5.7a14.6 14.6 0 0 1-2.2 2.8M6.2 7.5A15.1 15.1 0 0 0 2.7 12s3.4 5.7 9.3 5.7a10.4 10.4 0 0 0 3.1-.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 12 12" fill="currentColor"><rect x="3" y="2" width="2.5" height="8"/><rect x="6.5" y="2" width="2.5" height="8"/></svg>';
  var ICON_LOOP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 5.4h7.6l-1.7-1.7M12.8 10.6H5.2l1.7 1.7"/><path d="M12.8 5.4v2M3.2 10.6v-2"/></svg>';

  var ATLAS_SEEN_KEY = 'bird:atlasSeen';
  var atlasStuckThisLoad = false;
  var atlasStickScheduled = false;
  var atlasTestLifers = 0;
  try {
    atlasTestLifers = Math.max(0, Math.min(8,
      parseInt(new URLSearchParams(location.search).get('atlasLifers') || '0', 10) || 0));
  } catch (e) { }
  // REVIEW SWITCH: while the stick-on is being dialled in, replay it on every
  // page load so it can actually be watched. Set to false and the real rule
  // takes over - a stamp only peels on the visit that first shows it.
  var ATLAS_ALWAYS_REPLAY = false;

  // Measure the actual issue rather than forcing every family into a square.
  // A small skyline packer keeps the reading order, but fills the valleys left
  // by portrait and landscape issues. CSS grid's rectangular row-spans left
  // conspicuous holes even with a tiny gap because each stamp reserved every
  // cell in its bounding box.
  function atlasRects(root) {
    var out = {};
    if (!root) return out;
    root.querySelectorAll('.stamp-card[data-sci]').forEach(function (card) {
      if (getComputedStyle(card).display === 'none') return;
      out[card.dataset.sci] = card.getBoundingClientRect();
    });
    return out;
  }
  // Each family is issued at one stable display size. A restrained set of
  // scales gives the wall the varied rhythm of a collected album while
  // keeping every member of a family consistent across every sort mode.
  function atlasFamilyScale(card, mobile) {
    var sci = (card && card.dataset && card.dataset.sci) || '';
    var family = (window.STAMPS && window.STAMPS.familyOf)
      ? window.STAMPS.familyOf(sci) : sci;
    var hash = 2166136261;
    for (var i = 0; i < family.length; i++) {
      hash ^= family.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    var desktop = [.97, .99, 1.01, 1.03];
    var compact = [.97, .99, 1.01, 1.03];
    var levels = mobile ? compact : desktop;
    return levels[(hash >>> 0) % levels.length];
  }
  // The skyline pass is intentionally order-aware, which keeps each sort
  // legible but can strand one or two usable cavities near the foot of a
  // long wall. Repack only the trailing issues against the locked upper wall,
  // try a small deterministic set of tail orders, and keep the result only
  // when it genuinely shortens the collection. This closes ragged lower rows
  // without crushing the paper seams or scrambling the whole sort.
  function compactAtlasTail(placements, available, gap, unit, options) {
    if (!placements || placements.length < 7) return;
    options = options || {};
    // Give the final shelf enough material to close its largest valleys. Ten
    // issues was sufficient for the middle of the wall, but could strand an
    // isolated portrait in the last row on wide displays. This is still a
    // bounded pass (the upper 40%+ of a normal wall remains untouched).
    var count = Math.min(14, Math.max(8, Math.ceil(placements.length * .56)));
    var startX = gap / 2;
    var endPad = gap / 2;
    var tail = placements.slice().sort(function (a, b) {
      return (b.y + b.height) - (a.y + a.height);
    }).slice(0, count);
    var tailSet = new Set(tail);
    var locked = placements.filter(function (item) { return !tailSet.has(item); });
    var originalBottom = placements.reduce(function (max, item) {
      return Math.max(max, item.y + item.height);
    }, 0);

    // Height alone cannot distinguish a clean final shelf from one with a
    // large white river through it. Measure the widest horizontal opening in
    // the bottom band and use it as the deterministic tie-breaker.
    function lowerBandGap(items, bottom) {
      var bandTop = bottom - 154;
      var intervals = items.filter(function (item) {
        return item.y + item.height > bandTop;
      }).map(function (item) {
        return [Math.max(0, item.x), Math.min(available, item.x + item.width)];
      }).sort(function (a, b) { return a[0] - b[0]; });
      if (!intervals.length) return available;
      var cursor = 0;
      var widest = 0;
      intervals.forEach(function (interval) {
        widest = Math.max(widest, interval[0] - cursor);
        cursor = Math.max(cursor, interval[1]);
      });
      return Math.max(widest, available - cursor);
    }
    var originalGap = lowerBandGap(placements, originalBottom);

    // Life can borrow the same closing pass without surrendering its basic
    // newest-to-oldest reading. Measure the final visual scan, not merely the
    // permutation used to place it, because a later narrow issue can climb
    // into an older cavity even when items are processed in source order.
    function maxOrderDrift(items) {
      var visual = items.slice().sort(function (a, b) {
        return a.y - b.y || a.x - b.x || a.source.order - b.source.order;
      });
      return visual.reduce(function (largest, item, visualIndex) {
        return Math.max(largest, Math.abs(item.source.order - visualIndex));
      }, 0);
    }

    function placeOrder(order) {
      var placed = locked.map(function (item) {
        return { source: item, x: item.x, y: item.y, width: item.width, height: item.height };
      });
      order.forEach(function (item) {
        var best = null;
        for (var x = startX; x <= available - item.width - endPad; x += unit) {
          var blockers = placed.filter(function (other) {
            return x < other.x + other.width + gap &&
              x + item.width + gap > other.x;
          }).sort(function (a, b) { return a.y - b.y; });
          var y = gap / 2;
          for (var i = 0; i < blockers.length; i++) {
            var block = blockers[i];
            if (y + item.height + gap <= block.y) break;
            y = Math.max(y, block.y + block.height + gap);
          }
          if (!best || y < best.y ||
              (Math.abs(y - best.y) <= 1 && Math.abs(x - item.x) < Math.abs(best.x - item.x))) {
            best = { x: x, y: y };
          }
        }
        placed.push({ source: item, x: best.x, y: best.y, width: item.width, height: item.height });
      });
      var placedBottom = placed.reduce(function (max, item) {
          return Math.max(max, item.y + item.height);
        }, 0);
      return {
        bottom: placedBottom,
        lowerGap: lowerBandGap(placed, placedBottom),
        placed: placed
      };
    }

    var base = tail.slice().sort(function (a, b) { return a.order - b.order; });
    var candidates = [
      base,
      tail.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; }),
      tail.slice().sort(function (a, b) { return b.height - a.height || a.order - b.order; }),
      tail.slice().sort(function (a, b) { return b.width - a.width || a.order - b.order; }),
      tail.slice().sort(function (a, b) { return a.height - b.height || a.order - b.order; }),
      tail.slice().sort(function (a, b) { return a.width - b.width || a.order - b.order; }),
      tail.slice().sort(function (a, b) {
        return (b.width * b.height) - (a.width * a.height) || a.order - b.order;
      })
    ];
    for (var shift = 1; shift < base.length; shift++) {
      candidates.push(base.slice(shift).concat(base.slice(0, shift)));
    }
    for (var swap = 0; swap < base.length - 1; swap++) {
      var adjacent = base.slice();
      var held = adjacent[swap];
      adjacent[swap] = adjacent[swap + 1];
      adjacent[swap + 1] = held;
      candidates.push(adjacent);
    }

    var bestResult = null;
    candidates.forEach(function (candidate) {
      var result = placeOrder(candidate);
      if (isFinite(options.maxOrderDrift) &&
          maxOrderDrift(result.placed) > options.maxOrderDrift) return;
      if (!bestResult || result.bottom < bestResult.bottom - 1 ||
          (Math.abs(result.bottom - bestResult.bottom) <= 1 &&
           result.lowerGap < bestResult.lowerGap)) bestResult = result;
    });
    if (!bestResult || bestResult.bottom > originalBottom + 1 ||
        (Math.abs(bestResult.bottom - originalBottom) <= 1 &&
         bestResult.lowerGap >= originalGap - 1)) return;
    bestResult.placed.forEach(function (placed) {
      if (!tailSet.has(placed.source)) return;
      placed.source.x = placed.x;
      placed.source.y = placed.y;
    });
  }

  // A phone-width masonry wall can fill both outer edges somewhere down the
  // page while an individual shelf still reads as a left-pinned island. Move
  // only vertically disconnected groups: every issue in a group overlaps the
  // group's running y-range, so separate groups can move horizontally without
  // ever colliding. Family sections deliberately keep their shared left edge;
  // this pass is for the three flat collection views only.
  function centerMobileAtlasSlabs(placements, available, snap) {
    if (!placements.length) return;
    var ordered = placements.slice().sort(function (a, b) {
      return a.y - b.y || a.x - b.x || a.order - b.order;
    });
    var slabs = [];
    var slab = null;
    ordered.forEach(function (placed) {
      var placedBottom = placed.y + placed.height;
      // Only a genuine vertical separation starts a new component. Any real
      // overlap, however small, keeps the issues moving as one object.
      if (!slab || placed.y >= slab.bottom) {
        slab = { bottom: placedBottom, items: [placed] };
        slabs.push(slab);
        return;
      }
      slab.items.push(placed);
      slab.bottom = Math.max(slab.bottom, placedBottom);
    });
    slabs.forEach(function (group) {
      var minX = Math.min.apply(null, group.items.map(function (p) { return p.x; }));
      var maxX = Math.max.apply(null, group.items.map(function (p) { return p.x + p.width; }));
      var offsetX = (available - (maxX - minX)) / 2 - minX;
      offsetX = Math.round(offsetX / snap) * snap;
      // The centered bounds normally imply these limits already. Clamp after
      // snapping so a half-device-pixel cannot escape the packing sheet.
      offsetX = Math.max(-minX, Math.min(available - maxX, offsetX));
      if (Math.abs(offsetX) < snap / 2) return;
      group.items.forEach(function (placed) { placed.x += offsetX; });
    });
  }

  function clearAtlasPackedState(root) {
    if (!root) return;
    var grids = [root].concat([].slice.call(root.querySelectorAll('.atlas-fam-grid')));
    grids.forEach(function (grid) {
      grid.classList.remove('is-packed');
      grid.style.removeProperty('height');
      grid.style.removeProperty('--pack-gap');
    });
    root.querySelectorAll('.bird-card').forEach(function (card) {
      ['left', 'top', 'position', 'grid-column', 'grid-row', '--slot-w', '--slot-h'].forEach(function (name) {
        card.style.removeProperty(name);
      });
      var fit = card.querySelector('.stamp-fit');
      if (fit) fit.style.removeProperty('--fit-scale');
    });
  }

  function packAtlasGrids(root) {
    if (!root) return;
    var atlasRoot = root.id === 'atlasGrid' ? root :
      (root.closest ? root.closest('#atlasGrid') : null);
    if (atlasRoot && atlasRoot.dataset.layout === 'classic') {
      clearAtlasPackedState(root);
      queueAtlasOverflowState();
      return;
    }
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
    var mobile = viewportWidth <= 700;
    // Grow the complete issue gradually from phone to desktop dimensions.
    // Coupled with the Atlas-only fluid gutter, this avoids a one-pixel
    // breakpoint where the available sheet shrank as every stamp grew.
    var baseScale = Math.max(.8, Math.min(1,
      .8 + Math.max(0, viewportWidth - 700) / 1500));
    var narrowWall = viewportWidth < 900;
    var unit = 1;
    var grids = root.matches && root.matches('.atlas-fam-grid')
      ? [root]
      : [].slice.call(root.querySelectorAll('.atlas-fam-grid'));
    if (!grids.length) grids = [root];
    grids.forEach(function (g) {
      var familyGrid = g.classList.contains('atlas-fam-grid');
      // Life remains a true masonry wall, but chronology gets a strong local
      // bias below. Accession numbers are still emitted newest-first in DOM
      // order; spatial order may bend slightly when the next issue closes a
      // meaningful cavity.
      var lifeMasonry = g.id === 'atlasGrid' && g.dataset.sort === 'life';
      // CSS owns the seam so All, Family and mobile modes can each tune it.
      // Clear the old inline value left by earlier packer passes first.
      g.style.removeProperty('--pack-gap');
      var gap = parseFloat(getComputedStyle(g).getPropertyValue('--pack-gap'));
      if (!isFinite(gap) || gap < 0) gap = mobile ? 5 : 5.5;
      g.classList.remove('is-packed');
      g.style.removeProperty('height');
      var cards = [].slice.call(g.children).filter(function (card) {
        if (!card.matches || !card.matches('.stamp-card')) return false;
        card.style.removeProperty('left');
        card.style.removeProperty('top');
        card.style.removeProperty('position');
        card.style.removeProperty('grid-column');
        card.style.removeProperty('grid-row');
        return getComputedStyle(card).display !== 'none';
      });
      if (!cards.length) return;

      var available = Math.floor(g.getBoundingClientRect().width || g.clientWidth || 0);
      if (!available) return;
      var measured = [];
      cards.forEach(function (card) {
        var fit = card.querySelector('.stamp-fit');
        if (!fit) return;
        // Natural issue dimensions provide the first layer of variation; a
        // deterministic family scale adds another deliberate rhythm. These
        // binary-fraction values also keep fine screens off arbitrary scales.
        var scale = Math.min(baseScale * atlasFamilyScale(card, mobile),
          (available - gap * 2) / ((parseFloat(fit.style.width) || fit.offsetWidth || 188) + 4));
        fit.style.setProperty('--fit-scale', scale);
        var naturalW = parseFloat(fit.style.width) || fit.offsetWidth || 188;
        var naturalH = parseFloat(fit.style.height) || fit.offsetHeight || 236;
        // The silhouette itself owns the hairline around the perforations.
        // Reserving another pixel here manufactured the intermittent white
        // rivers in an otherwise tight stamp wall.
        var slotW = naturalW * scale;
        var slotH = naturalH * scale;
        card.style.setProperty('--slot-w', slotW + 'px');
        card.style.setProperty('--slot-h', slotH + 'px');
        measured.push({ card: card, width: slotW, height: slotH });
      });
      if (!measured.length) return;

      var bottom = 0;
      var placements = [];
      measured.forEach(function (item, index) { item.order = index; });
      var finalSnap = 1 / Math.max(1, window.devicePixelRatio || 1);
      // Choose tail geometry on one canonical half-pixel sheet so candidate
      // selection does not change with display density. Actual device-pixel
      // snapping still happens once, after compaction; a near-tied pair may
      // trade scan order by a hair without changing the wall geometry.
      var packingSnap = .5;
      var lifeVisualDriftLimit = mobile ? 3 : 5;

      // Keep the transient skyline work set scoped away from final placement
      // snapping and centering below.
      {
        var columns = Math.max(1, Math.floor(available / unit));
        var skyline = new Array(columns).fill(0);
        var pending = measured.map(function (item) {
          // At phone width a pair of fractional issue widths can be less than
          // one CSS pixel over after each span is rounded independently. Life
          // can safely share that half-pixel tolerance: the visible paper
          // widths still retain the full authored seam, and complementary
          // issues no longer split into two artificial rows at 320px.
          var spanTolerance = lifeMasonry && mobile ? .5 : 0;
          item.span = Math.min(columns, Math.max(1,
            Math.ceil(Math.min(available, item.width + gap) / unit - spanTolerance)));
          return item;
        });
        var lifeOrderPlaced = [];
        // Visual sorts get a four-issue lookahead. Life considers only the
        // next pair. Positions within one 24px visual band are read in
        // accession order and, on narrow walls, from the left edge. That lets
        // complementary portrait/landscape issues nest beside each other
        // without turning a ten-pixel skyline difference into a new row.
        // The closing pass below is free-form for visual sorts; Life accepts
        // only candidates whose final scan stays within a small accession
        // neighborhood.
        while (pending.length) {
          var choice = null;
          pending.slice(0, lifeMasonry ? 2 : 4).forEach(function (item, itemIndex) {
            if (lifeMasonry) {
              // A sliding two-item window alone does not bound drift: one
              // blocked head could otherwise be bypassed repeatedly as each
              // new neighbor enters the window. Keep selection local by making
              // a candidate eligible only after everything more than two
              // accession places ahead of it has painted. Do not force its y
              // position, though: reserving a vertical chronology frontier
              // manufactured large blank shelves beneath tall early issues.
              for (var prior = 0; prior <= item.order - 3; prior++) {
                if (!lifeOrderPlaced[prior]) return;
              }
            }
            for (var start = 0; start <= columns - item.span; start++) {
              var y = 0;
              for (var c = start; c < start + item.span; c++) y = Math.max(y, skyline[c]);
              if (lifeMasonry) {
                // A later narrow issue may use an existing cavity, but it may
                // not leap an arbitrary number of older accessions to do so.
                // Select another *real* skyline ledge instead of inventing a
                // y-floor: every accepted placement still physically rests on
                // the wall, so chronology cannot create a blank shelf.
                var candidateLeft = start * unit + gap / 2;
                var candidateTop = y + gap / 2;
                var visualBefore = placements.reduce(function (count, priorPlaced) {
                  var before = priorPlaced.y < candidateTop - packingSnap / 2 ||
                    (Math.abs(priorPlaced.y - candidateTop) <= packingSnap / 2 &&
                     priorPlaced.x < candidateLeft);
                  return count + (before ? 1 : 0);
                }, 0);
                if (item.order - visualBefore > lifeVisualDriftLimit) continue;
              }
              var waste = 0;
              for (var w = start; w < start + item.span; w++) waste += y - skyline[w];
              var candidate = {
                item: item, itemIndex: itemIndex, start: start, y: y,
                waste: waste, order: item.order
              };
              var beatsChoice = !choice || candidate.y < choice.y;
              if (lifeMasonry && choice) {
                beatsChoice = candidate.y < choice.y - 24;
                if (!beatsChoice && Math.abs(candidate.y - choice.y) <= 24) {
                  beatsChoice = candidate.order < choice.order ||
                    (candidate.order === choice.order &&
                     (narrowWall ? candidate.start < choice.start :
                      (candidate.waste < choice.waste ||
                       (candidate.waste === choice.waste &&
                        candidate.start < choice.start))));
                }
              } else if (!beatsChoice && choice && candidate.y === choice.y) {
                if (narrowWall) {
                  beatsChoice = candidate.order < choice.order ||
                    (candidate.order === choice.order && candidate.start < choice.start);
                } else {
                  beatsChoice = candidate.waste < choice.waste ||
                    (candidate.waste === choice.waste && candidate.order < choice.order);
                }
              }
              if (beatsChoice) choice = candidate;
            }
          });
          var placed = choice.item;
          pending.splice(choice.itemIndex, 1);
          if (lifeMasonry) lifeOrderPlaced[placed.order] = true;
          var left = choice.start * unit + gap / 2;
          var top = choice.y + gap / 2;
          left = Math.round(left / packingSnap) * packingSnap;
          top = Math.round(top / packingSnap) * packingSnap;
          placements.push({
            card: placed.card, x: left, y: top,
            width: placed.width, height: placed.height, order: placed.order
          });
          var nextY = Math.ceil(choice.y + placed.height + gap);
          for (var u = choice.start; u < choice.start + placed.span; u++) skyline[u] = nextY;
        }
        // During a live resize, keep the inexpensive skyline responsive and
        // defer the combinatorial closing pass until the viewport settles.
        // The final pass below is deterministic and restores the tight wall.
        if (!atlasResizeSettling) {
          compactAtlasTail(placements, available, gap, unit,
            lifeMasonry ? { maxOrderDrift: lifeVisualDriftLimit } : null);
        }
      }

      // Tail compaction can move an otherwise crisp issue back between device
      // pixels. Snap once at the very end, after every packing adjustment.
      placements.forEach(function (placed) {
        placed.x = Math.round(placed.x / finalSnap) * finalSnap;
        placed.y = Math.round(placed.y / finalSnap) * finalSnap;
      });

      // On phones, center each collision-safe vertical component in the three
      // flat collection views. Family sections retain one shared left edge;
      // desktop retains its original whole-wall centering.
      if (mobile && !familyGrid) {
        centerMobileAtlasSlabs(placements, available, finalSnap);
      } else if (g.id === 'atlasGrid' &&
          g.dataset.mode !== 'family' && placements.length) {
        var minX = Math.min.apply(null, placements.map(function (p) { return p.x; }));
        var maxX = Math.max.apply(null, placements.map(function (p) { return p.x + p.width; }));
        var offsetX = Math.max(0, (available - (maxX - minX)) / 2 - minX);
        offsetX = Math.round(offsetX / finalSnap) * finalSnap;
        if (offsetX) placements.forEach(function (placed) { placed.x += offsetX; });
      }
      bottom = 0;
      placements.forEach(function (placed) {
        placed.card.style.left = placed.x + 'px';
        placed.card.style.top = placed.y + 'px';
        bottom = Math.max(bottom, placed.y + placed.height);
      });
      g.classList.add('is-packed');
      g.style.height = Math.ceil(bottom + gap / 2) + 'px';
    });
    queueAtlasOverflowState();
  }
  // Settings hides the view strip while its full-screen panel is open. If a
  // background refresh lands then, the Atlas has no measurable width and the
  // packer correctly defers. Repack once the panel releases the strip so the
  // deferred wall cannot remain in its centered CSS fallback.
  var atlasVisibilityPackFrame = 0;
  function queueVisibleAtlasPack() {
    if (atlasVisibilityPackFrame) cancelAnimationFrame(atlasVisibilityPackFrame);
    atlasVisibilityPackFrame = requestAnimationFrame(function () {
      atlasVisibilityPackFrame = 0;
      if (document.body.classList.contains('admin-on')) return;
      var grid = document.getElementById('atlasGrid');
      if (grid) packAtlasGrids(grid);
    });
  }
  function animateAtlasFlip(root, before, options) {
    options = options || {};
    if (!root || !before || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    var duration = Number(options.duration) || 480;
    var startOpacity = options.solid ? 1 : .72;
    root.querySelectorAll('.stamp-card[data-sci]').forEach(function (card) {
      var old = before[card.dataset.sci];
      if (!old || getComputedStyle(card).display === 'none') return;
      var now = card.getBoundingClientRect();
      var dx = old.left - now.left;
      var dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      card.animate([
        { transform: 'translate(' + dx + 'px,' + dy + 'px)', opacity: startOpacity },
        { transform: 'translate(0,0)', opacity: 1 }
      ], { duration: duration, easing: 'cubic-bezier(.22,1,.36,1)' });
    });
  }

  // Sorting a single-page collection should move the stamps already on the
  // sheet, not destroy and repaint them. In particular, the family renderers'
  // canvases contain fine line screens that can visibly arrive a frame after
  // their paper silhouette. Build the new structure off-DOM, transplant every
  // unchanged keyed card into it, and only then commit the fragment. This
  // preserves the painted canvas and lets the FLIP pass animate one coherent
  // object from its old position to its new one.
  function commitAtlasMarkup(grid, html, sortMode, familyMode) {
    var existing = {};
    grid.querySelectorAll('.stamp-card[data-sci]').forEach(function (card) {
      existing[card.dataset.sci] = card;
    });
    var template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('.stamp-card[data-sci]').forEach(function (fresh) {
      var prior = existing[fresh.dataset.sci];
      if (!prior || prior.dataset.renderKey !== fresh.dataset.renderKey) return;
      ['com', 'audio', 'acc', 'fresh', 'win', 'total'].forEach(function (name) {
        if (fresh.dataset[name] == null) delete prior.dataset[name];
        else prior.dataset[name] = fresh.dataset[name];
      });
      fresh.replaceWith(prior);
    });
    grid.dataset.layout = 'stamps';
    if (familyMode) {
      // Flat mode gives the root an absolute-positioning context and a fixed
      // pixel height. Family mode packs its nested grids instead, so carrying
      // either root state across the switch leaves a stale scroll extent.
      grid.classList.remove('is-packed');
      grid.style.removeProperty('height');
      grid.style.removeProperty('--pack-gap');
      grid.setAttribute('data-mode', 'family');
    } else grid.removeAttribute('data-mode');
    grid.dataset.sort = sortMode;
    grid.replaceChildren(template.content);
  }

  function commitClassicAtlasMarkup(grid, html, sortMode, familyMode) {
    clearAtlasPackedState(grid);
    var template = document.createElement('template');
    template.innerHTML = html;
    grid.dataset.layout = 'classic';
    grid.dataset.sort = sortMode;
    if (familyMode) grid.setAttribute('data-mode', 'family');
    else grid.removeAttribute('data-mode');
    grid.replaceChildren(template.content);
  }

  // The hover peel is a clipped clone of the complete fitted issue. Keeping
  // the fringe contour in that clone means the paper teeth lift with the art,
  // and choosing the nearest edge makes flat-edge approaches work as naturally
  // as corners. Nothing is baked into the family renderers.
  var activeStampPeel = null;
  var activeStampPeelCard = null;
  var stampPeelFrame = 0;
  var stampPeelPoint = null;
  function repaintClonedCanvases(source, copy) {
    var originals = source.querySelectorAll('canvas');
    var clones = copy.querySelectorAll('canvas');
    originals.forEach(function (canvas, i) {
      var clone = clones[i];
      if (!clone) return;
      clone.width = canvas.width;
      clone.height = canvas.height;
      var context = clone.getContext && clone.getContext('2d');
      if (context) context.drawImage(canvas, 0, 0);
    });
  }
  function clearStampPeel(immediate) {
    if (stampPeelFrame) { cancelAnimationFrame(stampPeelFrame); stampPeelFrame = 0; }
    stampPeelPoint = null;
    var peel = activeStampPeel;
    activeStampPeel = null;
    activeStampPeelCard = null;
    if (!peel) return;
    if (immediate) { peel.remove(); return; }
    peel.classList.add('is-settling');
    setTimeout(function () { if (peel.parentNode) peel.remove(); }, 165);
  }
  function makeStampPeel(card) {
    var fit = card && card.querySelector('.stamp-fit');
    if (!fit) return null;
    var layer = document.createElement('span');
    layer.className = 'stamp-peel-layer';
    layer.setAttribute('aria-hidden', 'true');
    // The revealed contact patch must carry the same transparent perforation
    // alpha as the stamp. A plain polygon span reads as a rectangular crop at
    // the fringe, so use a third fitted clone and recolor it in CSS instead.
    var voidEl = fit.cloneNode(true);
    voidEl.querySelectorAll('.stamp-peel-layer').forEach(function (el) { el.remove(); });
    voidEl.classList.add('stamp-peel-void');
    var pagePaper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#fcfcfb';
    // Paint the exact die-cut footprint with the Atlas sheet color. This is
    // the bit of paper exposed beneath the lift: leaving the source artwork
    // visible here made the interaction read as a clipped selection. Because
    // this is still a complete fitted clone, its perforations remain exact.
    voidEl.querySelectorAll('.stamp .face').forEach(function (face) {
      face.replaceChildren();
      face.style.background = pagePaper;
      face.style.boxShadow = 'none';
    });
    voidEl.querySelectorAll('.stamp').forEach(function (stamp) {
      stamp.style.setProperty('--stamp-paper', pagePaper);
      stamp.style.background = pagePaper;
    });
    voidEl.querySelectorAll('.stamp-fringe-outline > i').forEach(function (edge) {
      edge.style.background = pagePaper;
      edge.style.backgroundImage = 'none';
    });
    var under = fit.cloneNode(true);
    under.querySelectorAll('.stamp-peel-layer').forEach(function (el) { el.remove(); });
    under.classList.add('stamp-peel-under-copy');
    repaintClonedCanvases(fit, under);
    var copy = fit.cloneNode(true);
    copy.querySelectorAll('.stamp-peel-layer').forEach(function (el) { el.remove(); });
    copy.classList.add('stamp-peel-copy');
    repaintClonedCanvases(fit, copy);
    var crease = document.createElement('span');
    crease.className = 'stamp-peel-crease';
    layer.appendChild(voidEl);
    layer.appendChild(under);
    layer.appendChild(copy);
    layer.appendChild(crease);
    fit.appendChild(layer);
    return layer;
  }
  function drawStampPeel() {
    stampPeelFrame = 0;
    if (!activeStampPeel || !activeStampPeelCard || !stampPeelPoint) return;
    var fit = activeStampPeelCard.querySelector('.stamp-fit');
    if (!fit) return clearStampPeel(true);
    var rect = fit.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var x = Math.max(0, Math.min(1, (stampPeelPoint.x - rect.left) / rect.width));
    var y = Math.max(0, Math.min(1, (stampPeelPoint.y - rect.top) / rect.height));
    var dl = x, dr = 1 - x, dt = y, db = 1 - y;
    var nearest = Math.min(dl, dr, dt, db);
    var strength = 1 - Math.min(1, nearest / .44);
    // The hinge sits *inside* the sheet, so the perforated outer edge is what
    // actually leaves the page. The former outer-edge origin made the clipped
    // art rotate inward and read like a selection, not a peel.
    var depth = 8 + 9 * strength;
    var angle = 26 + 22 * strength;
    var cornerX = Math.min(dl, dr) < .27;
    var cornerY = Math.min(dt, db) < .27;
    var side = '';
    if (cornerX && cornerY) side = (dl < dr ? 'l' : 'r') + (dt < db ? 't' : 'b');
    else if (nearest === dl) side = 'l';
    else if (nearest === dr) side = 'r';
    else if (nearest === dt) side = 't';
    else side = 'b';

    var d = depth.toFixed(2);
    var cursorX = x * 100;
    var cursorY = y * 100;
    var edgeSpan = 20 + strength * 8;
    var innerSpan = edgeSpan * .66;
    var lift = 12 + strength * 18;
    var offset = 2 + strength * 4;
    var clip, creaseClip, origin, transform, underTransform;
    var sx = 0, sy = Math.round(2 + strength * 6);
    if (side === 'l') {
      clip = 'polygon(0 ' + Math.max(0,cursorY-edgeSpan).toFixed(2) + '%,0 ' + Math.min(100,cursorY+edgeSpan).toFixed(2) + '%,' + d + '% ' + Math.min(100,cursorY+innerSpan).toFixed(2) + '%,' + d + '% ' + Math.max(0,cursorY-innerSpan).toFixed(2) + '%)';
      creaseClip = 'polygon(' + (depth-1.2).toFixed(2) + '% ' + Math.max(0,cursorY-innerSpan).toFixed(2) + '%,' + (depth+1.2).toFixed(2) + '% ' + Math.max(0,cursorY-innerSpan).toFixed(2) + '%,' + (depth+1.2).toFixed(2) + '% ' + Math.min(100,cursorY+innerSpan).toFixed(2) + '%,' + (depth-1.2).toFixed(2) + '% ' + Math.min(100,cursorY+innerSpan).toFixed(2) + '%)';
      origin = d + '% ' + cursorY.toFixed(2) + '%';
      transform = 'translate3d(-' + offset + 'px,0,' + lift + 'px) rotateY(' + angle + 'deg)';
      underTransform = 'translate3d(-' + (offset+2) + 'px,1px,' + (lift-3) + 'px) rotateY(' + (angle+5) + 'deg)'; sx = -5;
    } else if (side === 'r') {
      clip = 'polygon(100% ' + Math.max(0,cursorY-edgeSpan).toFixed(2) + '%,100% ' + Math.min(100,cursorY+edgeSpan).toFixed(2) + '%,' + (100-depth).toFixed(2) + '% ' + Math.min(100,cursorY+innerSpan).toFixed(2) + '%,' + (100-depth).toFixed(2) + '% ' + Math.max(0,cursorY-innerSpan).toFixed(2) + '%)';
      creaseClip = 'polygon(' + (100-depth-1.2).toFixed(2) + '% ' + Math.max(0,cursorY-innerSpan).toFixed(2) + '%,' + (100-depth+1.2).toFixed(2) + '% ' + Math.max(0,cursorY-innerSpan).toFixed(2) + '%,' + (100-depth+1.2).toFixed(2) + '% ' + Math.min(100,cursorY+innerSpan).toFixed(2) + '%,' + (100-depth-1.2).toFixed(2) + '% ' + Math.min(100,cursorY+innerSpan).toFixed(2) + '%)';
      origin = (100-depth).toFixed(2) + '% ' + cursorY.toFixed(2) + '%';
      transform = 'translate3d(' + offset + 'px,0,' + lift + 'px) rotateY(-' + angle + 'deg)';
      underTransform = 'translate3d(' + (offset+2) + 'px,1px,' + (lift-3) + 'px) rotateY(-' + (angle+5) + 'deg)'; sx = 5;
    } else if (side === 't') {
      clip = 'polygon(' + Math.max(0,cursorX-edgeSpan).toFixed(2) + '% 0,' + Math.min(100,cursorX+edgeSpan).toFixed(2) + '% 0,' + Math.min(100,cursorX+innerSpan).toFixed(2) + '% ' + d + '%,' + Math.max(0,cursorX-innerSpan).toFixed(2) + '% ' + d + '%)';
      creaseClip = 'polygon(' + Math.max(0,cursorX-innerSpan).toFixed(2) + '% ' + (depth-1.2).toFixed(2) + '%,' + Math.min(100,cursorX+innerSpan).toFixed(2) + '% ' + (depth-1.2).toFixed(2) + '%,' + Math.min(100,cursorX+innerSpan).toFixed(2) + '% ' + (depth+1.2).toFixed(2) + '%,' + Math.max(0,cursorX-innerSpan).toFixed(2) + '% ' + (depth+1.2).toFixed(2) + '%)';
      origin = cursorX.toFixed(2) + '% ' + d + '%';
      transform = 'translate3d(0,-' + offset + 'px,' + lift + 'px) rotateX(-' + angle + 'deg)';
      underTransform = 'translate3d(1px,-' + (offset+2) + 'px,' + (lift-3) + 'px) rotateX(-' + (angle+5) + 'deg)'; sy = -5;
    } else if (side === 'b') {
      clip = 'polygon(' + Math.max(0,cursorX-edgeSpan).toFixed(2) + '% 100%,' + Math.min(100,cursorX+edgeSpan).toFixed(2) + '% 100%,' + Math.min(100,cursorX+innerSpan).toFixed(2) + '% ' + (100-depth).toFixed(2) + '%,' + Math.max(0,cursorX-innerSpan).toFixed(2) + '% ' + (100-depth).toFixed(2) + '%)';
      creaseClip = 'polygon(' + Math.max(0,cursorX-innerSpan).toFixed(2) + '% ' + (100-depth-1.2).toFixed(2) + '%,' + Math.min(100,cursorX+innerSpan).toFixed(2) + '% ' + (100-depth-1.2).toFixed(2) + '%,' + Math.min(100,cursorX+innerSpan).toFixed(2) + '% ' + (100-depth+1.2).toFixed(2) + '%,' + Math.max(0,cursorX-innerSpan).toFixed(2) + '% ' + (100-depth+1.2).toFixed(2) + '%)';
      origin = cursorX.toFixed(2) + '% ' + (100-depth).toFixed(2) + '%';
      transform = 'translate3d(0,' + offset + 'px,' + lift + 'px) rotateX(' + angle + 'deg)';
      underTransform = 'translate3d(1px,' + (offset+2) + 'px,' + (lift-3) + 'px) rotateX(' + (angle+5) + 'deg)'; sy = 5;
    } else {
      var spreadN = Math.min(39, depth * 1.5);
      var spread = spreadN.toFixed(2);
      var hinge = (spreadN * .58).toFixed(2);
      var z = lift;
      if (side === 'lt') {
        clip = 'polygon(0 0,' + spread + '% 0,0 ' + spread + '%)'; origin = '0 0';
        creaseClip = 'polygon(' + hinge + '% 0,' + (spreadN+1.2).toFixed(2) + '% 0,0 ' + (spreadN+1.2).toFixed(2) + '%,0 ' + hinge + '%)';
        origin = hinge + '% ' + hinge + '%';
        transform = 'translate3d(-' + offset + 'px,-' + offset + 'px,' + z + 'px) rotateX(-' + angle + 'deg) rotateY(' + angle + 'deg)';
        underTransform = 'translate3d(-' + (offset+2) + 'px,-' + (offset+2) + 'px,' + (z-3) + 'px) rotateX(-' + (angle+4) + 'deg) rotateY(' + (angle+4) + 'deg)'; sx = -5; sy = -4;
      } else if (side === 'rt') {
        clip = 'polygon(' + (100-spread) + '% 0,100% 0,100% ' + spread + '%)'; origin = '100% 0';
        creaseClip = 'polygon(' + (100-hinge) + '% 0,' + (100-spreadN-1.2).toFixed(2) + '% 0,100% ' + (spreadN+1.2).toFixed(2) + '%,100% ' + hinge + '%)';
        origin = (100-parseFloat(hinge)).toFixed(2) + '% ' + hinge + '%';
        transform = 'translate3d(' + offset + 'px,-' + offset + 'px,' + z + 'px) rotateX(-' + angle + 'deg) rotateY(-' + angle + 'deg)';
        underTransform = 'translate3d(' + (offset+2) + 'px,-' + (offset+2) + 'px,' + (z-3) + 'px) rotateX(-' + (angle+4) + 'deg) rotateY(-' + (angle+4) + 'deg)'; sx = 5; sy = -4;
      } else if (side === 'lb') {
        clip = 'polygon(0 ' + (100-spread) + '%,0 100%,' + spread + '% 100%)'; origin = '0 100%';
        creaseClip = 'polygon(0 ' + (100-hinge) + '%,' + (spreadN+1.2).toFixed(2) + '% 100%,' + hinge + '% 100%,0 ' + (100-spreadN-1.2).toFixed(2) + '%)';
        origin = hinge + '% ' + (100-parseFloat(hinge)).toFixed(2) + '%';
        transform = 'translate3d(-' + offset + 'px,' + offset + 'px,' + z + 'px) rotateX(' + angle + 'deg) rotateY(' + angle + 'deg)';
        underTransform = 'translate3d(-' + (offset+2) + 'px,' + (offset+2) + 'px,' + (z-3) + 'px) rotateX(' + (angle+4) + 'deg) rotateY(' + (angle+4) + 'deg)'; sx = -5; sy = 4;
      } else {
        clip = 'polygon(100% ' + (100-spread) + '%,100% 100%,' + (100-spread) + '% 100%)'; origin = '100% 100%';
        creaseClip = 'polygon(100% ' + (100-hinge) + '%,' + (100-spreadN-1.2).toFixed(2) + '% 100%,' + (100-hinge) + '% 100%,100% ' + (100-spreadN-1.2).toFixed(2) + '%)';
        origin = (100-parseFloat(hinge)).toFixed(2) + '% ' + (100-parseFloat(hinge)).toFixed(2) + '%';
        transform = 'translate3d(' + offset + 'px,' + offset + 'px,' + z + 'px) rotateX(' + angle + 'deg) rotateY(-' + angle + 'deg)';
        underTransform = 'translate3d(' + (offset+2) + 'px,' + (offset+2) + 'px,' + (z-3) + 'px) rotateX(' + (angle+4) + 'deg) rotateY(-' + (angle+4) + 'deg)'; sx = 5; sy = 4;
      }
    }
    activeStampPeel.style.setProperty('--peel-clip', clip);
    activeStampPeel.style.setProperty('--peel-origin', origin);
    activeStampPeel.style.setProperty('--peel-transform', transform);
    activeStampPeel.style.setProperty('--peel-under-transform', underTransform);
    activeStampPeel.style.setProperty('--peel-crease-clip', creaseClip);
    activeStampPeel.style.setProperty('--peel-shadow-x', sx + 'px');
    activeStampPeel.style.setProperty('--peel-shadow-y', sy + 'px');
    activeStampPeel.style.setProperty('--peel-crease-angle',
      (side === 'l' || side === 'r') ? '90deg' :
      (side === 't' || side === 'b') ? '0deg' :
      (side === 'lt' || side === 'rb') ? '135deg' : '45deg');
    activeStampPeel.dataset.edge = side;
  }
  if (false && matchMedia('(hover:hover) and (pointer:fine)').matches &&
      !matchMedia('(prefers-reduced-motion:reduce)').matches) {
    document.addEventListener('pointermove', function (ev) {
      var card = ev.target.closest && ev.target.closest('.stamp-card');
      if (!card) { if (activeStampPeelCard) clearStampPeel(false); return; }
      if (activeStampPeelCard !== card) {
        clearStampPeel(true);
        activeStampPeelCard = card;
        activeStampPeel = makeStampPeel(card);
      }
      stampPeelPoint = { x: ev.clientX, y: ev.clientY };
      if (!stampPeelFrame) stampPeelFrame = requestAnimationFrame(drawStampPeel);
    }, { passive: true });
    document.addEventListener('pointerout', function (ev) {
      if (activeStampPeelCard && !activeStampPeelCard.contains(ev.relatedTarget)) clearStampPeel(false);
    }, { passive: true });
    document.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest && ev.target.closest('.stamp-card')) clearStampPeel(true);
    }, { passive: true });
  }

  function maybeStickNewStamps(grid, accession) {
    if (atlasStuckThisLoad || atlasStickScheduled) return;
    var seen = 0;
    var forced = atlasTestLifers > 0;
    if (!ATLAS_ALWAYS_REPLAY && !forced) {
      try { seen = parseInt(localStorage.getItem(ATLAS_SEEN_KEY) || '0', 10) || 0; } catch (e) { }
    }
    var highest = 0, k;
    for (k in accession) { if (accession[k] > highest) highest = accession[k]; }

    var allCards = [].slice.call(grid.querySelectorAll('.stamp-card'))
      .filter(function (c) { return +c.dataset.acc > 0; })
      .sort(function (a, b) { return (+a.dataset.acc) - (+b.dataset.acc); });
    var fresh = allCards
      .filter(function (c) { return (+c.dataset.acc || 0) > seen; })
      .sort(function (a, b) { return (+a.dataset.acc) - (+b.dataset.acc); });
    if (forced) fresh = allCards.slice(-atlasTestLifers);
    if (!fresh.length) { return; }

    // The first visit establishes the baseline collection. Treating an
    // imported life list as dozens of simultaneous arrivals turns a welcome
    // into a queue; only later deltas (or the review flag) earn the moment.
    if (!forced && seen === 0) {
      atlasStuckThisLoad = true;
      try { localStorage.setItem(ATLAS_SEEN_KEY, String(highest)); } catch (e) { }
      return;
    }
    atlasStickScheduled = true;

    var arrivals = fresh.slice();
    if (arrivals.length) {
      arrivals.forEach(function (card) { card.classList.add('new-stamp-pending'); });
      packAtlasGrids(grid);
    }

    function plop(card, ordinal) {
      card.style.opacity = '1';
      if (matchMedia('(prefers-reduced-motion:reduce)').matches || !card.animate) {
        return Promise.resolve();
      }
      var lean = ordinal % 2 ? .55 : -.55;
      var animation = card.animate([
        {
          opacity: 0,
          transform: 'translate3d(0,-18px,0) scale(.91) rotate(' + lean + 'deg)',
          filter: 'drop-shadow(0 12px 7px rgba(38,29,20,.17))',
          offset: 0
        },
        {
          opacity: 1,
          transform: 'translate3d(0,2.5px,0) scale(1.025) rotate(' + (-lean * .14) + 'deg)',
          filter: 'drop-shadow(0 3px 2px rgba(38,29,20,.12))',
          offset: .62
        },
        {
          opacity: 1,
          transform: 'translate3d(0,-1px,0) scale(.995) rotate(0deg)',
          filter: 'drop-shadow(0 1px 1px rgba(38,29,20,.08))',
          offset: .78
        },
        {
          opacity: 1,
          transform: 'translate3d(0,0,0) scale(1) rotate(0deg)',
          filter: 'drop-shadow(0 0 0 rgba(38,29,20,0))',
          offset: 1
        }
      ], {
        duration: 520,
        // Let the existing issues finish opening the landing spot before the
        // new issue drops. This is one continuous settle, not a peel/restick.
        delay: 520,
        easing: 'cubic-bezier(.18,.8,.22,1)',
        fill: 'both'
      });
      return animation.finished.catch(function () { }).then(function () {
        animation.cancel();
      });
    }

    function play() {
      if (atlasStuckThisLoad) return;
      atlasStuckThisLoad = true;
      var index = 0;
      function placeNext() {
        var card = arrivals[index];
        if (!card) {
          if (!forced) try { localStorage.setItem(ATLAS_SEEN_KEY, String(highest)); } catch (e) { }
          return;
        }
        var before = atlasRects(grid);
        card.style.opacity = '0';
        card.classList.remove('new-stamp-pending');
        card.classList.add('new-stamp-arriving');
        packAtlasGrids(grid);
        requestAnimationFrame(function () {
          // The collection makes room first; the new issue follows a fraction
          // later and lands once. No peel, roller, or second restick snap.
          animateAtlasFlip(grid, before, { solid: true, duration: 500 });
          plop(card, index).then(function () {
            card.style.removeProperty('opacity');
            card.classList.remove('new-stamp-arriving');
            index++;
            setTimeout(placeNext, 145);
          });
        });
      }
      placeNext();
    }

    if (forced && currentView !== 2) go(2);
    if (currentView === 2) { setTimeout(play, 850); return; }
    // wait until the atlas is brought forward
    var t = setInterval(function () {
      if (currentView === 2) { clearInterval(t); setTimeout(play, 850); }
    }, 300);
    setTimeout(function () { clearInterval(t); }, 120000);
  }

  var atlasCardAudio = null;
  var atlasCardAudioButton = null;
  function setAtlasCardButtonState(btn, state) {
    if (!btn) return;
    btn.setAttribute('data-state', state);
    if (state === 'playing') {
      btn.setAttribute('data-active', 'true');
      btn.innerHTML = ICON_PAUSE + '<span>stop</span>';
    } else if (state === 'loading') {
      btn.setAttribute('data-active', 'true');
      btn.innerHTML = ICON_PLAY + '<span>...</span>';
    } else if (state === 'missing') {
      btn.setAttribute('data-active', 'false');
      btn.innerHTML = ICON_PLAY + '<span>no audio</span>';
      setTimeout(function () {
        if (btn.getAttribute('data-state') === 'missing') {
          btn.innerHTML = ICON_PLAY + '<span>play</span>';
          btn.setAttribute('data-state', 'idle');
        }
      }, 2200);
    } else {
      btn.setAttribute('data-active', 'false');
      btn.innerHTML = ICON_PLAY + '<span>play</span>';
    }
  }
  function clearAtlasCardProgress(card) {
    if (!card) return;
    var sw = card.querySelector('.spectro-wrap');
    if (sw) sw.style.setProperty('--prog', '0%');
    card.removeAttribute('data-playing');
  }
  function stopAtlasCardAudio() {
    audioRelease(stopAtlasCardAudio);
    var audio = atlasCardAudio;
    var btn = atlasCardAudioButton;
    atlasCardAudio = null;
    atlasCardAudioButton = null;
    if (audio) {
      try { audio.pause(); } catch (e) { }
    }
    if (btn) {
      clearAtlasCardProgress(btn.closest('.bird-card'));
      setAtlasCardButtonState(btn, 'idle');
    }
  }
  function activateAtlasCardAudio(btn) {
    var card = btn && btn.closest('.bird-card');
    if (!card) return;
    if (btn === atlasCardAudioButton) { stopAtlasCardAudio(); return; }
    stopAtlasCardAudio();
    audioClaim(stopAtlasCardAudio);   // stop any modal-recording / live-stream audio
    setAtlasCardButtonState(btn, 'loading');
    atlasCardAudioButton = btn;
    // Render the spectrogram client-side from the recording's audio so
    // it matches the active theme. paintSpectrogram paints with the
    // --paper/--ink palette per data-theme (the same canvas the modal
    // recordings use), instead of a fixed-colour PNG that can't follow
    // light/dark mode. Decoded buffers are cached per URL.
    var spectroWrap = card.querySelector('.spectro-wrap');
    if (spectroWrap && !spectroWrap.firstChild) {
      var canvas = document.createElement('canvas');
      spectroWrap.appendChild(canvas);
      var aurl = card.dataset.audio;
      if (_decodedCache[aurl]) {
        paintSpectrogram(canvas, _decodedCache[aurl]);
      } else {
        var actx = getSpecCtx();
        if (actx) {
          fetch(aurl)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then(function (b) { return actx.decodeAudioData(b); })
            .then(function (buf) {
              _decodedCache[aurl] = buf;
              // Guard on document containment, not spectroWrap.contains:
              // a 30s refreshAll() poll can rebuild the atlas and detach
              // this card mid-decode. The detached wrap still "contains"
              // its canvas, but a detached node measures 0x0, which would
              // trap paintSpectrogram in its size-retry loop forever.
              if (document.contains(canvas)) paintSpectrogram(canvas, buf);
            })
            .catch(function () { if (spectroWrap.contains(canvas)) spectroWrap.removeChild(canvas); });
        } else {
          spectroWrap.removeChild(canvas);
        }
      }
    }
    // Start audio.
    var audio = new Audio(card.dataset.audio);
    audio.addEventListener('canplay', function () {
      if (atlasCardAudioButton !== btn || atlasCardAudio !== audio) return;
      setAtlasCardButtonState(btn, 'playing');
      card.setAttribute('data-playing', 'true');
      audio.play();
    });
    // Progress bar on the spectrogram strip.
    audio.addEventListener('timeupdate', function () {
      if (atlasCardAudioButton !== btn || atlasCardAudio !== audio) return;
      var pct = audio.duration ? (audio.currentTime / audio.duration * 100) : 0;
      if (spectroWrap) spectroWrap.style.setProperty('--prog', pct.toFixed(1) + '%');
    });
    audio.addEventListener('ended', function () {
      if (atlasCardAudioButton === btn && atlasCardAudio === audio) stopAtlasCardAudio();
    });
    audio.addEventListener('error', function () {
      if (atlasCardAudioButton === btn && atlasCardAudio === audio) {
        audioRelease(stopAtlasCardAudio);
        setAtlasCardButtonState(btn, 'missing');
        clearAtlasCardProgress(card);
        atlasCardAudio = null;
        atlasCardAudioButton = null;
      }
    });
    atlasCardAudio = audio;
    audio.load();
  }
  function wireAtlasCardAudio(grid) {
    if (!grid || grid.__atlasCardAudioWired) return;
    grid.__atlasCardAudioWired = true;
    grid.addEventListener('click', function (ev) {
      var btn = ev.target.closest && ev.target.closest('[data-action="play"]');
      if (!btn || !grid.contains(btn)) return;
      activateAtlasCardAudio(btn);
    });
  }
  function wireAtlasSpectrogramScrub(grid) {
    if (!grid || grid.__atlasSpectrogramScrubWired) return;
    grid.__atlasSpectrogramScrubWired = true;
    grid.addEventListener('click', function (ev) {
      var sw = ev.target.closest && ev.target.closest('.spectro-wrap');
      if (!sw || !sw.firstChild) return;
      var card = sw.closest('.bird-card');
      var btn = card && card.querySelector('[data-action="play"]');
      if (!btn) return;
      if (atlasCardAudioButton === btn && atlasCardAudio && atlasCardAudio.duration) {
        var rect = sw.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        atlasCardAudio.currentTime = pct * atlasCardAudio.duration;
      } else {
        btn.click();
      }
    });
  }

  function renderAtlas(animate) {
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;
    stopAtlasCardAudio();
    var classic = atlasUsesClassicCards();
    var priorRects = classic ? {} : atlasRects(grid);

    function showAtlasEmpty(message, hint) {
      // A packed wall owns an inline pixel height. If a later time window has
      // no birds, carrying that height into the empty state leaves several
      // screens of blank paper beneath the message.
      clearAtlasPackedState(grid);
      grid.removeAttribute('data-mode');
      grid.dataset.layout = classic ? 'classic' : 'stamps';
      grid.dataset.sort = window.__atlasSort || 'life';
      grid.innerHTML = '<div class="atlas-empty' + (hint ? '' : ' window-empty') + '">' +
        '<p>' + message + '</p>' +
        (hint ? '<p class="hint">' + hint + '</p>' : '') +
        '</div>';
      queueAtlasOverflowState();
    }

    var lifelist = (DATA.lifelist && DATA.lifelist.species) || [];
    var recent = (DATA.recent && DATA.recent.species) || [];
    var atlasHours = atlasWindowHours();
    // Window count lookup: sci -> count in current window.
    var winBySci = {};
    recent.forEach(function (s) { winBySci[s.sci] = +s.n; });

    if (!lifelist.length) {
      showAtlasEmpty('No birds detected yet.',
        'The atlas fills up as BirdNET-Pi identifies new species.');
      return;
    }

    // Time-window filter: when a windowed view is selected, only show
    // species heard in that window. ALL preserves the full lifelist.
    var isAllWindow = atlasHours >= 1000000;
    var filtered = isAllWindow
      ? lifelist
      : lifelist.filter(function (s) { return (winBySci[s.sci] || 0) > 0; });
    if (!filtered.length) {
      showAtlasEmpty(EMPTY_WINDOW_COPY);
      return;
    }

    // Sort by the atlas-sort segmented control (defaults to "count" =
    // most-heard all time).
    var sortMode = (window.__atlasSort) || 'life';
    var species = filtered.slice();
    // Accession number is the stable order in which a species entered the
    // complete life list. Build it before sorting so Life List can use the
    // number itself as its source of truth, including tied timestamps.
    var accession = {};
    lifelist.slice().sort(function (a, b) {
      return (a.first_seen || '').localeCompare(b.first_seen || '') ||
        (a.sci || '').localeCompare(b.sci || '');
    }).forEach(function (s, i) { accession[s.sci] = i + 1; });
    if (sortMode === 'count') {
      species.sort(function (a, b) { return (+b.n) - (+a.n); });
    } else if (sortMode === 'alpha') {
      species.sort(function (a, b) {
        return (a.com || a.sci || '').localeCompare(b.com || b.sci || '');
      });
    } else if (sortMode === 'family') {
      // grouped by family, and within a family the most-heard leads
      species.sort(function (a, b) {
        var fa = (window.STAMPS ? window.STAMPS.familyOf(a.sci) : 'Other');
        var fb = (window.STAMPS ? window.STAMPS.familyOf(b.sci) : 'Other');
        return fa.localeCompare(fb) || (+b.n) - (+a.n);
      });
    } else {
      // life list: the order species entered the collection, newest arrival first
      species.sort(function (a, b) {
        return (accession[b.sci] || 0) - (accession[a.sci] || 0);
      });
    }

    // A species is a "lifer" in the current view if its all-time first
    // detection falls inside the selected window - i.e. it was newly added
    // to the life list this 1h / 12h / 24h / 7d. Never shown for the ALL
    // window (every species would qualify against an open-ended span).
    var now = Date.now();
    var windowStartMs = now - atlasHours * 3600000;

    var cardHtml = species.map(function (s) {
      var total = +s.n || 0;
      var win = winBySci[s.sci] || 0;
      var firstMs = Date.parse((s.first_seen || '').replace(' ', 'T'));
      var isLifer = !isAllWindow && !isNaN(firstMs) && firstMs >= windowStartMs;
      var sketchSrc = './avian/api/cutout.php?sci=' + encodeURIComponent(s.sci) +
        (s.com ? '&com=' + encodeURIComponent(s.com) : '') +
        '&v=' + artRevision(s.sci, SKETCH_VERSION);
      var audioSrc = './avian/api/recording.php?sci=' + encodeURIComponent(s.sci);
      // The "all time" window makes the windowed count identical to the
      // all-time count - collapse to a single stat rather than print the
      // same number twice. Otherwise label the count with its span.
      var statRows = isAllWindow
        ? '<div><span class="n">' + fmtNK(total) + '</span><span class="lbl-inline">all time</span></div>'
        : '<div><span class="n">' + fmtNK(win) + '</span><span class="lbl-inline">' + windowLabel(atlasHours) + '</span></div>'
        + '<div><span class="n">' + fmtNK(total) + '</span><span class="lbl-inline">all time</span></div>';
      // Heard but never drawn: issue the bird's real family stamp with the
      // egg nest occupying its artwork plate. Waiting on tablesReady keeps
      // a card from flashing the placeholder before dims.json lands.
      var needsArt = tablesReady && !DIMS[slugify(s.sci)];
      var fresh = justGenerated[s.sci] ? '&t=' + justGenerated[s.sci] : '';
      if (classic) {
        var common = s.com || s.sci;
        var imageSrc = needsArt ? './nest-eggs.webp' : sketchSrc + fresh;
        var birdWiki = wikiUrl(s.sci);
        var birdEbird = ebirdUrl(s.sci);
        return ''
          + '<article class="bird-card classic-atlas-card' + (needsArt ? ' needs-art' : '') + '"'
          + ' data-sci="' + escHtml(s.sci) + '" data-com="' + escHtml(s.com || '') + '" data-audio="' + escHtml(audioSrc) + '"'
          + ' data-acc="' + (accession[s.sci] || 0) + '"'
          + ' data-fresh="' + (isLifer ? '1' : '0') + '" data-win="' + win + '" data-total="' + total + '">'
          + (isLifer ? '<span class="lifer-badge" title="new to the life list in this window">lifer</span>' : '')
          + '<div class="stat">' + statRows + '</div>'
          + '<div class="img-wrap">'
          + '<img loading="lazy" decoding="async" src="' + escHtml(imageSrc) + '" alt="' + escHtml(common) + '">'
          + '</div>'
          + '<h3>' + escHtml(common) + '</h3>'
          + '<div class="sci">' + escHtml(s.sci) + '</div>'
          + '<div class="spectro-wrap" aria-hidden="true"></div>'
          + '<div class="actions">'
          + '<button type="button" class="chip play" data-action="play" aria-label="play recording">'
          + ICON_PLAY + '<span>play</span>'
          + '</button>'
          + '<a class="chip ext" href="' + escHtml(birdWiki) + '" target="_blank" rel="noopener" aria-label="Wikipedia">wiki</a>'
          + (birdEbird ? '<a class="chip ext" href="' + escHtml(birdEbird) + '" target="_blank" rel="noopener" aria-label="eBird">ebird</a>' : '')
          + '</div>'
          + '</article>';
      }
      // Each species prints as a stamp whose design is set by its family.
      // The card stays the click target so the detail modal, highlighting
      // and deep links keep working untouched.
      var bird = {
        sci: s.sci, com: s.com, index: accession[s.sci] || 0, count: total,
        placeholder: needsArt
      };
      var renderKey = [s.sci, s.com || '', accession[s.sci] || 0, total,
        needsArt ? 'todo' : 'stamp', fresh,
        artRevision(s.sci, SKETCH_VERSION)].join('|');
      // Keep the Atlas issue itself as one clean click target. Generation lives
      // in the postcard's pose-control slot, where its cost and resulting state
      // change have enough context; no badge competes with the family artwork.
      var inner = window.STAMPS
        ? window.STAMPS.markup(bird, needsArt ? './nest-eggs.webp' : sketchSrc + fresh)
        : '';
      return ''
        + '<article class="bird-card stamp-card' + (needsArt ? ' needs-art' : '') + '"'
        + ' data-sci="' + escHtml(s.sci) + '" data-com="' + escHtml(s.com || '') + '" data-audio="' + escHtml(audioSrc) + '"'
        + ' data-render-key="' + escHtml(renderKey) + '"'
        + ' data-acc="' + (accession[s.sci] || 0) + '"'
        + ' data-fresh="' + (isLifer ? '1' : '0') + '" data-win="' + win + '" data-total="' + total + '">'
        + inner
        + '</article>';
    });

    // A spanning heading inside an auto-fill grid collapses the track count,
    // so the family view is built as one section per family instead.
    if (sortMode === 'family' && window.STAMPS) {
      var out = '', run = [], cur = null;
      function flush() {
        if (!run.length) return;
        out += '<section class="fam-block">'
             + '<h2 class="atlas-fam"><span>' + escHtml(cur) + '</span><i></i>'
             + '<em>' + run.length + ' species</em></h2>'
             + '<div class="atlas-fam-grid">' + run.join('') + '</div></section>';
        run = [];
      }
      species.forEach(function (sp, i) {
        var fam = window.STAMPS.familyOf(sp.sci);
        if (fam !== cur) { flush(); cur = fam; }
        run.push(cardHtml[i]);
      });
      flush();
      if (classic) commitClassicAtlasMarkup(grid, out, sortMode, true);
      else commitAtlasMarkup(grid, out, sortMode, true);
    } else {
      if (classic) commitClassicAtlasMarkup(grid, cardHtml.join(''), sortMode, false);
      else commitAtlasMarkup(grid, cardHtml.join(''), sortMode, false);
    }

    if (classic) {
      // Classic cards use the historical responsive grid. Leave stamp-only
      // geometry, visual effects, FLIP motion, and stick-on arrivals dormant.
      requestAnimationFrame(function () {
        queueAtlasOverflowState();
        queueCompactHeader();
      });
    } else {
      packAtlasGrids(grid);
      requestAnimationFrame(function () {
        animateAtlasFlip(grid, priorRects);
        queueCompactHeader();
      });

      // The stamp designs that use a real pixel treatment (cyanotype, halftone,
      // low-poly, engraving) paint onto a canvas once it has been laid out.
      if (window.FX) {
        requestAnimationFrame(function () { window.FX.run(grid); });
        setTimeout(function () { window.FX.run(grid); }, 400);
      }

      // Species heard since the last time the atlas was opened are stuck on
      // one at a time, oldest arrival first, instead of wearing a badge.
      // Runs once per page load, and only once the atlas is actually on
      // screen, so the moment is never spent behind another view.
      maybeStickNewStamps(grid, accession);
    }

    // Wire audio playback + spectrogram load.
    // - Only one card plays at a time. Clicking play on a different card
    //   stops the current one first.
    // - The spectrogram is lazily fetched on first play (saves a Pi hit
    //   for every card visible on initial render).
    // - If the recording endpoint 404s (no detection yet for this
    //   species), the button reverts and shows "no audio".
    // The Atlas root survives every render, including keyed stamp-card reuse.
    // One delegated play handler therefore covers both layouts without ever
    // accumulating listeners on a retained card or button.
    wireAtlasCardAudio(grid);

    // One delegated scrub listener survives all card rebuilds. Repeated Atlas
    // refreshes must not multiply the seek or restart action.
    wireAtlasSpectrogramScrub(grid);
    if (animate) playAtlasEntrance();
  }

  var atlasResizeFrame = 0;
  var atlasResizeSettleTimer = 0;
  var atlasResizeSettling = false;
  window.addEventListener('resize', function () {
    atlasResizeSettling = true;
    clearTimeout(atlasResizeSettleTimer);
    atlasResizeSettleTimer = setTimeout(function () {
      atlasResizeSettleTimer = 0;
      if (atlasResizeFrame) {
        cancelAnimationFrame(atlasResizeFrame);
        atlasResizeFrame = 0;
      }
      atlasResizeSettling = false;
      var grid = document.getElementById('atlasGrid');
      if (grid) packAtlasGrids(grid);
    }, 140);
    if (atlasResizeFrame) return;
    atlasResizeFrame = requestAnimationFrame(function () {
      atlasResizeFrame = 0;
      var grid = document.getElementById('atlasGrid');
      if (grid) packAtlasGrids(grid);
    });
  }, { passive: true });

  // The chart column and the info column must be the same height: the info
  // column is fixed content, so its natural height is the target, and both
  // charts fill it exactly. Measuring beats grid stretch here because the
  // view-slide container height-caps the grid and defeats the stretch.
  function syncChartHeight() {
    var side = document.querySelector('.stats-side');
    var chart = document.querySelector('.stats-chart');
    if (!side || !chart) return;
    if (window.matchMedia('(max-width: 900px)').matches) {
      document.documentElement.style.removeProperty('--chart-h');   // single column stacks
      return;
    }
    // While the ledger is expanded the side panel is stretched to the tall row,
    // so its height is the expanded height, not the collapsed slot. Measuring it
    // now would write that into --chart-h and the next collapse would compute
    // that everything fits and never trim. Leave the resting value be until the
    // ledger is back to its fitted height.
    if (hourlyExpanded) return;
    // offsetHeight already forces the layout this needs, so there is nothing
    // for a rAF to batch; doing it inline also cannot be left half-done by a
    // frame that never arrives.
    var h = side.offsetHeight;
    if (h > 200) document.documentElement.style.setProperty('--chart-h', h + 'px');
    if (statsHeatmapEl && statsHeatmapEl.style.display !== 'none' && !hourlyExpanded) renderHourly();
  }
  window.addEventListener('resize', syncChartHeight);

  function renderWindowDependent(animate) {
    renderCollageFromData(animate);
    renderAtlas(animate);
  }
  function renderTimeIndependent(animate) {
    // Lists first, then the graph (see renderWindowDependent).
    renderStatsLists();
    drawHistograms(animate);
    renderRhythm();
    syncChartHeight();
    renderAtlas(animate);
  }

  function renderStatsContext(animate) {
    hourlyExpanded = false;
    renderStatsLists();
    drawHistograms(animate);
    renderRhythm();
    renderHourly();
    updateStatsDateNav();
    syncChartHeight();
  }

  function refreshStatsContext(animate) {
    var seq = ++statsContextSeq;
    var forDate = currentHours >= 1000000 ? hourlyDate : null;
    var forHours = currentHours;
    var dateArg = forDate ? '&date=' + encodeURIComponent(forDate) : '';
    return Promise.all([
      fetchJson('./avian/api/birdnet-api.php?action=stats' + dateArg),
      fetchJson('./avian/api/birdnet-api.php?action=firstseen&limit=10' + dateArg),
      fetchJson('./avian/api/birdnet-api.php?action=recent&hours=' + forHours + dateArg),
      fetchJson('./avian/api/birdnet-api.php?action=rhythm&hours=' + forHours + dateArg),
      fetchJson('./avian/api/birdnet-api.php?action=hourly' + dateArg),
    ]).then(function (parts) {
      if (seq !== statsContextSeq || forDate !== hourlyDate || forHours !== currentHours) return;
      DATA.stats = parts[0];
      DATA.firstseen = parts[1];
      DATA.statsRecent = parts[2];
      if (parts[2] && typeof parts[2].site_name === 'string') applySiteName(parts[2].site_name);
      DATA.rhythm = parts[3];
      DATA.hourly = parts[4];
      renderStatsContext(animate);
    }).catch(function (e) { console.warn('stats context fetch failed', e); });
  }

  function refreshRecent(animate) {
    // Capture the window this fetch was issued for. If the user
    // changes the picker again before it resolves - or a slower poll
    // lands later - we discard the stale response so the collage
    // never reverts to a different window.
    var forHours = currentHours;
    return fetchJson('./avian/api/birdnet-api.php?action=recent&hours=' + forHours)
      .then(function (j) {
        if (forHours !== currentHours) return; // window changed mid-flight
        if (typeof j.site_name === 'string') applySiteName(j.site_name);
        DATA.recent = j; renderWindowDependent(animate);
      })
      .catch(function (e) { console.warn('recent fetch failed', e); });
  }
  function refreshAll(animate) {
    var forHours = currentHours;
    var liveStats = hourlyDate === null;
    return Promise.all([
      liveStats ? fetchJson('./avian/api/birdnet-api.php?action=stats').catch(function () { return null; }) : Promise.resolve(null),
      fetchJson('./avian/api/birdnet-api.php?action=lifelist').catch(function () { return null; }),
      fetchJson('./avian/api/birdnet-api.php?action=timeseries&days=30').catch(function () { return null; }),
      liveStats ? fetchJson('./avian/api/birdnet-api.php?action=firstseen&limit=10').catch(function () { return null; }) : Promise.resolve(null),
      fetchJson('./avian/api/birdnet-api.php?action=recent&hours=' + forHours).catch(function () { return null; }),
      liveStats ? fetchJson('./avian/api/birdnet-api.php?action=rhythm&hours=' + forHours).catch(function () { return null; }) : Promise.resolve(null),
      liveStats ? fetchJson('./avian/api/birdnet-api.php?action=hourly').catch(function () { return null; }) : Promise.resolve(null),
      DATA.calendar ? Promise.resolve(null) : fetchJson('./avian/api/birdnet-api.php?action=calendar').catch(function () { return null; }),
    ]).then(function (parts) {
      var stillLiveStats = liveStats && hourlyDate === null;
      if (stillLiveStats && parts[0]) DATA.stats = parts[0];
      DATA.lifelist = parts[1];
      DATA.timeseries = parts[2];
      if (stillLiveStats && parts[3]) DATA.firstseen = parts[3];
      // Only accept the recent slice if the window hasn't changed
      // since this poll started - otherwise keep what's there.
      if (forHours === currentHours && parts[4]) {
        DATA.recent = parts[4];
        if (stillLiveStats) DATA.statsRecent = parts[4];
        if (typeof parts[4].site_name === 'string') applySiteName(parts[4].site_name);
      }
      // A failed rhythm poll keeps the last-known chart rather than blanking it.
      if (stillLiveStats && parts[5]) DATA.rhythm = parts[5];
      if (stillLiveStats && parts[6]) DATA.hourly = parts[6];
      if (parts[7]) {
        DATA.calendar = parts[7];
        var cal = document.getElementById('statsCalendar');
        if (cal && cal.getAttribute('aria-hidden') === 'false') renderStatsCalendar();
      }
      recomputeDerived();
      renderTimeIndependent(animate);
      renderHourly();
      updateStatsDateNav();
      renderCollageFromData(animate);
    });
  }

  // Kick off the initial fetch. Renders pull from DATA as soon as it
  // populates; until then the page sits with empty histograms + lists.
  // animate=true so the collage blooms in on first load.
  refreshAll(true);

  // Hook into the window picker so the data refetches on change. Pass
  // animate=true so the collage blooms (the silent poll passes nothing).
  winBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      if (currentHours < 1000000) hourlyDate = null;
      updateStatsDateNav();
      refreshRecent(true);
      refreshStatsContext(true);
    });
  });

  // ---- Realtime polling ----
  // Every POLL_MS the page refetches the live data set so the collage,
  // stats, and atlas reflect new detections without a manual reload.
  // We use refreshAll() (cheap: 5 small JSON fetches) so the dependent
  // text/charts update too. Polling pauses when the tab is hidden and
  // resumes (with an immediate fetch) when it becomes visible again.
  var POLL_MS = 30 * 1000;
  var pollTimer = null;
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      refreshAll();
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopPolling();
    } else {
      // Force an immediate refresh on return so the user sees fresh
      // data right away, then resume normal polling cadence.
      refreshAll();
      startPolling();
    }
  });
  startPolling();

  // ---- Menu dropdown - the button morphs into its own card ----
  var shell = document.getElementById('menuShell');
  var surface = shell.querySelector('.menu-surface');
  var dd = document.getElementById('menu-dd');
  var menuBtn = document.getElementById('menuBtn');
  // Consumed further down by renderMenu and the unlock form, unchanged.
  var locked = document.getElementById('dd-locked');
  var items = document.getElementById('dd-items');
  var lockHint = document.getElementById('lockHint');
  var lockTransport = document.getElementById('lockTransport');
  var adminLock = document.getElementById('adminLock');
  var resetLiveAudioTransientState = null;
  var stopLiveAudioNow = null;
  var adminAccessState = 'checking';
  var pendingAdminSection = null;
  var adminAuthMeta = { required: false, lan_policy: false, password_configured: false };
  var ADMIN_IDLE_MS = 30 * 60 * 1000;
  var ADMIN_ACTIVITY_PING_MS = 60 * 1000;
  var ADMIN_ACTIVITY_PUBLISH_MS = 1000;
  var ADMIN_ACTIVITY_KEY = 'avian:admin-activity';
  var ADMIN_LOCK_KEY = 'avian:admin-lock';
  var ADMIN_SESSION_KEY = 'avian:admin-session';
  var adminIdleTimer = null;
  var adminLastActivityAt = 0;
  var adminLastActivityPingAt = 0;
  var adminLastActivityPublishedAt = 0;
  var adminActivityPublishTimer = null;
  var adminAutoLocking = false;
  var adminAuthGeneration = 0;
  var adminViewGeneration = 0;
  var adminUnlockProbeGeneration = 0;
  var pendingAdminNotice = null;
  var adminChannel = null;

  try {
    if (window.BroadcastChannel) adminChannel = new BroadcastChannel('avian-admin-auth');
  } catch (e) {}

  if (lockTransport) {
    var loopbackPreview = /^(localhost|127(?:[.]\d{1,3}){3}|\[?::1\]?)$/i.test(location.hostname);
    lockTransport.hidden = location.protocol === 'https:' || loopbackPreview;
  }

  var SHEET_R = 14;            // the sheet's resting corner, from styles.css
  // Reversing mid-flight should cost the travel that is left, not the
  // whole gesture, or a fast double-press feels slower than a single
  // one. The floors keep a near-finished morph from snapping.
  var MIN_OPEN_MS = 150, MIN_CLOSE_MS = 120;
  var STOPS = 24;
  // The panel's inverse scale is unbounded as the sheet approaches pill
  // size, and Chrome sizes a composited layer's raster for the largest
  // scale it will reach. Capping it costs nothing: everything past this
  // point happens while the contents are still at zero opacity.
  var MAX_INV = 2.2;
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

  var canAnimate = !!surface.animate;
  var running = [], endTimer = null, endNow = null;

  function reduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  // The timing lives in the stylesheet, in one place, for both halves of
  // the gesture. Reading it back means script never holds a second copy
  // of a number the designer might change.
  function cssVar(name) {
    return getComputedStyle(shell).getPropertyValue(name).trim();
  }
  function ms(name) {
    var v = cssVar(name), n = parseFloat(v);
    if (!n) return 320;
    return v.indexOf('ms') > -1 ? n : n * 1000;
  }
  // Current x/y scale of an element mid-flight, so an interrupted morph
  // resumes from where it actually is rather than snapping back.
  function scaleOf(el) {
    var m = getComputedStyle(el).transform;
    if (!m || m === 'none') return [1, 1];
    var p = m.slice(m.indexOf('(') + 1, -1).split(',');
    if (p.length === 16) return [parseFloat(p[0]), parseFloat(p[5])];
    if (p.length === 6) return [parseFloat(p[0]), parseFloat(p[3])];
    return [1, 1];
  }
  function stop() {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    endNow = null;
    for (var i = 0; i < running.length; i++) { try { running[i].cancel(); } catch (e) {} }
    running = [];
  }

  /* The shape change, as three keyframe tracks sampled along one
     parameter u.

     The parameter is the point of the whole thing. A plain transition
     cannot drive a container and its counter-scaled contents together:
     the browser would interpolate scale and 1/scale independently and
     their product would swell to nearly 2x in the middle of the motion,
     which is exactly the squash the counter-scale exists to prevent.
     Sampling both tracks against the same u and letting the easing map
     time onto u keeps the product at 1 on every frame.

     The corner is a third track because a border-radius on a scaled box
     renders at radius x scale, so the authored value has to be divided
     back out per axis, in CSS's elliptical Rx / Ry form. It rides its
     own animation rather than joining the transform's: border-radius is
     a paint property, and mixing it into the transform effect would
     drag the transform off the compositor with it. */
  function tracks(sxA, syA, sxB, syB, rA, rB) {
    var surf = [], panel = [], corner = [], i, u, sx, sy, r;
    for (i = 0; i <= STOPS; i++) {
      u = i / STOPS;
      sx = sxA + (sxB - sxA) * u;
      sy = syA + (syB - syA) * u;
      r = rA + (rB - rA) * u;
      surf.push({ offset: u, transform: 'scale(' + sx.toFixed(5) + ',' + sy.toFixed(5) + ')' });
      panel.push({ offset: u, transform: 'scale(' + Math.min(MAX_INV, 1 / sx).toFixed(5) + ',' + Math.min(MAX_INV, 1 / sy).toFixed(5) + ')' });
      corner.push({ offset: u, borderRadius: (r / sx).toFixed(2) + 'px / ' + (r / sy).toFixed(2) + 'px' });
    }
    return [surf, panel, corner];
  }
  function play(t, dur, ease, onEnd) {
    var opt = { duration: dur, easing: ease, fill: 'forwards' };
    var a = surface.animate(t[0], opt);
    var b = dd.animate(t[1], opt);
    var c = surface.animate(t[2], opt);
    running = [a, b, c];
    // A backgrounded tab does not tick the document timeline, so the
    // finish event may never arrive. Without the fallback a close
    // started just before the tab is hidden would stay half-collapsed.
    var fired = false;
    function end() { if (fired) return; fired = true; endNow = null; onEnd(); }
    endNow = end;
    a.onfinish = end;
    if (endTimer) clearTimeout(endTimer);
    endTimer = setTimeout(end, dur + 40);
  }

  // The panel sits out of flow at its final width in both states, so its
  // height is readable while the sheet is still clipped to a pill. The
  // shell takes that size outright - one assignment, no animated box.
  function sizeShell() {
    shell.style.width = dd.offsetWidth + 'px';
    shell.style.height = dd.offsetHeight + 'px';
  }
  var ro = window.ResizeObserver ? new ResizeObserver(function () {
    if (isOpen() && shell.hasAttribute('data-settled')) sizeShell();
  }) : null;

  function focusables() {
    return [].slice.call(shell.querySelectorAll(FOCUSABLE)).filter(function (el) {
      return el === menuBtn || el.offsetParent !== null;
    });
  }
  // preventScroll because the shell is fixed: without it the browser is
  // free to scroll the page behind the overlay to reach the row.
  function focusEl(el) {
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  function focusIn() {
    var pass = document.getElementById('lockPass');
    if (pass && pass.offsetParent) { focusEl(pass); return; }
    var f = focusables();
    for (var i = 0; i < f.length; i++) { if (f[i] !== menuBtn) { focusEl(f[i]); return; } }
    focusEl(menuBtn);
  }
  function isOpen() { return shell.hasAttribute('data-open'); }
  function pillScale() {
    return [menuBtn.offsetWidth / dd.offsetWidth, menuBtn.offsetHeight / dd.offsetHeight];
  }
  // How far along the shape travel a given x-scale sits, 0 at the pill
  // and 1 at the sheet. Both the corner and the shortened duration of an
  // interrupted morph are keyed to this rather than to a clock, so a
  // reversal picks up the shape it can actually see.
  function progress(sx, sx0) {
    var p = (sx - sx0) / (1 - sx0);
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  }

  function openDd() {
    if (isOpen() && !shell.hasAttribute('data-closing')) return;
    // Reopening mid-close picks up the shape where the collapse left it.
    var mid = shell.hasAttribute('data-closing') ? scaleOf(surface) : null;
    stop();

    // Measured, and --m-dur written, BEFORE the state attribute flips.
    // The attribute is what arms every CSS transition in the block; a
    // duration written after that recalc would be read by nothing.
    var s0 = pillScale();
    var h = menuBtn.offsetHeight;
    var sxA = mid ? mid[0] : s0[0], syA = mid ? mid[1] : s0[1];
    var from = progress(sxA, s0[0]);
    var live = canAnimate && !reduced();
    var dur = Math.max(MIN_OPEN_MS, Math.round(ms('--m-open') * (1 - from)));
    var ease = cssVar('--m-ease-open');
    if (live) shell.style.setProperty('--m-dur', dur + 'ms');
    else shell.style.removeProperty('--m-dur');

    shell.removeAttribute('data-closing');
    shell.setAttribute('data-open', '');
    dd.setAttribute('aria-hidden', 'false');
    menuBtn.setAttribute('aria-expanded', 'true');
    sizeShell();
    if (ro) ro.observe(dd);
    focusIn();

    if (!live) { shell.setAttribute('data-settled', ''); return; }
    // The corner travels with the shape, not the clock, so an
    // interrupted close reopens from the corner it currently has.
    var rA = (h / 2) + (SHEET_R - h / 2) * from;
    play(tracks(sxA, syA, 1, 1, rA, SHEET_R), dur, ease, function () {
      if (!isOpen()) return;
      stop();
      shell.style.removeProperty('--m-dur');
      shell.setAttribute('data-settled', '');
    });
  }

  function closeDd() {
    if (!isOpen() || shell.hasAttribute('data-closing')) return;
    // A failed or still-connecting stream belongs to this visit to the
    // drawer. Closing clears that transient state so the next open offers a
    // clean retry instead of preserving a dead, disabled control.
    if (resetLiveAudioTransientState) resetLiveAudioTransientState();
    // Straight away, not when the collapse ends: the rows go
    // visibility:hidden at that point, and focus sitting on one of them
    // would be dropped on the floor rather than handed back.
    if (shell.contains(document.activeElement)) focusEl(menuBtn);
    var mid = scaleOf(surface);
    stop();

    var s0 = pillScale();
    var h = menuBtn.offsetHeight;
    var from = progress(mid[0], s0[0]);
    var live = canAnimate && !reduced();
    var dur = Math.max(MIN_CLOSE_MS, Math.round(ms('--m-close') * from));
    var ease = cssVar('--m-ease-close');

    shell.removeAttribute('data-settled');
    dd.setAttribute('aria-hidden', 'true');
    menuBtn.setAttribute('aria-expanded', 'false');
    if (ro) ro.unobserve(dd);

    function done() {
      // Dropping data-open and the animation in one task means the pill
      // is never rendered at the collapsed scale.
      stop();
      shell.removeAttribute('data-open');
      shell.removeAttribute('data-closing');
      shell.style.removeProperty('--m-dur');
      shell.style.width = '';
      shell.style.height = '';
    }
    if (!live) { done(); return; }

    shell.style.setProperty('--m-dur', dur + 'ms');
    shell.setAttribute('data-closing', '');
    var rA = (h / 2) + (SHEET_R - h / 2) * from;
    play(tracks(mid[0], mid[1], s0[0], s0[1], rA, h / 2), dur, ease, done);
  }

  function toggleDd() { isOpen() && !shell.hasAttribute('data-closing') ? closeDd() : openDd(); }

  // --menu-w is viewport-relative below 700px, and every keyframe in
  // flight was sampled against the old box, so a rotate mid-morph would
  // land the sheet on a scale that no longer means anything. Finish
  // whatever is running against the old viewport, then re-measure.
  window.addEventListener('resize', function () {
    if (!isOpen()) return;
    if (endNow) { endNow(); return; }
    if (!shell.hasAttribute('data-settled')) {
      stop();
      shell.style.removeProperty('--m-dur');
      shell.setAttribute('data-settled', '');
    }
    sizeShell();
  });

  menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleDd(); });
  document.addEventListener('click', function (e) { if (!shell.contains(e.target)) closeDd(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDd(); });

  // The sheet covers the page, so Tab stays inside it until Escape or a
  // row takes you somewhere.
  shell.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !isOpen()) return;
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  function showAdminLocked(message, recovery, revealDrawer) {
    var wasAdminOn = document.body.classList.contains('admin-on');
    var previousAdminSect = adminSect;
    if (previousAdminSect) pendingAdminSection = previousAdminSect;
    if (!pendingAdminSection && typeof readAdminHash === 'function') {
      pendingAdminSection = readAdminHash();
    }
    if (stopLiveAudioNow) stopLiveAudioNow();
    lockVisibleGenerateForAuth();
    adminAccessState = 'locked';
    adminUnlockProbeGeneration += 1;
    adminAuthGeneration += 1;
    adminViewGeneration += 1;
    if (adminIdleTimer) { clearTimeout(adminIdleTimer); adminIdleTimer = null; }
    if (adminActivityPublishTimer) {
      clearTimeout(adminActivityPublishTimer);
      adminActivityPublishTimer = null;
    }
    discardPendingSettings();
    document.body.classList.remove('av-local');
    document.body.classList.add('av-forwarded');
    if (adminPollT) { clearInterval(adminPollT); adminPollT = null; }
    if (adminBody) adminBody.replaceChildren();
    if (adminEl) {
      adminEl.setAttribute('aria-hidden', 'true');
      adminEl.scrollTop = 0;
      adminEl.removeAttribute('data-admin-section');
      adminEl.setAttribute('data-title-pinned', 'false');
    }
    if (settingsInfoCleanup) settingsInfoCleanup();
    if (settingsAccessCleanup) settingsAccessCleanup();
    document.body.classList.remove('admin-on');
    adminSect = null;
    items.classList.remove('show');
    items.replaceChildren();
    if (adminLock) {
      adminLock.hidden = true;
      adminLock.disabled = false;
    }
    locked.style.display = '';
    if (wasAdminOn) queueVisibleAtlasPack();
    lockHint.textContent = recovery
      ? 'Admin password is missing or invalid. Over SSH, run sudo /usr/local/sbin/avian-admin-control password-reset.'
      : (typeof message === 'string' ? message : 'Your admin session expired. Unlock to continue.');
    lockHint.classList.toggle('lock-err', !!lockHint.textContent);
    if (pendingAdminSection && revealDrawer !== false) {
      openDd();
      setTimeout(function () { focusEl(document.getElementById('lockPass')); }, 0);
    }
  }

  function AdminAuthCancelled(reason) {
    this.name = 'AdminAuthCancelled';
    this.message = reason || 'admin authentication changed';
    this.adminAuthCancelled = true;
  }
  AdminAuthCancelled.prototype = Object.create(Error.prototype);
  AdminAuthCancelled.prototype.constructor = AdminAuthCancelled;
  function adminAuthCancelled(error) {
    return !!(error && error.adminAuthCancelled);
  }
  function cancelledAdminRequest(reason) {
    return Promise.reject(new AdminAuthCancelled(reason));
  }

  function guardAdminResponse(response, authGeneration, viewGeneration) {
    ['json', 'text', 'blob', 'arrayBuffer', 'formData'].forEach(function (method) {
      if (typeof response[method] !== 'function') return;
      var original = response[method].bind(response);
      try {
        response[method] = function () {
          return original().then(function (body) {
            if (authGeneration !== adminAuthGeneration
              || viewGeneration !== adminViewGeneration) {
              throw new AdminAuthCancelled('stale admin response body');
            }
            return body;
          });
        };
      } catch (e) {}
    });
    return response;
  }

  function signalAdminLock(message) {
    var event = { type: 'lock', at: Date.now(), message: typeof message === 'string' ? message : 'Admin controls locked.' };
    try { localStorage.setItem(ADMIN_LOCK_KEY, JSON.stringify(event)); } catch (e) {}
    if (adminChannel) {
      try { adminChannel.postMessage(event); } catch (e) {}
    }
  }

  function writeAdminActivity(at) {
    at = Math.min(Date.now(), Math.max(0, at || Date.now()));
    adminLastActivityAt = Math.max(adminLastActivityAt, at);
    adminLastActivityPublishedAt = Date.now();
    try { localStorage.setItem(ADMIN_ACTIVITY_KEY, String(at)); } catch (e) {}
    if (adminChannel) {
      try { adminChannel.postMessage({ type: 'activity', at: at }); } catch (e) {}
    }
  }

  function publishAdminActivity(at, immediate) {
    var now = Date.now();
    at = Math.min(now, Math.max(0, at || now));
    adminLastActivityAt = Math.max(adminLastActivityAt, at);
    var remaining = ADMIN_ACTIVITY_PUBLISH_MS - (now - adminLastActivityPublishedAt);
    if (immediate || remaining <= 0) {
      if (adminActivityPublishTimer) clearTimeout(adminActivityPublishTimer);
      adminActivityPublishTimer = null;
      writeAdminActivity(adminLastActivityAt);
      return;
    }
    if (!adminActivityPublishTimer) {
      adminActivityPublishTimer = setTimeout(function () {
        adminActivityPublishTimer = null;
        writeAdminActivity(adminLastActivityAt);
      }, remaining);
    }
  }

  function signalAdminSessionReplacement() {
    var event = { type: 'session-replaced', at: Date.now() };
    try { localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(event)); } catch (e) {}
    if (adminChannel) {
      try { adminChannel.postMessage(event); } catch (e) {}
    }
  }

  function sessionReplaced(notice) {
    if (notice) pendingAdminNotice = { message: notice, error: true };
    publishAdminActivity(Date.now(), true);
    signalAdminSessionReplacement();
    closeDd();
    // A same-tab policy or password update restores the Settings view as soon
    // as the replacement HttpOnly session lands. Keep the navigation drawer
    // closed throughout that handoff instead of briefly opening a lock form.
    showAdminLocked('', false, false);
    tryAutoUnlock();
  }

  function sharedAdminActivity() {
    var stored = 0;
    try { stored = parseInt(localStorage.getItem(ADMIN_ACTIVITY_KEY) || '0', 10) || 0; } catch (e) {}
    if (stored > Date.now() + 60000 || stored < 0) stored = 0;
    return Math.max(adminLastActivityAt, stored);
  }

  function receiveAdminAuthEvent(event) {
    var data = event && event.data ? event.data : event;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'activity' && Number.isFinite(data.at)
      && data.at >= 0 && data.at <= Date.now() + 60000) {
      adminLastActivityAt = Math.max(adminLastActivityAt, data.at);
      scheduleAdminIdleLock();
    } else if (data.type === 'lock') {
      showAdminLocked(typeof data.message === 'string' ? data.message : 'Admin controls locked in another tab.', false);
      // A stale request from another tab can report its old session after a
      // policy or password change has already installed a fresh shared cookie.
      // Recheck the server. A real logout stays locked because that probe is 401.
      tryAutoUnlock();
    } else if (data.type === 'session-replaced') {
      showAdminLocked('Admin session changed in another tab.', false);
      tryAutoUnlock();
    }
  }
  if (adminChannel) adminChannel.addEventListener('message', receiveAdminAuthEvent);
  window.addEventListener('storage', function (event) {
    if (event.key === ADMIN_ACTIVITY_KEY) {
      var at = parseInt(event.newValue || '0', 10) || 0;
      receiveAdminAuthEvent({ type: 'activity', at: at });
    } else if (event.key === ADMIN_LOCK_KEY && event.newValue) {
      try { receiveAdminAuthEvent(JSON.parse(event.newValue)); } catch (e) {}
    } else if (event.key === ADMIN_SESSION_KEY && event.newValue) {
      try { receiveAdminAuthEvent(JSON.parse(event.newValue)); } catch (e) {}
    }
  });

  function adminFetch(url, options) {
    options = options || {};
    if (!options.credentials) options.credentials = 'same-origin';
    if (!options.cache) options.cache = 'no-store';
    var requestGeneration = adminAuthGeneration;
    var requestViewGeneration = adminViewGeneration;
    if (adminAccessState === 'locked') return cancelledAdminRequest('admin controls are locked');
    return fetch(url, options).then(function (response) {
      if (requestGeneration !== adminAuthGeneration
        || requestViewGeneration !== adminViewGeneration) {
        return cancelledAdminRequest('stale admin response');
      }
      if (response.status !== 401) {
        return guardAdminResponse(response, requestGeneration, requestViewGeneration);
      }
      return response.clone().json().catch(function () { return {}; }).then(function (body) {
        if (requestGeneration !== adminAuthGeneration
          || requestViewGeneration !== adminViewGeneration) {
          return cancelledAdminRequest('stale admin error response');
        }
        showAdminLocked('Your admin session expired. Unlock to continue.', !!body.recovery);
        signalAdminLock('Admin session expired. Unlock to continue.');
        tryAutoUnlock();
        return cancelledAdminRequest('admin session expired');
      });
    }, function (error) {
      if (requestGeneration !== adminAuthGeneration
        || requestViewGeneration !== adminViewGeneration) {
        return cancelledAdminRequest('stale admin response');
      }
      throw error;
    });
  }

  function pingAdminActivity() {
    var now = Date.now();
    if (adminAccessState !== 'unlocked' || !adminAuthMeta.required
      || now - adminLastActivityPingAt < ADMIN_ACTIVITY_PING_MS) return;
    adminLastActivityPingAt = now;
    adminFetch('./avian/api/menu.php?action=activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
      body: '{}',
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
    }).catch(function (error) {
      if (!adminAuthCancelled(error)) adminLastActivityPingAt = 0;
    });
  }

  function lockAdminSession() {
    return fetch('./avian/api/menu.php?action=lock', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
      body: '{}',
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response;
    });
  }

  function idleLockAdminSession() {
    return fetch('./avian/api/menu.php?action=idle-lock', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
      body: '{}',
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok || !body.ok) throw new Error(body.error || ('HTTP ' + response.status));
        return body;
      });
    });
  }

  function scheduleAdminIdleLock() {
    if (adminIdleTimer) clearTimeout(adminIdleTimer);
    adminIdleTimer = null;
    if (adminAccessState !== 'unlocked' || !adminAuthMeta.required) return;
    adminLastActivityAt = sharedAdminActivity();
    var remaining = ADMIN_IDLE_MS - (Date.now() - adminLastActivityAt);
    if (remaining <= 0) {
      if (adminAutoLocking) return;
      adminAutoLocking = true;
      var idleAuthGeneration = adminAuthGeneration;
      var idleViewGeneration = adminViewGeneration;
      idleLockAdminSession().then(function (result) {
        if (idleAuthGeneration !== adminAuthGeneration
          || idleViewGeneration !== adminViewGeneration) {
          tryAutoUnlock();
          return;
        }
        if (!result.locked) {
          adminLastActivityAt = Date.now() - ADMIN_IDLE_MS + Math.max(1, result.remaining) * 1000;
          scheduleAdminIdleLock();
          return;
        }
        var message = 'Admin controls locked after 30 minutes of inactivity.';
        showAdminLocked(message, !!result.recovery);
        signalAdminLock(message);
      }).catch(function () {
        if (idleAuthGeneration !== adminAuthGeneration
          || idleViewGeneration !== adminViewGeneration) {
          tryAutoUnlock();
          return;
        }
        showAdminLocked('Admin controls are hidden because the session status could not be checked. Unlock to continue.', false);
      }).then(function () { adminAutoLocking = false; });
      return;
    }
    adminIdleTimer = setTimeout(scheduleAdminIdleLock, remaining);
  }

  function noteAdminActivity(event) {
    if (!event.isTrusted || adminAccessState !== 'unlocked' || !adminAuthMeta.required) return;
    if (!shell.contains(event.target) && !(adminEl && adminEl.contains(event.target))) return;
    publishAdminActivity(Date.now());
    pingAdminActivity();
    scheduleAdminIdleLock();
  }
  document.addEventListener('pointerdown', noteAdminActivity, true);
  document.addEventListener('keydown', noteAdminActivity, true);
  document.addEventListener('touchstart', noteAdminActivity, { capture: true, passive: true });
  document.addEventListener('wheel', noteAdminActivity, { capture: true, passive: true });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      adminLastActivityAt = sharedAdminActivity();
      scheduleAdminIdleLock();
    }
  });
  window.addEventListener('pageshow', function () {
    adminLastActivityAt = sharedAdminActivity();
    scheduleAdminIdleLock();
  });
  function adminJson(url) {
    return adminFetch(url).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  // The first request decides whether this browser needs the station password.
  // Until it resolves, the drawer remains in its neutral locked state.
  function tryAutoUnlock() {
    var probeGeneration = ++adminUnlockProbeGeneration;
    return fetch('./avian/api/menu.php', { credentials: 'same-origin' }).then(function (r) {
      if (probeGeneration !== adminUnlockProbeGeneration) return;
      if (r.status === 200) {
        return r.json().then(function (j) {
          if (probeGeneration !== adminUnlockProbeGeneration) return;
          renderMenu(j.items || [], j.auth || {});
          // Notification dot on the menu button itself when something
          // inside is waiting (instant cutouts awaiting their upgrade).
          menuBtn.classList.toggle('has-dot', (j.chroma || 0) > 0);
        });
      }
      if (r.status === 401) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (probeGeneration !== adminUnlockProbeGeneration) return;
          showAdminLocked('', !!j.recovery);
        });
      }
    }).catch(function () { });
  }
  tryAutoUnlock();

  function adminPasswordBytes(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)
      || typeof TextEncoder !== 'function') return null;
    var bytes = new TextEncoder().encode(value);
    return bytes.length >= 1 && bytes.length <= 64 ? bytes : null;
  }

  function adminBasicAuthorization(value) {
    var passwordBytes = adminPasswordBytes(value);
    if (!passwordBytes) return null;
    var prefix = new TextEncoder().encode('birdnet:');
    var binary = '';
    prefix.forEach(function (byte) { binary += String.fromCharCode(byte); });
    passwordBytes.forEach(function (byte) { binary += String.fromCharCode(byte); });
    return 'Basic ' + btoa(binary);
  }

  document.getElementById('unlockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var passInput = document.getElementById('lockPass');
    var p = passInput.value;
    var hdr = adminBasicAuthorization(p);
    if (!hdr) {
      passInput.value = '';
      lockHint.textContent = 'Password must use 1 to 64 UTF-8 bytes without control characters.';
      lockHint.classList.add('lock-err');
      passInput.focus();
      return;
    }
    passInput.value = '';
    p = '';
    // The password is sent once. The API returns a password-bound HttpOnly
    // session for later Settings, System, Logs, and Tools requests.
    fetch('./avian/api/menu.php', {
      method: 'POST',
      headers: { 'Authorization': hdr, 'X-Avian-Credential': '1' },
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.status === 200) {
        return r.json().then(function (j) {
          lockHint.classList.remove('lock-err');
          lockHint.textContent = '';
          publishAdminActivity(Date.now(), true);
          renderMenu(j.items || [], j.auth || {});
        });
      } else if (r.status === 401) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          lockHint.textContent = body.recovery
            ? 'Admin password is missing or invalid. Over SSH, run sudo /usr/local/sbin/avian-admin-control password-reset.'
            : 'Wrong password.';
          lockHint.classList.add('lock-err');
          passInput.focus();
        });
      } else if (r.status === 429) {
        lockHint.textContent = 'Too many attempts. Try again shortly.';
        lockHint.classList.add('lock-err');
        passInput.focus();
      } else {
        lockHint.textContent = 'auth unavailable.';
        lockHint.classList.add('lock-err');
      }
    }).catch(function () {
      lockHint.textContent = 'network error.';
      lockHint.classList.add('lock-err');
    });
  });

  // Render the unlocked drawer:
  //   - inline LIVE AUDIO player (streams icecast through the worker tunnel)
  //   - collapsible SETTINGS section (closed by default to avoid mis-clicks)
  //   - small ADVANCED TOOLS grid for the rest of BirdNET-Pi (still
  //     opens externally; rebuilding all of these in our design is on
  //     the follow-up list)
  function menuItemMarkup(it) {
    var label = escHtml(it && it.label || '');
    var href = escHtml(it && it.href || '');
    var attrs = it && it.native ? '' : ' target="_blank" rel="noopener"';
    var classes = [];
    if (!it || !it.native) classes.push('ext');
    if (it && it.full) classes.push('full');
    var cls = classes.length ? ' class="' + classes.join(' ') + '"' : '';
    var dot = it && it.dot ? '<i class="notif-dot"></i>' : '';
    return '<a' + cls + ' href="' + href + '"' + attrs + '><span>' + label + dot + '</span></a>';
  }

  function renderMenu(menu, auth) {
    adminUnlockProbeGeneration += 1;
    adminAccessState = 'unlocked';
    adminAuthMeta = auth || {};
    adminLastActivityAt = sharedAdminActivity() || Date.now();
    scheduleAdminIdleLock();
    resumeVisibleGenerateAfterAuth();
    if (adminAuthMeta.lan_policy && stopLiveAudioNow) stopLiveAudioNow();
    document.body.classList.toggle('av-local', !adminAuthMeta.required);
    document.body.classList.toggle('av-forwarded', !!adminAuthMeta.required);
    locked.style.display = 'none';
    items.classList.add('show');
    var audioHost = location.hostname.toLowerCase();
    var audioOctets = audioHost.split('.').map(Number);
    var localAudio = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(audioHost)
      || /\.local$/.test(audioHost)
      || (audioOctets.length === 4 && audioOctets.every(function (part) {
        return Number.isInteger(part) && part >= 0 && part <= 255;
      }) && (audioOctets[0] === 10
        || audioOctets[0] === 127
        || (audioOctets[0] === 169 && audioOctets[1] === 254)
        || (audioOctets[0] === 172 && audioOctets[1] >= 16 && audioOctets[1] <= 31)
        || (audioOctets[0] === 192 && audioOctets[1] === 168)));
    var liveAudioIcon = '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false"><path d="M3 2 L10 6 L3 10 Z"/></svg>';
    var stopIcon = '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false"><rect x="3" y="3" width="6" height="6"/></svg>';
    var specOnIcon = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 9 L4 5 L6 8 L8 3 L10 7"/></svg>';
    // Build the diagnostic shortcuts (system / logs / tools). With
    // native:true they navigate in-page; otherwise they keep the old
    // open-in-new-tab behavior for the legacy BirdNET-Pi screens.
    var linksHtml = menu.map(menuItemMarkup).join('');
    if (adminAuthMeta.lan_policy) localAudio = false;
    var liveAudioHtml = localAudio ?
      '<div class="live-audio" id="liveAudio" data-on="false" data-state="idle">'
      + '  <div class="pulse"></div>'
      + '  <div class="label">Live audio<span class="hint">stream from the mic</span></div>'
      + '  <button type="button" id="liveAudioBtn" aria-live="polite" aria-atomic="true" aria-label="listen to live audio">'
      + liveAudioIcon + '<span>listen</span>'
      + '  </button>'
      + '</div>'
      // Spectrogram canvas is always present; it stays a dark inert
      // strip until the stream is on, then the FFT loop paints it in
      // real time. No separate toggle.
      + '<canvas class="live-spectro" id="liveSpectro" width="600" height="120" aria-label="live spectrogram"></canvas>'
      + '<div class="live-status" id="liveStatus" role="status" aria-live="polite" aria-atomic="true"></div>'
      : '';
    items.innerHTML = liveAudioHtml + '<div class="menu-links">' + linksHtml + '</div>';

    if (adminLock) {
      adminLock.hidden = !adminAuthMeta.required;
      adminLock.disabled = false;
      adminLock.onclick = function () {
        adminLock.disabled = true;
        lockAdminSession().then(function () {
          showAdminLocked('', false);
          signalAdminLock('');
        }).catch(function () {
          adminLock.disabled = false;
        });
      };
    }

    if (pendingAdminSection) {
      var destination = pendingAdminSection;
      pendingAdminSection = null;
      setTimeout(function () { openAdmin(destination); }, 0);
    }

    // Clicking a nav link (settings / system / logs / tools) collapses the
    // menu back into the button - it has opened (or navigated to) its page,
    // so leaving the drawer open is just clutter. The listen button and the
    // built-by / GitHub links deliberately DON'T close it (you stay in the
    // drawer to keep the stream going; those links open a new tab).
    var menuLinks = items.querySelector('.menu-links');
    if (menuLinks) menuLinks.addEventListener('click', function (ev) {
      if (ev.target.closest('a')) closeDd();
    });
    if (!localAudio) {
      resetLiveAudioTransientState = function () {};
      stopLiveAudioNow = null;
      return;
    }

    // Live audio + realtime spectrogram. The audio element and the
    // FFT analyser share one AudioContext; once .play() is called the
    // analyser starts painting the canvas via rAF. No timeout - we
    // surface the natural error event or success ("playing") only.
    var liveBox = document.getElementById('liveAudio');
    var liveBtn = document.getElementById('liveAudioBtn');
    var spectroEl = document.getElementById('liveSpectro');
    var statusEl = document.getElementById('liveStatus');
    var liveEl = null, audioCtx = null, srcNode = null, analyser = null;
    var specRaf = null;
    var liveAttempt = 0, liveState = 'idle';

    function setStatus(msg) {
      statusEl.textContent = msg || '';
      statusEl.className = 'live-status';
    }
    function startAudio() {
      // Create the Audio element and resolve on the first "playing"
      // event (success). The browser will hang the network request
      // open for an icecast stream - that's normal - and "playing"
      // fires as soon as the first audio frame is decoded. We don't
      // race a timeout because icecast can take 1-10s to warm up
      // depending on tunnel + bitrate.
      return new Promise(function (resolve, reject) {
        liveEl = new Audio('/stream?t=' + Date.now());
        // No crossOrigin - the stream is same-origin via the worker
        // and crossOrigin='anonymous' would require CORS headers
        // icecast doesn't send.
        var settled = false;
        liveEl.addEventListener('playing', function () {
          if (settled) return;
          settled = true; resolve();
        });
        liveEl.addEventListener('error', function () {
          if (settled) return;
          settled = true;
          reject(new Error('stream error - check /#admin=system'));
        });
        audioClaim(stopAudio);   // stop any card / modal-recording audio
        liveEl.play().catch(function (e) {
          if (settled) return;
          settled = true; reject(e);
        });
      });
    }
    function paintQuietSpectrogram() {
      var ctx = spectroEl.getContext('2d');
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--paper-2').trim() || '#efe8d8';
      ctx.fillRect(0, 0, spectroEl.width, spectroEl.height);
    }
    function stopAudio() {
      liveAttempt++;
      audioRelease(stopAudio);
      if (specRaf) { cancelAnimationFrame(specRaf); specRaf = null; }
      if (liveEl) { try { liveEl.pause(); } catch (e) { } liveEl.src = ''; liveEl = null; }
      if (srcNode) { try { srcNode.disconnect(); } catch (e) { } srcNode = null; }
      if (analyser) { try { analyser.disconnect(); } catch (e) { } analyser = null; }
      liveState = 'idle';
      liveBox.setAttribute('data-on', 'false');
      liveBox.setAttribute('data-state', 'idle');
      liveBtn.removeAttribute('aria-disabled');
      liveBtn.removeAttribute('aria-busy');
      liveBtn.setAttribute('aria-label', 'listen to live audio');
      liveBtn.innerHTML = liveAudioIcon + '<span>listen</span>';
      setStatus('');
      // Clear the spectrogram canvas so it returns to its quiet state.
      paintQuietSpectrogram();
    }
    function showAudioUnavailable() {
      stopAudio();
      liveState = 'error';
      liveBox.setAttribute('data-state', 'error');
      liveBtn.setAttribute('aria-disabled', 'true');
      liveBtn.setAttribute('aria-label', 'Live audio unavailable. Close and reopen the menu to retry.');
      liveBtn.innerHTML = '<span>unavailable</span>';
      setStatus('');
    }
    resetLiveAudioTransientState = function () {
      if (liveState === 'connecting' || liveState === 'error') stopAudio();
    };
    stopLiveAudioNow = stopAudio;
    function attachSpectrogram() {
      if (!liveEl) return;
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      try {
        srcNode = audioCtx.createMediaElementSource(liveEl);
      } catch (e) {
        // MediaElementSource throws if the Audio is already wired up
        // (e.g. user toggled listen off then on). Best effort - let
        // the audio still play, just skip the spectrogram.
        return;
      }
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      srcNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      drawSpectrogram();
    }
    // Convert a CSS colour token (hex or rgb()) to [r,g,b] by letting the 2d
    // context normalise whatever form the variable is authored in.
    function toRGB(str, fallback) {
      var c = spectroEl.getContext('2d');
      c.fillStyle = fallback; c.fillStyle = str;   // invalid str leaves fallback
      var s = c.fillStyle;
      if (s.charAt(0) === '#') return [parseInt(s.substr(1, 2), 16), parseInt(s.substr(3, 2), 16), parseInt(s.substr(5, 2), 16)];
      var m = s.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
    }
    function drawSpectrogram() {
      var ctx = spectroEl.getContext('2d');
      var W = spectroEl.width, H = spectroEl.height;
      // Read palette tokens so the live spectrogram follows the theme - a
      // charcoal ground with a light trace in dark mode, not a hardcoded
      // light-mode ramp - matching the recording-row + card spectrograms.
      var cs = getComputedStyle(document.documentElement);
      var paper = cs.getPropertyValue('--paper-2').trim() || '#efe8d8';
      var bg = toRGB(paper, '#efe8d8');
      var fg = toRGB(cs.getPropertyValue('--ink').trim() || '#1a1612', '#1a1612');
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, W, H);
      var bins = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        if (!analyser) return;
        var img = ctx.getImageData(1, 0, W - 1, H);
        ctx.putImageData(img, 0, 0);
        ctx.clearRect(W - 1, 0, 1, H);
        analyser.getByteFrequencyData(bins);
        var n = bins.length;
        var lo = Math.floor(n * 250 / 24000);
        var hi = Math.floor(n * 12000 / 24000);
        for (var y = 0; y < H; y++) {
          var t = 1 - y / H;
          var idx = Math.round(lo + (hi - lo) * Math.pow(t, 1.6));
          var v = (bins[idx] || 0) / 255;
          var e = v * v * (3 - 2 * v);
          // Ground (paper) -> trace (ink) ramp, per the active theme.
          var r = bg[0] + Math.round((fg[0] - bg[0]) * e);
          var g = bg[1] + Math.round((fg[1] - bg[1]) * e);
          var b = bg[2] + Math.round((fg[2] - bg[2]) * e);
          ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
          ctx.fillRect(W - 1, y, 1, 1);
        }
        specRaf = requestAnimationFrame(tick);
      }
      tick();
    }

    // Keep both the quiet strip and an active stream in step with theme
    // changes. Restarting the painter clears old-theme pixels immediately.
    spectroEl.__refreshTheme = function () {
      if (specRaf) { cancelAnimationFrame(specRaf); specRaf = null; }
      if (analyser) drawSpectrogram();
      else paintQuietSpectrogram();
    };
    paintQuietSpectrogram();

    liveBtn.addEventListener('click', function (ev) {
      // Important: stop the click from propagating up to the
      // document-level "click outside drawer" handler, which would
      // close the dropdown.
      ev.stopPropagation();
      var on = liveBox.getAttribute('data-on') === 'true';
      if (liveState === 'error') return;
      if (on) { stopAudio(); return; }
      liveState = 'connecting';
      var attempt = ++liveAttempt;
      liveBox.setAttribute('data-on', 'true');
      liveBox.setAttribute('data-state', 'connecting');
      liveBtn.setAttribute('aria-busy', 'true');
      liveBtn.setAttribute('aria-label', 'stop live audio');
      liveBtn.innerHTML = stopIcon + '<span>stop</span>';
      setStatus('connecting...');
      startAudio()
        .then(function () {
          if (attempt !== liveAttempt) return;
          liveState = 'playing';
          liveBox.setAttribute('data-state', 'streaming');
          liveBtn.removeAttribute('aria-busy');
          setStatus('live now');
          attachSpectrogram();
        })
        .catch(function () {
          if (attempt !== liveAttempt) return;
          showAudioUnavailable();
        });
    });
  }

  // Pending changes (key -> value), written by the serialized autosave queue.
  var pending = {};

  function setSaveState(msg, cls) {
    var el = document.getElementById('saveState');
    if (el) { el.textContent = msg || ''; el.className = 'save-state' + (cls ? ' ' + cls : ''); }
  }
  // Settings write themselves. Several of these keys restart the analyzer,
  // so the delay is long enough that a slider being dragged or a key being
  // typed settles into one write rather than a burst of them.
  var autoSaveT = null;
  var settingsSaveBusy = false;
  function discardPendingSettings() {
    if (autoSaveT) clearTimeout(autoSaveT);
    autoSaveT = null;
    pending = {};
    setSaveState('');
  }
  function restoreSubmittedSettings(submitted) {
    Object.keys(submitted).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(pending, key)) pending[key] = submitted[key];
    });
  }
  function queueSave(delay) {
    if (!Object.keys(pending).length) return;
    setSaveState('saving...');
    clearTimeout(autoSaveT);
    autoSaveT = setTimeout(saveSettings, typeof delay === 'number' ? delay : 700);
  }

  // The range filter scores each species against where and when the
  // station is listening, so bad coordinates quietly distort every
  // species list. install_config.sh guesses them from ip-api.com and
  // falls back to 0,0 - which parks the station in the Gulf of Guinea.
  function stationRow(v) {
    var lat = v.LATITUDE, lon = v.LONGITUDE;
    var unset = (!lat && !lon);
    var where = unset ? 'not set' : (+lat).toFixed(4) + ', ' + (+lon).toFixed(4);
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">Station location</span></div>'
      + '  <div class="station-pick">'
      + '    <span class="station-coords' + (unset ? ' warn' : '') + '" id="stationCoords">' + where + '</span>'
      + '    <button type="button" class="pin-btn" id="stationEdit" aria-label="set location on a map">'
      + '      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
      + '        <path d="M7 12.5s4.2-4 4.2-6.7a4.2 4.2 0 1 0-8.4 0C2.8 8.5 7 12.5 7 12.5Z"/><circle cx="7" cy="5.8" r="1.5"/>'
      + '      </svg>'
      + '    </button>'
      + '  </div>'
      + '</div>';
  }

  // Secret field: the server never echoes the saved value, only whether
  // one is set - the input starts empty either way and a pasted value
  // replaces what's there on save.
  function settingsSecret(key, label, hint, isSet) {
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">' + label + '</span>'
      + (hint ? '<span class="hint">' + hint + '</span>' : '')
      + '  </div>'
      + '  <input type="password" class="secret" data-key="' + key + '" autocomplete="off" '
      + 'placeholder="' + (isSet ? 'saved, paste to replace' : 'paste key') + '">'
      + '</div>';
  }
  function settingsText(key, label, value, maxLength) {
    return ''
      + '<label class="menu-row settings-text-row">'
      + '  <span class="label">' + adminEsc(label) + '</span>'
      + '  <input type="text" class="settings-text" data-key="' + adminAttr(key) + '"'
      + '    value="' + adminAttr(value || '') + '" maxlength="' + (maxLength || 60) + '"'
      + '    autocomplete="off" spellcheck="false">'
      + '</label>';
  }
  function settingsToggle(key, label, hint, on) {
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">' + label + '</span>'
      + (hint ? '<span class="hint">' + hint + '</span>' : '')
      + '  </div>'
      + '  <button type="button" class="switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-key="' + key + '"></button>'
      + '</div>';
  }
  function settingsSlider(key, label, hint, val, min, max, step, digits, dflt) {
    // A key absent from birdnet.conf used to render NaN and park the
    // thumb nowhere; fall back to BirdNET-Pi's shipped default so the
    // control shows the value it is about to write.
    var v = parseFloat(val);
    if (!isFinite(v)) v = dflt;
    v = Math.min(max, Math.max(min, v));
    val = v;
    return ''
      + '<div class="slider-row">'
      + '  <div class="head">'
      + '    <div class="label-block">'
      + '      <span class="label">' + label + '</span>'
      + (hint ? '<span class="hint">' + hint + '</span>' : '')
      + '    </div>'
      + '    <span class="value" data-value-for="' + key + '">' + (+val).toFixed(digits) + '</span>'
      + '  </div>'
      + '  <div class="slider-track">'
      + '    <input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" data-key="' + key + '" data-digits="' + digits + '">'
      + '  </div>'
      + '</div>';
  }
  function settingsSegmented(key, label, hint, val, opts) {
    // A key missing from birdnet.conf used to leave every option
    // unselected (and the pill nowhere); fall back to the first option
    // so the control always shows the state it is about to save.
    var cur = opts.some(function (o) { return o.v === val; }) ? val : opts[0].v;
    var btns = opts.map(function (o) {
      return '<button type="button" data-v="' + o.v + '" aria-current="' + (o.v === cur ? 'true' : 'false') + '">' + o.label + '</button>';
    }).join('');
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">' + label + '</span>'
      + (hint ? '<span class="hint">' + hint + '</span>' : '')
      + '  </div>'
      + '  <div class="seg" data-key="' + key + '"><i class="seg-pill" aria-hidden="true"></i>' + btns + '</div>'
      + '</div>';
  }
  function settingsInfoMarkup(id, label, details) {
    return ''
      + '<button type="button" class="settings-info" data-settings-info'
      + ' aria-label="' + label + '" aria-describedby="' + id + '"'
      + ' aria-controls="' + id + '" aria-expanded="false">'
      + '  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M8 7.1v4M8 4.75h.01" stroke-linecap="round"/></svg>'
      + '  <span class="settings-tip" id="' + id + '" role="tooltip">' + details + '</span>'
      + '</button>';
  }
  var settingsInfoCleanup = null;
  var settingsAccessCleanup = null;
  function wireSettingsInfo(scope) {
    if (settingsInfoCleanup) settingsInfoCleanup();
    var buttons = [].slice.call(scope.querySelectorAll('[data-settings-info]'));
    function setOpen(button, open) {
      if (!button) return;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      var wrapper = button.closest('.access-copy');
      if (wrapper) wrapper.setAttribute('data-tip-open', open ? 'true' : 'false');
    }
    function closeAll(except) {
      buttons.forEach(function (button) {
        if (button !== except) {
          button.__tipPinned = false;
          setOpen(button, false);
        }
      });
    }
    buttons.forEach(function (button) {
      button.__tipPinned = false;
      button.__tipSuppressed = false;
      button.addEventListener('pointerenter', function () {
        if (!button.__tipSuppressed) setOpen(button, true);
      });
      button.addEventListener('pointerleave', function () {
        button.__tipSuppressed = false;
        if (!button.__tipPinned && document.activeElement !== button) setOpen(button, false);
      });
      button.addEventListener('focus', function () {
        button.__tipSuppressed = false;
        closeAll(button);
        setOpen(button, true);
      });
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        closeAll(button);
        button.__tipPinned = !button.__tipPinned;
        button.__tipSuppressed = !button.__tipPinned;
        setOpen(button, button.__tipPinned);
      });
      button.addEventListener('focusout', function () {
        setTimeout(function () {
          var wrapper = button.closest('.access-copy');
          if (!wrapper || !wrapper.contains(document.activeElement)) {
            button.__tipPinned = false;
            setOpen(button, false);
          }
        }, 0);
      });
    });
    function outside(event) {
      if (!event.target.closest('[data-settings-info]')) closeAll(null);
    }
    function escape(event) {
      if (event.key !== 'Escape') return;
      var open = buttons.find(function (button) {
        return button.getAttribute('aria-expanded') === 'true';
      });
      if (!open) return;
      event.stopPropagation();
      open.__tipPinned = false;
      open.__tipSuppressed = true;
      setOpen(open, false);
    }
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    settingsInfoCleanup = function () {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      settingsInfoCleanup = null;
    };
  }
  // Client-side theme switcher row. Reuses the .seg look but is tagged
  // data-theme-seg so wireSettingsControls skips it. It applies instantly
  // and is not part of the Pi config save flow.
  function themeRow() {
    var cur = themePreference();
    var icons = {
      auto: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="8.5" rx="1.5"/><path d="M5.25 13.5h5.5M8 11v2.5"/></svg>',
      light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9"/></svg>',
      dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.2 10.6A5.5 5.5 0 0 1 5.4 3.8a5.5 5.5 0 1 0 6.8 6.8Z"/></svg>'
    };
    var btn = function (v, label, tip) {
      var id = 'theme' + v.charAt(0).toUpperCase() + v.slice(1) + 'Tip';
      return '<button type="button" data-theme="' + v + '" aria-current="' + (cur === v ? 'true' : 'false') + '" aria-label="' + label + '" aria-describedby="' + id + '">'
        + icons[v] + '<span class="tip" id="' + id + '" role="tooltip">' + tip + '</span></button>';
    };
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">Theme</span></div>'
      + '  <div class="seg settings-theme-seg" data-theme-seg role="group" aria-label="Theme"><i class="seg-pill" aria-hidden="true"></i>'
      + btn('auto', 'Follow system theme', 'follow system') + btn('light', 'Use light theme', 'light') + btn('dark', 'Use dark theme', 'dark') + '</div>'
      + '</div>';
  }
  // Client-side collage-label switch. It applies instantly and remains a
  // browser preference rather than part of the Pi config save flow.
  function labelsRow() {
    var cur = labelPreference();
    var btn = function (v, label) {
      return '<button type="button" data-labels="' + v + '" aria-current="' + (cur === v ? 'true' : 'false') + '">' + label + '</button>';
    };
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">Bird names on this device</span><span class="hint">site follows the station setting below</span></div>'
      + '  <div class="seg" data-labels-seg><i class="seg-pill" aria-hidden="true"></i>' + btn('site', 'site') + btn('off', 'off') + btn('on', 'on') + '</div>'
      + '</div>';
  }
  function atlasAlwaysAllRow() {
    var on = atlasAlwaysAll();
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">Always show full atlas</span><span class="hint">show every unlocked stamp</span></div>'
      + '  <button type="button" class="switch" role="switch" aria-label="Always show full atlas"'
      + '    aria-checked="' + (on ? 'true' : 'false') + '" data-atlas-always-all></button>'
      + '</div>';
  }
  function atlasClassicRow() {
    var on = atlasUsesClassicCards();
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">Classic Atlas cards</span></div>'
      + '  <button type="button" class="switch" role="switch" aria-label="Classic Atlas cards"'
      + '    aria-checked="' + (on ? 'true' : 'false') + '" data-atlas-classic></button>'
      + '</div>';
  }
  function lanAuthRow(security) {
    security = security || {};
    var on = !!security.lan_admin_auth;
    var configured = !!security.password_configured;
    var reconciliationNeeded = !!security.policy_reconciliation_needed;
    var hint = reconciliationNeeded
      ? 'the loaded access policy differs from this saved setting'
      : configured
      ? 'lock Settings, System, Logs, and Tools on direct local connections'
      : 'From SSH, run: sudo /usr/local/sbin/avian-admin-control password-reset';
    var details = hint + '. Collage, Atlas, Stats, and recordings stay public. On plain HTTP, this blocks casual access '
      + 'but does not protect your password from a hostile network.';
    var canChangePassword = on && configured;
    return ''
      + '<div class="lan-auth-control" data-lan-auth-control' + (canChangePassword ? ' data-password-change' : '') + '>'
      + '  <div class="menu-row">'
      + '    <div class="access-copy"><span class="label">Require password on local network</span>'
      + settingsInfoMarkup('lanAuthTip', 'About local password protection', details)
      + '    </div>'
      + '    <div class="lan-auth-head-actions">'
      + (canChangePassword
        ? '      <button type="button" class="settings-disclosure" data-password-change-open aria-controls="passwordChangeForm" aria-expanded="false">change admin password</button>'
        : '')
      + '    <button type="button" class="switch" role="switch" data-lan-auth'
      + '      aria-label="Require password on local network" aria-describedby="lanAuthTip"'
      + '      aria-checked="' + (on ? 'true' : 'false') + '"'
      + ((!configured && !on) ? ' disabled' : '') + '></button>'
      + '    </div>'
      + '  </div>'
      + (reconciliationNeeded
        ? '  <button type="button" class="chip lan-auth-reconcile" data-lan-auth-reconcile>reapply saved access setting</button>'
        : '')
      + '  <form class="lan-auth-confirm" data-lan-auth-confirm hidden>'
      + '    <label for="lanAuthPassword">Confirm your admin password</label>'
      + '    <div><span class="lan-password-field"><input id="lanAuthPassword" type="password" autocomplete="current-password">'
      + '      <button type="button" class="lan-password-visibility" data-lan-password-visibility aria-label="Show admin password" aria-pressed="false">'
      + '        <span class="eye-show">' + ICON_EYE + '</span><span class="eye-hide">' + ICON_EYE_OFF + '</span></button></span>'
      + '      <button type="submit" class="chip">turn on</button>'
      + '      <button type="button" class="chip" data-lan-auth-cancel>cancel</button></div>'
      + '  </form>'
      + '  <p class="lan-auth-status" data-lan-auth-status role="status" aria-live="polite" aria-atomic="true"></p>'
      + (canChangePassword
        ? '  <form id="passwordChangeForm" class="password-change-form" data-password-change-form hidden>'
          + '    <span class="hint">New password: 12 to 64 letters or numbers.</span>'
          + '    <label>Current password<input type="password" data-password-current autocomplete="current-password" minlength="1" maxlength="64" required></label>'
          + '    <label>New password<input type="password" data-password-new autocomplete="new-password" minlength="12" maxlength="64" pattern="[A-Za-z0-9]+" required></label>'
          + '    <label>Confirm new password<input type="password" data-password-confirm autocomplete="new-password" minlength="12" maxlength="64" pattern="[A-Za-z0-9]+" required></label>'
          + '    <div><button type="submit" class="chip">change password</button>'
          + '      <button type="button" class="chip" data-password-change-cancel>cancel</button></div>'
          + '  </form>'
          + '  <p class="lan-auth-status" data-password-change-status role="status" aria-live="polite" aria-atomic="true"></p>'
        : '')
      + '</div>';
  }

  function birdweatherRow(state) {
    state = state || {};
    var available = state.ok !== false;
    var enabled = available && !!state.enabled;
    var configured = available && !!state.token_configured;
    var privacy = parseInt(state.privacy_threshold, 10);
    if (!isFinite(privacy) || privacy < 0 || privacy > 3) privacy = 0;
    if (!configured && privacy === 0) privacy = 1;
    var privacyButtons = [0, 1, 2, 3].map(function (level) {
      return '<button type="button" data-v="' + level + '" aria-current="'
        + (level === privacy ? 'true' : 'false') + '">' + level + '</button>';
    }).join('');
    var sharingDetails = 'BirdWeather receives each bird name, confidence, time, and your station coordinates. '
      + 'Audio is separate and stays off for a new station unless you turn it on.';
    var audioDetails = 'This sends the complete recording BirdNET analyzed, not only the detected call. '
      + 'It may contain people or other nearby sounds.';
    var privacyDetails = 'BirdNET still analyzes the audio. Level 0 checks the top 10 model candidates for Human, 1 about 60, 2 about 120, and 3 about 180. '
      + 'A match suppresses local bird detections for that 3-second window and its neighbors. Full recordings are not redacted.';
    return ''
      + '<div class="birdweather-control" data-birdweather-control data-token-configured="' + (configured ? 'true' : 'false') + '">'
      + '  <div class="menu-row birdweather-head">'
      + '    <div class="access-copy"><span class="label">Share detections with BirdWeather</span>'
      + settingsInfoMarkup('birdweatherTip', 'About BirdWeather sharing', sharingDetails)
      + '    </div>'
      + '    <div class="birdweather-head-actions">'
      + '      <button type="button" class="settings-disclosure" data-birdweather-disclosure aria-controls="birdweatherDetails" aria-expanded="' + (enabled ? 'true' : 'false') + '"' + (available ? '' : ' disabled') + '>details</button>'
      + '      <button type="button" class="switch" role="switch" data-birdweather-toggle'
      + '        aria-label="Share detections with BirdWeather" aria-describedby="birdweatherTip"'
      + '        aria-checked="' + (enabled ? 'true' : 'false') + '"' + (available ? '' : ' disabled') + '></button>'
      + '    </div>'
      + '  </div>'
      + (available ? '' : '  <p class="birdweather-unavailable" role="status">BirdWeather controls are unavailable on this station.</p>')
      + '  <div id="birdweatherDetails" class="birdweather-details-shell" data-birdweather-details-shell data-open="' + (enabled ? 'true' : 'false') + '" data-settled="' + (enabled ? 'true' : 'false') + '" aria-hidden="' + (enabled ? 'false' : 'true') + '"' + (enabled ? '' : ' hidden inert') + '>'
      + '  <form class="birdweather-details" data-birdweather-details>'
      + '    <div class="birdweather-token">'
      + '      <div class="birdweather-token-editor" data-birdweather-token-editor' + (configured ? ' hidden' : '') + '>'
      + '        <a id="birdweatherTokenLabel" href="https://app.birdweather.com/account/stations" target="_blank" rel="noopener">Station token</a>'
      + '        <input type="text" data-birdweather-token aria-labelledby="birdweatherTokenLabel" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="161" placeholder="station token">'
      + '      </div>'
      + '      <div class="birdweather-token-actions" data-birdweather-token-actions' + (configured ? '' : ' hidden') + '>'
      + '        <a class="birdweather-station-link" data-birdweather-station href="https://app.birdweather.com/account/stations" target="_blank" rel="noopener">view station on BirdWeather</a>'
      + '        <button type="button" class="birdweather-forget" data-birdweather-forget>forget token</button>'
      + '      </div>'
      + '    </div>'
      + '    <div class="menu-row">'
      + '      <div class="access-copy"><span class="label">Upload analyzed recordings</span>'
      + settingsInfoMarkup('birdweatherAudioTip', 'About BirdWeather audio uploads', audioDetails)
      + '      </div>'
      + '      <button type="button" class="switch" role="switch" data-birdweather-audio'
      + '        aria-label="Upload analyzed recordings" aria-describedby="birdweatherAudioTip"'
      + '        aria-checked="' + (state.upload_audio ? 'true' : 'false') + '"></button>'
      + '    </div>'
      + '    <div class="menu-row">'
      + '      <div class="access-copy"><span class="label">Human-sound filter</span>'
      + settingsInfoMarkup('birdweatherPrivacyTip', 'About the local human-sound filter', privacyDetails)
      + '      </div>'
      + '      <div class="seg birdweather-privacy" data-birdweather-privacy><i class="seg-pill" aria-hidden="true"></i>' + privacyButtons + '</div>'
      + '    </div>'
      + '    <p class="birdweather-status sr-only" data-birdweather-status role="status" aria-live="polite" aria-atomic="true"></p>'
      + '  </form>'
      + '  </div>'
      + '</div>';
  }

  function wireBirdweatherControl(scope, initialState) {
    var control = scope.querySelector('[data-birdweather-control]');
    if (!control || !initialState || initialState.ok === false) return;
    var state = initialState;
    var mainSwitch = control.querySelector('[data-birdweather-toggle]');
    var disclosure = control.querySelector('[data-birdweather-disclosure]');
    var detailsShell = control.querySelector('[data-birdweather-details-shell]');
    var details = control.querySelector('[data-birdweather-details]');
    var tokenEditor = control.querySelector('[data-birdweather-token-editor]');
    var tokenActions = control.querySelector('[data-birdweather-token-actions]');
    var tokenInput = control.querySelector('[data-birdweather-token]');
    var audioSwitch = control.querySelector('[data-birdweather-audio]');
    var privacy = control.querySelector('[data-birdweather-privacy]');
    var stationLink = control.querySelector('[data-birdweather-station]');
    var status = control.querySelector('[data-birdweather-status]');
    var forget = control.querySelector('[data-birdweather-forget]');
    var probeSequence = 0;
    var draftEnable = false;
    var detailsTransitionTimer = 0;
    var writeTimer = 0;
    var writing = false;
    var forgetting = false;
    var writeQueue = {};
    var tokenEditRevision = 0;
    var tokenSubmissionRevision = -1;
    var tokenFocusRevision = -1;
    if (!state.token_configured && +state.privacy_threshold === 0) state.privacy_threshold = 1;

    function note(message, error, tokenError) {
      status.textContent = message || '';
      status.classList.toggle('err', !!error);
      tokenInput.setAttribute('aria-invalid', tokenError ? 'true' : 'false');
      if (tokenInput.setCustomValidity) tokenInput.setCustomValidity(tokenError ? (message || 'BirdWeather rejected that token') : '');
      if (tokenError && !tokenEditor.hidden && !tokenInput.disabled && tokenInput.reportValidity) tokenInput.reportValidity();
    }
    function owns(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }
    function selectPrivacy(value) {
      privacy.querySelectorAll('button').forEach(function (button) {
        button.setAttribute('aria-current', +button.dataset.v === +value ? 'true' : 'false');
      });
      syncPill(privacy);
    }
    function setWriting(next) {
      writing = next;
      control.setAttribute('aria-busy', next ? 'true' : 'false');
      tokenInput.readOnly = next;
      mainSwitch.setAttribute('aria-disabled', next ? 'true' : 'false');
      audioSwitch.setAttribute('aria-disabled', next ? 'true' : 'false');
      privacy.querySelectorAll('button').forEach(function (button) {
        button.setAttribute('aria-disabled', next ? 'true' : 'false');
      });
      if (forget) forget.disabled = next || forgetting;
    }
    function tokenInputHasFocus() {
      return typeof document !== 'undefined' && document.activeElement === tokenInput;
    }
    function showTokenState(remote) {
      var configured = !!state.token_configured;
      stationLink.removeAttribute('aria-busy');
      tokenEditor.hidden = configured;
      tokenActions.hidden = !configured;
      forget.hidden = !configured;
      if (!configured) {
        stationLink.href = 'https://app.birdweather.com/account/stations';
        stationLink.removeAttribute('data-station-id');
        return;
      }
      tokenInput.value = '';
      remote = remote || state.station;
      var stationId = remote && remote.state === 'connected' ? +remote.station_id : 0;
      if (Number.isInteger(stationId) && stationId > 0) {
        stationLink.href = 'https://app.birdweather.com/stations/' + stationId;
        stationLink.setAttribute('data-station-id', String(stationId));
      } else {
        stationLink.href = 'https://app.birdweather.com/account/stations';
        stationLink.removeAttribute('data-station-id');
      }
    }
    function detailsAreOpen() {
      return detailsShell.getAttribute('data-open') === 'true';
    }
    function syncPrivacyPill() {
      requestAnimationFrame(function () {
        syncPill(privacy);
        requestAnimationFrame(function () { syncPill(privacy); });
      });
    }
    function finishDetailsOpen() {
      if (!detailsAreOpen()) return;
      detailsShell.setAttribute('data-settled', 'true');
      syncPrivacyPill();
    }
    function finishDetailsClose() {
      if (detailsAreOpen()) return;
      detailsShell.hidden = true;
      detailsShell.setAttribute('data-settled', 'false');
    }
    function openDetails(open, checkStation) {
      clearTimeout(detailsTransitionTimer);
      detailsShell.setAttribute('data-settled', 'false');
      if (open) {
        detailsShell.hidden = false;
        detailsShell.inert = false;
        detailsShell.setAttribute('aria-hidden', 'false');
        void detailsShell.offsetHeight;
        detailsShell.setAttribute('data-open', 'true');
        syncPrivacyPill();
        detailsTransitionTimer = setTimeout(finishDetailsOpen, 230);
      } else {
        detailsShell.setAttribute('data-open', 'false');
        detailsShell.setAttribute('aria-hidden', 'true');
        detailsShell.inert = true;
        detailsTransitionTimer = setTimeout(finishDetailsClose, 180);
      }
      disclosure.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && checkStation) probeStation();
    }
    detailsShell.addEventListener('transitionend', function (event) {
      if (event.target === detailsShell && event.propertyName === 'grid-template-rows') {
        clearTimeout(detailsTransitionTimer);
        if (detailsAreOpen()) finishDetailsOpen();
        else finishDetailsClose();
      }
    });
    function applyState(next) {
      probeSequence += 1;
      var priorStation = state && state.token_configured && state.station;
      var priorConfigured = !!(state && state.token_configured);
      state = next || state;
      if (!state.station && priorConfigured && state.token_configured && priorStation) state.station = priorStation;
      if (!owns(writeQueue, 'enabled')) {
        mainSwitch.setAttribute('aria-checked', state.enabled ? 'true' : 'false');
      }
      if (!owns(writeQueue, 'upload_audio')) {
        audioSwitch.setAttribute('aria-checked', state.upload_audio ? 'true' : 'false');
      }
      if (!owns(writeQueue, 'privacy_threshold')) selectPrivacy(state.privacy_threshold);
      control.setAttribute('data-token-configured', state.token_configured ? 'true' : 'false');
      showTokenState(state.station);
      if (state.enabled) draftEnable = false;
    }
    function probeStation() {
      if (!state.token_configured) { showTokenState(null); return; }
      var mine = ++probeSequence;
      stationLink.setAttribute('aria-busy', 'true');
      adminFetch('./avian/api/birdweather.php?probe=1', {
        credentials: 'same-origin', cache: 'no-store',
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.ok) throw new Error(body.error || 'station lookup failed');
          return body;
        });
      }).then(function (body) {
        if (mine !== probeSequence) return;
        state.station = body.station;
        state.configuration_valid = body.configuration_valid;
        stationLink.removeAttribute('aria-busy');
        showTokenState(body.station);
      }).catch(function (error) {
        if (mine !== probeSequence || adminAuthCancelled(error)) return;
        stationLink.removeAttribute('aria-busy');
        showTokenState({ state: 'unavailable' });
      });
    }
    function queueWrite(patch, delay) {
      Object.keys(patch).forEach(function (key) { writeQueue[key] = patch[key]; });
      note('', false, false);
      clearTimeout(writeTimer);
      writeTimer = setTimeout(flushWrites, typeof delay === 'number' ? delay : 0);
    }
    function readCanonicalState() {
      return adminFetch('./avian/api/birdweather.php', {
        credentials: 'same-origin', cache: 'no-store',
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.ok) throw new Error(body.error || 'BirdWeather state could not be re-read');
          return body;
        });
      }).then(function (body) {
        applyState(body);
        return body;
      });
    }
    function flushWrites() {
      clearTimeout(writeTimer);
      writeTimer = 0;
      if (writing || !Object.keys(writeQueue).length) return;
      var payload = writeQueue;
      writeQueue = {};
      var requestBody = JSON.stringify(payload);
      var submittedToken = owns(payload, 'token') ? payload.token : null;
      var submittedFocusRevision = tokenFocusRevision;
      var focusSubmittedToken = submittedToken !== null
        && submittedFocusRevision === tokenSubmissionRevision;
      var focusAfterWrite = null;
      var messageAfterWrite = '';
      var tokenErrorAfterWrite = false;
      if (submittedToken !== null || owns(payload, 'forget_token')) probeSequence += 1;
      if (submittedToken !== null) payload.token = '';
      setWriting(true);
      return adminFetch('./avian/api/birdweather.php', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
        body: requestBody,
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.ok) {
            var error = new Error(body.error || 'BirdWeather setting failed');
            error.saved = !!body.saved;
            error.settings = body.settings || null;
            throw error;
          }
          return body;
        });
      }).then(function (body) {
        requestBody = '';
        var focusStationAfterApply = focusSubmittedToken && tokenInputHasFocus();
        applyState(body);
        if (submittedToken !== null || owns(payload, 'forget_token')) tokenInput.value = '';
        if (body.station) showTokenState(body.station);
        else if (submittedToken !== null && body.token_configured) probeStation();
        if (owns(payload, 'forget_token')) {
          openDetails(true, false);
          focusAfterWrite = tokenInput;
        } else if (submittedToken !== null && body.token_configured && focusStationAfterApply) {
          focusAfterWrite = stationLink;
        } else if (owns(payload, 'enabled') && !!body.enabled === !!payload.enabled) {
          if (body.enabled) {
            if (!body.station) probeStation();
          } else {
            openDetails(false, false);
          }
        }
        tokenSubmissionRevision = -1;
        return true;
      }).catch(function (error) {
        requestBody = '';
        if (adminAuthCancelled(error)) return false;
        var focusStationAfterApply = focusSubmittedToken && tokenInputHasFocus();
        var recovery = Promise.resolve();
        if (error.saved && error.settings) {
          applyState(error.settings);
        } else if (error.saved) {
          recovery = readCanonicalState().catch(function () {
            // The write is durable even when the canonical re-read fails. Do
            // not leave a saved credential visible or make Forget look undone.
            var fallback = Object.assign({}, state);
            ['enabled', 'upload_audio', 'privacy_threshold'].forEach(function (key) {
              if (owns(payload, key)) fallback[key] = payload[key];
            });
            if (submittedToken !== null) {
              fallback.token_configured = true;
              fallback.configuration_valid = true;
              fallback.station = null;
            } else if (owns(payload, 'forget_token')) {
              fallback.enabled = false;
              fallback.upload_audio = false;
              fallback.token_configured = false;
              fallback.configuration_valid = true;
              fallback.station = null;
            }
            applyState(fallback);
          });
        } else {
          applyState(state);
        }
        return recovery.then(function () {
          if (error.saved && (submittedToken !== null || owns(payload, 'forget_token'))) tokenInput.value = '';
          if (error.saved && submittedToken !== null && state.token_configured && focusStationAfterApply) {
            focusAfterWrite = stationLink;
          }
          if (error.saved && owns(payload, 'forget_token') && !state.token_configured) {
            openDetails(true, false);
            focusAfterWrite = tokenInput;
          }
          messageAfterWrite = error.message || 'BirdWeather setting failed';
          tokenErrorAfterWrite = submittedToken !== null && !error.saved;
          tokenSubmissionRevision = -1;
          return false;
        });
      }).then(function (ok) {
        submittedToken = null;
        forgetting = false;
        setWriting(false);
        note(messageAfterWrite, !!messageAfterWrite, tokenErrorAfterWrite);
        if (focusAfterWrite && focusAfterWrite.focus) focusAfterWrite.focus();
        if (tokenFocusRevision === submittedFocusRevision) tokenFocusRevision = -1;
        if (Object.keys(writeQueue).length) queueWrite({}, 0);
        return ok;
      });
    }
    function saveToken(focusOnSuccess) {
      // Match the API normalization boundary: ordinary surrounding spaces are
      // paste noise, while tabs and other control characters must reach the
      // server unchanged so its strict validator can reject them.
      var value = tokenInput.value.replace(/^ +| +$/g, '');
      if (!value) {
        tokenInput.focus();
        return;
      }
      if (tokenSubmissionRevision === tokenEditRevision
        && (writing || owns(writeQueue, 'token'))) return;
      tokenSubmissionRevision = tokenEditRevision;
      tokenFocusRevision = focusOnSuccess ? tokenEditRevision : -1;
      var patch = { token: value };
      if (!state.token_configured) {
        var selected = privacy.querySelector('button[aria-current="true"]');
        patch.upload_audio = audioSwitch.getAttribute('aria-checked') === 'true';
        patch.privacy_threshold = selected ? +selected.dataset.v : 1;
      }
      if (draftEnable) patch.enabled = true;
      queueWrite(patch, 0);
    }

    disclosure.addEventListener('click', function () {
      var open = !detailsAreOpen();
      openDetails(open, open);
    });
    mainSwitch.addEventListener('click', function () {
      if (writing || forgetting) return;
      var prior = mainSwitch.getAttribute('aria-checked') === 'true';
      var desired = !prior;
      if (desired) {
        draftEnable = true;
        openDetails(true, false);
        if (!state.token_configured || state.configuration_valid === false) {
          if (state.token_configured) forget.focus();
          else tokenInput.focus();
          return;
        }
      } else {
        draftEnable = false;
      }
      queueWrite({ enabled: desired }, 0);
    });
    audioSwitch.addEventListener('click', function () {
      if (writing || forgetting) return;
      var enabled = audioSwitch.getAttribute('aria-checked') !== 'true';
      audioSwitch.setAttribute('aria-checked', enabled ? 'true' : 'false');
      queueWrite({ upload_audio: enabled }, 0);
    });
    privacy.querySelectorAll('button').forEach(function (button) {
      button.addEventListener('click', function () {
        if (writing || forgetting) return;
        privacy.querySelectorAll('button').forEach(function (candidate) {
          candidate.setAttribute('aria-current', candidate === button ? 'true' : 'false');
        });
        syncPill(privacy);
        queueWrite({ privacy_threshold: +button.dataset.v }, 0);
      });
    });
    details.addEventListener('submit', function (event) {
      event.preventDefault();
      saveToken(true);
    });
    tokenInput.addEventListener('input', function () {
      tokenEditRevision += 1;
      note('', false);
    });
    tokenInput.addEventListener('change', function () { saveToken(false); });
    tokenInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveToken(true);
    });
    forget.addEventListener('click', function () {
      if (writing || forgetting) return;
      if (!confirm('Forget the saved BirdWeather station token? Sharing must stay off until a new token is added.')) return;
      forgetting = true;
      forget.disabled = true;
      probeSequence += 1;
      state.station = null;
      delete writeQueue.token;
      queueWrite({
        enabled: false,
        upload_audio: false,
        forget_token: true,
      }, 0);
    });
    applyState(state);
    if (state.enabled) probeStation();
  }

  function wireLanAuthControl(scope, security) {
    var control = scope.querySelector('[data-lan-auth-control]');
    if (!control) return;
    var sw = control.querySelector('[data-lan-auth]');
    var form = control.querySelector('[data-lan-auth-confirm]');
    var password = control.querySelector('#lanAuthPassword');
    var passwordVisibility = control.querySelector('[data-lan-password-visibility]');
    var status = control.querySelector('[data-lan-auth-status]');
    var cancel = control.querySelector('[data-lan-auth-cancel]');
    var reconcile = control.querySelector('[data-lan-auth-reconcile]');
    var submit = form.querySelector('[type="submit"]');
    var desired = true;

    function showPassword(show) {
      password.type = show ? 'text' : 'password';
      if (!passwordVisibility) return;
      passwordVisibility.setAttribute('aria-pressed', show ? 'true' : 'false');
      passwordVisibility.setAttribute('aria-label', show ? 'Hide admin password' : 'Show admin password');
    }

    function note(message, error) {
      status.textContent = message || '';
      status.classList.toggle('err', !!error);
    }
    function closePasswordChange() {
      var passwordForm = control.querySelector('[data-password-change-form]');
      var passwordOpen = control.querySelector('[data-password-change-open]');
      if (!passwordForm || !passwordOpen) return;
      passwordForm.querySelectorAll('input[type="password"]').forEach(function (input) { input.value = ''; });
      passwordForm.hidden = true;
      passwordOpen.hidden = false;
      passwordOpen.setAttribute('aria-expanded', 'false');
      var passwordStatus = control.querySelector('[data-password-change-status]');
      if (passwordStatus) { passwordStatus.textContent = ''; passwordStatus.classList.remove('err'); }
    }
    function save(enabled, authorization) {
      if (enabled && stopLiveAudioNow) stopLiveAudioNow();
      sw.disabled = true;
      note('saving...', false);
      var headers = { 'Content-Type': 'application/json', 'X-Avian-Action': '1' };
      if (authorization) {
        headers.Authorization = authorization;
        headers['X-Avian-Credential'] = '1';
      }
      return fetch('./avian/api/config.php', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: headers,
        body: JSON.stringify({ lan_admin_auth: enabled }),
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.ok) {
            var error = new Error(body.error || 'access setting failed');
            error.status = response.status;
            error.recovery = !!body.recovery;
            error.reauth = !!body.reauth;
            error.remediation = body.remediation || '';
            throw error;
          }
          return body;
        });
      }).then(function () {
        sessionReplaced();
      }).catch(function (error) {
        if (error.recovery) {
          showAdminLocked('', true);
          return;
        }
        if (error.reauth) {
          sessionReplaced([error.message, error.remediation].filter(Boolean).join(' '));
          return;
        }
        sw.disabled = false;
        note([
          error.status === 401 ? 'Wrong password.' : (error.message || 'access setting failed'),
          error.remediation,
        ].filter(Boolean).join(' '), true);
        form.hidden = false;
        password.focus();
        if (error.status >= 500) tryAutoUnlock();
      });
    }

    sw.addEventListener('click', function () {
      closePasswordChange();
      closeDd();
      showPassword(false);
      var on = sw.getAttribute('aria-checked') === 'true';
      if (on) {
        if (!confirm('Turn off local admin password? Anyone on this network will be able to open Settings, System, Logs, and Tools.')) return;
        desired = false;
        submit.textContent = 'turn off';
        form.hidden = false;
        note('', false);
        password.focus();
      } else {
        desired = true;
        submit.textContent = 'turn on';
        form.hidden = false;
        note('', false);
        password.focus();
      }
    });
    if (reconcile) reconcile.addEventListener('click', function () {
      closePasswordChange();
      closeDd();
      showPassword(false);
      desired = sw.getAttribute('aria-checked') === 'true';
      submit.textContent = 'reapply';
      form.hidden = false;
      note('Confirm your password to reapply the saved setting.', false);
      password.focus();
    });
    cancel.addEventListener('click', function () {
      password.value = '';
      showPassword(false);
      form.hidden = true;
      note('', false);
      sw.focus();
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = password.value;
      var authorization = adminBasicAuthorization(value);
      if (!authorization) {
        note('Password must use 1 to 64 UTF-8 bytes without control characters.', true);
        password.focus();
        return;
      }
      password.value = '';
      showPassword(false);
      value = '';
      save(desired, authorization);
      authorization = '';
    });
    if (passwordVisibility) passwordVisibility.addEventListener('click', function () {
      showPassword(password.type === 'password');
      password.focus();
    });
  }

  function wirePasswordChange(scope) {
    var control = scope.querySelector('[data-password-change]');
    if (!control) return;
    var open = control.querySelector('[data-password-change-open]');
    var form = control.querySelector('[data-password-change-form]');
    var current = control.querySelector('[data-password-current]');
    var next = control.querySelector('[data-password-new]');
    var confirmNext = control.querySelector('[data-password-confirm]');
    var cancel = control.querySelector('[data-password-change-cancel]');
    var status = control.querySelector('[data-password-change-status]');
    function note(message, error) {
      status.textContent = message || '';
      status.classList.toggle('err', !!error);
    }
    function clear() {
      current.value = '';
      next.value = '';
      confirmNext.value = '';
    }
    open.addEventListener('click', function () {
      var lanForm = control.querySelector('[data-lan-auth-confirm]');
      var lanPassword = control.querySelector('#lanAuthPassword');
      if (lanPassword) { lanPassword.value = ''; lanPassword.type = 'password'; }
      var lanVisibility = control.querySelector('[data-lan-password-visibility]');
      if (lanVisibility) {
        lanVisibility.setAttribute('aria-pressed', 'false');
        lanVisibility.setAttribute('aria-label', 'Show admin password');
      }
      if (lanForm) lanForm.hidden = true;
      var lanStatus = control.querySelector('[data-lan-auth-status]');
      if (lanStatus) { lanStatus.textContent = ''; lanStatus.classList.remove('err'); }
      closeDd();
      form.hidden = false;
      open.hidden = true;
      open.setAttribute('aria-expanded', 'true');
      note('', false);
      current.focus();
    });
    cancel.addEventListener('click', function () {
      clear();
      form.hidden = true;
      open.hidden = false;
      open.setAttribute('aria-expanded', 'false');
      note('', false);
      open.focus();
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var currentValue = current.value;
      var nextValue = next.value;
      var authorization = adminBasicAuthorization(currentValue);
      if (!authorization) {
        note('Current password must use 1 to 64 UTF-8 bytes without control characters.', true);
        current.focus();
        return;
      }
      if (!/^[A-Za-z0-9]{12,64}$/.test(nextValue)) {
        note('New password must use 12 to 64 letters or numbers.', true);
        next.focus();
        return;
      }
      if (nextValue !== confirmNext.value) {
        note('New passwords do not match.', true);
        confirmNext.focus();
        return;
      }
      var requestBody = JSON.stringify({ admin_password: nextValue });
      clear();
      currentValue = '';
      nextValue = '';
      note('changing password...', false);
      Array.prototype.forEach.call(form.elements, function (element) { element.disabled = true; });
      fetch('./avian/api/config.php', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-Avian-Action': '1',
          'X-Avian-Credential': '1',
          'Authorization': authorization,
        },
        body: requestBody,
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.ok) {
            var error = new Error(body.error || 'password change failed');
            error.status = response.status;
            error.recovery = !!body.recovery;
            error.reauth = !!body.reauth;
            error.remediation = body.remediation || '';
            throw error;
          }
          return body;
        });
      }).then(function () {
        sessionReplaced();
      }).catch(function (error) {
        if (error.recovery) {
          showAdminLocked('', true);
          return;
        }
        if (error.reauth) {
          sessionReplaced([error.message, error.remediation].filter(Boolean).join(' '));
          return;
        }
        Array.prototype.forEach.call(form.elements, function (element) { element.disabled = false; });
        note([
          error.status === 401 ? 'Current password is incorrect.' : (error.message || 'password change failed'),
          error.remediation,
        ].filter(Boolean).join(' '), true);
        current.focus();
        if (error.status >= 500) tryAutoUnlock();
      }).then(function () {
        Array.prototype.forEach.call(form.elements, function (element) { element.disabled = false; });
        requestBody = '';
        authorization = '';
      });
    });
  }
  function wireSettingsAccessDismissal(scope) {
    if (settingsAccessCleanup) settingsAccessCleanup();
    var control = scope.querySelector('[data-lan-auth-control]');
    if (!control) return;
    var lanForm = control.querySelector('[data-lan-auth-confirm]');
    var lanSwitch = control.querySelector('[data-lan-auth]');
    var passwordForm = control.querySelector('[data-password-change-form]');
    var passwordOpen = control.querySelector('[data-password-change-open]');
    function closeLan(returnFocus) {
      if (!lanForm || lanForm.hidden) return false;
      var input = lanForm.querySelector('#lanAuthPassword');
      if (input) { input.value = ''; input.type = 'password'; }
      var visibility = lanForm.querySelector('[data-lan-password-visibility]');
      if (visibility) {
        visibility.setAttribute('aria-pressed', 'false');
        visibility.setAttribute('aria-label', 'Show admin password');
      }
      lanForm.hidden = true;
      var status = control.querySelector('[data-lan-auth-status]');
      if (status) { status.textContent = ''; status.classList.remove('err'); }
      if (returnFocus && lanSwitch) lanSwitch.focus();
      return true;
    }
    function closePassword(returnFocus) {
      if (!passwordForm || passwordForm.hidden) return false;
      passwordForm.querySelectorAll('input[type="password"]').forEach(function (input) { input.value = ''; });
      passwordForm.hidden = true;
      if (passwordOpen) {
        passwordOpen.hidden = false;
        passwordOpen.setAttribute('aria-expanded', 'false');
        if (returnFocus) passwordOpen.focus();
      }
      var status = control.querySelector('[data-password-change-status]');
      if (status) { status.textContent = ''; status.classList.remove('err'); }
      return true;
    }
    function outside(event) {
      if (!event.target || typeof event.target.closest !== 'function') return;
      if (lanForm && !lanForm.hidden && !lanForm.contains(event.target)
        && event.target !== lanSwitch && !event.target.closest('[data-lan-auth-reconcile]')) closeLan(false);
      if (passwordForm && !passwordForm.hidden && !passwordForm.contains(event.target)
        && event.target !== passwordOpen) closePassword(false);
    }
    function escape(event) {
      if (event.key !== 'Escape') return;
      var closed = closePassword(true) || closeLan(true);
      if (closed) { event.preventDefault(); event.stopPropagation(); }
    }
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    settingsAccessCleanup = function () {
      closePassword(false);
      closeLan(false);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      settingsAccessCleanup = null;
    };
  }
  function wireSettingsControls(scope) {
    scope = scope || document;
    scope.querySelectorAll('.switch:not([data-atlas-always-all]):not([data-atlas-classic]):not([data-lan-auth]):not([data-birdweather-toggle]):not([data-birdweather-audio]):not([data-archive-toggle])').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        pending[sw.dataset.key] = on;
        queueSave(400);
      });
    });
    scope.querySelectorAll('input[type="range"]').forEach(function (sl) {
      sl.addEventListener('input', function () {
        var v = +sl.value;
        var digits = +sl.dataset.digits || 2;
        var label = scope.querySelector('[data-value-for="' + sl.dataset.key + '"]');
        if (label) label.textContent = v.toFixed(digits);
        pending[sl.dataset.key] = v;
      });
      // Commit on release, not on every pixel of the drag: these keys restart
      // the analyzer, and a drag fires input a hundred times.
      sl.addEventListener('change', function () { queueSave(300); });
    });
    scope.querySelectorAll('.seg:not([data-theme-seg]):not([data-birdweather-privacy])').forEach(function (seg) {
      seg.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
          pending[seg.dataset.key] = b.dataset.v;
          queueSave(400);
        });
      });
    });
    scope.querySelectorAll('input.secret').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var v = inp.value.trim();
        // An empty field means "leave it alone", not "clear it" - the
        // server never sends the saved value back, so an untouched field
        // is always empty.
        if (v) pending[inp.dataset.key] = v;
        else delete pending[inp.dataset.key];
        if (Object.keys(pending).length) queueSave(1100);   // wait out the typing
        else { clearTimeout(autoSaveT); setSaveState(''); }
      });
    });
    scope.querySelectorAll('input.settings-text').forEach(function (inp) {
      function stage() {
        pending[inp.dataset.key] = inp.value.trim();
      }
      inp.addEventListener('input', function () {
        stage();
        queueSave(800);
      });
      inp.addEventListener('change', function () {
        stage();
        saveSettings();
      });
      inp.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        stage();
        saveSettings();
        inp.blur();
      });
    });
  }

  function saveSettings() {
    if (Object.keys(pending).length === 0) return Promise.resolve(true);
    if (settingsSaveBusy) { queueSave(300); return Promise.resolve(false); }
    if (autoSaveT) clearTimeout(autoSaveT);
    autoSaveT = null;
    var submitted = pending;
    pending = {};
    var body = JSON.stringify(submitted);
    var saved = false;
    settingsSaveBusy = true;
    setSaveState('saving...');
    return adminFetch('./avian/api/config.php', {
      method: 'POST', body: body,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j.ok) {
          saved = true;
          if (Object.prototype.hasOwnProperty.call(submitted, 'SITE_NAME')
            && !Object.prototype.hasOwnProperty.call(pending, 'SITE_NAME')) {
            applySiteName(submitted.SITE_NAME);
          }
          setSaveState('saved ✓', 'ok');
          // COLLAGE_LABELS travels on the recent payload, so re-fetch it and
          // the collage follows at once instead of on the next timer.
          try { refreshRecent(false); } catch (e) { }
          setTimeout(function () { setSaveState(''); }, 1800);
        } else {
          restoreSubmittedSettings(submitted);
          setSaveState('save failed', 'err');
        }
      })
      .catch(function (error) {
        if (adminAuthCancelled(error)) return;
        restoreSubmittedSettings(submitted);
        setSaveState('network error', 'err');
      })
      .then(function () {
        settingsSaveBusy = false;
        submitted = {};
        return saved;
      });
  }

  function flushPendingSettings() {
    return new Promise(function (resolve) {
      function settle() {
        if (settingsSaveBusy) {
          setTimeout(settle, 25);
          return;
        }
        if (!Object.keys(pending).length) {
          resolve(true);
          return;
        }
        saveSettings().then(function (ok) {
          if (!ok) { resolve(false); return; }
          settle();
        });
      }
      if (autoSaveT) clearTimeout(autoSaveT);
      autoSaveT = null;
      settle();
    });
  }

  // ---- Hash routing + atlas detail modal ----
  // When a collage tile or stats row is clicked it sets
  // location.hash = '#sci=<name>'. On arrival we switch to the atlas
  // view, highlight the matching card, AND open the detail modal with
  // expanded info (Wikipedia summary, taxonomy, all past recordings).
  function readHash() {
    var m = location.hash.match(/^#sci=([^&]+)/);
    if (!m) return null;
    return decodeURIComponent(m[1]);
  }
  function highlightAtlas(sci) {
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;
    grid.querySelectorAll('.bird-card[data-active="true"]').forEach(function (c) {
      c.removeAttribute('data-active');
    });
    if (!sci) return;
    var attempts = 0;
    (function find() {
      var card = grid.querySelector('.bird-card[data-sci="' + sci.replace(/"/g, '\"') + '"]');
      if (!card) {
        if (attempts++ < 10) return setTimeout(find, 80);
        return;
      }
      card.setAttribute('data-active', 'true');
      card.setAttribute('data-pulse', 'true');
      setTimeout(function () { card.removeAttribute('data-pulse'); }, 520);
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    })();
  }

  // ---- Detail modal ----
  // Caches per-sci species info so opening the same modal twice doesn't
  // re-fetch. Wikipedia + per-species endpoints are slow over the
  // tunnel; one fetch per session is plenty.
  var SPECIES_CACHE = {};
  var WIKI_CACHE = {};
  var modalAudio = null;
  var modalRecBtn = null;
  var modalAudioToken = 0;
  function fmtRecTime(d, t) {
    // d="2026-05-15", t="20:25:29"
    if (!d) return '-';
    var date = new Date((d || '') + 'T' + (t || '00:00:00'));
    if (isNaN(date.getTime())) return d + ' ' + (t || '');
    var now = Date.now();
    var ago = Math.floor((now - date.getTime()) / 1000);
    if (ago < 60) return ago + 's ago';
    if (ago < 3600) return Math.floor(ago / 60) + 'm ago';
    if (ago < 86400) return Math.floor(ago / 3600) + 'h ago';
    return Math.floor(ago / 86400) + 'd ago';
  }
  function fmtDateLine(d, t) {
    if (!d) return '';
    try {
      var date = new Date(d + 'T' + (t || '00:00:00'));
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' - ' + (t ? t.slice(0, 5) : '');
    } catch (e) { return d + ' ' + (t || ''); }
  }
  function rarityLabel(total, firstSeenIso) {
    if (!total) return '-';
    var days = 1;
    if (firstSeenIso) {
      var t = Date.parse((firstSeenIso || '').replace(' ', 'T'));
      if (!isNaN(t)) days = Math.max(1, Math.ceil((Date.now() - t) / 86400000));
    }
    var perDay = total / days;
    if (perDay >= 5) return 'common';
    if (perDay >= 1) return 'regular';
    if (perDay >= 0.2) return 'occasional';
    return 'rare';
  }
  function clamp01(value) {
    return Math.max(0, Math.min(1, +value || 0));
  }
  function fmtAudioTime(seconds) {
    seconds = Math.max(0, isFinite(seconds) ? seconds : 0);
    var mins = Math.floor(seconds / 60);
    var secs = Math.floor(seconds % 60);
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
  }
  function modalRow() {
    return modalRecBtn && modalRecBtn.closest('.rec-row');
  }
  function setModalPlayState(button, playing) {
    if (!button) return;
    if (playing) button.setAttribute('data-active', 'true');
    else button.removeAttribute('data-active');
    button.setAttribute('aria-label', playing ? 'Pause recording' : 'Play recording');
    button.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  }
  function setRecordingPosition(row, pct, arm) {
    if (!row) return;
    var strip = row.querySelector('.rec-spectro');
    if (!strip) return;
    pct = clamp01(pct);
    var pctStr = (pct * 100).toFixed(3) + '%';
    var played = strip.querySelector('.rec-spectro-played');
    var cursor = strip.querySelector('.rec-spectro-cursor');
    var slider = strip.querySelector('.rec-spectro-scrub');
    var duration = +(row.dataset.audioDuration || 0);
    if (arm !== false) strip.classList.add('armed');
    if (played) played.style.width = pctStr;
    if (cursor) cursor.style.left = pctStr;
    if (slider) {
      slider.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
      slider.setAttribute('aria-valuetext', duration
        ? fmtAudioTime(pct * duration) + ' of ' + fmtAudioTime(duration)
        : Math.round(pct * 100) + ' percent');
    }
    var time = strip.querySelector('.rec-player-time');
    if (time) time.textContent = fmtAudioTime(pct * duration) + ' / ' + (duration ? fmtAudioTime(duration) : '--:--');
    row.dataset.pendingSeek = String(pct);
  }
  function loopBounds(row) {
    var start = clamp01(row && row.dataset.loopStart || 0);
    var end = clamp01(row && row.dataset.loopEnd || 0);
    if (end - start < .04) {
      end = Math.min(1, start + .25);
      start = Math.max(0, end - .25);
    }
    return { start: start, end: end };
  }
  function syncLoopRegion(row) {
    if (!row) return;
    var strip = row.querySelector('.rec-spectro');
    if (!strip) return;
    var bounds = loopBounds(row);
    row.dataset.loopStart = String(bounds.start);
    row.dataset.loopEnd = String(bounds.end);
    var enabled = row.dataset.loopEnabled === 'true';
    strip.toggleAttribute('data-loop', enabled);
    var region = strip.querySelector('.rec-loop-region');
    var startHandle = strip.querySelector('.rec-loop-handle[data-edge="start"]');
    var endHandle = strip.querySelector('.rec-loop-handle[data-edge="end"]');
    var button = strip.querySelector('.rec-loop-toggle');
    if (region) {
      region.style.left = (bounds.start * 100).toFixed(2) + '%';
      region.style.width = ((bounds.end - bounds.start) * 100).toFixed(2) + '%';
    }
    [startHandle, endHandle].forEach(function (handle, index) {
      if (!handle) return;
      var value = index ? bounds.end : bounds.start;
      handle.style.left = (value * 100).toFixed(2) + '%';
      handle.setAttribute('aria-valuenow', String(Math.round(value * 100)));
      var duration = +(row.dataset.audioDuration || 0);
      handle.setAttribute('aria-valuetext', duration
        ? fmtAudioTime(value * duration)
        : Math.round(value * 100) + ' percent');
      handle.tabIndex = enabled ? 0 : -1;
    });
    if (button) {
      button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      button.setAttribute('aria-label', enabled ? 'Stop repeating selected section' : 'Repeat a selected section');
    }
  }
  function setLoopEnabled(row, enabled) {
    if (!row) return;
    if (enabled) {
      var current = clamp01(row.dataset.pendingSeek || 0);
      var bounds = loopBounds(row);
      if (row.dataset.loopInitialized !== 'true') {
        bounds.start = current;
        bounds.end = Math.min(1, current + .25);
        if (bounds.end - bounds.start < .08) bounds.start = Math.max(0, bounds.end - .25);
        row.dataset.loopStart = String(bounds.start);
        row.dataset.loopEnd = String(bounds.end);
        row.dataset.loopInitialized = 'true';
      }
      row.dataset.loopEnabled = 'true';
      var active = modalRow();
      if (active === row && modalAudio && modalAudio.duration) {
        bounds = loopBounds(row);
        var pct = modalAudio.currentTime / modalAudio.duration;
        if (pct < bounds.start || pct >= bounds.end) {
          modalAudio.currentTime = bounds.start * modalAudio.duration;
          setRecordingPosition(row, bounds.start);
        }
      }
    } else {
      row.dataset.loopEnabled = 'false';
    }
    syncLoopRegion(row);
  }

  // rAF-driven cursor smoothing. timeupdate fires ~4Hz which feels
  // janky; sample audio.currentTime every animation frame so the playback
  // line tracks the custom spectrogram without layout transitions.
  var modalCursorRaf = null;
  function startCursorLoop() {
    if (modalCursorRaf) return;
    var tick = function () {
      if (!modalAudio || !modalRecBtn) { modalCursorRaf = null; return; }
      var row = modalRow();
      if (row && modalAudio.duration) {
        if (row.dataset.loopEnabled === 'true') {
          var bounds = loopBounds(row);
          var endTime = bounds.end * modalAudio.duration;
          if (modalAudio.currentTime >= endTime - .025) {
            modalAudio.currentTime = bounds.start * modalAudio.duration;
          }
        }
        var pct = (modalAudio.currentTime / modalAudio.duration) * 100;
        setRecordingPosition(row, pct / 100);
      }
      modalCursorRaf = requestAnimationFrame(tick);
    };
    modalCursorRaf = requestAnimationFrame(tick);
  }
  function stopCursorLoop() {
    if (modalCursorRaf) { cancelAnimationFrame(modalCursorRaf); modalCursorRaf = null; }
  }

  // Pause the currently-playing modal recording but KEEP the audio
  // element alive so the user can scrub (audio.currentTime is still
  // mutable on a paused element) and then resume from the same spot.
  // The cursor stays visible at its last position.
  function pauseModalAudio() {
    stopCursorLoop();
    if (modalAudio) { try { modalAudio.pause(); } catch (e) { } }
    audioRelease(stopModalAudio);
    if (modalRecBtn) {
      setModalPlayState(modalRecBtn, false);
    }
  }
  // Hard-stop: pause + tear down the audio + clear cursor. Used when
  // switching rows or closing the modal.
  function stopModalAudio() {
    audioRelease(stopModalAudio);
    stopCursorLoop();
    modalAudioToken += 1;
    if (modalAudio) { try { modalAudio.pause(); } catch (e) { } modalAudio = null; }
    if (modalRecBtn) {
      var prevRow = modalRow();
      if (prevRow) {
        var strip = prevRow.querySelector('.rec-spectro');
        if (strip) {
          strip.classList.remove('armed');
        }
        setRecordingPosition(prevRow, 0, false);
      }
      setModalPlayState(modalRecBtn, false);
      modalRecBtn = null;
    }
  }

  function sketchSrc(sci, pose) {
    // Look up the common name from the lifelist so the worker's JIT
    // Gemini prompt is right for a never-pre-rendered species.
    var sp = ((DATA.lifelist && DATA.lifelist.species) || [])
      .find(function (s) { return s.sci === sci; });
    var com = sp ? (sp.com || '') : '';
    var base = './avian/api/cutout.php?sci=' + encodeURIComponent(sci) +
      (com ? '&com=' + encodeURIComponent(com) : '') +
      '&v=' + artRevision(sci, SKETCH_VERSION);
    var n = +pose || 1;
    return n > 1 ? base + '&pose=' + n : base;
  }
  // ---- On-demand generation (atlas modal) ----
  // The generate button appears only for species with no illustration
  // (no DIMS entry): one press renders both poses on the Pi via
  // generate.php + generate_one.py, then the modal image and the
  // collage masks refresh in place. Cost control is the whole point -
  // people generate the birds they actually hear, not a whole region.
  var genPollT = null;
  var activeGenerate = null;
  function genBtnState(btn, label, disabled) {
    btn.textContent = label;
    btn.disabled = !!disabled;
  }
  function lockVisibleGenerateForAuth() {
    if (genPollT) { clearTimeout(genPollT); genPollT = null; }
    var btn = document.getElementById('modalGenerate');
    if (!btn || btn.hidden) return;
    var interrupted = activeGenerate && activeGenerate.btn === btn
      && activeGenerate.stillThere();
    genBtnState(btn, interrupted
      ? 'unlock in menu to check progress'
      : 'unlock in menu to generate', false);
  }
  function resumeVisibleGenerateAfterAuth() {
    var btn = document.getElementById('modalGenerate');
    if (!btn || btn.hidden) return;
    if (activeGenerate && activeGenerate.btn === btn
      && activeGenerate.stillThere()) {
      genBtnState(btn, 'checking progress...', true);
      watchGenerate(btn, activeGenerate.sci, activeGenerate.stillThere,
        activeGenerate.onDone, activeGenerate);
      return;
    }
    activeGenerate = null;
    if (/^unlock in menu/.test(btn.textContent || '')) {
      genBtnState(btn, 'generate image', false);
    }
  }
  function finishActiveGenerate(job) {
    if (activeGenerate === job) activeGenerate = null;
  }
  // stillThere tells the poller whether its button is still the one on
  // screen: the modal may have moved to another bird, and the atlas may have
  // re-rendered the card out from under us. Without it the poll repaints
  // someone else's button.
  function watchGenerate(btn, sci, stillThere, onDone, job) {
    clearTimeout(genPollT);
    adminJson('./avian/api/generate.php?action=status').then(function (s) {
      if (activeGenerate !== job) return;
      if (!stillThere()) { finishActiveGenerate(job); return; }
      if (s.running) {
        genBtnState(btn, s.step === 'masks' ? 'finishing...' : 'generating...', true);
        genPollT = setTimeout(function () {
          watchGenerate(btn, sci, stillThere, onDone, job);
        }, 4000);
        return;
      }
      if (s.ok && s.sci === sci) {
        finishActiveGenerate(job);
        genBtnState(btn, 'generated', true);
        justGenerated[sci] = Date.now();
        onDone();
      } else {
        finishActiveGenerate(job);
        genBtnState(btn, 'failed, try again', false);
      }
    }).catch(function (error) {
      if (activeGenerate !== job) return;
      if (adminAuthCancelled(error)) {
        if (stillThere()) genBtnState(btn, 'unlock in menu to check progress', false);
        return;
      }
      finishActiveGenerate(job);
      if (stillThere()) genBtnState(btn, 'failed, try again', false);
    });
  }
  // Kick a postcard generation off and follow it. Only one job runs on the Pi
  // at a time; keeping the action here also gives its cost and progress enough
  // context without adding a competing badge to the Atlas stamp itself.
  function startGenerate(btn, sci, stillThere, onDone) {
    if (!sci) return;
    stillThere = stillThere || function () { return document.body.contains(btn); };
    onDone = onDone || function () {
      delete POSTCARD_POSE_CACHE[sci];
      loadTables(true);
    };
    if (adminAccessState !== 'unlocked') {
      genBtnState(btn, 'unlock in menu to generate', false);
      openDd();
      focusEl(document.getElementById('lockPass'));
      return;
    }
    var job = { btn: btn, sci: sci, stillThere: stillThere, onDone: onDone };
    activeGenerate = job;
    genBtnState(btn, 'starting...', true);
    adminFetch('./avian/api/generate.php?action=start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
      body: JSON.stringify({ sci: sci }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (activeGenerate !== job || !stillThere()) return;
        if (!res.ok) {
          var why = (res.j && res.j.error) || 'failed';
          if (why === 'busy') {
            watchGenerate(btn, sci, stillThere, onDone, job);
            return;
          }
          finishActiveGenerate(job);
          genBtnState(btn, why === 'no gemini key' ? 'add a gemini key in settings' : why, false);
          return;
        }
        watchGenerate(btn, sci, stillThere, onDone, job);
      })
      .catch(function (error) {
        if (activeGenerate !== job) return;
        if (adminAuthCancelled(error)) {
          if (stillThere()) genBtnState(btn, 'unlock in menu to check progress', false);
          return;
        }
        finishActiveGenerate(job);
        if (stillThere()) genBtnState(btn, 'failed, try again', false);
      });
  }
  (function wireGenerate() {
    var btn = document.getElementById('modalGenerate');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var sci = (document.getElementById('modalSci').textContent || '').trim();
      startGenerate(btn, sci, function () {
        return (document.getElementById('modalSci').textContent || '').trim() === sci;
      }, function () {
        delete POSTCARD_POSE_CACHE[sci];
        var request = ++POSTCARD_IMAGE_REQUEST;
        var img = document.getElementById('modalImg');
        var artwork = document.getElementById('modalArtwork');
        var poseToggle = document.getElementById('modalPoseToggle');
        var freshness = justGenerated[sci] || Date.now();
        var generatedSrc = sketchSrc(sci, 2) + '&t=' + freshness;
        btn.hidden = true;
        if (artwork) artwork.setAttribute('data-art-state', 'loading');
        if (img) img.classList.add('is-loading');
        decodePostcardImage(generatedSrc).then(function (ok) {
          if (request !== POSTCARD_IMAGE_REQUEST || !img) return;
          if (!ok) {
            if (artwork) artwork.setAttribute('data-art-state', 'fallback');
            img.src = './nest-eggs.webp';
            img.dataset.sci = sci;
            img.alt = 'Nest with eggs, bird illustration temporarily unavailable for ' + sci;
            img.classList.remove('is-loading');
            return;
          }
          img.src = generatedSrc;
          img.dataset.sci = sci;
          img.alt = sci;
          rememberPostcardPose(sci, 2);
          if (artwork) artwork.setAttribute('data-art-state', 'ready');
          if (poseToggle) {
            poseToggle.removeAttribute('data-unavailable');
            [].slice.call(poseToggle.querySelectorAll('button')).forEach(function (poseBtn) {
              poseBtn.removeAttribute('data-unavailable');
              poseBtn.setAttribute('aria-current', poseBtn.dataset.pose === '2' ? 'true' : 'false');
            });
            syncPill(poseToggle);
          }
          requestAnimationFrame(function () {
            if (request === POSTCARD_IMAGE_REQUEST) img.classList.remove('is-loading');
          });
        });
        loadTables(true).then(function (loaded) {
          if (!loaded) return;
          var grid = document.getElementById('atlasGrid');
          requestAnimationFrame(function () {
            if (window.FX && grid) window.FX.run(grid);
            requestAnimationFrame(function () { refreshOpenPostcardStamp(sci); });
          });
        });
      });
    });
  })();

  var POSTCARD_IMAGE_REQUEST = 0;
  var POSTCARD_CONTENT_REQUEST = 0;
  var POSTCARD_POSE_CACHE = Object.create(null);
  var postcardPanelAnimations = [];
  var postcardPanelMotionId = 0;
  var postcardPanelTarget = 'about';
  var postcardPanelGroupName = '';

  function postcardPanels() {
    var postcard = document.getElementById('postcard-modal');
    if (!postcard) return [];
    var about = postcard.querySelector('.postcard-about');
    var recordings = postcard.querySelector('.postcard-recordings');
    return about && recordings ? [about, recordings] : [];
  }

  function postcardPanelName(panel) {
    return panel && panel.classList.contains('postcard-recordings') ? 'recordings' : 'about';
  }

  // Named <details> groups enforce exclusivity in the browser itself. The
  // height transition briefly needs both bodies rendered, so suspend the
  // shared name only for that measured interval and restore it once exactly
  // one panel is open again.
  function suspendPostcardPanelGroup(panels) {
    (panels || postcardPanels()).forEach(function (panel) {
      var name = panel.getAttribute('name');
      if (!name) return;
      if (!postcardPanelGroupName) postcardPanelGroupName = name;
      panel.removeAttribute('name');
    });
  }

  function restorePostcardPanelGroup(panels) {
    if (!postcardPanelGroupName) return;
    var name = postcardPanelGroupName;
    (panels || postcardPanels()).forEach(function (panel) {
      panel.setAttribute('name', name);
    });
    postcardPanelGroupName = '';
  }

  function clearPostcardPanelStyles(panel) {
    panel.style.removeProperty('height');
    panel.style.removeProperty('flex');
    panel.style.removeProperty('overflow');
    panel.style.removeProperty('will-change');
    panel.removeAttribute('data-panel-state');
  }

  function cancelPostcardPanelMotion() {
    postcardPanelAnimations.forEach(function (animation) {
      animation.onfinish = null;
      animation.oncancel = null;
      try { animation.cancel(); } catch (err) {}
    });
    postcardPanelAnimations = [];
  }

  function applyPostcardPanelState(targetName) {
    var panels = postcardPanels();
    suspendPostcardPanelGroup(panels);
    panels.forEach(function (panel) {
      panel.open = postcardPanelName(panel) === targetName;
      clearPostcardPanelStyles(panel);
    });
    restorePostcardPanelGroup(panels);
    postcardPanelTarget = targetName;
  }

  function settlePostcardPanels(targetName) {
    postcardPanelMotionId += 1;
    cancelPostcardPanelMotion();
    applyPostcardPanelState(targetName || 'about');
  }

  function resetPostcardPanels() {
    settlePostcardPanels('about');
  }

  function openPostcardPanel(target) {
    var panels = postcardPanels();
    if (panels.length !== 2 || panels.indexOf(target) === -1) return;

    var targetName = postcardPanelName(target);
    var other = panels[0] === target ? panels[1] : panels[0];
    if (!postcardPanelAnimations.length && postcardPanelTarget === targetName &&
        target.open && !other.open) return;

    // Read the currently painted heights before cancelling an in-flight
    // transition. A reversal therefore starts exactly where the prior motion
    // was interrupted instead of snapping back to its first keyframe.
    var starts = panels.map(function (panel) {
      return panel.getBoundingClientRect().height;
    });
    var motionId = ++postcardPanelMotionId;
    cancelPostcardPanelMotion();
    postcardPanelTarget = targetName;

    // Let the browser lay out the intended exclusive end state, then restore
    // both bodies while fixed-height clips animate between the two layouts.
    // Temporarily remove the native group name first; otherwise opening the
    // second body immediately closes the first before it can animate.
    suspendPostcardPanelGroup(panels);
    panels.forEach(function (panel) {
      clearPostcardPanelStyles(panel);
      panel.open = panel === target;
    });
    void target.offsetHeight;
    var ends = panels.map(function (panel) {
      return panel.getBoundingClientRect().height;
    });
    var reducedMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var canAnimate = panels.every(function (panel) {
      return typeof panel.animate === 'function';
    });
    var measurable = starts.concat(ends).every(function (height) {
      return isFinite(height) && height > 0;
    });
    if (reducedMotion || !canAnimate || !measurable) {
      applyPostcardPanelState(targetName);
      return;
    }

    panels.forEach(function (panel, index) {
      panel.open = true;
      panel.style.flex = '0 0 auto';
      panel.style.height = starts[index] + 'px';
      panel.style.overflow = 'hidden';
      panel.style.willChange = 'height';
      panel.setAttribute('data-panel-state', panel === target ? 'opening' : 'closing');
    });
    void target.offsetHeight;

    var animations = [];
    try {
      panels.forEach(function (panel, index) {
        animations.push(panel.animate([
          { height: starts[index] + 'px' },
          { height: ends[index] + 'px' }
        ], {
          duration: 260,
          easing: 'cubic-bezier(.32,.72,0,1)',
          fill: 'both'
        }));
      });
    } catch (err) {
      cancelPostcardPanelMotion();
      applyPostcardPanelState(targetName);
      return;
    }
    postcardPanelAnimations = animations;

    var finished = 0;
    animations.forEach(function (animation) {
      animation.onfinish = function () {
        finished += 1;
        if (finished !== animations.length || motionId !== postcardPanelMotionId) return;
        cancelPostcardPanelMotion();
        applyPostcardPanelState(targetName);
      };
    });
  }

  function decodePostcardImage(src) {
    return new Promise(function (resolve) {
      var probe = new Image();
      var settled = false;
      function done(ok) {
        if (settled) return;
        settled = true;
        resolve(ok);
      }
      probe.onload = function () {
        var decoded = probe.decode ? probe.decode() : Promise.resolve();
        Promise.resolve(decoded).catch(function () {}).then(function () { done(true); });
      };
      probe.onerror = function () { done(false); };
      probe.src = src;
    });
  }

  function postcardPoseAvailability(sci, poseBtns) {
    if (POSTCARD_POSE_CACHE[sci]) return Promise.resolve(POSTCARD_POSE_CACHE[sci]);
    return Promise.all(poseBtns.map(function (b) {
      var pose = +b.dataset.pose;
      return fetch(sketchSrc(sci, pose), { method: 'HEAD', cache: 'no-store' })
        .then(function (r) { return { pose: pose, ok: r.ok }; })
        .catch(function () { return { pose: pose, ok: false }; });
    })).then(function (results) {
      // Cache real availability, never a total transport failure. A temporary
      // offline/worker error may use the nest for this opening, but the next
      // postcard attempt should probe again rather than fossilize that miss.
      if (results.some(function (result) { return result.ok; })) {
        POSTCARD_POSE_CACHE[sci] = results;
      }
      return results;
    });
  }

  function populatePostcard(sci) {
    if (!sci) return;
    var request = ++POSTCARD_IMAGE_REQUEST;
    var contentRequest = ++POSTCARD_CONTENT_REQUEST;
    var img = document.getElementById('modalImg');
    var artwork = document.getElementById('modalArtwork');
    var genBtn = document.getElementById('modalGenerate');
    var poseToggle = document.getElementById('modalPoseToggle');
    var poseBtns = [].slice.call(poseToggle.querySelectorAll('button'));
    var needsArt = tablesReady && !DIMS[slugify(sci)];

    // Reset the visual synchronously. A confirmed missing illustration is a
    // deliberate egg-nest state, not a failed image request; this also means
    // the previous species can never remain visible behind the new postcard.
    if (artwork) artwork.setAttribute('data-art-state', needsArt ? 'missing' : 'loading');
    poseToggle.setAttribute('data-unavailable', 'true');
    poseBtns.forEach(function (b) {
      b.setAttribute('data-unavailable', 'true');
      b.setAttribute('aria-current', 'false');
    });
    if (genBtn) {
      genBtn.hidden = !needsArt;
      if (needsArt) genBtnState(genBtn,
        adminAccessState === 'unlocked' ? 'generate image' : 'unlock in menu to generate',
        false);
    }

    var imageReady;
    if (needsArt) {
      img.src = './nest-eggs.webp';
      img.dataset.sci = sci;
      img.alt = 'Nest with eggs, bird image not generated yet for ' + sci;
      img.classList.remove('is-loading');
      imageReady = Promise.resolve();
    } else {
      poseToggle.removeAttribute('data-unavailable');
      if (img.dataset.sci !== sci || !(img.complete && img.naturalWidth > 0)) {
        img.classList.add('is-loading');
      }
      img.alt = sci;

      // Probe each pose's image with HEAD. Restore this species' last confirmed
      // choice when it is readable; otherwise use the existing in-flight-first
      // default without allowing a stale preference to select a missing pose.
      // A DIMS-known image that cannot be read falls back to the nest without
      // offering generation; a transient transport failure is not missing art.
      imageReady = postcardPoseAvailability(sci, poseBtns).then(function (results) {
        if (request !== POSTCARD_IMAGE_REQUEST) return;
        var available = results.filter(function (r) { return r.ok; });
        poseBtns.forEach(function (b) {
          var result = results.find(function (r) { return r.pose === +b.dataset.pose; });
          if (result && result.ok) b.removeAttribute('data-unavailable');
          else b.setAttribute('data-unavailable', 'true');
        });
        // Default to the highest-numbered available pose (in-flight if present,
        // else perched). No readable pose gets a deterministic nest fallback.
        var rememberedPose = rememberedPostcardPose(sci);
        var pick = available.find(function (candidate) {
          return candidate.pose === rememberedPose;
        }) || available.slice().sort(function (a, b) { return b.pose - a.pose; })[0];
        if (!pick) {
          poseToggle.setAttribute('data-unavailable', 'true');
          if (artwork) artwork.setAttribute('data-art-state', 'fallback');
          img.src = './nest-eggs.webp';
          img.dataset.sci = sci;
          img.alt = 'Nest with eggs, bird illustration temporarily unavailable for ' + sci;
          img.classList.remove('is-loading');
          return;
        }
        var pickedButton = poseToggle.querySelector('button[data-pose="' + pick.pose + '"]');
        if (pickedButton) {
          poseBtns.forEach(function (b) {
            b.setAttribute('aria-current', b === pickedButton ? 'true' : 'false');
          });
        }
        // Single-option => hide the chrome.
        if (available.length <= 1) {
          poseToggle.setAttribute('data-unavailable', 'true');
        }
        // Slide the white pill to the active button.
        syncPill(poseToggle);
        var src = sketchSrc(sci, pick.pose);
        if (img.getAttribute('src') === src && img.complete && img.naturalWidth > 0) {
          img.dataset.sci = sci;
          if (artwork) artwork.setAttribute('data-art-state', 'ready');
          img.classList.remove('is-loading');
          return;
        }
        return decodePostcardImage(src).then(function (ok) {
          if (request !== POSTCARD_IMAGE_REQUEST) return;
          if (!ok) {
            poseToggle.setAttribute('data-unavailable', 'true');
            if (artwork) artwork.setAttribute('data-art-state', 'fallback');
            img.src = './nest-eggs.webp';
            img.dataset.sci = sci;
            img.alt = 'Nest with eggs, bird illustration temporarily unavailable for ' + sci;
            img.classList.remove('is-loading');
            return;
          }
          img.src = src;
          img.dataset.sci = sci;
          if (artwork) artwork.setAttribute('data-art-state', 'ready');
          requestAnimationFrame(function () {
            if (request === POSTCARD_IMAGE_REQUEST) img.classList.remove('is-loading');
          });
        });
      });
    }
    document.getElementById('modalSci').textContent = sci;
    var sciParts = sci.trim().split(/\s+/);
    var family = window.STAMPS && window.STAMPS.latinOf ? window.STAMPS.latinOf(sci) : '';
    if (!family && window.STAMPS && window.STAMPS.familyOf) family = window.STAMPS.familyOf(sci);
    document.getElementById('modalFamily').textContent = family || '-';
    document.getElementById('modalGenus').textContent = sciParts[0] || '-';
    document.getElementById('modalSpecies').textContent = sciParts.slice(1).join(' ') || '-';
    var lifelistBird = (((DATA || {}).lifelist || {}).species || []).find(function (bird) {
      return bird.sci === sci;
    });
    // The common name is already present on every Atlas card/lifelist row.
    // Paint it synchronously so a long title never arrives a frame late and
    // reflows the identity panel while the stamp is landing.
    document.getElementById('modalCommon').textContent = (lifelistBird && lifelistBird.com) || sci;
    document.getElementById('modalAllTime').textContent = '-';
    document.getElementById('modalFirstSeen').textContent = '-';
    document.getElementById('modalRarity').textContent = '-';
    document.getElementById('modalRarity').classList.remove('rare');
    document.getElementById('modalDesc').textContent = 'Loading description...';
    document.getElementById('modalDesc').classList.add('placeholder');
    var previousDistinctive = document.querySelector('.postcard-about .about-distinctive');
    if (previousDistinctive) previousDistinctive.remove();
    document.getElementById('modalRecordings').innerHTML = '<li class="rec-empty">Loading recordings...</li>';
    document.getElementById('modalRecCount').textContent = '';
    document.getElementById('modalWiki').href = wikiUrl(sci);
    var ebirdLink = document.getElementById('modalEbird');
    var ebirdHref = ebirdUrl(sci);
    ebirdLink.hidden = !ebirdHref;
    if (ebirdHref) ebirdLink.href = ebirdHref;
    else ebirdLink.removeAttribute('href');

    resetPostcardPanels();

    // Species detail (lifelist row + every detection).
    var loadSpecies = SPECIES_CACHE[sci]
      ? Promise.resolve(SPECIES_CACHE[sci])
      : fetchJson('./avian/api/birdnet-api.php?action=species&sci=' + encodeURIComponent(sci)).then(function (j) {
        SPECIES_CACHE[sci] = j;
        return j;
      });
    loadSpecies.then(function (j) {
      if (contentRequest !== POSTCARD_CONTENT_REQUEST) return;
      var s = j.summary || {};
      document.getElementById('modalCommon').textContent = s.com || sci;
      document.getElementById('modalAllTime').textContent = (+s.total || 0).toLocaleString();
      document.getElementById('modalFirstSeen').textContent = s.first_seen ? fmtRecTime(s.first_seen.split(' ')[0], s.first_seen.split(' ')[1]) : '-';
      var rar = rarityLabel(+s.total || 0, s.first_seen);
      var rarEl = document.getElementById('modalRarity');
      rarEl.textContent = rar;
      if (rar === 'rare') rarEl.classList.add('rare');
      var dets = j.detections || [];
      document.getElementById('modalRecCount').textContent = dets.length + (dets.length === 1 ? ' recording' : ' recordings');
      document.getElementById('modalRecordings').innerHTML = dets.length
        ? dets.map(function (d) {
          return '<li class="rec-row" data-file="' + escHtml(d.file || '') + '" data-date="' + escHtml(d.d || '') + '">'
            + '<button class="rec-row-toggle" type="button" aria-expanded="false">'
            + '<span class="when"><b>' + fmtRecTime(d.d, d.t) + '</b></span>'
            + '<span class="conf"><b>' + ((+d.conf || 0) * 100).toFixed(0) + '%</b></span>'
            + '<span class="date-time"><b>' + fmtDateLine(d.d, d.t) + '</b></span>'
            + '</button>'
            + '<div class="rec-spectro" aria-hidden="true">'
            + '<div class="rec-spectro-loading">loading spectrogram...</div>'
            + '<div class="rec-spectro-played"></div>'
            + '<div class="rec-loop-region" aria-hidden="true"></div>'
            + '<div class="rec-spectro-cursor"></div>'
            + '<div class="rec-spectro-scrub" role="slider" aria-label="Scrub recording spectrogram" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0"></div>'
            + '<button class="rec-loop-handle" data-edge="start" type="button" role="slider" aria-label="Repeat section start" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1"></button>'
            + '<button class="rec-loop-handle" data-edge="end" type="button" role="slider" aria-label="Repeat section end" aria-valuemin="0" aria-valuemax="100" aria-valuenow="25" tabindex="-1"></button>'
            + '<div class="rec-player-controls">'
            + '<button class="rec-player-toggle" type="button" aria-label="Play recording">' + ICON_PLAY + '</button>'
            + '<span class="rec-player-time" aria-hidden="true">0:00 / --:--</span>'
            + '<button class="rec-loop-toggle" type="button" aria-label="Repeat a selected section" aria-pressed="false">' + ICON_LOOP + '<span>loop</span></button>'
            + '</div>'
            + '</div>'
            + '</li>';
        }).join('')
        : '<li class="rec-empty">No recordings yet.</li>';
      document.getElementById('modalRecordings').scrollTop = 0;
    }).catch(function () {
      if (contentRequest !== POSTCARD_CONTENT_REQUEST) return;
      document.getElementById('modalRecordings').innerHTML = '<li class="rec-empty">Failed to load recordings.</li>';
    });

    // Wikipedia lead (description + genus / family). `format=6` deliberately
    // changes the cache key after the compact-card sentence-budget pass.
    var loadWiki = WIKI_CACHE[sci]
      ? Promise.resolve(WIKI_CACHE[sci])
      : fetchJson('./avian/api/wiki.php?format=6&sci=' + encodeURIComponent(sci)).then(function (j) {
        WIKI_CACHE[sci] = j; return j;
      });
    loadWiki.then(function (j) {
      if (contentRequest !== POSTCARD_CONTENT_REQUEST) return;
      var desc = document.getElementById('modalDesc');
      renderAboutDescription(desc, j);
      if (j.source && /^https:\/\/en\.wikipedia\.org\/wiki\//.test(j.source.url || '')) {
        document.getElementById('modalWiki').href = j.source.url;
      }
    }).catch(function () {
      if (contentRequest !== POSTCARD_CONTENT_REQUEST) return;
      var desc = document.getElementById('modalDesc');
      desc.textContent = 'No description available.';
      desc.classList.add('placeholder');
    });
    return imageReady;
  }

  // Deep links and non-stamp surfaces still use the historical entry point.
  // Route them into the same postcard instead of maintaining a second detail
  // modal with a subtly different information hierarchy.
  function openDetailModal(sci, waitCount) {
    if (!sci) return;
    var card = atlasGridEl
      ? atlasGridEl.querySelector('.bird-card[data-sci="' + sci.replace(/"/g, '\"') + '"]')
      : null;
    if (card && card.classList.contains('stamp-card')) return openPostcard(card, { preserveHash: true });

    // On a fresh #sci= load the route runs before the asynchronous Atlas has
    // committed its stamp cards. Wait briefly for the matching source so the
    // postcard never opens with an empty stamp slot. A filtered/missing bird
    // still falls back to the information-only card after the bounded wait.
    waitCount = +waitCount || 0;
    if (atlasGridEl && !atlasGridEl.querySelector('.bird-card') && waitCount < 15) {
      setTimeout(function () {
        if (readHash() === sci) openDetailModal(sci, waitCount + 1);
      }, 80);
      return;
    }
    populatePostcard(sci);
    var postcard = document.getElementById('postcard-modal');
    if (!postcard) return;
    setPostcardAtlasSource(atlasUsesClassicCards() ? 'classic' : 'stamps');
    preparePostcardShell();
    revealPostcardShell();
  }
  function cleanAboutLead(text) {
    return String(text || '')
      .replace(/\(\s*\)/g, '')
      .replace(/[\t\u00a0 ]+/g, ' ')
      .replace(/ *\r?\n+ */g, '\n')
      .trim();
  }

  function aboutSentences(text) {
    var flat = cleanAboutLead(text).replace(/\n+/g, ' ');
    if (!flat) return [];
    var out = [];
    var start = 0;
    // Avoid lookbehind so the fallback stays compatible with older WebKit.
    // Sentence punctuation only counts when the next token looks like a new
    // sentence, which keeps common abbreviations in the source intact.
    var boundary = /[.!?](?:["”’')\]]*)?(?=\s+(?:["“‘'(]?[A-Z0-9])|$)/g;
    var match;
    while ((match = boundary.exec(flat))) {
      var end = boundary.lastIndex;
      var sentence = flat.slice(start, end).trim();
      if (sentence) out.push(sentence);
      start = end;
      while (/\s/.test(flat.charAt(start))) start += 1;
      boundary.lastIndex = start;
    }
    var tail = flat.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  function completeAboutSentence(sentence) {
    sentence = String(sentence || '').trim();
    if (/(?:\.{3}|…)\s*["”’')\]]*$/.test(sentence)) return false;
    return /[.!?]\s*["”’')\]]*$/.test(sentence);
  }

  // Backward-compatible formatter for a cached/older wiki response. The API
  // now supplies these paragraphs directly, but this keeps every sentence
  // complete even if a proxy briefly serves the prior response shape.
  function aboutParagraphs(text) {
    var lead = cleanAboutLead(text);
    var sentences = aboutSentences(lead).filter(completeAboutSentence);
    if (sentences.length <= 1) return sentences;

    var sourceParagraphs = lead.split(/\n+/).filter(Boolean);
    var firstSourceIsIntro = sourceParagraphs.length > 1 &&
      aboutSentences(sourceParagraphs[0]).length === 1;
    var intro = [sentences[0]];
    var cursor = 1;
    var introLength = sentences[0].length;
    if (!firstSourceIsIntro && sentences.length > 2 && introLength < 150) {
      var withSecond = introLength + 1 + sentences[1].length;
      if (withSecond <= 285) {
        intro.push(sentences[1]);
        introLength = withSecond;
        cursor = 2;
      }
    }

    var detail = [];
    var detailLength = 0;
    var skippedMinorVagrancy = false;
    for (; cursor < sentences.length; cursor += 1) {
      // Prefer the fuller context that follows a short exceptional-vagrancy
      // aside when at least two complete source sentences remain.
      var minorVagrancy = sentences[cursor].length <= 140 &&
        /(?:\b(?:rare|occasional(?:ly)?)\b[^.!?]{0,90}\bvagrant\b|\bvagrant\b[^.!?]{0,90}\b(?:rare|occasional(?:ly)?)\b)/i.test(sentences[cursor]);
      if (minorVagrancy && sentences.length - cursor - 1 >= 2) {
        skippedMinorVagrancy = true;
        continue;
      }
      if (skippedMinorVagrancy && detail.length >= 2) break;
      var nextLength = detailLength + (detail.length ? 1 : 0) + sentences[cursor].length;
      var nextTotal = introLength + 2 + nextLength;
      // Preserve at least two complete context sentences, then stop before a
      // third would make the middle paragraph feel oversized. Never clip text.
      if (detail.length >= 2 && nextLength > 380) break;
      if (detail.length >= 2 && nextTotal > 700 &&
          introLength + 2 + detailLength >= 430) break;
      detail.push(sentences[cursor]);
      detailLength = nextLength;
      if (detail.length >= 2 && detailLength >= 360 &&
          introLength + 2 + detailLength >= 430) break;
    }
    // Match the API's main-copy ceiling for a cached legacy payload. Remove
    // only whole trailing sentences, keeping one true intro and one context
    // sentence; a modern structured response has already run the full
    // paragraph + field-mark line budget on the server.
    while (intro.join(' ').length + 2 + detail.join(' ').length > 575) {
      if (intro.length > 1) intro.pop();
      else if (detail.length > 1) detail.pop();
      else break;
    }
    return [intro.join(' '), detail.join(' ')];
  }

  function renderAboutDescription(desc, payload) {
    var supplied = payload && Array.isArray(payload.paragraphs)
      ? payload.paragraphs
      : [];
    var paragraphs = supplied.map(function (paragraph) {
      return String(paragraph || '').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    if (!paragraphs.length && payload && payload.extract) {
      paragraphs = aboutParagraphs(payload.extract);
    }

    desc.textContent = '';
    var aboutBody = desc.closest('.postcard-section-body');
    var existingDistinctive = aboutBody && aboutBody.querySelector('.about-distinctive');
    if (existingDistinctive) existingDistinctive.remove();
    if (!paragraphs.length) {
      desc.textContent = 'No description available.';
      desc.classList.add('placeholder');
      return;
    }
    paragraphs.forEach(function (paragraph) {
      var block = document.createElement('p');
      block.textContent = paragraph;
      desc.appendChild(block);
    });
    var distinctive = payload && typeof payload.distinctive === 'string'
      ? payload.distinctive.replace(/\s+/g, ' ').trim()
      : '';
    var taxonomy = aboutBody && aboutBody.querySelector('.modal-meta');
    if (distinctive && taxonomy) {
      var fieldMarks = document.createElement('p');
      fieldMarks.className = 'desc about-distinctive';
      fieldMarks.textContent = distinctive;
      taxonomy.insertAdjacentElement('afterend', fieldMarks);
    }
    desc.classList.remove('placeholder');
  }

  function closeDetailModal() {
    closePostcard();
  }

  // Shared-element morph: the modal-card scales+translates from the
  // clicked atlas card's exact rect to its natural centred rect, so the
  // little card appears to expand into the big one (and retract on
  // close). Only the card transforms; the container's opacity does the
  // single fade for backdrop + card together - no double-fade, and the
  // transform is cleared only once hidden so there's no mid-close snap.
  var atlasGridEl = document.getElementById('atlasGrid');
  var modalCloseResetTimer = null;
  function morphTransform(modalCard, sourceCard) {
    if (!modalCard || !sourceCard) return null;
    var s = sourceCard.getBoundingClientRect();
    // Source off-screen (opened from stats mid-slide, or scrolled away)
    // -> skip the morph and just fade, rather than fly in from nowhere.
    if (!s.width || s.bottom < 0 || s.top > window.innerHeight ||
      s.right < 0 || s.left > window.innerWidth) return null;
    var m = modalCard.getBoundingClientRect();
    if (!m.width) return null;
    var scale = Math.max(0.1, s.width / m.width);
    var dx = (s.left + s.width / 2) - (m.left + m.width / 2);
    var dy = (s.top + s.height / 2) - (m.top + m.height / 2);
    return 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' + scale.toFixed(4) + ')';
  }
  // Run cb once the transform transition finishes, with a timeout
  // fallback for environments where transitionend doesn't fire.
  function onceTransformEnd(el, cb, fallbackMs) {
    var fired = false;
    function handler(ev) {
      if (ev && ev.propertyName && ev.propertyName !== 'transform') return;
      if (fired) return;
      fired = true;
      el.removeEventListener('transitionend', handler);
      cb();
    }
    el.addEventListener('transitionend', handler);
    setTimeout(handler, fallbackMs);
  }
  function morphModalOpen(modalCard, sourceCard) {
    var modal = document.getElementById('detail-modal');
    if (!modalCard) { modal.classList.add('is-open'); return; }
    if (modalCloseResetTimer) {
      clearTimeout(modalCloseResetTimer);
      modalCloseResetTimer = null;
    }
    // Identity first so we can measure the card's natural rect, then jump
    // it (no transition) to the source card's position + scale.
    modalCard.classList.remove('is-morphing');
    modalCard.style.transform = '';
    void modalCard.offsetWidth;
    var start = morphTransform(modalCard, sourceCard);
    if (start) {
      modalCard.style.transform = start;
      void modalCard.offsetWidth;
    }
    // Next tick: fade the container in and glide the card to identity.
    // setTimeout (not rAF) - rAF can stall in non-painting/headless
    // contexts; the forced reflow above already commits the start
    // transform so the transition interpolates cleanly from it.
    setTimeout(function () {
      modal.classList.add('is-open');
      if (start) {
        modalCard.classList.add('is-morphing');
        modalCard.style.transform = 'translate3d(0,0,0) scale(1)';
      }
    }, 0);
    if (start) {
      onceTransformEnd(modalCard, function () {
        // A close took over (is-open gone); clearing now snaps the card to centre.
        if (!modal.classList.contains('is-open')) return;
        modalCard.classList.remove('is-morphing');
        modalCard.style.transform = '';
      }, 360);
    }
  }
  function morphModalClose(modalCard, sourceCard, done) {
    var modal = document.getElementById('detail-modal');
    // Fade the container out (backdrop + card) and retract the card to
    // the source rect at the same time.
    modal.classList.remove('is-open');
    var end = modalCard ? morphTransform(modalCard, sourceCard) : null;
    var finish = function () {
      if (done) done();
      if (modalCard) {
        if (modalCloseResetTimer) clearTimeout(modalCloseResetTimer);
        modalCloseResetTimer = setTimeout(function () {
          modalCard.classList.remove('is-morphing');
          modalCard.style.transform = '';
          modalCloseResetTimer = null;
        }, 240);
      }
    };
    if (modalCard && end) {
      modalCard.classList.add('is-morphing');
      void modalCard.offsetWidth;
      modalCard.style.transform = end;
      onceTransformEnd(modalCard, finish, 360);
    } else {
      // No morph -> let the container opacity fade run, then hide.
      setTimeout(finish, 280);
    }
  }

  // Pose toggle inside the modal - swaps the sketch between perched and
  // in-flight, then remembers the confirmed choice for this species. A short
  // opacity transition makes the swap feel intentional rather than a hard cut.
  document.getElementById('modalPoseToggle').addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('button');
    if (!btn || btn.getAttribute('data-unavailable') === 'true') return;
    var pose = +btn.dataset.pose;
    var toggle = document.getElementById('modalPoseToggle');
    [].slice.call(toggle.querySelectorAll('button')).forEach(function (b) {
      b.setAttribute('aria-current', b === btn ? 'true' : 'false');
    });
    syncPill(toggle);
    var img = document.getElementById('modalImg');
    var sci = (document.getElementById('modalSci').textContent || '').trim();
    var request = ++POSTCARD_IMAGE_REQUEST;
    var src = sketchSrc(sci, pose);
    var hasCurrentPose = img.complete && img.naturalWidth > 0 && img.getAttribute('src');
    if (!hasCurrentPose) img.classList.add('is-loading');
    decodePostcardImage(src).then(function (ok) {
      if (request !== POSTCARD_IMAGE_REQUEST) return;
      if (!ok) return;
      img.src = src;
      img.dataset.sci = sci;
      rememberPostcardPose(sci, pose);
      var artwork = document.getElementById('modalArtwork');
      if (artwork) artwork.setAttribute('data-art-state', 'ready');
      requestAnimationFrame(function () {
        if (request === POSTCARD_IMAGE_REQUEST) img.classList.remove('is-loading');
      });
    });
  });

  // Expose for debugging during dev - also lets the modal be opened
  // from outside the IIFE if needed.
  window.__openDetailModal = openDetailModal;
  window.__closeDetailModal = closeDetailModal;

  // ===== Admin overlay (settings / system / logs / tools) =====
  // Lives in the same shell as the rest of the app - the menu button
  // and return-to-atlas pill stay put. The slider hides; this overlay
  // takes over the body. Navigation is via the drawer menu, NOT
  // internal tabs (the drawer is the canonical nav surface).
  var adminEl = document.getElementById('adminScreen');
  var adminBody = document.getElementById('adminBody');
  var adminTitle = document.getElementById('adminTitle');
  var adminPollT = null;
  var adminSect = null;
  var adminTitleFrame = 0;
  var ADMIN_TITLES = {
    settings: 'Settings',
    system: 'System',
    logs: 'Logs',
    tools: 'Tools',
  };
  function syncAdminTitlePin() {
    adminTitleFrame = 0;
    if (!adminEl) return;
    var pinned = adminEl.getAttribute('data-title-pinned') === 'true';
    // Both desktop and mobile titles travel 42px from their resting row to
    // the fixed control line. The smaller exit threshold prevents chatter
    // without leaving a backdrop behind a title that has already moved down.
    var pinAt = 42;
    var threshold = pinned ? pinAt - 8 : pinAt;
    adminEl.setAttribute('data-title-pinned',
      adminSect === 'settings' && adminEl.scrollTop > threshold ? 'true' : 'false');
  }
  function queueAdminTitlePin() {
    if (adminTitleFrame) return;
    adminTitleFrame = requestAnimationFrame(syncAdminTitlePin);
  }
  if (adminEl) adminEl.addEventListener('scroll', queueAdminTitlePin, { passive: true });
  function adminEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function adminAttr(s) {
    return adminEsc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function adminCopyText(text) {
    function legacyCopy() {
      return new Promise(function (resolve, reject) {
        var active = document.activeElement;
        var input = document.createElement('textarea');
        input.value = text;
        input.style.position = 'fixed';
        input.style.top = '0';
        input.style.left = '0';
        input.style.width = '2px';
        input.style.height = '2px';
        input.style.padding = '0';
        input.style.border = '0';
        input.style.opacity = '0.01';
        document.body.appendChild(input);
        input.focus();
        input.select();
        input.setSelectionRange(0, input.value.length);
        var copied = false;
        try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
        input.remove();
        if (active && active.focus) active.focus();
        if (copied) resolve();
        else reject(new Error('copy unavailable'));
      });
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(legacyCopy);
    }
    return legacyCopy();
  }
  function adminFmtBytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }
  function adminFmtAge(s) {
    if (s == null) return '-';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  // Admin endpoints reuse the HttpOnly session set by menu.php. Nothing
  // sensitive is kept in JavaScript-readable storage.
  function adminApi(url) {
    return adminFetch(url, { credentials: 'same-origin', cache: 'no-store' });
  }
  function openAdmin(section) {
    if (adminAccessState !== 'unlocked') {
      pendingAdminSection = section;
      if (adminAccessState === 'locked') {
        showAdminLocked('', false);
      }
      return;
    }
    if (adminSect === 'settings' && section !== 'settings') {
      discardPendingSettings();
      if (settingsInfoCleanup) settingsInfoCleanup();
      if (settingsAccessCleanup) settingsAccessCleanup();
    }
    adminViewGeneration += 1;
    document.body.classList.add('admin-on');
    adminEl.setAttribute('aria-hidden', 'false');
    adminTitle.textContent = ADMIN_TITLES[section] || section;
    if (adminPollT) { clearInterval(adminPollT); adminPollT = null; }
    if (adminSect !== section) adminEl.scrollTop = 0;
    adminSect = section;
    adminEl.setAttribute('data-admin-section', section);
    syncAdminTitlePin();
    if (section === 'settings') renderAdminSettings();
    else if (section === 'system') renderAdminSystem();
    else if (section === 'logs') renderAdminLogs();
    else if (section === 'tools') renderAdminTools();
    else adminBody.innerHTML = adminUnreachableHtml('unknown admin section');
  }
  function closeAdmin() {
    var wasAdminOn = document.body.classList.contains('admin-on');
    var previousAdminSect = adminSect;
    if (previousAdminSect === 'settings') {
      discardPendingSettings();
      if (settingsInfoCleanup) settingsInfoCleanup();
      if (settingsAccessCleanup) settingsAccessCleanup();
    }
    adminViewGeneration += 1;
    document.body.classList.remove('admin-on');
    adminEl.setAttribute('aria-hidden', 'true');
    if (adminPollT) { clearInterval(adminPollT); adminPollT = null; }
    adminSect = null;
    adminEl.scrollTop = 0;
    adminEl.removeAttribute('data-admin-section');
    syncAdminTitlePin();
    if (wasAdminOn) queueVisibleAtlasPack();
  }

  // One quiet glyph per metric, drawn on the same 24-grid and stroke weight as
  // the tool-card icons so the two admin pages read as one hand. Sits in the
  // top-right dead space; alert/warn tint it rather than ringing the whole card.
  var SYS_ICONS = {
    pipeline: '<path d="M3 12h3l2-5 3 11 2-7 1.6 3H21"/>',
    audio: '<path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3"/>',
    db: '<ellipse cx="12" cy="6" rx="6.5" ry="2.5"/><path d="M5.5 6v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6"/><path d="M5.5 12v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l2.6 1.8"/>',
    temp: '<path d="M14 13.6V6a2 2 0 0 0-4 0v7.6a3 3 0 1 0 4 0z"/><path d="M12 13.4V9"/>',
    mem: '<rect x="3.5" y="8" width="17" height="8" rx="1.2"/><path d="M7 8V6M11 8V6M15 8V6M7 18v-2M11 18v-2M15 18v-2"/>',
    disk: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><circle cx="16.5" cy="12" r="1.2"/><path d="M6.5 12h6"/>',
    mic: '<path d="M12 3.5a2 2 0 0 1 2 2v5a2 2 0 0 1-4 0v-5a2 2 0 0 1 2-2z"/><path d="M7.5 10.5a4.5 4.5 0 0 0 9 0"/><path d="M12 15v2.5"/>'
  };
  function adminIcon(key) {
    if (!SYS_ICONS[key]) return '';
    return '<span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + SYS_ICONS[key] + '</svg></span>';
  }
  function adminCard(title, value, sub, cls, icon) {
    return '<div class="admin-card ' + (cls || '') + '">'
      + adminIcon(icon)
      + '<h3>' + adminEsc(title) + '</h3>'
      + '<div class="v">' + adminEsc(value) + '</div>'
      + (sub ? '<div class="sub">' + adminEsc(sub) + '</div>' : '')
      + '</div>';
  }
  // sudo -n fails fast if the narrow admin policy is missing. Point at the
  // surgical repair helper instead of rerunning the full first installer.
  var SUDO_HINT = 'admin setup incomplete. run sudo /usr/local/sbin/avian-service-refresh on the pi.';
  function sudoBlocked(text) {
    return typeof text === 'string' && /sudo:.*password is required|sudo:.*no tty/i.test(text);
  }
  function adminUnreachableHtml(reason) {
    return '<div class="admin-unreachable">Pi unreachable - ' + adminEsc(reason || 'no data') + '</div>';
  }

  // ---- Station location picker ----
  // A small slippy map built by hand rather than pulled from a CDN: the
  // page ships no build step and has to keep working on a Pi behind a
  // tunnel, so the only network calls are the OSM tiles themselves and a
  // Nominatim lookup when the owner searches. Both are opt-in, in the
  // sense that nothing here loads until the pin is clicked.
  var TILE = 256;
  function lonToX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function latToY(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }
  function xToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function yToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function openStationPicker(lat, lon, onPick) {
    var z = (lat || lon) ? 11 : 2;
    var cx = lonToX(lon || 0, z), cy = latToY(lat || 0, z);
    var host = document.createElement('div');
    host.className = 'map-modal';
    host.innerHTML =
      '<div class="map-backdrop" data-close="1"></div>'
      + '<div class="map-card">'
      + '  <div class="map-head">'
      + '    <input id="mapSearch" type="text" placeholder="search for a place" autocomplete="off">'
      + '    <button type="button" class="pin-btn" id="mapClose" aria-label="close">' + ICON_CLOSE + '</button>'
      + '  </div>'
      + '  <div class="map-view" id="mapView"><div class="map-tiles" id="mapTiles"></div>'
      + '    <div class="map-pin" aria-hidden="true"></div>'
      + '    <div class="map-zoom"><button type="button" data-z="1">+</button><button type="button" data-z="-1">-</button></div>'
      + '    <ul class="map-hits" id="mapHits" hidden></ul>'
      + '  </div>'
      + '  <div class="map-foot"><span class="map-coords" id="mapCoords"></span>'
      + '    <span class="map-attr">&copy; OpenStreetMap contributors</span>'
      + '    <button type="button" class="map-use" id="mapUse">use this location</button></div>'
      + '</div>';
    document.body.appendChild(host);
    var view = host.querySelector('#mapView');
    var tiles = host.querySelector('#mapTiles');
    var coords = host.querySelector('#mapCoords');

    function centre() {
      return { lat: yToLat(cy, z), lon: xToLon(cx, z) };
    }
    function draw() {
      var w = view.clientWidth, h = view.clientHeight;
      var cols = Math.ceil(w / TILE) + 2, rows = Math.ceil(h / TILE) + 2;
      var x0 = Math.floor(cx - cols / 2), y0 = Math.floor(cy - rows / 2);
      var max = Math.pow(2, z), html = '';
      for (var i = 0; i < cols; i++) {
        for (var j = 0; j < rows; j++) {
          var tx = x0 + i, ty = y0 + j;
          if (ty < 0 || ty >= max) continue;
          var wx = ((tx % max) + max) % max;
          var left = Math.round((tx - cx) * TILE + w / 2);
          var top = Math.round((ty - cy) * TILE + h / 2);
          html += '<img alt="" draggable="false" style="left:' + left + 'px;top:' + top + 'px" src="https://tile.openstreetmap.org/'
            + z + '/' + wx + '/' + ty + '.png">';
        }
      }
      tiles.innerHTML = html;
      var c = centre();
      coords.textContent = c.lat.toFixed(4) + ', ' + c.lon.toFixed(4);
    }
    // drag to pan
    var dragging = false, px = 0, py = 0;
    view.addEventListener('pointerdown', function (e) {
      // The zoom buttons and the results list live over the map. Capturing
      // the pointer for a pan would eat their click, so leave them alone.
      if (e.target.closest('.map-zoom') || e.target.closest('.map-hits')) return;
      dragging = true; px = e.clientX; py = e.clientY;
      view.setPointerCapture(e.pointerId);
    });
    view.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      cx -= (e.clientX - px) / TILE; cy -= (e.clientY - py) / TILE;
      px = e.clientX; py = e.clientY;
      draw();
    });
    view.addEventListener('pointerup', function () { dragging = false; });
    host.querySelector('.map-zoom').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var c = centre();
      z = Math.max(2, Math.min(17, z + (+b.dataset.z)));
      cx = lonToX(c.lon, z); cy = latToY(c.lat, z);
      draw();
    });
    // Search offers the top few hits rather than jumping to the first, since
    // a place name is rarely unique. The list floats over the map and only it
    // takes the pointer, so the map can still be dragged underneath.
    var hits = host.querySelector('#mapHits');
    var field = host.querySelector('#mapSearch');
    function hideHits() { hits.hidden = true; hits.innerHTML = ''; }
    function note(msg) {
      hits.innerHTML = '<li class="map-note">' + escHtml(msg) + '</li>';
      hits.hidden = false;
    }
    // A place name is rarely unique, so the head of the name is what
    // distinguishes one hit from another and the tail is context.
    function showHits(list) {
      if (!list.length) { note('nothing found'); return; }
      hits.innerHTML = list.map(function (h, i) {
        var parts = h.display_name.split(', ');
        return '<li><button type="button" data-hit="' + i + '">'
          + '<span class="place">' + escHtml(parts.shift()) + '</span>'
          + (parts.length ? '<span class="where">' + escHtml(parts.join(', ')) + '</span>' : '')
          + '</button></li>';
      }).join('');
      hits.hidden = false;
      hits.scrollTop = 0;
    }
    function goTo(la, lo, zoom) {
      z = zoom || 13; cx = lonToX(lo, z); cy = latToY(la, z); draw();
    }
    function take(h) {
      if (!h) return;
      goTo(+h.lat, +h.lon);
      hideHits();
      field.value = h.display_name.split(',')[0];
    }
    // Responses can land out of order, so only the newest query is allowed to
    // paint. Without the token a slow "San" can overwrite a fast "San Diego".
    var found = [], searchT, seq = 0;
    function run(q) {
      var mine = ++seq;
      note('searching...');
      fetch('https://nominatim.openstreetmap.org/search?format=json&limit=8&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (mine !== seq) return;
          found = j || [];
          showHits(found);
        })
        .catch(function () { if (mine === seq) note('search unavailable'); });
    }
    field.addEventListener('input', function () {
      var q = field.value.trim();
      clearTimeout(searchT);
      if (q.length < 3) { seq++; hideHits(); return; }
      searchT = setTimeout(function () { run(q); }, 450);
    });
    field.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchT);
        if (found.length) take(found[0]);
        else if (field.value.trim().length >= 3) run(field.value.trim());
      } else if (e.key === 'Escape' && !hits.hidden) {
        e.stopPropagation();
        hideHits();
      }
    });
    hits.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-hit]');
      if (b) take(found[+b.dataset.hit]);
    });
    // Opening animates, so closing has to as well, or the card vanishes on a
    // frame and reads as a glitch rather than a dismissal.
    var closing = false;
    function close() {
      if (closing) return;
      closing = true;
      host.classList.add('closing');
      var done = function () { host.remove(); };
      var card = host.querySelector('.map-card');
      card.addEventListener('animationend', done, { once: true });
      setTimeout(done, 320);          // never leave it stuck if the animation is off
    }
    host.addEventListener('click', function (e) {
      // closest, not the target itself: a click on the X lands on the svg or
      // its path, whose id is not mapClose, so a direct id check missed it.
      if (e.target.closest('#mapClose') || e.target.closest('[data-close]')) close();
    });
    host.querySelector('#mapUse').addEventListener('click', function () {
      var c = centre();
      onPick(+c.lat.toFixed(5), +c.lon.toFixed(5));
      close();
    });
    // Draw straight away rather than waiting on a frame: rAF is throttled
    // when the tab is not foregrounded, and a map that stays blank until
    // you touch it reads as broken. The timeout catches the case where
    // layout has not settled on the first call.
    draw();
    setTimeout(draw, 0);
    window.addEventListener('resize', draw);
  }

  function archiveConfiguredState(state) {
    return !!(state && state.installed && state.dependencies && state.dependencies.rclone
      && state.dependencies.sqlite3 && state.remote && state.remote.configured);
  }

  function archiveSettingsRow(initialState) {
    var configured = archiveConfiguredState(initialState);
    var enabled = configured && initialState.timer && initialState.timer.enabled === 'enabled';
    var remoteName = initialState && initialState.remote && initialState.remote.name || 'gdrive';
    var archiveDetails = 'Back up completed days to Google Drive. Before first use, run rclone config on the Pi, name the remote '
      + adminEsc(remoteName) + ', choose drive.file, then return here and use the button beside the command.';
    return ''
      + '<div class="archive-settings-control" data-archive-control aria-busy="' + (initialState ? 'false' : 'true') + '">'
      + '  <div class="menu-row archive-settings-head">'
      + '    <div class="access-copy"><span class="label">Nightly Drive backup</span>'
      + settingsInfoMarkup('archiveBackupTip', 'About Nightly Drive backup', archiveDetails)
      + '    </div>'
      + '    <div class="archive-settings-head-actions">'
      + '      <button type="button" class="settings-disclosure" data-archive-disclosure aria-controls="archiveSettingsDetails" aria-expanded="' + (enabled ? 'true' : 'false') + '">details</button>'
      + '      <button type="button" class="switch" role="switch" data-archive-toggle aria-label="Nightly Drive backup" aria-describedby="archiveBackupTip" aria-checked="' + (enabled ? 'true' : 'false') + '"></button>'
      + '    </div>'
      + '  </div>'
      + '  <div id="archiveSettingsDetails" class="birdweather-details-shell archive-details-shell" data-archive-details-shell'
      + '    data-open="' + (enabled ? 'true' : 'false') + '" data-settled="' + (enabled ? 'true' : 'false') + '"'
      + '    aria-hidden="' + (enabled ? 'false' : 'true') + '"' + (enabled ? '' : ' hidden inert') + '>'
      + '    <div class="archive-settings-details" data-archive-details></div>'
      + '  </div>'
      + '</div>';
  }

  function wireArchiveControl(scope, initialState) {
    var control = scope.querySelector('[data-archive-control]');
    if (!control) return;
    var mainSwitch = control.querySelector('[data-archive-toggle]');
    var disclosure = control.querySelector('[data-archive-disclosure]');
    var detailsShell = control.querySelector('[data-archive-details-shell]');
    var details = control.querySelector('[data-archive-details]');
    var archiveState = initialState && initialState.ok ? initialState : null;
    var archiveFailureKind = initialState && initialState.failure_kind || '';
    var archiveNotice = initialState && initialState.error || '';
    var archiveNoticeAction = archiveNotice ? 'refresh' : '';
    var archiveNoticeError = !!archiveNotice;
    var archiveOpen = !!(archiveState && archiveState.timer && archiveState.timer.enabled === 'enabled');
    var archiveBusy = false;
    var archiveBusyAction = '';
    var archiveSequence = 0;
    var transitionTimer = 0;

    function archiveApi(action, confirmValue) {
      var body = { action: action };
      if (confirmValue) body.confirm = confirmValue;
      return adminFetch('./avian/api/archive.php', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
        body: JSON.stringify(body),
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (result) {
          if (!response.ok || !result.ok) throw new Error(result.error || (response.ok ? 'archive controls unavailable' : ('HTTP ' + response.status)));
          return result;
        });
      });
    }

    function saveArchiveRetention(values) {
      return adminFetch('./avian/api/config.php', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
        body: JSON.stringify(values),
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (result) {
          if (!response.ok || !result.ok) throw new Error(result.error || 'could not save recording retention');
          return result;
        });
      });
    }

    function retentionControls(preserve, fullDisk, disabled) {
      var preserveSwitch = scope.querySelector('.switch[data-key="preserve"]');
      var fullDiskSeg = scope.querySelector('.seg[data-key="FULL_DISK"]');
      if (preserveSwitch) {
        if (typeof preserve === 'boolean') preserveSwitch.setAttribute('aria-checked', preserve ? 'true' : 'false');
        preserveSwitch.disabled = !!disabled;
      }
      if (fullDiskSeg) {
        if (fullDisk) {
          fullDiskSeg.querySelectorAll('button').forEach(function (button) {
            button.setAttribute('aria-current', button.dataset.v === fullDisk ? 'true' : 'false');
          });
          syncPill(fullDiskSeg);
        }
        fullDiskSeg.querySelectorAll('button').forEach(function (button) { button.disabled = !!disabled; });
      }
    }

    function prepareArchiveRetention() {
      return flushPendingSettings().then(function (saved) {
        if (!saved) throw new Error('could not finish saving current settings');
        return adminFetch('./avian/api/config.php', { credentials: 'same-origin', cache: 'no-store' });
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (result) {
          if (!response.ok) throw new Error(result.error || 'could not read recording retention');
          var previous = {
            MAX_FILES_SPECIES: result.values && Number.isFinite(+result.values.MAX_FILES_SPECIES)
              ? +result.values.MAX_FILES_SPECIES : 0,
            FULL_DISK: result.values && result.values.FULL_DISK || 'purge',
          };
          return saveArchiveRetention({ preserve: true, FULL_DISK: 'keep' }).then(function () {
            delete pending.preserve;
            delete pending.FULL_DISK;
            retentionControls(true, 'keep', true);
            return previous;
          });
        });
      });
    }

    function archiveCode(command) {
      return '<div class="code" role="button" tabindex="0" title="click to copy" aria-label="copy command">'
        + '<span class="copy" aria-hidden="true">' + ICON_COPY + '</span>'
        + '<pre>' + adminEsc(command) + '</pre>'
        + '</div>';
    }

    function archiveToggle(label, on, action, disabled, disabledTitle) {
      return '<div class="archive-control-row">'
        + '<span class="archive-label">' + adminEsc(label) + '</span>'
        + '<button type="button" class="switch" role="switch" aria-label="' + adminEsc(label) + '"'
        + ' aria-checked="' + (on ? 'true' : 'false') + '" data-archive-action="' + action + '"'
        + (disabled && disabledTitle ? ' title="' + adminAttr(disabledTitle) + '"' : '')
        + (disabled ? ' disabled' : '') + '></button>'
        + '</div>';
    }

    function archiveActionRow(button, action) {
      return '<div class="archive-action-row">' + button
        + (archiveNotice && archiveNoticeAction === action
          ? '<span class="archive-inline-state' + (archiveNoticeError ? ' is-error' : '') + '">' + adminEsc(archiveNotice) + '</span>'
          : '')
        + '</div>';
    }

    function archiveDetail(state) {
      var configured = archiveConfiguredState(state);
      if (!configured && !archiveOpen) return '';
      var inner = '<div class="archive-detail' + (configured ? ' is-controls' : '') + '">';
      if (!state) {
        if (archiveFailureKind === 'helper') {
          inner += '<p>Refresh the archive helper after updating.</p>'
            + archiveCode('cd ~/BirdNET-Pi && ./scripts/install_services.sh')
            + (archiveNotice ? '<div class="archive-command-error">' + adminEsc(archiveNotice) + '</div>' : '');
        } else {
          inner += '<p>Could not reach this station.</p>'
            + archiveActionRow('<button type="button" class="archive-button quiet" data-archive-action="refresh">try again</button>', 'network-retry')
            + (archiveNotice ? '<div class="archive-command-error">' + adminEsc(archiveNotice) + '</div>' : '');
        }
      } else if (!state.dependencies || !state.dependencies.rclone || !state.dependencies.sqlite3) {
        inner += '<p>Install rclone and sqlite3.</p>'
          + archiveCode('sudo apt install rclone sqlite3')
          + archiveActionRow('<button type="button" class="archive-button quiet" data-archive-action="refresh"'
            + (archiveBusy ? ' disabled' : '') + '>check again</button>', 'refresh');
      } else if (!state.remote || !state.remote.configured) {
        var setupAction = state.installed ? 'refresh' : 'install';
        var setupLabel = state.installed ? 'check again'
          : (archiveBusyAction === 'install' ? 'setting up...' : 'set up archive');
        inner += '<div class="archive-setup-row">'
          + '<div class="archive-setup-command">'
          + archiveCode('rclone config')
          + '</div>'
          + '<button type="button" class="archive-setup-button" data-archive-action="' + setupAction + '"'
          + (archiveBusy ? ' disabled' : '') + '>' + setupLabel + '</button>'
          + (archiveNotice && archiveNoticeAction === setupAction
            ? '<span class="archive-inline-state' + (archiveNoticeError ? ' is-error' : '') + '">' + adminEsc(archiveNotice) + '</span>'
            : '')
          + '</div>';
      } else if (!state.installed) {
        inner += '<div class="archive-setup-row is-action-only">'
          + '<button type="button" class="archive-setup-button" data-archive-action="install"'
          + (archiveBusy ? ' disabled' : '') + '>'
          + (archiveBusyAction === 'install' ? 'setting up...' : 'set up archive') + '</button>'
          + (archiveNotice && archiveNoticeAction === 'install'
            ? '<span class="archive-inline-state' + (archiveNoticeError ? ' is-error' : '') + '">' + adminEsc(archiveNotice) + '</span>'
            : '')
          + '</div>';
      } else {
        var enabled = state.timer && state.timer.enabled === 'enabled';
        var running = state.service && (state.service.active === 'active' || state.service.active === 'activating');
        inner += '<div class="archive-run-row">'
          + '<button type="button" class="archive-button quiet archive-run-button" data-archive-action="run"'
          + (running || archiveBusy ? ' disabled' : '') + '>' + (running ? 'running...' : 'run now') + '</button>'
          + '</div>';
        var canPurge = state.last && state.last.state === 'OK' && state.last.verified_files > 0;
        if (enabled) {
          inner += archiveToggle('Clear verified local files', !!state.purge,
            state.purge ? 'purge-off' : 'purge-on', archiveBusy || running || !canPurge,
            'Run the archive once before enabling local cleanup.');
        }
        if (archiveNoticeError) inner += '<div class="archive-command-error">' + adminEsc(archiveNotice) + '</div>';
      }
      return inner + '</div>';
    }

    function detailsAreOpen() {
      return detailsShell.getAttribute('data-open') === 'true';
    }
    function finishOpen() {
      if (detailsAreOpen()) detailsShell.setAttribute('data-settled', 'true');
    }
    function finishClose() {
      if (detailsAreOpen()) return;
      detailsShell.hidden = true;
      detailsShell.setAttribute('data-settled', 'false');
    }
    function openDetails(open) {
      clearTimeout(transitionTimer);
      archiveOpen = open;
      detailsShell.setAttribute('data-settled', 'false');
      if (open) {
        detailsShell.hidden = false;
        detailsShell.inert = false;
        detailsShell.setAttribute('aria-hidden', 'false');
        void detailsShell.offsetHeight;
        detailsShell.setAttribute('data-open', 'true');
        transitionTimer = setTimeout(finishOpen, 230);
      } else {
        detailsShell.setAttribute('data-open', 'false');
        detailsShell.setAttribute('aria-hidden', 'true');
        detailsShell.inert = true;
        transitionTimer = setTimeout(finishClose, 180);
      }
      disclosure.setAttribute('aria-expanded', open ? 'true' : 'false');
      paintArchive();
    }

    detailsShell.addEventListener('transitionend', function (event) {
      if (event.target !== detailsShell || event.propertyName !== 'grid-template-rows') return;
      clearTimeout(transitionTimer);
      if (detailsAreOpen()) finishOpen();
      else finishClose();
    });

    function paintArchive() {
      var configured = archiveConfiguredState(archiveState);
      var enabled = configured && archiveState.timer && archiveState.timer.enabled === 'enabled';
      control.setAttribute('aria-busy', archiveBusy ? 'true' : 'false');
      mainSwitch.disabled = archiveBusy;
      mainSwitch.setAttribute('aria-checked', enabled ? 'true' : 'false');
      details.innerHTML = archiveDetail(archiveState);
      retentionControls(null, null, archiveBusy || enabled);
    }

    function loadArchiveStatus() {
      var request = ++archiveSequence;
      return adminFetch('./avian/api/archive.php', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (result) {
            if (request !== archiveSequence) return;
            if (!response.ok || !result.ok) {
              var error = new Error(result.error || (response.ok ? 'archive controls unavailable' : ('HTTP ' + response.status)));
              error.archiveKind = response.status === 503 && result.hint ? 'helper' : 'request';
              throw error;
            }
            archiveState = result;
            archiveFailureKind = '';
            if (archiveNoticeAction === 'run' && archiveNotice === 'started'
              && (!result.service || (result.service.active !== 'active' && result.service.active !== 'activating'))
              && result.last && result.last.state !== 'never') {
              archiveNotice = '';
              archiveNoticeAction = '';
            }
            paintArchive();
          });
        }).catch(function (error) {
          if (request !== archiveSequence || adminAuthCancelled(error)) return;
          archiveState = null;
          archiveFailureKind = error.archiveKind || 'network';
          archiveNoticeAction = 'refresh';
          archiveNotice = error.message || 'archive controls unavailable';
          archiveNoticeError = true;
          paintArchive();
        });
    }

    function performArchiveAction(action) {
      if (archiveBusy) return;
      if (action === 'purge-on'
        && !confirm('Clear local recordings only after each file is copied and checksum-verified? Today always stays on this Pi.')) return;
      archiveBusy = true;
      archiveBusyAction = action;
      archiveNoticeAction = action;
      archiveNoticeError = false;
      archiveNotice = action === 'run' ? 'starting...'
        : action === 'install' ? 'installing...'
          : action === 'enable' ? 'enabling...'
            : action === 'disable' ? 'disabling...'
              : 'saving...';
      paintArchive();
      var prepared = action === 'enable' || action === 'run';
      var timerWasEnabled = !!(archiveState && archiveState.timer && archiveState.timer.enabled === 'enabled');
      var previousRetention = null;
      var work = prepared
        ? prepareArchiveRetention().then(function (previous) {
          previousRetention = previous;
          return archiveApi(action);
        }).catch(function (error) {
          if (!previousRetention || (action === 'run' && timerWasEnabled)) throw error;
          return saveArchiveRetention(previousRetention).then(function () {
            retentionControls(previousRetention.MAX_FILES_SPECIES >= 10000, previousRetention.FULL_DISK, false);
            throw error;
          });
        })
        : archiveApi(action, action === 'purge-on' ? 'verified-local-files' : '');
      work.then(function (result) {
        archiveState = result;
        archiveNotice = action === 'run' ? 'started'
          : action === 'install' ? 'installed'
            : action === 'enable' ? 'enabled'
              : action === 'disable' ? 'disabled' : 'saved';
        archiveNoticeError = false;
        if (action === 'enable' || action === 'install' || action === 'run') archiveOpen = true;
        if (action === 'disable') archiveOpen = false;
      }).catch(function (error) {
        if (adminAuthCancelled(error)) return;
        archiveNotice = error.message || 'archive action failed';
        archiveNoticeError = true;
      }).then(function () {
        archiveBusy = false;
        archiveBusyAction = '';
        if (archiveOpen !== detailsAreOpen()) openDetails(archiveOpen);
        else paintArchive();
        return loadArchiveStatus();
      });
    }

    function copyArchiveCode(box) {
      var pre = box && box.querySelector('pre');
      var tag = box && box.querySelector('.copy');
      if (!pre || !tag) return;
      adminCopyText(pre.textContent).then(function () {
        tag.innerHTML = ICON_CHECK;
        box.setAttribute('data-copied', '1');
        setTimeout(function () { tag.innerHTML = ICON_COPY; box.removeAttribute('data-copied'); }, 1400);
      }).catch(function () { box.setAttribute('data-copy-error', '1'); });
    }

    disclosure.addEventListener('click', function () { openDetails(!detailsAreOpen()); });
    mainSwitch.addEventListener('click', function () {
      if (archiveBusy) return;
      if (!archiveConfiguredState(archiveState)) {
        openDetails(true);
        return;
      }
      var enabled = archiveState.timer && archiveState.timer.enabled === 'enabled';
      if (!enabled) openDetails(true);
      performArchiveAction(enabled ? 'disable' : 'enable');
    });
    control.addEventListener('click', function (event) {
      var code = event.target.closest('.code');
      if (code) { copyArchiveCode(code); return; }
      var button = event.target.closest('[data-archive-action]');
      if (!button || button.disabled) return;
      var action = button.dataset.archiveAction;
      if (action === 'refresh') {
        archiveBusy = true;
        archiveBusyAction = 'refresh';
        archiveNoticeAction = 'refresh';
        archiveNotice = 'checking...';
        archiveNoticeError = false;
        paintArchive();
        loadArchiveStatus().then(function () {
          archiveBusy = false;
          archiveBusyAction = '';
          if (archiveState) archiveNotice = '';
          paintArchive();
        });
        return;
      }
      performArchiveAction(action);
    });
    control.addEventListener('keydown', function (event) {
      var code = event.target.closest('.code');
      if (code && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        copyArchiveCode(code);
      }
    });

    paintArchive();
    adminPollT = setInterval(loadArchiveStatus, 10000);
  }

  function renderAdminSettings() {
    if (settingsInfoCleanup) settingsInfoCleanup();
    if (settingsAccessCleanup) settingsAccessCleanup();
    adminBody.innerHTML = '<p style="font:11px ui-monospace,monospace;color:var(--ink-soft);text-align:center">loading settings...</p>';
    Promise.all([
      adminFetch('./avian/api/config.php', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }),
      adminJson('./avian/api/generate.php?action=status').catch(function (error) {
        if (adminAuthCancelled(error)) throw error;
        return null;
      }),
      adminFetch('./avian/api/birdweather.php', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (body) {
            return r.ok && body.ok ? body : { ok: false };
          });
        }).catch(function (error) {
          if (adminAuthCancelled(error)) throw error;
          return { ok: false };
        }),
      adminFetch('./avian/api/archive.php', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            if (response.ok && body.ok) return body;
            return {
              ok: false,
              error: body.error || 'archive controls unavailable',
              failure_kind: response.status === 503 && body.hint ? 'helper' : 'request',
            };
          });
        }).catch(function (error) {
          if (adminAuthCancelled(error)) throw error;
          return { ok: false, error: 'archive controls unavailable', failure_kind: 'network' };
        }),
    ])
      .then(function (parts) {
        var cfg = parts[0];
        var gen = parts[1] || {};
        var birdweather = parts[2] || { ok: false };
        var archive = parts[3] || { ok: false, failure_kind: 'network' };
        var v = cfg.values || {};
        var sec = cfg.secrets || {};
        var security = cfg.security || {};
        var preserve = cfg.preserve;
        // Instant chroma cutouts awaiting the full-quality workstation
        // pass: surface the count and a ready-to-paste command. The
        // command carries this station's hostname; only the ssh user is
        // left for the owner to fill in.
        var cutoutsNote = '';
        if (gen.chroma > 0) {
          var cmd = 'curl -sLO https://raw.githubusercontent.com/Twarner491/AvianVisitors/avian-visitors/avian/scripts/upgrade_cutouts.py'
            + ' && python3 upgrade_cutouts.py --pi pi-user@' + location.hostname;
          cutoutsNote = ''
            + '<div class="cutouts-note" id="cutoutsNote">'
            + '  <div><span class="label">Instant cutouts <i class="notif-dot"></i></span>'
            + '  <span class="hint">' + gen.chroma + ' bird' + (gen.chroma === 1 ? '' : 's') + ' cut on the Pi with the quick method. '
            + 'For full-quality edges, run this on your computer (swap in your ssh user):</span></div>'
            + '  <code class="cutcmd" id="cutCmd">' + cmd + '</code>'
            + '  <button type="button" class="chip" id="cutCopy">copy command</button>'
            + '</div>';
        }
        adminBody.innerHTML =
          '<div class="admin-settings">'
          + '<section>'
          + themeRow()
          + labelsRow()
          + settingsSegmented('COLLAGE_LABELS', 'Bird names', 'the station default: every device set to site, and every frame rendered from this station', v.COLLAGE_LABELS || 'on', [
            { v: 'off', label: 'off' },
            { v: 'on', label: 'on' },
          ])
          + atlasAlwaysAllRow()
          + atlasClassicRow()
          + settingsText('SITE_NAME', 'Station name', v.SITE_NAME || 'BirdNET-Pi', 60)
          + '</section><section>'
          + settingsSlider('CONFIDENCE', 'Confidence threshold', 'min score to log a detection', v.CONFIDENCE, 0.1, 0.95, 0.05, 2, 0.7)
          + settingsSlider('SF_THRESH', 'Range filter', 'min likelihood a species is here this week', v.SF_THRESH, 0.001, 0.5, 0.001, 3, 0.03)
          + settingsSlider('SENSITIVITY', 'Sensitivity', 'sigmoid slope on the classifier output', v.SENSITIVITY, 0.5, 1.5, 0.05, 2, 1.25)
          + settingsSlider('OVERLAP', 'Chunk overlap', 'seconds re-analyzed per pass', v.OVERLAP, 0, 2.5, 0.1, 1, 0.0)
          + '</section><section>'
          + stationRow(v)
          + settingsSecret('GEMINI_API_KEY', 'Gemini API key', 'for drawing birds on demand', sec.GEMINI_API_KEY)
          + settingsSecret('EBIRD_API_KEY', 'eBird API key', 'for regional species filters', sec.EBIRD_API_KEY)
          + '</section><section class="settings-retention">'
          + lanAuthRow(security)
          + birdweatherRow(birdweather)
          + archiveSettingsRow(archive)
          + settingsToggle('preserve', 'Preserve all recordings', "don't auto-delete", preserve)
          + settingsSegmented('FULL_DISK', 'When disk fills', '', v.FULL_DISK, [
            { v: 'keep', label: 'keep' },
            { v: 'purge', label: 'purge' },
          ])
          + '</section>'
          + cutoutsNote
          + '<div class="menu-save-row">'
          + '  <span class="save-state" id="saveState"></span>'
          + '</div>'
          + '</div>';
        var cutCopy = document.getElementById('cutCopy');
        if (cutCopy) cutCopy.addEventListener('click', function () {
          var t = document.getElementById('cutCmd').textContent;
          adminCopyText(t).then(function () {
            cutCopy.textContent = 'copied';
            setTimeout(function () { cutCopy.textContent = 'copy command'; }, 1600);
          }).catch(function () { cutCopy.textContent = 'copy failed'; });
        });
        var pin = document.getElementById('stationEdit');
        if (pin) pin.addEventListener('click', function () {
          openStationPicker(+v.LATITUDE || 0, +v.LONGITUDE || 0, function (la, lo) {
            pending.LATITUDE = la; pending.LONGITUDE = lo;
            var el = document.getElementById('stationCoords');
            if (el) { el.textContent = la.toFixed(4) + ', ' + lo.toFixed(4); el.classList.remove('warn'); }
            queueSave(400);
          });
        });
        wireSettingsControls(adminBody);
        wireLanAuthControl(adminBody, security);
        wirePasswordChange(adminBody);
        wireSettingsAccessDismissal(adminBody);
        wireBirdweatherControl(adminBody, birdweather);
        wireArchiveControl(adminBody, archive);
        wireSettingsInfo(adminBody);
        if (pendingAdminNotice) {
          var noticeTarget = adminBody.querySelector('[data-lan-auth-status]');
          if (noticeTarget) {
            noticeTarget.textContent = pendingAdminNotice.message;
            noticeTarget.classList.toggle('err', !!pendingAdminNotice.error);
            pendingAdminNotice = null;
          }
        }
        adminBody.querySelectorAll('.seg').forEach(wireToggleAdvance);   // open-space advance
        // Slide each pill onto its current option (fonts settle first,
        // otherwise the measured button width is the fallback face's).
        function syncSettingsPills() { adminBody.querySelectorAll('.seg').forEach(syncPill); }
        syncSettingsPills();
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncSettingsPills);
        adminBody.addEventListener('click', function (ev) {
          if (ev.target.closest('.seg')) requestAnimationFrame(syncSettingsPills);
        });
        // Theme switcher applies + persists immediately (separate from the
        // Pi config save below).
        var themeSeg = adminBody.querySelector('[data-theme-seg]');
        if (themeSeg) themeSeg.addEventListener('click', function (ev) {
          var b = ev.target.closest('button[data-theme]');
          if (!b) return;
          applyTheme(b.getAttribute('data-theme'));
          [].forEach.call(themeSeg.querySelectorAll('button'), function (x) {
            x.setAttribute('aria-current', x === b ? 'true' : 'false');
          });
        });
        // Labels switcher applies + persists immediately too. The second
        // render after the handwriting face loads swaps the measured
        // fallback metrics for the real ones.
        var labelsSeg = adminBody.querySelector('[data-labels-seg]');
        if (labelsSeg) labelsSeg.addEventListener('click', function (ev) {
          var b = ev.target.closest('button[data-labels]');
          if (!b) return;
          var chosen = b.getAttribute('data-labels');
          writeLS('bird:labels', (chosen === 'on' || chosen === 'off') ? chosen : 'site');
          [].forEach.call(labelsSeg.querySelectorAll('button'), function (x) {
            x.setAttribute('aria-current', x === b ? 'true' : 'false');
          });
          if (document.fonts && document.fonts.load) {
            document.fonts.load('600 16px Hand').then(function () {
              labelFontReady = true; renderCollageFromData();
            }).catch(function () { labelFontReady = true; renderCollageFromData(); });
          } else {
            labelFontReady = true; renderCollageFromData();
          }
        });
        // Atlas-only preference: apply immediately without touching the
        // shared time picker or sending a station settings request.
        var atlasAllSwitch = adminBody.querySelector('[data-atlas-always-all]');
        if (atlasAllSwitch) atlasAllSwitch.addEventListener('click', function () {
          applyAtlasAlwaysAll(atlasAllSwitch.getAttribute('aria-checked') !== 'true');
        });
        var atlasClassicSwitch = adminBody.querySelector('[data-atlas-classic]');
        if (atlasClassicSwitch) atlasClassicSwitch.addEventListener('click', function () {
          applyAtlasStyle(atlasClassicSwitch.getAttribute('aria-checked') !== 'true');
        });
      })
      .catch(function (err) {
        if (adminAuthCancelled(err)) return;
        adminBody.innerHTML = adminUnreachableHtml('settings load failed (' + err + ')');
      });
  }

  function renderAdminSystem() {
    adminBody.innerHTML = '<p style="font:11px ui-monospace,monospace;color:var(--ink-soft);text-align:center">loading...</p>';
    var sequence = 0;
    function tick() {
      var request = ++sequence;
      adminApi('./avian/api/birdnet-status.php?action=diag')
        .then(function (r) { return r.text().then(function (raw) { return { status: r.status, raw: raw }; }); })
        .then(function (res) {
          if (request !== sequence) return;
          var j = null;
          try { j = JSON.parse(res.raw); } catch (e) { }
          if (res.status !== 200 || !j) {
            adminBody.innerHTML = adminUnreachableHtml(
              !j ? 'birdnet-status.php not installed on the pi' : (j.error || 'HTTP ' + res.status)
            );
            return;
          }
          adminBody.innerHTML = adminSystemMarkup(j);
          wireAdminRestarts();
        })
        .catch(function (e) {
          if (request !== sequence) return;
          if (adminAuthCancelled(e)) return;
          adminBody.innerHTML = adminUnreachableHtml(e.message);
        });
    }
    tick();
    adminPollT = setInterval(tick, 6000);
  }
  function adminSystemMarkup(j) {
    var sys = j.system || {}, svc = j.services || {}, recLogs = j.recent_logs || {};
    var stream = sys.stream_data || {}, db = sys.birds_db || {};
    var streamAlert = !stream.exists || stream.newest_age_s == null || stream.newest_age_s > 600;
    var dbAlert = db.exists && db.modified_s > 3600;
    var keySvcs = ['birdnet_recording', 'birdnet_analysis', 'birdnet_log'];
    var dead = keySvcs.filter(function (n) { return svc[n] && svc[n].active !== 'active'; });
    var html = '<div class="admin-grid">';
    html += adminCard('recording pipeline', dead.length === 0 ? 'live' : (dead.length + ' down'),
      dead.length === 0 ? 'all services active' : dead.join(', '),
      dead.length === 0 ? '' : 'alert', 'pipeline');
    html += adminCard('newest live audio',
      stream.newest_age_s == null ? 'no chunks' : adminFmtAge(stream.newest_age_s) + ' ago',
      stream.newest_name || '',
      streamAlert ? 'alert' : '', 'audio');
    html += adminCard('birds.db updated',
      db.exists ? adminFmtAge(db.modified_s) + ' ago' : 'missing',
      db.mtime || '',
      dbAlert ? 'warn' : '', 'db');
    html += adminCard('uptime', (sys.uptime || {}).pretty || '-',
      'load ' + ((sys.uptime || {}).load || []).map(function (n) { return n.toFixed(2); }).join(' / '),
      '', 'clock');
    html += adminCard('cpu temp',
      sys.temp_c != null ? sys.temp_c.toFixed(1) + '°C' : '-',
      sys.hostname + ' - ' + sys.kernel,
      sys.temp_c != null && sys.temp_c > 75 ? 'warn' : '', 'temp');
    html += adminCard('memory used', sys.mem ? sys.mem.used_pct + '%' : '-',
      sys.mem ? adminFmtBytes(sys.mem.used_bytes) + ' / ' + adminFmtBytes(sys.mem.total_bytes) : '',
      sys.mem && sys.mem.used_pct > 92 ? 'warn' : '', 'mem');
    html += adminCard('disk (birdsongs)', sys.disk_birds ? sys.disk_birds.used_pct + '%' : '-',
      sys.disk_birds ? adminFmtBytes(sys.disk_birds.total_bytes - sys.disk_birds.free_bytes) + ' / ' + adminFmtBytes(sys.disk_birds.total_bytes) : '',
      sys.disk_birds && sys.disk_birds.used_pct > 92 ? 'warn' : '', 'disk');
    var audio = sys.audio || {}, cards = audio.arecord_l || [];
    var mic = cards.find ? cards.find(function (c) { return /usb-audio|microphone|mic/i.test(c); }) : null;
    // Without a USB mic, /proc/asound/cards only lists the Pi's HDMI
    // audio outputs - which aren't an input source. Flag that clearly
    // rather than showing "audio device: vc4hdmi0" as if it were a mic.
    html += adminCard('audio device',
      mic || (cards.length ? 'no microphone attached' : 'no audio devices'),
      mic ? '' : (cards[0] || ''),
      mic ? '' : 'warn', 'mic');
    html += '</div>';

    html += '<h2 class="admin-section-head">services</h2>';
    html += '<table class="admin-tbl"><thead><tr><th>unit</th><th>state</th><th>enabled</th><th>since</th><th></th></tr></thead><tbody>';
    Object.keys(svc).forEach(function (name) {
      var s = svc[name];
      var pill = (s.active === 'active') ? 'active' : (s.active === 'failed' ? 'failed' : 'inactive');
      html += '<tr>'
        + '<td>' + adminEsc(name) + '</td>'
        + '<td><span class="pill ' + pill + '">' + adminEsc(s.active) + '</span></td>'
        + '<td>' + adminEsc(s.enabled) + '</td>'
        + '<td>' + adminEsc(s.since || '-') + '</td>'
        + '<td>' + (s.restartable
          ? '<button class="restart" data-unit="' + adminEsc(name) + '">restart</button>'
          : '<span class="muted">status only</span>') + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>';

    var conf = (sys.conf || {}).values || {};
    var rows = Object.keys(conf).map(function (k) {
      return '<tr><td>' + adminEsc(k) + '</td><td>' + adminEsc(conf[k]) + '</td></tr>';
    }).join('');
    if (rows) {
      html += '<h2 class="admin-section-head">birdnet.conf</h2>';
      html += '<table class="admin-tbl"><tbody>' + rows + '</tbody></table>';
    }
    if (Object.keys(recLogs).length) {
      html += '<h2 class="admin-section-head">recent journal</h2>';
      Object.keys(recLogs).forEach(function (u) {
        html += '<h3 style="font:9.5px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin:12px 0 6px">' + adminEsc(u) + '</h3>';
        html += '<div class="admin-logs-pane">' + adminEsc(recLogs[u] || '(empty)') + '</div>';
      });
    }
    return html;
  }
  function wireAdminRestarts() {
    adminBody.querySelectorAll('button.restart').forEach(function (b) {
      b.addEventListener('click', function () {
        var unit = b.dataset.unit;
        if (!confirm('Restart ' + unit + '?')) return;
        var requestView = adminViewGeneration;
        var requestSection = adminSect;
        b.disabled = true; var old = b.textContent; b.textContent = '...';
        adminFetch('./avian/api/birdnet-status.php?action=restart&unit=' + encodeURIComponent(unit), {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
          body: '{}',
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            b.textContent = j.ok ? 'ok' : 'fail';
            setTimeout(function () {
              if (requestView !== adminViewGeneration
                || requestSection !== adminSect
                || requestSection !== 'system') return;
              b.disabled = false;
              b.textContent = old;
              renderAdminSystem();
            }, 1200);
          })
          .catch(function (error) {
            if (adminAuthCancelled(error)) return;
            b.textContent = 'err';
            b.disabled = false;
            setTimeout(function () { b.textContent = old; }, 1500);
          });
      });
    });
  }

  function renderAdminLogs() {
    var unit = 'birdnet_recording', lines = 120, autoScroll = true;
    var sequence = 0;
    adminBody.innerHTML =
      '<div class="admin-logs-toolbar">'
      + '  <label>unit</label><select id="adminLogsUnit">'
      // php-fpm unit name differs per Debian version (8.2 on Bookworm,
      // 8.4 on Trixie). List all three so the dropdown has the right one
      // regardless of host - birdnet-status.php's ALLOWED_UNITS already
      // skips ones systemd doesn't know about.
      + ['birdnet_recording', 'birdnet_analysis', 'birdnet_log', 'birdnet_stats', 'spectrogram_viewer', 'livestream', 'icecast2', 'caddy', 'php8.4-fpm', 'php8.3-fpm', 'php8.2-fpm']
        .map(function (u) { return '<option value="' + u + '">' + u + '</option>'; }).join('')
      + '  </select>'
      + '  <label>lines</label><input id="adminLogsLines" type="number" value="120" min="20" max="500" step="20">'
      + '</div>'
      + '<div class="admin-logs-pane" id="adminLogsOut">loading...</div>';
    var pane = document.getElementById('adminLogsOut');
    var sel = document.getElementById('adminLogsUnit');
    var linesIn = document.getElementById('adminLogsLines');
    sel.addEventListener('change', function () { unit = sel.value; tick(); });
    linesIn.addEventListener('change', function () { lines = +linesIn.value || 120; tick(); });
    pane.addEventListener('scroll', function () {
      autoScroll = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 20;
    });
    function tick() {
      var request = ++sequence;
      adminApi('./avian/api/birdnet-status.php?action=logs&unit=' + encodeURIComponent(unit) + '&lines=' + lines)
        .then(function (r) { return r.text().then(function (raw) { return { status: r.status, raw: raw }; }); })
        .then(function (res) {
          if (request !== sequence) return;
          var j = null;
          try { j = JSON.parse(res.raw); } catch (e) { }
          if (res.status !== 200 || !j) {
            pane.textContent = 'pi unreachable - ' + (j && j.error ? j.error : 'no data');
            return;
          }
          pane.textContent = sudoBlocked(j.text) ? SUDO_HINT : (j.text || '(empty)');
          if (autoScroll) pane.scrollTop = pane.scrollHeight;
        }).catch(function (error) {
          if (request !== sequence) return;
          if (adminAuthCancelled(error)) return;
          pane.textContent = 'pi unreachable - ' + (error.message || 'no data');
        });
    }
    tick();
    adminPollT = setInterval(tick, 4000);
  }

  // Six services in one row. The whole card is the control: a run button
  // beside a one-line description was more chrome than the action deserved.
  var TOOL_ICONS = {
    birdnet_recording: '<path d="M12 3.5a2 2 0 0 1 2 2v5a2 2 0 0 1-4 0v-5a2 2 0 0 1 2-2z"/><path d="M7.5 10.5a4.5 4.5 0 0 0 9 0"/><path d="M12 15v2.5"/>',
    birdnet_analysis: '<path d="M3 12h2.5l2-6 3 12 2.5-9 2 3H21"/>',
    birdnet_log: '<ellipse cx="12" cy="6" rx="6.5" ry="2.5"/><path d="M5.5 6v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6"/><path d="M5.5 12v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5"/>',
    spectrogram_viewer: '<path d="M4 14v3M7.5 10v7M11 6v11M14.5 11v6M18 8v9"/>',
    livestream: '<circle cx="12" cy="12" r="1.8"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6"/><path d="M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
    icecast2: '<rect x="3.5" y="4.5" width="17" height="6" rx="1.6"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.6"/><path d="M7 7.5h.01M7 16.5h.01"/>'
  };
  function toolIcon(unit) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + TOOL_ICONS[unit] + '</svg>';
  }
  function renderAdminTools() {
    var actions = [
      ['recording', 'captures audio from the mic', 'birdnet_recording'],
      ['analysis', 'runs the model on each chunk', 'birdnet_analysis'],
      ['log', 'writes detections to the database', 'birdnet_log'],
      ['spectrogram', 'legacy live fft view', 'spectrogram_viewer'],
      ['livestream', 'feed behind the live-audio button', 'livestream'],
      ['icecast', 'serves that stream to the browser', 'icecast2'],
    ];
    var html = '<h2 class="admin-section-head">services</h2>';
    html += '<div class="tool-row">';
    actions.forEach(function (a) {
      html += '<button type="button" class="tool-card" data-unit="' + adminEsc(a[2]) + '">'
        + '<span class="badge" data-live="?"><i class="now">...</i><i class="act">restart</i></span>'
        + '<span class="ic">' + toolIcon(a[2]) + '</span>'
        + '<span class="ttl">' + adminEsc(a[0]) + '</span>'
        + '<span class="dsc">' + adminEsc(a[1]) + '</span>'
        + '<span class="state" data-out="' + adminEsc(a[2]) + '"></span>'
        + '</button>';
    });
    html += '</div>';

    html += '<h2 class="admin-section-head">update</h2>';
    html += '<div class="admin-actions-grid">';
    // The block is the button. A separate control below it was a second thing
    // to aim at for an action the block itself obviously affords.
    function deployCard(title, desc, lines, action, buttonLabel) {
      return '<div class="admin-action deploy maintenance-card" data-maintenance-card="' + action + '" aria-busy="false">'
        + '<button type="button" class="run" data-maintenance-action="' + action + '">' + adminEsc(buttonLabel) + '</button>'
        + '<h4>' + adminEsc(title) + '</h4>'
        + '<p>' + adminEsc(desc) + '</p>'
        + '<div class="code" role="button" tabindex="0" title="click to copy" aria-label="copy command">'
        + '<span class="copy" aria-hidden="true">' + ICON_COPY + '</span>'
        + '<pre>' + adminEsc(lines.join('\n')) + '</pre>'
        + '</div>'
        + '<span class="state" aria-live="polite"></span>'
        + '</div>';
    }
    html += deployCard('pull latest', 'newest code from github', [
      'cd ~/BirdNET-Pi && ./scripts/update_birdnet.sh',
    ], 'update', 'pull');
    html += deployCard('reinstall services', 'refreshes symlinks and unit files', [
      'cd ~/BirdNET-Pi && ./scripts/reinstall_services.sh',
    ], 'services', 'reinstall');
    html += '</div>';

    html += '<h2 class="admin-section-head">your data</h2>';
    html += '<div class="admin-actions-grid">';
    function dataCard(title, desc, what) {
      return '<a class="admin-action" data-admin-export data-export-scope="' + what + '" href="./avian/api/export.php?what=' + what + '" download>'
        + '<span class="run">download</span>'
        + '<h4>' + adminEsc(title) + '</h4>'
        + '<p>' + adminEsc(desc) + '</p>'
        + '</a>';
    }
    html += dataCard('detections', 'every detection as csv: date, species, confidence, file', 'detections');
    html += dataCard('recordings', 'every clip as tar, by date and species. can run to many gb', 'recordings');
    html += '</div>';
    adminBody.innerHTML = html;
    adminBody.querySelectorAll('[data-admin-export]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (!adminAuthMeta.required) return;
        event.preventDefault();
        if (link.getAttribute('aria-busy') === 'true') return;
        link.setAttribute('aria-busy', 'true');
        var scope = link.dataset.exportScope;
        adminFetch('./avian/api/menu.php?action=download-grant', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
          body: JSON.stringify({ scope: scope }),
        })
          .then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              if (!response.ok || !body.ok || !/^[a-f0-9]{48}$/.test(body.token || '')) {
                throw new Error(body.error || 'download authorization failed');
              }
              var download = document.createElement('a');
              download.href = link.href + '&grant=' + encodeURIComponent(body.token);
              download.download = '';
              download.hidden = true;
              document.body.appendChild(download);
              download.click();
              download.remove();
            });
          }).catch(function (error) {
            if (adminAuthCancelled(error)) return;
            link.setAttribute('data-error', '1');
            setTimeout(function () { link.removeAttribute('data-error'); }, 1800);
          }).then(function () {
            link.removeAttribute('aria-busy');
          });
      });
    });

    // Whether a unit is up is the first thing you want off this page, so the
    // badge carries it and the card only has to be hovered to offer the fix.
    function paintStates() {
      adminJson('./avian/api/birdnet-status.php?action=services').then(function (j) {
        var svc = (j && j.services) || {};
        adminBody.querySelectorAll('.tool-card').forEach(function (card) {
          if (card.dataset.busy) return;
          var st = svc[card.dataset.unit];
          var live = st && st.active === 'active' ? 'running'
            : st && st.active === 'inactive' ? 'stopped'
            : st ? 'error' : 'unknown';
          var b = card.querySelector('.badge');
          b.dataset.live = live;
          b.querySelector('.now').textContent = live;
        });
      }).catch(function (error) {
        if (adminAuthCancelled(error)) return;
        adminBody.querySelectorAll('.tool-card .badge').forEach(function (b) {
          b.dataset.live = 'unknown';
          b.querySelector('.now').textContent = 'unknown';
        });
      });
    }
    paintStates();

    // The card is the button, so a stray click restarts a service. The
    // confirm matters more here than it did beside a labelled run button.
    adminBody.querySelectorAll('.tool-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var unit = card.dataset.unit;
        if (card.dataset.busy) return;
        if (!confirm('restart ' + unit + '?')) return;
        card.dataset.busy = '1';
        var out = card.querySelector('.state');
        out.textContent = 'restarting...';
        card.setAttribute('data-state', 'busy');
        adminFetch('./avian/api/birdnet-status.php?action=restart&unit=' + encodeURIComponent(unit), {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
          body: '{}',
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            card.setAttribute('data-state', j.ok ? 'ok' : 'err');
            out.textContent = sudoBlocked(j.out) ? SUDO_HINT
              : (j.ok ? 'restarted' : 'failed rc=' + j.rc);
            setTimeout(function () {
              delete card.dataset.busy;
              card.removeAttribute('data-state');
              out.textContent = '';
              paintStates();
            }, 2600);
          })
          .catch(function (e) {
            if (adminAuthCancelled(e)) return;
            card.setAttribute('data-state', 'err');
            out.textContent = e.message || 'request failed';
            setTimeout(function () {
              delete card.dataset.busy;
              card.removeAttribute('data-state');
              out.textContent = '';
            }, 2600);
          });
      });
    });
    adminBody.querySelectorAll('.admin-action .code').forEach(function (box) {
      var take = function () {
        var pre = box.querySelector('pre');
        var tag = box.querySelector('.copy');
        if (!pre || !tag) return;
        adminCopyText(pre.textContent).then(function () {
          // Held visible from script rather than a hover rule: the confirmation
          // has to survive the pointer leaving, which is exactly when a hover
          // state would drop it.
          tag.innerHTML = ICON_CHECK;
          tag.style.opacity = '1';
          tag.style.color = 'var(--ink)';
          setTimeout(function () {
            tag.innerHTML = ICON_COPY;
            tag.style.opacity = '';
            tag.style.color = '';
          }, 1400);
        }).catch(function () { box.setAttribute('data-copy-error', '1'); });
      };
      box.addEventListener('click', take);
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); take(); }
      });
    });

    var maintenancePoll = null;
    function maintenanceMessage(state) {
      if (!state) return '';
      if (state.state === 'running' || state.state === 'queued') {
        return state.action === 'services' ? 'reinstalling...' : 'updating...';
      }
      if (state.state === 'complete') return state.action === 'services' ? 'reinstalled' : 'updated';
      if (state.state === 'failed') return state.detail || 'failed';
      return '';
    }
    function paintMaintenance(state) {
      adminBody.querySelectorAll('[data-maintenance-card]').forEach(function (card) {
        var active = state && state.action === card.dataset.maintenanceCard;
        var busy = active && (state.state === 'running' || state.state === 'queued');
        card.setAttribute('aria-busy', busy ? 'true' : 'false');
        var button = card.querySelector('[data-maintenance-action]');
        var out = card.querySelector('.state');
        if (button) button.disabled = !!(state && (state.state === 'running' || state.state === 'queued'));
        if (out) out.textContent = active ? maintenanceMessage(state) : '';
      });
      if (state && (state.state === 'running' || state.state === 'queued')) {
        clearTimeout(maintenancePoll);
        maintenancePoll = setTimeout(loadMaintenance, 1500);
      }
    }
    function maintenanceRequest(action) {
      return adminFetch('./avian/api/maintenance.php', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
        body: JSON.stringify({
          action: action,
          confirm: action === 'services' ? 'reinstall-services' : 'update-station',
        }),
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.ok) throw new Error(body.error || 'maintenance unavailable');
          return body;
        });
      });
    }
    function loadMaintenance() {
      return adminFetch('./avian/api/maintenance.php', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            if (!response.ok || !body.ok) throw new Error(body.error || 'maintenance unavailable');
            paintMaintenance(body);
          });
        }).catch(function (error) {
          if (!adminAuthCancelled(error) && window.console) console.warn('maintenance status failed', error);
        });
    }
    adminBody.querySelectorAll('[data-maintenance-action]').forEach(function (button) {
      button.addEventListener('click', function () {
        var action = button.dataset.maintenanceAction;
        var prompt = action === 'services'
          ? 'Reinstall service files and web links?'
          : 'Pull the latest Avian Visitors release? The update stops if tracked local code has changed.';
        if (!confirm(prompt)) return;
        var card = button.closest('[data-maintenance-card]');
        var out = card && card.querySelector('.state');
        button.disabled = true;
        if (card) card.setAttribute('aria-busy', 'true');
        if (out) out.textContent = action === 'services' ? 'reinstalling...' : 'updating...';
        maintenanceRequest(action).then(function (state) {
          paintMaintenance(state);
        }).catch(function (error) {
          if (adminAuthCancelled(error)) return;
          button.disabled = false;
          if (card) card.setAttribute('aria-busy', 'false');
          if (out) out.textContent = error.message || 'maintenance unavailable';
        });
      });
    });
    loadMaintenance();
  }

  // Initial load: if URL has a sci hash, jump to atlas, highlight, and
  // open the modal.
  if (readHash()) { go(2); highlightAtlas(readHash()); openDetailModal(readHash()); }
  // Admin overlay routing accepts only the four native admin sections.
  // screen with that sub-tab. Clearing the hash closes it.
  function readAdminHash() {
    var m = location.hash.match(/^#admin=([a-z]+)$/);
    return m && Object.prototype.hasOwnProperty.call(ADMIN_TITLES, m[1]) ? m[1] : null;
  }
  // #about - brief explainer popup; reached via /about (302 -> /#about)
  // or the masthead eyebrow. aria-hidden drives the CSS fade/slide.
  function openAbout() { document.getElementById('about-modal').setAttribute('aria-hidden', 'false'); }
  function closeAbout() { document.getElementById('about-modal').setAttribute('aria-hidden', 'true'); }
  function syncRouter() {
    window.__lastHashchange = Date.now();
    var sci = readHash();
    var adm = readAdminHash();
    if (location.hash === '#about') openAbout(); else closeAbout();
    if (adm) { openAdmin(adm); return; }
    closeAdmin();
    if (sci) { go(2); highlightAtlas(sci); openDetailModal(sci); }
    else { highlightAtlas(null); closeDetailModal(); }
  }
  if (readAdminHash()) openAdmin(readAdminHash());
  if (location.hash === '#about') openAbout();
  window.addEventListener('hashchange', syncRouter);

  // About popup: backdrop / close / explore button all carry data-close,
  // which clears the hash and routes through syncRouter -> closeAbout.
  // The masthead eyebrow opens it; Escape dismisses it.
  document.getElementById('about-modal').addEventListener('click', function (ev) {
    if (ev.target.dataset && ev.target.dataset.close === '1') {
      if (location.hash) { location.hash = ''; } else { closeAbout(); }
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' &&
      document.getElementById('about-modal').getAttribute('aria-hidden') === 'false') {
      if (location.hash) { location.hash = ''; } else { closeAbout(); }
    }
  });
  document.getElementById('aboutLink').addEventListener('click', function () {
    location.hash = '#about';
  });

  // Shared decode context for spectrogram generation. Lives once for
  // the page; lazily created on first expand to avoid bootstrapping
  // WebAudio if no one ever opens a row.
  var _specAudioCtx = null;
  function getSpecCtx() {
    if (!_specAudioCtx) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (C) _specAudioCtx = new C();
    }
    return _specAudioCtx;
  }

  // Cache decoded AudioBuffers per file so repeated expand/collapse on
  // the same row doesn't re-fetch + re-decode the mp3.
  var _decodedCache = {};

  // Minimal in-place Cooley-Tukey radix-2 FFT (n must be a power of 2).
  // Operates on parallel real/imag Float32Array buffers. ~30 lines and
  // fast enough for our ~1024-sample windows of 3-second clips.
  function _fft(real, imag) {
    var n = real.length;
    var j = 0;
    for (var i = 0; i < n - 1; i++) {
      if (i < j) {
        var tr = real[i]; real[i] = real[j]; real[j] = tr;
        var ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      var k = n >> 1;
      while (k <= j) { j -= k; k >>= 1; }
      j += k;
    }
    for (var stage = 2; stage <= n; stage *= 2) {
      var half = stage >> 1;
      var ang = -2 * Math.PI / stage;
      var wR = Math.cos(ang), wI = Math.sin(ang);
      for (var sBase = 0; sBase < n; sBase += stage) {
        var cR = 1, cI = 0;
        for (var sb = 0; sb < half; sb++) {
          var a = sBase + sb;
          var b = a + half;
          var trA = real[b] * cR - imag[b] * cI;
          var tiA = real[b] * cI + imag[b] * cR;
          real[b] = real[a] - trA;
          imag[b] = imag[a] - tiA;
          real[a] = real[a] + trA;
          imag[a] = imag[a] + tiA;
          var nR = cR * wR - cI * wI;
          cI = cR * wI + cI * wR;
          cR = nR;
        }
      }
    }
  }

  // Paint an STFT spectrogram onto the strip's canvas. y-axis is the
  // bird audible band (~200 Hz - ~10 kHz) on a mildly compressed log
  // scale; x-axis is time across the whole clip; colour is dB
  // magnitude mapped to our warm ink palette over the dark paper-ink
  // ground.
  function paintSpectrogram(canvas, audioBuffer) {
    canvas.__birdAudioBuffer = audioBuffer;
    canvas.__birdPaintToken = (canvas.__birdPaintToken || 0) + 1;
    canvas.__birdPaintRetries = 0;
    var token = canvas.__birdPaintToken;
    // Defer to the next animation frame so the canvas has been laid out
    // (the parent strip may still be mid-transition expanding from 0).
    // Without this, subsequent expansions paint onto a zero-sized canvas.
    requestAnimationFrame(function () {
      _paintSpectrogramNow(canvas, audioBuffer, token);
    });
  }
  function spectrogramPalette(canvas) {
    var strip = canvas && canvas.closest ? canvas.closest('.rec-spectro') : null;
    var controls = strip && strip.querySelector('.rec-player-controls');
    function channels(value, fallback) {
      var parts = String(value || '').match(/[\d.]+/g);
      if (!parts || parts.length < 3) return fallback;
      return [Math.round(+parts[0]), Math.round(+parts[1]), Math.round(+parts[2])];
    }
    if (strip && controls) {
      return {
        bg: channels(getComputedStyle(strip).backgroundColor, [252, 252, 251]),
        fg: channels(getComputedStyle(controls).color, [41, 37, 31])
      };
    }
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return dark
      ? { bg: [41, 42, 46], fg: [239, 237, 232] }
      : { bg: [252, 252, 251], fg: [41, 37, 31] };
  }
  function _paintSpectrogramNow(canvas, audioBuffer, token) {
    if (!document.contains(canvas) || canvas.__birdPaintToken !== token) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    // Read parent strip's box, not the canvas (canvas might be 0-sized
    // briefly during expansion). The strip's expanded height is 88px;
    // width is the row width.
    var strip = canvas.parentElement;
    var cssW = strip ? strip.clientWidth : (canvas.clientWidth || 600);
    var cssH = strip ? strip.clientHeight : (canvas.clientHeight || 88);
    if (strip && strip.classList.contains('rec-spectro')) {
      var playerControls = strip.querySelector('.rec-player-controls');
      if (playerControls) cssH -= playerControls.offsetHeight;
    }
    if (cssW < 32 || cssH < 32) {
      // A row can be collapsed while its audio is still decoding. Stop that
      // hidden paint immediately; the cached buffer will repaint on the next
      // expansion. Keep a bounded retry for ordinary one-frame layout waits.
      var recordingRow = canvas.closest && canvas.closest('.rec-row');
      if (recordingRow && !recordingRow.classList.contains('expanded')) return;
      canvas.__birdPaintRetries += 1;
      if (canvas.__birdPaintRetries > 120) return;
      requestAnimationFrame(function () { _paintSpectrogramNow(canvas, audioBuffer, token); });
      return;
    }
    var W = Math.max(1, Math.floor(cssW * dpr));
    var H = Math.max(1, Math.floor(cssH * dpr));
    canvas.width = W; canvas.height = H;

    var ctx = canvas.getContext('2d');
    var samples = audioBuffer.getChannelData(0);
    var sr = audioBuffer.sampleRate;
    var FFT_SIZE = 1024;
    var bins = FFT_SIZE >> 1;
    var nyquist = sr / 2;

    // Frequency-band mapping (Hz -> bin) for the bird-relevant band.
    // Most North American songbirds + corvids range 250 Hz - 8 kHz, but
    // hummingbirds, kinglets, and warblers reach 12 kHz. Push the cap
    // up so we don't miss the high-frequency tail.
    var fLo = 200, fHi = Math.min(12000, nyquist);
    var binLo = Math.max(1, Math.floor(fLo / nyquist * bins));
    var binHi = Math.min(bins - 1, Math.ceil(fHi / nyquist * bins));

    // Hann window
    var win = new Float32Array(FFT_SIZE);
    for (var i = 0; i < FFT_SIZE; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }

    // Choose a hop that lays exactly W columns over the whole clip.
    var hop = Math.max(1, Math.floor((samples.length - FFT_SIZE) / Math.max(1, W - 1)));
    var real = new Float32Array(FFT_SIZE);
    var imag = new Float32Array(FFT_SIZE);

    var imgData = ctx.createImageData(W, H);
    var data = imgData.data;

    // Paint from the postcard's resolved panel + ink colours rather than a
    // separate media palette. The audio trace therefore belongs to the same
    // sheet in both themes, with no CSS filter softening its detail.
    var palette = spectrogramPalette(canvas);
    var BG_R = palette.bg[0], BG_G = palette.bg[1], BG_B = palette.bg[2];
    var FG_R = palette.fg[0], FG_G = palette.fg[1], FG_B = palette.fg[2];
    for (var p = 0; p < data.length; p += 4) {
      data[p] = BG_R; data[p + 1] = BG_G; data[p + 2] = BG_B; data[p + 3] = 255;
    }

    // Precompute row -> bin map (log-ish so low freqs get more space).
    var rowToBin = new Int32Array(H);
    for (var row = 0; row < H; row++) {
      var t = 1 - row / (H - 1); // 1 at top, 0 at bottom
      var bin = Math.round(binLo + (binHi - binLo) * Math.pow(t, 1.55));
      rowToBin[row] = Math.max(binLo, Math.min(binHi, bin));
    }

    // Normalize each clip against its own robust energy distribution. A fixed
    // dB range turns quiet microphones into grey fog and loud ones into solid
    // ink. Per-frequency spectral subtraction removes steady room/traffic
    // noise, then global percentiles preserve the actual transient contours.
    var rawMin = -110, rawMax = 10;
    var energyMap = new Float32Array(W * H);
    energyMap.fill(rawMin);
    var magnitudeScale = Math.max(1, FFT_SIZE * .5);
    var processedColumns = 0;
    for (var col = 0; col < W; col++) {
      var start = col * hop;
      if (start + FFT_SIZE > samples.length) break;
      for (var s = 0; s < FFT_SIZE; s++) {
        real[s] = samples[start + s] * win[s];
        imag[s] = 0;
      }
      _fft(real, imag);
      for (var row2 = 0; row2 < H; row2++) {
        var bin2 = rowToBin[row2];
        var re = real[bin2], im = imag[bin2];
        var mag = Math.sqrt(re * re + im * im);
        var db = 20 * Math.log10(mag / magnitudeScale + 1e-9);
        var energyIndex = row2 * W + col;
        energyMap[energyIndex] = db;
      }
      processedColumns = col + 1;
    }

    var histogramMin = 0, histogramMax = 60;
    var histogram = new Uint32Array(160);
    var energyCount = 0;
    for (var row3 = 0; row3 < H; row3++) {
      var rowHistogram = new Uint32Array(96);
      for (var col2 = 0; col2 < processedColumns; col2++) {
        var rawDb = energyMap[row3 * W + col2];
        var rawIndex = Math.floor((rawDb - rawMin) / (rawMax - rawMin) * rowHistogram.length);
        rawIndex = Math.max(0, Math.min(rowHistogram.length - 1, rawIndex));
        rowHistogram[rawIndex] += 1;
      }
      var rowTarget = Math.max(1, processedColumns) * .55;
      var rowSeen = 0;
      var rowFloor = rawMin;
      for (var rh = 0; rh < rowHistogram.length; rh++) {
        rowSeen += rowHistogram[rh];
        if (rowSeen >= rowTarget) {
          rowFloor = rawMin + (rh / (rowHistogram.length - 1)) * (rawMax - rawMin);
          break;
        }
      }
      for (var col3 = 0; col3 < processedColumns; col3++) {
        var mapIndex = row3 * W + col3;
        var contrastDb = Math.max(0, energyMap[mapIndex] - rowFloor);
        energyMap[mapIndex] = contrastDb;
        energyCount += 1;
        var histogramIndex = Math.floor((contrastDb - histogramMin) / (histogramMax - histogramMin) * histogram.length);
        histogramIndex = Math.max(0, Math.min(histogram.length - 1, histogramIndex));
        histogram[histogramIndex] += 1;
      }
    }
    function energyPercentile(fraction) {
      var target = Math.max(1, energyCount) * fraction;
      var seen = 0;
      for (var h = 0; h < histogram.length; h++) {
        seen += histogram[h];
        if (seen >= target) {
          return histogramMin + (h / (histogram.length - 1)) * (histogramMax - histogramMin);
        }
      }
      return histogramMax;
    }
    var inkFloor = energyPercentile(.7);
    var inkCeiling = energyPercentile(.995);
    if (inkCeiling - inkFloor < 8) inkCeiling = inkFloor + 8;

    for (var energyPx = 0; energyPx < energyMap.length; energyPx++) {
      var v = (energyMap[energyPx] - inkFloor) / Math.max(1, inkCeiling - inkFloor);
      if (v < 0) v = 0; else if (v > 1) v = 1;
      // Suppress the residual noise floor, then smooth the call contour.
      v = Math.pow(v, 1.32);
      var e = v * v * (3 - 2 * v);
      var r = BG_R + Math.round((FG_R - BG_R) * e);
      var g = BG_G + Math.round((FG_G - BG_G) * e);
      var b = BG_B + Math.round((FG_B - BG_B) * e);
      var px = energyPx * 4;
      data[px] = r; data[px + 1] = g; data[px + 2] = b; data[px + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    canvas.classList.add('ready');
  }

  // Lazy-add + paint the canvas-based spectrogram for a row's strip.
  // Decoded buffers are cached per file so re-expanding is instant.
  function ensureSpectroImage(row) {
    var file = row && row.dataset.file;
    if (!file) return;
    var strip = row.querySelector('.rec-spectro');
    if (!strip) return;
    var loadingEl = strip.querySelector('.rec-spectro-loading');
    var canvas = strip.querySelector('canvas');
    var readyImage = strip.querySelector('.rec-spectro-image.ready');
    if (readyImage) {
      if (loadingEl) loadingEl.style.display = 'none';
      return;
    }
    if (canvas && canvas.classList.contains('ready')) {
      if (loadingEl) loadingEl.style.display = 'none';
      return;
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      var played = strip.querySelector('.rec-spectro-played');
      strip.insertBefore(canvas, played);
    }
    if (loadingEl) {
      loadingEl.style.display = '';
      loadingEl.textContent = 'rendering spectrogram...';
    }

    function done() {
      if (loadingEl) loadingEl.style.display = 'none';
    }
    function fail(reason) {
      if (loadingEl) {
        loadingEl.style.display = '';
        loadingEl.textContent = reason || 'spectrogram unavailable';
      }
    }

    function decodeRecording(url, cacheKey) {
      if (_decodedCache[cacheKey]) return Promise.resolve(_decodedCache[cacheKey]);
      if (!ctx) return Promise.reject(new Error('WebAudio not available'));
      return fetch(url)
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.arrayBuffer();
        })
        .then(function (buffer) { return ctx.decodeAudioData(buffer); })
        .then(function (audioBuffer) {
          _decodedCache[cacheKey] = audioBuffer;
          return audioBuffer;
        });
    }

    function paintDecoded(audioBuffer) {
      paintSpectrogram(canvas, audioBuffer);
      done();
    }

    // BirdNET-Pi writes a PNG beside every extracted MP3. Prefer the audio
    // because it gives us a consistent, theme-aware STFT, but retain the
    // exact-recording PNG as a resilient fallback when an installation has
    // already rotated its audio while keeping the generated spectrogram.
    function paintStoredSpectrogram(url) {
      return new Promise(function (resolve, reject) {
        var image = new Image();
        image.decoding = 'async';
        image.onload = function () {
          try {
            var ratio = Math.min(2, window.devicePixelRatio || 1);
            var width = Math.max(320, Math.round((strip.clientWidth || 640) * ratio));
            var controls = strip.querySelector('.rec-player-controls');
            var visualHeight = (strip.clientHeight || 112) - (controls ? controls.offsetHeight : 0);
            var height = Math.max(80, Math.round(visualHeight * ratio));
            canvas.width = width;
            canvas.height = height;
            var draw = canvas.getContext('2d', { willReadFrequently: true });
            draw.drawImage(image, 0, 0, width, height);

            // Re-ink BirdNET's coloured export into the postcard palette so
            // the fallback is visually identical to the client-side trace.
            var pixels = draw.getImageData(0, 0, width, height);
            var data = pixels.data;
            var palette = spectrogramPalette(canvas);
            var bg = palette.bg;
            var fg = palette.fg;
            for (var i = 0; i < data.length; i += 4) {
              var lum = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
              var energy = 1 - lum;
              energy = energy * energy * (3 - 2 * energy);
              data[i] = Math.round(bg[0] + (fg[0] - bg[0]) * energy);
              data[i + 1] = Math.round(bg[1] + (fg[1] - bg[1]) * energy);
              data[i + 2] = Math.round(bg[2] + (fg[2] - bg[2]) * energy);
              data[i + 3] = 255;
            }
            draw.putImageData(pixels, 0, 0);
            canvas.classList.add('ready');
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        image.onerror = reject;
        image.src = url;
      });
    }

    if (_decodedCache[file]) {
      paintSpectrogram(canvas, _decodedCache[file]);
      done();
      return;
    }
    // Exact stored PNGs remain useful even when WebAudio is unavailable.
    // Audio decoding checks the context only when that path is actually used.
    var ctx = getSpecCtx();
    decodeRecording('./avian/api/recording.php?file=' + encodeURIComponent(file), file)
      .then(paintDecoded)
      .catch(function () {
        return paintStoredSpectrogram('./avian/api/spectrogram.php?file=' + encodeURIComponent(file))
          .then(done)
          .catch(function () { fail('recording unavailable'); });
      });
  }

  function setRecordingExpanded(row, expanded) {
    if (!row) return;
    var toggle = row.querySelector('.rec-row-toggle');
    var strip = row.querySelector('.rec-spectro');
    row.classList.toggle('expanded', expanded);
    if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (strip) strip.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    if (expanded) {
      ensureSpectroImage(row);
      syncLoopRegion(row);
    } else if (modalRow() === row) {
      pauseModalAudio();
    }
  }

  function recordingSources(row) {
    var sources = [];
    var file = row.dataset.file || '';
    if (file) {
      sources.push('./avian/api/recording.php?file=' + encodeURIComponent(file));
    }
    return sources;
  }

  function playModalRecording(row) {
    var button = row && row.querySelector('.rec-player-toggle');
    if (!button || button.disabled) return;
    setRecordingExpanded(row, true);

    if (modalRow() === row && modalAudio) {
      if (!modalAudio.paused) {
        pauseModalAudio();
        return;
      }
      var resumedBounds = loopBounds(row);
      if (row.dataset.loopEnabled === 'true' && modalAudio.duration) {
        var resumedPct = modalAudio.currentTime / modalAudio.duration;
        if (resumedPct < resumedBounds.start || resumedPct >= resumedBounds.end) {
          modalAudio.currentTime = resumedBounds.start * modalAudio.duration;
        }
      }
      audioClaim(stopModalAudio);
      var resumePromise = modalAudio.play();
      if (resumePromise && resumePromise.catch) {
        resumePromise.catch(function () {
          audioRelease(stopModalAudio);
          setModalPlayState(button, false);
        });
      }
      return;
    }

    var sources = recordingSources(row);
    stopModalAudio();
    modalRecBtn = button;
    button.disabled = false;
    button.removeAttribute('data-error');
    var audio = new Audio();
    var token = ++modalAudioToken;
    modalAudio = audio;
    audio.preload = 'metadata';
    audio.__sourceIndex = -1;
    audio.__sources = sources;

    function unavailable() {
      if (token !== modalAudioToken || audio !== modalAudio) return;
      audioRelease(stopModalAudio);
      stopCursorLoop();
      setModalPlayState(button, false);
      button.setAttribute('data-error', 'true');
      button.setAttribute('aria-label', 'Recording unavailable');
      button.disabled = true;
      var time = row.querySelector('.rec-player-time');
      if (time) time.textContent = 'unavailable';
    }
    function trySource(index) {
      if (token !== modalAudioToken || audio !== modalAudio) return;
      if (index >= audio.__sources.length) {
        unavailable();
        return;
      }
      audio.__sourceIndex = index;
      audio.src = audio.__sources[index];
      audio.load();
      audioClaim(stopModalAudio);
      var playPromise;
      try { playPromise = audio.play(); }
      catch (error) { trySource(index + 1); return; }
      if (playPromise && playPromise.catch) {
        playPromise.catch(function (error) {
          if (token !== modalAudioToken || audio !== modalAudio || audio.__sourceIndex !== index) return;
          if (error && error.name === 'NotAllowedError') {
            audioRelease(stopModalAudio);
            setModalPlayState(button, false);
            return;
          }
          trySource(index + 1);
        });
      }
    }

    audio.addEventListener('loadedmetadata', function () {
      if (token !== modalAudioToken || audio !== modalAudio) return;
      row.dataset.audioDuration = String(audio.duration || 0);
      syncLoopRegion(row);
      var seek = clamp01(row.dataset.pendingSeek || 0);
      if (row.dataset.loopEnabled === 'true') {
        var bounds = loopBounds(row);
        if (seek < bounds.start || seek >= bounds.end) seek = bounds.start;
      }
      if (audio.duration) {
        try { audio.currentTime = seek * audio.duration; } catch (error) {}
      }
      setRecordingPosition(row, seek, seek > 0);
    });
    audio.addEventListener('playing', function () {
      if (token !== modalAudioToken || audio !== modalAudio) return;
      setModalPlayState(button, true);
      audioClaim(stopModalAudio);
      startCursorLoop();
    });
    audio.addEventListener('pause', function () {
      if (token !== modalAudioToken || audio !== modalAudio || audio.ended) return;
      setModalPlayState(button, false);
      stopCursorLoop();
    });
    audio.addEventListener('ended', function () {
      if (token !== modalAudioToken || audio !== modalAudio) return;
      if (row.dataset.loopEnabled === 'true' && audio.duration) {
        audio.currentTime = loopBounds(row).start * audio.duration;
        audio.play().catch(function () { pauseModalAudio(); });
        return;
      }
      setRecordingPosition(row, 1);
      setModalPlayState(button, false);
      stopCursorLoop();
      audioRelease(stopModalAudio);
    });
    audio.addEventListener('error', function () {
      if (token !== modalAudioToken || audio !== modalAudio) return;
      var failedIndex = audio.__sourceIndex;
      setTimeout(function () {
        if (token === modalAudioToken && audio === modalAudio && audio.__sourceIndex === failedIndex) {
          trySource(failedIndex + 1);
        }
      }, 0);
    });

    if (!sources.length) unavailable();
    else trySource(0);
  }

  var modalRecordings = document.getElementById('modalRecordings');
  modalRecordings.addEventListener('click', function (ev) {
    if (!ev.target.closest) return;
    var play = ev.target.closest('.rec-player-toggle');
    if (play) {
      playModalRecording(play.closest('.rec-row'));
      return;
    }
    var loop = ev.target.closest('.rec-loop-toggle');
    if (loop) {
      var loopRow = loop.closest('.rec-row');
      setLoopEnabled(loopRow, loopRow.dataset.loopEnabled !== 'true');
      return;
    }
    if (ev.target.closest('.rec-spectro-scrub, .rec-loop-handle')) return;
    var toggle = ev.target.closest('.rec-row-toggle');
    var row = toggle && toggle.closest('.rec-row');
    if (row) setRecordingExpanded(row, !row.classList.contains('expanded'));
  });

  // The spectrogram is the scrub surface. Horizontal pointer motion seeks;
  // vertical touch motion remains available to the recording list. When loop
  // is active, either bracket can be dragged or adjusted from the keyboard.
  (function () {
    var scrubDrag = null;
    var loopDrag = null;
    function pctFromEvent(row, clientX) {
      var strip = row.querySelector('.rec-spectro');
      var rect = strip.getBoundingClientRect();
      return rect.width ? clamp01((clientX - rect.left) / rect.width) : 0;
    }
    function seekTo(row, pct) {
      pct = clamp01(pct);
      setRecordingPosition(row, pct);
      if (modalRow() === row && modalAudio && modalAudio.duration) {
        try { modalAudio.currentTime = pct * modalAudio.duration; } catch (error) {}
      }
    }
    function moveLoopEdge(row, edge, pct) {
      var bounds = loopBounds(row);
      pct = clamp01(pct);
      if (edge === 'start') bounds.start = Math.min(pct, bounds.end - .04);
      else bounds.end = Math.max(pct, bounds.start + .04);
      row.dataset.loopStart = String(clamp01(bounds.start));
      row.dataset.loopEnd = String(clamp01(bounds.end));
      row.dataset.loopInitialized = 'true';
      syncLoopRegion(row);
    }
    modalRecordings.addEventListener('pointerdown', function (ev) {
      var handle = ev.target.closest && ev.target.closest('.rec-loop-handle');
      if (handle) {
        var loopRow = handle.closest('.rec-row');
        if (!loopRow || loopRow.dataset.loopEnabled !== 'true') return;
        loopDrag = { row: loopRow, edge: handle.dataset.edge };
        moveLoopEdge(loopRow, handle.dataset.edge, pctFromEvent(loopRow, ev.clientX));
        try { handle.setPointerCapture(ev.pointerId); } catch (error) {}
        ev.preventDefault();
        return;
      }
      var scrub = ev.target.closest && ev.target.closest('.rec-spectro-scrub');
      if (!scrub) return;
      var row = scrub.closest('.rec-row');
      if (!row || !row.classList.contains('expanded')) return;
      scrubDrag = row;
      seekTo(row, pctFromEvent(row, ev.clientX));
      try { scrub.setPointerCapture(ev.pointerId); } catch (error) {}
    });
    document.addEventListener('pointermove', function (ev) {
      if (loopDrag) moveLoopEdge(loopDrag.row, loopDrag.edge, pctFromEvent(loopDrag.row, ev.clientX));
      else if (scrubDrag) seekTo(scrubDrag, pctFromEvent(scrubDrag, ev.clientX));
    });
    function finishPointer() { scrubDrag = null; loopDrag = null; }
    document.addEventListener('pointerup', finishPointer);
    document.addEventListener('pointercancel', finishPointer);
    modalRecordings.addEventListener('keydown', function (ev) {
      var scrub = ev.target.closest && ev.target.closest('.rec-spectro-scrub');
      var handle = ev.target.closest && ev.target.closest('.rec-loop-handle');
      if (!scrub && !handle) return;
      var row = (scrub || handle).closest('.rec-row');
      var value = +((scrub || handle).getAttribute('aria-valuenow') || 0) / 100;
      var step = ev.shiftKey ? .1 : .02;
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') value -= step;
      else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') value += step;
      else if (ev.key === 'PageDown') value -= .1;
      else if (ev.key === 'PageUp') value += .1;
      else if (ev.key === 'Home') value = 0;
      else if (ev.key === 'End') value = 1;
      else return;
      if (handle) moveLoopEdge(row, handle.dataset.edge, value);
      else seekTo(row, value);
      ev.preventDefault();
    });
  })();

  // Hidden audio should never surprise someone after the accordion or the
  // postcard closes. Mutations also cover a species swap replacing the list.
  var postcardRecordingsPanel = document.querySelector('.postcard-recordings');
  if (postcardRecordingsPanel) postcardRecordingsPanel.addEventListener('toggle', function () {
    if (!postcardRecordingsPanel.open && modalAudio && !modalAudio.paused) pauseModalAudio();
  });
  if (window.MutationObserver) {
    new MutationObserver(function () {
      if (modalRecBtn && !modalRecordings.contains(modalRecBtn)) stopModalAudio();
    }).observe(modalRecordings, { childList: true });
    var postcardShell = document.getElementById('postcard-modal');
    if (postcardShell) new MutationObserver(function () {
      if (postcardShell.getAttribute('aria-hidden') === 'true' && modalAudio) stopModalAudio();
    }).observe(postcardShell, { attributes: true, attributeFilter: ['aria-hidden'] });
  }

  // Any element with data-sci is a "jump to that bird's atlas card"
  // affordance: atlas cards themselves, stats list rows (top species /
  // first detections), stats timeline squares, and any future surface
  // that wants to point at a bird. Action chips inside cards stop
  // propagation themselves.
  function jumpToSci(sci) {
    if (!sci) return;
    if (location.hash !== '#sci=' + encodeURIComponent(sci)) {
      location.hash = '#sci=' + encodeURIComponent(sci);
    } else {
      // Same hash -> still re-highlight (the user clicked it again).
      go(2); highlightAtlas(sci);
    }
  }

  var postcardModal = document.getElementById('postcard-modal');
  var postcardSlot = postcardModal && postcardModal.querySelector('.postcard-stamp-slot');
  var activePostcardSci = '';
  var activePostcardFlight = null;
  var activePostcardLanded = null;
  var activePostcardCard = null;
  var activePostcardAnimation = null;
  var activeClassicPostcardAnimation = null;
  var activeClassicPostcardSource = null;
  var postcardCloseTimer = 0;
  var postcardDrawerHandle = postcardModal && postcardModal.querySelector('.postcard-drawer-handle');
  var postcardDrawerMedia = window.matchMedia ? window.matchMedia('(max-width: 860px)') : null;
  var postcardDrawerState = {
    pointerId: null,
    startY: 0,
    dragY: 0,
    lastY: 0,
    lastTime: 0,
    velocityY: 0,
    moved: false,
    suppressClickUntil: 0,
    resetTimer: 0,
    captureLossTimer: 0
  };
  // A fresh #sci= deep link can prepare the postcard before execution reaches
  // this late-bound interaction block. Preserve counters established by that
  // early route instead of resetting them and invalidating its reveal frame.
  var postcardOpenSequence = Number.isFinite(postcardOpenSequence) ? postcardOpenSequence : 0;
  var postcardShellSequence = Number.isFinite(postcardShellSequence) ? postcardShellSequence : 0;

  // cloneNode() preserves a canvas element but not its bitmap. Repaint each
  // cloned canvas in place so family-specific canvas selectors keep working
  // while the airborne and landed issues remain pixel-identical to the Atlas.
  function cloneRenderedStamp(fit) {
    var copy = fit.cloneNode(true);
    copy.querySelectorAll('.stamp-peel-layer').forEach(function (el) { el.remove(); });
    repaintClonedCanvases(fit, copy);
    return copy;
  }
  function refreshOpenPostcardStamp(sci) {
    if (!sci || activePostcardSci !== sci || !postcardSlot) return;
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;
    var card = [].slice.call(grid.querySelectorAll('.stamp-card[data-sci]')).find(function (candidate) {
      return candidate.dataset.sci === sci;
    });
    var fit = card && card.querySelector('.stamp-fit');
    if (!fit) return;
    var landed = cloneRenderedStamp(fit);
    var naturalW = parseFloat(fit.style.width) || fit.offsetWidth || 188;
    var naturalH = parseFloat(fit.style.height) || fit.offsetHeight || 236;
    var turn = postcardTurn(sci);
    landed.style.setProperty('--postcard-turn', turn.toFixed(2) + 'deg');
    landed.dataset.postcardWidth = String(naturalW);
    landed.dataset.postcardHeight = String(naturalH);
    landed.dataset.postcardTurn = String(turn);
    postcardSlot.replaceChildren(landed);
    card.style.opacity = '0';
    activePostcardLanded = landed;
    activePostcardCard = card;
    fitPostcardStamp(landed);
  }
  function postcardTurn(sci) {
    var n = 0, i;
    for (i = 0; i < sci.length; i++) n += sci.charCodeAt(i);
    return ((n % 7) - 3) * .16;
  }
  function fitPostcardStamp(fit) {
    if (!fit || !postcardSlot) return 1;
    var naturalW = +(fit.dataset.postcardWidth || parseFloat(fit.style.width) || fit.offsetWidth || 188);
    var naturalH = +(fit.dataset.postcardHeight || parseFloat(fit.style.height) || fit.offsetHeight || 236);
    var turn = +(fit.dataset.postcardTurn || 0);
    var radians = Math.abs(turn) * Math.PI / 180;
    var rotatedW = Math.abs(naturalW * Math.cos(radians)) + Math.abs(naturalH * Math.sin(radians));
    var rotatedH = Math.abs(naturalW * Math.sin(radians)) + Math.abs(naturalH * Math.cos(radians));
    var slotBox = postcardSlot.getBoundingClientRect();
    var inset = 5;
    var scale = Math.min(
      Math.max(1, slotBox.width - inset * 2) / Math.max(1, rotatedW),
      Math.max(1, slotBox.height - inset * 2) / Math.max(1, rotatedH)
    ) * .995;
    fit.style.setProperty('--postcard-scale', Math.max(.01, scale).toFixed(4));
    return scale;
  }
  if (postcardSlot && window.ResizeObserver) {
    new ResizeObserver(function () {
      if (activePostcardLanded && document.contains(activePostcardLanded)) {
        fitPostcardStamp(activePostcardLanded);
      }
    }).observe(postcardSlot);
  }
  function clearSciHash() {
    if (!readHash()) return;
    var url = new URL(location.href);
    url.hash = '';
    history.replaceState(history.state, '', url.pathname + url.search);
    highlightAtlas(null);
  }

  function postcardDrawerSheet() {
    return postcardModal && postcardModal.querySelector('.postcard-sheet');
  }

  function setPostcardAtlasSource(source) {
    if (!postcardModal) postcardModal = document.getElementById('postcard-modal');
    if (!postcardSlot && postcardModal) postcardSlot = postcardModal.querySelector('.postcard-stamp-slot');
    if (!postcardModal) return;
    var classic = source === 'classic';
    postcardModal.setAttribute('data-atlas-source', classic ? 'classic' : 'stamps');
    if (classic && postcardSlot) postcardSlot.replaceChildren();
  }

  function releasePostcardDrawerPointer() {
    var pointerId = postcardDrawerState.pointerId;
    postcardDrawerState.pointerId = null;
    if (pointerId === null || !postcardDrawerHandle ||
        typeof postcardDrawerHandle.releasePointerCapture !== 'function') return;
    try {
      if (!postcardDrawerHandle.hasPointerCapture || postcardDrawerHandle.hasPointerCapture(pointerId)) {
        postcardDrawerHandle.releasePointerCapture(pointerId);
      }
    } catch (err) {}
  }

  function resetPostcardDrawer() {
    clearTimeout(postcardDrawerState.resetTimer);
    postcardDrawerState.resetTimer = 0;
    clearTimeout(postcardDrawerState.captureLossTimer);
    postcardDrawerState.captureLossTimer = 0;
    releasePostcardDrawerPointer();
    postcardDrawerState.startY = 0;
    postcardDrawerState.dragY = 0;
    postcardDrawerState.lastY = 0;
    postcardDrawerState.lastTime = 0;
    postcardDrawerState.velocityY = 0;
    postcardDrawerState.moved = false;
    postcardDrawerState.suppressClickUntil = 0;
    if (postcardModal) {
      postcardModal.classList.remove('is-drawer-dragging', 'is-drawer-closing');
    }
    var sheet = postcardDrawerSheet();
    if (sheet) {
      sheet.classList.remove('is-drawer-dragging', 'is-drawer-closing');
      sheet.style.removeProperty('--drawer-drag-y');
    }
  }

  function settlePostcardDrawerBack() {
    clearTimeout(postcardDrawerState.resetTimer);
    postcardDrawerState.resetTimer = 0;
    releasePostcardDrawerPointer();
    if (postcardModal) {
      postcardModal.classList.remove('is-drawer-dragging', 'is-drawer-closing');
    }
    var sheet = postcardDrawerSheet();
    if (!sheet) return;
    sheet.classList.remove('is-drawer-dragging', 'is-drawer-closing');
    // Re-enable the sheet's transform transition before returning the custom
    // property to zero, so an incomplete gesture glides home rather than snaps.
    void sheet.offsetWidth;
    sheet.style.setProperty('--drawer-drag-y', '0px');
    postcardDrawerState.resetTimer = setTimeout(function () {
      postcardDrawerState.resetTimer = 0;
      if (postcardDrawerState.pointerId === null &&
          postcardModal && !postcardModal.classList.contains('is-drawer-closing') &&
          !sheet.classList.contains('is-drawer-closing')) {
        sheet.style.removeProperty('--drawer-drag-y');
      }
    }, 320);
  }

  function startPostcardDrawerDrag(ev) {
    if (!postcardModal || !postcardDrawerHandle ||
        postcardModal.getAttribute('aria-hidden') === 'true') return;
    if (postcardDrawerMedia && !postcardDrawerMedia.matches) return;
    if (postcardDrawerState.pointerId !== null || ev.isPrimary === false) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;

    clearTimeout(postcardDrawerState.resetTimer);
    postcardDrawerState.resetTimer = 0;
    clearTimeout(postcardDrawerState.captureLossTimer);
    postcardDrawerState.captureLossTimer = 0;
    postcardDrawerState.pointerId = ev.pointerId;
    postcardDrawerState.startY = ev.clientY;
    postcardDrawerState.dragY = 0;
    postcardDrawerState.lastY = 0;
    postcardDrawerState.lastTime = performance.now();
    postcardDrawerState.velocityY = 0;
    postcardDrawerState.moved = false;
    postcardDrawerState.suppressClickUntil = 0;
    var sheet = postcardDrawerSheet();
    postcardModal.classList.remove('is-drawer-closing', 'is-drawer-dragging');
    if (sheet) {
      sheet.classList.remove('is-drawer-closing');
      sheet.classList.add('is-drawer-dragging');
      sheet.style.setProperty('--drawer-drag-y', '0px');
    }
    try { postcardDrawerHandle.setPointerCapture(ev.pointerId); } catch (err) {}
  }

  function movePostcardDrawer(ev) {
    if (postcardDrawerState.pointerId !== ev.pointerId) return;
    var now = performance.now();
    var dragY = Math.max(0, Math.min(window.innerHeight, ev.clientY - postcardDrawerState.startY));
    var elapsed = Math.max(1, now - postcardDrawerState.lastTime);
    var instantVelocity = (dragY - postcardDrawerState.lastY) / elapsed;
    postcardDrawerState.velocityY = postcardDrawerState.velocityY * .55 + instantVelocity * .45;
    postcardDrawerState.dragY = dragY;
    postcardDrawerState.lastY = dragY;
    postcardDrawerState.lastTime = now;
    if (Math.abs(ev.clientY - postcardDrawerState.startY) > 5) {
      postcardDrawerState.moved = true;
    }
    var sheet = postcardDrawerSheet();
    if (sheet) sheet.style.setProperty('--drawer-drag-y', dragY.toFixed(1) + 'px');
    if (ev.cancelable) ev.preventDefault();
  }

  function finishPostcardDrawerDrag(ev, cancelled) {
    if (postcardDrawerState.pointerId !== ev.pointerId) return;
    clearTimeout(postcardDrawerState.captureLossTimer);
    postcardDrawerState.captureLossTimer = 0;
    var now = performance.now();
    if (!cancelled) {
      var dragY = Math.max(0, Math.min(window.innerHeight, ev.clientY - postcardDrawerState.startY));
      var elapsed = Math.max(1, now - postcardDrawerState.lastTime);
      var finalDelta = dragY - postcardDrawerState.lastY;
      if (elapsed <= 90 && Math.abs(finalDelta) > .5) {
        var instantVelocity = (dragY - postcardDrawerState.lastY) / elapsed;
        postcardDrawerState.velocityY = postcardDrawerState.velocityY * .55 + instantVelocity * .45;
      } else if (elapsed > 90) {
        postcardDrawerState.velocityY = 0;
      }
      postcardDrawerState.dragY = dragY;
      if (Math.abs(ev.clientY - postcardDrawerState.startY) > 5) {
        postcardDrawerState.moved = true;
      }
    }

    var sheet = postcardDrawerSheet();
    var sheetHeight = sheet ? sheet.getBoundingClientRect().height : window.innerHeight;
    var distanceThreshold = Math.min(150, Math.max(88, sheetHeight * .18));
    var fastEnough = postcardDrawerState.dragY >= 28 && postcardDrawerState.velocityY >= .7;
    var farEnough = postcardDrawerState.dragY >= distanceThreshold;
    var shouldClose = !cancelled && (farEnough || fastEnough);
    if (postcardDrawerState.moved) {
      // Pointer drags on buttons are followed by a synthetic click. Keep that
      // click from turning a short reset into an accidental close.
      postcardDrawerState.suppressClickUntil = now + 650;
    }
    releasePostcardDrawerPointer();

    if (shouldClose && postcardModal) {
      postcardModal.classList.remove('is-drawer-dragging');
      if (sheet) {
        sheet.classList.remove('is-drawer-dragging');
        sheet.classList.add('is-drawer-closing');
      } else {
        postcardModal.classList.add('is-drawer-closing');
      }
      closePostcard();
      return;
    }
    settlePostcardDrawerBack();
  }

  function deferLostPostcardDrawerCapture(ev) {
    if (postcardDrawerState.pointerId !== ev.pointerId) return;
    clearTimeout(postcardDrawerState.captureLossTimer);
    var pointerId = ev.pointerId;
    // Some browsers report capture loss before dispatching an outside
    // pointerup. Give the window-level up handler one task to finish the real
    // gesture; cancel only if that pointer is still active afterward.
    postcardDrawerState.captureLossTimer = setTimeout(function () {
      postcardDrawerState.captureLossTimer = 0;
      if (postcardDrawerState.pointerId === pointerId) {
        finishPostcardDrawerDrag({ pointerId: pointerId }, true);
      }
    }, 32);
  }

  function preparePostcardShell() {
    // Initial #sci= deep links are routed before the click-flight wiring at
    // the end of this file runs. Resolve the shell lazily so a refreshed deep
    // link opens the same postcard instead of only pre-populating hidden DOM.
    if (!postcardModal) postcardModal = document.getElementById('postcard-modal');
    if (!postcardSlot && postcardModal) postcardSlot = postcardModal.querySelector('.postcard-stamp-slot');
    if (!postcardModal) return;
    resetPostcardDrawer();
    if (!Number.isFinite(postcardShellSequence)) postcardShellSequence = 0;
    if (!Number.isFinite(postcardOpenSequence)) postcardOpenSequence = 0;
    postcardShellSequence += 1;
    clearTimeout(postcardCloseTimer);
    postcardCloseTimer = 0;
    var angles = [-.36, .28, -.22, .44, .18, -.31];
    var angle = angles[postcardOpenSequence++ % angles.length];
    postcardModal.style.setProperty('--sheet-turn', angle + 'deg');
    postcardModal.classList.remove('is-open');
    postcardModal.classList.add('is-positioned');
    postcardModal.classList.add('is-blurring');
    document.body.classList.add('postcard-open');
    postcardModal.setAttribute('aria-hidden', 'false');
    void postcardModal.offsetWidth;
    return postcardShellSequence;
  }
  function revealPostcardShell() {
    if (!postcardModal) return;
    var sequence = postcardShellSequence;
    // Give the masked backdrop one complete paint before the paper enters.
    // This prevents the compositor from briefly showing a sharp card on an
    // unprepared page and then popping the blur in behind it.
    requestAnimationFrame(function () {
      if (!postcardModal || sequence !== postcardShellSequence ||
          postcardModal.getAttribute('aria-hidden') === 'true') return;
      postcardModal.classList.remove('is-positioned');
      void postcardModal.offsetWidth;
      requestAnimationFrame(function () {
        if (!postcardModal || sequence !== postcardShellSequence ||
            postcardModal.getAttribute('aria-hidden') === 'true') return;
        postcardModal.classList.add('is-open');
        postcardModal.classList.remove('is-blurring');
      });
    });
  }
  function releaseClassicPostcardMotion() {
    var animation = activeClassicPostcardAnimation;
    var source = activeClassicPostcardSource;
    activeClassicPostcardAnimation = null;
    activeClassicPostcardSource = null;
    if (animation) {
      animation.onfinish = null;
      animation.oncancel = null;
      try { animation.cancel(); } catch (err) {}
    }
    if (source) source.style.opacity = '';
    if (postcardModal) postcardModal.classList.remove('is-classic-entering');
  }
  function finishClassicPostcardMotion(animation) {
    if (activeClassicPostcardAnimation !== animation) return;
    activeClassicPostcardAnimation = null;
    animation.onfinish = null;
    animation.oncancel = null;
    try { animation.cancel(); } catch (err) {}
    if (postcardModal) postcardModal.classList.remove('is-classic-entering');
  }
  function revealClassicPostcardShell(sourceCard, sourceRect, animate) {
    var sheet = postcardDrawerSheet();
    var reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!sheet || !sourceRect || !sourceRect.width || !sourceRect.height) {
      revealPostcardShell();
      return;
    }

    // Keyboard activation and reduced-motion both keep the spatial state
    // change, but skip the travel. The class disables the sheet's ordinary
    // entrance transition for the same frame that publishes its final state.
    if (!animate || reduced) {
      postcardModal.classList.add('is-classic-entering', 'is-open');
      postcardModal.classList.remove('is-positioned', 'is-blurring');
      requestAnimationFrame(function () {
        if (postcardModal) postcardModal.classList.remove('is-classic-entering');
      });
      return;
    }
    if (typeof sheet.animate !== 'function') {
      revealPostcardShell();
      return;
    }

    var target = sheet.getBoundingClientRect();
    if (!target.width || !target.height) {
      revealPostcardShell();
      return;
    }
    var scaleX = Math.max(.16, Math.min(1, sourceRect.width / target.width));
    var scaleY = Math.max(.16, Math.min(1, sourceRect.height / target.height));
    var dx = sourceRect.left + sourceRect.width / 2 - (target.left + target.width / 2);
    var dy = sourceRect.top + sourceRect.height / 2 - (target.top + target.height / 2);
    var turn = parseFloat(getComputedStyle(postcardModal).getPropertyValue('--sheet-turn')) || 0;
    var startTransform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1)
      + 'px,0) scale(' + scaleX.toFixed(4) + ',' + scaleY.toFixed(4) + ') rotate(' + turn + 'deg)';
    var endTransform = 'translate3d(0,0,0) scale(1,1) rotate(' + turn + 'deg)';

    postcardModal.classList.add('is-classic-entering', 'is-open');
    postcardModal.classList.remove('is-positioned', 'is-blurring');
    sourceCard.style.opacity = '0';
    activeClassicPostcardSource = sourceCard;
    var animation = sheet.animate([
      { transform: startTransform, opacity: .74, offset: 0 },
      { transform: endTransform, opacity: 1, offset: 1 }
    ], {
      duration: 260,
      easing: 'cubic-bezier(.23,1,.32,1)',
      fill: 'both'
    });
    activeClassicPostcardAnimation = animation;
    animation.onfinish = function () { finishClassicPostcardMotion(animation); };
    animation.oncancel = function () {
      if (activeClassicPostcardAnimation === animation) releaseClassicPostcardMotion();
    };
  }
  function releasePostcardFlight() {
    if (activePostcardAnimation) {
      activePostcardAnimation.onfinish = null;
      activePostcardAnimation.oncancel = null;
      try { activePostcardAnimation.commitStyles(); } catch (err) {}
      activePostcardAnimation.cancel();
    }
    if (activePostcardLanded) activePostcardLanded.style.opacity = '1';
    if (activePostcardFlight) activePostcardFlight.remove();
    if (activePostcardCard) activePostcardCard.style.opacity = '';
    activePostcardAnimation = null;
    activePostcardFlight = null;
    activePostcardLanded = null;
    activePostcardCard = null;
  }
  function closePostcard() {
    if (!postcardModal || postcardModal.getAttribute('aria-hidden') === 'true') return;
    var drawerSheet = postcardDrawerSheet();
    var drawerDrivenClose = postcardModal.classList.contains('is-drawer-closing') ||
      (drawerSheet && drawerSheet.classList.contains('is-drawer-closing'));
    if (!drawerDrivenClose) resetPostcardDrawer();
    postcardShellSequence += 1;
    // Hand the airborne issue to its identical postcard copy only as the
    // sheet closes. While open, one node owns the complete visual state, so
    // there is no delayed shadow/rotation snap at the end of the flight.
    releasePostcardFlight();
    releaseClassicPostcardMotion();
    settlePostcardPanels(postcardPanelTarget);
    postcardModal.classList.remove('is-positioned');
    requestAnimationFrame(function () {
      postcardModal.classList.remove('is-open');
      postcardModal.classList.remove('is-blurring');
      document.body.classList.remove('postcard-open');
    });
    clearSciHash();
    activePostcardSci = '';
    clearTimeout(postcardCloseTimer);
    postcardCloseTimer = setTimeout(function () {
      postcardCloseTimer = 0;
      postcardModal.setAttribute('aria-hidden', 'true');
      if (postcardSlot) postcardSlot.innerHTML = '';
      resetPostcardDrawer();
    }, 340);
  }
  function openClassicPostcard(card, options) {
    if (!postcardModal) postcardModal = document.getElementById('postcard-modal');
    if (!postcardSlot && postcardModal) postcardSlot = postcardModal.querySelector('.postcard-stamp-slot');
    if (!postcardModal || !postcardSlot || !card) return jumpToSci(card && card.dataset.sci);
    options = options || {};
    if (!options.preserveHash) clearSciHash();
    clearTimeout(postcardCloseTimer);
    postcardCloseTimer = 0;
    releasePostcardFlight();
    releaseClassicPostcardMotion();
    var sourceRect = card.getBoundingClientRect();
    activePostcardSci = card.dataset.sci || '';
    setPostcardAtlasSource('classic');
    populatePostcard(activePostcardSci);
    preparePostcardShell();
    revealClassicPostcardShell(card, sourceRect, options.animate !== false);
  }
  function openPostcard(card, options) {
    if (!postcardModal) postcardModal = document.getElementById('postcard-modal');
    if (!postcardSlot && postcardModal) postcardSlot = postcardModal.querySelector('.postcard-stamp-slot');
    if (!postcardModal || !postcardSlot || !card) return jumpToSci(card && card.dataset.sci);
    options = options || {};
    if (!options.preserveHash) clearSciHash();
    clearTimeout(postcardCloseTimer);
    postcardCloseTimer = 0;
    releasePostcardFlight();
    releaseClassicPostcardMotion();
    setPostcardAtlasSource('stamps');
    var fit = card.querySelector('.stamp-fit');
    if (!fit) return jumpToSci(card.dataset.sci);
    activePostcardSci = card.dataset.sci || '';
    populatePostcard(activePostcardSci);
    postcardSlot.innerHTML = '';

    // Capture and replace the live issue before the modal changes body or
    // scrollbar geometry. The airborne copy is visible from the same frame as
    // the click, so there is no pause before the handoff begins.
    var source = fit.getBoundingClientRect();
    var landed = cloneRenderedStamp(fit);
    var naturalW = parseFloat(fit.style.width) || fit.offsetWidth || 188;
    var naturalH = parseFloat(fit.style.height) || fit.offsetHeight || 236;
    var turn = postcardTurn(activePostcardSci);
    landed.style.setProperty('--postcard-turn', turn.toFixed(2) + 'deg');
    landed.dataset.postcardWidth = String(naturalW);
    landed.dataset.postcardHeight = String(naturalH);
    landed.dataset.postcardTurn = String(turn);
    landed.style.opacity = '0';
    postcardSlot.appendChild(landed);

    var sourceScale = Math.min(source.width / naturalW, source.height / naturalH);
    var flight = document.createElement('div');
    flight.className = 'postcard-flight';
    flight.style.left = (source.left + source.width / 2 - naturalW / 2) + 'px';
    flight.style.top = (source.top + source.height / 2 - naturalH / 2) + 'px';
    flight.style.width = naturalW + 'px';
    flight.style.height = naturalH + 'px';
    flight.style.transform = 'translate3d(0,0,0) scale(' + sourceScale + ')';
    flight.appendChild(cloneRenderedStamp(fit));
    document.body.appendChild(flight);
    card.style.opacity = '0';
    activePostcardFlight = flight;
    activePostcardLanded = landed;
    activePostcardCard = card;

    // Resolve the final postcard geometry without ever painting that helper
    // state. The sheet then enters normally while the issue travels directly
    // to the exact landed transform; revealing it cannot cause a second snap.
    preparePostcardShell();
    // Fit the rotated axis-aligned bounds, not just the unrotated issue. This
    // keeps every family an equal optical inset from all four slot edges.
    var targetScale = fitPostcardStamp(landed);
    void landed.offsetWidth;
    var target = landed.getBoundingClientRect();

    // getBoundingClientRect() includes the axis-aligned box of the rotated
    // issue. Reusing that width as a scale caused the airborne copy to land
    // slightly large and then visibly snap to the real postcard transform.
    // The slot's explicit scale is the exact final transform.
    var finalScale = targetScale;
    var dx = target.left + target.width / 2 - (source.left + source.width / 2);
    var dy = target.top + target.height / 2 - (source.top + source.height / 2);
    var reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
    var finalTransform = 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(' + finalScale + ') rotate(' + turn + 'deg)';
    revealPostcardShell();
    var anim = flight.animate(reduced ? [
      { transform: finalTransform }
    ] : [
      { transform: 'translate3d(0,0,0) scale(' + sourceScale + ') rotate(0deg)', offset: 0 },
      { transform: 'translate3d(' + (dx * .5) + 'px,' + (dy * .44 - 14) + 'px,0) scale(' + Math.max(sourceScale, finalScale) + ') rotate(' + (turn - .45) + 'deg)', offset: .5 },
      { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(' + finalScale + ') rotate(' + turn + 'deg)', offset: 1 }
    ], { duration: reduced ? 1 : 420, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' });
    activePostcardAnimation = anim;
    var finishFlight = function () {
      if (activePostcardAnimation !== anim) return;
      anim.onfinish = null;
      anim.oncancel = null;
      anim.cancel();
      landed.style.opacity = '1';
      flight.remove();
      activePostcardAnimation = null;
      activePostcardFlight = null;
    };
    anim.onfinish = finishFlight;
  }

  if (postcardModal) {
    var postcardBackdrop = postcardModal.querySelector('.postcard-backdrop');
    if (postcardBackdrop) postcardBackdrop.addEventListener('click', closePostcard);
    postcardModal.addEventListener('click', function (ev) {
      if (ev.target !== postcardBackdrop && ev.target.closest('[data-postcard-close]')) closePostcard();
    });
    if (postcardDrawerHandle) {
      postcardDrawerHandle.addEventListener('pointerdown', startPostcardDrawerDrag);
      window.addEventListener('pointermove', movePostcardDrawer, { passive: false });
      window.addEventListener('pointerup', function (ev) {
        finishPostcardDrawerDrag(ev, false);
      });
      window.addEventListener('pointercancel', function (ev) {
        finishPostcardDrawerDrag(ev, true);
      });
      postcardDrawerHandle.addEventListener('lostpointercapture', deferLostPostcardDrawerCapture);
      postcardDrawerHandle.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
        ev.preventDefault();
        ev.stopPropagation();
        closePostcard();
      });
      postcardDrawerHandle.addEventListener('click', function (ev) {
        var pointerClick = ev.detail !== 0;
        if (pointerClick && performance.now() < postcardDrawerState.suppressClickUntil) {
          postcardDrawerState.suppressClickUntil = 0;
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        closePostcard();
      });
    }
    postcardPanels().forEach(function (panel) {
      var summary = panel.querySelector('summary');
      if (!summary) return;
      summary.addEventListener('click', function (ev) {
        ev.preventDefault();
        openPostcardPanel(panel);
      });
    });
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && postcardModal && postcardModal.getAttribute('aria-hidden') === 'false') closePostcard();
  });

  document.addEventListener('click', function (ev) {
    if (!ev.target.closest) return;
    if (ev.target.closest('#postcard-modal')) return;
    var card = ev.target.closest('.bird-card');
    if (card) {
      if (ev.target.closest('.actions, .spectro-wrap')) return;
      if (card.classList.contains('stamp-card')) return openPostcard(card);
      if (card.classList.contains('classic-atlas-card')) {
        return openClassicPostcard(card, { animate: ev.detail !== 0 });
      }
      return jumpToSci(card.dataset.sci);
    }
    var row = ev.target.closest('li[data-sci]');
    if (row) return jumpToSci(row.dataset.sci);
    var tlCol = ev.target.closest('.stats-tl-col[data-sci]');
    if (tlCol) return jumpToSci(tlCol.dataset.sci);
    var hmRow = ev.target.closest('.heatmap-row[data-sci]');
    if (hmRow) return jumpToSci(hmRow.dataset.sci);
  });

  // After the atlas re-renders (window change, fresh fetch), re-apply
  // any active hash so the highlight survives a rebuild.
  var _origRenderAtlas = renderAtlas;
  renderAtlas = function (animate) {
    _origRenderAtlas(animate);
    var s = readHash();
    if (s) highlightAtlas(s);
  };
})();

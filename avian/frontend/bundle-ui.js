(function (global) {
  'use strict';

  var API_URL = './avian/api/bundles.php';
  var CATALOG_URL = 'https://avianvisitors.com/bundles';
  var FRAME_URL = './assets/bundle-catalog/index.html?v=r4';
  var ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
  var JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
  var STYLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
  var MOBILE_QUERY = '(max-width: 860px)';
  var DEFAULT_NAME = 'Japanese Woodblock';
  var DEFAULT_STYLE = 'japanese-woodblock';

  var mounted = false;
  var root = null;
  var trigger = null;
  var currentName = null;
  var note = null;
  var live = null;
  var snapshot = null;
  var refreshArtwork = null;
  var requestController = null;
  var pollTimer = 0;
  var pollDeadline = 0;
  var pollReconcileDeadline = 0;
  var pollIsSlow = false;
  var pollFailureCount = 0;
  var jobTracking = false;
  var jobTrackingGeneration = 0;
  var jobTrackingId = '';
  var jobRefreshArtwork = null;
  var dialog = null;
  var sheet = null;
  var frame = null;
  var handle = null;
  var handoff = '';
  var returnFocus = null;
  var closeTimer = 0;
  var closing = false;
  var backdropPointer = null;
  var themeObserver = null;
  var requestedPackId = '';
  var stationRegion = '';
  var mobile = global.matchMedia ? global.matchMedia(MOBILE_QUERY) : null;
  var drawer = {
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

  function rowMarkup() {
    return ''
      + '<div class="menu-row bundle-setting-row">'
      + '  <div><span class="label">Bird bundle</span><span class="hint bundle-setting-note" data-bundle-note hidden></span></div>'
      + '  <button class="bundle-setting-trigger" type="button" data-bundle-browser-open aria-haspopup="dialog">'
      + '    <span data-bundle-current>' + DEFAULT_NAME + '</span>'
      + '    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>'
      + '  </button>'
      + '  <span class="visually-hidden" data-bundle-live role="status" aria-live="polite"></span>'
      + '</div>';
  }

  function ownRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function exactKeys(value, expected) {
    if (!ownRecord(value)) return false;
    var actual = Object.keys(value).sort();
    var wanted = expected.slice().sort();
    return actual.length === wanted.length && actual.every(function (key, index) {
      return key === wanted[index];
    });
  }

  function cleanName(value, fallback) {
    if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
      return fallback;
    }
    return value.trim();
  }

  function packsFrom(value) {
    var packs = ownRecord(value) && ownRecord(value.catalog) && Array.isArray(value.catalog.packs)
      ? value.catalog.packs : [];
    if (packs.length > 1000) return [];
    return packs.filter(function (pack) {
      return ownRecord(pack) && typeof pack.id === 'string' && ID_PATTERN.test(pack.id);
    });
  }

  function activeRecord(value) {
    var active = ownRecord(value) && ownRecord(value.library) && ownRecord(value.library.active)
      ? value.library.active : null;
    return active && typeof active.id === 'string' && ID_PATTERN.test(active.id) ? active : null;
  }

  function activePack(value) {
    var active = activeRecord(value);
    if (!active) return null;
    return packsFrom(value).find(function (pack) { return pack.id === active.id; }) || null;
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function activeStyle() {
    var pack = activePack(snapshot);
    var id = pack && ownRecord(pack.style) ? pack.style.id : '';
    return typeof id === 'string' && STYLE_PATTERN.test(id) ? id : DEFAULT_STYLE;
  }

  function broadRegionForCoordinates(latitudeValue, longitudeValue) {
    var latitude = Number(latitudeValue);
    var longitude = Number(longitudeValue);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
        || (latitude === 0 && longitude === 0)) return '';

    // These broad, intentionally conservative geographic bands mirror the
    // catalog's six filters. Border and polar coordinates fall back to the
    // unfiltered catalog rather than guessing from whichever bundle is active.
    var northAmerica = (latitude >= 7 && latitude <= 84 && longitude >= -170 && longitude <= -77)
      || (latitude >= 10 && latitude <= 28 && longitude > -77 && longitude <= -58)
      || (latitude >= 58 && latitude <= 84 && longitude > -77 && longitude <= -10)
      || (latitude >= 18 && latitude <= 23 && longitude >= -161 && longitude <= -154);
    if (northAmerica) return 'North America';

    if (latitude >= -60 && latitude <= 13 && longitude >= -92 && longitude <= -30) {
      return 'South America';
    }

    var oceania = (latitude >= -48 && latitude <= -9 && longitude >= 110 && longitude <= 155)
      || (latitude >= -48 && latitude <= -33 && longitude >= 165)
      || (latitude >= -25 && latitude <= 30 && longitude >= 130)
      || (latitude >= -30 && latitude <= 30 && longitude <= -105);
    if (oceania) return 'Oceania';

    var europeSouth = longitude <= 0 ? 35.5 : (longitude <= 20 ? 37 : (longitude <= 30 ? 34.5 : 40));
    var europe = latitude >= europeSouth && latitude <= 72 && longitude >= -25 && longitude <= 45;
    if (europe || (latitude >= 36 && latitude <= 40 && longitude >= -32 && longitude < -25)) {
      return 'Europe';
    }

    var africa = latitude >= -36 && latitude <= 37.5 && longitude >= -20 && longitude <= 52
      && !(latitude > 12 && longitude > 35);
    if (africa) return 'Africa';

    if (latitude >= -11 && latitude <= 82 && longitude >= 25 && longitude <= 180) {
      return 'Asia';
    }
    return '';
  }

  function announce(message, error) {
    if (live) live.textContent = message || '';
    if (note) {
      note.textContent = message || '';
      note.hidden = !message || !error;
      note.classList.toggle('err', !!error);
    }
  }

  function setBusy(value) {
    if (!trigger) return;
    trigger.toggleAttribute('data-busy', !!value);
    trigger.setAttribute('aria-busy', value ? 'true' : 'false');
  }

  function applySnapshot(value) {
    if (!ownRecord(value) || value.ok !== true || !ownRecord(value.catalog) || !ownRecord(value.library)) {
      throw new Error('The bundle library returned an invalid response.');
    }
    snapshot = value;
    var active = activeRecord(value);
    var pack = activePack(value);
    var name = cleanName(active && active.name, cleanName(pack && pack.name, DEFAULT_NAME));
    if (currentName) currentName.textContent = name;
    var job = ownRecord(value.job) ? value.job : null;
    setBusy(!!job && job.state === 'running');
    sendLibrary();
    return value;
  }

  function responseJson(response) {
    return response.json().catch(function () { return {}; }).then(function (body) {
      if (!response.ok || !ownRecord(body) || body.ok !== true) {
        throw new Error(cleanName(body && body.error, 'The bundle request did not complete.'));
      }
      return body;
    });
  }

  function fetchSnapshot() {
    if (requestController) requestController.abort();
    requestController = typeof AbortController === 'function' ? new AbortController() : null;
    var options = { credentials: 'same-origin', cache: 'no-store' };
    if (requestController) options.signal = requestController.signal;
    return fetch(API_URL, options).then(responseJson).then(applySnapshot);
  }

  function safeRefreshArtwork(callback) {
    var refresher = typeof callback === 'function' ? callback : refreshArtwork;
    if (typeof refresher !== 'function') return Promise.resolve(true);
    var active = activeRecord(snapshot);
    if (!active) {
      var missing = new Error('Bird artwork is still loading.');
      missing.bundleArtwork = true;
      return Promise.reject(missing);
    }
    try {
      return Promise.resolve(refresher(active)).then(function (loaded) {
        if (loaded === false) {
          var error = new Error('Bird artwork is still loading.');
          error.bundleArtwork = true;
          throw error;
        }
        return true;
      }).catch(function (error) {
        if (error && typeof error === 'object') error.bundleArtwork = true;
        throw error;
      });
    } catch (error) {
      if (error && typeof error === 'object') error.bundleArtwork = true;
      return Promise.reject(error);
    }
  }

  function stopPolling() {
    jobTrackingGeneration += 1;
    clearTimeout(pollTimer);
    pollTimer = 0;
    pollDeadline = 0;
    pollReconcileDeadline = 0;
    pollIsSlow = false;
    pollFailureCount = 0;
    jobTracking = false;
    jobTrackingId = '';
    jobRefreshArtwork = null;
  }

  function reportFailure(error) {
    setBusy(false);
    if (error && error.bundleArtwork) {
      if (global.console) global.console.error('bundle artwork refresh failed', error);
      // Keep the Settings row compact. The exact refresh is retried whenever
      // Settings mounts again, while assistive technology still receives a
      // quiet status update instead of a large persistent error line.
      announce('Bird bundle changed. Artwork will retry when Settings opens.', false);
      return;
    }
    announce(error && error.message ? error.message : 'The bundle request did not complete.', true);
  }

  function backgroundRetryDelay() {
    pollFailureCount += 1;
    return Math.min(30000, 1000 * Math.pow(2, Math.min(5, pollFailureCount - 1)));
  }

  function reconcileCompletedJob(generation, successMessage) {
    if (!jobTracking || generation !== jobTrackingGeneration) return;
    var callback = jobRefreshArtwork;
    fetchSnapshot().then(function () {
      if (!jobTracking || generation !== jobTrackingGeneration) return false;
      return safeRefreshArtwork(callback);
    }).then(function (loaded) {
      if (!jobTracking || generation !== jobTrackingGeneration) return;
      if (loaded === false) {
        var pending = new Error('Bird artwork is still loading.');
        pending.bundleArtwork = true;
        throw pending;
      }
      setBusy(false);
      announce(successMessage || 'Bird bundle updated.', false);
      stopPolling();
    }).catch(function (error) {
      if (!jobTracking || generation !== jobTrackingGeneration) return;
      if (Date.now() < pollReconcileDeadline) {
        pollTimer = global.setTimeout(function () {
          reconcileCompletedJob(generation, successMessage);
        }, backgroundRetryDelay());
        return;
      }
      reportFailure(error);
      stopPolling();
    });
  }

  function pollJob() {
    if (!jobTracking || !pollDeadline) return;
    var generation = jobTrackingGeneration;
    fetch(API_URL + '?action=status', { credentials: 'same-origin', cache: 'no-store' })
      .then(responseJson)
      .then(function (body) {
        if (!jobTracking || generation !== jobTrackingGeneration) return;
        pollFailureCount = 0;
        var job = ownRecord(body.job) ? body.job : null;
        if (jobTrackingId && (!job || job.id !== jobTrackingId)) {
          // Jobs are station-wide. If another tab or manager superseded ours,
          // never attribute its progress or failure to the user's selection.
          // Reconcile the station's authoritative active identity instead.
          clearTimeout(pollTimer);
          pollTimer = 0;
          reconcileCompletedJob(generation, 'Bird bundle refreshed.');
          return;
        }
        if (job && job.state === 'failed') {
          var failed = new Error(cleanName(job.error, 'The bundle could not be used.'));
          failed.bundleJobTerminal = true;
          throw failed;
        }
        if (job && job.state === 'running') {
          if (Date.now() >= pollDeadline) {
            if (Date.now() >= pollReconcileDeadline) {
              var expired = new Error('This bundle is still being prepared. Open Settings later to check it.');
              expired.bundleJobTerminal = true;
              throw expired;
            }
            if (!pollIsSlow) {
              pollIsSlow = true;
              announce('This bundle is taking longer than expected. It will keep loading in the background.', true);
            }
            pollTimer = global.setTimeout(pollJob, 5000);
            return;
          }
          var phase = cleanName(job.phase, 'updating');
          announce(phase + (Number.isFinite(job.percent) ? ' ' + Math.max(0, Math.min(100, job.percent)) + '%' : ''), false);
          pollTimer = global.setTimeout(pollJob, 800);
          return;
        }
        if (!job || job.state !== 'succeeded') {
          throw new Error('The bundle update status is unavailable. Check again in a moment.');
        }
        clearTimeout(pollTimer);
        pollTimer = 0;
        reconcileCompletedJob(generation);
      })
      .catch(function (error) {
        if (!jobTracking || generation !== jobTrackingGeneration) return;
        if (!(error && error.bundleJobTerminal) && Date.now() < pollReconcileDeadline) {
          pollTimer = global.setTimeout(pollJob, backgroundRetryDelay());
          return;
        }
        reportFailure(error);
        stopPolling();
      });
  }

  function startPolling(callback, jobId) {
    stopPolling();
    pollDeadline = Date.now() + 5 * 60 * 1000;
    pollReconcileDeadline = Date.now() + 4 * 60 * 60 * 1000;
    pollIsSlow = false;
    pollFailureCount = 0;
    jobTracking = true;
    jobTrackingId = typeof jobId === 'string' && JOB_ID_PATTERN.test(jobId) ? jobId : '';
    jobRefreshArtwork = typeof callback === 'function' ? callback : refreshArtwork;
    setBusy(true);
    pollTimer = global.setTimeout(pollJob, 450);
  }

  function allowedUsePack(id) {
    if (!ID_PATTERN.test(id)) return null;
    return packsFrom(snapshot).find(function (pack) {
      return pack.id === id && packCanBeUsed(pack);
    }) || null;
  }

  function packCanBeUsed(pack) {
    if (!ownRecord(pack)) return false;
    if (pack.included === true) return true;
    if (pack.installed === true && typeof pack.activation_version === 'string' &&
        pack.activation_version.length > 0 && pack.activation_version.length <= 64) return true;
    return pack.catalog_current !== false && pack.availability === 'installable';
  }

  function useBundle(id) {
    if (!allowedUsePack(id)) {
      announce('That bundle is not available for this station.', true);
      return;
    }
    setBusy(true);
    announce('Preparing bird bundle.', false);
    var artworkCallback = refreshArtwork;
    fetch(API_URL, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Avian-Action': '1' },
      body: JSON.stringify({ action: 'use', id: id })
    }).then(responseJson).then(function (body) {
      requestClose();
      if (body.unchanged === true || !body.job) {
        stopPolling();
        return fetchSnapshot().then(function () { return safeRefreshArtwork(artworkCallback); }).then(function () {
          setBusy(false);
          announce('Bird bundle selected.', false);
        }).catch(function (error) {
          reportFailure(error);
        });
      }
      startPolling(artworkCallback, ownRecord(body.job) ? body.job.id : '');
    }).catch(function (error) {
      setBusy(false);
      announce(error.message, true);
      // The error copy lives in the Settings row, so return focus there rather
      // than leaving a seemingly inert catalog over the actionable message.
      requestClose();
    });
  }

  function freshHandoff() {
    if (!global.crypto || typeof global.crypto.getRandomValues !== 'function') return '';
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }

  function installedIds() {
    var ids = [];
    var seen = Object.create(null);
    var packs = packsFrom(snapshot);
    var known = Object.create(null);
    packs.forEach(function (pack) { known[pack.id] = true; });
    var active = activeRecord(snapshot);
    if (active && known[active.id]) {
      seen[active.id] = true;
      ids.push(active.id);
    }
    var records = ownRecord(snapshot) && ownRecord(snapshot.library) && Array.isArray(snapshot.library.installed)
      ? snapshot.library.installed : [];
    records.slice(0, 1000).forEach(function (record) {
      var id = ownRecord(record) && typeof record.id === 'string' ? record.id : '';
      if (ID_PATTERN.test(id) && known[id] && !seen[id] && ids.length < 100) {
        seen[id] = true;
        ids.push(id);
      }
    });
    return ids.slice(0, 100);
  }

  function installableIds() {
    var ids = [];
    packsFrom(snapshot).forEach(function (pack) {
      if (ids.length < 100 && packCanBeUsed(pack)) ids.push(pack.id);
    });
    return ids;
  }

  function presentationText(value, limit, fallback) {
    if (typeof value !== 'string') return fallback;
    var cleaned = value.replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return fallback;
    return Array.from(cleaned).slice(0, limit).join('');
  }

  function presentationRegionGroup(value) {
    var group = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z]+/g, ' ').trim() : '';
    if (group.indexOf('north america') >= 0) return 'North America';
    if (group.indexOf('south america') >= 0) return 'South America';
    if (group.indexOf('europe') >= 0) return 'Europe';
    if (group.indexOf('africa') >= 0) return 'Africa';
    if (group.indexOf('asia') >= 0) return 'Asia';
    if (group.indexOf('oceania') >= 0 || group.indexOf('australia') >= 0) return 'Oceania';
    return 'Other';
  }

  function installedPackPresentations(ids) {
    var packs = packsFrom(snapshot);
    return ids.map(function (id) {
      var pack = packs.find(function (candidate) { return candidate.id === id; }) || {};
      var activationVersion = pack.included === true ? pack.version : pack.activation_version;
      var presentation = ownRecord(pack.activation_presentation) &&
        pack.activation_presentation.version === activationVersion
        ? pack.activation_presentation : pack;
      var style = ownRecord(presentation.style) ? presentation.style : {};
      var coverage = ownRecord(presentation.coverage) ? presentation.coverage : {};
      var species = Number.isInteger(presentation.species_count) && presentation.species_count >= 0 && presentation.species_count <= 10000
        ? presentation.species_count : null;
      var archiveBytes = Number.isSafeInteger(presentation.archive_bytes) && presentation.archive_bytes > 0
        ? presentation.archive_bytes
        : (Number.isSafeInteger(presentation.bytes) && presentation.bytes > 0 ? presentation.bytes : null);
      var styleId = typeof style.id === 'string' && STYLE_PATTERN.test(style.id) ? style.id : DEFAULT_STYLE;
      return {
        id: id,
        name: presentationText(presentation.name, 90, id),
        region: presentationText(coverage.label, 90, 'Other'),
        regionGroup: presentationRegionGroup(coverage.group),
        style: presentationText(style.name, 60, 'Illustrated'),
        styleId: styleId,
        species: species,
        contributor: presentationText(presentation.creator, 60, 'Unknown'),
        official: presentation.review === 'official' || presentation.review === 'maintainer',
        version: presentationText(activationVersion, 64, '0.0.0'),
        license: presentationText(presentation.license, 60, 'Not listed'),
        archiveBytes: archiveBytes
      };
    });
  }

  function postToFrame(type, detail) {
    if (!frame || !frame.contentWindow || !handoff) return;
    var message = { v: 1, type: type, handoff: handoff };
    Object.keys(detail || {}).forEach(function (key) { message[key] = detail[key]; });
    // sandbox="allow-scripts" gives the child an intentionally opaque origin,
    // so '*' is required here. The child authenticates this parent by its real
    // event.origin, WindowProxy, version, and the 128-bit one-use handoff.
    frame.contentWindow.postMessage(message, '*');
  }

  function sendTheme() {
    postToFrame('avianvisitors:bundle-theme', { theme: currentTheme() });
  }

  function sendLibrary() {
    var ids = installedIds();
    var installedPacks = installedPackPresentations(ids);
    var active = activeRecord(snapshot);
    var activeCatalogPack = active && packsFrom(snapshot).find(function (pack) {
      return pack.id === active.id;
    });
    var selectedVersion = activeCatalogPack && activeCatalogPack.included === true
      ? activeCatalogPack.version
      : (activeCatalogPack ? activeCatalogPack.activation_version : null);
    var activeId = active && ids.indexOf(active.id) >= 0 && active.version === selectedVersion
      ? active.id : '';
    postToFrame('avianvisitors:bundle-library', {
      ids: ids,
      activeId: activeId,
      installableIds: installableIds(),
      installedPacks: installedPacks
    });
  }

  function onFrameMessage(event) {
    if (!dialog || !dialog.open || closing || !frame || event.source !== frame.contentWindow ||
        event.origin !== 'null' || !ownRecord(event.data) || event.data.v !== 1 ||
        event.data.handoff !== handoff) return;
    var data = event.data;
    if (data.type === 'avianvisitors:bundle-library-request' &&
        exactKeys(data, ['v', 'type', 'handoff'])) {
      sendLibrary();
      return;
    }
    if (data.type === 'avianvisitors:bundle-install' &&
        exactKeys(data, ['v', 'type', 'handoff', 'id']) && typeof data.id === 'string') {
      useBundle(data.id);
      return;
    }
    if (data.type === 'avianvisitors:bundle-close' &&
        exactKeys(data, ['v', 'type', 'handoff'])) {
      requestClose();
      return;
    }
  }

  function releaseDrawerPointer() {
    var pointerId = drawer.pointerId;
    drawer.pointerId = null;
    if (pointerId === null || !handle || typeof handle.releasePointerCapture !== 'function') return;
    try {
      if (!handle.hasPointerCapture || handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    } catch (_) {}
  }

  function resetDrawer() {
    clearTimeout(drawer.resetTimer);
    clearTimeout(drawer.captureLossTimer);
    drawer.resetTimer = 0;
    drawer.captureLossTimer = 0;
    releaseDrawerPointer();
    drawer.startY = 0;
    drawer.dragY = 0;
    drawer.lastY = 0;
    drawer.lastTime = 0;
    drawer.velocityY = 0;
    drawer.moved = false;
    drawer.suppressClickUntil = 0;
    if (sheet) {
      sheet.classList.remove('is-drawer-dragging', 'is-drawer-closing');
      sheet.style.removeProperty('--bundle-drawer-y');
    }
  }

  function settleDrawer() {
    if (!sheet) return;
    sheet.classList.remove('is-drawer-dragging');
    void sheet.offsetWidth;
    sheet.style.setProperty('--bundle-drawer-y', '0px');
    drawer.resetTimer = global.setTimeout(function () {
      drawer.resetTimer = 0;
      if (drawer.pointerId === null && sheet && !sheet.classList.contains('is-drawer-closing')) {
        sheet.style.removeProperty('--bundle-drawer-y');
      }
    }, 320);
  }

  function startDrawer(event) {
    if (!dialog || !dialog.open || !handle || (mobile && !mobile.matches)) return;
    if (drawer.pointerId !== null || event.isPrimary === false) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearTimeout(drawer.resetTimer);
    clearTimeout(drawer.captureLossTimer);
    drawer.resetTimer = 0;
    drawer.captureLossTimer = 0;
    drawer.pointerId = event.pointerId;
    drawer.startY = event.clientY;
    drawer.dragY = 0;
    drawer.lastY = 0;
    drawer.lastTime = performance.now();
    drawer.velocityY = 0;
    drawer.moved = false;
    drawer.suppressClickUntil = 0;
    sheet.classList.remove('is-drawer-closing');
    sheet.classList.add('is-drawer-dragging');
    sheet.style.setProperty('--bundle-drawer-y', '0px');
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
  }

  function moveDrawer(event) {
    if (drawer.pointerId !== event.pointerId) return;
    var now = performance.now();
    var dragY = Math.max(0, Math.min(global.innerHeight, event.clientY - drawer.startY));
    var elapsed = Math.max(1, now - drawer.lastTime);
    var instantVelocity = (dragY - drawer.lastY) / elapsed;
    drawer.velocityY = drawer.velocityY * .55 + instantVelocity * .45;
    drawer.dragY = dragY;
    drawer.lastY = dragY;
    drawer.lastTime = now;
    if (Math.abs(event.clientY - drawer.startY) > 5) drawer.moved = true;
    if (sheet) sheet.style.setProperty('--bundle-drawer-y', dragY.toFixed(1) + 'px');
    if (event.cancelable) event.preventDefault();
  }

  function finishDrawer(event, cancelled) {
    if (drawer.pointerId !== event.pointerId) return;
    clearTimeout(drawer.captureLossTimer);
    drawer.captureLossTimer = 0;
    var now = performance.now();
    if (!cancelled) {
      var dragY = Math.max(0, Math.min(global.innerHeight, event.clientY - drawer.startY));
      var elapsed = Math.max(1, now - drawer.lastTime);
      var finalDelta = dragY - drawer.lastY;
      if (elapsed <= 90 && Math.abs(finalDelta) > .5) {
        var instantVelocity = finalDelta / elapsed;
        drawer.velocityY = drawer.velocityY * .55 + instantVelocity * .45;
      } else if (elapsed > 90) {
        drawer.velocityY = 0;
      }
      drawer.dragY = dragY;
      if (Math.abs(event.clientY - drawer.startY) > 5) drawer.moved = true;
    }
    var sheetHeight = sheet ? sheet.getBoundingClientRect().height : global.innerHeight;
    var distanceThreshold = Math.min(150, Math.max(88, sheetHeight * .18));
    var fastEnough = drawer.dragY >= 28 && drawer.velocityY >= .7;
    var farEnough = drawer.dragY >= distanceThreshold;
    var shouldClose = !cancelled && (farEnough || fastEnough);
    if (drawer.moved) drawer.suppressClickUntil = now + 650;
    releaseDrawerPointer();
    if (shouldClose) {
      requestClose(true);
      return;
    }
    settleDrawer();
  }

  function deferLostCapture(event) {
    if (drawer.pointerId !== event.pointerId) return;
    clearTimeout(drawer.captureLossTimer);
    var pointerId = event.pointerId;
    drawer.captureLossTimer = global.setTimeout(function () {
      drawer.captureLossTimer = 0;
      if (drawer.pointerId === pointerId) finishDrawer({ pointerId: pointerId }, true);
    }, 32);
  }

  function teardownDialog(restoreFocus) {
    clearTimeout(closeTimer);
    closeTimer = 0;
    resetDrawer();
    if (themeObserver) themeObserver.disconnect();
    themeObserver = null;
    global.removeEventListener('message', onFrameMessage);
    global.removeEventListener('pointermove', moveDrawer);
    global.removeEventListener('pointerup', onDrawerUp);
    global.removeEventListener('pointercancel', onDrawerCancel);
    if (frame) frame.src = 'about:blank';
    if (dialog && dialog.open) dialog.close();
    if (dialog) dialog.remove();
    document.body.classList.remove('bundle-browser-open');
    dialog = null;
    sheet = null;
    frame = null;
    handle = null;
    handoff = '';
    backdropPointer = null;
    closing = false;
    if (restoreFocus && returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }

  function requestClose(fromDrawer) {
    if (!dialog || !dialog.open || closing) return;
    closing = true;
    // Invalidate the capability before the exit animation. A stale frame can
    // no longer select a bundle even while its final pixels are still visible.
    handoff = freshHandoff();
    dialog.classList.remove('is-open');
    dialog.classList.add('is-closing');
    if (sheet && ((mobile && mobile.matches) || fromDrawer)) {
      sheet.classList.remove('is-drawer-dragging');
      sheet.classList.add('is-drawer-closing');
    }
    var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer = global.setTimeout(function () { teardownDialog(true); }, reduced ? 0 : ((mobile && mobile.matches) ? 280 : 210));
  }

  function onDrawerUp(event) { finishDrawer(event, false); }
  function onDrawerCancel(event) { finishDrawer(event, true); }

  function frameUrl() {
    var url = new URL(FRAME_URL, global.location.href);
    url.searchParams.set('embed', '1');
    url.searchParams.set('handoff', handoff);
    url.searchParams.set('parentOrigin', global.location.origin);
    url.searchParams.set('theme', currentTheme());
    if (stationRegion) url.searchParams.set('region', stationRegion);
    var style = activeStyle();
    if (requestedPackId) {
      var requested = packsFrom(snapshot).find(function (pack) { return pack.id === requestedPackId; });
      var requestedStyle = requested && ownRecord(requested.style) ? requested.style.id : '';
      if (typeof requestedStyle === 'string' && STYLE_PATTERN.test(requestedStyle)) style = requestedStyle;
    }
    if (style) url.searchParams.set('style', style);
    return url.toString();
  }

  function openDialog() {
    if (!mounted || dialog) return;
    handoff = freshHandoff();
    if (!handoff) {
      announce('This browser cannot securely open the bundle catalog.', true);
      return;
    }
    closing = false;
    returnFocus = document.activeElement || trigger;
    dialog = document.createElement('dialog');
    dialog.className = 'bundle-browser-dialog';
    dialog.setAttribute('aria-label', 'Browse bird bundles');
    dialog.innerHTML = ''
      + '<section class="bundle-browser-sheet">'
      + '  <button class="bundle-browser-handle" type="button" aria-label="Close bundle catalog"><span aria-hidden="true"></span></button>'
      + '  <iframe class="bundle-browser-frame" title="Bundle catalog" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>'
      + '  <a class="bundle-browser-open-full" href="' + CATALOG_URL + '" target="_blank" rel="noopener noreferrer" aria-label="Open full catalog" aria-describedby="bundle-browser-open-full-tip">'
      + '    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.25 12.75 12.5 3.5M6 3.5h6.5V10"></path></svg>'
      + '    <span class="bundle-browser-open-full-tip" id="bundle-browser-open-full-tip" role="tooltip">Open full catalog</span>'
      + '  </a>'
      + '</section>';
    document.body.appendChild(dialog);
    sheet = dialog.querySelector('.bundle-browser-sheet');
    frame = dialog.querySelector('.bundle-browser-frame');
    handle = dialog.querySelector('.bundle-browser-handle');
    frame.src = frameUrl();

    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      requestClose();
    });
    dialog.addEventListener('pointerdown', function (event) {
      backdropPointer = event.target === dialog ? event.pointerId : null;
    });
    dialog.addEventListener('pointerup', function (event) {
      var close = event.target === dialog && backdropPointer === event.pointerId;
      backdropPointer = null;
      if (close) requestClose();
    });
    dialog.addEventListener('pointercancel', function () { backdropPointer = null; });
    frame.addEventListener('load', function () {
      sendTheme();
      sendLibrary();
    });
    handle.addEventListener('pointerdown', startDrawer);
    handle.addEventListener('lostpointercapture', deferLostCapture);
    handle.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    });
    handle.addEventListener('click', function (event) {
      var pointerClick = event.detail !== 0;
      if (pointerClick && performance.now() < drawer.suppressClickUntil) {
        drawer.suppressClickUntil = 0;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    });
    global.addEventListener('pointermove', moveDrawer, { passive: false });
    global.addEventListener('pointerup', onDrawerUp);
    global.addEventListener('pointercancel', onDrawerCancel);
    global.addEventListener('message', onFrameMessage);
    themeObserver = new MutationObserver(function (records) {
      if (records.some(function (record) { return record.attributeName === 'data-theme'; })) sendTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    document.body.classList.add('bundle-browser-open');
    dialog.showModal();
    requestAnimationFrame(function () {
      if (!dialog || !dialog.open) return;
      dialog.classList.add('is-open');
      // Focus the browsing surface itself. The mobile handle remains keyboard
      // reachable without painting a full-width focus rectangle on open.
      frame.focus({ preventScroll: true });
    });
  }

  function requestedBundleFromUrl() {
    try {
      var url = new URL(global.location.href);
      var values = url.searchParams.getAll('bundle');
      var id = values.length === 1 && ID_PATTERN.test(values[0]) ? values[0] : '';
      if (values.length) {
        url.searchParams.delete('bundle');
        global.history.replaceState(global.history.state, '', url.pathname + url.search + url.hash);
      }
      return id;
    } catch (_) { return ''; }
  }

  function mount(options) {
    unmount();
    options = options || {};
    root = options.root || document;
    trigger = root.querySelector('[data-bundle-browser-open]');
    if (!trigger) return;
    currentName = root.querySelector('[data-bundle-current]');
    note = root.querySelector('[data-bundle-note]');
    live = root.querySelector('[data-bundle-live]');
    refreshArtwork = options.refreshArtwork || null;
    stationRegion = broadRegionForCoordinates(options.latitude, options.longitude);
    mounted = true;
    trigger.addEventListener('click', openDialog);
    requestedPackId = requestedBundleFromUrl();
    fetchSnapshot().then(function () {
      var job = ownRecord(snapshot) && ownRecord(snapshot.job) ? snapshot.job : null;
      if (job && job.state === 'running' && !jobTracking) startPolling(null, job.id);
      return safeRefreshArtwork();
    }).catch(function (error) {
      if (error && error.name === 'AbortError') throw error;
      reportFailure(error);
      return false;
    }).then(function () {
      if (requestedPackId) openDialog();
    }).catch(function (error) {
      if (error && error.name === 'AbortError') return;
      // The included artwork remains a valid fallback on first boot or while
      // an older station is still receiving the bundle service update.
      snapshot = null;
      if (requestedPackId) openDialog();
    });
  }

  function unmount() {
    mounted = false;
    // A station-level install can finish after the user leaves Settings. Keep
    // its tiny status watcher and exact artwork callback alive so the visible
    // collage moves to the activated revision without requiring a reload.
    if (!jobTracking) {
      stopPolling();
      if (requestController) requestController.abort();
      requestController = null;
    }
    if (trigger) trigger.removeEventListener('click', openDialog);
    if (dialog) teardownDialog(false);
    root = null;
    trigger = null;
    currentName = null;
    note = null;
    live = null;
    snapshot = null;
    refreshArtwork = null;
    requestedPackId = '';
    stationRegion = '';
  }

  global.AVIAN_BUNDLES = {
    rowMarkup: rowMarkup,
    mount: mount,
    unmount: unmount
  };
})(window);

(() => {
  "use strict";

  const CATALOG_URL = "/catalog/bundles-v1.json";
  const PUBLIC_CATALOG_URL = "https://avianvisitors.com/catalog/bundles-v1.json";
  const COMMUNITY_CATALOG_URL = "/api/bundles/catalog/discovery-v1.json";
  const PUBLIC_COMMUNITY_CATALOG_URL =
    "https://avianvisitors.com/api/bundles/catalog/discovery-v1.json";
  const PUBLIC_ASSET_ORIGIN = "https://avianvisitors.com";
  // The vendor step rewrites only this runtime prefix. Keeping the canonical
  // input prefix assembled below lets an opaque station frame consume the live
  // public catalog while resolving its checked-in preview copies locally.
  const LOCAL_PREVIEW_PREFIX = "/assets/bundle-catalog/bundle-previews/";
  const CANONICAL_PREVIEW_PREFIX = "/" + "bundle-previews/";
  const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
  const MAX_BUNDLE_OBJECT_BYTES = 4 * 1024 * 1024;
  const MAX_SCIENTIFIC_NAME_CODE_POINTS = 163;
  const MAX_LOOSE_PNG_FILENAME_CODE_POINTS = MAX_SCIENTIFIC_NAME_CODE_POINTS + 6;
  const MAX_STYLE_NAME_CODE_POINTS = 80;
  const MAX_BUNDLE_VERSION_CODE_POINTS = 40;
  const MAX_CATALOG_PACKS = 1000;
  const LEGACY_REPOSITORY_PACK_IDS = new Set([
    "community-florida-us-woodblock",
    "community-switzerland-woodblock",
    "community-germany-woodblock",
    "community-iberian-peninsula-woodblock",
    "community-derbyshire-woodblock",
    "community-england-woodblock",
    "community-netherlands-woodblock",
    "community-victoria-australia-woodblock",
    "community-canberra-act-woodblock",
  ]);
  const STYLE_CATEGORIES = ["Traditional", "Painterly", "Photographic", "Graphic", "Experimental", "Other"];
  const STYLE_SEARCH = {
    Traditional: "calm classic quiet timeless print",
    Painterly: "soft textured lush painted brush",
    Photographic: "natural realistic detailed photo",
    Graphic: "bold clean colorful minimal poster vector",
    Experimental: "energetic loose playful strange abstract sketch scribble",
    Other: "",
  };
  const STYLE_EDITORIAL = {
    "japanese-woodblock": {
      style: "Sparse kach\u014d-e-inspired birds use flat color, confident ink contours, restrained earth tones, and generous negative space. Diagnostic plumage stays legible without becoming field-guide realism.",
      method: "Gemini 2.5 Flash Image worked from species photographed and selected print references. BiRefNet removed the cream ground, then species-specific corrections and human curation refined the set.",
    },
    "evolutionary-impressionist": {
      style: "Loose, bright gestures trade feather-by-feather detail for motion, silhouette, and flashes of plumage color. A fine outer contour holds each bird together while overlapping strokes create its deliberately energetic character.",
      method: "Built on Matt DesLauriers’s work, Synthetic Gestures: An Evolutionary Sketching Machine; SIREN paths evolved with sNES while CLIP compared each bird with its Japanese Woodblock cutout before human review.",
    },
  };
  const REGION_COUNTRIES = {
    "North America": "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MX NI PA PM PR SV SX TC TT US VC VG VI",
    "South America": "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
    Europe: "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
    Africa: "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
    Asia: "AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
    Oceania: "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS",
  };
  const params = new URLSearchParams(location.search);
  const embedded = params.get("embed") === "1";
  const handoff = /^[0-9a-f]{32}$/.test(params.get("handoff") || "") ? params.get("handoff") : "";
  const parentOrigin = (() => {
    try {
      const value = params.get("parentOrigin") || location.origin;
      const parsed = new URL(value);
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === value
        ? value : "";
    } catch (_) { return ""; }
  })();
  const shareRequested = params.get("share") === "1" && !embedded;
  const loopbackHost = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  const localContributionPreview = loopbackHost;
  if (shareRequested) {
    const draft = {};
    for (const [key, limit] of Object.entries({
      name: 72, region: 72, group: 20, style: 48, category: 30, count: 6, license: 30,
      method: 12, model: 100, creator: 100, source: 300,
    })) {
      draft[key] = String(params.get(key) || "").replace(/[<>\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
    }
    try { sessionStorage.setItem("avian:bundle-share-draft", JSON.stringify(draft)); } catch (_) { }
    const clean = new URL(location.href);
    for (const key of ["share", "name", "region", "group", "style", "category", "count", "license", "method", "model", "creator", "source"]) {
      clean.searchParams.delete(key);
    }
    history.replaceState(null, "", clean.pathname + clean.search);
  }
  if (embedded) document.documentElement.classList.add("embed");

  const official = [
    {
      id: "official-western-us-woodblock",
      styleId: "japanese-woodblock",
      name: "Japanese Woodblock",
      region: "Western North America",
      regionGroup: "North America",
      regionCodes: ["US-W"],
      style: "Japanese Woodblock",
      styleCategory: "Traditional",
      styleTags: ["calm", "classic", "ink", "japanese", "minimal", "printmaking", "quiet", "woodblock"],
      searchTerms: ["western united states", "western canada", "west coast"],
      species: 333,
      contributor: "Avian Visitors",
      sourceUrl: "https://github.com/Twarner491/AvianVisitors",
      official: true,
      localStyle: "woodblock",
      availability: "installable",
      installable: true,
      manifestUrl: "https://avianvisitors.com/api/bundles/manifests/31fcb450f517acb2ea26b1c559cc3aad1696f583587209bd2a43058d8e6803e1.json",
      manifestSha256: "31fcb450f517acb2ea26b1c559cc3aad1696f583587209bd2a43058d8e6803e1",
      previewUrl: "/assets/bundle-catalog/bundle-previews/woodblock-corvus-brachyrhynchos.png",
      previews: [
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-woodblock-0.png", commonName: "Steller's Jay", scientificName: "Cyanocitta stelleri" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-woodblock-1.png", commonName: "Anna's Hummingbird", scientificName: "Calypte anna" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-woodblock-2.png", commonName: "Great Blue Heron", scientificName: "Ardea herodias" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-woodblock-3.png", commonName: "Western Tanager", scientificName: "Piranga ludoviciana" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-woodblock-4.png", commonName: "Northern Flicker", scientificName: "Colaptes auratus" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-woodblock-5.png", commonName: "Barn Owl", scientificName: "Tyto alba" },
      ],
      version: "1.0.0",
      license: "CC-BY-NC-SA-4.0",
      archiveBytes: 438672342,
      note: "The original hand-reviewed Avian Visitors illustration set.",
    },
    {
      id: "official-western-us-impressionist",
      styleId: "evolutionary-impressionist",
      name: "Western North America Evolutionary Impressionist",
      region: "Western North America",
      regionGroup: "North America",
      regionCodes: ["US-W"],
      style: "Evolutionary Impressionist",
      styleCategory: "Experimental",
      styleTags: ["drawing", "energetic", "evolved", "expressive", "gestural", "loose", "scribble", "sketch"],
      searchTerms: ["western united states", "western canada", "west coast"],
      species: 333,
      contributor: "Avian Visitors",
      sourceUrl: "https://github.com/Twarner491/AvianVisitors",
      official: true,
      localStyle: "",
      availability: "installable",
      installable: true,
      manifestUrl: "https://avianvisitors.com/api/bundles/manifests/9d071dba2ef81084d483374a13c852785faa64898b9db461e7b28abb4c7d426b.json",
      manifestSha256: "9d071dba2ef81084d483374a13c852785faa64898b9db461e7b28abb4c7d426b",
      previewUrl: "/assets/bundle-catalog/bundle-previews/impressionist-corvus-brachyrhynchos.png",
      previews: [
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-impressionist-0.png", commonName: "Steller's Jay", scientificName: "Cyanocitta stelleri" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-impressionist-1.png", commonName: "Anna's Hummingbird", scientificName: "Calypte anna" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-impressionist-2.png", commonName: "Great Blue Heron", scientificName: "Ardea herodias" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-impressionist-3.png", commonName: "Western Tanager", scientificName: "Piranga ludoviciana" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-impressionist-4.png", commonName: "Northern Flicker", scientificName: "Colaptes auratus" },
        { url: "/assets/bundle-catalog/bundle-previews/official-western-us-impressionist-5.png", commonName: "Barn Owl", scientificName: "Tyto alba" },
      ],
      version: "1.0.0",
      license: "CC-BY-NC-SA-4.0",
      archiveBytes: 298432679,
      note: "333 species for Western North America.",
    },
  ];

  const catalog = document.querySelector("#bundle-catalog");
  const state = document.querySelector("#catalog-state");
  const search = document.querySelector("#bundle-search");
  const searchWrap = document.querySelector("#catalog-search-wrap");
  const searchGuidance = document.querySelector("#search-guidance");
  const searchProgress = document.querySelector("#search-progress");
  const regionFilter = document.querySelector("#region-filter");
  const catalogShell = document.querySelector("#catalog-shell");
  const shareOpen = document.querySelector("#share-open");
  const shareReveal = document.querySelector("#share-panel");
  const shareGithubMark = shareOpen.querySelector(".github-mark").cloneNode(true);
  let bundles = official;
  let discoveredBundles = official;
  let installedPackPresentations = [];
  let stationRegion = cleanText(params.get("region"), 60);
  let catalogError = "";
  let openBundleId = embedded && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(params.get("style") || "")
    ? params.get("style") : "";
  const installedPackIds = new Set();
  const installablePackIds = new Set();
  let activePackId = "";
  const regionScrollControllers = new Set();
  const INSTALLED_PACK_KEYS = [
    "id", "name", "region", "regionGroup", "style", "styleId", "species",
    "contributor", "official", "version", "license", "archiveBytes",
  ];
  const PUBLIC_REGION_GROUPS = new Set([
    "North America", "South America", "Europe", "Africa", "Asia", "Oceania", "Other",
  ]);

  function slug(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }

  function cleanText(value, max = 100) {
    const cleaned = String(value || "").replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return Array.from(cleaned).slice(0, max).join("");
  }

  function strictBundleVersion(value) {
    const version = typeof value === "string" ? value : "";
    const match = version.length <= MAX_BUNDLE_VERSION_CODE_POINTS && version.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
    );
    if (!match) return "";
    if (match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return "";
    return version;
  }

  function exactMessage(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function asciiCompare(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function hasLoneSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    }
    return false;
  }

  function exactCommonName(value) {
    return typeof value === "string" && Array.from(value).length <= 100 &&
      !hasLoneSurrogate(value) && !/[<>\u0000-\u001f]/.test(value)
      ? value : "";
  }

  function exactPublicText(value, max, required = false) {
    return typeof value === "string" && (!required || value.length > 0) &&
      Array.from(value).length <= max && !hasLoneSurrogate(value) &&
      !/[<>\u0000-\u001f\u007f]/.test(value);
  }

  function exactNewIntakeText(value, max, required = false) {
    return exactPublicText(value, max, required) && (!required || value.trim().length > 0);
  }

  function installedPackPresentation(value) {
    if (!exactMessage(value, INSTALLED_PACK_KEYS) ||
        typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.id) ||
        !exactPublicText(value.name, 90, true) ||
        !exactPublicText(value.region, 90, true) || !PUBLIC_REGION_GROUPS.has(value.regionGroup) ||
        !exactPublicText(value.style, MAX_STYLE_NAME_CODE_POINTS, true) || typeof value.styleId !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.styleId) ||
        !(value.species === null || (Number.isInteger(value.species) && value.species >= 0 && value.species <= 10000)) ||
        !exactPublicText(value.contributor, 60, true) || typeof value.official !== "boolean" ||
        !exactPublicText(value.version, MAX_BUNDLE_VERSION_CODE_POINTS, true) ||
        !exactPublicText(value.license, 60, true) ||
        !(value.archiveBytes === null || (Number.isSafeInteger(value.archiveBytes) && value.archiveBytes > 0))) {
      return null;
    }
    return {
      id: value.id,
      name: value.name,
      region: value.region,
      regionGroup: value.regionGroup,
      regionCodes: [],
      postalCodes: [],
      style: value.style,
      styleId: value.styleId,
      styleCategory: inferStyleCategory(value.style),
      styleTags: [],
      searchTerms: [],
      species: value.species,
      contributor: value.contributor,
      contributorLogin: "",
      sourceUrl: "",
      official: value.official,
      localStyle: "",
      availability: "unavailable",
      installable: false,
      previewUrl: "",
      previewGeometry: null,
      manifestSha256: "",
      previews: [],
      version: value.version,
      license: value.license,
      archiveBytes: value.archiveBytes,
      note: "",
    };
  }

  function rebuildBundles() {
    const installedById = new Map(installedPackPresentations.map((pack) => [pack.id, pack]));
    const hostedBundles = discoveredBundles.filter((pack) => pack.installable);
    const seen = new Set(hostedBundles.map((pack) => pack.id));
    bundles = hostedBundles.map((pack) => {
      const installed = installedById.get(pack.id);
      const matchingPreviewVersion = installed && installed.version === pack.version;
      // Use only the station's bounded facts for the exact verified local
      // revision this downloaded ID will activate. Discovery artwork is safe
      // to reuse only when it describes that same immutable version.
      return installed ? {
        ...pack,
        name: installed.name,
        region: installed.region,
        regionGroup: installed.regionGroup,
        style: installed.style,
        styleId: installed.styleId,
        styleCategory: inferStyleCategory(installed.style),
        styleTags: [],
        searchTerms: [],
        species: installed.species,
        contributor: installed.contributor,
        contributorLogin: matchingPreviewVersion ? pack.contributorLogin : "",
        official: installed.official,
        version: installed.version,
        license: installed.license,
        archiveBytes: installed.archiveBytes,
        note: "",
        previewUrl: matchingPreviewVersion ? pack.previewUrl : "",
        previewGeometry: matchingPreviewVersion ? pack.previewGeometry : null,
        manifestSha256: matchingPreviewVersion ? pack.manifestSha256 : "",
        previews: matchingPreviewVersion ? pack.previews : [],
      } : pack;
    });
    installedPackPresentations.forEach((pack) => {
      if (seen.has(pack.id)) return;
      seen.add(pack.id);
      bundles.push(pack);
    });
  }

  function safeSourceUrl(value) {
    try {
      if (typeof value !== "string" || value.indexOf("\\") >= 0 ||
          /[<>\u0000-\u001f\u007f]/.test(value)) return "";
      const url = new URL(value);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return "";
      return url.toString().slice(0, 300);
    } catch (_) {
      return "";
    }
  }

  function safeManifestUrl(value, sha256) {
    try {
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(String(sha256 || "")) ||
          value.indexOf("\\") >= 0 || /[<>\u0000-\u001f\u007f]/.test(value)) return "";
      const url = new URL(value);
      const match = url.pathname.match(/^\/api\/bundles\/manifests\/([0-9a-f]{64})\.json$/);
      return url.protocol === "https:" && !url.port && url.hostname === "avianvisitors.com" &&
        !url.username && !url.password && !url.search && !url.hash && match?.[1] === sha256
        ? url.toString() : "";
    } catch (_) {
      return "";
    }
  }

  function catalogBundle(pack) {
    const coverage = pack.coverage || {};
    const style = pack.style || {};
    const packId = cleanText(pack.id, 90);
    const category = STYLE_CATEGORIES.includes(cleanText(style.category, 30))
      ? cleanText(style.category, 30) : inferStyleCategory(style.name);
    const manifestSha256 = /^[0-9a-f]{64}$/.test(String(pack.manifest?.sha256 || ""))
      ? pack.manifest.sha256 : "";
    const manifestUrl = safeManifestUrl(pack.manifest?.url, manifestSha256);
    const previewGeometry = safePreviewGeometry(pack.preview_geometry);
    const previews = Array.isArray(pack.previews) ? pack.previews.slice(0, 6).map((preview) => ({
      url: safePreviewUrl(preview?.url),
      commonName: exactCommonName(preview?.common_name),
      scientificName: cleanText(preview?.scientific_name, MAX_SCIENTIFIC_NAME_CODE_POINTS),
    })).filter((preview) => preview.url &&
      (!hostedObjectDigest(preview.url) || (previewGeometry && manifestSha256))) : [];
    const previewUrl = safePreviewUrl(pack.preview_url);
    return {
      id: /^[a-z0-9][a-z0-9._-]{0,79}$/.test(packId) ? packId : "",
      name: cleanText(pack.name, 90),
      region: cleanText(coverage.label, 90) || "Other",
      regionGroup: cleanText(coverage.group, 60) || "Other",
      regionCodes: Array.isArray(coverage.region_codes)
        ? coverage.region_codes.map((code) => cleanText(code, 32)).slice(0, 16)
        : [],
      postalCodes: Array.isArray(coverage.postal_codes)
        ? coverage.postal_codes.map((code) => cleanText(code, 12))
          .filter((code) => /^\d{5}(?:-\d{4})?$/.test(code)).slice(0, 200)
        : [],
      style: cleanText(style.name, MAX_STYLE_NAME_CODE_POINTS) || "Unspecified",
      styleId: /^[a-z0-9][a-z0-9._-]{0,79}$/.test(style.id || "") ? style.id : slug(style.name),
      styleCategory: category,
      styleTags: Array.isArray(style.tags)
        ? style.tags.map((tag) => cleanText(tag, 32)).slice(0, 20)
        : [],
      searchTerms: Array.isArray(pack.search_terms)
        ? pack.search_terms.map((term) => cleanText(term, 60)).slice(0, 30)
        : [],
      species: Number.isInteger(pack.species_count) ? pack.species_count : null,
      contributor: cleanText(pack.contributor || pack.creator, 60) || "Unknown",
      contributorLogin: githubLogin(pack.contributor || pack.creator),
      sourceUrl: safeSourceUrl(pack.source_url || pack.repository_url),
      official: pack.review === "maintainer" || pack.review === "official",
      localStyle: /^[a-z0-9][a-z0-9._-]{0,79}$/.test(pack.local_id || "") ? pack.local_id : "",
      availability: cleanText(pack.availability, 24),
      installable: !!pack.manifest && pack.availability === "installable",
      previewUrl: previewUrl && (!hostedObjectDigest(previewUrl) ||
        (previewGeometry && manifestSha256 &&
          hostedObjectDigest(previewUrl) === previewGeometry.coverSha256))
        ? previewUrl : "",
      previewGeometry,
      manifestUrl,
      manifestSha256,
      previews,
      version: cleanText(pack.version, MAX_BUNDLE_VERSION_CODE_POINTS),
      license: cleanText(pack.license, 60),
      archiveBytes: Number.isSafeInteger(pack.archive_bytes) && pack.archive_bytes > 0 ? pack.archive_bytes : null,
      note: typeof pack.description === "string" && Array.from(pack.description).length <= 260
        ? pack.description : "",
    };
  }

  function inferStyleCategory(name) {
    const value = normalize(name);
    if (/woodblock|ukiyo|engraving|etching|lithograph|audubon|folk|print/.test(value)) return "Traditional";
    if (/watercolor|gouache|oil|pastel|paint/.test(value)) return "Painterly";
    if (/photo|realistic|photoreal/.test(value)) return "Photographic";
    if (/vector|geometric|flat|poster|pixel|graphic/.test(value)) return "Graphic";
    if (/scribble|sketch|gestur|evolution|collage|abstract|impression/.test(value)) return "Experimental";
    return "Other";
  }

  function safePreviewUrl(value) {
    if (typeof value !== "string") return "";
    const localPreviewName = value.startsWith(LOCAL_PREVIEW_PREFIX)
      ? value.slice(LOCAL_PREVIEW_PREFIX.length) : "";
    if (/^[a-z0-9._-]+\.png$/.test(localPreviewName)) return value;
    const canonicalPreviewName = value.startsWith(CANONICAL_PREVIEW_PREFIX)
      ? value.slice(CANONICAL_PREVIEW_PREFIX.length) : "";
    if (/^[a-z0-9._-]+\.png$/.test(canonicalPreviewName)) {
      return LOCAL_PREVIEW_PREFIX + canonicalPreviewName;
    }
    if (/^\/api\/bundles\/objects\/[0-9a-f]{64}\.png$/.test(value)) {
      return embedded ? PUBLIC_ASSET_ORIGIN + value : value;
    }
    try {
      const url = new URL(value);
      const approvedHost = !url.port && (url.hostname === "avianvisitors.com" ||
        url.hostname === "www.avianvisitors.com" || url.hostname === "assets.avianvisitors.com");
      const approvedObject = /^\/api\/bundles\/objects\/[0-9a-f]{64}\.png$/.test(url.pathname);
      return url.protocol === "https:" && approvedHost && approvedObject && !url.username && !url.password &&
        !url.search && !url.hash
        ? url.toString().slice(0, 500) : "";
    } catch (_) {
      return "";
    }
  }

  function hostedObjectDigest(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value, window.location.origin);
      const approvedHost = url.origin === window.location.origin ||
        (url.protocol === "https:" && !url.port && (url.hostname === "avianvisitors.com" ||
          url.hostname === "www.avianvisitors.com" || url.hostname === "assets.avianvisitors.com"));
      const match = url.pathname.match(/^\/api\/bundles\/objects\/([0-9a-f]{64})\.png$/);
      return approvedHost && !url.username && !url.password && !url.search && !url.hash && match
        ? match[1] : "";
    } catch (_) {
      return "";
    }
  }

  function safePreviewGeometry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !/^[0-9a-f]{64}$/.test(String(value.sha256 || "")) ||
        !/^[0-9a-f]{64}$/.test(String(value.cover_sha256 || "")) ||
        typeof value.url !== "string") return null;
    try {
      const relativePublicAsset = embedded && value.url.startsWith("/");
      const url = new URL(value.url, relativePublicAsset ? PUBLIC_ASSET_ORIGIN : window.location.origin);
      const approvedHost = url.origin === window.location.origin ||
        (url.protocol === "https:" && !url.port && (url.hostname === "avianvisitors.com" ||
          url.hostname === "www.avianvisitors.com" || url.hostname === "assets.avianvisitors.com"));
      const match = url.pathname.match(/^\/api\/bundles\/preview-geometry\/([0-9a-f]{64})\.json$/);
      if (!approvedHost || url.username || url.password || url.search || url.hash ||
          !match || match[1] !== value.sha256) return null;
      return {
        url: (relativePublicAsset ? url.toString() : value.url).slice(0, 500),
        sha256: value.sha256,
        coverSha256: value.cover_sha256,
      };
    } catch (_) {
      return null;
    }
  }

  function catalogManifestUrl(pack) {
    const id = typeof pack?.id === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(pack.id)
      ? pack.id : "";
    const version = strictBundleVersion(pack?.version);
    const manifest = /^[0-9a-f]{64}$/.test(String(pack?.manifestSha256 || ""))
      ? pack.manifestSha256 : "";
    if (!pack?.installable || !id || !version || !manifest) return "";
    return safeManifestUrl(pack.manifestUrl, manifest);
  }

  let activeCommandPopover = null;
  let commandControlSequence = 0;

  function setCommandPopover(next, restoreFocus = false) {
    const previous = activeCommandPopover;
    if (previous) {
      previous.root.removeAttribute("data-command-open");
      previous.trigger.setAttribute("aria-expanded", "false");
      previous.popover.setAttribute("aria-hidden", "true");
      previous.popover.inert = true;
    }
    activeCommandPopover = next || null;
    if (next) {
      next.root.setAttribute("data-command-open", "");
      next.trigger.setAttribute("aria-expanded", "true");
      next.popover.setAttribute("aria-hidden", "false");
      next.popover.inert = false;
      requestAnimationFrame(() => next.options[0]?.focus({ preventScroll: true }));
    } else if (restoreFocus && previous?.trigger.isConnected) {
      previous.trigger.focus({ preventScroll: true });
    }
  }

  async function copyCommandText(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (_) { }
    }
    const previousFocus = document.activeElement;
    const field = document.createElement("textarea");
    try {
      field.value = value;
      field.setAttribute("readonly", "");
      field.setAttribute("aria-hidden", "true");
      field.style.position = "fixed";
      field.style.opacity = "0";
      field.style.pointerEvents = "none";
      document.body.append(field);
      field.select?.();
      return document.execCommand?.("copy") === true;
    } catch (_) {
      return false;
    } finally {
      field.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
  }

  function bundleCommandControl(pack) {
    const selector = typeof pack?.id === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,79}$/.test(pack.id) && catalogManifestUrl(pack)
      ? pack.id : "";
    if (!selector) return null;

    const root = document.createElement("div");
    root.className = "bundle-command";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "bundle-command-trigger";
    const id = "bundle-command-" + (++commandControlSequence);
    const tipId = id + "-tip";
    const commandTextId = id + "-text";
    const command = `sudo avian-bundle use '${selector}'`;
    trigger.setAttribute("aria-label", "Copy install command");
    trigger.setAttribute("aria-describedby", tipId);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", id);
    const icon = document.createElement("span");
    icon.className = "bundle-command-glyph";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = ">_";
    const tip = document.createElement("span");
    tip.className = "bundle-command-tip";
    tip.id = tipId;
    tip.setAttribute("role", "tooltip");
    tip.textContent = "Copy install command";
    trigger.append(icon, tip);

    const popover = document.createElement("div");
    popover.className = "bundle-command-popover";
    popover.id = id;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Install command");
    popover.setAttribute("aria-describedby", commandTextId);
    popover.setAttribute("aria-hidden", "true");
    popover.inert = true;
    const status = document.createElement("span");
    status.className = "visually-hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const option = document.createElement("button");
    option.type = "button";
    option.className = "bundle-command-option";
    option.setAttribute("aria-label", "Copy install command");
    option.setAttribute("aria-describedby", commandTextId);
    const code = document.createElement("code");
    code.id = commandTextId;
    code.textContent = command;
    const result = document.createElement("span");
    result.className = "bundle-command-result";
    option.append(code, result);
    let copyOperation = 0;
    let feedbackTimer = 0;
    const copy = async () => {
      const operation = ++copyOperation;
      if (feedbackTimer) {
        window.clearTimeout(feedbackTimer);
        feedbackTimer = 0;
      }
      const copied = await copyCommandText(command);
      if (operation !== copyOperation) return;
      status.textContent = copied ? "Install command copied." : "Could not copy the install command.";
      result.textContent = copied ? "Copied" : "Copy failed";
      option.removeAttribute("data-copied");
      if (!copied) return;
      option.setAttribute("data-copied", "");
      feedbackTimer = window.setTimeout(() => {
        if (operation !== copyOperation) return;
        feedbackTimer = 0;
        option.removeAttribute("data-copied");
        result.textContent = "";
      }, 1600);
    };
    option.addEventListener("click", async (event) => {
      event.stopPropagation?.();
      await copy();
    });
    popover.append(option, status);
    const options = [option];
    const entry = { root, trigger, popover, options };
    trigger.addEventListener("click", async () => {
      if (activeCommandPopover === entry) {
        setCommandPopover(null, true);
        return;
      }
      setCommandPopover(entry);
      await copy();
    });
    popover.addEventListener("keydown", (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Math.max(0, options.indexOf(document.activeElement));
      const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (current + 1) % options.length
          : (current + options.length - 1) % options.length;
      options[index].focus({ preventScroll: true });
    });
    root.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (activeCommandPopover === entry && !root.contains(document.activeElement)) {
          setCommandPopover(null);
        }
      }, 0);
    });
    root.append(trigger, popover);
    return root;
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean))).sort(asciiCompare);
  }

  function normalize(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function broadRegionForCode(code) {
    const country = String(code || "").toUpperCase().split("-")[0];
    for (const [region, countries] of Object.entries(REGION_COUNTRIES)) {
      if (countries.split(" ").includes(country)) return region;
    }
    return "";
  }

  function regionCodeMatches(bundleCode, queryCode) {
    const candidate = String(bundleCode || "").toUpperCase();
    return candidate === queryCode || candidate.startsWith(queryCode + "-") || queryCode.startsWith(candidate + "-");
  }

  function postalCodeMatches(bundleCode, queryCode) {
    return String(bundleCode || "").slice(0, 5) === queryCode;
  }

  function searchPlan(value) {
    let remainder = String(value || "").trim();
    const partialPostal = remainder.match(/^\d{1,4}$/);
    const postal = remainder.match(/\b(\d{5})(?:-\d{0,4})?(?=\s|$)/);
    const regionCode = remainder.match(/\b[A-Za-z]{2}(?:-[A-Za-z0-9]{1,8}){1,3}\b/);
    if (postal) remainder = remainder.replace(postal[0], " ");
    else if (partialPostal) remainder = "";
    if (regionCode) remainder = remainder.replace(regionCode[0], " ");
    return {
      postal: postal ? postal[1] : "",
      postalPrefix: partialPostal ? partialPostal[0] : "",
      regionCode: regionCode ? regionCode[0].toUpperCase() : "",
      broadRegion: postal || partialPostal ? "North America" : broadRegionForCode(regionCode ? regionCode[0] : ""),
      tokens: normalize(remainder).split(" ").filter(Boolean),
    };
  }

  function syncSearchGuidance(plan) {
    if (!plan.postalPrefix) {
      searchWrap.removeAttribute("data-postal-progress");
      searchGuidance.textContent = "";
      searchProgress.textContent = "";
      return;
    }
    const entered = plan.postalPrefix.length;
    const remaining = 5 - entered;
    searchWrap.setAttribute("data-postal-progress", "");
    searchProgress.textContent = "ZIP " + entered + "/5";
    searchGuidance.textContent = "ZIP code, " + entered + " of 5 digits entered. "
      + remaining + (remaining === 1 ? " digit remains." : " digits remain.");
  }

  function fillFilters() {
    const selectedRegion = stationRegion || "all";
    regionFilter.replaceChildren(new Option("All regions", "all"));
    unique(bundles.map((bundle) => bundle.regionGroup)).forEach((region) => regionFilter.add(new Option(region, region)));
    regionFilter.value = Array.from(regionFilter.options).some((o) => o.value === selectedRegion) ? selectedRegion : "all";
  }

  function filteredBundles(plan) {
    const region = regionFilter.value;
    const exactCodeExists = plan.regionCode && bundles.some((bundle) =>
      (bundle.regionCodes || []).some((code) => regionCodeMatches(code, plan.regionCode)));
    const exactPostalExists = plan.postal && bundles.some((bundle) =>
      (bundle.postalCodes || []).some((code) => postalCodeMatches(code, plan.postal)));
    return bundles.filter((bundle) => {
      if (region !== "all" && bundle.regionGroup !== region) return false;
      if (plan.regionCode) {
        if (exactCodeExists && !(bundle.regionCodes || []).some((code) => regionCodeMatches(code, plan.regionCode))) return false;
        if (!exactCodeExists && plan.broadRegion && bundle.regionGroup !== plan.broadRegion) return false;
        if (!exactCodeExists && !plan.broadRegion) return false;
      }
      if (plan.postal) {
        if (exactPostalExists && !(bundle.postalCodes || []).some((code) => postalCodeMatches(code, plan.postal))) return false;
        if (!exactPostalExists && bundle.regionGroup !== "North America") return false;
      }
      if (plan.postalPrefix) {
        const codes = bundle.postalCodes || [];
        if (codes.length && !codes.some((code) => code.startsWith(plan.postalPrefix))) return false;
        if (!codes.length && bundle.regionGroup !== "North America") return false;
      }
      if (!plan.tokens.length) return true;
      const haystack = normalize([
        bundle.name, bundle.region, bundle.regionGroup, bundle.style, bundle.styleCategory,
        bundle.contributor, bundle.note, STYLE_SEARCH[bundle.styleCategory] || "",
      ].concat(bundle.regionCodes || [], bundle.styleTags || [], bundle.searchTerms || []).join(" "));
      return plan.tokens.every((token) => haystack.includes(token));
    });
  }

  function formatBytes(value) {
    if (!Number.isSafeInteger(value) || value <= 0) return "Not listed";
    const units = ["B", "KB", "MB", "GB"];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1) + " " + units[unit];
  }

  function fact(label, value) {
    const item = document.createElement("div");
    item.className = "style-fact";
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    item.append(term, detail);
    return item;
  }

  function commonValue(packs, read) {
    if (!packs.length) return "";
    const values = unique(packs.map(read));
    return values.length === 1 && packs.every((pack) => read(pack)) ? values[0] : "";
  }

  function styleGroups() {
    const groups = new Map();
    bundles.forEach((bundle) => {
      const id = bundle.styleId || slug(bundle.style);
      if (!groups.has(id)) groups.set(id, { id, name: bundle.style, packs: [] });
      groups.get(id).packs.push(bundle);
    });
    return groups;
  }

  function githubLogin(value) {
    const login = String(value || "");
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login) ? login : "";
  }

  function regionStrip(packs) {
    const strip = document.createElement("div");
    strip.className = "style-regions";
    strip.tabIndex = 0;
    strip.setAttribute("role", "region");
    strip.setAttribute("aria-label", "Available regions and contributors. Scroll horizontally for more.");
    packs.forEach((pack) => {
      const login = pack.official ? "Twarner491" : githubLogin(pack.contributorLogin);
      const item = document.createElement(login ? "a" : "span");
      item.className = "style-region";
      if (login) {
        item.href = "https://github.com/" + encodeURIComponent(login);
        item.target = "_blank";
        item.rel = "noopener noreferrer";
      }
      if (pack.official) {
        item.setAttribute("aria-label", pack.region + ". Official bundle by " + pack.contributor + ".");
      }
      const region = document.createElement("strong");
      region.textContent = pack.region;
      const contributor = document.createElement(pack.official ? "span" : "small");
      if (pack.official) contributor.className = "style-region-official";
      contributor.textContent = pack.official ? "Official" : pack.contributor;
      item.append(region, contributor);
      strip.append(item);
    });
    return strip;
  }

  function destroyRegionScrollers() {
    regionScrollControllers.forEach((controller) => controller.destroy());
    regionScrollControllers.clear();
  }

  function destroyGallery(panel) {
    const gallery = panel?.querySelector(".style-collage");
    if (!gallery) return;
    gallery._collageController?.destroy();
    gallery._collageController = null;
    gallery.removeAttribute("data-mounted");
  }

  function destroyCatalogControllers() {
    setCommandPopover(null);
    catalog.querySelectorAll(".style-collapse").forEach(destroyGallery);
    destroyRegionScrollers();
  }

  function regionScroller(strip, active) {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const originals = Array.from(strip.children);
    let enabled = false;
    let visible = false;
    let hovering = false;
    let focused = false;
    let interacting = false;
    let looping = false;
    let frame = 0;
    let focusFrame = 0;
    let last = 0;
    let position = strip.scrollLeft;
    let naturalWidth = 0;
    let manualMax = 0;
    let cycleWidth = 0;
    let edgeState = "";
    let visibilityTimer = 0;
    let interactionTimer = 0;
    const abort = new AbortController();
    const signal = abort.signal;

    function removeClones() {
      strip.querySelectorAll("[data-region-clone]").forEach((clone) => clone.remove());
    }

    function regionGap() {
      try {
        const styles = window.getComputedStyle?.(strip);
        const value = Number.parseFloat(styles?.columnGap || styles?.gap || "");
        if (Number.isFinite(value)) return value;
      } catch (_) { }
      return 14;
    }

    function normalize(value, width = cycleWidth) {
      if (!(width > 0)) return Math.max(0, value);
      return ((value % width) + width) % width;
    }

    function cloneRegions() {
      originals.forEach((item) => {
        const clone = item.cloneNode(true);
        clone.setAttribute("data-region-clone", "");
        clone.setAttribute("aria-hidden", "true");
        clone.setAttribute("tabindex", "-1");
        clone.querySelectorAll("a, button, input, select, textarea, [tabindex]").forEach((control) => {
          control.setAttribute("tabindex", "-1");
        });
        strip.append(clone);
      });
    }

    function measure() {
      const previousCycle = cycleWidth;
      const previous = looping ? normalize(strip.scrollLeft, previousCycle) : strip.scrollLeft;
      stop();
      removeClones();
      naturalWidth = strip.scrollWidth;
      manualMax = Math.max(0, naturalWidth - strip.clientWidth);
      looping = manualMax > 1 && !motion.matches;
      cycleWidth = 0;
      if (looping) {
        cycleWidth = naturalWidth + regionGap();
        cloneRegions();
        position = normalize(previous, cycleWidth);
      } else {
        position = Math.max(0, Math.min(previous, manualMax));
      }
      strip.scrollLeft = position;
      updateEdges();
      schedule();
    }

    function updateEdges() {
      const next = looping ? "both"
        : manualMax < 2 ? "none"
        : strip.scrollLeft <= 1 ? "right"
          : strip.scrollLeft >= manualMax - 1 ? "left" : "both";
      if (next !== edgeState) {
        edgeState = next;
        strip.dataset.edges = next;
      }
    }

    function allowed() {
      return enabled && visible && looping && !document.hidden && !motion.matches
        && !interacting && !hovering && !focused;
    }

    function syncVisibility() {
      const bounds = strip.getBoundingClientRect();
      visible = bounds.bottom > 0 && bounds.top < (window.innerHeight || document.documentElement.clientHeight);
      if (visible) schedule(); else stop();
    }

    function schedule() {
      if (!allowed() || frame) return;
      frame = window.requestAnimationFrame(step);
    }

    function stop() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
    }

    function step(now) {
      frame = 0;
      if (!allowed()) { stop(); return; }
      if (!last) last = now;
      const elapsed = Math.min(64, Math.max(0, now - last));
      last = now;
      position += elapsed * 0.014;
      if (cycleWidth > 0 && position >= cycleWidth) position = normalize(position);
      strip.scrollLeft = position;
      updateEdges();
      schedule();
    }

    function beginInteraction() {
      clearTimeout(interactionTimer);
      interactionTimer = 0;
      interacting = true;
      position = strip.scrollLeft;
      stop();
    }

    function endInteraction(delay = 0) {
      clearTimeout(interactionTimer);
      const resume = () => {
        interactionTimer = 0;
        interacting = false;
        position = looping ? normalize(strip.scrollLeft) : Math.max(0, Math.min(strip.scrollLeft, manualMax));
        strip.scrollLeft = position;
        updateEdges();
        schedule();
      };
      if (delay > 0) interactionTimer = window.setTimeout(resume, delay);
      else resume();
    }

    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      measure();
      syncVisibility();
    }) : null;
    const intersectionObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      visible = !!entry?.isIntersecting;
      if (visible) schedule(); else stop();
    }) : null;
    resizeObserver?.observe(strip);
    intersectionObserver?.observe(strip);
    strip.addEventListener("mouseenter", () => { hovering = true; stop(); }, { signal });
    strip.addEventListener("mouseleave", () => {
      hovering = false;
      position = looping ? normalize(strip.scrollLeft) : strip.scrollLeft;
      strip.scrollLeft = position;
      schedule();
    }, { signal });
    strip.addEventListener("focusin", () => { focused = true; stop(); }, { signal });
    strip.addEventListener("focusout", () => {
      if (focusFrame) window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = 0;
        focused = strip.contains(document.activeElement);
        if (!focused) endInteraction();
        schedule();
      });
    }, { signal });
    strip.addEventListener("pointerdown", beginInteraction, { passive: true, signal });
    strip.addEventListener("touchstart", beginInteraction, { passive: true, signal });
    window.addEventListener("pointerup", () => endInteraction(900), { passive: true, signal });
    window.addEventListener("pointercancel", () => endInteraction(900), { passive: true, signal });
    window.addEventListener("touchend", () => endInteraction(900), { passive: true, signal });
    window.addEventListener("touchcancel", () => endInteraction(900), { passive: true, signal });
    strip.addEventListener("wheel", () => {
      beginInteraction();
      endInteraction(900);
    }, { passive: true, signal });
    strip.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
      event.preventDefault();
      beginInteraction();
      const page = Math.max(80, strip.clientWidth * .72);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? manualMax
          : strip.scrollLeft + (["ArrowLeft", "PageUp"].includes(event.key) ? -page : page);
      position = Math.max(0, Math.min(next, manualMax));
      strip.scrollLeft = position;
      updateEdges();
    }, { signal });
    strip.addEventListener("scroll", () => {
      position = strip.scrollLeft;
      updateEdges();
    }, { passive: true, signal });
    if (!intersectionObserver) window.addEventListener("scroll", syncVisibility, { passive: true, signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else schedule(); }, { signal });
    const motionChanged = () => measure();
    if (motion.addEventListener) motion.addEventListener("change", motionChanged, { signal });
    else motion.addListener?.(motionChanged);

    const controller = {
      setActive(value) {
        const next = !!value;
        if (next && !enabled) {
          interacting = false;
          clearTimeout(interactionTimer);
          interactionTimer = 0;
        }
        enabled = next;
        clearTimeout(visibilityTimer);
        if (enabled) {
          measure();
          syncVisibility();
          visibilityTimer = window.setTimeout(syncVisibility, 340);
        } else stop();
      },
      destroy() {
        enabled = false;
        visible = false;
        stop();
        if (focusFrame) window.cancelAnimationFrame(focusFrame);
        focusFrame = 0;
        clearTimeout(visibilityTimer);
        clearTimeout(interactionTimer);
        resizeObserver?.disconnect();
        intersectionObserver?.disconnect();
        motion.removeEventListener?.("change", motionChanged);
        if (!motion.addEventListener) motion.removeListener?.(motionChanged);
        abort.abort();
        removeClones();
        regionScrollControllers.delete(controller);
      },
    };
    regionScrollControllers.add(controller);
    controller.setActive(active);
    return controller;
  }

  function mountGallery(panel) {
    const gallery = panel.querySelector(".style-collage");
    if (!gallery || gallery.dataset.mounted === "true") return;
    const previews = gallery._bundlePreviews || [];
    if (window.AvianBundleCollage && previews.length) {
      gallery._collageController = window.AvianBundleCollage.mount(
        gallery, previews, gallery._geometryUrl || undefined,
        gallery._manifestSha256 || undefined
      );
      gallery.dataset.mounted = "true";
      gallery._collageController.ready.catch(() => {
        if (!gallery.isConnected) return;
        gallery.removeAttribute("data-mounted");
      });
    }
  }

  function stylePanel(group, open, visiblePacks) {
    const collapse = document.createElement("div");
    collapse.className = "style-collapse";
    collapse.id = "style-panel-" + slug(group.id);
    collapse.setAttribute("aria-hidden", String(!open));
    collapse.inert = !open;
    const inner = document.createElement("div");
    inner.className = "style-collapse-inner";
    const body = document.createElement("div");
    body.className = "style-body";

    const previewPack = group.packs.find((pack) => pack.previews.length >= 6)
      || group.packs.find((pack) => pack.previews.length)
      || group.packs.find((pack) => pack.previewUrl);
    const layout = document.createElement("div");
    layout.className = "style-layout";
    if (!previewPack) layout.classList.add("style-layout-no-preview");
    const visual = document.createElement("section");
    visual.className = "style-visual";
    visual.setAttribute("aria-label", "Example birds from " + group.name);
    if (previewPack) {
      const gallery = document.createElement("div");
      gallery.className = "style-collage";
      if (previewPack.previews.length) {
        gallery._bundlePreviews = previewPack.previews.slice(0, 6).map((preview) => ({
          url: preview.url,
          commonName: preview.commonName,
          scientificName: preview.scientificName,
          weight: 1,
        }));
        gallery._geometryUrl = previewPack.previewGeometry?.url || "";
        gallery._manifestSha256 = previewPack.manifestSha256 || "";
      } else {
        gallery.classList.add("style-collage-single");
        const image = document.createElement("img");
        image.className = "style-collage-single-image";
        image.src = previewPack.previewUrl;
        image.alt = previewPack.name + " example bird";
        image.loading = "eager";
        image.decoding = "async";
        gallery.append(image);
      }
      visual.append(gallery);
    }

    const info = document.createElement("section");
    info.className = "style-info";
    const representative = group.packs.find((pack) => pack.official)
      || group.packs.find((pack) => pack.note)
      || group.packs[0];
    if (representative?.note) {
      const description = document.createElement("p");
      description.className = "style-description";
      description.textContent = representative.note;
      info.append(description);
    }
    const editorial = STYLE_EDITORIAL[group.id];
    if (editorial?.style) {
      const styleDescription = document.createElement("p");
      styleDescription.className = "style-description style-description-secondary";
      styleDescription.textContent = editorial.style;
      info.append(styleDescription);
    }

    const regions = regionStrip(visiblePacks);
    regions._regionController = regionScroller(regions, open);

    const facts = document.createElement("dl");
    facts.className = "style-meta";
    const installablePacks = visiblePacks.filter((pack) => pack.installable);
    const version = commonValue(installablePacks, (pack) => pack.version);
    const license = commonValue(installablePacks, (pack) => pack.license);
    const size = commonValue(installablePacks, (pack) => pack.archiveBytes ? formatBytes(pack.archiveBytes) : "");
    [["Style", group.name], ["Version", version], ["License", license], ["Size", size]]
      .filter((entry) => entry[1])
      .forEach((entry) => facts.append(fact(entry[0], entry[1])));
    info.append(facts);

    if (editorial?.method) {
      const method = document.createElement("p");
      method.className = "style-method";
      method.textContent = editorial.method;
      info.append(method);
    }

    info.append(regions);

    const action = document.createElement("div");
    action.className = "style-action";
    const canUse = (pack) => embedded ? installablePackIds.has(pack.id) : pack.installable;
    const activeTarget = visiblePacks.find((pack) => pack.id === activePackId);
    const target = activeTarget
      || visiblePacks.find((pack) => installedPackIds.has(pack.id) && canUse(pack))
      || visiblePacks.find((pack) => pack.official && canUse(pack))
      || visiblePacks.find((pack) => canUse(pack));
    if (target) {
      const actionRow = document.createElement("div");
      actionRow.className = "bundle-action-row";
      if (embedded) {
        const use = document.createElement("button");
        use.type = "button";
        use.className = "bundle-use";
        const canRefresh = activeTarget && target.id !== "official-western-us-woodblock" && canUse(target);
        if (activeTarget && !canRefresh) {
          use.textContent = "Currently in use";
          use.disabled = true;
          use.setAttribute("data-current", "");
        } else {
          if (canRefresh) use.textContent = "Refresh local birds";
          else use.innerHTML = "Use on my local station <span aria-hidden=\"true\">↗</span>";
          use.addEventListener("click", () => {
            if (!handoff || !parentOrigin) return;
            window.parent.postMessage({
              v: 1,
              type: "avianvisitors:bundle-install",
              id: target.id,
              handoff,
            }, parentOrigin);
          });
        }
        actionRow.append(use);
      } else {
        const use = document.createElement("a");
        use.className = "bundle-use";
        const stationBase = loopbackHost ? "http://127.0.0.1:8137/" : "http://birdnet.local/avian/";
        const handoffUrl = new URL(stationBase);
        handoffUrl.searchParams.set("bundle", target.id);
        handoffUrl.searchParams.set("style", group.id);
        use.href = handoffUrl.toString();
        use.innerHTML = "Use on my local station <span aria-hidden=\"true\">↗</span>";
        actionRow.append(use);
        const command = bundleCommandControl(target);
        if (command) actionRow.append(command);
      }
      action.append(actionRow);
    } else if (visiblePacks.length &&
        (embedded || visiblePacks.some((pack) => pack.availability === "unavailable"))) {
      const unavailable = document.createElement("button");
      unavailable.type = "button";
      unavailable.className = "bundle-use";
      unavailable.textContent = "Unavailable";
      unavailable.disabled = true;
      unavailable.setAttribute("data-unavailable", "");
      action.append(unavailable);
    }
    info.append(action);
    layout.append(visual, info);
    body.append(layout);
    inner.append(body);
    collapse.append(inner);
    return collapse;
  }

  function cardForStyle(group, visiblePacks) {
    const open = openBundleId === group.id;
    const representative = group.packs.find((pack) => pack.official)
      || group.packs.find((pack) => pack.previews.length)
      || group.packs[0];
    const entry = document.createElement("article");
    entry.className = "style-entry";
    const heading = document.createElement("h2");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "style-toggle";
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-controls", "style-panel-" + slug(group.id));
    const cover = document.createElement("img");
    cover.className = "style-cover";
    const coverSource = representative.previewUrl || representative.previews[0]?.url || "";
    if (coverSource) cover.src = coverSource;
    else cover.hidden = true;
    cover.alt = "";
    cover.decoding = "async";
    const name = document.createElement("span");
    name.className = "style-name";
    name.textContent = group.name;
    button.append(cover, name);
    const badges = document.createElement("span");
    badges.className = "style-badges";
    if (group.packs.some((pack) => pack.official)) {
      const badge = document.createElement("span");
      badge.className = "bundle-badge";
      badge.textContent = "Official";
      badges.append(badge);
    }
    if (visiblePacks.some((pack) => installedPackIds.has(pack.id))) {
      const downloaded = document.createElement("span");
      downloaded.className = "bundle-badge bundle-badge-downloaded";
      downloaded.title = "Downloaded";
      const downloadedIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      downloadedIcon.setAttribute("viewBox", "0 0 16 16");
      downloadedIcon.setAttribute("fill", "none");
      downloadedIcon.setAttribute("stroke", "currentColor");
      downloadedIcon.setAttribute("stroke-width", "1.25");
      downloadedIcon.setAttribute("stroke-linecap", "round");
      downloadedIcon.setAttribute("stroke-linejoin", "round");
      downloadedIcon.setAttribute("aria-hidden", "true");
      downloadedIcon.setAttribute("focusable", "false");
      const downloadedPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      downloadedPath.setAttribute("d", "M8 2.25v7.5m0 0L5.5 7.25M8 9.75l2.5-2.5M3 11.5v1.25h10V11.5");
      downloadedIcon.append(downloadedPath);
      const downloadedCopy = document.createElement("span");
      downloadedCopy.className = "visually-hidden";
      downloadedCopy.textContent = "Downloaded";
      downloaded.append(downloadedIcon, downloadedCopy);
      badges.append(downloaded);
    }
    button.append(badges);
    const chevron = document.createElement("span");
    chevron.className = "style-chevron";
    chevron.setAttribute("aria-hidden", "true");
    button.append(chevron);
    heading.append(button);
    const panel = stylePanel(group, open, visiblePacks);
    button.addEventListener("click", () => {
      const opening = button.getAttribute("aria-expanded") !== "true";
      catalog.querySelectorAll(".style-toggle").forEach((toggle) => {
        const expanded = toggle === button && opening;
        toggle.setAttribute("aria-expanded", String(expanded));
        const otherPanel = document.getElementById(toggle.getAttribute("aria-controls"));
        if (!otherPanel) return;
        otherPanel.setAttribute("aria-hidden", String(!expanded));
        otherPanel.inert = !expanded;
        const strip = otherPanel.querySelector(".style-regions");
        strip?._regionController?.setActive(expanded);
        if (expanded) mountGallery(otherPanel);
        else destroyGallery(otherPanel);
      });
      openBundleId = opening ? group.id : "";
    });
    entry.append(heading, panel);
    return entry;
  }

  function render() {
    const plan = searchPlan(search.value);
    syncSearchGuidance(plan);
    const visiblePacks = filteredBundles(plan);
    const visibleByStyle = new Map();
    visiblePacks.forEach((bundle) => {
      const id = bundle.styleId || slug(bundle.style);
      if (!visibleByStyle.has(id)) visibleByStyle.set(id, []);
      visibleByStyle.get(id).push(bundle);
    });
    const visibleStyles = new Set(visibleByStyle.keys());
    const groups = styleGroups();
    if (openBundleId && !visibleStyles.has(openBundleId)) openBundleId = "";
    destroyCatalogControllers();
    catalog.replaceChildren();
    state.textContent = catalogError;
    state.hidden = !catalogError;
    const shown = Array.from(groups.values()).filter((group) => visibleStyles.has(group.id));
    if (!shown.length) {
      const empty = document.createElement("p");
      empty.className = "empty-catalog";
      empty.textContent = "No matching bundles";
      catalog.append(empty);
      return;
    }
    const styleOrder = new Map([["japanese-woodblock", 0], ["evolutionary-impressionist", 1]]);
    shown.sort((a, b) => (styleOrder.get(a.id) ?? 99) - (styleOrder.get(b.id) ?? 99)
      || asciiCompare(a.name, b.name));
    const downloadedStyles = [];
    const remainingStyles = [];
    shown.forEach((group) => {
      const visible = visibleByStyle.get(group.id) || [];
      (visible.some((pack) => installedPackIds.has(pack.id)) ? downloadedStyles : remainingStyles).push(group);
    });
    downloadedStyles.concat(remainingStyles).forEach((group) =>
      catalog.append(cardForStyle(group, visibleByStyle.get(group.id) || [])));
    if (openBundleId) {
      const panel = document.getElementById("style-panel-" + slug(openBundleId));
      if (panel) requestAnimationFrame(() => mountGallery(panel));
    }
  }

  function updateQuery() {
    const next = new URL(location.href);
    if (regionFilter.value === "all") next.searchParams.delete("region");
    else next.searchParams.set("region", regionFilter.value);
    next.searchParams.delete("style");
    history.replaceState(null, "", next);
  }

  search.addEventListener("input", render);
  regionFilter.addEventListener("change", () => {
    stationRegion = "";
    updateQuery();
    render();
  });
  window.addEventListener("message", (event) => {
    if (!embedded || !parentOrigin || event.source !== window.parent || event.origin !== parentOrigin ||
        !exactMessage(event.data, ["v", "type", "handoff", "ids", "activeId", "installableIds", "installedPacks"]) ||
        event.data.v !== 1 || event.data.handoff !== handoff ||
        event.data.type !== "avianvisitors:bundle-library" || !Array.isArray(event.data.ids) ||
        event.data.ids.length > 100 || !Array.isArray(event.data.installableIds) ||
        event.data.installableIds.length > 100 || !Array.isArray(event.data.installedPacks) ||
        event.data.installedPacks.length > 100 ||
        !event.data.ids.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) ||
        new Set(event.data.ids).size !== event.data.ids.length ||
        !event.data.installableIds.every((id) =>
          typeof id === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) ||
        new Set(event.data.installableIds).size !== event.data.installableIds.length ||
        typeof event.data.activeId !== "string" ||
        (event.data.activeId && !event.data.ids.includes(event.data.activeId))) return;
    const parsedInstalledPacks = event.data.installedPacks.map(installedPackPresentation);
    if (parsedInstalledPacks.some((pack) => !pack) ||
        new Set(parsedInstalledPacks.map((pack) => pack.id)).size !== parsedInstalledPacks.length ||
        parsedInstalledPacks.length !== event.data.ids.length ||
        !parsedInstalledPacks.every((pack) => event.data.ids.includes(pack.id))) return;
    installedPackIds.clear();
    event.data.ids.forEach((id) => installedPackIds.add(id));
    installablePackIds.clear();
    event.data.installableIds.forEach((id) => installablePackIds.add(id));
    activePackId = event.data.activeId;
    installedPackPresentations = parsedInstalledPacks;
    const selectedRegion = regionFilter.value;
    rebuildBundles();
    fillFilters();
    if (Array.from(regionFilter.options).some((option) => option.value === selectedRegion)) {
      regionFilter.value = selectedRegion;
    }
    render();
  });
  if (embedded && handoff && parentOrigin) {
    window.parent.postMessage({ v: 1, type: "avianvisitors:bundle-library-request", handoff }, parentOrigin);
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      window.parent.postMessage({ v: 1, type: "avianvisitors:bundle-close", handoff }, parentOrigin);
    });
  }

  if (!embedded) {

  let shareSession = null;
  let shareRefreshPromise = null;
  let shareController = null;
  let shareSubmissionId = "";
  let shareReplacementFor = "";
  let shareUploadActive = false;
  let sharePrepareSequence = 0;
  let shareManageSequence = 0;
  let shareManageRowSequence = 0;
  let sharePublishedSequence = 0;
  const githubProfile = document.querySelector("#github-profile");
  const githubProfileOpen = document.querySelector("#github-profile-open");
  const githubProfileMenu = document.querySelector("#github-profile-menu");
  const githubProfileAvatar = document.querySelector("#github-profile-avatar");
  const githubProfileFallback = document.querySelector("#github-profile-fallback");

  function syncShareLauncher() {
    const authenticated = !!shareSession?.authenticated;
    const sharing = catalogShell.hasAttribute("data-sharing");
    shareOpen.dataset.authenticated = String(authenticated);
    shareOpen.dataset.open = String(authenticated && sharing);
    shareOpen.setAttribute("aria-expanded", String(authenticated && sharing));
    if (authenticated) {
      let plus = shareOpen.querySelector(".share-plus");
      if (!plus) {
        shareOpen.replaceChildren();
        plus = document.createElement("span");
        plus.className = "share-plus";
        plus.setAttribute("aria-hidden", "true");
        shareOpen.append(plus);
      }
      shareOpen.setAttribute("aria-label", sharing ? "Close bundle panel" : "Add a bundle");
      shareOpen.title = sharing ? "Close bundle panel" : "Add a bundle";
      syncGithubProfile();
      return;
    }
    if (!shareOpen.querySelector(".github-mark")) {
      shareOpen.replaceChildren();
      shareOpen.append(shareGithubMark.cloneNode(true));
      const label = document.createElement("span");
      label.textContent = "Sign in with GitHub";
      shareOpen.append(label);
    }
    shareOpen.setAttribute("aria-label", "Sign in with GitHub");
    shareOpen.title = "Sign in with GitHub";
    syncGithubProfile();
  }

  function githubIdentity() {
    const login = githubLogin(shareSession?.user?.login) || "";
    const id = String(shareSession?.user?.id || "");
    return { login, id: /^\d{1,24}$/.test(id) ? id : "" };
  }

  function syncGithubProfile() {
    const authenticated = !!shareSession?.authenticated;
    githubProfile.hidden = !authenticated;
    if (!authenticated) {
      setProfileMenu(false);
      githubProfileAvatar.hidden = true;
      githubProfileAvatar.removeAttribute("src");
      githubProfileFallback.hidden = false;
      return;
    }
    const identity = githubIdentity();
    githubProfileOpen.setAttribute("aria-label", identity.login ? "GitHub account for " + identity.login : "GitHub account");
    githubProfileOpen.title = identity.login ? "@" + identity.login : "GitHub account";
    const localAvatar = shareSession?.preview && identity.login
      ? "https://avatars.githubusercontent.com/" + encodeURIComponent(identity.login) + "?s=80&v=4" : "";
    const avatar = identity.id ? "https://avatars.githubusercontent.com/u/" + identity.id + "?s=80&v=4" : localAvatar;
    githubProfileAvatar.hidden = !avatar;
    githubProfileFallback.hidden = !!avatar;
    if (avatar) githubProfileAvatar.src = avatar;
    else githubProfileAvatar.removeAttribute("src");
  }

  function setProfileMenu(open, restoreFocus = false) {
    const next = !!open && !githubProfile.hidden;
    if (next) githubProfile.setAttribute("data-menu-open", "");
    else githubProfile.removeAttribute("data-menu-open");
    githubProfileOpen.setAttribute("aria-expanded", String(next));
    githubProfileMenu.setAttribute("aria-hidden", String(!next));
    githubProfileMenu.inert = !next;
    if (next) {
      const first = document.querySelector("#share-manage-open");
      if (first) first.focus({ preventScroll: true });
    } else if (restoreFocus && !githubProfile.hidden) {
      githubProfileOpen.focus({ preventScroll: true });
    }
  }

  function openShare() {
    if (catalogShell.hasAttribute("data-sharing")) return;
    catalogShell.setAttribute("data-sharing", "");
    syncShareLauncher();
    shareReveal.setAttribute("aria-hidden", "false");
    shareReveal.inert = false;
    prepareShareDialog(++sharePrepareSequence);
  }

  function closeShare() {
    if (!catalogShell.hasAttribute("data-sharing")) return;
    shareReplacementFor = "";
    sharePublishedSequence += 1;
    setManageStatus("");
    catalogShell.removeAttribute("data-sharing");
    syncShareLauncher();
    shareReveal.setAttribute("aria-hidden", "true");
    shareReveal.inert = true;
    sharePrepareSequence += 1;
    shareInspectSequence += 1;
    invalidateSharePreparation();
    cancelShareUpload();
    shareOpen.focus({ preventScroll: true });
  }

  shareOpen.addEventListener("click", async () => {
    if (!shareSession) await refreshShareLauncher();
    if (!shareSession?.authenticated) {
      if (localContributionPreview) {
        shareSession = {
          configured: false,
          sharing_ready: false,
          authenticated: true,
          preview: true,
          user: { login: "Twarner491" },
          csrf: "",
        };
        syncShareLauncher();
        openShare();
        return;
      }
      location.assign(authPath("choose"));
      return;
    }
    if (catalogShell.hasAttribute("data-sharing")) closeShare();
    else openShare();
  });
  shareReveal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeShare));

  githubProfileOpen.addEventListener("click", () => {
    setProfileMenu(!githubProfile.hasAttribute("data-menu-open"));
  });
  githubProfile.addEventListener("focusout", () => {
    setTimeout(() => {
      if (githubProfile.hasAttribute("data-menu-open") && !githubProfile.contains(document.activeElement)) setProfileMenu(false);
    }, 0);
  });
  githubProfileMenu.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [document.querySelector("#share-manage-open"), document.querySelector("#share-sign-out")];
    const current = Math.max(0, items.indexOf(document.activeElement));
    const next = event.key === "ArrowDown" ? (current + 1) % items.length : (current + items.length - 1) % items.length;
    items[next].focus({ preventScroll: true });
  });
  githubProfileAvatar.addEventListener("error", () => {
    githubProfileAvatar.hidden = true;
    githubProfileFallback.hidden = false;
  });
  githubProfileAvatar.addEventListener("load", () => {
    githubProfileAvatar.hidden = false;
    githubProfileFallback.hidden = true;
  });

  const shareUploadForm = document.querySelector("#share-upload-form");
  const shareArchive = document.querySelector("#share-archive");
  const shareCover = document.querySelector("#share-cover");
  const shareFileStage = document.querySelector("#share-stage-file");
  const shareReviewStage = document.querySelector("#share-stage-review");
  const shareDetailsStage = document.querySelector("#share-stage-details");
  const shareManage = document.querySelector("#share-manage");
  const shareManageStatus = document.querySelector("#share-manage-status");
  const shareStyleChoice = document.querySelector("#share-style-choice");
  const shareStyleNew = document.querySelector("#share-style-new");
  const shareInfoOpen = document.querySelector("#share-info-open");
  const shareInfoPopover = document.querySelector("#share-info-popover");
  const shareDropShell = document.querySelector(".share-drop-shell");
  const shareReviewDrop = document.querySelector("#share-review-drop");
  const shareReviewTitle = document.querySelector("#share-review-title");
  const shareFileList = document.querySelector("#share-file-list");
  const shareAddFiles = document.querySelector("#share-add-files");
  const shareFileNext = document.querySelector("#share-file-next");
  const shareSubmit = document.querySelector("#share-submit");
  const shareMadeFields = document.querySelector("#share-made-fields");
  const shareMethod = document.querySelector("#share-method");
  const shareModelField = document.querySelector("#share-model-field");
  const shareModel = document.querySelector("#share-model");
  const MAX_SHARE_ATTEMPTS = 8;
  const DEFAULT_SHARE_LICENSE = "CC-BY-NC-SA-4.0";
  const MAX_LOOSE_PNGS = 1500;
  const MAX_SHARE_SPECIES = 1000;
  const MAX_SHARE_ARCHIVE_BYTES = 768 * 1024 * 1024;
  const MAX_SHARE_EXPANDED_BYTES = 640 * 1024 * 1024;
  const MAX_LOOSE_MANIFEST_BYTES = 4 * 1024 * 1024;
  const LOOSE_ZIP_SAFETY_BYTES = 2 * 1024 * 1024;
  const MAX_PNG_SIDE = 4096;
  const MAX_PNG_PIXELS = 16000000;
  const LOOSE_PNG_NAME = /^([a-z]{2,40}(?:-[a-z]{2,40}){1,3})(-2)?\.png$/;
  const FA_PAPERCLIP = "M364.2 83.8c-24.4-24.4-64-24.4-88.4 0l-184 184c-42.1 42.1-42.1 110.3 0 152.4s110.3 42.1 152.4 0l152-152c10.9-10.9 28.7-10.9 39.6 0s10.9 28.7 0 39.6l-152 152c-64 64-167.6 64-231.6 0s-64-167.6 0-231.6l184-184c46.3-46.3 121.3-46.3 167.6 0s46.3 121.3 0 167.6l-176 176c-28.6 28.6-75 28.6-103.6 0s-28.6-75 0-103.6l144-144c10.9-10.9 28.7-10.9 39.6 0s10.9 28.7 0 39.6l-144 144c-6.7 6.7-6.7 17.7 0 24.4s17.7 6.7 24.4 0l176-176c24.4-24.4 24.4-64 0-88.4z";
  const FA_TRASH = "M170.5 51.6L151.5 80l145 0-19-28.4c-1.5-2.2-4-3.6-6.7-3.6l-93.7 0c-2.7 0-5.2 1.3-6.7 3.6zm147-26.6L354.2 80 368 80l48 0 8 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-8 0 0 304c0 44.2-35.8 80-80 80l-224 0c-44.2 0-80-35.8-80-80l0-304-8 0c-13.3 0-24-10.7-24-24S10.7 80 24 80l8 0 48 0 13.8 0 36.7-55.1C140.9 9.4 158.4 0 177.1 0l93.7 0c18.7 0 36.2 9.4 46.6 24.9zM80 128l0 304c0 17.7 14.3 32 32 32l224 0c17.7 0 32-14.3 32-32l0-304L80 128zm80 64l0 208c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-208c0-8.8 7.2-16 16-16s16 7.2 16 16zm80 0l0 208c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-208c0-8.8 7.2-16 16-16s16 7.2 16 16zm80 0l0 208c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-208c0-8.8 7.2-16 16-16s16 7.2 16 16z";
  let shareArchiveFile = null;
  let shareArchiveManifest = null;
  let shareArchiveEntries = null;
  let shareInspectSequence = 0;
  let shareAttemptId = 0;
  let shareInputMode = "";
  let shareFileAttempts = [];
  const shareAttemptRows = new Map();
  let shareSelectedAttemptId = "";
  let shareInspectionChain = Promise.resolve();
  let shareDraft = null;
  let shareSubmitSequence = 0;
  let sharePreparing = false;

  function sharePanel(name) {
    ["share-auth", "share-upload-form", "share-manage", "share-progress", "share-ready", "share-fallback"].forEach((id) => {
      document.getElementById(id).hidden = id !== name;
    });
  }

  function contributionReturnPath() {
    const next = new URL(location.href);
    next.pathname = "/bundles";
    next.searchParams.delete("embed");
    next.searchParams.delete("handoff");
    next.searchParams.delete("from");
    next.searchParams.set("share", "1");
    return next.pathname + next.search;
  }

  async function shareApi(path, options) {
    const response = await fetch(path, Object.assign({
      credentials: "same-origin",
      cache: "no-store",
    }, options || {}));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.detail || body.error || "contribution service unavailable");
      error.status = response.status;
      if (response.status === 429) {
        const header = response.headers?.get("retry-after");
        const seconds = header && /^\d+$/.test(header.trim()) ? Number(header)
          : header ? (Date.parse(header) - Date.now()) / 1000 : Number(body.retry_after_s);
        error.retryAfterMs = Number.isFinite(seconds) && seconds > 0
          ? Math.min(60000, Math.max(1000, Math.ceil(seconds * 1000))) : 60000;
      }
      throw error;
    }
    return body;
  }

  function authPath(account) {
    const target = new URL("/api/bundles/auth/start", location.origin);
    target.searchParams.set("return", contributionReturnPath());
    if (account) target.searchParams.set("account", account);
    return target.pathname + target.search;
  }

  async function refreshShareLauncher() {
    if (shareRefreshPromise) return shareRefreshPromise;
    shareRefreshPromise = (async () => {
      try {
        shareSession = await shareApi("/api/bundles/session");
      } catch (_) {
        shareSession = localContributionPreview ? {
          configured: false,
          sharing_ready: false,
          authenticated: false,
          preview: true,
          user: { login: "Twarner491" },
          csrf: "",
        } : {
          configured: false,
          sharing_ready: false,
          authenticated: false,
          preview: false,
          user: null,
          csrf: "",
        };
      }
      syncShareLauncher();
      return shareSession;
    })();
    try {
      return await shareRefreshPromise;
    } finally {
      shareRefreshPromise = null;
    }
  }

  function configureSignedOut() {
    const login = document.querySelector("#share-login");
    delete login.dataset.localPreview;
    login.href = localContributionPreview ? "#" : authPath("choose");
    if (embedded && !localContributionPreview) {
      login.target = "_blank";
    } else {
      login.removeAttribute("target");
    }
  }

  function showSignedInAccount() {
    syncGithubProfile();
  }

  function showLocalSharePreview() {
    shareSession = {
      configured: false,
      sharing_ready: false,
      authenticated: false,
      preview: true,
      user: { login: "Twarner491" },
      csrf: "",
    };
    document.querySelector("#share-copy").textContent = "Sign in, choose a ZIP bundle or PNGs, then review the details.";
    configureSignedOut();
    document.querySelector("#share-login").dataset.localPreview = "true";
    sharePanel("share-auth");
    syncShareLauncher();
  }

  async function prepareShareDialog(sequence) {
    document.querySelector("#share-copy").textContent = "Checking the contribution service.";
    sharePanel("");
    if (localContributionPreview && shareSession?.preview && shareSession.authenticated) {
      document.querySelector("#share-copy").textContent = "Local workflow preview. Nothing can be uploaded from this page.";
      sharePanel("share-upload-form");
      showSignedInAccount();
      shareDraft = readShareDraft();
      resetShareFlow();
      setTimeout(() => { try { shareArchive.focus({ preventScroll: false }); } catch (_) { } }, 30);
      return;
    }
    try {
      shareSession = await shareApi("/api/bundles/session");
      if (sequence !== sharePrepareSequence || !catalogShell.hasAttribute("data-sharing")) return;
      syncShareLauncher();
      if (!shareSession.configured || !shareSession.sharing_ready) {
        if (localContributionPreview) {
          showLocalSharePreview();
          return;
        }
        document.querySelector("#share-copy").textContent = "Hosted contributions are not enabled yet.";
        sharePanel("share-fallback");
        return;
      }
      if (!shareSession.authenticated) {
        document.querySelector("#share-copy").textContent = "Sign in, choose a ZIP bundle or PNGs, then review the details.";
        configureSignedOut();
        sharePanel("share-auth");
        return;
      }
      document.querySelector("#share-copy").textContent = "Choose a ZIP bundle or PNGs to share with the community.";
      sharePanel("share-upload-form");
      showSignedInAccount();
      shareDraft = readShareDraft();
      resetShareFlow();
      setTimeout(() => { try { shareArchive.focus({ preventScroll: false }); } catch (_) { } }, 30);
    } catch (_) {
      if (sequence !== sharePrepareSequence || !catalogShell.hasAttribute("data-sharing")) return;
      if (localContributionPreview) {
        showLocalSharePreview();
        return;
      }
      document.querySelector("#share-copy").textContent = "Hosted contributions are not available right now.";
      sharePanel("share-fallback");
    }
  }

  document.querySelector("#share-login").addEventListener("click", (event) => {
    if (!localContributionPreview || event.currentTarget.dataset.localPreview !== "true") return;
    event.preventDefault();
    shareSession.authenticated = true;
    syncShareLauncher();
    document.querySelector("#share-copy").textContent = "Local workflow preview. Nothing can be uploaded from this page.";
    sharePanel("share-upload-form");
    showSignedInAccount();
    shareDraft = readShareDraft();
    resetShareFlow();
    shareArchive.focus({ preventScroll: true });
  });

  function readShareDraft() {
    let draft;
    try { draft = JSON.parse(sessionStorage.getItem("avian:bundle-share-draft") || "null"); } catch (_) { draft = null; }
    return draft && typeof draft === "object" ? draft : null;
  }

  function invalidateSharePreparation() {
    shareSubmitSequence += 1;
    sharePreparing = false;
    if (shareSubmit) shareSubmit.disabled = false;
  }

  function beginSharePreparation() {
    if (sharePreparing || shareUploadActive) return 0;
    sharePreparing = true;
    shareSubmit.disabled = true;
    return ++shareSubmitSequence;
  }

  function sharePreparationCurrent(sequence) {
    return sharePreparing && sequence === shareSubmitSequence &&
      catalogShell.hasAttribute("data-sharing") && shareSession?.authenticated;
  }

  function finishSharePreparation(sequence) {
    if (sequence !== shareSubmitSequence) return;
    sharePreparing = false;
    shareSubmit.disabled = !!shareUploadActive;
  }

  function resetShareFlow(preserveReplacement = false) {
    const correction = preserveReplacement && !!shareReplacementFor;
    shareInspectSequence += 1;
    invalidateSharePreparation();
    shareUploadForm.reset();
    shareFileAttempts = [];
    shareInputMode = "";
    shareSelectedAttemptId = "";
    if (!preserveReplacement) shareReplacementFor = "";
    shareArchiveFile = null;
    shareArchiveManifest = null;
    shareArchiveEntries = null;
    shareCover.value = "";
    shareFileStage.hidden = false;
    shareReviewStage.hidden = true;
    shareDetailsStage.hidden = true;
    shareAttemptRows.clear();
    shareFileList.replaceChildren();
    document.querySelector("#share-review-ready").textContent = "";
    shareFileNext.disabled = true;
    shareMadeFields.hidden = true;
    shareModelField.hidden = true;
    const drop = document.querySelector("#share-drop");
    drop.removeAttribute("aria-busy");
    drop.removeAttribute("data-dragging");
    shareReviewDrop.removeAttribute("data-dragging");
    document.querySelector("#share-drop-title").textContent = correction ? "Upload corrected files" : "Upload files";
    document.querySelector("#share-drop-note").textContent = correction
      ? "Drop a corrected ZIP bundle or PNGs" : "Drop a ZIP bundle or PNGs";
    setShareInfo(false);
    document.querySelector("#share-file-error").textContent = "";
    document.querySelector("#share-error").textContent = "";
  }

  function zipAllowedName(name) {
    return name === "illustrations/" || name === "LICENSES/" ||
      name === "manifest.json" || name === "README.md" ||
      /^LICENSES\/[A-Za-z0-9._-]{1,100}\.txt$/.test(name) ||
      /^illustrations\/[a-z0-9]+(?:-[a-z0-9]+)*(?:-2)?\.png$/.test(name);
  }

  function zipName(bytes) {
    let value;
    try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (_) { throw new Error("The ZIP contains an unreadable filename."); }
    const directory = value.endsWith("/");
    const parts = (directory ? value.slice(0, -1) : value).split("/");
    if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("The ZIP contains an unsafe path.");
    }
    return value;
  }

  async function zipDirectory(file) {
    if (!file || file.size < 1024 || file.size > MAX_SHARE_ARCHIVE_BYTES) throw new Error("Choose a ZIP between 1 KB and 768 MiB.");
    const tailStart = Math.max(0, file.size - 65557);
    const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tailView.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error("This is not a complete standard ZIP archive.");
    const disk = tailView.getUint16(eocd + 4, true);
    const directoryDisk = tailView.getUint16(eocd + 6, true);
    const diskEntries = tailView.getUint16(eocd + 8, true);
    const totalEntries = tailView.getUint16(eocd + 10, true);
    const directoryBytes = tailView.getUint32(eocd + 12, true);
    const directoryOffset = tailView.getUint32(eocd + 16, true);
    if (disk || directoryDisk || diskEntries !== totalEntries || !totalEntries || totalEntries > MAX_LOOSE_PNGS + 128 ||
        totalEntries === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff ||
        directoryBytes > MAX_BUNDLE_OBJECT_BYTES || directoryOffset + directoryBytes > file.size) {
      throw new Error("This ZIP layout is not supported for browser review.");
    }
    const bytes = new Uint8Array(await file.slice(directoryOffset, directoryOffset + directoryBytes).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Map();
    const folded = new Set();
    let cursor = 0;
    let expanded = 0;
    let images = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("The ZIP directory is incomplete.");
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const compressed = view.getUint32(cursor + 20, true);
      const uncompressed = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (!nameLength || end > bytes.length || flags & 1 || ![0, 8].includes(method) ||
          compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error("The ZIP uses an unsupported archive feature.");
      }
      const name = zipName(bytes.slice(cursor + 46, cursor + 46 + nameLength));
      const lower = name.toLowerCase();
      if (!zipAllowedName(name) || entries.has(name) || folded.has(lower)) throw new Error("The ZIP contains an unsupported or duplicate file.");
      if (name.endsWith("/") && (compressed || uncompressed)) throw new Error("A ZIP folder entry is invalid.");
      if (uncompressed > MAX_BUNDLE_OBJECT_BYTES && name !== "manifest.json") throw new Error("One file is larger than the bundle limit.");
      if (name === "manifest.json" && uncompressed > MAX_BUNDLE_OBJECT_BYTES) throw new Error("manifest.json is too large.");
      if ((name === "README.md" || name.startsWith("LICENSES/")) && uncompressed > 1024 * 1024) throw new Error("A ZIP text file is too large.");
      if (name.endsWith(".png") && ++images > MAX_LOOSE_PNGS) throw new Error("A bundle may contain at most 1500 PNG images.");
      if (uncompressed && !compressed) throw new Error("The ZIP contains an invalid compressed file.");
      if (compressed && uncompressed / compressed > 100) throw new Error("The ZIP contains an unsafe compression ratio.");
      expanded += uncompressed;
      if (expanded > MAX_SHARE_EXPANDED_BYTES) throw new Error("The expanded bundle exceeds 640 MiB.");
      if (!name.endsWith("/")) entries.set(name, { name, flags, method, compressed, uncompressed, localOffset });
      if (entries.size > MAX_LOOSE_PNGS + 64) throw new Error("The ZIP contains too many files.");
      folded.add(lower);
      cursor = end;
    }
    if (!entries.has("manifest.json")) throw new Error("The ZIP is missing manifest.json.");
    return entries;
  }

  async function inflateZipEntry(file, entry, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("A ZIP file exceeds the preview limit.");
    const ceiling = Math.min(limit, MAX_BUNDLE_OBJECT_BYTES);
    if (!entry || entry.uncompressed > ceiling || entry.compressed > ceiling) throw new Error("A ZIP file exceeds the preview limit.");
    const header = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (header.length !== 30 || new DataView(header.buffer).getUint32(0, true) !== 0x04034b50) throw new Error("A ZIP file header is invalid.");
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const dataOffset = entry.localOffset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true);
    if (dataOffset + entry.compressed > file.size) throw new Error("A ZIP file is incomplete.");
    const compressed = await file.slice(dataOffset, dataOffset + entry.compressed).arrayBuffer();
    if (entry.method === 0) {
      if (compressed.byteLength !== entry.uncompressed) throw new Error("A ZIP file has the wrong size.");
      return new Uint8Array(compressed);
    }
    if (typeof DecompressionStream !== "function") throw new Error("This browser cannot preview compressed ZIP files.");
    let stream;
    try { stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw")); }
    catch (_) { throw new Error("This browser cannot preview this ZIP compression."); }
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > ceiling || total > entry.uncompressed) {
        await reader.cancel().catch(() => {});
        throw new Error("A ZIP file expanded past its declared size.");
      }
      chunks.push(part.value);
    }
    if (total !== entry.uncompressed) throw new Error("A ZIP file has the wrong expanded size.");
    const output = new Uint8Array(total);
    let at = 0;
    chunks.forEach((chunk) => { output.set(chunk, at); at += chunk.byteLength; });
    return output;
  }

  function manifestCommonName(bird) {
    if (!Object.prototype.hasOwnProperty.call(bird, "common_name")) return "";
    const value = bird.common_name;
    if (typeof value !== "string" || Array.from(value).length > 100 ||
        hasLoneSurrogate(value) || /[<>\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("manifest.json contains an invalid common name.");
    }
    return value;
  }

  function parseShareManifest(value, entries) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== "avian-visitors-asset-pack" || value.format_version !== 1) {
      throw new Error("manifest.json is not an Avian Visitors bundle manifest.");
    }
    if (LEGACY_REPOSITORY_PACK_IDS.has(value.id)) {
      throw new Error("This bundle ID is reserved for its existing contributor listing.");
    }
    const species = value.species;
    const style = value.style || {};
    const coverage = value.coverage || {};
    const license = value.license || {};
    const licenseDeclared = typeof license.spdx === "string" ? license.spdx : "";
    const supportedLicense = ["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0"];
    const attribution = value.attribution || {};
    const provenance = value.provenance || { method: "manual", model: null, review: "contributor-reviewed" };
    if (!exactNewIntakeText(value.name, 90, true) ||
        !exactNewIntakeText(style.name, MAX_STYLE_NAME_CODE_POINTS, true) ||
        !exactNewIntakeText(coverage.label, 90, true) ||
        !Array.isArray(species) || !species.length || species.length > MAX_SHARE_SPECIES ||
        licenseDeclared && !supportedLicense.includes(licenseDeclared) ||
        !["manual", "generated", "mixed"].includes(provenance.method) ||
        !exactNewIntakeText(attribution.creator, 100, true) ||
        (value.description !== undefined && !exactNewIntakeText(value.description, 260)) ||
        (attribution.source_url !== undefined && attribution.source_url !== null &&
          !exactNewIntakeText(attribution.source_url, 300, true)) ||
        provenance.review !== "contributor-reviewed") {
      throw new Error("manifest.json is missing supported catalog, license, or review details.");
    }
    if ((provenance.method === "generated" || provenance.method === "mixed") &&
        !exactNewIntakeText(provenance.model, 100, true)) {
      throw new Error("Generated bundles must name their model in manifest.json.");
    }
    const codes = Array.isArray(coverage.region_codes) ? coverage.region_codes : [];
    if (codes.length > 32 || codes.some((code) => typeof code !== "string" || !/^[A-Z]{2}(?:-[A-Z0-9]{1,8}){0,3}$/.test(code))) {
      throw new Error("manifest.json contains an invalid region code.");
    }
    const seen = new Set();
    let objects = 0;
    const covers = species.map((bird) => {
      const scientific = cleanText(bird?.scientific_name, MAX_SCIENTIFIC_NAME_CODE_POINTS);
      if (!/^[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}$/.test(scientific) || seen.has(scientific) || !Array.isArray(bird.poses) || !bird.poses.length) {
        throw new Error("manifest.json contains an invalid species entry.");
      }
      seen.add(scientific);
      objects += bird.poses.length;
      if (objects > MAX_LOOSE_PNGS) throw new Error("A bundle may contain at most 1500 PNG images.");
      const pose = bird.poses.find((item) => item?.id === "perched") || bird.poses[0];
      if (!pose || typeof pose.file !== "string" || !entries.has(pose.file)) throw new Error("A cover bird is missing from the ZIP.");
      return { scientific, common: manifestCommonName(bird), file: pose.file };
    });
    return {
      value, covers, codes, style, coverage,
      license: Object.assign({}, license, { spdx: licenseDeclared || DEFAULT_SHARE_LICENSE }),
      licenseDeclared, attribution, provenance,
    };
  }

  function inferredRegionGroup(codes) {
    const country = String(codes[0] || "").split("-", 1)[0];
    for (const [group, countries] of Object.entries(REGION_COUNTRIES)) {
      if ((" " + countries + " ").includes(" " + country + " ")) return group;
    }
    return "Other";
  }

  function formatShareBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function shareHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const SHARE_CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
      table[index] = value >>> 0;
    }
    return table;
  })();

  function shareCrc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = (value >>> 8) ^ SHARE_CRC32_TABLE[(value ^ byte) & 0xff];
    return (value ^ 0xffffffff) >>> 0;
  }

  function looseArchiveEstimate(files) {
    const names = files.map((file) => String(file.identity?.path || file.path || file.name || ""));
    const rawBytes = files.reduce((total, file) => total + Number(file.size || 0), 0);
    const memberHeaders = names.reduce((total, name) => {
      const bytes = new TextEncoder().encode(name).byteLength;
      return total + 76 + (2 * bytes);
    }, 0);
    const manifestNameBytes = new TextEncoder().encode("manifest.json").byteLength;
    return rawBytes + memberHeaders + MAX_LOOSE_MANIFEST_BYTES +
      76 + (2 * manifestNameBytes) + 22 + LOOSE_ZIP_SAFETY_BYTES;
  }

  function looseExpandedEstimate(files) {
    return files.reduce((total, file) => total + Number(file.size || 0), 0) + MAX_LOOSE_MANIFEST_BYTES;
  }

  function inspectPngStructure(raw) {
    if (raw.length < 45 || raw[0] !== 0x89 || raw[1] !== 0x50 || raw[2] !== 0x4e || raw[3] !== 0x47 ||
        raw[4] !== 0x0d || raw[5] !== 0x0a || raw[6] !== 0x1a || raw[7] !== 0x0a) {
      throw new Error("This file is not a PNG image.");
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let cursor = 8;
    let ihdr = null;
    let sawIdat = false;
    let endedIdat = false;
    let sawIend = false;
    let hasTransparency = false;
    while (cursor < raw.length) {
      if (cursor + 12 > raw.length) throw new Error("This PNG is incomplete or corrupt.");
      const length = view.getUint32(cursor, false);
      if (length > MAX_BUNDLE_OBJECT_BYTES || length > raw.length - cursor - 12) {
        throw new Error("This PNG is incomplete or corrupt.");
      }
      const typeBytes = raw.subarray(cursor + 4, cursor + 8);
      if ([...typeBytes].some((byte) => !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)))) {
        throw new Error("This PNG is incomplete or corrupt.");
      }
      const type = String.fromCharCode(...typeBytes);
      const dataStart = cursor + 8;
      const dataEnd = dataStart + length;
      if (shareCrc32(raw.subarray(cursor + 4, dataEnd)) !== view.getUint32(dataEnd, false)) {
        throw new Error("This PNG is incomplete or corrupt.");
      }
      if (!ihdr && type !== "IHDR") throw new Error("This PNG is incomplete or corrupt.");
      if (type === "IHDR") {
        if (ihdr || cursor !== 8 || length !== 13) throw new Error("This PNG is incomplete or corrupt.");
        const width = view.getUint32(dataStart, false);
        const height = view.getUint32(dataStart + 4, false);
        const bitDepth = raw[dataStart + 8];
        const colorType = raw[dataStart + 9];
        const validDepths = {
          0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
        };
        if (!width || !height || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE || width * height > MAX_PNG_PIXELS) {
          throw new Error("PNG dimensions exceed the 4096-pixel and 16-megapixel limits.");
        }
        if (!validDepths[colorType]?.includes(bitDepth) || raw[dataStart + 10] !== 0 ||
            raw[dataStart + 11] !== 0 || raw[dataStart + 12] > 1) {
          throw new Error("This PNG is incomplete or corrupt.");
        }
        ihdr = { width, height, colorType };
        hasTransparency = colorType === 4 || colorType === 6;
      } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
        throw new Error("Animated PNGs are not supported.");
      } else if (type === "IDAT") {
        if (endedIdat || !ihdr || sawIend) throw new Error("This PNG is incomplete or corrupt.");
        sawIdat = true;
      } else {
        if (sawIdat && type !== "IEND") endedIdat = true;
        if (type === "tRNS") hasTransparency = true;
        if ((typeBytes[0] & 32) === 0 && type !== "PLTE" && type !== "IEND") {
          throw new Error("This PNG contains an unsupported critical chunk.");
        }
      }
      cursor = dataEnd + 4;
      if (type === "IEND") {
        if (length || !sawIdat || cursor !== raw.length) throw new Error("This PNG is incomplete or corrupt.");
        sawIend = true;
      }
    }
    if (!ihdr || !sawIdat || !sawIend) throw new Error("This PNG is incomplete or corrupt.");
    if (!hasTransparency) throw new Error("Bird PNGs must include a transparent background.");
    return ihdr;
  }

  async function decodePngPixels(file, expected) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("This browser cannot safely inspect PNG transparency.");
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      if (bitmap.width !== expected.width || bitmap.height !== expected.height ||
          bitmap.width > MAX_PNG_SIDE || bitmap.height > MAX_PNG_SIDE || bitmap.width * bitmap.height > MAX_PNG_PIXELS) {
        throw new Error("PNG dimensions do not match its decoded image.");
      }
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
      if (!context) throw new Error("This browser cannot safely inspect PNG transparency.");
      context.clearRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      let transparent = false;
      let visible = false;
      for (let top = 0; top < bitmap.height && (!transparent || !visible); top += 256) {
        const pixels = context.getImageData(0, top, bitmap.width, Math.min(256, bitmap.height - top)).data;
        for (let index = 3; index < pixels.length && (!transparent || !visible); index += 4) {
          if (pixels[index] === 0) transparent = true;
          if (pixels[index] > 127) visible = true;
        }
      }
      if (!transparent || !visible) {
        throw new Error("Bird PNGs must contain transparent and visible pixels.");
      }
    } catch (error) {
      if (/^(PNG dimensions|Bird PNGs|This browser)/.test(String(error?.message || ""))) throw error;
      throw new Error("This PNG could not be decoded safely.");
    } finally {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
  }

  function loosePngIdentity(name) {
    const exact = String(name || "");
    const match = exact.match(LOOSE_PNG_NAME);
    if (!match || cleanText(exact, MAX_LOOSE_PNG_FILENAME_CODE_POINTS) !== exact ||
        exact.includes("/") || exact.includes("\\")) {
      throw new Error("Name PNGs genus-species.png, with -2 for a flight pose.");
    }
    const scientific = match[1].split("-").map((part, index) =>
      index ? part : part[0].toUpperCase() + part.slice(1)).join(" ");
    return {
      path: "illustrations/" + exact,
      scientific,
      pose: match[2] ? "flight" : "perched",
    };
  }

  function looseSpecies() {
    const species = new Map();
    shareFileAttempts.filter((attempt) => attempt.kind === "png" && attempt.status === "valid")
      .sort((left, right) => asciiCompare(left.identity.path, right.identity.path))
      .forEach((attempt) => {
        let bird = species.get(attempt.identity.scientific);
        if (!bird) {
          bird = { scientific_name: attempt.identity.scientific, poses: [] };
          species.set(attempt.identity.scientific, bird);
        }
        bird.poses.push({
          id: attempt.identity.pose,
          file: attempt.identity.path,
          sha256: attempt.sha256,
          bytes: attempt.size,
        });
      });
    return [...species.values()].sort((left, right) => asciiCompare(left.scientific_name, right.scientific_name))
      .map((bird) => Object.assign(bird, {
        poses: bird.poses.sort((left, right) => left.id === right.id ? 0 : left.id === "perched" ? -1 : 1),
      }));
  }

  function looseReadyState() {
    if (shareInputMode !== "png" || !shareFileAttempts.length) {
      return { ready: false, species: [], files: [], rawBytes: 0, archiveEstimate: 0 };
    }
    const files = shareFileAttempts.filter((attempt) => !attempt.overflow);
    const rawBytes = files.reduce((total, attempt) => total + attempt.size, 0);
    const archiveEstimate = looseArchiveEstimate(files);
    if (!files.length || files.length !== shareFileAttempts.length ||
        files.some((attempt) => attempt.kind !== "png" || attempt.status !== "valid")) {
      return { ready: false, species: [], files, rawBytes, archiveEstimate };
    }
    const species = looseSpecies();
    return {
      ready: species.length >= 1 && species.length <= MAX_SHARE_SPECIES && files.length <= MAX_LOOSE_PNGS &&
        looseExpandedEstimate(files) <= MAX_SHARE_EXPANDED_BYTES && archiveEstimate <= MAX_SHARE_ARCHIVE_BYTES,
      species,
      files,
      rawBytes,
      archiveEstimate,
    };
  }

  function shareInputReady() {
    if (shareInputMode === "png") return looseReadyState().ready;
    return shareInputMode === "zip" && shareFileAttempts.length === 1 &&
      shareFileAttempts[0].status === "valid";
  }

  function styleOptions(parsed) {
    const manifestStyle = cleanText(parsed.style.name, MAX_STYLE_NAME_CODE_POINTS);
    const names = new Map();
    bundles.forEach((bundle) => {
      const name = cleanText(bundle.style, MAX_STYLE_NAME_CODE_POINTS);
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    });
    const options = [...names.values()].sort(asciiCompare).map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      return option;
    });
    const match = names.get(manifestStyle.toLowerCase());
    const create = document.createElement("option");
    create.value = "__new";
    create.textContent = "Create new style";
    options.push(create);
    shareStyleChoice.replaceChildren(...options);
    shareStyleChoice.value = match || "__new";
    shareStyleNew.value = match ? "" : manifestStyle;
    syncStyleDetails();
  }

  function syncStyleDetails() {
    const creating = shareStyleChoice.value === "__new";
    document.querySelector("#share-new-style-field").hidden = !creating;
    const name = cleanText(creating ? shareStyleNew.value : shareStyleChoice.value,
      MAX_STYLE_NAME_CODE_POINTS);
    document.querySelector("#share-style").value = name;
    const known = bundles.find((bundle) => bundle.style === name);
    document.querySelector("#share-style-category").value = known?.styleCategory || inferStyleCategory(name);
  }

  function syncShareProvenanceFields() {
    const loose = shareInputMode === "png";
    const usesModel = shareMethod.value === "generated" || shareMethod.value === "mixed";
    shareMadeFields.hidden = !loose;
    shareModelField.hidden = !loose || !usesModel;
    if (loose && !usesModel) shareModel.value = "";
  }

  function populateShareDetails(parsed, file) {
    const manifest = parsed.value;
    document.querySelector("#share-name").value = cleanText(manifest.name, 90);
    document.querySelector("#share-description").value = cleanText(manifest.description, 260);
    document.querySelector("#share-region").value = cleanText(parsed.coverage.label, 90);
    document.querySelector("#share-code").value = parsed.codes.join(", ");
    document.querySelector("#share-count").value = String(parsed.covers.length);
    document.querySelector("#share-license").value = parsed.license.spdx || DEFAULT_SHARE_LICENSE;
    document.querySelector("#share-method").value = parsed.provenance.method;
    document.querySelector("#share-model").value = cleanText(parsed.provenance.model, 100);
    document.querySelector("#share-creator").value = cleanText(parsed.attribution.creator, 100);
    document.querySelector("#share-source").value = safeSourceUrl(parsed.attribution.source_url);
    shareCover.value = parsed.covers[0]?.scientific || "";
    const group = shareDraft && ["North America", "South America", "Europe", "Africa", "Asia", "Oceania", "Other"].includes(shareDraft.group)
      ? shareDraft.group : inferredRegionGroup(parsed.codes);
    document.querySelector("#share-region-group").value = group;
    styleOptions(parsed);
    if (shareDraft && STYLE_CATEGORIES.includes(shareDraft.category)) {
      document.querySelector("#share-style-category").value = shareDraft.category;
    }
    document.querySelector("#share-version").textContent =
      cleanText(manifest.version, MAX_BUNDLE_VERSION_CODE_POINTS) || "1.0.0";
    document.querySelector("#share-size").textContent = formatShareBytes(file.size);
    syncShareProvenanceFields();
  }

  function populateLooseDetails(state, preserve = false) {
    const priorStyle = preserve
      ? cleanText(document.querySelector("#share-style").value, MAX_STYLE_NAME_CODE_POINTS) : "";
    const priorRegion = preserve ? cleanText(document.querySelector("#share-region").value, 90) : "";
    const supportedLicenses = new Set(["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0"]);
    const supportedMethods = new Set(["manual", "generated", "mixed"]);
    const groups = new Set(["North America", "South America", "Europe", "Africa", "Asia", "Oceania", "Other"]);
    styleOptions({ style: {
      name: priorStyle || cleanText(shareDraft?.style, MAX_STYLE_NAME_CODE_POINTS),
    } });
    document.querySelector("#share-region").value = priorRegion || cleanText(shareDraft?.region, 90);
    document.querySelector("#share-code").value = "";
    document.querySelector("#share-count").value = String(state.species.length);
    const currentLicense = preserve ? document.querySelector("#share-license").value : "";
    const draftLicense = cleanText(shareDraft?.license, 30);
    document.querySelector("#share-license").value = supportedLicenses.has(currentLicense)
      ? currentLicense : supportedLicenses.has(draftLicense) ? draftLicense : DEFAULT_SHARE_LICENSE;
    const currentMethod = preserve ? cleanText(shareMethod.value, 12) : "";
    const draftMethod = cleanText(shareDraft?.method, 12);
    const method = supportedMethods.has(currentMethod) ? currentMethod
      : supportedMethods.has(draftMethod) ? draftMethod : "manual";
    document.querySelector("#share-method").value = method;
    const currentModel = preserve ? cleanText(shareModel.value, 100) : "";
    shareModel.value = method === "manual" ? "" : currentModel || cleanText(shareDraft?.model, 100);
    const currentCreator = preserve ? cleanText(document.querySelector("#share-creator").value, 100) : "";
    const currentSource = preserve ? safeSourceUrl(document.querySelector("#share-source").value) : "";
    document.querySelector("#share-creator").value = currentCreator || cleanText(shareDraft?.creator, 100) || githubIdentity().login;
    document.querySelector("#share-source").value = currentSource || safeSourceUrl(shareDraft?.source);
    shareCover.value = state.species[0]?.scientific_name || "";
    if (!preserve) {
      const draftGroup = cleanText(shareDraft?.group, 20);
      document.querySelector("#share-region-group").value = groups.has(draftGroup) ? draftGroup : "Other";
    }
    document.querySelector("#share-name").value = "";
    document.querySelector("#share-description").value = "";
    document.querySelector("#share-version").textContent = "1.0.0";
    document.querySelector("#share-size").textContent = formatShareBytes(state.rawBytes);
    syncShareProvenanceFields();
  }

  function storedShareZip(members, name) {
    const local = [];
    const directory = [];
    let offset = 0;
    members.forEach((member) => {
      const encodedName = new TextEncoder().encode(member.name);
      const size = member.size;
      if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff || encodedName.length > 0xffff) {
        throw new Error("The generated bundle is too large for a standard ZIP.");
      }
      const localHeader = new Uint8Array(30 + encodedName.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint32(14, member.crc32, true);
      localView.setUint32(18, size, true);
      localView.setUint32(22, size, true);
      localView.setUint16(26, encodedName.length, true);
      localHeader.set(encodedName, 30);
      local.push(localHeader, member.body);

      const centralHeader = new Uint8Array(46 + encodedName.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint32(16, member.crc32, true);
      centralView.setUint32(20, size, true);
      centralView.setUint32(24, size, true);
      centralView.setUint16(28, encodedName.length, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(encodedName, 46);
      directory.push(centralHeader);
      offset += localHeader.byteLength + size;
      if (offset > 0xffffffff) throw new Error("The generated bundle is too large for a standard ZIP.");
    });
    const directoryBytes = directory.reduce((total, entry) => total + entry.byteLength, 0);
    if (members.length > 0xffff || directoryBytes > 0xffffffff) {
      throw new Error("The generated bundle has too many files for a standard ZIP.");
    }
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, members.length, true);
    endView.setUint16(10, members.length, true);
    endView.setUint32(12, directoryBytes, true);
    endView.setUint32(16, offset, true);
    const archive = new Blob([...local, ...directory, end], { type: "application/zip" });
    Object.defineProperty(archive, "name", { configurable: true, value: name });
    return archive;
  }

  async function buildLooseArchive(details) {
    const state = looseReadyState();
    if (!state.ready) throw new Error("Finish checking the PNG files before continuing.");
    const fingerprint = state.files.slice().sort((left, right) => asciiCompare(left.identity.path, right.identity.path))
      .map((attempt) => attempt.identity.path + ":" + attempt.sha256).join("\n");
    const identity = githubIdentity();
    const identityBytes = new TextEncoder().encode(JSON.stringify({
      account: identity.id || identity.login,
      style: details.style,
      region: details.region,
      license: details.license,
      method: details.method,
      model: details.model || "",
      creator: details.creator,
      source: details.source || "",
      files: fingerprint,
    }));
    const digest = shareHex(new Uint8Array(await crypto.subtle.digest("SHA-256", identityBytes)));
    const loginSlug = slug(identity.login).slice(0, 32) || "contributor";
    const packId = "community-" + loginSlug + "-" + digest.slice(0, 16);
    const styleId = slug(details.style).slice(0, 79) || "community-style";
    const manifest = {
      format: "avian-visitors-asset-pack",
      format_version: 1,
      id: packId,
      version: "1.0.0",
      name: cleanText(details.style + " - " + details.region, 90),
      style: { id: styleId, name: details.style },
      coverage: { type: "selection", label: details.region, region_codes: [] },
      species: state.species,
      license: { spdx: details.license },
      attribution: Object.assign({ creator: details.creator }, details.source ? { source_url: details.source } : {}),
      provenance: {
        method: details.method,
        model: details.model || null,
        review: "contributor-reviewed",
      },
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const members = [{
      name: "manifest.json",
      body: manifestBytes,
      size: manifestBytes.byteLength,
      crc32: shareCrc32(manifestBytes),
    }];
    state.files.slice().sort((left, right) => asciiCompare(left.identity.path, right.identity.path))
      .forEach((attempt) => members.push({
        name: attempt.identity.path,
        body: attempt.file,
        size: attempt.size,
        crc32: attempt.crc32,
      }));
    const file = storedShareZip(members, packId + "-1.0.0.zip");
    if (file.size < 1024 || file.size > MAX_SHARE_ARCHIVE_BYTES) {
      throw new Error("The generated ZIP must be between 1 KB and 768 MiB.");
    }
    const entries = await zipDirectory(file);
    const raw = await inflateZipEntry(file, entries.get("manifest.json"), MAX_BUNDLE_OBJECT_BYTES);
    let reparsed;
    try { reparsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch (_) { throw new Error("The generated manifest could not be read."); }
    const parsed = parseShareManifest(reparsed, entries);
    return { file, entries, parsed };
  }

  function shareFaIcon(viewBox, path, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
  }

  function createShareAttemptRow(attempt) {
      const row = document.createElement("article");
      row.className = "share-file-card";
      row.dataset.attemptId = String(attempt.id);
      const nameId = "share-file-name-" + attempt.id;
      const noteId = "share-file-note-" + attempt.id;
      row.setAttribute("aria-labelledby", nameId);
      row.setAttribute("aria-describedby", noteId);
      row.append(shareFaIcon("0 0 448 512", FA_PAPERCLIP, "share-file-icon fa-icon"));
      const copy = document.createElement("span");
      copy.className = "share-file-copy";
      const name = document.createElement("strong");
      name.id = nameId;
      const note = document.createElement("small");
      note.id = noteId;
      note.setAttribute("aria-live", "polite");
      note.setAttribute("aria-atomic", "true");
      copy.append(name, note);
      const remove = document.createElement("button");
      remove.className = "share-file-remove";
      remove.type = "button";
      remove.dataset.attemptId = String(attempt.id);
      remove.append(shareFaIcon("0 0 448 512", FA_TRASH, "fa-icon"));
      remove.addEventListener("click", () => removeShareAttempt(attempt.id));
      row.append(copy, remove);
      return row;
  }

  function updateShareAttemptRow(row, attempt) {
    row.dataset.state = attempt.status;
    row.querySelector("strong").textContent = attempt.name;
    const note = row.querySelector("small");
    let nextNote;
    if (attempt.status === "valid") {
      if (attempt.kind === "png") {
        nextNote = attempt.identity.scientific + " - " + attempt.identity.pose + " - " + formatShareBytes(attempt.size);
      } else {
        const pngLabel = attempt.pngNames.length === 1 ? "PNG" : "PNGs";
        nextNote = attempt.parsed.covers.length + " species - " + attempt.pngNames.length + " " + pngLabel + " - " + formatShareBytes(attempt.size);
      }
    } else if (attempt.status === "error") {
      nextNote = attempt.error;
    } else {
      nextNote = attempt.status === "checking" ? "Checking bundle" : "Waiting to check";
    }
    if (note.textContent !== nextNote) note.textContent = nextNote;
    const remove = row.querySelector(".share-file-remove");
    remove.setAttribute("aria-label", "Remove " + attempt.name);
    remove.title = "Remove " + attempt.name;
  }

  function renderShareAttempts() {
    const live = new Set();
    shareFileAttempts.forEach((attempt) => {
      const key = String(attempt.id);
      live.add(key);
      let row = shareAttemptRows.get(key);
      if (!row) {
        row = createShareAttemptRow(attempt);
        shareAttemptRows.set(key, row);
        shareFileList.append(row);
      }
      updateShareAttemptRow(row, attempt);
    });
    for (const [key, row] of shareAttemptRows) {
      if (live.has(key)) continue;
      row.remove();
      shareAttemptRows.delete(key);
    }

    const sole = shareInputMode === "zip" && shareFileAttempts.length === 1 && shareFileAttempts[0].status === "valid"
      ? shareFileAttempts[0] : null;
    const loose = looseReadyState();
    if (sole) {
      shareArchiveFile = sole.file;
      shareArchiveEntries = sole.entries;
      shareArchiveManifest = sole.parsed;
      const key = "zip:" + sole.id;
      if (key !== shareSelectedAttemptId) {
        shareSelectedAttemptId = key;
        populateShareDetails(sole.parsed, sole.file);
      }
    } else if (loose.ready) {
      shareArchiveFile = null;
      shareArchiveEntries = null;
      shareArchiveManifest = null;
      const key = "png:" + loose.files.map((attempt) => attempt.id).join(",");
      if (key !== shareSelectedAttemptId) {
        const preserve = shareSelectedAttemptId.startsWith("png:");
        shareSelectedAttemptId = key;
        populateLooseDetails(loose, preserve);
      }
    } else {
      if (shareInputMode !== "png" || !shareSelectedAttemptId.startsWith("png:")) {
        shareSelectedAttemptId = "";
      }
      shareArchiveFile = null;
      shareArchiveEntries = null;
      shareArchiveManifest = null;
    }

    const checking = shareFileAttempts.filter((attempt) => attempt.status === "queued" || attempt.status === "checking").length;
    const ready = document.querySelector("#share-review-ready");
    let readyText = "";
    if (checking) readyText = checking === 1 ? "Checking file" : "Checking files";
    else if (sole || loose.ready) readyText = "";
    else if (shareInputMode === "png" && loose.files.length && loose.files.every((attempt) => attempt.status === "valid") && loose.archiveEstimate > MAX_SHARE_ARCHIVE_BYTES) readyText = "PNGs exceed the bundle size limit";
    else if (shareInputMode === "png" && loose.files.length && looseExpandedEstimate(loose.files) > MAX_SHARE_EXPANDED_BYTES) readyText = "PNGs exceed the 640 MiB expanded limit";
    else if (shareInputMode === "png" && loose.files.length && looseSpecies().length > MAX_SHARE_SPECIES) readyText = "A bundle may contain at most 1000 species";
    else if (shareInputMode === "png" && shareFileAttempts.length) readyText = "Remove files with errors";
    else if (shareFileAttempts.length > 1) readyText = "Keep one valid bundle ZIP";
    else if (shareFileAttempts.length) readyText = "Remove this file to try again";
    if (ready.textContent !== readyText) ready.textContent = readyText;
    shareFileNext.disabled = (!sole && !loose.ready) || checking > 0;
    if (checking) shareReviewDrop.setAttribute("aria-busy", "true");
    else shareReviewDrop.removeAttribute("aria-busy");
  }

  function removeShareAttempt(id) {
    const index = shareFileAttempts.findIndex((attempt) => attempt.id === id);
    if (index < 0) return;
    invalidateSharePreparation();
    const removed = shareFileAttempts[index];
    removed.file = null;
    removed.entries = null;
    removed.parsed = null;
    removed.identity = null;
    shareFileAttempts.splice(index, 1);
    if (!shareFileAttempts.length) {
      resetShareFlow(true);
      shareArchive.focus({ preventScroll: true });
      return;
    }
    renderShareAttempts();
    requestAnimationFrame(() => {
      const buttons = shareFileList.querySelectorAll(".share-file-remove");
      const target = buttons[Math.min(index, buttons.length - 1)] || shareFileNext;
      try { target.focus({ preventScroll: true }); } catch (_) { }
    });
  }

  async function inspectShareAttempt(attempt, generation) {
    if (generation !== shareInspectSequence || !shareFileAttempts.includes(attempt)) return;
    attempt.status = "checking";
    renderShareAttempts();
    try {
      if (attempt.kind === "png") {
        const identity = loosePngIdentity(attempt.originalName);
        if (attempt.size < 1024 || attempt.size > MAX_BUNDLE_OBJECT_BYTES) {
          throw new Error("Each PNG must be between 1 KB and 4 MB.");
        }
        if (shareFileAttempts.some((other) => other !== attempt && other.identity?.path === identity.path)) {
          throw new Error("This PNG is already in the bundle.");
        }
        const budgetFiles = shareFileAttempts.filter((other) => other.kind === "png" && other.file)
          .map((other) => ({
            size: other.size,
            path: other === attempt ? identity.path : other.identity?.path || "illustrations/" + String(other.originalName || "file.png"),
          }));
        if (looseArchiveEstimate(budgetFiles) > MAX_SHARE_ARCHIVE_BYTES) {
          throw new Error("This PNG would exceed the 768 MiB archive limit.");
        }
        if (looseExpandedEstimate(budgetFiles) > MAX_SHARE_EXPANDED_BYTES) {
          throw new Error("This PNG would exceed the 640 MiB expanded limit.");
        }
        const raw = new Uint8Array(await attempt.file.arrayBuffer());
        if (raw.length !== attempt.size) throw new Error("This PNG is incomplete or corrupt.");
        const png = inspectPngStructure(raw);
        await decodePngPixels(attempt.file, png);
        if (generation !== shareInspectSequence || !shareFileAttempts.includes(attempt)) return;
        const digest = await crypto.subtle.digest("SHA-256", raw);
        if (generation !== shareInspectSequence || !shareFileAttempts.includes(attempt)) return;
        attempt.identity = identity;
        attempt.sha256 = shareHex(new Uint8Array(digest));
        attempt.crc32 = shareCrc32(raw);
        attempt.status = "valid";
      } else {
        const entries = await zipDirectory(attempt.file);
        const raw = await inflateZipEntry(attempt.file, entries.get("manifest.json"), MAX_BUNDLE_OBJECT_BYTES);
        let manifest;
        try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
        catch (_) { throw new Error("manifest.json is not valid UTF-8 JSON."); }
        const parsed = parseShareManifest(manifest, entries);
        if (generation !== shareInspectSequence || !shareFileAttempts.includes(attempt)) return;
        attempt.status = "valid";
        attempt.entries = entries;
        attempt.parsed = parsed;
        attempt.pngNames = [...entries.keys()].filter((name) => name.toLowerCase().endsWith(".png"));
      }
    } catch (archiveError) {
      if (generation !== shareInspectSequence || !shareFileAttempts.includes(attempt)) return;
      attempt.status = "error";
      attempt.error = cleanText(archiveError?.message, 180) || "This bundle could not be reviewed.";
      attempt.file = null;
      attempt.entries = null;
      attempt.parsed = null;
      attempt.identity = null;
    }
    renderShareAttempts();
  }

  function addShareFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((file) => file && typeof file.name === "string");
    if (!incoming.length) return;
    invalidateSharePreparation();
    const kindFor = (file) => file.name.toLowerCase().endsWith(".zip") ? "zip"
      : file.name.toLowerCase().endsWith(".png") ? "png" : "other";
    const recognized = new Set(incoming.map(kindFor).filter((kind) => kind !== "other"));
    const mixed = recognized.size > 1;
    if (!shareInputMode && !mixed && recognized.size === 1) shareInputMode = [...recognized][0];
    const reviewable = shareFileAttempts.filter((attempt) => !attempt.overflow).length;
    const limit = shareInputMode === "png" ? MAX_LOOSE_PNGS : MAX_SHARE_ATTEMPTS;
    const available = Math.max(0, limit - reviewable);
    const accepted = incoming.slice(0, available);
    const rejected = incoming.slice(accepted.length);
    const generation = shareInspectSequence;
    const firstReveal = shareReviewStage.hidden;
    const pngBudget = shareFileAttempts.filter((attempt) => attempt.kind === "png" && attempt.file)
      .map((attempt) => ({ size: attempt.size, path: attempt.identity?.path || "illustrations/" + String(attempt.originalName || "file.png") }));
    accepted.forEach((file) => {
      const kind = kindFor(file);
      const safeName = cleanText(file.name, MAX_LOOSE_PNG_FILENAME_CODE_POINTS)
        .replace(/[\\/]/g, "") || "File";
      let immediateError = "";
      if (mixed) immediateError = "Choose either one ZIP bundle or PNG files, not both.";
      else if (kind === "other") immediateError = "Choose a ZIP bundle or PNG files.";
      else if (shareInputMode && kind !== shareInputMode) immediateError = "Choose either one ZIP bundle or PNG files, not both.";
      const budgetEntry = { size: Number.isFinite(file.size) ? file.size : 0, path: "illustrations/" + String(file.name) };
      if (!immediateError && kind === "png" && looseArchiveEstimate([...pngBudget, budgetEntry]) > MAX_SHARE_ARCHIVE_BYTES) {
        immediateError = "This PNG would exceed the 768 MiB archive limit.";
      } else if (!immediateError && kind === "png" && looseExpandedEstimate([...pngBudget, budgetEntry]) > MAX_SHARE_EXPANDED_BYTES) {
        immediateError = "This PNG would exceed the 640 MiB expanded limit.";
      } else if (!immediateError && kind === "png") {
        pngBudget.push(budgetEntry);
      }
      const attempt = {
        id: ++shareAttemptId,
        file: immediateError ? null : file,
        name: safeName,
        originalName: file.name,
        kind,
        size: Number.isFinite(file.size) ? file.size : 0,
        status: immediateError ? "error" : "queued",
        error: immediateError,
        entries: null,
        parsed: null,
        identity: null,
        sha256: "",
        crc32: 0,
        pngNames: [],
      };
      shareFileAttempts.push(attempt);
      if (!immediateError) {
        shareInspectionChain = shareInspectionChain.then(() => inspectShareAttempt(attempt, generation)).catch(() => {});
      }
    });
    if (rejected.length) {
      let overflow = shareFileAttempts.find((attempt) => attempt.overflow);
      if (!overflow) {
        overflow = {
          id: ++shareAttemptId,
          file: null,
          name: "",
          size: 0,
          status: "error",
          error: "Not added. Remove a file before trying again.",
          entries: null,
          parsed: null,
          identity: null,
          kind: "other",
          pngNames: [],
          overflow: true,
          overflowCount: 0,
        };
        shareFileAttempts.push(overflow);
      }
      overflow.overflowCount += rejected.length;
      overflow.name = overflow.overflowCount === 1
        ? cleanText(rejected[0].name, MAX_LOOSE_PNG_FILENAME_CODE_POINTS)
          .replace(/[\\/]/g, "") || "Additional file"
        : overflow.overflowCount + " additional files";
    }
    shareFileStage.hidden = true;
    shareReviewStage.hidden = false;
    shareDetailsStage.hidden = true;
    setShareInfo(false);
    renderShareAttempts();
    shareArchive.value = "";
    if (firstReveal) requestAnimationFrame(() => {
      try { shareReviewTitle.focus({ preventScroll: false }); } catch (_) { }
    });
  }

  shareArchive.addEventListener("change", () => addShareFiles(shareArchive.files));
  shareAddFiles.addEventListener("click", () => shareArchive.click());
  shareFileNext.addEventListener("click", () => {
    if (!shareInputReady()) return;
    shareReviewStage.hidden = true;
    shareDetailsStage.hidden = false;
    const target = shareStyleChoice.value === "__new" ? shareStyleNew : shareStyleChoice;
    target.focus({ preventScroll: false });
  });
  document.querySelector("#share-details-back").addEventListener("click", () => {
    if (!shareInputReady()) return;
    shareDetailsStage.hidden = true;
    shareReviewStage.hidden = false;
    shareFileNext.focus({ preventScroll: false });
  });
  shareStyleChoice.addEventListener("change", syncStyleDetails);
  shareStyleNew.addEventListener("input", syncStyleDetails);
  shareMethod.addEventListener("change", syncShareProvenanceFields);

  const shareDrop = document.querySelector("#share-drop");
  function bindShareDropTarget(target, surface) {
    target.addEventListener("dragenter", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      surface.setAttribute("data-dragging", "");
    });
    target.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    target.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && target.contains(event.relatedTarget)) return;
      surface.removeAttribute("data-dragging");
    });
    target.addEventListener("drop", (event) => {
      event.preventDefault();
      surface.removeAttribute("data-dragging");
      addShareFiles(event.dataTransfer?.files);
    });
  }
  bindShareDropTarget(shareDropShell, shareDrop);
  bindShareDropTarget(shareReviewDrop, shareReviewDrop);

  function setShareInfo(open, restoreFocus = false) {
    const next = !!open;
    if (next) shareDropShell.setAttribute("data-info-open", "");
    else shareDropShell.removeAttribute("data-info-open");
    shareInfoOpen.setAttribute("aria-expanded", String(next));
    shareInfoPopover.setAttribute("aria-hidden", String(!next));
    shareInfoPopover.inert = !next;
    if (!next && restoreFocus) shareInfoOpen.focus({ preventScroll: true });
  }

  shareInfoOpen.addEventListener("click", () => {
    setShareInfo(!shareDropShell.hasAttribute("data-info-open"));
  });

  const MANAGE_STATUS = {
    uploading: "Uploading",
    completing: "Finishing upload",
    uploaded: "Uploaded",
    validating: "Validating",
    awaiting_review: "Awaiting review",
    validation_failed: "Validation failed",
    approved: "Approved",
    published: "Published",
    rejected: "Not accepted",
    abandoned: "Removed",
    expired: "Expired",
  };
  const ABANDONABLE_STATUS = new Set(["uploading", "uploaded", "validating", "awaiting_review", "validation_failed", "rejected"]);

  function correctionDraft(submission) {
    const metadata = submission && typeof submission.metadata === "object" && !Array.isArray(submission.metadata)
      ? submission.metadata : {};
    const provenance = metadata.provenance && typeof metadata.provenance === "object" && !Array.isArray(metadata.provenance)
      ? metadata.provenance : {};
    const attribution = metadata.attribution && typeof metadata.attribution === "object" && !Array.isArray(metadata.attribution)
      ? metadata.attribution : {};
    const groups = new Set(["North America", "South America", "Europe", "Africa", "Asia", "Oceania", "Other"]);
    const group = cleanText(metadata.region_group, 20);
    const category = cleanText(metadata.style_category, 30);
    return {
      name: cleanText(metadata.name, 72),
      region: cleanText(metadata.region_label, 72),
      group: groups.has(group) ? group : "Other",
      style: cleanText(metadata.style_name, 48),
      category: STYLE_CATEGORIES.includes(category) ? category : "Other",
      count: Number.isInteger(metadata.species_count) && metadata.species_count >= 1 && metadata.species_count <= MAX_SHARE_SPECIES
        ? String(metadata.species_count) : "",
      license: cleanText(metadata.license_spdx, 30),
      method: ["manual", "generated", "mixed"].includes(provenance.method)
        ? provenance.method : "manual",
      model: cleanText(provenance.model, 100),
      creator: cleanText(attribution.creator, 100),
      source: safeSourceUrl(attribution.source_url),
    };
  }

  function publishedCatalogPack(submission) {
    const id = String(submission?.validation?.summary?.id || "");
    const version = strictBundleVersion(submission?.validation?.summary?.version);
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id) || !version) return null;
    return bundles.find((pack) => pack.id === id && pack.version === version && catalogManifestUrl(pack)) || null;
  }

  function setManageStatus(message, retrySubmission = null) {
    shareManageStatus.replaceChildren();
    shareManageStatus.hidden = !message;
    if (!message) return;
    const copy = document.createElement("span");
    copy.textContent = message;
    shareManageStatus.append(copy);
    if (!retrySubmission) return;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.setAttribute("aria-label", "Retry opening published bundle details");
    retry.addEventListener("click", () => { void openPublishedDetails(retrySubmission); });
    shareManageStatus.append(retry);
  }

  async function openPublishedDetails(submission) {
    const sequence = ++sharePublishedSequence;
    let pack = publishedCatalogPack(submission);
    if (!pack) {
      setManageStatus("Refreshing public bundle details.");
      try { await refreshCommunity(); } catch (_) { }
      if (sequence !== sharePublishedSequence || shareManage.hidden ||
          !catalogShell.hasAttribute("data-sharing")) return;
      pack = publishedCatalogPack(submission);
      if (!pack) {
        setManageStatus("Public details are still syncing. Try again shortly.", submission);
        return;
      }
    }
    setManageStatus("");
    setProfileMenu(false);
    closeShare();
    search.value = "";
    regionFilter.value = "all";
    stationRegion = "";
    openBundleId = pack.styleId || slug(pack.style);
    updateQuery();
    render();
    requestAnimationFrame(() => {
      const controls = Array.from(catalog.querySelectorAll(".style-toggle"));
      const control = controls.find((candidate) =>
        candidate.getAttribute("aria-controls") === "style-panel-" + slug(openBundleId));
      control?.scrollIntoView?.({ block: "nearest" });
      control?.focus({ preventScroll: true });
    });
  }

  function openCorrectionUpload(submission) {
    const id = String(submission?.id || "");
    if (!/^[a-z0-9_-]{20,40}$/.test(id) || submission?.status !== "rejected" ||
        submission?.review_state !== "changes_requested") return;
    const note = cleanText(submission?.moderation_note, 500);
    sharePublishedSequence += 1;
    setManageStatus("");
    setProfileMenu(false);
    shareDraft = correctionDraft(submission);
    sharePanel("share-upload-form");
    resetShareFlow();
    shareReplacementFor = id;
    document.querySelector("#share-copy").textContent = note
      ? "Changes requested: " + note + " Upload corrected files."
      : "Changes requested. Upload corrected files.";
    document.querySelector("#share-drop-title").textContent = "Upload corrected files";
    document.querySelector("#share-drop-note").textContent = "Drop a corrected ZIP bundle or PNGs";
    syncShareLauncher();
    shareArchive.focus({ preventScroll: false });
  }

  function managedBundleRow(submission) {
    const row = document.createElement("article");
    row.className = "share-manage-row";
    const manageRowKey = "share-manage-row-" + (++shareManageRowSequence);
    const submissionStatus = cleanText(submission?.status, 40);
    if (submissionStatus) row.setAttribute("data-manage-status", submissionStatus);
    const metadata = submission && typeof submission.metadata === "object" && !Array.isArray(submission.metadata)
      ? submission.metadata : {};
    const style = cleanText(metadata.style_name, MAX_STYLE_NAME_CODE_POINTS) || "Untitled style";
    const region = cleanText(metadata.region_label, 90) || "Region not available";
    const reviewState = cleanText(submission?.review_state, 40);
    const id = String(submission?.id || "");
    const canCorrect = /^[a-z0-9_-]{20,40}$/.test(id) && submission?.status === "rejected" &&
      reviewState === "changes_requested";
    const publishedId = String(submission?.validation?.summary?.id || "");
    const publishedVersion = strictBundleVersion(submission?.validation?.summary?.version);
    const canOpenPublished = submission?.status === "published" && submission?.publication_status === "published" &&
      /^[a-z0-9][a-z0-9._-]{0,79}$/.test(publishedId) && !!publishedVersion;
    const manageAction = canCorrect ? "correction" : canOpenPublished ? "published" : "";
    const copy = document.createElement(manageAction ? "button" : "span");
    copy.className = manageAction ? "share-manage-copy share-manage-primary" : "share-manage-copy";
    if (manageAction) {
      copy.type = "button";
      copy.setAttribute("aria-label", manageAction === "correction"
        ? "Upload corrections for " + style
        : "Open public details for " + style);
      copy.addEventListener("click", () => manageAction === "correction"
        ? openCorrectionUpload(submission) : openPublishedDetails(submission));
      row.setAttribute("data-manage-action", manageAction);
    }
    const title = document.createElement("strong");
    title.textContent = style;
    const status = submission?.publication_status === "revoked" ? "Unlisted"
      : submission?.status === "abandoned" ? MANAGE_STATUS.abandoned
      : submission?.status === "expired" ? MANAGE_STATUS.expired
      : reviewState === "changes_requested" ? "Changes requested"
      : reviewState === "approval_requested" ? "Approval starting"
        : MANAGE_STATUS[submission?.status] || "Processing";
    const version = cleanText(submission?.validation?.summary?.version,
      MAX_BUNDLE_VERSION_CODE_POINTS);
    const details = document.createElement("small");
    details.id = manageRowKey + "-details";
    details.textContent = [region, version ? "v" + version : "", status, formatShareBytes(Number(submission?.archive_bytes))]
      .filter(Boolean).join(" - ");
    copy.append(title, details);
    if (manageAction) copy.setAttribute("aria-describedby", details.id);
    const reviewNote = cleanText(submission?.moderation_note, 500);
    if (reviewNote && canCorrect) {
      const note = document.createElement("small");
      note.className = "share-manage-note";
      note.id = manageRowKey + "-feedback";
      note.textContent = reviewNote;
      copy.classList.add("share-manage-primary-feedback");
      copy.append(note);
      copy.setAttribute("aria-describedby", details.id + " " + note.id);
    }

    const actions = document.createElement("span");
    actions.className = "share-manage-actions";
    if (/^[a-z0-9_-]{20,40}$/.test(id) && ABANDONABLE_STATUS.has(submission?.status)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        if (!remove.hasAttribute("data-confirm")) {
          remove.setAttribute("data-confirm", "");
          remove.textContent = "Confirm";
          setTimeout(() => {
            remove.removeAttribute("data-confirm");
            remove.textContent = "Remove";
          }, 4000);
          return;
        }
        remove.disabled = true;
        try {
          await shareApi("/api/bundles/submissions/" + encodeURIComponent(id) + "/abandon", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Bundle-CSRF": shareSession.csrf },
            body: "{}",
          });
          await loadManagedBundles();
        } catch (error) {
          remove.disabled = false;
          remove.removeAttribute("data-confirm");
          remove.textContent = cleanText(error.message, 40) || "Try again";
        }
      });
      actions.append(remove);
    }
    row.append(copy);
    if (actions.children.length) row.append(actions);
    return row;
  }

  function renderManagedBundles(submissions) {
    const list = document.querySelector("#share-manage-list");
    if (!Array.isArray(submissions) || !submissions.length) {
      const empty = document.createElement("p");
      empty.className = "share-manage-empty";
      empty.textContent = "No bundles shared yet";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...submissions.slice(0, 20).map(managedBundleRow));
  }

  async function loadManagedBundles() {
    const sequence = ++shareManageSequence;
    setManageStatus("");
    const list = document.querySelector("#share-manage-list");
    const loading = document.createElement("p");
    loading.className = "share-manage-empty";
    loading.textContent = "Loading bundles";
    list.replaceChildren(loading);
    if (shareSession?.preview) {
      renderManagedBundles([]);
      return;
    }
    try {
      const result = await shareApi("/api/bundles/submissions");
      if (sequence !== shareManageSequence || shareManage.hidden) return;
      renderManagedBundles(result.submissions);
    } catch (_) {
      if (sequence !== shareManageSequence || shareManage.hidden) return;
      const unavailable = document.createElement("p");
      unavailable.className = "share-manage-empty";
      unavailable.textContent = "Your bundles are unavailable right now";
      list.replaceChildren(unavailable);
    }
  }

  async function openManagedBundles() {
    if (!shareSession?.authenticated) return;
    shareReplacementFor = "";
    sharePublishedSequence += 1;
    setManageStatus("");
    setProfileMenu(false);
    if (!catalogShell.hasAttribute("data-sharing")) {
      catalogShell.setAttribute("data-sharing", "");
      shareReveal.setAttribute("aria-hidden", "false");
      shareReveal.inert = false;
    }
    sharePrepareSequence += 1;
    sharePanel("share-manage");
    syncShareLauncher();
    requestAnimationFrame(() => document.querySelector("#share-manage-title")?.focus({ preventScroll: false }));
    await loadManagedBundles();
  }

  document.querySelector("#share-manage-open").addEventListener("click", openManagedBundles);
  document.querySelector("#share-manage-add").addEventListener("click", () => {
    sharePublishedSequence += 1;
    setManageStatus("");
    sharePanel("share-upload-form");
    shareDraft = readShareDraft();
    resetShareFlow();
    syncShareLauncher();
    shareArchive.focus({ preventScroll: false });
  });

  document.addEventListener("pointerdown", (event) => {
    if (activeCommandPopover && !activeCommandPopover.root.contains(event.target)) setCommandPopover(null);
    if (githubProfile.hasAttribute("data-menu-open") && !githubProfile.contains(event.target)) setProfileMenu(false);
    if (shareDropShell.hasAttribute("data-info-open") && !shareDropShell.contains(event.target)) setShareInfo(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (activeCommandPopover) {
      setCommandPopover(null, true);
      return;
    }
    if (githubProfile.hasAttribute("data-menu-open")) {
      setProfileMenu(false, true);
      return;
    }
    if (shareDropShell.hasAttribute("data-info-open")) {
      setShareInfo(false, true);
      return;
    }
    if (catalogShell.hasAttribute("data-sharing")) closeShare();
  });

  const shareSignOut = document.querySelector("#share-sign-out");
  shareSignOut.addEventListener("click", async () => {
    if (!shareSession?.authenticated) return;
    shareSignOut.disabled = true;
    try {
      await cancelShareUpload(true);
    } catch (_) {
      shareSignOut.disabled = false;
      document.querySelector("#share-copy").textContent = "Could not remove the active upload. Try again before logging out.";
      return;
    }
    if (!shareSession.preview) {
      try {
        await shareApi("/api/bundles/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bundle-CSRF": shareSession.csrf },
          body: "{}",
        });
      } catch (_) {
        shareSignOut.disabled = false;
        document.querySelector("#share-copy").textContent = "Could not log out. Try again.";
        return;
      }
    }
    setProfileMenu(false);
    try { localStorage.removeItem("avian:bundle-github-login"); } catch (_) { }
    shareSession.authenticated = false;
    resetShareFlow();
    closeShare();
    syncShareLauncher();
    shareSignOut.disabled = false;
  });

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason || Object.assign(new Error("Upload cancelled"), { name: "AbortError" }));
      };
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async function putPart(url, blob, signal) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw signal.reason || Object.assign(new Error("Upload cancelled"), { name: "AbortError" });
      try {
        return await shareApi(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Bundle-CSRF": shareSession.csrf,
          },
          body: blob,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        if (attempt < 2) await sleep(error.status === 429 ? error.retryAfterMs : (attempt ? 1000 : 350), signal);
      }
    }
    throw lastError;
  }

  async function abandonCurrentUpload(strict = false) {
    const id = shareSubmissionId;
    if (!id) return true;
    if (!shareSession || !shareSession.csrf) {
      if (strict) throw new Error("The upload could not be removed.");
      shareSubmissionId = "";
      return false;
    }
    try {
      const response = await fetch("/api/bundles/submissions/" + encodeURIComponent(id) + "/abandon", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", "X-Bundle-CSRF": shareSession.csrf },
        body: "{}",
      });
      if (!response.ok) throw new Error("The upload could not be removed.");
      shareSubmissionId = "";
      return true;
    } catch (error) {
      if (strict) throw error;
      shareSubmissionId = "";
      return false;
    }
  }

  async function cancelShareUpload(strict = false) {
    if (!shareUploadActive && !shareSubmissionId) return true;
    if (shareController) shareController.abort();
    shareUploadActive = false;
    return abandonCurrentUpload(strict);
  }

  document.querySelector("#share-cancel").addEventListener("click", async () => {
    try {
      await cancelShareUpload(true);
    } catch (_) {
      document.querySelector("#share-progress-copy").textContent = "The active upload could not be removed. Try again.";
      return;
    }
    document.querySelector("#share-copy").textContent = "Upload cancelled. The private quarantine copy was removed.";
    sharePanel("share-upload-form");
    showSignedInAccount();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!shareUploadActive) return;
    event.preventDefault();
    event.returnValue = "";
  });

  shareUploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!shareSession || !shareSession.authenticated) return;
    const preparation = beginSharePreparation();
    if (!preparation) return;
    let completionStarted = false;
    try {
    const error = document.querySelector("#share-error");
    error.textContent = "";
    syncStyleDetails();
    let file = shareArchiveFile;
    let name = cleanText(document.querySelector("#share-name").value, 90);
    const region = cleanText(document.querySelector("#share-region").value, 90);
    const style = cleanText(document.querySelector("#share-style").value,
      MAX_STYLE_NAME_CODE_POINTS);
    const styleCategory = document.querySelector("#share-style-category").value;
    const regionGroup = document.querySelector("#share-region-group").value;
    const license = document.querySelector("#share-license").value;
    let count = Number(document.querySelector("#share-count").value);
    let codes = document.querySelector("#share-code").value.toUpperCase().split(",")
      .map((code) => code.trim()).filter(Boolean);
    let method = document.querySelector("#share-method").value;
    let model = cleanText(document.querySelector("#share-model").value, 100);
    let creator = cleanText(document.querySelector("#share-creator").value, 100);
    let source = document.querySelector("#share-source").value.trim();
    let coverSpecies = cleanText(shareCover.value, MAX_SCIENTIFIC_NAME_CODE_POINTS);
    const loose = shareInputMode === "png" ? looseReadyState() : null;
    if (loose?.ready) {
      name = cleanText(style + " - " + region, 90);
      count = loose.species.length;
      codes = [];
      method = ["manual", "generated", "mixed"].includes(method) ? method : "manual";
      model = method === "manual" ? "" : model;
      creator = creator || githubIdentity().login;
      source = safeSourceUrl(source);
      coverSpecies = loose.species[0]?.scientific_name || "";
      document.querySelector("#share-name").value = name;
      document.querySelector("#share-count").value = String(count);
      document.querySelector("#share-code").value = "";
      document.querySelector("#share-method").value = method;
      document.querySelector("#share-model").value = model;
      document.querySelector("#share-creator").value = creator;
      document.querySelector("#share-source").value = source;
      shareCover.value = coverSpecies;
    }
    if ((!loose && (!shareArchiveManifest || !file)) || (loose && !loose.ready) ||
        !name || !region || !style || !STYLE_CATEGORIES.includes(styleCategory) ||
        !Object.prototype.hasOwnProperty.call(REGION_COUNTRIES, regionGroup) && regionGroup !== "Other" ||
        !["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0"].includes(license) ||
        !creator || !coverSpecies || !Number.isInteger(count) || count < 1 || count > MAX_SHARE_SPECIES) {
      error.textContent = "Choose the bundle details before uploading.";
      return;
    }
    if (source) {
      try {
        const parsedSource = new URL(source);
        if (parsedSource.protocol !== "https:" || parsedSource.username || parsedSource.password) throw new Error();
      } catch (_) {
        error.textContent = "Use a complete HTTPS source URL.";
        return;
      }
    }
    if (codes.length > 32 || codes.some((code) => !/^[A-Z]{2}(?:-[A-Z0-9]{1,8}){0,3}$/.test(code))) {
      error.textContent = "Use region codes such as GB-ENG-DBY, separated by commas.";
      return;
    }
    if ((method === "generated" || method === "mixed") && !model) {
      error.textContent = "Name the model used to make the generated artwork.";
      return;
    }
    if (loose) {
      try {
        const built = await buildLooseArchive({ style, region, license, method, model, creator, source });
        if (!sharePreparationCurrent(preparation)) return;
        file = built.file;
        shareArchiveFile = built.file;
        shareArchiveEntries = built.entries;
        shareArchiveManifest = built.parsed;
        name = cleanText(built.parsed.value.name, 90);
        document.querySelector("#share-name").value = name;
        document.querySelector("#share-size").textContent = formatShareBytes(file.size);
      } catch (buildError) {
        error.textContent = cleanText(buildError?.message, 180) || "The PNG bundle could not be prepared.";
        return;
      }
    }
    if (!file || !shareArchiveManifest) {
      error.textContent = "Choose the bundle files before continuing.";
      return;
    }
    if (file.size < 1024 || file.size > MAX_SHARE_ARCHIVE_BYTES) {
      error.textContent = "The ZIP archive must be between 1 KB and 768 MiB.";
      return;
    }
    if (cleanText(file.name, 160) !== file.name || file.name.includes("/") || file.name.includes("\\") || !file.name.toLowerCase().endsWith(".zip")) {
      error.textContent = "Choose a ZIP with a simple filename.";
      return;
    }
    if (!shareSession.preview &&
        (style !== cleanText(shareArchiveManifest.style.name, MAX_STYLE_NAME_CODE_POINTS) ||
        region !== cleanText(shareArchiveManifest.coverage.label, 90) ||
        license !== shareArchiveManifest.licenseDeclared)) {
      error.textContent = "These choices must match manifest.json until versioned revisions are enabled. Update the ZIP and upload it again.";
      return;
    }
    const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (!sharePreparationCurrent(preparation)) return;
    if (signature.length !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
      error.textContent = "Choose a standard ZIP archive containing manifest.json and illustrations.";
      return;
    }
    if (shareSession.preview) {
      error.textContent = "Local preview only. Nothing was uploaded.";
      return;
    }

    if (!sharePreparationCurrent(preparation)) return;
    shareUploadActive = true;
    shareController = new AbortController();
    const progress = document.querySelector("#share-progress-bar");
    const progressCopy = document.querySelector("#share-progress-copy");
    const progressTitle = document.querySelector("#share-progress-title");
    progress.value = 0;
    progressTitle.textContent = "Preparing private upload";
    progressCopy.textContent = "Nothing is public while this upload is in progress.";
    sharePanel("share-progress");
    try {
      const submissionPath = shareReplacementFor
        ? "/api/bundles/submissions/" + encodeURIComponent(shareReplacementFor) + "/replacement"
        : "/api/bundles/submissions";
      const created = await shareApi(submissionPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bundle-CSRF": shareSession.csrf },
        body: JSON.stringify({
          name,
          region_label: region,
          region_group: regionGroup,
          region_codes: codes,
          style_name: style,
          style_category: styleCategory,
          species_count: count,
          license_spdx: license,
          provenance_method: method,
          provenance_model: model,
          creator_name: creator,
          source_url: source,
          cover_species: coverSpecies,
          review_state: "contributor-reviewed",
          archive_name: file.name,
          archive_bytes: file.size,
        }),
        signal: shareController.signal,
      });
      const upload = created.submission;
      shareSubmissionId = upload.id;
      progressTitle.textContent = "Uploading bundle";
      for (let part = 1; part <= upload.expected_parts; part += 1) {
        const start = (part - 1) * upload.part_size;
        const blob = file.slice(start, Math.min(file.size, start + upload.part_size));
        progressCopy.textContent = "Part " + part + " of " + upload.expected_parts;
        await putPart("/api/bundles/submissions/" + encodeURIComponent(upload.id) + "/parts/" + part, blob, shareController.signal);
        progress.value = part / upload.expected_parts;
      }
      progressTitle.textContent = "Starting validation";
      progressCopy.textContent = "The completed archive is still private.";
      completionStarted = true;
      const completed = await shareApi("/api/bundles/submissions/" + encodeURIComponent(upload.id) + "/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bundle-CSRF": shareSession.csrf },
        body: "{}",
        signal: shareController.signal,
      });
      shareSubmissionId = "";
      shareUploadActive = false;
      shareController = null;
      document.querySelector("#share-copy").textContent = "Bundle received from @" + shareSession.user.login + ".";
      document.querySelector("#share-ready-copy").textContent = completed.validation_queued
        ? "The archive is private and queued for validation. It will appear in the catalog only after the files and artwork have been reviewed."
        : "The archive is private, but validation has not started. Nothing has been published.";
      sharePanel("share-ready");
      try { sessionStorage.removeItem("avian:bundle-share-draft"); } catch (_) { }
      resetShareFlow();
    } catch (uploadError) {
      const cancelled = !!(shareController && shareController.signal.aborted);
      shareUploadActive = false;
      shareController = null;
      if (cancelled) return;
      if (!completionStarted) {
        await abandonCurrentUpload();
      } else {
        // The completion response can be lost after R2 and D1 commit. Keep the
        // exact upload for server reconciliation instead of deleting bytes
        // that may already be queued for validation.
        shareSubmissionId = "";
      }
      document.querySelector("#share-copy").textContent = "The upload did not complete.";
      if (completionStarted) {
        document.querySelector("#share-copy").textContent = "The private upload was kept.";
        document.querySelector("#share-ready-copy").textContent =
          "Open Manage bundles to check whether validation started or to remove the upload.";
        sharePanel("share-ready");
        resetShareFlow();
        refreshShareLauncher().catch(() => {});
      } else {
        error.textContent = uploadError.message;
        sharePanel("share-upload-form");
        showSignedInAccount();
      }
    }
    } finally {
      finishSharePreparation(preparation);
    }
  });

  refreshShareLauncher().then(() => {
    if (!shareRequested) return;
    if (shareSession?.authenticated) openShare();
    else if (!localContributionPreview) location.assign(authPath("choose"));
  });
  }

  async function loadCommunity() {
    catalogError = "";
    const parseCatalog = (data, allowEmpty = false) => {
      if (!data || typeof data !== "object" || data.format !== "avian-visitors-bundle-catalog" ||
          data.format_version !== 1 || !Array.isArray(data.packs) ||
          data.packs.length > MAX_CATALOG_PACKS) {
        throw new Error("unsupported catalog");
      }
      const seen = new Set();
      const parsed = data.packs.map(catalogBundle).filter((bundle) => {
        if (!bundle.id || !bundle.name || seen.has(bundle.id)) return false;
        seen.add(bundle.id);
        return true;
      });
      if (!parsed.length && !allowEmpty) throw new Error("empty catalog");
      return parsed;
    };

    const fetchCatalog = async (url) => {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error(String(response.status));
      const declaredValue = response.headers?.get?.("content-length") || "";
      if (declaredValue && (!/^\d+$/.test(declaredValue) || Number(declaredValue) > MAX_CATALOG_BYTES)) {
        throw new Error("catalog is too large");
      }
      const reader = response.body?.getReader?.();
      if (!reader) throw new Error("catalog body is not streamable");
      const chunks = [];
      let total = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_CATALOG_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error("catalog is too large");
        }
        chunks.push(part.value);
      }
      const raw = new Uint8Array(total);
      let offset = 0;
      chunks.forEach((chunk) => { raw.set(chunk, offset); offset += chunk.byteLength; });
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
      catch (_) { throw new Error("catalog is not valid UTF-8 JSON"); }
    };

    let baselineBundles = official;
    try {
      const candidates = parseCatalog(await fetchCatalog(
        embedded ? PUBLIC_CATALOG_URL : CATALOG_URL
      ));
      const safeStatic = candidates.filter((bundle) =>
        (bundle.official && bundle.id.startsWith("official-")) ||
        (!bundle.official && bundle.availability === "repository" && !bundle.installable));
      if (!safeStatic.some((bundle) => bundle.official)) {
        throw new Error("official catalog is empty");
      }
      baselineBundles = safeStatic;
    } catch (_) {
      try {
        const snapshot = embedded && window.AVIAN_BUNDLE_CATALOG_SNAPSHOT
          ? parseCatalog(window.AVIAN_BUNDLE_CATALOG_SNAPSHOT) : [];
        const safeStatic = snapshot.filter((bundle) =>
          (bundle.official && bundle.id.startsWith("official-")) ||
          (!bundle.official && bundle.availability === "repository" && !bundle.installable));
        if (safeStatic.some((bundle) => bundle.official)) baselineBundles = safeStatic;
      } catch (_) { }
    }

    try {
      const community = parseCatalog(await fetchCatalog(
        embedded ? PUBLIC_COMMUNITY_CATALOG_URL : COMMUNITY_CATALOG_URL
      ), true);
      if (community.some((bundle) => bundle.official || bundle.id.startsWith("official-") ||
          LEGACY_REPOSITORY_PACK_IDS.has(bundle.id) ||
          bundle.availability !== "installable" || !bundle.installable)) {
        throw new Error("community catalog violates confirmed authority");
      }
      const positions = new Map(baselineBundles.map((bundle, index) => [bundle.id, index]));
      discoveredBundles = [...baselineBundles];
      for (const bundle of community) {
        const position = positions.get(bundle.id);
        if (position === undefined) {
          positions.set(bundle.id, discoveredBundles.length);
          discoveredBundles.push(bundle);
          continue;
        }
        const existing = discoveredBundles[position];
        if (existing.official || existing.availability !== "repository" || existing.installable) {
          throw new Error("community catalog overlaps protected authority");
        }
        // A confirmed hosted revision replaces its repository-only migration
        // placeholder in place, keeping catalog order stable.
        discoveredBundles[position] = bundle;
      }
    } catch (liveError) {
      catalogError = "The community catalog is unavailable. Official bundles are still shown.";
      discoveredBundles = baselineBundles;
    }
    rebuildBundles();
    fillFilters();
    render();
  }

  let communityLoadPromise = null;
  async function refreshCommunity() {
    if (communityLoadPromise) return communityLoadPromise;
    const pending = loadCommunity();
    communityLoadPromise = pending;
    try { return await pending; }
    finally { if (communityLoadPromise === pending) communityLoadPromise = null; }
  }

  refreshCommunity();
})();

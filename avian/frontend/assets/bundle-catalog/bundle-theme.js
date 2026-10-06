(() => {
  "use strict";

  const KEY = "avian:bundles:theme:v1";
  const QUERY = "(prefers-color-scheme: dark)";
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const embedded = params.get("embed") === "1";
  const handoff = /^[0-9a-f]{32}$/.test(params.get("handoff") || "") ? params.get("handoff") : "";
  const embeddedTheme = embedded && (params.get("theme") === "light" || params.get("theme") === "dark")
    ? params.get("theme") : "";
  const parentOrigin = (() => {
    try {
      const value = params.get("parentOrigin") || location.origin;
      const parsed = new URL(value);
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === value
        ? value : "";
    } catch (_) { return ""; }
  })();
  let media = null;
  let explicit = false;
  try { media = window.matchMedia(QUERY); } catch (_) { }

  function storedTheme() {
    try {
      const value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : "";
    } catch (_) {
      return "";
    }
  }

  function systemTheme() {
    return media?.matches ? "dark" : "light";
  }

  function exactMessage(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function themeControl() {
    return document.querySelector(".bundle-theme-switch");
  }

  function themePill(control) {
    if (!control) return null;
    let pill = control.querySelector(".bundle-theme-pill");
    if (pill) return pill;
    pill = document.createElement("i");
    pill.className = "bundle-theme-pill";
    pill.setAttribute("aria-hidden", "true");
    control.prepend(pill);
    return pill;
  }

  function syncPill() {
    const control = themeControl();
    const active = control?.querySelector('button[aria-pressed="true"]');
    const pill = themePill(control);
    if (!active || !pill) return;
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  function syncControls(theme) {
    document.querySelectorAll("[data-bundle-theme]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.bundleTheme === theme));
    });
    syncPill();
  }

  function applyTheme(theme, persist = false) {
    const next = theme === "dark" ? "dark" : "light";
    root.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content", next === "dark" ? "#17181c" : "#fcfcfb"
    );
    syncControls(next);
    if (persist) {
      explicit = true;
      try { localStorage.setItem(KEY, next); } catch (_) { }
    }
  }

  const initial = embeddedTheme || storedTheme();
  explicit = !!initial;
  applyTheme(initial || systemTheme());

  document.addEventListener("DOMContentLoaded", () => {
    syncControls(root.dataset.theme);
    themeControl()?.addEventListener("click", (event) => {
      const button = event.target.closest?.("button[data-bundle-theme]");
      if (button) {
        applyTheme(button.dataset.bundleTheme, true);
        return;
      }
      applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
    });
    document.fonts?.ready?.then(syncPill).catch(() => {});
  });

  const followSystem = () => {
    if (!explicit) applyTheme(systemTheme());
  };
  if (media?.addEventListener) media.addEventListener("change", followSystem);
  else media?.addListener?.(followSystem);

  window.addEventListener("storage", (event) => {
    if (embedded) return;
    if (event.key !== KEY && event.key !== null) return;
    const stored = storedTheme();
    explicit = !!stored;
    applyTheme(stored || systemTheme());
  });

  window.addEventListener("message", (event) => {
    if (!embedded || !handoff || !parentOrigin || event.source !== window.parent || event.origin !== parentOrigin ||
        !exactMessage(event.data, ["v", "type", "handoff", "theme"]) ||
        event.data.v !== 1 || event.data.handoff !== handoff ||
        event.data.type !== "avianvisitors:bundle-theme" ||
        (event.data.theme !== "light" && event.data.theme !== "dark")) return;
    explicit = true;
    applyTheme(event.data.theme);
  });
})();

// Frosted Pages: makes the page's large opaque backgrounds translucent, so
// the compositor blur behind the Firefox window shows through.
//
// Needs browser.tabs.allow_transparent_browser = true, otherwise Firefox paints
// an opaque backdrop behind every page. With that pref on, pages that set no
// background at all would be see-through, so on sites that are NOT frosted
// this script gives them a normal opaque background instead.
//
// Runs in the top frame of http(s) pages only (manifest.json), after defaults.js.
"use strict";

// Only page-sized surfaces are tinted: large areas, and full-width bars like
// headers and navigation. Smaller things (buttons, cards, code blocks) keep
// their background.
const MIN_WIDTH_SHARE = 0.5;
const MIN_HEIGHT_SHARE = 0.25;
const BAR_WIDTH_SHARE = 0.6;
const BAR_MIN_HEIGHT = 40;
// Panel mode (a site's panel opacity below 100%): tall columns such as a chat
// list or sidebar get the panel opacity, and the panel-mode fixes below apply.
const PANEL_MIN_WIDTH_SHARE = 0.15;
const PANEL_MIN_HEIGHT_SHARE = 0.5;
const RAIL_MIN_WIDTH = 40;
const RAIL_MIN_HEIGHT_SHARE = 0.6;
// With panels on, a surface must be this wide to count as page background.
const PAGE_WIDTH_SHARE_WITH_PANELS = 0.75;

// With panels on, surfaces that clash with the window (light ones on a dark
// desktop) would turn into grey mud when frosted, so their colors are
// inverted first (images and video inside are flipped back), like dark-mode
// extensions do. Light desktops get the mirror treatment.
const INVERT = "invert(1) hue-rotate(180deg)";
const INVERTED_ATTR = "data-frosted-inverted";
// Cleared overlays: their ::before/::after (Gmail's rail extends into the
// header that way) are cleared by the injected stylesheet too.
const CLEARED_ATTR = "data-frosted-cleared";

const host = location.hostname;
const root = document.documentElement;
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
let site = { ...DEFAULT_SITE, enabled: false }; // until the settings are loaded

// Elements we changed, with their original inline background-color and the
// page's own computed color, so changes can be redone or undone exactly.
const tinted = new Map();
// Cutout layers: a large gradient painted behind a panel, hidden by covers in
// the panel color except where some elements (chat bubbles) leave a hole.
// Frosting the covers would show the gradient everywhere, so the gradient is
// moved onto the holes instead. Original inline values, to restore:
const restyled = new Map();
// Layer element -> its original background-image.
const layerImages = new Map();
// Elements that now paint the layer gradient themselves -> their layer.
const holes = new Map();

let observer = null;
let scanTimer = 0;
// Viewport size, read once per scan: every read from the extension sandbox is
// slow, and the size checks run for each element of the page.
let vw = 0;
let vh = 0;
let fallbackStyle = null;
let frostStyle = null;

function panelsOn(s = site) {
  return s.panelOpacity < 100;
}

// Computed colors come as rgb()/rgba(), or in modern syntax (color(srgb ...),
// oklch(), lab() ...) when a site uses those; the latter are converted by
// painting them on a 1px canvas.
const colorCache = new Map();
let colorCtx = null;

function parseColor(str) {
  const m = str.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const srgb = str.match(/^color\(srgb ([^)]+)\)$/);
  if (srgb) {
    const p = srgb[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
    return { r: Math.round(p[0] * 255), g: Math.round(p[1] * 255), b: Math.round(p[2] * 255), a: p.length > 3 ? p[3] : 1 };
  }
  if (!str || str === "transparent" || str === "none") return null;
  if (colorCache.has(str)) return colorCache.get(str);
  let color = null;
  try {
    if (!colorCtx) colorCtx = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = str;
    colorCtx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
    color = { r, g, b, a: a / 255 };
  } catch (e) {}
  colorCache.set(str, color);
  return color;
}

function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// The color the page shows where it sets none: dark if its text is light.
function canvasColor() {
  const text = parseColor(getComputedStyle(document.body || root).color);
  return text && luminance(text) > 0.5 ? { r: 28, g: 27, b: 34, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
}

function sameColor(a, b) {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

// Nearest ancestor we already tinted.
function tintedAncestor(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (tinted.has(p)) return p;
  }
  return null;
}

// Popups, dropdowns and dialogs float above the page (absolute or fixed, with
// a shadow or a raised z-index); see-through they would be unreadable over
// the content behind, so they keep their own opacity.
function isFloating(el) {
  for (let p = el; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.position !== "absolute" && cs.position !== "fixed") continue;
    const r = p.getBoundingClientRect();
    if (r.width >= vw * 0.9 && r.height >= vh * 0.9) continue;
    if (cs.boxShadow !== "none" || parseInt(cs.zIndex) > 0) return true;
  }
  return false;
}

function sitsOnSameColor(el, color) {
  const below = tintedAncestor(el);
  return !!below && sameColor(tinted.get(below).color, color);
}

// panel: uses the panel opacity. stripe: shading on the surface below (rows,
// faint overlays), always fully transparent.
function tint(el, color, { panel = false, stripe = false } = {}) {
  if (!tinted.has(el)) {
    tinted.set(el, {
      value: el.style.getPropertyValue("background-color"),
      priority: el.style.getPropertyPriority("background-color"),
      color,
      panel,
      stripe,
      floating: isFloating(el),
      // A surface with the same color as the one it sits on would stack the
      // tint and look more opaque, so it becomes fully transparent instead.
      clear: stripe || sitsOnSameColor(el, color),
    });
  }
  paint(el);
}

function paint(el) {
  const { color: c, clear, panel, floating } = tinted.get(el);
  const a = clear ? 0 : floating ? c.a : Math.round(c.a * (panel ? site.panelOpacity : site.opacity)) / 100;
  el.style.setProperty("background-color", `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`, "important");
}

function untint(el) {
  const orig = tinted.get(el);
  if (orig.value) el.style.setProperty("background-color", orig.value, orig.priority);
  else el.style.removeProperty("background-color");
  tinted.delete(el);
}

function untintAll() {
  for (const el of [...tinted.keys()]) untint(el);
}

function restyle(el, props) {
  let saved = restyled.get(el);
  if (!saved) restyled.set(el, saved = {});
  for (const [prop, value] of Object.entries(props)) {
    if (!(prop in saved)) saved[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
    el.style.setProperty(prop, value, "important");
  }
}

function unrestyleAll() {
  for (const [el, saved] of restyled) {
    for (const [prop, [value, priority]] of Object.entries(saved)) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
  }
  restyled.clear();
  layerImages.clear();
  holes.clear();
  for (const el of document.querySelectorAll(`[${INVERTED_ATTR}], [${CLEARED_ATTR}]`)) {
    el.removeAttribute(INVERTED_ATTR);
    el.removeAttribute(CLEARED_ATTR);
  }
  if (frostStyle) { frostStyle.remove(); frostStyle = null; }
}

// Paint the layer's gradient on a hole exactly where the layer showed it.
function paintHole(el, layer) {
  const r = layer.getBoundingClientRect();
  restyle(el, {
    "background-image": layerImages.get(layer),
    "background-attachment": "fixed",
    "background-position": `${r.left}px ${r.top}px`,
    "background-size": `${r.width}px ${r.height}px`,
    "background-repeat": "no-repeat",
  });
}

// Borders and shadows in the surface color would frame the frosted area.
function hideSurfaceEdges(el, cs, surface) {
  const props = {};
  for (const side of ["top", "right", "bottom", "left"]) {
    const color = parseColor(cs.getPropertyValue(`border-${side}-color`));
    if (cs.getPropertyValue(`border-${side}-style`) !== "none" && parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0 &&
        color && sameColor(color, surface)) props[`border-${side}-color`] = "transparent";
  }
  if (cs.boxShadow.includes(`rgb(${surface.r}, ${surface.g}, ${surface.b})`)) props["box-shadow"] = "none";
  if (Object.keys(props).length) restyle(el, props);
}

function cutout(el, cs, layer, surface) {
  if (holes.has(el)) { paintHole(el, layer); return; }
  hideSurfaceEdges(el, cs, surface);
  const bg = parseColor(cs.backgroundColor);
  if (!tinted.has(el) && bg && bg.a >= 0.5 && sameColor(bg, surface)) { tint(el, bg, { panel: true }); return; }
  const outline = parseColor(cs.outlineColor);
  if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && outline && sameColor(outline, surface)) {
    restyle(el, { "outline-color": "transparent" });
    if ((!bg || bg.a === 0) && cs.backgroundImage === "none" && parseFloat(cs.borderTopLeftRadius) > 0) {
      holes.set(el, layer);
      paintHole(el, layer);
    }
  }
}

function isPageSized(el) {
  const w = el.clientWidth || el.offsetWidth;
  const h = el.clientHeight || el.offsetHeight;
  const share = panelsOn() ? PAGE_WIDTH_SHARE_WITH_PANELS : MIN_WIDTH_SHARE;
  return (w >= vw * share && h >= vh * MIN_HEIGHT_SHARE) ||
         (w >= vw * BAR_WIDTH_SHARE && h >= BAR_MIN_HEIGHT);
}

// Panels: columns and sidebars, including narrow full-height rails.
function isPanel(el) {
  const w = el.clientWidth || el.offsetWidth;
  const h = el.clientHeight || el.offsetHeight;
  return (w >= vw * PANEL_MIN_WIDTH_SHARE && h >= vh * PANEL_MIN_HEIGHT_SHARE) ||
         (w >= RAIL_MIN_WIDTH && h >= vh * RAIL_MIN_HEIGHT_SHARE);
}

function fitsScheme(color) {
  if (!panelsOn()) return true;
  return darkScheme.matches ? luminance(color) < 0.5 : luminance(color) >= 0.5;
}

function insideInverted(el) {
  return !!el.parentElement && !!el.parentElement.closest(`[${INVERTED_ATTR}]`);
}

function ensureFrostStyle() {
  if (!frostStyle) {
    frostStyle = document.createElement("style");
    frostStyle.textContent = `[${INVERTED_ATTR}] :is(img, video, picture, canvas, iframe, embed, object, svg image) { filter: ${INVERT} !important; }
      [${CLEARED_ATTR}]::before, [${CLEARED_ATTR}]::after { background-color: transparent !important; }`;
    (document.head || root).append(frostStyle);
  }
}

function invert(el) {
  ensureFrostStyle();
  el.setAttribute(INVERTED_ATTR, "");
  restyle(el, { filter: INVERT });
}

function markCleared(el) {
  ensureFrostStyle();
  el.setAttribute(CLEARED_ATTR, "");
}

// Sticky headers, fixed bars and overlays have the page scrolling underneath
// them, so a translucent one would show sharp content through it. They and
// everything inside them keep their own background.
// A fixed layer covering the whole window is a backdrop (Gmail's theme layer),
// not a bar, so it is frosted like the page.
function isPinned(el) {
  for (let p = el; p && p !== document.body; p = p.parentElement) {
    const pos = getComputedStyle(p).position;
    if (pos === "sticky") return true;
    if (pos === "fixed") {
      const r = p.getBoundingClientRect();
      if (r.width < vw * 0.9 || r.height < vh * 0.9) return true;
    }
  }
  return false;
}

function scan() {
  scanTimer = 0;
  if (!site.enabled || !document.body) return;
  const panels = panelsOn();
  vw = innerWidth;
  vh = innerHeight;
  withoutObserver(() => {
    // The root always gets a tint, so the page reads as one surface.
    if (!tinted.has(root)) {
      const own = parseColor(getComputedStyle(root).backgroundColor);
      const body = parseColor(getComputedStyle(document.body).backgroundColor);
      const color = own && own.a > 0 ? own : body && body.a > 0 ? body : canvasColor();
      tint(root, color);
    }
    // A solid body covering the whole window hides the root's own color
    // (Gmail: white html under a dark body), so the root must not show it.
    const rootEntry = tinted.get(root);
    const bodyEntry = tinted.get(document.body);
    const bodyColor = bodyEntry ? bodyEntry.color : parseColor(getComputedStyle(document.body).backgroundColor);
    const bodyCovers = !!bodyColor && bodyColor.a >= 0.5 && !sameColor(bodyColor, rootEntry.color) &&
      document.body.clientWidth >= vw * 0.9 && document.body.clientHeight >= vh * 0.9;
    if (rootEntry.clear !== bodyCovers) { rootEntry.clear = bodyCovers; paint(root); }
    // Headers that became sticky after scrolling get their background back.
    // Elements the page removed are forgotten: web apps that stay open for
    // days replace their DOM all the time, and holding on would leak it.
    for (const el of [...tinted.keys()]) {
      if (el !== root && (!el.isConnected || isPinned(el))) untint(el);
    }
    for (const map of [restyled, layerImages, holes]) {
      for (const el of map.keys()) if (!el.isConnected) map.delete(el);
    }
    // Once html has its own background, body's no longer fills the canvas,
    // so it is tinted like any other surface. Parents come before children,
    // and a subtree comes right after its root: once an element is outside the
    // current cutout layer, no later one is inside it.
    let layer = null;
    for (const el of [document.body, ...document.body.querySelectorAll("*")]) {
      if (layer && !layer.el.contains(el)) layer = null;
      if (layer) { cutout(el, getComputedStyle(el), layer.el, layer.surface); continue; }
      const entry = tinted.get(el);
      const page = isPageSized(el);
      if (entry) {
        // The window was resized or the page rebuilt around it: the surface may
        // have become page or panel, or no longer sit on its own color.
        const panel = !page;
        const clear = entry.stripe || sitsOnSameColor(el, entry.color);
        if (panel !== entry.panel || clear !== entry.clear) {
          Object.assign(entry, { panel, clear });
          paint(el);
        }
      } else if (page || (panels && isPanel(el))) {
        const color = parseColor(getComputedStyle(el).backgroundColor);
        if (color && color.a >= 0.5 && !isPinned(el)) {
          // Inside an inverted surface colors are already flipped.
          if (!fitsScheme(color) && !insideInverted(el)) invert(el);
          tint(el, color, { panel: !page });
        } else if (color && color.a > 0 && panels && !fitsScheme(color) && !insideInverted(el) && !isPinned(el)) {
          // A faint light overlay on a whole column (Gmail's app rail) is a
          // grey bar on dark glass: clear it.
          tint(el, color, { panel: true, stripe: true });
          markCleared(el);
        }
      } else if (panels) {
        // Any block in the color of the frosted surface it sits on (a header,
        // a toolbar, tabs) is part of that surface, whatever its size. Rows and
        // strips spanning the whole surface (Gmail's mail rows) are shading on
        // it; they would stack up and darken it, so they are cleared.
        const below = tintedAncestor(el);
        const color = below && parseColor(getComputedStyle(el).backgroundColor);
        if (color && color.a >= 0.5 && !isPinned(el)) {
          const surface = tinted.get(below).color;
          const stripe = !sameColor(color, surface) && fitsScheme(color) &&
            el.getBoundingClientRect().width >= below.getBoundingClientRect().width * 0.9;
          if (stripe || sameColor(color, surface)) tint(el, color, { panel: true, stripe });
        }
      }
      if (panels && isPanel(el)) {
        let image = layerImages.get(el);
        if (!image) {
          const own = getComputedStyle(el).backgroundImage;
          if (/^(linear|radial)-gradient\(/.test(own)) image = own;
        }
        const below = image && (tinted.get(el) || tinted.get(tintedAncestor(el)));
        if (below) {
          if (!layerImages.has(el)) { layerImages.set(el, image); restyle(el, { "background-image": "none" }); }
          hideSurfaceEdges(el, getComputedStyle(el), below.color);
          layer = { el, surface: below.color };
        }
      }
    }
  });
}

function scheduleScan(delay = 250) {
  if (!scanTimer) scanTimer = setTimeout(scan, delay);
}

function withoutObserver(fn) {
  if (observer) observer.disconnect();
  fn();
  if (observer) observer.observe(root, { childList: true, subtree: true });
}

// Not frosted: make sure a page without any background is not see-through.
function ensureOpaque() {
  const check = () => {
    if (site.enabled || !document.body) return;
    const html = parseColor(getComputedStyle(root).backgroundColor);
    const body = parseColor(getComputedStyle(document.body).backgroundColor);
    if ((html && html.a > 0) || (body && body.a > 0)) return;
    const c = canvasColor();
    fallbackStyle = document.createElement("style");
    fallbackStyle.textContent = `html { background-color: rgb(${c.r}, ${c.g}, ${c.b}) !important; }`;
    (document.head || root).append(fallbackStyle);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check, { once: true });
  else check();
}

function apply(next) {
  const prev = site;
  site = next;
  if (fallbackStyle) { fallbackStyle.remove(); fallbackStyle = null; }

  if (prev.enabled && next.enabled && panelsOn(prev) === panelsOn(next)) {
    // Only an opacity changed: repaint what we already have.
    for (const el of tinted.keys()) paint(el);
    return;
  }
  // Switched on or off, or panel mode toggled: undo everything, then start over.
  if (observer) { observer.disconnect(); observer = null; }
  untintAll();
  unrestyleAll();
  if (!next.enabled) {
    ensureOpaque();
    return;
  }
  observer = new MutationObserver(() => scheduleScan());
  observer.observe(root, { childList: true, subtree: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scan(), { once: true });
  else scan();
}

async function load() {
  // Every site is frosted unless you turned it off for that site.
  const { sites = {} } = await browser.storage.local.get("sites");
  return { ...DEFAULT_SITE, ...sites[host] };
}

// Maximized and fullscreen windows are not frosted (userChrome.css makes the
// toolbars solid then too). Pages can't see the window state, so ask the
// background script whenever the viewport changes.
let settings = null;
let windowSolid = false;

function update() {
  if (settings) apply({ ...settings, enabled: settings.enabled && !windowSolid });
}

async function checkWindow() {
  let state;
  try { state = await browser.runtime.sendMessage("window-state"); } catch (e) { return; }
  const solid = state === "maximized" || state === "fullscreen";
  if (solid !== windowSolid) {
    windowSolid = solid;
    update();
  }
}

function onResize() {
  scheduleScan();
  // The window state can settle a moment after the resize.
  checkWindow();
  setTimeout(checkWindow, 300);
}

Promise.all([load(), checkWindow()]).then(([s]) => { settings = s; update(); });
browser.storage.onChanged.addListener(changes => {
  if (changes.sites) load().then(s => { settings = s; update(); });
});
addEventListener("load", () => scheduleScan(0), { once: true });
addEventListener("resize", onResize);
addEventListener("scroll", () => scheduleScan(), { passive: true });
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkWindow(); });

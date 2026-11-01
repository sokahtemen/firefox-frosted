"use strict";
const DEFAULT_OPACITY = 50;
const DEFAULT_PANEL_OPACITY = 100;
const DEFAULTS = { enabled: true, opacity: DEFAULT_OPACITY, panelOpacity: DEFAULT_PANEL_OPACITY };
const $ = id => document.getElementById(id);
let host = "";

async function save(patch) {
  const { sites = {} } = await browser.storage.local.get("sites");
  const site = Object.assign({}, DEFAULTS, sites[host], patch);
  sites[host] = site;
  await browser.storage.local.set({ sites });
}

function show(site) {
  $("enabled").checked = site.enabled;
  $("opacity").value = site.opacity;
  $("opacity").disabled = !site.enabled;
  $("value").textContent = site.opacity + "%";
  $("panelOpacity").value = site.panelOpacity;
  $("panelOpacity").disabled = !site.enabled;
  $("panelValue").textContent = site.panelOpacity + "%";
}

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).hostname; } catch (e) {}
  if (!host || !/^https?:$/.test(new URL(tab.url).protocol)) {
    $("host").textContent = "Not available here";
    $("note").textContent = "Only works on regular web pages.";
    $("enabled").disabled = $("opacity").disabled = $("panelOpacity").disabled = true;
    return;
  }
  $("host").textContent = host;
  const { sites = {} } = await browser.storage.local.get("sites");
  show(Object.assign({}, DEFAULTS, sites[host]));

  $("enabled").addEventListener("change", e => {
    const next = { enabled: e.target.checked, opacity: +$("opacity").value, panelOpacity: +$("panelOpacity").value };
    save(next);
    show(next);
  });
  $("opacity").addEventListener("input", e => {
    $("value").textContent = e.target.value + "%";
    save({ opacity: +e.target.value });
  });
  $("panelOpacity").addEventListener("input", e => {
    $("panelValue").textContent = e.target.value + "%";
    save({ panelOpacity: +e.target.value });
  });
})();

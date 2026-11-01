// Sites are frosted by default; the toolbar button shows "OFF" on sites
// where you turned it off.
"use strict";

async function updateBadge(tab) {
  if (!tab || !tab.url) return;
  let host = "";
  try { host = new URL(tab.url).hostname; } catch (e) { return; }
  const { sites = {} } = await browser.storage.local.get("sites");
  const off = !!sites[host] && !sites[host].enabled;
  browser.browserAction.setBadgeText({ text: off ? "OFF" : "", tabId: tab.id });
}

browser.browserAction.setBadgeBackgroundColor({ color: "#4a6f8a" });
browser.tabs.onActivated.addListener(({ tabId }) => browser.tabs.get(tabId).then(updateBadge));
browser.tabs.onUpdated.addListener((id, info, tab) => { if (info.url || info.status) updateBadge(tab); });
browser.storage.onChanged.addListener(() =>
  browser.tabs.query({ active: true }).then(tabs => tabs.forEach(updateBadge)));

// Content scripts ask for their window's state (normal, maximized, fullscreen).
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg === "window-state" && sender.tab) {
    return browser.windows.get(sender.tab.windowId).then(w => w.state);
  }
});

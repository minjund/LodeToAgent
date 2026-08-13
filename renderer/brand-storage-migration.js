"use strict";

(() => {
  // These aliases are intentionally retained for one-way migration from the
  // previous product identity. New writes use only the Whitebox keys.
  const legacyPrefix = "loadtoagent";
  const currentPrefix = "whitebox";
  const persistentKeys = [
    "provider-visibility:v1",
    "dashboard-preferences:v2",
    "quality-preferences:v3",
    "session-archives:v1",
    "result-reviews:v1",
    "project-notice-acks:v1",
    "project-dismissals:v1",
    "start-guide:v1",
    "locale:v1",
    "terminal-session-order:v1",
    "terminal-view:v1",
    "theme:v1",
  ];

  for (const suffix of persistentKeys) {
    try {
      const currentKey = `${currentPrefix}:${suffix}`;
      if (localStorage.getItem(currentKey) !== null) continue;
      const legacyValue = localStorage.getItem(`${legacyPrefix}:${suffix}`);
      if (legacyValue !== null) localStorage.setItem(currentKey, legacyValue);
    } catch (_storageUnavailable) {
      // Storage can be unavailable in hardened or test contexts. Each product
      // module already falls back to its defaults in that case.
    }
  }
})();

'use strict';

// Keep identity/capability metadata anchored to the host's validated bundled
// manifest. Adapter-only runtime metadata is additive and cannot grant access.
const HOST_MANIFEST = require('../../bundled').ASIDE_MANIFEST;
const ASIDE_MANIFEST = Object.freeze({
  ...HOST_MANIFEST,
  label: HOST_MANIFEST.name,
  shortLabel: 'Aside',
  description: 'Monitor and control Aside Browser tasks through its official MCP server.',
  bundled: true,
  trusted: true,
  runtime: 'native-macos',
  minimumMacOS: 15,
  homepage: 'https://aside.com/',
  command: 'aside',
  mcpArgs: Object.freeze(['mcp']),
});

function macOSMajorFromDarwinRelease(release) {
  const darwinMajor = Number.parseInt(String(release || '').split('.')[0], 10);
  if (!Number.isFinite(darwinMajor) || darwinMajor <= 0) return 0;
  return darwinMajor >= 20 ? darwinMajor - 9 : 10;
}

function asidePlatformStatus(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return {
      supported: false,
      code: 'ASIDE_PLATFORM_UNSUPPORTED',
      reason: 'Aside Browser is available only on macOS 15 or newer.',
      platform,
      minimumMacOS: ASIDE_MANIFEST.minimumMacOS,
    };
  }
  const nativeRelease = platform === process.platform ? require('os').release() : '';
  const macOSMajor = Number(options.macOSMajor)
    || macOSMajorFromDarwinRelease(options.release || nativeRelease);
  if (macOSMajor && macOSMajor < ASIDE_MANIFEST.minimumMacOS) {
    return {
      supported: false,
      code: 'ASIDE_MACOS_TOO_OLD',
      reason: `Aside Browser requires macOS ${ASIDE_MANIFEST.minimumMacOS} or newer.`,
      platform,
      macOSMajor,
      minimumMacOS: ASIDE_MANIFEST.minimumMacOS,
    };
  }
  return {
    supported: true,
    code: 'ASIDE_PLATFORM_SUPPORTED',
    reason: '',
    platform,
    macOSMajor,
    minimumMacOS: ASIDE_MANIFEST.minimumMacOS,
  };
}

module.exports = { ASIDE_MANIFEST, asidePlatformStatus, macOSMajorFromDarwinRelease };

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ACTIVE_PROFILE_SENTINEL,
  LEGACY_USER_DATA_NAMES,
  markProfileActive,
  resolveLegacyUserDataPath,
  resolveLegacyUserDataPaths,
  selectBrandUserData,
} = require('../../src/brandMigration');
const {
  mergeRendererState,
} = require('../../src/rendererStateRecovery');

const tests = [];
function test(name, run) { tests.push({ name, run }); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-user-data-selection-'));
  const container = path.join(root, 'app-data');
  const current = path.join(container, 'Whitebox');
  return { root, container, current };
}

function remove(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

test('an existing lowercase legacy userData root is kept in place', () => {
  const value = fixture();
  try {
    const legacy = path.join(value.container, 'loadtoagent');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'terminal-sessions.json'), '[{"id":"legacy"}]');

    const result = selectBrandUserData({ userDataPath: value.current });

    assert.equal(result.path, legacy);
    assert.equal(result.source, 'legacy');
    assert.equal(result.legacyPath, legacy);
    assert.equal(result.runtimePath, legacy);
    assert.equal(result.errors.length, 0);
    assert.equal(fs.existsSync(value.current), false, 'selection must not create or copy a second store');
    assert.equal(fs.readFileSync(path.join(legacy, 'terminal-sessions.json'), 'utf8'), '[{"id":"legacy"}]');
  } finally {
    remove(value);
  }
});

test('the title-cased legacy fallback works on case-sensitive file systems', () => {
  const value = fixture();
  try {
    const legacy = path.join(value.container, 'LoadToAgent');
    const lowercase = path.join(value.container, 'loadtoagent');
    fs.mkdirSync(legacy, { recursive: true });
    const caseSensitiveFs = Object.create(fs);
    caseSensitiveFs.lstatSync = candidate => {
      if (path.resolve(candidate) === path.resolve(lowercase)) {
        const error = new Error('fixture lowercase path is missing');
        error.code = 'ENOENT';
        throw error;
      }
      return fs.lstatSync(candidate);
    };

    const result = selectBrandUserData({
      userDataPath: value.current,
      fileSystem: caseSensitiveFs,
      platform: 'linux',
    });

    assert.equal(result.path, legacy);
    assert.equal(result.runtimePath, legacy);
    assert.equal(result.source, 'legacy');
    assert.equal(result.errors.length, 0);
  } finally {
    remove(value);
  }
});

test('interim Whitebox renderer state is recovered without moving the canonical legacy profile', () => {
  const value = fixture();
  try {
    const legacy = path.join(value.container, 'loadtoagent');
    const leveldb = path.join(value.current, 'Local Storage', 'leveldb');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(leveldb, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'terminal-sessions.json'), '[{"id":"legacy-terminal"}]');
    fs.writeFileSync(path.join(leveldb, '000003.log'), 'prefix\0whitebox:result-reviews:v1\0suffix');

    const result = selectBrandUserData({ userDataPath: value.current });

    assert.equal(result.path, legacy);
    assert.equal(result.runtimePath, legacy);
    assert.equal(result.legacyPath, legacy);
    assert.equal(result.source, 'legacy');
    assert.equal(fs.readFileSync(path.join(legacy, 'terminal-sessions.json'), 'utf8'), '[{"id":"legacy-terminal"}]');
  } finally {
    remove(value);
  }
});

test('an activated Whitebox UI profile remains sticky without moving the legacy runtime store', () => {
  const value = fixture();
  try {
    const legacy = path.join(value.container, 'loadtoagent');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(value.current, { recursive: true });

    assert.deepStrictEqual(markProfileActive({ currentPath: value.current, selectedPath: value.current }), {
      written: true,
      path: path.join(value.current, ACTIVE_PROFILE_SENTINEL),
    });
    assert.equal(markProfileActive({ currentPath: value.current, selectedPath: value.current }).reason, 'already-active');
    assert.equal(markProfileActive({ currentPath: value.current, selectedPath: legacy }).reason, 'legacy-profile');

    const result = selectBrandUserData({ userDataPath: value.current });
    assert.equal(result.path, path.resolve(value.current));
    assert.equal(result.runtimePath, legacy);
    assert.equal(result.source, 'whitebox-recovered');
  } finally {
    remove(value);
  }
});

test('a new installation uses the Whitebox userData root without creating it early', () => {
  const value = fixture();
  try {
    const result = selectBrandUserData({ userDataPath: value.current });
    assert.equal(result.path, path.resolve(value.current));
    assert.equal(result.source, 'whitebox');
    assert.equal(result.legacyPath, '');
    assert.equal(result.errors.length, 0);
    assert.equal(fs.existsSync(value.current), false);
  } finally {
    remove(value);
  }
});

test('partial Whitebox data and an obsolete copy marker never outrank the live legacy store', () => {
  const value = fixture();
  try {
    const legacy = path.join(value.container, 'loadtoagent');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(path.join(value.current, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(path.join(value.current, '.whitebox-brand-migration-v1.json'), '{}');
    fs.writeFileSync(path.join(value.current, 'Local Storage', 'leveldb', 'CURRENT'), 'partial');

    const result = selectBrandUserData({ userDataPath: value.current });

    assert.equal(result.path, legacy);
    assert.equal(result.source, 'legacy');
    assert.equal(fs.readFileSync(path.join(value.current, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8'), 'partial');
  } finally {
    remove(value);
  }
});

test('an unsafe legacy entry is ignored and reported', () => {
  const value = fixture();
  try {
    fs.mkdirSync(value.container, { recursive: true });
    fs.writeFileSync(path.join(value.container, 'loadtoagent'), 'not a directory');

    const result = selectBrandUserData({ userDataPath: value.current });

    assert.equal(result.path, path.resolve(value.current));
    assert.equal(result.source, 'whitebox');
    assert.ok(result.errors.some(item => item.operation === 'validate-legacy-path'));
  } finally {
    remove(value);
  }
});

test('an explicit legacy path can be selected without relying on product casing', () => {
  const value = fixture();
  try {
    const legacy = path.join(value.container, 'custom-old-store');
    fs.mkdirSync(legacy, { recursive: true });

    const result = selectBrandUserData({
      userDataPath: value.current,
      legacyUserDataPath: legacy,
    });

    assert.equal(result.path, legacy);
    assert.equal(result.source, 'legacy');
  } finally {
    remove(value);
  }
});

test('legacy path helpers return both historical Electron casings in priority order', () => {
  const value = fixture();
  try {
    assert.deepStrictEqual(LEGACY_USER_DATA_NAMES, ['loadtoagent', 'LoadToAgent']);
    assert.equal(resolveLegacyUserDataPath(value.current), path.join(value.container, 'loadtoagent'));
    assert.deepStrictEqual(resolveLegacyUserDataPaths(value.current), [
      path.join(value.container, 'loadtoagent'),
      path.join(value.container, 'LoadToAgent'),
    ]);
  } finally {
    remove(value);
  }
});

test('renderer review state is merged across both profiles and both brand prefixes', () => {
  const source = {
    'loadtoagent:result-reviews:v1': JSON.stringify({
      shared: { stamp: 'source-old', reviewedAt: 10 },
      sourceOnly: { stamp: 'source-only', reviewedAt: 20 },
    }),
    'whitebox:result-reviews:v1': JSON.stringify({
      shared: { stamp: 'source-newer', reviewedAt: 30 },
    }),
    'whitebox:project-notice-acks:v1': JSON.stringify({
      notice: { stamp: 'seen', seenAt: 50 },
    }),
    'whitebox:theme:v1': 'light',
  };
  const destination = {
    'loadtoagent:result-reviews:v1': JSON.stringify({
      destinationOld: { stamp: 'destination-old', reviewedAt: 40 },
    }),
    'whitebox:result-reviews:v1': JSON.stringify({
      shared: { stamp: 'destination-tie', reviewedAt: 30 },
    }),
    'loadtoagent:session-archives:v1': JSON.stringify({
      archived: { responseAt: 60, archivedAt: 70 },
    }),
    'whitebox:theme:v1': 'dark',
  };
  const before = JSON.stringify({ source, destination });
  const merged = mergeRendererState({ source, destination });
  const reviews = JSON.parse(merged.values['whitebox:result-reviews:v1']);
  const notices = JSON.parse(merged.values['whitebox:project-notice-acks:v1']);
  const archives = JSON.parse(merged.values['whitebox:session-archives:v1']);

  assert.deepStrictEqual(Object.keys(reviews).sort(), ['destinationOld', 'shared', 'sourceOnly']);
  assert.equal(reviews.shared.stamp, 'destination-tie', 'equal timestamps must keep the selected destination value');
  assert.equal(reviews.sourceOnly.stamp, 'source-only');
  assert.equal(notices.notice.stamp, 'seen');
  assert.equal(archives.archived.responseAt, 60);
  assert.equal(merged.values['whitebox:theme:v1'], 'dark', 'destination current values must outrank alternate profile values');
  assert.equal(JSON.stringify({ source, destination }), before, 'logical recovery must never mutate either source snapshot');
});

test('invalid renderer records fail soft without replacing valid state', () => {
  const merged = mergeRendererState({
    source: {
      'whitebox:result-reviews:v1': '{broken',
      'whitebox:project-notice-acks:v1': JSON.stringify({ invalid: { stamp: '', seenAt: 10 } }),
    },
    destination: {
      'loadtoagent:result-reviews:v1': JSON.stringify({ valid: { stamp: 'kept', reviewedAt: 12 } }),
    },
  });
  assert.equal(JSON.parse(merged.values['whitebox:result-reviews:v1']).valid.stamp, 'kept');
  assert.deepStrictEqual(JSON.parse(merged.values['whitebox:project-notice-acks:v1']), {});
  assert.ok(merged.warnings.some(value => value.includes('invalid-json')));
});

test('invalid current preferences fall back to valid legacy profile values', () => {
  const merged = mergeRendererState({
    source: {
      'loadtoagent:theme:v1': 'light',
      'whitebox:locale:v1': 'ko',
      'whitebox:dashboard-preferences:v2': JSON.stringify({ version: 2, view: 'active' }),
      'whitebox:provider-visibility:v1': JSON.stringify({ hidden: ['gemini'] }),
    },
    destination: {
      'whitebox:theme:v1': 'sepia',
      'whitebox:locale:v1': 'invalid',
      'whitebox:dashboard-preferences:v2': '{broken',
      'whitebox:provider-visibility:v1': JSON.stringify({ hidden: 'gemini' }),
    },
  });
  assert.equal(merged.values['whitebox:theme:v1'], 'light');
  assert.equal(merged.values['whitebox:locale:v1'], 'ko');
  assert.equal(JSON.parse(merged.values['whitebox:dashboard-preferences:v2']).version, 2);
  assert.deepStrictEqual(JSON.parse(merged.values['whitebox:provider-visibility:v1']).hidden, ['gemini']);
  assert.ok(merged.warnings.filter(value => value.includes('invalid-value')).length >= 4);
});

test('current brand preferences outrank stale legacy-prefix values in either profile', () => {
  const merged = mergeRendererState({
    source: {
      'loadtoagent:theme:v1': 'dark',
      'whitebox:theme:v1': 'light',
      'loadtoagent:dashboard-preferences:v2': JSON.stringify({ version: 2, view: 'source-old' }),
      'whitebox:dashboard-preferences:v2': JSON.stringify({ version: 2, view: 'source-current' }),
    },
    destination: {
      'loadtoagent:theme:v1': 'dark',
      'loadtoagent:dashboard-preferences:v2': JSON.stringify({ version: 2, view: 'destination-old' }),
    },
  });
  assert.equal(merged.values['whitebox:theme:v1'], 'light');
  assert.equal(JSON.parse(merged.values['whitebox:dashboard-preferences:v2']).view, 'source-current');
});

test('main process keeps the legacy singleton/runtime root while assigning renderer storage separately', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(source, /app\.setPath\('userData', runtimeUserDataPath\)/);
  assert.match(source, /app\.setPath\('sessionData', rendererSessionDataPath\)/);
  assert.ok(source.indexOf('interimProfileGuardRequest = acquireInterimProfileGuard')
    < source.indexOf('app.whenReady().then'),
  '교차 버전 프로필 잠금은 Electron ready 전에 시작해야 합니다.');
  assert.match(source, /await recoverBrandRendererState\(\);/);
});

async function run() {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.run();
      passed += 1;
      process.stdout.write(`PASS ${item.name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${item.name}\n${error.stack}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${passed}/${tests.length} brand userData tests passed\n`);
}

if (require.main === module) run();

module.exports = {
  registerBrandMigrationTests: context => {
    for (const item of tests) context.test(item.name, item.run);
  },
};

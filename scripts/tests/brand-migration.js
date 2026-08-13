'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LEGACY_USER_DATA_NAMES,
  resolveLegacyUserDataPath,
  resolveLegacyUserDataPaths,
  selectBrandUserData,
} = require('../../src/brandMigration');

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
    assert.equal(result.source, 'legacy');
    assert.equal(result.errors.length, 0);
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

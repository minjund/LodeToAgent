'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { nextOccurrence, parseAutomationToml, scanCodexAutomationHomes, scanCodexAutomations } = require('../../src/automationMonitor');

function registerAutomationMonitorTests(context) {
  const { test, temp } = context;

  test('Codex 자동화에서 예약 메타데이터만 읽고 프롬프트는 노출하지 않는다', () => {
    const root = path.join(temp, 'automations');
    const folder = path.join(root, 'nightly');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'automation.toml'), [
      'version = 1',
      'id = "nightly"',
      'kind = "cron"',
      'name = "Nightly verification"',
      'prompt = """never expose this secret instruction',
      'name = "prompt-derived private name"',
      'cwds = ["/private/prompt/path"]',
      '"""',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY;BYHOUR=22;BYMINUTE=0"',
      'model = "gpt-fixture"',
      'cwds = ["/tmp/project"]',
      'created_at = 1783952317122',
      'updated_at = 1784036287963',
    ].join('\n'), 'utf8');

    const parsed = parseAutomationToml(fs.readFileSync(path.join(folder, 'automation.toml'), 'utf8'));
    assert.equal('prompt' in parsed, false);
    const items = scanCodexAutomations({ root, now: new Date(2026, 6, 16, 12, 0, 0) });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'nightly');
    assert.equal(items[0].enabled, true);
    assert.deepStrictEqual(items[0].cwds, ['/tmp/project']);
    assert.equal(JSON.stringify(items).includes('secret instruction'), false);
    assert.equal(JSON.stringify(items).includes('prompt-derived'), false);
    assert.equal(JSON.stringify(items).includes('/private/prompt/path'), false);
    const next = new Date(items[0].nextRunAt);
    assert.deepStrictEqual([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()], [2026, 6, 16, 22, 0]);
  });

  test('일간·시간·주간 반복 규칙의 다음 실행 시각을 계산한다', () => {
    const daily = new Date(nextOccurrence('FREQ=DAILY;BYHOUR=9;BYMINUTE=30', new Date(2026, 6, 16, 9, 31)));
    assert.deepStrictEqual([daily.getDate(), daily.getHours(), daily.getMinutes()], [17, 9, 30]);
    const hourly = new Date(nextOccurrence('FREQ=HOURLY;BYMINUTE=15', new Date(2026, 6, 16, 9, 10)));
    assert.deepStrictEqual([hourly.getDate(), hourly.getHours(), hourly.getMinutes()], [16, 9, 15]);
    const weekly = new Date(nextOccurrence('FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0', new Date(2026, 6, 16, 9, 0)));
    assert.deepStrictEqual([weekly.getDay(), weekly.getDate(), weekly.getHours(), weekly.getMinutes()], [5, 17, 18, 0]);
    const everyTwoHours = new Date(nextOccurrence(
      'FREQ=HOURLY;INTERVAL=2;BYMINUTE=15',
      new Date(2026, 6, 16, 10, 20),
      new Date(2026, 6, 16, 8, 15),
    ));
    assert.deepStrictEqual([everyTwoHours.getDate(), everyTwoHours.getHours(), everyTwoHours.getMinutes()], [16, 12, 15]);
    const everyTwoWeeks = new Date(nextOccurrence(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=18;BYMINUTE=0',
      new Date(2026, 6, 18, 9, 0),
      new Date(2026, 6, 12, 9, 0),
    ));
    assert.deepStrictEqual([everyTwoWeeks.getDay(), everyTwoWeeks.getDate(), everyTwoWeeks.getHours()], [5, 31, 18]);
  });

  test('로컬과 발견된 WSL 홈의 Codex 예약을 함께 수집한다', () => {
    const writeAutomation = (home, id) => {
      const folder = path.join(home, '.codex', 'automations', id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'automation.toml'), [
        `id = "${id}"`,
        `name = "${id} schedule"`,
        'status = "ACTIVE"',
        'rrule = "FREQ=DAILY;BYHOUR=22;BYMINUTE=0"',
      ].join('\n'), 'utf8');
    };
    const localHome = path.join(temp, 'automation-homes', 'local');
    const wslHome = path.join(temp, 'automation-homes', 'wsl');
    writeAutomation(localHome, 'local-daily');
    writeAutomation(wslHome, 'wsl-daily');
    const items = scanCodexAutomationHomes({
      homes: [
        { home: localHome, kind: 'windows', label: 'Local' },
        { home: wslHome, kind: 'wsl', distro: 'Ubuntu', label: 'WSL · Ubuntu' },
        { home: wslHome, kind: 'wsl', distro: 'Duplicate' },
      ],
      now: new Date(2026, 6, 16, 12, 0, 0),
    });
    assert.equal(items.length, 2);
    assert(items.some(item => item.id === 'local-daily' && item.environment.kind === 'windows'));
    assert(items.some(item => item.id === 'wsl-daily' && item.environment.distro === 'Ubuntu' && item.sourceLabel === 'WSL · Ubuntu'));
    assert(items.every(item => !Object.hasOwn(item, 'prompt')));
  });
}

module.exports = { registerAutomationMonitorTests };

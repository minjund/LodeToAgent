'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function createRegressionFixtures(root) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-test-'));

  function jsonl(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const stat = fs.statSync(file);
    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
  }

  function cleanup() {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  return { root, temp, jsonl, cleanup };
}

module.exports = { createRegressionFixtures };

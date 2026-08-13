'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const roots = ['bin', 'renderer', 'scripts', 'src'];
const files = [
  path.join(root, 'main.js'),
  path.join(root, 'preload.js'),
  path.join(root, 'attention-popup-preload.js'),
];

function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(target);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
  }
}

roots.forEach(name => collect(path.join(root, name)));
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}
console.log(`${files.length} JavaScript files passed node --check.`);

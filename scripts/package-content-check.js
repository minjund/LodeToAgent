'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmArgs = [...(npmExecPath ? [npmExecPath] : []), 'pack', '--dry-run', '--json'];
const allowedDocsAssets = [
  'docs/assets/loadtoagent-dashboard.png',
  'docs/assets/loadtoagent-demo.gif',
  'docs/assets/loadtoagent-project-session-ux-concept.png',
];
const allowedDocsAssetSet = new Set(allowedDocsAssets);

function tarballState() {
  return new Map(fs.readdirSync(root)
    .filter(name => name.endsWith('.tgz'))
    .map(name => {
      const stat = fs.statSync(path.join(root, name));
      return [name, `${stat.size}:${stat.mtimeMs}`];
    }));
}

const tarballsBefore = tarballState();
const result = spawnSync(npmCommand, npmArgs, {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32' && !npmExecPath,
  windowsHide: true,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`npm pack --dry-run failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`);
}

let reportOutput;
try {
  reportOutput = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`npm pack returned invalid JSON: ${error.message}`);
}

const reports = Array.isArray(reportOutput)
  ? reportOutput
  : (reportOutput && typeof reportOutput === 'object' ? Object.values(reportOutput) : []);

if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0].files)) {
  throw new Error('npm pack returned an unexpected report shape.');
}

const report = reports[0];
const packageFiles = report.files.map(file => {
  if (!file || typeof file.path !== 'string') throw new Error('npm pack reported a file without a path.');
  return file.path.replaceAll('\\', '/');
}).sort();
const packageFileSet = new Set(packageFiles);
const unexpectedDocs = packageFiles.filter(file => file.startsWith('docs/')
  && !/^docs\/[^/]+\.md$/.test(file)
  && !allowedDocsAssetSet.has(file));
const draftFiles = unexpectedDocs.filter(file => file.startsWith('docs/assets/ux-drafts/'));
const otherUnexpectedDocs = unexpectedDocs.filter(file => !draftFiles.includes(file));
const missingAssets = allowedDocsAssets.filter(file => !packageFileSet.has(file));
const tarballsAfter = tarballState();
const writtenTarballs = [...tarballsAfter]
  .filter(([name, state]) => tarballsBefore.get(name) !== state)
  .map(([name]) => name)
  .sort();
const problems = [];

if (draftFiles.length) problems.push(`UX drafts included:\n  ${draftFiles.join('\n  ')}`);
if (otherUnexpectedDocs.length) problems.push(`Unexpected docs content included:\n  ${otherUnexpectedDocs.join('\n  ')}`);
if (missingAssets.length) problems.push(`Required docs assets missing:\n  ${missingAssets.join('\n  ')}`);
if (writtenTarballs.length) problems.push(`Dry run wrote tarballs:\n  ${writtenTarballs.join('\n  ')}`);
if (problems.length) throw new Error(`Package content check failed:\n${problems.join('\n')}`);

console.log(`Package content check passed: ${report.entryCount} files, ${report.size} bytes (${report.unpackedSize} unpacked).`);
console.log(`Verified ${allowedDocsAssets.length} docs assets; no UX drafts, unexpected docs content, or tarball output.`);

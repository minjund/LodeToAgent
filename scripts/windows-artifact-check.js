'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'win32') throw new Error('Windows artifact verification must run on Windows.');
const releaseDir = path.resolve(process.env.WHITEBOX_RELEASE_DIR || path.join(__dirname, '..', 'release'));
const unpackedExecutable = path.join(releaseDir, 'win-unpacked', 'Whitebox.exe');
if (!fs.existsSync(unpackedExecutable)) throw new Error(`Packaged Whitebox executable was not found: ${unpackedExecutable}`);
const metadataScript = [
  "$file = Get-Item -LiteralPath $env:WHITEBOX_EXECUTABLE",
  "if ($file.Name -ne 'Whitebox.exe') { throw ('Unexpected executable name: ' + $file.Name) }",
  "if ($file.VersionInfo.ProductName -ne 'Whitebox') { throw ('Unexpected ProductName: ' + $file.VersionInfo.ProductName) }",
  "if ($file.VersionInfo.FileDescription -ne 'Whitebox') { throw ('Unexpected FileDescription: ' + $file.VersionInfo.FileDescription) }",
  "Add-Type -AssemblyName System.Drawing",
  "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($file.FullName)",
  "if ($null -eq $icon -or $icon.Width -lt 16 -or $icon.Height -lt 16) { throw 'Packaged executable has no readable icon' }",
  "$icon.Dispose()",
].join('; ');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
const powershell7 = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
const powershell = fs.existsSync(powershell7)
  ? powershell7
  : path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', metadataScript], {
  env: { ...process.env, WHITEBOX_EXECUTABLE: unpackedExecutable },
  encoding: 'utf8',
  windowsHide: true,
});
console.log('Whitebox.exe: product name, description, and embedded icon verified');
const artifacts = fs.readdirSync(releaseDir)
  .filter(name => /^Whitebox(?:-Setup)?-[0-9].*\.exe$/i.test(name) || /^Whitebox-[0-9].*-portable\.exe$/i.test(name))
  .map(name => path.join(releaseDir, name));
if (!artifacts.length) throw new Error('No Windows installer artifacts were found.');

for (const artifact of artifacts) {
  const stat = fs.statSync(artifact);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid Windows installer artifact: ${artifact}`);
  const artifactBrandScript = [
    "$file = Get-Item -LiteralPath $env:WHITEBOX_ARTIFACT",
    "if ($file.VersionInfo.ProductName -ne 'Whitebox') { throw ('Unexpected ProductName: ' + $file.VersionInfo.ProductName) }",
    "Add-Type -AssemblyName System.Drawing",
    "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($file.FullName)",
    "if ($null -eq $icon -or $icon.Width -lt 16 -or $icon.Height -lt 16) { throw 'Artifact has no readable icon' }",
    "$icon.Dispose()",
  ].join('; ');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', artifactBrandScript], {
    env: { ...process.env, WHITEBOX_ARTIFACT: artifact },
    encoding: 'utf8',
    windowsHide: true,
  });
  console.log(`${path.basename(artifact)}: Whitebox product name and embedded icon verified`);
}

if (process.env.WHITEBOX_ALLOW_UNSIGNED === 'true') {
  for (const artifact of artifacts) console.log(`${path.basename(artifact)}: unsigned artifact verified`);
  process.exit(0);
}

for (const artifact of artifacts) {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:WHITEBOX_ARTIFACT",
    "if ($signature.Status -ne 'Valid') { throw ('Invalid Authenticode signature: ' + $signature.Status) }",
    "$signature.SignerCertificate.Subject",
  ].join('; ');
  const subject = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, WHITEBOX_ARTIFACT: artifact },
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  console.log(`${path.basename(artifact)}: ${subject}`);
}

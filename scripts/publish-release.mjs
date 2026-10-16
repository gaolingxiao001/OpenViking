#!/usr/bin/env node
// Uploads what build-release.mjs produced to the release bucket:
//
//   <prefix>/releases/<version>/vika-<version>-<platform>.tar.gz (+ .sha256)
//   <prefix>/releases/<version>/release.json
//   <prefix>/install.sh        the installer, with this bucket as its download base
//   <prefix>/latest            the version, written last
//
//   VIKA_TOS_BUCKET=... VIKA_TOS_ENDPOINT=tos-sg.tiktok-row.org VIKA_TOS_ACCESS_KEY=... \
//     node scripts/publish-release.mjs [--dist dist] [--no-latest] [--force]
//
// The access key is the bucket's own key (sent as x-tos-access); keep it out
// of files and the repo. A version is never overwritten unless --force.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersion, sha256File } from '../packages/updater/src/artifacts.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

function options(argv) {
  const result = { dist: path.join(REPO, 'dist'), latest: true, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dist') result.dist = path.resolve(argv[++index]);
    else if (argv[index] === '--no-latest') result.latest = false;
    else if (argv[index] === '--force') result.force = true;
    else throw new Error(`unknown option ${argv[index]}`);
  }
  return result;
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const opts = options(process.argv.slice(2));
const bucket = required('VIKA_TOS_BUCKET');
const endpoint = required('VIKA_TOS_ENDPOINT').replace(/^https?:\/\//, '');
const accessKey = required('VIKA_TOS_ACCESS_KEY');
const prefix = (process.env.VIKA_TOS_PREFIX || 'vika').replace(/^\/+|\/+$/g, '');
const objectBase = `https://${bucket}.${endpoint}`;
const downloadBase = (process.env.VIKA_DOWNLOAD_BASE || `${objectBase}/${prefix}`).replace(/\/+$/, '');

async function request(method, key, body, contentType) {
  const response = await fetch(`${objectBase}/${key}`, {
    method,
    headers: { 'x-tos-access': accessKey, ...(contentType ? { 'content-type': contentType } : {}) },
    body,
  });
  if (method === 'HEAD') return response.status;
  if (!response.ok) throw new Error(`${method} ${key} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.status;
}

function put(key, filePathOrText, contentType) {
  const body = fs.existsSync(filePathOrText) ? fs.readFileSync(filePathOrText) : Buffer.from(filePathOrText);
  process.stderr.write(`upload ${key} (${(body.length / 1024 / 1024).toFixed(1)} MB)\n`);
  return request('PUT', key, body, contentType);
}

const manifestPath = path.join(opts.dist, 'release.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = assertVersion(manifest.version);
const releaseKey = `${prefix}/releases/${version}`;
if (!opts.force && await request('HEAD', `${releaseKey}/release.json`) === 200) {
  throw new Error(`version ${version} is already published; versions are immutable (use --force to replace)`);
}

for (const [platformId, file] of Object.entries(manifest.files)) {
  const archive = path.join(opts.dist, file.name);
  if (sha256File(archive) !== file.sha256) throw new Error(`${file.name} does not match release.json`);
  // Each release tells its updater where newer ones live; it must be this bucket.
  const inner = JSON.parse(execFileSync('tar', ['-xzOf', archive, `vika-${version}-${platformId}/release.json`], { encoding: 'utf8' }));
  if (inner.downloadBase !== downloadBase) {
    throw new Error(`${file.name} was built for ${inner.downloadBase || 'no download base'}, not ${downloadBase}; rebuild with --download-base ${downloadBase}`);
  }
  await put(`${releaseKey}/${file.name}`, archive, 'application/gzip');
  await put(`${releaseKey}/${file.name}.sha256`, `${file.sha256}  ${file.name}\n`, 'text/plain');
}
await put(`${releaseKey}/release.json`, manifestPath, 'application/json');
const installer = fs.readFileSync(path.join(REPO, 'scripts', 'install.sh'), 'utf8').replace('__VIKA_DOWNLOAD_BASE__', downloadBase);
await put(`${prefix}/install.sh`, installer, 'text/plain; charset=utf-8');
if (opts.latest) await put(`${prefix}/latest`, `${version}\n`, 'text/plain');
process.stdout.write(`published vika ${version}\ninstall: curl -fsSL ${downloadBase}/install.sh | sh\n`);

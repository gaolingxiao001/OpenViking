import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const INSTALLER = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const PLATFORM = `${process.platform}-${process.arch}`;

// A home directory, a fake pm2 that records any call, and a release archive
// laid out like build-release.mjs makes them.
function machine(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vika-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\necho "$@" >> "${root}/pm2-calls"\n`, { mode: 0o755 });
  const archive = (version, { platform = PLATFORM, nodeWorks = true } = {}) => {
    const work = fs.mkdtempSync(path.join(root, 'build-'));
    const directory = path.join(work, `vika-${version}-${platform}`);
    fs.mkdirSync(path.join(directory, 'node', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'packages', 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'node', 'bin', 'node'), `#!/bin/sh\nexit ${nodeWorks ? 0 : 1}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(directory, 'packages', 'cli', 'bin', 'vika.mjs'), '');
    const file = path.join(root, `vika-${version}-${platform}.tar.gz`);
    execFileSync('tar', ['-czf', file, '-C', work, path.basename(directory)]);
    fs.writeFileSync(`${file}.sha256`, `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}\n`);
    return file;
  };
  const install = (...args) => spawnSync('sh', [INSTALLER, '--no-setup', ...args], {
    encoding: 'utf8',
    env: { HOME: home, SHELL: '/bin/bash', PATH: `${bin}:${process.env.PATH}` },
  });
  const vika = path.join(home, '.vika');
  return { root, home, vika, archive, install, pm2Calls: () => fs.existsSync(path.join(root, 'pm2-calls')) };
}

test('installs a release under ~/.vika, adds the launcher and PATH, and never touches pm2', (t) => {
  const m = machine(t);
  const first = m.install('--file', m.archive('0.5.0'));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.realpathSync(path.join(m.vika, 'current')), fs.realpathSync(path.join(m.vika, 'releases', '0.5.0')));
  const launcher = fs.readFileSync(path.join(m.vika, 'bin', 'vika'), 'utf8');
  assert.match(launcher, /exec "\$HOME\/\.vika\/current\/node\/bin\/node" "\$HOME\/\.vika\/current\/packages\/cli\/bin\/vika\.mjs" "\$@"/);
  assert.equal(fs.statSync(path.join(m.vika, 'bin', 'vika')).mode & 0o111, 0o111);
  assert.match(fs.readFileSync(path.join(m.home, '.bashrc'), 'utf8'), /export PATH="\$HOME\/\.vika\/bin:\$PATH"/);
  assert.equal(fs.existsSync(path.join(m.vika, 'deploy.lock')), false, 'the lock is released');
  assert.match(first.stderr, /下一步：.*vika setup/);

  const second = m.install('--file', m.archive('0.6.0'));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.realpathSync(path.join(m.vika, 'rollback')), fs.realpathSync(path.join(m.vika, 'releases', '0.5.0')));
  assert.match(second.stderr, /vika restart/);
  const again = m.install('--file', m.archive('0.6.0'));
  assert.match(again.stderr, /已经是 Vika 0\.6\.0/);
  assert.equal(fs.readFileSync(path.join(m.home, '.bashrc'), 'utf8').match(/\.vika\/bin/g).length, 1, 'PATH is added once');
  assert.equal(m.pm2Calls(), false);
});

test('refuses a corrupted archive, another platform, or a Node that cannot run here, leaving the install as it was', (t) => {
  const m = machine(t);
  assert.equal(m.install('--file', m.archive('0.5.0')).status, 0);
  const corrupted = m.archive('0.6.0');
  fs.writeFileSync(`${corrupted}.sha256`, `${'0'.repeat(64)}  x\n`);
  const bad = m.install('--file', corrupted);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /校验失败/);

  const other = m.install('--file', m.archive('0.6.0', { platform: PLATFORM === 'linux-x64' ? 'darwin-arm64' : 'linux-x64' }));
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /不是给/);

  const broken = m.install('--file', m.archive('0.6.1', { nodeWorks: false }));
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /运行不了这个版本/);
  assert.equal(fs.realpathSync(path.join(m.vika, 'current')), fs.realpathSync(path.join(m.vika, 'releases', '0.5.0')));
  assert.deepEqual(fs.readdirSync(path.join(m.vika, 'releases')), ['0.5.0']);
  assert.equal(fs.existsSync(path.join(m.vika, 'deploy.lock')), false);
});

test('waits for a running upgrade instead of racing it', (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.vika, 'deploy.lock'), { recursive: true });
  const blocked = m.install('--file', m.archive('0.5.0'));
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /另一个安装或升级正在进行/);
  assert.ok(fs.existsSync(path.join(m.vika, 'deploy.lock')), 'someone else\'s lock is left alone');
});

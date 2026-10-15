import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const RELEASE_METADATA = '.lark-release.json';

export const DEFAULT_REMOTE_URL = 'https://github.com/ZaynJarvis/lark-daemon.git';
export const DEFAULT_REMOTE_BRANCH = 'main';

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function cleanBuildEnv(source = process.env) {
  const keys = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'XDG_CACHE_HOME',
  ];
  return Object.fromEntries(keys
    .filter((key) => typeof source[key] === 'string' && source[key] !== '')
    .map((key) => [key, source[key]]));
}

function commandOutput(result) {
  return String(result?.stdout || '').trim();
}

async function run(execFileImpl, command, args, options = {}) {
  return execFileImpl(command, args, {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function validateBranch(branch, gitBin, execFileImpl) {
  if (typeof branch !== 'string' || branch === '') throw new Error('updater remote branch must be non-empty');
  try {
    await run(execFileImpl, gitBin, ['check-ref-format', `refs/heads/${branch}`]);
  } catch {
    throw new Error(`invalid updater remote branch: ${branch}`);
  }
}

async function ensureMirror({ mirrorDir, remoteUrl, gitBin, execFileImpl }) {
  const info = await lstat(mirrorDir).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) {
    await mkdir(path.dirname(mirrorDir), { recursive: true, mode: 0o700 });
    await run(execFileImpl, gitBin, ['init', '--bare', mirrorDir]);
    await run(execFileImpl, gitBin, ['--git-dir', mirrorDir, 'remote', 'add', 'origin', remoteUrl]);
    return;
  }
  if (!info.isDirectory()) throw new Error(`updater mirror is not a directory: ${mirrorDir}`);
  const bare = commandOutput(await run(execFileImpl, gitBin, ['--git-dir', mirrorDir, 'rev-parse', '--is-bare-repository']));
  if (bare !== 'true') throw new Error(`updater mirror is not a bare Git repository: ${mirrorDir}`);
  let configuredUrl;
  try {
    configuredUrl = commandOutput(await run(
      execFileImpl,
      gitBin,
      ['--git-dir', mirrorDir, 'remote', 'get-url', 'origin'],
    ));
  } catch {
    throw new Error(`updater mirror has no origin remote: ${mirrorDir}`);
  }
  if (configuredUrl !== remoteUrl) {
    throw new Error(`updater mirror origin mismatch: expected ${remoteUrl}`);
  }
}

async function currentRelease(baseDir) {
  // `baseDir` may be reached through a compatibility symlink (for example
  // /home -> /data00/home). Compare canonical paths so the current release
  // is not rejected solely because `current` was resolved but `releases` was
  // not.
  const releasesRoot = await realpath(path.join(baseDir, 'releases')).catch((error) => {
    if (error?.code === 'ENOENT') return path.resolve(baseDir, 'releases');
    throw error;
  });
  const release = await realpath(path.join(baseDir, 'current')).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!release) return null;
  if (!isInside(releasesRoot, release)) throw new Error(`current release must resolve inside ${releasesRoot}`);
  return release;
}

async function readReleaseMetadata(release) {
  if (!release) return null;
  try {
    return JSON.parse(await readFile(path.join(release, RELEASE_METADATA), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function releaseTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function atomicSymlink(target, linkPath) {
  const temporary = `${linkPath}.pending-${process.pid}-${Date.now()}`;
  await symlink(target, temporary);
  try {
    await rename(temporary, linkPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function defaultValidateRelease(release, { npmBin, execFileImpl, buildEnv }) {
  // Install into this unpublished release. A failed install must leave the
  // current release (including its Pi executable) intact and rollbackable.
  await run(execFileImpl, npmBin, ['ci', '--no-audit', '--no-fund'], {
    cwd: release,
    env: buildEnv,
    timeout: 300_000,
  });
  await run(execFileImpl, npmBin, ['run', 'check:pi'], {
    cwd: release,
    env: buildEnv,
    timeout: 30_000,
  });
  await run(execFileImpl, npmBin, ['test'], {
    cwd: release,
    env: buildEnv,
    timeout: 300_000,
  });
  await run(execFileImpl, npmBin, ['run', 'check'], {
    cwd: release,
    env: buildEnv,
    timeout: 300_000,
  });
}

export async function publishLatestRelease({
  baseDir = path.join(os.homedir(), '.local', 'lib', 'lark-daemon'),
  mirrorDir = process.env.LARK_UPDATER_GIT_DIR || path.join(baseDir, 'upstream.git'),
  remoteUrl = process.env.LARK_UPDATER_REMOTE_URL || DEFAULT_REMOTE_URL,
  remoteBranch = process.env.LARK_UPDATER_REMOTE_BRANCH || DEFAULT_REMOTE_BRANCH,
  gitBin = process.env.GIT_BIN || 'git',
  tarBin = process.env.TAR_BIN || 'tar',
  npmBin = process.env.NPM_BIN || 'npm',
  execFileImpl = execFile,
  validateReleaseImpl = defaultValidateRelease,
  buildEnv = cleanBuildEnv(),
  now = () => new Date(),
} = {}) {
  if (typeof remoteUrl !== 'string' || remoteUrl === '') throw new Error('updater remote URL must be non-empty');
  await validateBranch(remoteBranch, gitBin, execFileImpl);
  await ensureMirror({ mirrorDir, remoteUrl, gitBin, execFileImpl });
  const remoteRef = `refs/remotes/origin/${remoteBranch}`;
  await run(execFileImpl, gitBin, [
    '--git-dir',
    mirrorDir,
    'fetch',
    '--force',
    '--prune',
    '--no-tags',
    'origin',
    `+refs/heads/${remoteBranch}:${remoteRef}`,
  ], { timeout: 300_000 });
  const commit = commandOutput(await run(
    execFileImpl,
    gitBin,
    ['--git-dir', mirrorDir, 'rev-parse', `${remoteRef}^{commit}`],
  ));
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('updater resolved an invalid Git commit');

  const previousRelease = await currentRelease(baseDir);
  const previousMetadata = await readReleaseMetadata(previousRelease);
  if (
    previousMetadata?.version === 1
    && previousMetadata.commit === commit
    && previousMetadata.remoteUrl === remoteUrl
    && previousMetadata.remoteBranch === remoteBranch
  ) {
    await access(path.join(previousRelease, 'ecosystem.config.cjs'));
    return {
      release: previousRelease,
      commit,
      published: false,
      previousRelease,
    };
  }

  const releasesRoot = path.join(baseDir, 'releases');
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  const pending = await mkdtemp(path.join(releasesRoot, '.pending-'));
  const archive = `${pending}.tar`;
  let finalRelease = null;
  let moved = false;
  try {
    await run(execFileImpl, gitBin, [
      '--git-dir',
      mirrorDir,
      'archive',
      '--format=tar',
      `--output=${archive}`,
      commit,
    ]);
    await run(execFileImpl, tarBin, ['-xf', archive, '-C', pending]);

    const packageJson = JSON.parse(await readFile(path.join(pending, 'package.json'), 'utf8'));
    const version = packageJson?.version;
    if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
      throw new Error('release package version is not path-safe');
    }
    await writeFile(path.join(pending, RELEASE_METADATA), `${JSON.stringify({
      version: 1,
      commit,
      remoteUrl,
      remoteBranch,
    }, null, 2)}\n`, { mode: 0o644 });
    await validateReleaseImpl(pending, { npmBin, execFileImpl, buildEnv });

    finalRelease = path.join(
      releasesRoot,
      `${version}-${releaseTimestamp(now())}-${commit.slice(0, 12)}`,
    );
    await rename(pending, finalRelease);
    moved = true;
    if (previousRelease && previousRelease !== finalRelease) {
      await atomicSymlink(previousRelease, path.join(baseDir, 'rollback'));
    }
    await atomicSymlink(finalRelease, path.join(baseDir, 'current'));
    return {
      release: finalRelease,
      commit,
      published: true,
      previousRelease,
    };
  } catch (error) {
    if (!moved) await rm(pending, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(archive, { force: true });
  }
}

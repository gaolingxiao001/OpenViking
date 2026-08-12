import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { projectDir as daemonProjectDir } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function sourceFiles(directory) {
  return fs.readdirSync(directory)
    .filter((name) => /\.(?:mjs|js)$/.test(name))
    .map((name) => path.join(directory, name));
}

describe('module boundaries', () => {
  it('loads daemon configuration from the release root', () => {
    assert.equal(daemonProjectDir, root);
  });

  it('defines two homomorphic daemons plus one shared web and updater', () => {
    const require = createRequire(import.meta.url);
    const ecosystemPath = path.join(root, 'ecosystem.config.cjs');
    delete require.cache[require.resolve(ecosystemPath)];
    const ecosystem = require(ecosystemPath);
    assert.deepEqual(
      ecosystem.apps.map((app) => app.name),
      ['lark-daemon-zayn', 'lark-daemon-sally', 'lark-web', 'lark-updater'],
    );
    const [zayn, sally, web, updater] = ecosystem.apps;
    assert.match(zayn.script, /packages\/daemon\/src\/main\.mjs$/);
    assert.equal(zayn.script, sally.script);
    assert.equal(zayn.cwd, sally.cwd);
    assert.equal(zayn.kill_timeout, sally.kill_timeout);
    assert.match(web.script, /packages\/web\/src\/main\.mjs$/);
    assert.equal(zayn.env.LARK_DAEMON_PORT, '3738');
    assert.equal(zayn.env.LARK_DAEMON_DATA_DIR, undefined);
    assert.equal(zayn.env.LARK_DAEMON_WORKSPACE, undefined);
    assert.equal(sally.env.LARK_DAEMON_PORT, '3740');
    assert.equal(sally.env.LARK_DAEMON_PROFILE, 'sally');
    assert.equal(zayn.env.LARK_DAEMON_AGENT_NAME, undefined);
    assert.equal(sally.env.LARK_DAEMON_AGENT_NAME, '斯斯');
    assert.equal(web.env.LARK_WEB_PORT, '3737');
    assert.deepEqual(
      JSON.parse(web.env.LARK_WEB_INSTANCES).map(({ id, port }) => ({ id, port })),
      [{ id: 'zayn', port: 3738 }, { id: 'sally', port: 3740 }],
    );
    assert.match(updater.script, /packages\/updater\/src\/main\.mjs$/);
    assert.match(updater.env.LARK_UPDATER_SOCKET, /updater\.sock$/);
    assert.equal(zayn.wait_ready, true);
    assert.equal(sally.wait_ready, true);
    assert.equal(web.wait_ready, true);
    assert.equal(updater.wait_ready, true);
    assert.equal(fs.existsSync(path.join(root, 'ecosystem.sally.config.cjs')), false);
  });

  it('keeps the web module independent from SQLite and daemon source code', () => {
    const webFiles = sourceFiles(path.join(root, 'packages', 'web', 'src'));
    assert.ok(webFiles.length >= 3);
    const webSource = webFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(webSource, /node:sqlite|store\.mjs|packages\/daemon/);
    assert.doesNotMatch(webSource, /loadProjectEnv|readFileSync\([^)]*\.env/);

    const daemonSource = sourceFiles(path.join(root, 'packages', 'daemon', 'src'))
      .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(daemonSource, /packages\/web|web\/public|activity\.(?:css|js)/);

    const updaterSource = sourceFiles(path.join(root, 'packages', 'updater', 'src'))
      .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(updaterSource, /packages\/daemon|store\.mjs|lark\.mjs/);
  });

  it('runs all package test suites from the root command', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(manifest.scripts.test, /packages\/daemon\/test\/\*\.test\.mjs/);
    assert.match(manifest.scripts.test, /packages\/web\/test\/\*\.test\.mjs/);
    assert.match(manifest.scripts.test, /packages\/updater\/test\/\*\.test\.mjs/);
  });

  it('publishes a tested release without mutating runtime processes', () => {
    const deploy = fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf8');
    assert.match(deploy, /DEPLOY_LOCK=.*deploy\.lock/);
    assert.match(deploy, /if ! mkdir "\$DEPLOY_LOCK"/);
    assert.match(deploy, /npm test[^\n]*npm run check/);
    assert.match(deploy, /ln -sf "\$ENV_FILE" "\$REL\/\.env"/);
    assert.match(deploy, /ln -sfn "\$REL" "\$BASE\/current"/);
    assert.match(deploy, /ln -sfn "\$PREV" "\$BASE\/rollback"/);
    assert.match(deploy, /lark-daemon upgrade zayn\|sally\|all/);
    assert.match(deploy, /refusing to replace foreign CLI symlink/);
    assert.match(deploy, /refusing to replace existing CLI path/);
    assert.doesNotMatch(deploy, /pm2_control\(\)/);
    assert.doesNotMatch(deploy, /^\s*pm2 (?:delete|start|save)/m);
  });

  it('bootstraps only the updater with a clean environment and a bounded rollback', () => {
    const bootstrap = fs.readFileSync(path.join(root, 'scripts', 'bootstrap-updater.sh'), 'utf8');
    assert.match(bootstrap, /pm2_control\(\)/);
    assert.match(bootstrap, /env -i/);
    assert.match(bootstrap, /delete lark-updater/);
    assert.match(bootstrap, /start "\$CONFIG" --only lark-updater --update-env/);
    assert.doesNotMatch(bootstrap, /startOrReload/);
    assert.match(bootstrap, /--unix-socket "\$SOCKET" http:\/\/localhost\/ready/);
    assert.match(bootstrap, /"\$BASE"\/releases\/\*\/packages\/updater\/src\/main\.mjs/);
    assert.match(bootstrap, /restoring \$PREVIOUS_RELEASE/);
    assert.doesNotMatch(bootstrap, /--only (?:all|lark-daemon)/);
  });

  it('allows exact sibling operations without permitting self or broad PM2 control', () => {
    const prompt = fs.readFileSync(
      path.join(root, 'packages', 'daemon', 'agent', 'system-prompt.md'),
      'utf8',
    );
    assert.match(prompt, /Never directly restart, stop, reconfigure, or deploy the PM2 application that owns the active turn/);
    assert.match(prompt, /Self-updates must go through an allowlisted external updater\/supervisor/);
    assert.match(prompt, /lark-daemon upgrade zayn\|sally\|all/);
    assert.match(prompt, /without running `deploy\.sh`/);
    assert.match(prompt, /may manage an explicitly named sibling daemon\/web pair only after verifying/);
    assert.match(prompt, /Never use broad PM2 selectors or touch unrelated applications/);
    assert.doesNotMatch(prompt, /Never deploy, restart, stop, or reconfigure lark-daemon or lark-web yourself/);
  });
});

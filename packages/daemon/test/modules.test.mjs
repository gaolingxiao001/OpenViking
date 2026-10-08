import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

  it('builds every daemon plus shared web and updater from one manifest', () => {
    const require = createRequire(import.meta.url);
    const ecosystemPath = path.join(root, 'ecosystem.config.cjs');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ecosystem-'));
    const manifestPath = path.join(directory, 'deployment.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      version: 1,
      defaultInstance: 'beta',
      env: {
        LARK_DAEMON_LOG_LEVEL: 'info',
        LARK_DAEMON_DRY_RUN: 'false',
      },
      agents: [
        {
          id: 'alpha',
          displayName: 'Alpha',
          profile: 'cli_alpha',
          port: 3738,
          dataDir: '/Users/test/.local/share/lark-daemon-alpha',
          workspace: '/Users/test/Documents/work/alpha-workspace',
          ovConfig: '/Users/test/.openviking/ovcli.conf.alpha',
          model: 'gpt-5.6-sol',
          meetingAudio: {
            targetChatId: 'oc_target12345678',
            pythonCommand: '/usr/bin/python3',
            asrConfigFile: '/Users/test/.config/lark-daemon/alpha-asr.yaml',
          },
        },
        {
          id: 'beta',
          displayName: 'Beta',
          profile: 'cli_beta',
          port: 3740,
          dataDir: '/Users/test/.local/share/lark-daemon-beta',
          workspace: '/Users/test/Documents/work/beta-workspace',
          ovConfig: '/Users/test/.openviking/ovcli.conf.beta',
          model: 'ark',
          volcSessionId: 'sesn-beta-self-hosted',
          volcEnvironmentId: 'env-beta-self-hosted',
        },
      ],
    }, null, 2)}\n`);
    const env = {
      HOME: '/Users/test',
      PATH: '/safe/bin',
      LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath,
      LARK_DAEMON_LOG_LEVEL: 'debug',
      ARK_API_KEY: 'system-only-secret',
      LARK_DAEMON_VOLC_SESSION_ID: 'seed-session-ref',
      SESSION_ID: 'generic-session-ref',
    };
    const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    let ecosystem;
    let manifestOnlyEcosystem;
    try {
      delete require.cache[require.resolve(ecosystemPath)];
      const { buildEcosystem } = require(ecosystemPath);
      ecosystem = buildEcosystem(env);
      manifestOnlyEcosystem = buildEcosystem({
        HOME: '/Users/test',
        PATH: '/safe/bin',
        LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath,
      });
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
    assert.deepEqual(
      ecosystem.apps.map((app) => app.name),
      ['lark-daemon-alpha', 'lark-daemon-beta', 'lark-web', 'lark-updater'],
    );
    const [alpha, beta, web, updater] = ecosystem.apps;
    assert.match(alpha.script, /packages\/daemon\/src\/main\.mjs$/);
    assert.match(web.script, /packages\/web\/src\/main\.mjs$/);
    assert.equal(alpha.env.LARK_DAEMON_PORT, '3738');
    assert.equal(alpha.env.LARK_DAEMON_HTTP_ENABLED, 'true');
    assert.equal(alpha.env.LARK_DAEMON_EVENT_MODE, 'raw');
    assert.equal(alpha.env.LARK_DAEMON_PROFILE, 'cli_alpha');
    assert.equal(alpha.env.LARKSUITE_CLI_PROFILE, 'cli_alpha');
    assert.equal(alpha.env.LARK_DAEMON_AGENT_NAME, 'Alpha');
    assert.equal(alpha.env.LARK_DAEMON_UPGRADE_TARGET, 'alpha');
    assert.equal(alpha.env.OPENVIKING_CLI_CONFIG_FILE, '/Users/test/.openviking/ovcli.conf.alpha');
    assert.equal(alpha.env.LARK_DAEMON_CODEX_MODEL, undefined);
    assert.equal(alpha.env.LARK_DAEMON_MODEL, 'gpt-5.6-sol');
    assert.equal(alpha.env.LARK_DAEMON_MEETING_AUDIO_ENABLED, 'true');
    assert.equal(alpha.env.LARK_DAEMON_MEETING_AUDIO_WORKER_COMMAND, '/usr/bin/python3');
    assert.equal(alpha.env.LARK_DAEMON_MEETING_AUDIO_ASR_CONFIG_FILE, '/Users/test/.config/lark-daemon/alpha-asr.yaml');
    assert.deepEqual(JSON.parse(alpha.env.LARK_DAEMON_MEETING_AUDIO_WORKER_ARGS_JSON).slice(1, 3), [
      '--worker-dir',
      path.join(root, 'meeting-asr'),
    ]);
    assert.equal(alpha.env.LARK_DAEMON_LOG_LEVEL, 'debug');
    assert.equal(alpha.env.LARK_DAEMON_DRY_RUN, 'false');
    assert.equal(alpha.env.ARK_API_KEY, 'system-only-secret');
    assert.equal(alpha.env.LARK_DAEMON_VOLC_SESSION_ID, '');
    assert.equal(alpha.env.LARK_DAEMON_VOLC_ENVIRONMENT_ID, '');
    assert.equal(beta.env.LARK_DAEMON_PROFILE, 'cli_beta');
    assert.equal(beta.env.LARK_DAEMON_MODEL, 'ark');
    assert.equal(beta.env.LARK_DAEMON_CODEX_MODEL, undefined);
    assert.equal(beta.env.LARK_DAEMON_VOLC_SESSION_ID, 'sesn-beta-self-hosted');
    assert.equal(beta.env.LARK_DAEMON_VOLC_ENVIRONMENT_ID, 'env-beta-self-hosted');
    assert.equal(beta.env.LARK_DAEMON_MEETING_AUDIO_ENABLED, undefined);
    assert.equal(web.env.LARK_WEB_PORT, '3737');
    assert.equal(web.env.LARK_WEB_DEFAULT_INSTANCE, 'beta');
    const effectiveWebEnv = Object.fromEntries(Object.entries({
      ...env,
      ...web.env,
    }).filter(([key]) => !web.filter_env.some((prefix) => key.startsWith(prefix))));
    assert.equal(effectiveWebEnv.ARK_API_KEY, undefined);
    assert.equal(effectiveWebEnv.LARK_DAEMON_VOLC_SESSION_ID, undefined);
    assert.equal(effectiveWebEnv.SESSION_ID, undefined);
    assert.deepEqual(
      JSON.parse(web.env.LARK_WEB_INSTANCES),
      [
        { id: 'alpha', label: 'Alpha', host: '127.0.0.1', port: 3738 },
        { id: 'beta', label: 'Beta', host: '127.0.0.1', port: 3740 },
      ],
    );
    assert.match(updater.script, /packages\/updater\/src\/main\.mjs$/);
    assert.match(updater.env.LARK_UPDATER_SOCKET, /updater\.sock$/);
    assert.equal(updater.env.LARK_DAEMON_DEPLOYMENT_MANIFEST, manifestPath);
    assert.equal(updater.env.LARK_DAEMON_LOG_LEVEL, 'debug');
    assert.equal(updater.env.ARK_API_KEY, 'system-only-secret');
    assert.equal(updater.env.LARK_DAEMON_DRY_RUN, undefined);
    assert.equal(web.env.LARK_DAEMON_LOG_LEVEL, undefined);
    const [manifestOnlyAlpha, , , manifestOnlyUpdater] = manifestOnlyEcosystem.apps;
    assert.equal(manifestOnlyAlpha.env.LARK_DAEMON_LOG_LEVEL, 'info');
    assert.equal(manifestOnlyAlpha.env.LARK_DAEMON_DRY_RUN, 'false');
    assert.equal(manifestOnlyUpdater.env.LARK_DAEMON_LOG_LEVEL, undefined);
    assert.equal(manifestOnlyUpdater.env.LARK_DAEMON_DRY_RUN, undefined);
    assert.deepEqual(JSON.parse(updater.env.LARK_UPDATER_TARGETS_JSON), {
      alpha: {
        app: 'lark-daemon-alpha',
        readyUrl: 'http://127.0.0.1:3738/ready',
        upgradeSharedWeb: false,
      },
      beta: {
        app: 'lark-daemon-beta',
        readyUrl: 'http://127.0.0.1:3740/ready',
        upgradeSharedWeb: false,
      },
    });
    assert.equal(alpha.wait_ready, true);
    assert.equal(beta.wait_ready, true);
    assert.equal(web.wait_ready, true);
    assert.equal(updater.wait_ready, true);
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
    assert.match(deploy, /loadDeploymentManifest\(process\.env\)/);
    assert.doesNotMatch(deploy, /ENV_FILE|REL\/\.env|REPO\/\.env|BASE\/env/);
    assert.match(deploy, /ln -sfn "\$REL" "\$BASE\/current"/);
    assert.match(deploy, /ln -sfn "\$PREV" "\$BASE\/rollback"/);
    assert.match(deploy, /lark-daemon upgrade <target\|all>/);
    assert.match(deploy, /refusing to replace foreign CLI symlink/);
    assert.match(deploy, /refusing to replace existing CLI path/);
    assert.doesNotMatch(deploy, /pm2_control\(\)/);
    assert.doesNotMatch(deploy, /^\s*pm2 (?:delete|start|save)/m);
  });

  it('bootstraps only the updater with a clean environment and a bounded rollback', () => {
    const bootstrap = fs.readFileSync(path.join(root, 'scripts', 'bootstrap-updater.sh'), 'utf8');
    assert.match(bootstrap, /pm2_control\(\)/);
    assert.match(bootstrap, /env -i/);
    assert.match(bootstrap, /LARK_DAEMON_DEPLOYMENT_MANIFEST/);
    assert.match(bootstrap, /LARK_DAEMON_LOG_LEVEL/);
    assert.match(bootstrap, /ARK_API_KEY/);
    assert.match(bootstrap, /LARK_DAEMON_VOLC_SESSION_ID/);
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
    assert.match(prompt, /lark-daemon upgrade \{\{LARK_DAEMON_UPGRADE_TARGET\}\}/);
    assert.match(prompt, /without running `deploy\.sh`/);
    assert.match(prompt, /may manage an explicitly named sibling daemon\/web pair only after verifying/);
    assert.match(prompt, /Never use broad PM2 selectors or touch unrelated applications/);
    assert.doesNotMatch(prompt, /Never deploy, restart, stop, or reconfigure lark-daemon or lark-web yourself/);
  });
});

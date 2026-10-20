import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, projectDir } from '../src/config.mjs';
import { managedPiBin } from '../src/pi-runtime.mjs';
import { assembleConversationPolicy as loadSystemPrompt } from '../src/conversation-policy.mjs';

const saved = new Map();

function setEnv(name, value) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe('configuration safety', { concurrency: false }, () => {
  it('accepts Telegram as primary and alongside existing connectors without putting keys in config', () => {
    setEnv('VIKA_CHANNEL', 'telegram');
    setEnv('VIKA_CONNECTORS_JSON', '["telegram","weixin"]');
    const config = getConfig();
    assert.equal(config.channel, 'telegram');
    assert.deepEqual(config.connectors, ['telegram', 'weixin']);
    assert.equal(config.telegramToken, undefined);
  });
  it('accepts Slack and a bot reply fuse that defaults to 20 and can be turned off', () => {
    setEnv('VIKA_CHANNEL', 'slack');
    setEnv('VIKA_CONNECTORS_JSON', '["slack","lark"]');
    setEnv('VIKA_BOT_REPLY_FUSE', undefined);
    const config = getConfig();
    assert.equal(config.channel, 'slack');
    assert.equal(config.botReplyFuse, 20);
    setEnv('VIKA_BOT_REPLY_FUSE', '0');
    assert.equal(getConfig().botReplyFuse, 0);
    setEnv('VIKA_BOT_REPLY_FUSE', '-1');
    assert.throws(() => getConfig(), /VIKA_BOT_REPLY_FUSE/);
  });
  it('keeps meeting audio entirely disabled unless explicitly configured', () => {
    setEnv('VIKA_MEETING_AUDIO_ENABLED', 'false');
    setEnv('VIKA_MEETING_AUDIO_TARGET_CHAT_ID', undefined);
    setEnv('VIKA_MEETING_AUDIO_WORKER_COMMAND', undefined);
    assert.equal(getConfig().meetingAudio, null);
  });

  it('builds an isolated SQLite spool and worker command only behind the feature flag', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-asr-config-'));
    const asrConfigFile = path.join(directory, 'config.yaml');
    fs.writeFileSync(asrConfigFile, 'asr: {}\n', { mode: 0o600 });
    setEnv('VIKA_MEETING_AUDIO_ENABLED', 'true');
    setEnv('VIKA_MEETING_AUDIO_TARGET_CHAT_ID', 'oc_target12345678');
    setEnv('VIKA_MEETING_AUDIO_WORKER_COMMAND', '/usr/bin/python3');
    setEnv('VIKA_MEETING_AUDIO_WORKER_ARGS_JSON', '["worker.py"]');
    setEnv('VIKA_MEETING_AUDIO_ASR_CONFIG_FILE', asrConfigFile);
    try {
      const config = getConfig();
      assert.match(config.meetingAudio.spoolPath, /meeting-audio-spool\.sqlite3$/);
      assert.deepEqual(config.meetingAudio.workerArgs, ['worker.py', '--config', asrConfigFile]);
      assert.equal(config.meetingAudio.asrConfigFile, asrConfigFile);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires a private ASR credential file instead of accepting secrets in worker env', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-asr-private-'));
    const asrConfigFile = path.join(directory, 'config.yaml');
    fs.writeFileSync(asrConfigFile, 'asr: {}\n', { mode: 0o644 });
    setEnv('VIKA_MEETING_AUDIO_ENABLED', 'true');
    setEnv('VIKA_MEETING_AUDIO_TARGET_CHAT_ID', 'oc_target12345678');
    setEnv('VIKA_MEETING_AUDIO_WORKER_COMMAND', '/usr/bin/python3');
    setEnv('VIKA_MEETING_AUDIO_WORKER_ARGS_JSON', '["worker.py"]');
    setEnv('VIKA_MEETING_AUDIO_ASR_CONFIG_FILE', asrConfigFile);
    try {
      assert.throws(() => getConfig(), /ASR_CONFIG_FILE must have mode 0600/);
      fs.chmodSync(asrConfigFile, 0o600);
      setEnv('VIKA_MEETING_AUDIO_WORKER_ARGS_JSON', '["worker.py","--config","other.yaml"]');
      assert.throws(() => getConfig(), /must not contain --config/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('takes mailboxes only with private account files, and never as the primary IM', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-email-config-'));
    const accountFile = path.join(directory, 'email.json');
    const otherFile = path.join(directory, 'other.json');
    fs.writeFileSync(accountFile, '{}', { mode: 0o644 });
    fs.writeFileSync(otherFile, '{}', { mode: 0o600 });
    setEnv('VIKA_CHANNEL', 'lark');
    setEnv('VIKA_CONNECTORS_JSON', '["lark","email"]');
    const accounts = (list) => setEnv('VIKA_EMAIL_ACCOUNTS_JSON', JSON.stringify(list));
    try {
      setEnv('VIKA_EMAIL_ACCOUNTS_JSON', undefined);
      assert.throws(() => getConfig(), /VIKA_EMAIL_ACCOUNTS_JSON must list the mailboxes/);
      accounts([{ id: 'email-gmail', config: accountFile }]);
      assert.throws(() => getConfig(), /email account file of email-gmail must have mode 0600/);
      fs.chmodSync(accountFile, 0o600);
      accounts([{ id: 'email-gmail', config: accountFile }, { id: 'email-gmail', config: otherFile }]);
      assert.throws(() => getConfig(), /invalid or repeated mailbox id/);
      accounts([{ id: 'gmail', config: accountFile }]);
      assert.throws(() => getConfig(), /invalid or repeated mailbox id/);
      accounts([{ id: 'email-gmail', config: accountFile }, { id: 'email-qq', config: otherFile }]);
      assert.deepEqual([getConfig().connectors, getConfig().emailAccounts],
        [['lark', 'email'], [{ id: 'email-gmail', configFile: accountFile }, { id: 'email-qq', configFile: otherFile }]]);
      setEnv('VIKA_CHANNEL', 'email');
      assert.throws(() => getConfig(), /VIKA_CHANNEL/);
    } finally {
      setEnv('VIKA_EMAIL_ACCOUNTS_JSON', undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a mismatched daemon and lark-cli profile', () => {
    setEnv('VIKA_LARK_PROFILE', 'cli_expected');
    setEnv('LARKSUITE_CLI_PROFILE', 'cli_wrong');
    assert.throws(() => getConfig(), /must match LARKSUITE_CLI_PROFILE/);
  });

  it('rejects a non-loopback health server', () => {
    setEnv('VIKA_HOST', '0.0.0.0');
    assert.throws(() => getConfig(), /loopback/);
  });

  it('rejects writable workspaces that contain the daemon', () => {
    setEnv('VIKA_WORKSPACE', path.dirname(projectDir));
    assert.throws(() => getConfig(), /running daemon directory/);
  });

  it('rejects an out-of-range codex effort', () => {
    setEnv('VIKA_CODEX_EFFORT', 'turbo');
    assert.throws(() => getConfig(), /VIKA_CODEX_EFFORT/);
  });

  it('does not read the removed Codex model environment variable', () => {
    setEnv('VIKA_MODEL', undefined);
    setEnv('VIKA_CODEX_MODEL', 'gpt-5.6-sol');
    const config = getConfig();
    assert.equal(config.initialModel, '');
    assert.equal(Object.hasOwn(config, 'codexModel'), false);
  });

  it('accepts TraeX CLI path and reasoning effort', () => {
    setEnv('TRAEX_BIN', '/opt/local/bin/traecli');
    setEnv('TRAECLI_BIN', '/ignored/traecli');
    setEnv('VIKA_TRAEX_EFFORT', 'xhigh');
    const config = getConfig();
    assert.equal(config.traexBin, '/opt/local/bin/traecli');
    assert.equal(config.traexEffort, 'xhigh');

    setEnv('TRAEX_BIN', undefined);
    assert.equal(getConfig().traexBin, '/ignored/traecli');

    setEnv('VIKA_TRAEX_EFFORT', 'turbo');
    assert.throws(() => getConfig(), /VIKA_TRAEX_EFFORT/);
  });

  it('accepts Pi CLI path and thinking-level effort', () => {
    setEnv('PI_BIN', undefined);
    assert.equal(getConfig().piBin, managedPiBin());
    setEnv('PI_BIN', '/opt/homebrew/bin/pi');
    setEnv('VIKA_PI_MODEL', 'openai/gpt-4o');
    setEnv('VIKA_PI_EFFORT', 'xhigh');
    const config = getConfig();
    assert.equal(config.piBin, '/opt/homebrew/bin/pi');
    assert.equal(config.piModel, 'openai/gpt-4o');
    assert.equal(config.piEffort, 'xhigh');
    setEnv('VIKA_PI_EFFORT', 'turbo');
    assert.throws(() => getConfig(), /VIKA_PI_EFFORT/);
  });

  it('loads the managed-agent seed session without exposing the API key publicly', () => {
    setEnv('ARK_API_KEY', 'secret-test-key');
    setEnv('VIKA_MODEL', 'ark');
    setEnv('VIKA_VOLC_SESSION_ID', 'sesn-test12345678');
    setEnv('VIKA_VOLC_ENVIRONMENT_ID', 'env-test12345678');
    setEnv('SESSION_ID', 'sesn-generic-wins-only-as-fallback');
    const config = getConfig();
    assert.equal(config.volcApiKey, 'secret-test-key');
    assert.equal(config.volcSessionId, 'sesn-test12345678');
    assert.equal(config.volcEnvironmentId, 'env-test12345678');
    assert.equal(config.volcBaseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
    assert.equal(config.initialModel, 'ark');
  });

  it('rejects a non-HTTPS managed-agent endpoint', () => {
    setEnv('VIKA_VOLC_BASE_URL', 'http://ark.example.test/api/v3');
    assert.throws(() => getConfig(), /valid HTTPS URL/);
  });
});

describe('release-owned system prompt', () => {
  it('loads the single prompt file and substitutes release configuration', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-prompt-'));
    const systemPromptPath = path.join(directory, 'system-prompt.md');
    const empty = path.join(directory, 'empty.md');
    fs.writeFileSync(systemPromptPath, 'policy\n\n{{TEAM_TASK_BOARD_URL}}\n\n{{AGENT_NAME}}\n\n{{VIKA_UPGRADE_TARGET}}\n');
    fs.writeFileSync(empty, '');
    try {
      const text = loadSystemPrompt({
        systemPromptPath,
        openVikingPromptPath: empty,
        openVikingConfigPath: path.join(directory, 'ovcli.conf'),
        harnessPromptPath: empty,
        teamTaskBoardUrl: 'https://board.example',
        agentName: '斯斯',
        upgradeTarget: 'sisi',
      });
      assert.match(text, /^policy\n\nhttps:\/\/board\.example\n\n斯斯\n\nsisi/);
      assert.match(text, /<context-workdir>/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds meeting capability policy only when the feature is enabled', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-prompt-audio-'));
    const systemPromptPath = path.join(directory, 'system-prompt.md');
    const empty = path.join(directory, 'empty.md');
    fs.writeFileSync(systemPromptPath, 'base\n');
    fs.writeFileSync(empty, '');
    try {
      const baseConfig = {
        systemPromptPath,
        openVikingPromptPath: empty,
        openVikingConfigPath: path.join(directory, 'ovcli.conf'),
        harnessPromptPath: empty,
      };
      const withoutAudio = loadSystemPrompt({ ...baseConfig, meetingAudio: null });
      assert.match(withoutAudio, /^base/);
      assert.match(withoutAudio, /<context-workdir>/);
      assert.doesNotMatch(withoutAudio, /no implicit delivery target/);
      assert.match(
        loadSystemPrompt({ ...baseConfig, meetingAudio: {} }),
        /no implicit delivery target/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds the mail rules only when a mailbox is connected, on Lark and Weixin alike', () => {
    const rules = /^# Email$/m;
    assert.doesNotMatch(loadSystemPrompt({ connectors: ['lark'] }), rules);
    for (const connectors of [['lark', 'email'], ['weixin', 'email']]) {
      const policy = loadSystemPrompt({ connectors });
      assert.match(policy, rules);
      assert.match(policy, /You never send mail\./);
      assert.match(policy, /A non-chat event reaches people only through the owner/);
    }
    assert.match(loadSystemPrompt({ connectors: ['weixin', 'email'] }), /^# Weixin conversation policy/);
  });

  it('configures one release prompt with no mutable kernel paths', () => {
    const config = getConfig();
    assert.match(config.systemPromptPath, /agent\/system-prompt\.md$/);
    assert.equal('kernelInnerPath' in config, false);
    assert.equal('kernelOuterPath' in config, false);
    assert.equal('kernelOuterDataPath' in config, false);
  });
});

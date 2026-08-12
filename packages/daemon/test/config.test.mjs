import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, loadSystemPrompt, projectDir } from '../src/config.mjs';

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
  it('keeps meeting audio entirely disabled unless explicitly configured', () => {
    setEnv('LARK_DAEMON_MEETING_AUDIO_ENABLED', 'false');
    setEnv('LARK_DAEMON_MEETING_AUDIO_TARGET_CHAT_ID', undefined);
    setEnv('LARK_DAEMON_MEETING_AUDIO_WORKER_COMMAND', undefined);
    assert.equal(getConfig().meetingAudio, null);
  });

  it('builds an isolated SQLite spool and worker command only behind the feature flag', () => {
    setEnv('LARK_DAEMON_MEETING_AUDIO_ENABLED', 'true');
    setEnv('LARK_DAEMON_MEETING_AUDIO_TARGET_CHAT_ID', 'oc_target12345678');
    setEnv('LARK_DAEMON_MEETING_AUDIO_WORKER_COMMAND', '/usr/bin/python3');
    setEnv('LARK_DAEMON_MEETING_AUDIO_WORKER_ARGS_JSON', '["worker.py"]');
    const config = getConfig();
    assert.match(config.meetingAudio.spoolPath, /meeting-audio-spool\.sqlite3$/);
    assert.deepEqual(config.meetingAudio.workerArgs, ['worker.py']);
    assert.match(config.meetingAudio.authoritySocketPath, /meeting-audio-authority\.sock$/);
  });

  it('accepts only raw event mode', () => {
    setEnv('LARK_DAEMON_EVENT_MODE', 'raw');
    assert.equal(getConfig().eventMode, 'raw');
    setEnv('LARK_DAEMON_EVENT_MODE', 'compact');
    assert.throws(() => getConfig(), /must be raw/);
  });

  it('rejects a non-loopback health server', () => {
    setEnv('LARK_DAEMON_HOST', '0.0.0.0');
    assert.throws(() => getConfig(), /loopback/);
  });

  it('rejects writable workspaces that contain the daemon', () => {
    setEnv('LARK_DAEMON_WORKSPACE', path.dirname(projectDir));
    assert.throws(() => getConfig(), /running daemon directory/);
  });

  it('rejects an out-of-range codex effort', () => {
    setEnv('LARK_DAEMON_CODEX_EFFORT', 'turbo');
    assert.throws(() => getConfig(), /LARK_DAEMON_CODEX_EFFORT/);
  });
});

describe('release-owned system prompt', () => {
  it('loads the single prompt file and substitutes release configuration', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-prompt-'));
    const systemPromptPath = path.join(directory, 'system-prompt.md');
    fs.writeFileSync(systemPromptPath, 'policy\n\n{{TEAM_TASK_BOARD_URL}}\n\n{{AGENT_NAME}}\n');
    try {
      assert.equal(loadSystemPrompt({
        systemPromptPath,
        teamTaskBoardUrl: 'https://board.example',
        agentName: '斯斯',
      }), 'policy\n\nhttps://board.example\n\n斯斯\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds meeting capability policy only when the feature is enabled', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-prompt-audio-'));
    const systemPromptPath = path.join(directory, 'system-prompt.md');
    fs.writeFileSync(systemPromptPath, 'base\n');
    try {
      assert.equal(loadSystemPrompt({ systemPromptPath, meetingAudio: null }), 'base\n');
      assert.match(
        loadSystemPrompt({ systemPromptPath, meetingAudio: {} }),
        /decision_capability/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('configures one release prompt with no mutable kernel paths', () => {
    const config = getConfig();
    assert.match(config.systemPromptPath, /agent\/system-prompt\.md$/);
    assert.equal('kernelInnerPath' in config, false);
    assert.equal('kernelOuterPath' in config, false);
    assert.equal('kernelOuterDataPath' in config, false);
  });
});

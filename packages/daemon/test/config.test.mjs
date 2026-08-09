import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, loadSystemPrompt, loadSystemPromptDetail, projectDir } from '../src/config.mjs';

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

describe('two-layer kernel system prompt', () => {
  function kernelFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-kernel-'));
    const releaseDir = path.join(directory, 'release');
    const dataDir = path.join(directory, 'data');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, 'kernel-inner.md'), '# Policy\n\ninner core\n');
    fs.writeFileSync(path.join(releaseDir, 'kernel-outer.md'), '## Team task board\n\n{{TEAM_TASK_BOARD_URL}}\n\n## Persona\n\nouter voice\n');
    return {
      directory,
      config: {
        kernelInnerPath: path.join(releaseDir, 'kernel-inner.md'),
        kernelOuterPath: path.join(releaseDir, 'kernel-outer.md'),
        kernelOuterDataPath: path.join(dataDir, 'kernel-outer.md'),
        systemPromptPath: path.join(releaseDir, 'system-prompt.md'),
        teamTaskBoardUrl: 'https://board.example',
      },
    };
  }

  it('assembles inner + outer, seeds the mutable outer copy once, and substitutes tokens', () => {
    const { directory, config } = kernelFixture();
    try {
      const first = loadSystemPromptDetail(config);
      assert.equal(first.source, 'kernel');
      assert.equal(first.outerSeeded, true);
      assert.equal(first.outerPath, config.kernelOuterDataPath);
      assert.match(first.text, /^# Policy\n\ninner core\n\n## Team task board/);
      assert.match(first.text, /https:\/\/board\.example/);
      assert.ok(fs.existsSync(config.kernelOuterDataPath));

      // Workspace edits to the data-dir copy win over the release copy.
      fs.writeFileSync(config.kernelOuterDataPath, '## Persona\n\nedited persona\n');
      const second = loadSystemPromptDetail(config);
      assert.equal(second.outerSeeded, false);
      assert.match(second.text, /edited persona/);
      assert.doesNotMatch(second.text, /outer voice/);
      // The inner security core always comes from the release.
      assert.match(second.text, /inner core/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the release outer kernel without seeding when no data copy path is configured', () => {
    const { directory, config } = kernelFixture();
    try {
      delete config.kernelOuterDataPath;
      const detail = loadSystemPromptDetail(config);
      assert.equal(detail.outerSeeded, false);
      assert.match(detail.text, /outer voice/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to a legacy single-file system-prompt.md when kernel files are absent', () => {
    const { directory, config } = kernelFixture();
    try {
      fs.rmSync(config.kernelInnerPath);
      fs.writeFileSync(config.systemPromptPath, 'legacy prompt {{TEAM_TASK_BOARD_URL}}\n');
      const detail = loadSystemPromptDetail(config);
      assert.equal(detail.source, 'legacy');
      assert.equal(detail.text, 'legacy prompt https://board.example\n');
      assert.equal(loadSystemPrompt(config), detail.text);
      assert.ok(!fs.existsSync(config.kernelOuterDataPath));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getConfig } from '../src/config.mjs';

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
    setEnv('LARK_DAEMON_WORKSPACE', '/Users/bytedance/Documents/work');
    assert.throws(() => getConfig(), /running daemon directory/);
  });

  it('rejects markdown delivery', () => {
    setEnv('LARK_DAEMON_REPLY_FORMAT', 'markdown');
    assert.throws(() => getConfig(), /LARK_DAEMON_REPLY_FORMAT/);
  });
});

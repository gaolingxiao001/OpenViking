import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyOpenVikingChildEnv,
  isOpenVikingEnvKey,
  loadOpenVikingIdentity,
  openVikingChildEnv,
  openVikingIdentityUris,
  openVikingUserId,
} from '../src/openviking.mjs';
import { sanitizeAgentChildEnv } from '../src/process-utils.mjs';

describe('OpenViking env seam', () => {
  it('copies only OPENVIKING_ keys', () => {
    const env = openVikingChildEnv({
      PATH: '/bin',
      OPENVIKING_CLI_CONFIG_FILE: '/tmp/ov.conf',
      OPENVIKING_AUTO_RECALL: '0',
      LARK_APP_SECRET: 'no',
    });
    assert.deepEqual(env, {
      OPENVIKING_CLI_CONFIG_FILE: '/tmp/ov.conf',
      OPENVIKING_AUTO_RECALL: '0',
    });
    assert.equal(isOpenVikingEnvKey('OPENVIKING_CLI_CONFIG_FILE'), true);
    assert.equal(isOpenVikingEnvKey('LARK_DAEMON_DATA_DIR'), false);
  });

  it('is the only writer of OPENVIKING_ keys on a child env', () => {
    const next = applyOpenVikingChildEnv({
      PATH: '/bin',
      OPENVIKING_CLI_CONFIG_FILE: 'stale',
      OPENVIKING_AUTO_CAPTURE: 'drop-me',
    }, {
      OPENVIKING_CLI_CONFIG_FILE: '/tmp/fresh.conf',
    });
    assert.equal(next.PATH, '/bin');
    assert.equal(next.OPENVIKING_CLI_CONFIG_FILE, '/tmp/fresh.conf');
    assert.equal(next.OPENVIKING_AUTO_CAPTURE, undefined);
  });

  it('lets agent children keep OPENVIKING_ after Lark/Ark stripping', () => {
    const env = sanitizeAgentChildEnv({
      PATH: '/bin',
      LARK_APP_SECRET: 'no',
      ARK_API_KEY: 'no',
      OPENVIKING_CLI_CONFIG_FILE: '/tmp/ov.conf',
      OPENVIKING_MEMORY_ENABLED: '1',
    }, { profile: 'fixed' });
    assert.equal(env.LARK_APP_SECRET, undefined);
    assert.equal(env.ARK_API_KEY, undefined);
    assert.equal(env.OPENVIKING_CLI_CONFIG_FILE, '/tmp/ov.conf');
    assert.equal(env.OPENVIKING_MEMORY_ENABLED, '1');
    assert.equal(env.LARKSUITE_CLI_PROFILE, 'fixed');
  });

  it('reads the identity over OV HTTP, identity.md first', async () => {
    assert.deepEqual(openVikingIdentityUris('amy'), [
      'viking://user/amy/identity.md',
      'viking://user/amy/memories/identity.md',
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ov-id-'));
    const filePath = path.join(directory, 'ov.json');
    fs.writeFileSync(filePath, JSON.stringify({ user: 'amy', account: 'hs' }));
    const config = { openVikingConfigPath: filePath };
    const missing = Object.assign(new Error('missing'), { httpStatus: 404 });
    const client = (files) => ({
      reads: [],
      async read(uri, offset, limit) {
        this.reads.push({ uri, offset, limit });
        if (files[uri] instanceof Error) throw files[uri];
        if (uri in files) return files[uri];
        throw missing;
      },
    });
    try {
      assert.equal(openVikingUserId(config, {}), 'amy');

      const preferred = client({
        'viking://user/amy/identity.md': '  hello\n',
        'viking://user/amy/memories/identity.md': 'unused',
      });
      assert.deepEqual(await loadOpenVikingIdentity(config, { client: preferred, env: {} }), {
        user: 'amy',
        uri: 'viking://user/amy/identity.md',
        text: 'hello',
      });
      assert.deepEqual(preferred.reads, [{ uri: 'viking://user/amy/identity.md', offset: 0, limit: -1 }]);

      for (const first of [missing, '']) {
        const fallback = client({
          'viking://user/amy/identity.md': first,
          'viking://user/amy/memories/identity.md': 'fallback identity',
        });
        assert.deepEqual(await loadOpenVikingIdentity(config, { client: fallback, env: {} }), {
          user: 'amy',
          uri: 'viking://user/amy/memories/identity.md',
          text: 'fallback identity',
        });
      }

      assert.deepEqual(await loadOpenVikingIdentity(config, { client: client({}), env: {} }), {
        user: 'amy',
        uri: 'viking://user/amy/identity.md',
        text: '',
      });

      // Only a missing file falls through; an outage is reported.
      const down = client({ 'viking://user/amy/identity.md': new Error('OpenViking session request failed (HTTP 503)') });
      await assert.rejects(loadOpenVikingIdentity(config, { client: down, env: {} }), /HTTP 503/);
      assert.equal(down.reads.length, 1);

      const noUser = client({});
      assert.deepEqual(await loadOpenVikingIdentity({}, { client: noUser, env: {} }), { user: '', uri: '', text: '' });
      assert.deepEqual(noUser.reads, []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

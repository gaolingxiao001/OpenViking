import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { getConfig } from '../src/config.mjs';

const KEYS = [
  'VIKA_WEB_HOST',
  'VIKA_WEB_PORT',
  'VIKA_WEB_DAEMON_HOST',
  'VIKA_WEB_DAEMON_PORT',
  'VIKA_WEB_INSTANCES',
  'VIKA_WEB_DEFAULT_INSTANCE',
];
let previous;

beforeEach(() => {
  previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test('web config accepts a fixed loopback allowlist of daemon instances', () => {
  process.env.VIKA_WEB_HOST = '0.0.0.0';
  process.env.VIKA_WEB_INSTANCES = JSON.stringify([
    { id: 'zayn', label: 'Zayn', host: '127.0.0.1', port: 3738 },
    { id: 'sally', label: '斯斯', host: 'localhost', port: 3740 },
  ]);
  process.env.VIKA_WEB_DEFAULT_INSTANCE = 'sally';
  const config = getConfig();
  assert.deepEqual(config.instances.map(({ id, label, port }) => ({ id, label, port })), [
    { id: 'zayn', label: 'Zayn', port: 3738 },
    { id: 'sally', label: '斯斯', port: 3740 },
  ]);
  assert.equal(config.defaultInstance, 'sally');
  assert.equal(config.host, '0.0.0.0');
  assert.ok(Object.isFrozen(config.instances));
});

test('web routes are not capped to a fixed agent count', () => {
  process.env.VIKA_WEB_INSTANCES = JSON.stringify(Array.from({ length: 32 }, (_, index) => ({
    id: `agent-${index}`,
    label: `Agent ${index}`,
    host: '127.0.0.1',
    port: 4000 + index,
  })));
  process.env.VIKA_WEB_DEFAULT_INSTANCE = 'agent-17';
  const config = getConfig();
  assert.equal(config.instances.length, 32);
  assert.equal(config.defaultInstance, 'agent-17');
});

test('web config rejects arbitrary upstreams, duplicate ids, and an unknown default', () => {
  process.env.VIKA_WEB_INSTANCES = JSON.stringify([
    { id: 'zayn', label: 'Zayn', host: 'example.test', port: 3738 },
  ]);
  assert.throws(() => getConfig(), /loopback/);

  process.env.VIKA_WEB_INSTANCES = JSON.stringify([
    { id: 'zayn', label: 'Zayn', host: '127.0.0.1', port: 3738 },
    { id: 'zayn', label: 'Other', host: '127.0.0.1', port: 3740 },
  ]);
  assert.throws(() => getConfig(), /duplicate.*id/);

  process.env.VIKA_WEB_INSTANCES = JSON.stringify([
    { id: 'zayn', label: 'Zayn', host: '127.0.0.1', port: 3738 },
  ]);
  process.env.VIKA_WEB_DEFAULT_INSTANCE = 'sally';
  assert.throws(() => getConfig(), /must name an entry/);
});

test('web config rejects arbitrary bind hosts while allowing wildcard listeners', () => {
  process.env.VIKA_WEB_HOST = 'example.test';
  assert.throws(() => getConfig(), /wildcard or loopback/);
  process.env.VIKA_WEB_HOST = '::';
  assert.equal(getConfig().host, '::');
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EFFORT_LEVELS,
  commandCandidate,
  executeCommand,
  matchPrefix,
  parseCommand,
} from '../src/commands.mjs';

function fakeCodex(overrides = {}) {
  const calls = [];
  return {
    calls,
    threadId: 'th-live',
    model: '',
    effort: 'medium',
    async rotateSession(options) { calls.push(['rotate', options]); return 'th-new'; },
    async setModel(model) { calls.push(['setModel', model]); return 'th-new'; },
    async setEffort(effort) { calls.push(['setEffort', effort]); return 'th-new'; },
    ...overrides,
  };
}

describe('parseCommand', () => {
  it('returns null for anything that does not start with a slash', () => {
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand('说说 /new 是什么'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand(null), null);
  });

  it('matches exact names and unambiguous prefixes, case-insensitively', () => {
    assert.deepEqual(parseCommand('/new'), { name: 'new', arg: '' });
    assert.deepEqual(parseCommand('  /h  '), { name: 'help', arg: '' });
    assert.deepEqual(parseCommand('/M gpt-5.5'), { name: 'model', arg: 'gpt-5.5' });
    assert.deepEqual(parseCommand('/eff high'), { name: 'effort', arg: 'high' });
  });

  it('keeps everything after the command token as one arg', () => {
    assert.deepEqual(parseCommand('/model  a  b '), { name: 'model', arg: 'a b' });
  });

  it('reports unknown and bare-slash tokens without a name', () => {
    const unknown = parseCommand('/foo bar');
    assert.equal(unknown.name, null);
    assert.equal(unknown.token, 'foo');
    assert.deepEqual(unknown.matches, []);
    assert.equal(parseCommand('/').name, null);
  });
});

describe('commandCandidate', () => {
  it('passes p2p text through unchanged', () => {
    assert.equal(commandCandidate({ chatType: 'p2p', content: ' /new ', mentions: [] }), '/new');
    assert.equal(commandCandidate({ chatType: 'p2p', content: '普通消息', mentions: [] }), '普通消息');
  });

  it('requires a mention in group chats', () => {
    assert.equal(commandCandidate({ chatType: 'group', content: '/help', mentions: [] }), null);
    assert.equal(commandCandidate({ chatType: 'group', content: '/help' }), null);
  });

  it('strips mention placeholders around the command in a group', () => {
    const mentions = [{ key: '@_user_1', name: 'Zayn', id: 'ou_bot12345678' }];
    assert.equal(
      commandCandidate({ chatType: 'group', content: '@_user_1 /new', mentions }),
      '/new',
    );
    assert.equal(
      commandCandidate({ chatType: 'group', content: '/model gpt-5.5 @_user_1', mentions }),
      '/model gpt-5.5',
    );
    assert.equal(
      commandCandidate({ chatType: 'group', content: '@_user_1 帮我看看', mentions }),
      '帮我看看',
    );
  });
});

describe('matchPrefix', () => {
  it('lets an exact match win over longer candidates and reports ambiguity', () => {
    assert.deepEqual(matchPrefix('low', ['low', 'lower']), ['low']);
    assert.deepEqual(matchPrefix('m', EFFORT_LEVELS), ['minimal', 'medium']);
    assert.deepEqual(matchPrefix('', EFFORT_LEVELS), []);
  });
});

describe('executeCommand', () => {
  it('help reports commands and current session state', async () => {
    const codex = fakeCodex({ threadId: 'th-42', model: 'gpt-x', effort: 'high' });
    const outcome = await executeCommand({ name: 'help', arg: '' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /\/new/);
    assert.match(outcome.text, /th-42/);
    assert.match(outcome.text, /gpt-x/);
    assert.match(outcome.text, /high/);
    assert.equal(codex.calls.length, 0);
  });

  it('new rotates the session without resume', async () => {
    const codex = fakeCodex();
    const outcome = await executeCommand({ name: 'new', arg: '' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /th-new/);
    assert.deepEqual(codex.calls, [['rotate', { resume: false }]]);
  });

  it('new while disconnected still succeeds with a deferred message', async () => {
    const codex = fakeCodex({ rotateSession: async () => null });
    const outcome = await executeCommand({ name: 'new', arg: '' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /重连/);
  });

  it('model without an arg reports the current model and the available options', async () => {
    const codex = fakeCodex({
      model: '',
      listModels: async () => [
        { id: 'gpt-5.5', efforts: ['low', 'medium'] },
        { id: 'gpt-5.5-codex', efforts: [] },
      ],
    });
    const outcome = await executeCommand({ name: 'model', arg: '' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /（默认）/);
    assert.match(outcome.text, /可选：gpt-5\.5、gpt-5\.5-codex/);
    assert.equal(codex.calls.length, 0);
  });

  it('model resolves prefixes against the live list and rejects unknown or ambiguous names', async () => {
    const codex = fakeCodex({
      listModels: async () => [
        { id: 'gpt-5.5', efforts: [] },
        { id: 'gpt-5.5-codex', efforts: [] },
      ],
    });

    const prefixed = await executeCommand({ name: 'model', arg: 'gpt-5.5-c' }, codex);
    assert.equal(prefixed.ok, true);
    assert.deepEqual(codex.calls, [['setModel', 'gpt-5.5-codex']]);

    const exact = await executeCommand({ name: 'model', arg: 'gpt-5.5' }, codex);
    assert.equal(exact.ok, true);
    assert.deepEqual(codex.calls.at(-1), ['setModel', 'gpt-5.5']);

    const ambiguous = await executeCommand({ name: 'model', arg: 'gpt' }, codex);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.text, /歧义/);

    const unknown = await executeCommand({ name: 'model', arg: 'claude-x' }, codex);
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /未找到模型/);
    assert.equal(codex.calls.length, 2);
  });

  it('model accepts a raw name when no list is available and rejects garbage', async () => {
    const codex = fakeCodex({ listModels: async () => [] });
    const outcome = await executeCommand({ name: 'model', arg: 'gpt-5.5-codex' }, codex);
    assert.equal(outcome.ok, true);
    assert.deepEqual(codex.calls, [['setModel', 'gpt-5.5-codex']]);

    const bad = await executeCommand({ name: 'model', arg: 'rm -rf /' }, codex);
    assert.equal(bad.ok, false);
    assert.equal(codex.calls.length, 1);
  });

  it('effort prefix-matches a level and rejects ambiguous or unknown input', async () => {
    const codex = fakeCodex();
    const high = await executeCommand({ name: 'effort', arg: 'h' }, codex);
    assert.equal(high.ok, true);
    assert.match(high.text, /已开启新会话/);
    assert.deepEqual(codex.calls, [
      ['setEffort', 'high'],
      ['rotate', { resume: false }],
    ]);

    const ambiguous = await executeCommand({ name: 'effort', arg: 'm' }, codex);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.text, /minimal、medium/);

    const unknown = await executeCommand({ name: 'effort', arg: 'turbo' }, codex);
    assert.equal(unknown.ok, false);
    assert.equal(codex.calls.length, 2);
  });

  it('effort validates against the current model and rejects unsupported levels', async () => {
    const codex = fakeCodex({
      model: 'gpt-5.6-sol',
      listModels: async () => [
        { id: 'gpt-5.5', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
        { id: 'gpt-5.6-sol', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
      ],
    });

    const unsupported = await executeCommand({ name: 'effort', arg: 'minimal' }, codex);
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.text, /不支持的档位：minimal/);
    assert.match(unsupported.text, /none、low、medium、high、xhigh/);
    assert.equal(codex.calls.length, 0);

    const none = await executeCommand({ name: 'effort', arg: 'n' }, codex);
    assert.equal(none.ok, true);
    assert.deepEqual(codex.calls[0], ['setEffort', 'none']);

    const listing = await executeCommand({ name: 'effort', arg: '' }, codex);
    assert.match(listing.text, /可选：none、low、medium、high、xhigh/);
  });

  it('unknown commands answer with help instead of reaching codex', async () => {
    const codex = fakeCodex();
    const outcome = await executeCommand({ name: null, arg: '', token: 'foo', matches: [] }, codex);
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /未知命令：\/foo/);
    assert.match(outcome.text, /可用命令/);
    assert.equal(codex.calls.length, 0);
  });
});

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
    runtime: 'codex',
    threadId: 'th-live',
    model: '',
    effort: 'medium',
    state: { connected: true, activeTurn: 0, queued: 0 },
    turnInProgress: false,
    async interruptTurn() { calls.push(['interrupt']); },
    async rotateSession(options) { calls.push(['rotate', options]); return 'th-new'; },
    async setModel(model) { calls.push(['setModel', model]); return 'th-new'; },
    async setEffort(effort) { calls.push(['setEffort', effort]); return 'th-new'; },
    async snapshot({ catalog = 'cached' } = {}) {
      const models = catalog === 'refresh' ? await this.listModels?.() ?? [] : [];
      return {
        runtime: this.runtime,
        session: { id: this.threadId, connected: this.state.connected },
        model: this.model,
        effort: this.effort,
        queued: this.state.queued,
        work: this.workStatus ?? {
          working: this.turnInProgress,
          startedAtMs: null,
          connected: this.state.connected,
          queued: this.state.queued,
          switching: false,
        },
        capabilities: {
          effortControl: this.runtime === 'volc' ? 'remote-managed' : 'selectable',
        },
        models,
      };
    },
    async transition(request) {
      if (request.kind === 'new-session') {
        await this.interruptTurn();
        return { ok: true, threadId: await this.rotateSession({ resume: false }) };
      }
      if (request.kind === 'select-model') {
        const result = await this.setModel(request.selector);
        return result && typeof result === 'object'
          ? { ok: true, ...result }
          : { ok: true, runtimeChanged: false, model: request.selector, threadId: result };
      }
      if (request.kind === 'select-effort') {
        await this.interruptTurn();
        await this.setEffort(request.effort);
        return {
          ok: true,
          effort: request.effort,
          threadId: await this.rotateSession({ resume: false }),
        };
      }
      throw new Error(`unexpected transition ${request.kind}`);
    },
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

  it('never accepts slash commands in group chats, mentioned or not', () => {
    assert.equal(commandCandidate({ chatType: 'group', content: '/help', mentions: [] }), null);
    assert.equal(commandCandidate({ chatType: 'group', content: '/help' }), null);
    const mentions = [{ key: '@_user_1', name: 'Zayn', id: 'ou_bot12345678' }];
    assert.equal(
      commandCandidate({ chatType: 'group', content: '@_user_1 /new', mentions }),
      null,
    );
    assert.equal(
      commandCandidate({ chatType: 'group', content: '/model gpt-5.5 @_user_1', mentions }),
      null,
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
    assert.match(outcome.text, /pi、ark、sonnet、gpt-5\.6-sol/);
    assert.doesNotMatch(outcome.text, /claude:|codex:/);
    assert.doesNotMatch(outcome.text, /restart/);
    assert.equal(codex.calls.length, 0);
  });

  it('new rotates the session without resume', async () => {
    const codex = fakeCodex();
    const outcome = await executeCommand({ name: 'new', arg: '' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /th-new/);
    assert.deepEqual(codex.calls, [['interrupt'], ['rotate', { resume: false }]]);
  });

  it('treats the removed /restart command as unknown', () => {
    assert.deepEqual(parseCommand('/restart'), {
      name: null,
      arg: '',
      token: 'restart',
      matches: [],
    });
  });

  it('new while disconnected still succeeds with a deferred message', async () => {
    const codex = fakeCodex({ rotateSession: async () => null });
    const outcome = await executeCommand({ name: 'new', arg: '' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /重连/);
  });

  it('status reports active duration without consulting subagents', async () => {
    const codex = fakeCodex({
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      workStatus: {
        working: true,
        startedAtMs: Date.now() - 125_000,
        connected: true,
        queued: 2,
        switching: false,
      },
    });
    const outcome = await executeCommand({ name: 'status', arg: '' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /模型工作中，已持续 2 分/);
    assert.match(outcome.text, /排队消息：2/);
    assert.equal(codex.calls.length, 0);
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

  it('accepts a direct Codex model while Claude is active', async () => {
    const codex = fakeCodex({
      runtime: 'claude',
      model: 'sonnet',
      listModels: async () => [
        { id: 'sonnet', efforts: ['medium'] },
        { id: 'opus', efforts: ['medium'] },
      ],
      async setModel(model) {
        this.calls.push(['setModel', model]);
        return { runtimeChanged: true, runtime: 'codex', model, syncedThroughSeq: 12 };
      },
    });
    const outcome = await executeCommand({ name: 'model', arg: 'gpt-5.6-sol' }, codex);
    assert.equal(outcome.ok, true);
    assert.deepEqual(codex.calls, [['setModel', 'gpt-5.6-sol']]);
    assert.match(outcome.text, /已切到 gpt-5\.6-sol/);
    assert.doesNotMatch(outcome.text, /codex:/);
    assert.doesNotMatch(outcome.text, /seq|hidden reasoning/);
  });

  it('keeps qualified model aliases compatible but hides prefixes in replies', async () => {
    const codex = fakeCodex({
      runtime: 'claude',
      model: 'sonnet',
      listModels: async () => [
        { id: 'sonnet', efforts: ['medium'] },
        { id: 'opus', efforts: ['medium'] },
      ],
      async setModel(model) {
        this.calls.push(['setModel', model]);
        const direct = model.replace(/^(?:claude|codex):/, '');
        return { runtimeChanged: model.startsWith('codex:'), model: direct };
      },
    });

    const claude = await executeCommand({ name: 'model', arg: 'claude:son' }, codex);
    assert.equal(claude.ok, true);
    assert.deepEqual(codex.calls[0], ['setModel', 'claude:sonnet']);
    assert.match(claude.text, /已切到 sonnet，已开启新会话/);
    assert.doesNotMatch(claude.text, /claude:/);

    const back = await executeCommand({ name: 'model', arg: 'codex:gpt-5.6-sol' }, codex);
    assert.equal(back.ok, true);
    assert.deepEqual(codex.calls[1], ['setModel', 'codex:gpt-5.6-sol']);
    assert.match(back.text, /已切到 gpt-5\.6-sol/);
    assert.doesNotMatch(back.text, /codex:/);

    const invalid = await executeCommand({ name: 'model', arg: 'claude:' }, codex);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.text, '无效的模型名');
    assert.doesNotMatch(invalid.text, /claude:/);

    const missing = await executeCommand({ name: 'model', arg: 'claude:missing' }, codex);
    assert.equal(missing.ok, false);
    assert.match(missing.text, /未找到模型：missing/);
    assert.doesNotMatch(missing.text, /claude:/);
  });

  it('same-runtime model switch reports the fresh session id', async () => {
    const codex = fakeCodex({
      listModels: async () => [{ id: 'gpt-5.5', efforts: [] }],
      async setModel(model) {
        this.calls.push(['setModel', model]);
        return { runtimeChanged: false, model, threadId: 'th-fresh' };
      },
    });
    const outcome = await executeCommand({ name: 'model', arg: 'gpt-5.5' }, codex);
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /已切到 gpt-5\.5，已开启新会话：th-fresh/);
  });

  it('selects Ark as a third runtime and allows a direct Codex name on the way back', async () => {
    const agent = fakeCodex({
      runtime: 'codex',
      model: 'gpt-current',
      listModels: async () => [
        { id: 'gpt-current', efforts: ['medium'] },
        { id: 'ark', efforts: ['managed'] },
      ],
      async setModel(model) {
        calls.push(['setModel', model]);
        this.runtime = model === 'ark' ? 'volc' : 'codex';
        return { runtimeChanged: true, runtime: this.runtime, model };
      },
    });
    const { calls } = agent;
    const switched = await executeCommand({ name: 'model', arg: 'volcengine' }, agent);
    assert.equal(switched.ok, true);
    assert.deepEqual(calls.at(-1), ['setModel', 'ark']);

    agent.listModels = async () => [{ id: 'ark', efforts: ['managed'] }, { id: 'sonnet' }];
    const returned = await executeCommand({ name: 'model', arg: 'gpt-5.6-sol' }, agent);
    assert.equal(returned.ok, true);
    assert.deepEqual(calls.at(-1), ['setModel', 'gpt-5.6-sol']);
  });

  it('selects Pi as a first-class runtime via /model pi and pi:<model>', async () => {
    const agent = fakeCodex({
      runtime: 'codex',
      model: 'gpt-current',
      listModels: async () => [
        { id: 'gpt-current', efforts: ['medium'] },
        { id: 'ark', efforts: ['managed'] },
      ],
      async setModel(model) {
        this.calls.push(['setModel', model]);
        const runtime = model === 'pi' || String(model).startsWith('pi:') ? 'pi' : this.runtime;
        this.runtime = runtime;
        return {
          runtimeChanged: runtime === 'pi',
          runtime,
          model: model === 'pi' ? 'pi' : model.replace(/^pi:/, ''),
        };
      },
    });
    const switched = await executeCommand({ name: 'model', arg: 'pi' }, agent);
    assert.equal(switched.ok, true);
    assert.deepEqual(agent.calls.at(-1), ['setModel', 'pi']);
    assert.match(switched.text, /已切到 pi/);

    agent.runtime = 'codex';
    const qualified = await executeCommand({ name: 'model', arg: 'pi:openai/gpt-4o' }, agent);
    assert.equal(qualified.ok, true);
    assert.deepEqual(agent.calls.at(-1), ['setModel', 'pi:openai/gpt-4o']);
    assert.match(qualified.text, /已切到 openai\/gpt-4o/);
  });

  it('stays on Pi for pi:<id> and an unprefixed live-list id', async () => {
    const agent = fakeCodex({
      runtime: 'pi',
      model: 'google/gemini-pro',
      listModels: async () => [
        { id: 'openai/gpt-4o', efforts: ['medium'] },
        { id: 'google/gemini-pro', efforts: ['medium'] },
        { id: 'sonnet', efforts: ['medium'] },
      ],
      async setModel(model) {
        this.calls.push(['setModel', model]);
        const runtimeChanged = !(model === 'pi' || String(model).startsWith('pi:')
          || model === 'openai/gpt-4o' || model === 'google/gemini-pro');
        if (runtimeChanged) this.runtime = 'codex';
        return {
          runtimeChanged,
          runtime: this.runtime,
          model: String(model).replace(/^pi:/, ''),
          threadId: 'pi-fresh',
        };
      },
    });

    const qualified = await executeCommand({ name: 'model', arg: 'pi:openai/gpt-4o' }, agent);
    assert.equal(qualified.ok, true);
    assert.equal(agent.runtime, 'pi');
    assert.deepEqual(agent.calls.at(-1), ['setModel', 'pi:openai/gpt-4o']);
    assert.match(qualified.text, /已切到 openai\/gpt-4o，已开启新会话：pi-fresh/);
    assert.doesNotMatch(qualified.text, /历史对话会接上/);

    const live = await executeCommand({ name: 'model', arg: 'openai/gpt-4o' }, agent);
    assert.equal(live.ok, true);
    assert.equal(agent.runtime, 'pi');
    assert.deepEqual(agent.calls.at(-1), ['setModel', 'openai/gpt-4o']);
    assert.match(live.text, /已切到 openai\/gpt-4o，已开启新会话：pi-fresh/);
    assert.doesNotMatch(live.text, /历史对话会接上/);
  });

  it('explains that Ark effort is managed remotely', async () => {
    const agent = fakeCodex({ runtime: 'volc', model: 'ark', effort: 'managed' });
    const { calls } = agent;
    const result = await executeCommand({ name: 'effort', arg: 'high' }, agent);
    assert.equal(result.ok, false);
    assert.match(result.text, /远端 Agent/);
    assert.equal(calls.some(([name]) => name === 'setEffort'), false);
  });

  it('effort prefix-matches a level and rejects ambiguous or unknown input', async () => {
    const codex = fakeCodex();
    const high = await executeCommand({ name: 'effort', arg: 'h' }, codex);
    assert.equal(high.ok, true);
    assert.match(high.text, /已开启新会话/);
    assert.deepEqual(codex.calls, [
      ['interrupt'],
      ['setEffort', 'high'],
      ['rotate', { resume: false }],
    ]);

    const ambiguous = await executeCommand({ name: 'effort', arg: 'm' }, codex);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.text, /minimal、medium/);

    const unknown = await executeCommand({ name: 'effort', arg: 'turbo' }, codex);
    assert.equal(unknown.ok, false);
    assert.equal(codex.calls.length, 3);
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
    assert.deepEqual(codex.calls[0], ['interrupt']);
    assert.deepEqual(codex.calls[1], ['setEffort', 'none']);

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

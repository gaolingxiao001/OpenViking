import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VolcAgent } from '../src/volc.mjs';

const quietLogger = {
  child() { return this; },
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function templateSession(id = 'sesn-template12345') {
  return {
    id,
    status: 'idle',
    agent: { id: 'agent-test12345', version: 3, model: { id: 'deepseek-test' } },
    environment_id: 'env-test12345',
    vault_ids: null,
  };
}

function store() {
  const sessions = [];
  const activities = [];
  let globalSession = null;
  let managedTurn = null;
  let managedPoison = null;
  let cognition = { runtime: 'volc', epoch: 1, authorityToken: 'token' };
  const inbounds = new Map([
    [1, { seq: 1, messageId: 'om_first12345678', conversationKey: 'chat-a' }],
    [2, { seq: 2, messageId: 'om_second1234567', conversationKey: 'chat-a' }],
    [3, { seq: 3, messageId: 'om_third12345678', conversationKey: 'chat-b' }],
  ]);
  return {
    sessions,
    activities,
    getCognitionState: () => cognition,
    getGlobalSession: () => globalSession,
    setGlobalSession: (sessionId, policyHash, fields) => {
      sessions.push([sessionId, policyHash, fields]);
      globalSession = { sessionId, policyHash, ...fields };
    },
    getManagedTurn: () => managedTurn,
    beginManagedTurn: (turn) => { managedTurn = { ...turn, status: 'POSTING' }; },
    acceptManagedTurn: (runtime, sessionId, expectedUserEventId) => {
      assert.equal(managedTurn.runtime, runtime);
      assert.equal(managedTurn.sessionId, sessionId);
      managedTurn = { ...managedTurn, status: 'ACCEPTED', expectedUserEventId };
      globalSession = {
        ...globalSession,
        syncedThroughSeq: Math.max(
          globalSession?.syncedThroughSeq ?? 0,
          managedTurn.deliveredThroughSeq ?? 0,
        ),
      };
      return managedTurn;
    },
    prepareManagedTurnContinuation: ({
      runtime,
      authorityToken,
      sessionId,
      epoch,
      expectedUserEventId,
      body,
      bridge,
    }) => {
      assert.equal(managedTurn.runtime, runtime);
      assert.equal(managedTurn.authorityToken, authorityToken);
      assert.equal(managedTurn.sessionId, sessionId);
      assert.equal(managedTurn.epoch, epoch);
      assert.equal(managedTurn.status, 'ACCEPTED');
      assert.equal(managedTurn.expectedUserEventId, expectedUserEventId);
      managedTurn = {
        ...managedTurn,
        status: 'CONTINUATION_READY',
        expectedUserEventId: null,
        continuationBody: body,
        bridge,
      };
      return managedTurn;
    },
    clearManagedTurn: (runtime, expected = {}) => {
      if (!managedTurn || managedTurn.runtime !== runtime) return false;
      if (expected.sessionId && managedTurn.sessionId !== expected.sessionId) return false;
      if (expected.expectedUserEventId
        && managedTurn.expectedUserEventId !== expected.expectedUserEventId) return false;
      managedTurn = null;
      return true;
    },
    getManagedSessionPoison: () => managedPoison,
    poisonManagedSession: (runtime, sessionId, epoch) => {
      managedPoison = { runtime, sessionId, epoch };
      return true;
    },
    replacePoisonedManagedSession: ({
      runtime,
      authorityToken,
      nextAuthorityToken,
      expectedSessionId,
      sessionId,
      policyHash,
      expectedEpoch,
    }) => {
      assert.deepEqual(cognition, { runtime, epoch: expectedEpoch, authorityToken });
      assert.equal(globalSession.sessionId, expectedSessionId);
      assert.equal(managedPoison.sessionId, expectedSessionId);
      cognition = { runtime, epoch: expectedEpoch + 1, authorityToken: nextAuthorityToken };
      globalSession = {
        sessionId,
        policyHash,
        runtime,
        epoch: cognition.epoch,
        syncedThroughSeq: 0,
        sessionReady: true,
      };
      managedTurn = null;
      managedPoison = null;
      return cognition;
    },
    cognitionJournalBeforeInbound: () => 0,
    cognitionJournalSeqForInbound: (seq) => seq,
    inboundBySeq: (seq) => inbounds.get(seq) ?? null,
    recordActivity: (activity) => activities.push(activity),
  };
}

function config(overrides = {}) {
  return {
    volcApiKey: 'test-key',
    volcSessionId: 'sesn-template12345',
    volcBaseUrl: 'https://ark.example.test/api/v3',
    volcRequestTimeoutMs: 5_000,
    volcStreamIdleTimeoutMs: 5_000,
    cognitionMaxChars: 120_000,
    ...overrides,
  };
}

describe('Volc managed-agent runtime', () => {
  it('posts before opening SSE and delivers only the last agent.message on idle', async () => {
    const calls = [];
    const events = [
      { id: 'evt-old-final', type: 'agent.message', content: [{ type: 'text', text: 'STALE_OUTPUT' }] },
      { id: 'evt-old-idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
      { id: 'evt-user', type: 'user.message', content: [{ type: 'text', text: 'hello' }] },
      { id: 'evt-progress', type: 'agent.message', content: [{ type: 'text', text: 'working' }] },
      { id: 'tool-1', type: 'agent.tool_use', name: 'bash' },
      { id: 'evt-final', type: 'agent.message', content: [{ type: 'text', text: 'ARK_RUNTIME_OK' }] },
      { id: 'evt-idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const sse = events.map((event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body });
      if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
      if (url.endsWith('/sessions') && options.method === 'POST') {
        return json(templateSession('sesn-live12345678'));
      }
      if (url.endsWith('/events/stream')) {
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.includes('/events?')) return json({ data: [] });
      if (url.endsWith('/events') && options.method === 'POST') {
        return json({ data: [{ id: 'evt-user', type: 'user.message' }] });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const outputs = [];
    let succeeded;
    const completed = new Promise((resolve) => { succeeded = resolve; });
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, {
      fetch,
      onTurnOutput: async (output) => {
        outputs.push(output);
        return { accepted: true };
      },
      onTurnSucceeded: succeeded,
    });

    await agent.start();
    assert.equal(agent.deliver('hello', 1), true);
    await completed;

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].text, 'ARK_RUNTIME_OK');
    assert.equal(outputs[0].eventId, 'evt-final');
    assert.deepEqual(outputs[0].inboundSeqs, [1]);
    assert.equal(outputs[0].authorityToken, 'token');
    assert.equal(outputs[0].sessionId, 'sesn-live12345678');
    assert.equal(outputs[0].cognitionEpoch, 1);
    const streamIndex = calls.findIndex((call) => call.url.endsWith('/events/stream'));
    const postIndex = calls.findIndex((call) => call.url.endsWith('/events') && call.method === 'POST');
    // Post before attaching the stream: Volc buffers session events until a
    // stream attaches, so posting first cannot miss output, and it avoids
    // opening a stream against a session with nothing queued yet.
    assert.ok(postIndex >= 0 && streamIndex > postIndex);
    const posted = JSON.parse(calls[postIndex].body);
    assert.equal(posted.events[0].type, 'user.message');
    assert.equal(posted.events[0].content[0].text, 'hello');
    assert.equal(posted.events[1].type, 'system.message');
    assert.match(posted.events[1].content[0].text, /daemon relays only the final agent\.message locally/);
    assert.equal(agent.turnInProgress, false);
    assert.ok(data.activities.some((activity) => activity.kind === 'agent.tool_called'));
  });

  it('bridges strict text tool decisions across remote subturns before completing once', async () => {
    const toolDefinitions = [
      {
        name: 'list_lark_chats',
        description: 'List chats.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
        },
      },
      {
        name: 'reply_lark_message',
        description: 'Reply to a message.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message_id: { type: 'string', pattern: '^om_[A-Za-z0-9_-]{8,}$' },
            text: { type: 'string', minLength: 1 },
          },
          required: ['message_id'],
        },
      },
    ];
    const decisions = [
      JSON.stringify({
        protocol: 'lark-daemon-tools/v1',
        kind: 'tool_call',
        call_id: 'read_1',
        name: 'list_lark_chats',
        arguments: { limit: 5 },
      }),
      JSON.stringify({
        protocol: 'lark-daemon-tools/v1',
        kind: 'tool_call',
        call_id: 'reply_1',
        name: 'reply_lark_message',
        arguments: { message_id: 'om_first12345678', text: 'done' },
      }),
    ];
    const posts = [];
    let streamIndex = 0;
    const fetch = async (url, options = {}) => {
      if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
      if (url.endsWith('/sessions') && options.method === 'POST') {
        return json(templateSession('sesn-bridge123456'));
      }
      if (url.endsWith('/events/stream')) {
        const index = streamIndex++;
        const events = [
          { id: `evt-user-${index + 1}`, type: 'user.message' },
          { id: `evt-decision-${index + 1}`, type: 'agent.message', content: [{ type: 'text', text: decisions[index] }] },
          { id: `evt-idle-${index + 1}`, type: 'session.status_idle', stop_reason: 'end_turn' },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.includes('/events?')) return json({ data: [] });
      if (url.endsWith('/events') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        posts.push(body);
        return json({ data: [{ id: `evt-user-${posts.length}`, type: 'user.message' }] });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const toolCalls = [];
    const outputs = [];
    let resolveCompleted;
    const completed = new Promise((resolve) => { resolveCompleted = resolve; });
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, {
      fetch,
      toolDefinitions,
      onToolCall: async (call) => {
        toolCalls.push(call);
        if (call.name === 'list_lark_chats') {
          return {
            accepted: true,
            ok: true,
            terminal: false,
            result: {
              content: [{ type: 'text', text: 'one chat' }],
              structuredContent: { chats: [{ chat_id: 'oc_chat12345678', name: 'chat' }] },
            },
          };
        }
        return { accepted: true, ok: true, terminal: true, result: { content: [] } };
      },
      onTurnOutput: async (output) => { outputs.push(output); return { accepted: true }; },
      onTurnSucceeded: resolveCompleted,
    });

    await agent.start();
    agent.deliver('hello', 1);
    await completed;

    assert.equal(posts.length, 2);
    assert.equal(posts[0].events[0].content[0].text, 'hello');
    assert.match(posts[0].events[1].content[0].text, /lark-daemon-tools\/v1/);
    const continuation = JSON.parse(posts[1].events[0].content[0].text);
    assert.equal(continuation.kind, 'tool_result');
    assert.equal(continuation.call_id, 'read_1');
    assert.deepEqual(toolCalls.map((call) => call.name), ['list_lark_chats', 'reply_lark_message']);
    assert.equal(toolCalls[1].eventId, 'evt-decision-2');
    assert.deepEqual(outputs, []);
    assert.equal(agent.turnInProgress, false);
    assert.equal(data.getManagedTurn(), null);
    assert.equal(data.activities.filter((activity) => activity.kind === 'agent.turn_completed').length, 1);
  });

  it('returns a protocol error subturn when the managed agent emits prose', async () => {
    const toolDefinitions = [{
      name: 'list_lark_chats',
      description: 'List chats.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    }];
    const decisions = [
      'I should use a tool.',
      JSON.stringify({ protocol: 'lark-daemon-tools/v1', kind: 'finish', outcome: 'silent' }),
    ];
    const posts = [];
    let streamIndex = 0;
    const fetch = async (url, options = {}) => {
      if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
      if (url.endsWith('/sessions') && options.method === 'POST') {
        return json(templateSession('sesn-repair123456'));
      }
      if (url.endsWith('/events/stream')) {
        const index = streamIndex++;
        const events = [
          { id: `evt-repair-user-${index}`, type: 'user.message' },
          { id: `evt-repair-agent-${index}`, type: 'agent.message', content: [{ type: 'text', text: decisions[index] }] },
          { id: `evt-repair-idle-${index}`, type: 'session.status_idle', stop_reason: 'end_turn' },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.includes('/events?')) return json({ data: [] });
      if (url.endsWith('/events') && options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return json({ data: [{ id: `evt-repair-user-${posts.length - 1}`, type: 'user.message' }] });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    let completed;
    const done = new Promise((resolve) => { completed = resolve; });
    const agent = new VolcAgent(config(), store(), quietLogger, {
      fetch,
      toolDefinitions,
      onToolCall: async () => { throw new Error('no tool should execute'); },
      onTurnSucceeded: completed,
    });

    await agent.start();
    agent.deliver('hello', 1);
    await done;

    assert.equal(posts.length, 2);
    const repair = JSON.parse(posts[1].events[0].content[0].text);
    assert.equal(repair.kind, 'protocol_error');
    assert.match(repair.error, /strict JSON/);
    assert.equal(agent.turnInProgress, false);
  });

  it('does not replay accepted cognition after an idle turn has no agent.message', async () => {
    const rows = [
      {
        seq: 1, epoch: 1, kind: 'outbound', status: 'COMMITTED', atMs: 1,
        chatId: 'chat-a', actor: 'me', text: 'OLD_HISTORY_MARKER',
      },
      {
        seq: 2, epoch: 1, kind: 'inbound', status: 'COMMITTED', atMs: 2,
        inboundSeq: 1, chatId: 'chat-a', messageId: 'om_first12345678', actor: 'user', text: 'first',
      },
      {
        seq: 3, epoch: 1, kind: 'outbound', status: 'COMMITTED', atMs: 3,
        chatId: 'chat-a', actor: 'me', text: 'FIRST_TURN_FAILED',
      },
      {
        seq: 4, epoch: 1, kind: 'inbound', status: 'COMMITTED', atMs: 4,
        inboundSeq: 2, chatId: 'chat-a', messageId: 'om_second1234567', actor: 'user', text: 'second',
      },
    ];
    const data = store();
    data.cognitionJournalBeforeInbound = (seq) => (seq === 1 ? 1 : 3);
    data.cognitionJournalSeqForInbound = (seq) => (seq === 1 ? 2 : 4);
    data.cognitionJournal = (_epoch, through, after = 0) => rows
      .filter((row) => row.seq > after && row.seq <= through);

    const posts = [];
    let streamCount = 0;
    const turnEvents = [
      [
        { id: 'evt-user-1', type: 'user.message' },
        { id: 'evt-thinking-1', type: 'agent.thinking', content: [{ type: 'text', text: 'hidden' }] },
        { id: 'evt-idle-1', type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
      [
        { id: 'evt-user-2', type: 'user.message' },
        { id: 'evt-answer-2', type: 'agent.message', content: [{ type: 'text', text: 'SECOND_OK' }] },
        { id: 'evt-idle-2', type: 'session.status_idle', stop_reason: 'end_turn' },
      ],
    ];
    const fetch = async (url, options = {}) => {
      if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
      if (url.endsWith('/sessions') && options.method === 'POST') {
        return json(templateSession('sesn-incremental-live'));
      }
      if (url.endsWith('/events/stream')) {
        const events = turnEvents[streamCount++] ?? [];
        const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.includes('/events?')) return json({ data: [] });
      if (url.endsWith('/events') && options.method === 'POST') {
        const request = JSON.parse(options.body);
        posts.push(request.events[0].content[0].text);
        return json({ data: [{
          id: posts.length === 1 ? 'evt-user-1' : 'evt-user-2',
          type: 'user.message',
        }] });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    let agent;
    const completed = new Promise((resolve) => {
      agent = new VolcAgent(config(), data, quietLogger, {
        fetch,
        onTurnOutput: async () => ({ accepted: true }),
        onTurnFailed: () => agent.deliver('second', 2),
        onTurnSucceeded: resolve,
      });
    });
    await agent.start();
    agent.deliver('first', 1);
    await completed;

    assert.equal(posts.length, 2);
    assert.match(posts[0], /OLD_HISTORY_MARKER/);
    assert.doesNotMatch(posts[1], /OLD_HISTORY_MARKER/);
    assert.doesNotMatch(posts[1], /\] first(?:\n|$)/);
    assert.match(posts[1], /FIRST_TURN_FAILED/);
    assert.match(posts[1], /second$/);
    await agent.stop();
  });

  it('finds the fence and replays output via the post-POST history catch-up, without needing the stream', async () => {
    const calls = [];
    let streamCount = 0;
    let historyCount = 0;
    const preFenceSse = [
      { id: 'evt-answer-no-echo', type: 'agent.message', content: [{ type: 'text', text: 'HISTORY_FENCE_OK' }] },
      { id: 'evt-idle-no-echo', type: 'session.status_idle', stop_reason: 'end_turn' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const history = [
      { id: 'evt-idle-no-echo', type: 'session.status_idle', stop_reason: 'end_turn' },
      { id: 'evt-answer-no-echo', type: 'agent.message', content: [{ type: 'text', text: 'HISTORY_FENCE_OK' }] },
      { id: 'evt-user-no-echo', type: 'user.message', content: [{ type: 'text', text: 'hello' }] },
    ];
    const fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET' });
      if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
      if (url.endsWith('/sessions') && options.method === 'POST') {
        return json(templateSession('sesn-no-echo-live'));
      }
      if (url.endsWith('/events/stream')) {
        streamCount += 1;
        if (streamCount > 1) return json({}, 400);
        return new Response(preFenceSse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.includes('/events?')) {
        historyCount += 1;
        return json({ data: historyCount === 1 ? [] : history });
      }
      if (url.endsWith('/events') && options.method === 'POST') {
        return json({ data: [{ id: 'evt-user-no-echo', type: 'user.message' }] });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const outputs = [];
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const agent = new VolcAgent(config(), store(), quietLogger, {
      fetch,
      onTurnOutput: async (output) => {
        outputs.push(output.text);
        return { accepted: true };
      },
      onTurnSucceeded: () => settle('succeeded'),
      onTurnFailed: (info) => settle(`failed: ${info.error}`),
    });
    await agent.start();
    agent.deliver('hello', 1);
    let timeout;
    const timedOut = new Promise((resolve) => {
      timeout = setTimeout(() => resolve('timed out'), 2_000);
      timeout.unref?.();
    });
    const outcome = await Promise.race([done, timedOut]);
    clearTimeout(timeout);
    assert.equal(outcome, 'succeeded');
    assert.deepEqual(outputs, ['HISTORY_FENCE_OK']);
    // The post-POST history catch-up (historyCount 2) already contains the
    // fence, the answer, and the idle event, so the turn completes without
    // ever needing to attach the live stream.
    assert.equal(streamCount, 0);
    assert.equal(historyCount, 2);
    assert.equal(agent.seenEventIds.has('evt-answer-no-echo'), true);
    await agent.stop();
  });

  it('creates a remote session before committing a prepared /new rotation', async () => {
    const calls = [];
    let createCount = 0;
    const fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body });
      if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
      if (url.endsWith('/sessions') && options.method === 'POST') {
        createCount += 1;
        return json(templateSession(createCount === 1 ? 'sesn-live12345678' : 'sesn-fresh1234567'));
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, { fetch });
    await agent.start();

    const prepared = await agent.prepareSessionRotation();
    assert.equal(agent.threadId, 'sesn-live12345678');
    assert.equal(prepared.id, 'sesn-fresh1234567');
    assert.equal(agent.commitSessionRotation(prepared), 'sesn-fresh1234567');
    assert.equal(agent.threadId, 'sesn-fresh1234567');
    const create = calls.find((call) => call.url.endsWith('/sessions') && call.method === 'POST');
    assert.deepEqual(JSON.parse(create.body), {
      agent: { type: 'agent', id: 'agent-test12345', version: 3 },
      environment_id: 'env-test12345',
      title: JSON.parse(create.body).title,
    });
  });

  it('recovers an accepted remote turn from history without reposting it', async () => {
    const data = store();
    const bootstrap = new VolcAgent(config(), data, quietLogger, {
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions') && options.method === 'POST') {
          return json(templateSession('sesn-recovery-live1'));
        }
        throw new Error(`unexpected bootstrap request: ${url}`);
      },
    });
    await bootstrap.start();
    data.beginManagedTurn({
      runtime: 'volc',
      sessionId: bootstrap.sessionId,
      epoch: 1,
      inboundSeqs: [1],
      conversationKey: 'chat-a',
      deliveredThroughSeq: 1,
    });
    data.acceptManagedTurn('volc', bootstrap.sessionId, 'evt-recovery-user');

    const history = [
      { id: 'evt-recovery-idle', type: 'session.status_idle', stop_reason: 'end_turn' },
      { id: 'evt-recovery-answer', type: 'agent.message', content: [{ type: 'text', text: 'RECOVERED_OK' }] },
      { id: 'evt-recovery-user', type: 'user.message', content: [{ type: 'text', text: 'question' }] },
    ];
    const calls = [];
    let completed;
    const done = new Promise((resolve) => { completed = resolve; });
    const recovered = new VolcAgent(config(), data, quietLogger, {
      fetch: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET' });
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions/sesn-recovery-live1')) {
          return json(templateSession('sesn-recovery-live1'));
        }
        if (url.endsWith('/events/stream')) {
          return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/events?')) return json({ data: history });
        throw new Error(`unexpected recovery request: ${url}`);
      },
      onTurnOutput: async (info) => {
        assert.equal(info.text, 'RECOVERED_OK');
        return { accepted: true };
      },
      onTurnSucceeded: completed,
    });
    await recovered.start();
    await done;
    assert.equal(calls.some((call) => call.url.endsWith('/events') && call.method === 'POST'), false);
    assert.equal(data.getManagedTurn(), null);
    await recovered.stop();
  });

  it('reposts a persisted tool result after restart without executing the tool again', async () => {
    const toolDefinitions = [{
      name: 'list_lark_chats',
      description: 'List chats.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    }];
    const data = store();
    const bridgeOptions = {
      toolDefinitions,
      onToolCall: async () => {
        throw new Error('persisted tool call must not execute again');
      },
    };
    const bootstrap = new VolcAgent(config(), data, quietLogger, {
      ...bridgeOptions,
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions') && options.method === 'POST') {
          return json(templateSession('sesn-continuation1'));
        }
        throw new Error(`unexpected bootstrap request: ${url}`);
      },
    });
    await bootstrap.start();
    data.beginManagedTurn({
      runtime: 'volc',
      authorityToken: 'token',
      sessionId: bootstrap.sessionId,
      epoch: 1,
      inboundSeqs: [1],
      conversationKey: 'chat-a',
      deliveredThroughSeq: 1,
      bridge: { calls: 0, protocolErrors: 0 },
    });
    data.acceptManagedTurn('volc', bootstrap.sessionId, 'evt-original-user');
    const continuationBody = JSON.stringify({
      protocol: 'lark-daemon-tools/v1',
      kind: 'tool_result',
      call_id: 'read_1',
      name: 'list_lark_chats',
      ok: true,
      result: { content: [{ type: 'text', text: 'one chat' }] },
    });
    data.prepareManagedTurnContinuation({
      runtime: 'volc',
      authorityToken: 'token',
      sessionId: bootstrap.sessionId,
      epoch: 1,
      expectedUserEventId: 'evt-original-user',
      body: continuationBody,
      bridge: { calls: 1, protocolErrors: 0 },
    });

    const posts = [];
    const finish = JSON.stringify({
      protocol: 'lark-daemon-tools/v1',
      kind: 'finish',
      outcome: 'silent',
    });
    let completed;
    const done = new Promise((resolve) => { completed = resolve; });
    const recovered = new VolcAgent(config(), data, quietLogger, {
      ...bridgeOptions,
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions/sesn-continuation1')) {
          return json(templateSession('sesn-continuation1'));
        }
        if (url.endsWith('/events/stream')) {
          const events = [
            { id: 'evt-cont-user', type: 'user.message' },
            { id: 'evt-cont-finish', type: 'agent.message', content: [{ type: 'text', text: finish }] },
            { id: 'evt-cont-idle', type: 'session.status_idle', stop_reason: 'end_turn' },
          ];
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        if (url.includes('/events?')) return json({ data: [] });
        if (url.endsWith('/events') && options.method === 'POST') {
          posts.push(JSON.parse(options.body));
          return json({ data: [{ id: 'evt-cont-user', type: 'user.message' }] });
        }
        throw new Error(`unexpected recovery request: ${url}`);
      },
      onTurnSucceeded: completed,
    });
    await recovered.start();
    await done;

    assert.equal(posts.length, 1);
    assert.equal(posts[0].events[0].content[0].text, continuationBody);
    assert.equal(data.getManagedTurn(), null);
    await recovered.stop();
  });

  it('quarantines an accepted saved turn whose Lark conversation scope cannot be recovered', async () => {
    const data = store();
    const bootstrap = new VolcAgent(config(), data, quietLogger, {
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions') && options.method === 'POST') {
          return json(templateSession('sesn-scope-old123'));
        }
        throw new Error(`unexpected bootstrap request: ${url}`);
      },
    });
    await bootstrap.start();
    data.beginManagedTurn({
      runtime: 'volc',
      sessionId: bootstrap.sessionId,
      epoch: 1,
      inboundSeqs: [1],
      conversationKey: 'chat-b',
      deliveredThroughSeq: 1,
    });
    data.acceptManagedTurn('volc', bootstrap.sessionId, 'evt-scope-user');

    const failures = [];
    let createCount = 0;
    const recovered = new VolcAgent(config(), data, quietLogger, {
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions/sesn-scope-old123')) {
          return json({ ...templateSession('sesn-scope-old123'), status: 'running' });
        }
        if (url.endsWith('/sessions') && options.method === 'POST') {
          createCount += 1;
          return json(templateSession('sesn-scope-clean12'));
        }
        throw new Error(`unexpected recovery request: ${url}`);
      },
      onTurnFailed: (info) => failures.push(info),
    });
    await recovered.start();
    await recovered.poisonRecoveryPromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createCount, 1);
    assert.equal(recovered.sessionId, 'sesn-scope-clean12');
    assert.equal(recovered.sessionPoisoned, false);
    assert.equal(recovered.cognitionEpoch, 2);
    assert.equal(failures.length, 1);
    assert.match(failures[0].error, /lost its Lark conversation scope/);
    await recovered.stop();
  });

  it('quarantines a saved rescheduling session without an accepted turn fence', async () => {
    const data = store();
    const bootstrap = new VolcAgent(config(), data, quietLogger, {
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions') && options.method === 'POST') {
          return json(templateSession('sesn-reschedule-old'));
        }
        throw new Error(`unexpected bootstrap request: ${url}`);
      },
    });
    await bootstrap.start();

    let createCount = 0;
    const recovered = new VolcAgent(config(), data, quietLogger, {
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions/sesn-reschedule-old')) {
          return json({ ...templateSession('sesn-reschedule-old'), status: 'rescheduling' });
        }
        if (url.endsWith('/sessions') && options.method === 'POST') {
          createCount += 1;
          return json(templateSession('sesn-reschedule-clean'));
        }
        throw new Error(`unexpected recovery request: ${url}`);
      },
    });
    await recovered.start();
    await recovered.poisonRecoveryPromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createCount, 1);
    assert.equal(recovered.sessionId, 'sesn-reschedule-clean');
    assert.equal(recovered.sessionPoisoned, false);
    assert.equal(recovered.cognitionEpoch, 2);
    await recovered.stop();
  });

  it('queues all input that arrives during an active cloud turn', async () => {
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, { fetch: async () => json({}) });
    agent.connected = true;
    agent.turnActive = true;
    agent.activeConversationKey = 'chat-a';
    assert.equal(agent.deliver('same chat', 2), true);
    assert.equal(agent.deliver('other chat', 3), true);
    assert.equal(agent.activeItems.length, 0);
    assert.equal(agent.queue.length, 2);
    assert.equal(agent.queue[0][0].seq, 2);
    assert.equal(agent.queue[1][0].seq, 3);
  });

  it('requires the accepted user.message fence before accepting output or idle', async () => {
    const data = store();
    let succeeded = 0;
    const outputs = [];
    const agent = new VolcAgent(config(), data, quietLogger, {
      fetch: async () => json({}),
      onTurnOutput: async (info) => {
        outputs.push(info.text);
        return { accepted: true };
      },
      onTurnSucceeded: () => { succeeded += 1; },
    });
    agent.connected = true;
    agent.turnActive = true;
    agent.activeItems = [{ text: 'first', seq: 1 }];
    agent.expectedUserEventId = 'user-current';

    agent._handleEvent({ id: 'idle-old', type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
    assert.equal(agent.turnActive, true);
    agent._handleEvent({ id: 'user-other-client', type: 'user.message' });
    agent._handleEvent({ id: 'message-other-client', type: 'agent.message', content: [{ type: 'text', text: 'wrong' }] });
    assert.equal(agent.lastMessage, '');
    agent._handleEvent({ id: 'user-current', type: 'user.message' });
    agent._handleEvent({ id: 'message-current', type: 'agent.message', content: [{ type: 'text', text: 'right' }] });
    agent._handleEvent({ id: 'idle-new', type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.turnActive, false);
    assert.equal(succeeded, 1);
    assert.deepEqual(outputs, ['right']);
  });

  it('does not abort the stream when session-lifecycle events arrive before the user.message fence', () => {
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, { fetch: async () => json({}) });
    agent.connected = true;
    agent.turnActive = true;
    agent.expectedUserEventId = 'user-current';
    agent.turnFenceSeen = false;
    let aborted = false;
    agent.streamAbortController = { abort: () => { aborted = true; } };

    agent._handleEvent({ id: 'status-running', type: 'session.status_running' });
    agent._handleEvent({ id: 'thread-status-running', type: 'session.thread_status_running' });
    assert.equal(aborted, false);
    assert.equal(agent.turnFenceSeen, false);

    agent._handleEvent({ id: 'user-current', type: 'user.message' });
    assert.equal(agent.turnFenceSeen, true);
  });

  it('still aborts the stream when agent output arrives before the user.message fence', () => {
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, { fetch: async () => json({}) });
    agent.connected = true;
    agent.turnActive = true;
    agent.expectedUserEventId = 'user-current';
    agent.turnFenceSeen = false;
    let aborted = false;
    agent.streamAbortController = { abort: () => { aborted = true; } };

    agent._handleEvent({ id: 'stray-message', type: 'agent.message', content: [{ type: 'text', text: 'stale' }] });
    assert.equal(aborted, true);
    assert.equal(agent.turnFenceSeen, false);
  });

  it('fails closed for a mixed or targetless conversation batch', () => {
    const data = store();
    const failures = [];
    const agent = new VolcAgent(config(), data, quietLogger, {
      fetch: async () => json({}),
      onTurnFailed: (info) => failures.push(info),
    });
    agent.connected = true;
    assert.equal(agent.deliverBatch([
      { text: 'chat a', seq: 1 },
      { text: 'chat b', seq: 3 },
    ]), true);
    assert.equal(agent.turnActive, false);
    assert.match(failures[0].error, /exactly one Lark conversation scope/);
    assert.equal(agent.deliver('meeting without inbound target', null, 'receipt-1'), true);
    assert.equal(agent.turnActive, false);
    assert.equal(failures.length, 2);
  });

  it('treats bare status_idle and string stop reasons strictly', async () => {
    const failures = [];
    const agent = new VolcAgent(config(), store(), quietLogger, {
      fetch: async () => json({}),
      onTurnFailed: (info) => failures.push(info),
    });
    agent.connected = true;
    agent.turnActive = true;
    agent.activeItems = [{ text: 'first', seq: 1 }];
    agent.expectedUserEventId = 'user-current';
    agent._handleEvent({ id: 'user-current', type: 'user.message' });
    agent._handleEvent({ id: 'idle-current', type: 'status_idle', stop_reason: 'requires_action' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.turnActive, false);
    assert.match(failures[0].error, /requires_action/);
  });

  it('does not report success when local output delivery is rejected', async () => {
    let succeeded = 0;
    const failures = [];
    const agent = new VolcAgent(config(), store(), quietLogger, {
      fetch: async () => json({}),
      onTurnOutput: async () => ({ accepted: false }),
      onTurnSucceeded: () => { succeeded += 1; },
      onTurnFailed: (info) => failures.push(info),
    });
    agent.connected = true;
    agent.turnActive = true;
    agent.activeItems = [{ text: 'first', seq: 1 }];
    agent.deliveredThroughSeq = 1;
    agent.expectedUserEventId = 'user-current';
    agent._handleEvent({ id: 'user-current', type: 'user.message' });
    agent._handleEvent({ id: 'answer-current', type: 'agent.message', content: [{ type: 'text', text: 'answer' }] });
    agent._handleEvent({ id: 'idle-current', type: 'status_idle', stop_reason: 'end_turn' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(succeeded, 0);
    assert.equal(failures.length, 1);
    assert.equal(agent.syncedThroughSeq, 0);
  });

  it('waits for completion that races the interrupt POST before rotating', async () => {
    let releaseInterrupt;
    let releaseOutput;
    const interruptPosted = new Promise((resolve) => { releaseInterrupt = resolve; });
    const outputDelivered = new Promise((resolve) => { releaseOutput = resolve; });
    let abandoned = 0;
    const agent = new VolcAgent(config(), store(), quietLogger, {
      fetch: async () => json({}),
      onTurnOutput: async () => {
        await outputDelivered;
        return { accepted: true };
      },
      onTurnAbandoned: () => { abandoned += 1; },
    });
    agent.connected = true;
    agent.sessionId = 'sesn-race-old123';
    agent.turnActive = true;
    agent.activeItems = [{ text: 'first', seq: 1 }];
    agent.lastMessage = 'answer';
    agent.lastMessageEventId = 'evt-answer';
    agent.expectedUserEventId = 'evt-user';
    agent.turnFenceSeen = true;
    agent._postEvents = async () => { await interruptPosted; return { data: [] }; };

    let interruptSettled = false;
    const interrupted = agent.interruptTurn().then(() => { interruptSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const completing = agent._completeTurn();
    releaseInterrupt();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(interruptSettled, false, 'rotation must wait for the in-flight local delivery');
    releaseOutput();
    await Promise.all([interrupted, completing]);
    assert.equal(interruptSettled, true);
    assert.equal(abandoned, 0);
    assert.equal(agent.rotationPending, true);
  });

  it('restores FIFO draining when a prepared rotation is cancelled', () => {
    const agent = new VolcAgent(config(), store(), quietLogger, { fetch: async () => json({}) });
    const started = [];
    agent.connected = true;
    agent.rotationPending = true;
    agent.queue.push([{ text: 'older', seq: 1 }]);
    agent._startBatch = (items) => {
      started.push(items[0].seq);
      agent.turnActive = true;
    };
    agent.deliver('newer', 2);
    assert.equal(started.length, 0);
    agent.cancelSessionRotation();
    assert.deepEqual(started, [1]);
    assert.equal(agent.queue[0][0].seq, 2);
  });

  it('quarantines an ambiguous POST session before draining later chat work', async () => {
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, { fetch: async () => json({}) });
    const started = [];
    agent.connected = true;
    agent.sessionId = 'sesn-ambiguous12';
    data.setGlobalSession(agent.sessionId, agent.policyHash, {
      runtime: 'volc',
      epoch: 1,
      syncedThroughSeq: 0,
      sessionReady: true,
    });
    agent._createSession = async () => templateSession('sesn-clean123456');
    agent._startBatch = (items) => {
      started.push({ sessionId: agent.sessionId, seq: items[0].seq });
      agent.turnActive = true;
    };

    agent._poisonSession();
    agent.deliver('later chat work', 3);
    const recovery = agent.poisonRecoveryPromise;
    assert.ok(recovery);
    assert.deepEqual(started, []);
    await recovery;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [{ sessionId: 'sesn-clean123456', seq: 3 }]);
    assert.equal(agent.sessionPoisoned, false);
    assert.equal(agent.cognitionEpoch, 2);
    assert.notEqual(agent.authorityToken, 'token');
  });

  it('settles an uncertain replay without reporting ordinary turn success', async () => {
    let succeeded = 0;
    let failed = 0;
    const data = store();
    const agent = new VolcAgent(config(), data, quietLogger, {
      fetch: async () => json({}),
      onTurnOutput: async () => ({ accepted: true, uncertain: true }),
      onTurnSucceeded: () => { succeeded += 1; },
      onTurnFailed: () => { failed += 1; },
    });
    agent.connected = true;
    agent.sessionId = 'sesn-uncertain123';
    agent.turnActive = true;
    agent.activeItems = [{ text: 'first', seq: 1 }];
    agent.lastMessage = 'answer';
    agent.deliveredThroughSeq = 1;
    await agent._completeTurn();
    assert.equal(succeeded, 0);
    assert.equal(failed, 0);
    assert.equal(agent.syncedThroughSeq, 1);
    assert.equal(data.activities.at(-1).status, 'uncertain');
  });

  it('fails terminal HTTP errors once without logging the response body', async () => {
    let streamCalls = 0;
    let failed;
    const failure = new Promise((resolve) => { failed = resolve; });
    const agent = new VolcAgent(config(), store(), quietLogger, {
      fetch: async (url, options = {}) => {
        if (url.endsWith('/sessions/sesn-template12345')) return json(templateSession());
        if (url.endsWith('/sessions') && options.method === 'POST') {
          return json(templateSession('sesn-terminal1234'));
        }
        if (url.includes('/events?')) return json({ data: [] });
        if (url.endsWith('/events') && options.method === 'POST') {
          return json({ data: [{ id: 'evt-user', type: 'user.message' }] });
        }
        if (url.endsWith('/events/stream')) {
          streamCalls += 1;
          return json({ message: 'secret response body' }, 401);
        }
        throw new Error(`unexpected request: ${url}`);
      },
      onTurnFailed: failed,
    });
    await agent.start();
    agent.deliver('hello', 1);
    const info = await failure;
    assert.equal(streamCalls, 1);
    assert.match(info.error, /Volc API request failed \(401\)/);
    assert.doesNotMatch(info.error, /secret response body|sesn-terminal/);
  });

  it('rejects missing credentials without making a request', async () => {
    const agent = new VolcAgent(config({ volcApiKey: '' }), store(), quietLogger, {
      fetch: async () => { throw new Error('must not fetch'); },
    });
    await assert.rejects(() => agent.start(), /ARK_API_KEY/);
  });
});

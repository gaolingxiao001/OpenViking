import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EDITABLE_CHARS, approvalCard, approvalNote, approvedText } from '../src/actions/approval.mjs';
import { ActionService } from '../src/actions/service.mjs';
import { startActionApi, stopActionApi } from '../src/actions/api.mjs';
import { createMcpHandler } from '../src/actions/mcp.mjs';
import { resolveCardAction } from '../src/card-messages.mjs';
import { formatCognitionJournalLine } from '../src/cognition.mjs';
import { eventMessage } from '../src/connectors/protocol.mjs';
import { normalizeEvent } from '../src/event.mjs';
import { Harness } from '../src/harness.mjs';
import { formatInboundLine } from '../src/runtime-input.mjs';
import { Store } from '../src/store.mjs';
import { chatEvent, mailEvent, subjectEvent } from './event-fixture.mjs';
import { fakeConnectors } from './action-fixture.mjs';

const TOKEN = 'runtime-token';
const OWNER = { id: 'ou_owner12345678', target: { user_id: 'ou_owner12345678' } };
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const mcpPath = fileURLToPath(new URL('../src/actions/mcp.mjs', import.meta.url));

function setup(t, { ids = ['lark'], run = null, roster = null, liveness = null, meetingEnabled = false, ovClient = null,
  owners = { lark: OWNER }, channel = 'lark', profile = undefined } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(directory, 'state.sqlite3'), logger);
  store.initializeCognition('codex', TOKEN);
  const connectors = fakeConnectors({ ids, run, owners });
  const logs = [];
  const record = (level) => (message, fields = {}) => logs.push({ level, message, ...fields });
  const service = new ActionService({
    config: { workspace, tempDir: path.join(directory, 'tmp'), maxReplyChars: 1_000, channel, profile },
    store, connectors, roster, liveness, meetingEnabled, ovClient,
    logger: { debug() {}, info: record('info'), warn: record('warn'), error: record('error'), child() { return this; } },
  });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (tool, input, authority = TOKEN) => service.call(tool, input, { authority });
  const inbound = (fields) => store.ingest(chatEvent({ chatType: 'group', ...fields })).inbound;
  return { directory, workspace, store, connectors, service, call, inbound, logs };
}

describe('agent tools', () => {
  it('offers only the tools some configured connector supports', (t) => {
    const names = (service) => service.tools().map((tool) => tool.name);
    const lark = setup(t, { meetingEnabled: true });
    assert.ok(names(lark.service).includes('react_to_message'));
    assert.ok(names(lark.service).includes('list_chats'));
    assert.ok(names(lark.service).includes('read_meeting_inbox'));
    const weixin = setup(t, { ids: ['weixin'] });
    assert.deepEqual(names(weixin.service), [
      'send_message', 'notify_owner', 'reply_message', 'get_message_media',
    ]);
    // The OV session tool exists only for an instance configured with OpenViking.
    assert.ok(!names(lark.service).includes('read_openviking_session_context'));
    const withOV = setup(t, { ids: ['weixin'], ovClient: {} });
    assert.ok(names(withOV.service).includes('read_openviking_session_context'));
  });

  it('validates input against the tool schema before any connector call', async (t) => {
    const { call, connectors, inbound } = setup(t);
    inbound({ messageId: 'om_a' });
    await assert.rejects(() => call('send_message', { chat_id: 'oc_chat12345678', text: 'legacy', decision_id: 'message:om_a' }), /unknown field: text/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_chat12345678', markdown: 'x' }), /decision_id is required/);
    await assert.rejects(() => call('react_to_message', { message_id: 'om_a', emoji_type: '1bad', decision_id: 'message:om_a' }), /emoji_type has an invalid format/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_chat12345678', decision_id: 'message:om_a' }), /message body is required/);
    await assert.rejects(() => call('no_such_tool', {}), /unknown tool/);
    assert.equal(connectors.calls.length, 0);
  });

  it('fences a retired runtime out of reads and writes', async (t) => {
    const { store, call, connectors, inbound } = setup(t);
    inbound({ messageId: 'om_decision123456' });
    store.initializeCognition('claude', 'new-owner');
    await assert.rejects(() => call('list_chats', {}), /no longer owns/);
    await assert.rejects(() => call('send_message', {
      chat_id: 'oc-chat', markdown: 'late', decision_id: 'message:om_decision123456',
    }), /no longer owns/);
    assert.equal(connectors.calls.length, 0);
  });

  it('separates response attribution from the latest freshness fence', async (t) => {
    const { store, call, connectors, inbound, logs } = setup(t);
    const older = inbound({ messageId: 'om_olderDecision1', chatId: 'oc_steer12345678' });
    const olderTwo = inbound({ messageId: 'om_otherOlder1234', chatId: 'oc_steer12345678' });
    const latest = inbound({ messageId: 'om_latestDecision', chatId: 'oc_steer12345678' });
    inbound({ messageId: 'om_otherScope1234', chatId: 'oc_other12345678' });

    await call('send_message', { chat_id: 'oc_steer12345678', markdown: 'fast answer B', decision_id: 'message:om_latestDecision' });
    await call('send_message', { chat_id: 'oc_steer12345678', markdown: 'finished answer A',
      decision_id: 'message:om_latestDecision', response_to_id: 'message:om_olderDecision1' });
    await call('reply_message', { message_id: 'om_otherOlder1234', markdown: 'answer A2', decision_id: 'message:om_latestDecision' });
    assert.deepEqual(
      store.db.prepare('SELECT inbound_seq FROM outbox ORDER BY id').all().map((row) => row.inbound_seq),
      [latest.seq, older.seq, olderTwo.seq],
    );

    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'cross scope',
      decision_id: 'message:om_latestDecision', response_to_id: 'message:om_otherScope1234' }), /same chat\/thread or subject, no newer/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'future',
      decision_id: 'message:om_olderDecision1', response_to_id: 'message:om_latestDecision' }), /newer authenticated input/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'stale',
      decision_id: 'message:om_olderDecision1' }), /newer authenticated input/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'unknown',
      decision_id: 'message:om_neverReceived1' }), /not the event= of an accepted daemon-authenticated input/);
    assert.equal(connectors.calls.length, 3, 'invalid attribution and stale fences stop before the connector');

    // Each call leaves one agent_tool line; refusals carry the seqs that explain them.
    const lines = logs.filter((line) => line.message === 'agent_tool');
    assert.deepEqual(lines.slice(0, 3).map((line) => [line.outcome, line.decisionSeq, line.responseSeq]),
      [['ok', latest.seq, latest.seq], ['ok', latest.seq, older.seq], ['ok', latest.seq, olderTwo.seq]]);
    assert.ok(lines.slice(0, 3).every((line) => line.outboxId && line.attempt === 1 && line.connector === 'lark'));
    assert.deepEqual(lines.slice(3).map((line) => [line.outcome, line.code, line.decisionSeq ?? null, line.newerSeq ?? null]), [
      ['blocked', 'attribution_rejected', latest.seq, null],
      ['blocked', 'stale_decision', older.seq, latest.seq],
      ['blocked', 'stale_decision', older.seq, latest.seq],
      ['blocked', 'unknown_decision', null, null],
    ]);
    assert.doesNotMatch(JSON.stringify(logs), /oc_steer|om_latest|fast answer/);
    const blockedRows = store.db.prepare("SELECT inbound_seq, detail_json FROM activities WHERE kind = 'delivery.blocked' ORDER BY id").all();
    assert.equal(blockedRows.length, 4);
    assert.deepEqual(JSON.parse(blockedRows[1].detail_json), {
      tool: 'send_message', code: 'stale_decision', connector: 'lark', via: null, runtime: 'codex',
      decisionSeq: older.seq, newerSeq: latest.seq,
    });
  });

  it('reserves every delivery in the outbox and journal; a repeat returns the earlier result', async (t) => {
    const { store, call, connectors, inbound } = setup(t);
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const input = { chat_id: 'oc_chat12345678', markdown: 'hello', decision_id: 'message:om_decision123456' };
    const first = await call('send_message', input);
    assert.match(first.text, /^Delivered message to chat_id=oc_chat12345678\. message_id=om_delivered123456/);
    const [{ connector, action, input: sent }] = connectors.calls;
    assert.deepEqual([connector, action], ['lark', 'message.send']);
    assert.deepEqual(sent.content, { type: 'markdown', text: 'hello' });
    assert.match(sent.idempotency_key, /^ld_[a-f0-9]{40}$/);

    const row = store.db.prepare('SELECT * FROM outbox').get();
    assert.deepEqual([row.status, row.caller, row.remote_message_id], ['SENT', 'agent', 'om_delivered123456']);
    const journal = store.db.prepare("SELECT * FROM cognition_journal WHERE kind = 'outbound'").get();
    assert.deepEqual([journal.status, journal.message_id, journal.chat_id, journal.runtime_token, journal.text],
      ['COMMITTED', 'om_delivered123456', 'oc_chat12345678', TOKEN, 'hello']);
    assert.deepEqual(store.db.prepare("SELECT kind FROM activities WHERE outbox_id = ? ORDER BY id").all(row.id)
      .map((item) => item.kind), ['delivery.queued', 'delivery.sent']);

    const repeat = await call('send_message', input);
    assert.equal(repeat.data.duplicate, true);
    assert.match(repeat.text, /Already delivered/);
    assert.equal(connectors.calls.length, 1);

    await call('send_message', { ...input, idempotency_key: 'intentional-second' });
    assert.equal(connectors.calls.length, 2);
    assert.notEqual(connectors.calls[1].input.idempotency_key, sent.idempotency_key);
  });

  it('retries an uncertain action only where the provider honours the idempotency key', async (t) => {
    let fail = true;
    const run = (_connector, action) => {
      if (fail) throw new Error('timed out');
      return action === 'message.react' ? { reaction_id: 'r1' } : { message_id: 'om_delivered123456' };
    };
    const { store, call, connectors, inbound } = setup(t, { ids: ['lark', 'weixin'], run });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    inbound({ source: 'weixin', messageId: 'wx_peer_1', chatId: 'peer@im.wechat', chatType: 'p2p' });
    const send = { chat_id: 'oc_chat12345678', markdown: 'once', decision_id: 'message:om_decision123456' };
    const react = { message_id: 'om_decision123456', emoji_type: 'OK', decision_id: 'message:om_decision123456' };
    const weixin = { message_id: 'wx_peer_1', markdown: 'hi', decision_id: 'message:wx_peer_1' };
    for (const [tool, input] of [['send_message', send], ['react_to_message', react], ['reply_message', weixin]]) {
      await assert.rejects(() => call(tool, input), /timed out/);
    }
    assert.deepEqual(store.stats().outbox, { UNCERTAIN: 3 });
    assert.equal(store.cognitionJournal().filter((item) => item.status === 'UNCERTAIN').length, 3);

    fail = false;
    const retried = await call('send_message', send);
    assert.equal(retried.data.message_id, 'om_delivered123456');
    assert.equal(connectors.calls[3].input.idempotency_key, connectors.calls[0].input.idempotency_key);
    assert.equal(store.db.prepare("SELECT attempt_count FROM outbox WHERE action = 'message.send'").get().attempt_count, 2);
    await assert.rejects(() => call('react_to_message', react), /outcome is uncertain/);
    await assert.rejects(() => call('reply_message', weixin), /outcome is uncertain/);
    assert.equal(connectors.calls.length, 4);
  });

  it('routes by a known target id, an explicit source, or the only capable connector', async (t) => {
    const { call, connectors, inbound } = setup(t, { ids: ['lark', 'weixin'],
      run: (_connector, action) => (action === 'chat.list' ? { chats: [], has_more: false } : { message_id: 'om_delivered123456' }) });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    inbound({ source: 'weixin', messageId: 'wx_peer_1', chatId: 'peer@im.wechat', chatType: 'p2p' });

    await call('reply_message', { message_id: 'wx_peer_1', markdown: 'hi', decision_id: 'message:wx_peer_1' });
    await call('reply_message', { message_id: 'om_decision123456', markdown: 'hi', decision_id: 'message:om_decision123456' });
    await call('list_chats', {});
    assert.deepEqual(connectors.calls.map((item) => [item.connector, item.action]), [
      ['weixin', 'message.reply'], ['lark', 'message.reply'], ['lark', 'chat.list'],
    ]);

    await assert.rejects(() => call('react_to_message', { message_id: 'wx_peer_1', emoji_type: 'OK', decision_id: 'message:wx_peer_1' }),
      /weixin does not support message.react/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_neverSeen1234', markdown: 'x', decision_id: 'message:om_decision123456' }),
      /pass source \(one of: lark, weixin\)/);
    await call('send_message', { source: 'lark', chat_id: 'oc_neverSeen1234', markdown: 'x', decision_id: 'message:om_decision123456' });
    assert.equal(connectors.calls.at(-1).connector, 'lark');
  });

  it('checks message content against the connector manifest', async (t) => {
    const { call, connectors, inbound } = setup(t, { ids: ['weixin'] });
    inbound({ source: 'weixin', messageId: 'wx_peer_1', chatId: 'peer@im.wechat', chatType: 'p2p' });
    const base = { message_id: 'wx_peer_1', decision_id: 'message:wx_peer_1' };
    await assert.rejects(() => call('reply_message', { ...base, card: { elements: [] } }), /weixin cannot send card messages/);
    await assert.rejects(() => call('reply_message', { ...base, markdown: 'x', mention_user_ids: ['ou_someone12345'] }),
      /mentions are not supported/);
    await assert.rejects(() => call('reply_message', { ...base, markdown: 'x', reply_in_thread: true }), /does not support thread replies/);
    assert.equal(connectors.calls.length, 0);
  });

  it('freezes a workspace file for the upload and removes the snapshot afterwards', async (t) => {
    let seen;
    const { call, workspace, directory, inbound } = setup(t, { run: (_connector, _action, input) => {
      seen = { ...input.content, bytes: fs.readFileSync(input.content.path, 'utf8') };
      return { message_id: 'om_delivered123456' };
    } });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    fs.writeFileSync(path.join(workspace, 'chart.png'), 'png bytes');
    await call('send_message', { chat_id: 'oc_chat12345678', file_path: 'chart.png', decision_id: 'message:om_decision123456' });
    assert.equal(seen.type, 'file');
    assert.equal(seen.name, 'chart.png');
    assert.equal(seen.bytes, 'png bytes');
    assert.ok(seen.path.startsWith(path.join(directory, 'tmp', 'outbox')));
    assert.equal(fs.existsSync(seen.path), false);
  });

  it('resolves mention names through the roster of the target chat', async (t) => {
    const lookups = [];
    const roster = { async resolveNames(chatId, names) {
      lookups.push(chatId);
      return names.map((name) => ({ name, id: 'ou_alice12345678' }));
    } };
    const { call, connectors, inbound } = setup(t, { roster });
    inbound({ messageId: 'om_target12345678', chatId: 'oc_decision123456' });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_decision123456' });
    await call('reply_message', { message_id: 'om_target12345678', markdown: '@Alice please check',
      mention_names: ['Alice'], mention_user_ids: ['ou_bob1234567890'], decision_id: 'message:om_decision123456' });
    assert.deepEqual(lookups, ['oc_decision123456']);
    assert.deepEqual(connectors.calls[0].input.content.mentions, [
      { id: 'ou_bob1234567890' }, { name: 'Alice', id: 'ou_alice12345678' },
    ]);
  });

  it('re-checks freshness and authority after an awaited mention lookup', async (t) => {
    let finishLookup = null;
    const roster = { resolveNames: (_chatId, names) => new Promise((resolve) => {
      finishLookup = () => resolve(names.map((name) => ({ name, id: 'ou_alice12345678' })));
    }) };
    const { store, call, connectors, inbound } = setup(t, { roster });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });

    const stale = call('send_message', { chat_id: 'oc_chat12345678', markdown: '@Alice hi',
      mention_names: ['Alice'], decision_id: 'message:om_decision123456' });
    inbound({ messageId: 'om_newer123456789', chatId: 'oc_chat12345678' });
    finishLookup();
    await assert.rejects(stale, (error) => error.code === 'stale_decision');

    const revoked = call('reply_message', { message_id: 'om_newer123456789', markdown: '@Alice hi',
      mention_names: ['Alice'], decision_id: 'message:om_newer123456789' });
    store.initializeCognition('claude', 'new-owner');
    finishLookup();
    await assert.rejects(revoked, (error) => error.code === 'authority_revoked');

    assert.equal(connectors.calls.length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  });

  it('blocks a delivery to a Connector that is down without reserving it, so the retry goes through', async (t) => {
    const { store, call, connectors } = setup(t, { ids: ['lark', 'weixin'] });
    let weixinUp = false;
    connectors.available = (id) => id !== 'weixin' || weixinUp;
    store.ingest(chatEvent({ source: 'weixin', messageId: 'wx-decision-0001', chatId: 'wx-peer' }));
    const reply = () => call('reply_message', { message_id: 'wx-decision-0001', markdown: '收到',
      decision_id: 'message:wx-decision-0001' });

    await assert.rejects(reply(), (error) => error.code === 'connector_unavailable'
      && /weixin connector is temporarily unavailable.*No action was taken/.test(error.message));
    assert.equal(connectors.calls.length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
    const [blocked] = store.listActivities({ limit: 10 }).activities.filter((activity) => activity.kind === 'delivery.blocked');
    assert.equal(blocked.metadata.code, 'connector_unavailable');

    weixinUp = true;
    await reply();
    assert.deepEqual(connectors.calls.map((entry) => [entry.connector, entry.action]), [['weixin', 'message.reply']]);
    assert.equal(store.db.prepare("SELECT status FROM outbox").get().status, 'SENT');
  });

  it('keeps one temporary working reaction per conversation and clears it on the next final delivery there', async (t) => {
    let reactions = 0;
    const run = (_connector, action) => {
      if (action === 'message.react') return { reaction_id: `reaction_${reactions += 1}` };
      if (action === 'message.reaction.delete') return { deleted: true };
      return { message_id: 'om_delivered123456' };
    };
    const { store, service, call, connectors, inbound } = setup(t, { run });
    inbound({ messageId: 'om_scopeA12345678', chatId: 'oc_scopeA12345678' });
    inbound({ messageId: 'om_scopeB12345678', chatId: 'oc_scopeB12345678' });
    await call('react_to_message', { message_id: 'om_scopeA12345678', emoji_type: 'OnIt', temporary: true, decision_id: 'message:om_scopeA12345678' });
    assert.equal(service.temporaryReactions.size, 1);

    await call('send_message', { chat_id: 'oc_scopeB12345678', markdown: 'other scope', decision_id: 'message:om_scopeB12345678' });
    assert.equal(service.temporaryReactions.size, 1, 'a delivery elsewhere must not clear it');

    await call('react_to_message', { message_id: 'om_scopeA12345678', emoji_type: 'OK', decision_id: 'message:om_scopeA12345678' });
    assert.equal(service.temporaryReactions.size, 0);
    const deletion = connectors.calls.find((item) => item.action === 'message.reaction.delete');
    assert.deepEqual(deletion.input, { message_id: 'om_scopeA12345678', reaction_id: 'reaction_1' });
    assert.deepEqual(store.cognitionJournal().filter((item) => item.kind === 'outbound').map((item) => item.text),
      ['other scope', '[reaction OK]'], 'the cleared working reaction leaves the observable history');

    await assert.rejects(() => call('react_to_message', { message_id: 'om_scopeA12345678', emoji_type: 'OK', temporary: true,
      decision_id: 'message:om_scopeA12345678' }), /must use the OnIt emoji/);
  });

  it('never reports a final delivery as failed because working reaction cleanup failed', async (t) => {
    const run = (_connector, action) => {
      if (action === 'message.reaction.delete') throw new Error('cleanup failed');
      return action === 'message.react' ? { reaction_id: 'reaction_cleanup' } : { message_id: 'om_delivered123456' };
    };
    const { service, call, inbound } = setup(t, { run });
    inbound({ messageId: 'om_cleanup1234567', chatId: 'oc_cleanup1234567' });
    await call('react_to_message', { message_id: 'om_cleanup1234567', emoji_type: 'OnIt', temporary: true, decision_id: 'message:om_cleanup1234567' });
    const sent = await call('send_message', { chat_id: 'oc_cleanup1234567', markdown: 'finished', decision_id: 'message:om_cleanup1234567' });
    assert.equal(sent.data.message_id, 'om_delivered123456');
    assert.equal(service.temporaryReactions.size, 0);
  });

  it('touches idle liveness after every successful delivery, including daemon replies', async (t) => {
    let touches = 0;
    const { service, call, inbound } = setup(t, { liveness: { touch() { touches += 1; } } });
    const event = inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    await call('react_to_message', { message_id: 'om_decision123456', emoji_type: 'OK', decision_id: 'message:om_decision123456' });
    await service.replyToEvent(event, 'notice', 'failure-notice');
    assert.equal(touches, 2);
  });

  it('replies to an event on its own route once per purpose', async (t) => {
    const { store, service, connectors, inbound } = setup(t);
    const event = inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    assert.deepEqual(await service.replyToEvent(event, 'first notice', 'failure-notice'), { ok: true });
    assert.deepEqual(await service.replyToEvent(event, 'second notice', 'failure-notice'), { ok: true });
    await service.replyToEvent(event, 'command reply', 'command-reply');
    assert.equal(connectors.calls.length, 2);
    assert.deepEqual(connectors.calls[0].input.content, { type: 'markdown', text: 'first notice' });
    assert.equal(connectors.calls[0].input.message_id, 'om_decision123456');
    assert.deepEqual(store.db.prepare('SELECT DISTINCT caller FROM outbox').all().map((row) => row.caller), ['daemon']);
    assert.deepEqual(await service.replyToEvent(chatEvent({ replyRoute: null }), 'x', 'p'), { ok: false, stage: 'no-target' });
  });

  it('does not reserve or invoke anything in dry-run mode', async (t) => {
    const { store, service, call, connectors, inbound } = setup(t);
    service.config.dryRun = true;
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const result = await call('send_message', { chat_id: 'oc_chat12345678', markdown: 'x', decision_id: 'message:om_decision123456' });
    assert.match(result.text, /Dry run only/);
    assert.equal(connectors.calls.length, 0);
    assert.deepEqual(store.stats().outbox, {});
  });

  it('reads and acknowledges the durable meeting inbox', async (t) => {
    const { store, call } = setup(t, { meetingEnabled: true });
    store.ensureMeetingSession('734000000000000123');
    store.ingestMeetingEvent({
      eventKey: 'meeting:test-transcript', meetingId: '734000000000000123',
      eventType: 'vc.bot.meeting_activity_v1', activityType: 'transcript_received', occurredAtMs: 1_723_300_000_000,
      payload: { transcript_received_items: [{ speaker: { user_name: 'Alice' }, text: '请把结论发到群里', sentence_id: 's-1' }] },
    });
    store.commitMeetingInboxBatch('734000000000000123', store.pendingMeetingEvents('734000000000000123'), 1_723_300_000_001);
    const first = await call('read_meeting_inbox', { limit: 10 });
    assert.match(first.text, /Read and acknowledged 1 meeting messages; remaining=0/);
    assert.match(first.text, /请把结论发到群里/);
    assert.match((await call('read_meeting_inbox', {})).text, /Meeting inbox is empty/);
  });

  it('pages OV session context consistently and fences authority after the remote read', async (t) => {
    let value = 'abcdef';
    const ovClient = { async context() { return { overview: value }; } };
    const { store, call } = setup(t, { ovClient });
    const { epoch } = store.getCognitionState();
    store.db.exec('CREATE TABLE IF NOT EXISTS ov_session_sync(epoch INTEGER PRIMARY KEY, session_id TEXT, uri TEXT)');
    store.db.prepare('INSERT INTO ov_session_sync(epoch, session_id, uri) VALUES (?, ?, ?)').run(epoch, 'test-session', 'viking://session/test');
    const first = (await call('read_openviking_session_context', { epoch, max_chars: 4 })).data;
    const next = (await call('read_openviking_session_context', { epoch, offset: first.next_offset, expected_digest: first.expected_digest })).data;
    assert.equal(first.text + next.text, JSON.stringify({ overview: value }));
    await assert.rejects(() => call('read_openviking_session_context', { epoch, offset: 4 }), /requires expected_digest/);
    value = 'changed';
    await assert.rejects(() => call('read_openviking_session_context', { epoch, offset: 4, expected_digest: first.expected_digest }), /result changed/);
    ovClient.context = async () => {
      store.initializeCognition('claude', 'new-owner');
      return { overview: 'must not escape' };
    };
    await assert.rejects(() => call('read_openviking_session_context', { epoch }), /no longer owns/);
  });
});

describe('agent tool front-ends', () => {
  async function serve(t, options) {
    const state = setup(t, options);
    const socketPath = path.join(state.directory, 'actions.sock');
    const server = await startActionApi({ socketPath, service: state.service, logger });
    t.after(() => stopActionApi(server));
    assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
    return { ...state, socketPath };
  }

  it('relays tools/list and tools/call from the MCP adapter, with images inline', async (t) => {
    const { directory, socketPath, inbound } = await serve(t, { run: (_connector, action) => {
      if (action !== 'message.media') return { message_id: 'om_delivered123456' };
      const file = path.join(directory, 'img.png');
      fs.writeFileSync(file, 'png');
      return { media: [{ path: file, name: 'img.png', kind: 'image', mime_type: 'image/png', size: 3 }] };
    } });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const handle = createMcpHandler({ socketPath, authority: TOKEN, client: 'mcp' });

    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(listed.result.tools.some((tool) => tool.name === 'send_message' && tool.inputSchema.properties.chat_id));
    assert.ok(listed.result.tools.every((tool) => !('action' in tool)));

    const sent = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message',
      arguments: { chat_id: 'oc_chat12345678', markdown: 'hi', decision_id: 'message:om_decision123456' } } });
    assert.match(sent.result.content[0].text, /Delivered message/);
    assert.equal(sent.result.structuredContent.message_id, 'om_delivered123456');

    const media = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_message_media',
      arguments: { message_id: 'om_decision123456', key: 'img_abcdefgh1234' } } });
    assert.deepEqual(media.result.content[1], { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' });

    const stale = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_message',
      arguments: { chat_id: 'oc_chat12345678', markdown: 'hi', decision_id: 'message:om_unknown123456' } } });
    assert.equal(stale.result.isError, true);
    assert.match(stale.result.content[0].text, /not the event= of an accepted daemon-authenticated input/);

    const retired = createMcpHandler({ socketPath, authority: 'retired', client: 'mcp' });
    const fenced = await retired({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_chats', arguments: {} } });
    assert.match(fenced.result.content[0].text, /no longer owns/);
  });

  it('serves tools over real MCP stdio with the runtime environment', async (t) => {
    const { socketPath, inbound, connectors, logs } = await serve(t);
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const env = { ...process.env, PERSONAL_AGENT_SOCKET: socketPath, PERSONAL_AGENT_AUTHORITY: TOKEN };
    const run = (requests) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [mcpPath], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, responses: stdout.trim().split('\n').map(JSON.parse).sort((a, b) => a.id - b.id), stderr }));
      child.stdin.end(requests.map((request, index) => JSON.stringify({ jsonrpc: '2.0', id: index, ...request })).join('\n') + '\n');
    });

    const sent = await run([
      { method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { method: 'tools/list' },
      { method: 'tools/call', params: { name: 'reply_message', arguments: {
        message_id: 'om_decision123456', markdown: 'it\'s "quoted"\nand multi-line\u2028分行\u2029分段', decision_id: 'message:om_decision123456',
      } } },
      { method: 'tools/call', params: { name: 'send_message', arguments: {
        chat_id: 'oc_chat12345678', markdown: 'x', decision_id: 'message:om_missing12345',
      } } },
    ]);
    assert.equal(sent.code, 0, sent.stderr);
    assert.ok(sent.responses[1].result.tools.some(({ name }) => name === 'send_message'));
    assert.match(sent.responses[2].result.content[0].text, /^Delivered reply to message_id=om_decision123456/);
    assert.equal(connectors.calls[0].input.content.text, 'it\'s "quoted"\nand multi-line\u2028分行\u2029分段');
    assert.equal(logs.find((line) => line.message === 'agent_tool').via, 'mcp');
    assert.equal(sent.responses[3].result.isError, true);
    assert.match(sent.responses[3].result.content[0].text, /not the event= of an accepted daemon-authenticated input/);
  });

  it('refuses to run outside a daemon runtime', () => {
    const result = spawnSync(process.execPath, [mcpPath], {
      env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PERSONAL_AGENT_SOCKET is not set/);
  });
});

it('finds decisions, reply targets, newer inputs and orphaned conversations through indexes', (t) => {
  const { store } = setup(t);
  const plans = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    if (/FROM connector_events/.test(sql) && !/^\s*DELETE FROM connector_events/.test(sql)) {
      plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join(' '));
    }
    return prepare(sql);
  };
  // An id that is not an inbound (a reply to the bot's own message) used to
  // scan the whole event history before falling through to the outbox.
  store.acceptedEvents('om_unknown12345678');
  store.acceptedMessageEvents('om_unknown12345678', 'lark');
  store.eventByMessageId('om_unknown12345678', 'lark');
  store.connectorForMessage('om_unknown12345678');
  store.newerAcceptedSeq('["lark","issue","owner/repo#1"]', 1);
  // Retention cleanup runs synchronously at startup and daily; without an index
  // every conversation left without events scans the whole event table.
  store.prune(86_400_000);
  assert.equal(plans.length, 6);
  assert.match(plans[0], /USING INDEX connector_events_event /);
  assert.match(plans[1], /USING INDEX connector_events_message \(connector_instance=\? AND message_id=\?\)/);
  assert.match(plans[2], /USING INDEX connector_events_message \(connector_instance=\? AND message_id=\?\)/);
  assert.match(plans[3], /USING INDEX connector_events_message_seq/);
  assert.match(plans[4], /USING COVERING INDEX connector_events_scope_status_seq/);
  assert.match(plans[5], /SEARCH connector_events USING COVERING INDEX connector_events_conv_status_seq \(conv_key=\?\)/);
  assert.doesNotMatch(plans.join(' '), /SCAN connector_events/);
});

// A decision names one accepted inbound event by its event= id. Freshness,
// attribution and idempotency all follow that event.
describe('decision references', () => {
  const send = (call, decision, extra = {}) => call('notify_owner', {
    markdown: '会议 10 分钟后开始', decision_id: decision, ...extra,
  });
  const outbox = (store) => store.db.prepare('SELECT inbound_seq FROM outbox ORDER BY id').all().map((row) => row.inbound_seq);

  it('acts on a non-chat event by the event= value its line shows, special characters included', async (t) => {
    const { store, call, connectors } = setup(t);
    const event = subjectEvent({ source: 'github', eventId: 'owner/repo#123 comment 50%', kind: 'issue.commented',
      subjectType: 'issue', subjectId: 'owner/repo#123' });
    const { seq } = store.ingest(event).inbound;
    const shown = /event=(\S+)/.exec(formatInboundLine(event))[1];
    assert.equal(shown, 'owner/repo#123%20comment%2050%25');

    await send(call, shown);
    assert.deepEqual(outbox(store), [seq]);
    // No line ever shows the raw id: a space cannot survive inside a tag.
    await assert.rejects(send(call, 'owner/repo#123 comment 50%'), /decision_id has an invalid format/);
    assert.equal(connectors.calls.length, 1);
  });

  it('fences a non-chat decision by its subject and lets the newest one fulfil an earlier request there', async (t) => {
    const { store, call, connectors } = setup(t);
    const issue = (eventId, subjectId) => subjectEvent({ source: 'github', eventId, kind: 'issue.updated',
      subjectType: 'issue', subjectId });
    const opened = store.ingest(issue('issue-1-opened', 'owner/repo#1')).inbound;
    store.ingest(issue('issue-2-opened', 'owner/repo#2'));
    // Another subject is another scope.
    await send(call, 'issue-1-opened');

    store.ingest(issue('issue-1-commented', 'owner/repo#1'));
    await assert.rejects(send(call, 'issue-1-opened', { markdown: 'late' }), (error) => error.code === 'stale_decision');
    // A new comment does not cancel the request before it.
    await send(call, 'issue-1-commented', { markdown: 'done', response_to_id: 'issue-1-opened' });
    await assert.rejects(send(call, 'issue-1-opened', { markdown: 'future', response_to_id: 'issue-1-commented' }),
      (error) => error.code === 'stale_decision');
    assert.deepEqual(outbox(store), [opened.seq, opened.seq]);
    assert.equal(connectors.calls.length, 2);
  });

  it('takes only event= as a reference and refuses an event id that several instances accepted', async (t) => {
    const { store, call, connectors } = setup(t);
    // One instance: an event whose id is another event's message id. Each one
    // is reached by its own event=; a message id is never a reference.
    const chat = store.ingest(chatEvent({ messageId: 'om_shared12345678', eventId: 'evt-chat-1', chatId: 'oc_a12345678' })).inbound;
    const doc = store.ingest(subjectEvent({ source: 'lark', eventId: 'om_shared12345678', subjectType: 'doc', subjectId: 'doc-1' })).inbound;
    // One message, two events: the original and an edit.
    const created = store.ingest(chatEvent({ messageId: 'om_twice123456789', eventId: 'evt-created', chatId: 'oc_b12345678' })).inbound;
    store.ingest(chatEvent({ messageId: 'om_twice123456789', eventId: 'evt-edited', chatId: 'oc_b12345678',
      kind: 'message.updated' }));
    // Two instances of one source, each with its own reminder-1.
    store.ingest(subjectEvent({ instance: 'calendar-personal', eventId: 'reminder-1' }));
    const work = store.ingest(subjectEvent({ instance: 'calendar-work', eventId: 'reminder-1' })).inbound;

    await assert.rejects(send(call, 'om_twice123456789'),
      (error) => error.code === 'unknown_decision' && /msg= is not accepted/.test(error.message));
    await assert.rejects(send(call, 'evt-edited', { response_to_id: 'om_twice123456789' }),
      (error) => error.code === 'attribution_rejected');
    await assert.rejects(send(call, 'reminder-1'),
      (error) => error.code === 'decision_ambiguous' && /decision_instance/.test(error.message));
    assert.equal(connectors.calls.length, 0);

    await send(call, 'om_shared12345678');
    await send(call, 'evt-chat-1');
    await send(call, 'evt-edited', { response_to_id: 'evt-created' });
    await assert.rejects(send(call, 'evt-created', { markdown: 'stale' }), (error) => error.code === 'stale_decision');
    await send(call, 'reminder-1', { decision_instance: 'calendar-work' });
    assert.deepEqual(outbox(store), [doc.seq, chat.seq, created.seq, work.seq]);
    assert.equal(connectors.calls.length, 4);
  });

  it('points a stale decision at the newer input\'s event=, and a retry that follows the hint goes through', async (t) => {
    const { store, call, connectors } = setup(t);
    const reply = (decision) => call('reply_message', { message_id: 'om_question1234567', markdown: '好的', decision_id: decision });
    const question = store.ingest(chatEvent({ messageId: 'om_question1234567', eventId: 'evt-question', chatId: 'oc_b12345678' })).inbound;
    const followUp = chatEvent({ messageId: 'om_followUp123456', eventId: 'evt-follow-up', chatId: 'oc_b12345678' });
    store.ingest(followUp);

    const stale = await reply('evt-question').catch((error) => error);
    assert.equal(stale.code, 'stale_decision');
    assert.doesNotMatch(stale.message, /msg=/);
    // Copy the tag the hint names from the newer input's line, as the model would.
    const [, tag] = /use its (\w+)= as decision_id/.exec(stale.message);
    const line = formatInboundLine(followUp);
    const wrong = await reply(/ msg=(\S+)/.exec(line)[1]).catch((error) => error);
    assert.equal(wrong.code, 'unknown_decision');
    assert.match(wrong.message, /not the event= of an accepted .* \(msg= is not accepted\)/);
    await reply(new RegExp(` ${tag}=(\\S+)`).exec(line)[1]);
    // The reply still answers the question it targets.
    assert.deepEqual(outbox(store), [question.seq]);
    assert.equal(connectors.calls.length, 1);
  });

  it('keys a delivery by its decision event', async (t) => {
    const { store, call, connectors } = setup(t);
    store.ingest(chatEvent({ messageId: 'om_again12345678', eventId: 'evt-again', chatId: 'oc_notify12345678' }));
    await send(call, 'evt-again');
    assert.equal((await send(call, 'evt-again')).data.duplicate, true);

    // The same reminder text for two events, or for one event id on two
    // instances, is a separate delivery each time.
    store.ingest(subjectEvent({ eventId: 'reminder-1', subjectId: 'evt_1' }));
    store.ingest(subjectEvent({ eventId: 'reminder-2', subjectId: 'evt_2' }));
    store.ingest(subjectEvent({ instance: 'calendar-work', eventId: 'reminder-1', subjectId: 'evt_1' }));
    for (const [id, instance] of [['reminder-1', 'calendar'], ['reminder-2', 'calendar'], ['reminder-1', 'calendar-work']]) {
      assert.equal((await send(call, id, { decision_instance: instance })).data.duplicate, undefined);
    }
    assert.equal(connectors.calls.length, 4);
    assert.equal(new Set(connectors.calls.map((entry) => entry.input.idempotency_key)).size, 4);
  });

  it('re-checks the decision event after an awaited preparation, also against a newer event for the same message', async (t) => {
    let finishLookup = null;
    const roster = { resolveNames: (_chatId, names) => new Promise((resolve) => {
      finishLookup = () => resolve(names.map((name) => ({ name, id: 'ou_alice12345678' })));
    }) };
    const { store, call, connectors, inbound } = setup(t, { roster });
    inbound({ messageId: 'om_racing12345678', eventId: 'evt-first', chatId: 'oc_chat12345678' });

    const pending = call('send_message', { chat_id: 'oc_chat12345678', markdown: '@Alice hi',
      mention_names: ['Alice'], decision_id: 'evt-first' });
    // The same message comes back as a new event (an edit) while the lookup awaits.
    inbound({ messageId: 'om_racing12345678', eventId: 'evt-second', chatId: 'oc_chat12345678', kind: 'message.updated' });
    finishLookup();
    await assert.rejects(pending, (error) => error.code === 'stale_decision');
    assert.equal(connectors.calls.length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  });
});

// The owner is the person the agent works for. A non-chat event reaches people
// only as a notice to the owner, on an IM the Core picks; an action that speaks
// for the owner (a mail reply) needs a chat message the owner sent.
describe('owner notices and owner-only actions', () => {
  const outboundLines = (store) => store.cognitionJournal().filter((item) => item.kind === 'outbound').map(formatCognitionJournalLine);

  it('notifies the owner on the primary IM, and lets a non-chat event do nothing else', async (t) => {
    const { store, call, connectors } = setup(t);
    const reminder = store.ingest(subjectEvent({ eventId: 'reminder-1' })).inbound;
    store.ingest(chatEvent({ messageId: 'om_group12345678', eventId: 'evt-group', chatId: 'oc_group12345678', chatType: 'group' }));

    for (const [tool, input] of [
      ['send_message', { chat_id: 'oc_group12345678', markdown: 'leak' }],
      ['reply_message', { message_id: 'om_group12345678', markdown: 'leak' }],
      ['react_to_message', { message_id: 'om_group12345678', emoji_type: 'OK' }],
    ]) {
      await assert.rejects(call(tool, { ...input, decision_id: 'reminder-1' }),
        (error) => error.code === 'owner_only' && /use notify_owner/.test(error.message));
    }
    // Only a chat message may name the IM.
    await assert.rejects(call('notify_owner', { markdown: 'x', decision_id: 'reminder-1', source: 'lark' }),
      (error) => error.code === 'invalid_input' && /only when a chat message asked/.test(error.message));
    assert.equal(connectors.calls.length, 0);

    const result = await call('notify_owner', { markdown: '1:1 十分钟后开始', decision_id: 'reminder-1' });
    assert.match(result.text, /^Delivered notification to the owner on lark\./);
    assert.deepEqual(connectors.calls.map(({ connector, action, input }) => [connector, action, input.user_id, input.chat_id]),
      [['lark', 'message.send', OWNER.id, undefined]]);
    assert.deepEqual(store.db.prepare('SELECT chat_id, conv_key, inbound_seq FROM outbox').all().map((row) => ({ ...row })),
      [{ chat_id: null, conv_key: null, inbound_seq: reminder.seq }]);
    // History shows a notice to the owner, not a message in some chat.
    assert.match(outboundLines(store)[0], /^\[source=lark to=owner in_reply_to_event=reminder-1 time=\S+ from=me\] 1:1 十分钟后开始$/);
  });

  it('tells the owner on the IM a chat message named, and still sends across IMs for a chat', async (t) => {
    const { store, call, connectors } = setup(t, { ids: ['lark', 'weixin'],
      owners: { lark: OWNER, weixin: { id: 'wx-owner', target: { chat_id: 'wx-owner' } } } });
    store.ingest(chatEvent({ source: 'weixin', messageId: 'wx-msg-1', eventId: 'wx-evt-1', chatId: 'wx-owner', senderId: 'wx-owner' }));
    store.ingest(chatEvent({ messageId: 'om_group12345678', eventId: 'evt-group', chatId: 'oc_group12345678', chatType: 'group' }));

    // "在飞书上提醒我": the chat message picks the IM, the Core picks the person.
    await call('notify_owner', { markdown: '提醒你', decision_id: 'wx-evt-1', source: 'lark' });
    // Without source the primary IM is used.
    await call('notify_owner', { markdown: '提醒你 2', decision_id: 'wx-evt-1' });
    // "在飞书那个群里说一声": a chat decision keeps send_message to any chat.
    await call('send_message', { chat_id: 'oc_group12345678', markdown: '大家好', decision_id: 'wx-evt-1' });
    assert.deepEqual(connectors.calls.map(({ connector, input }) => [connector, input.user_id ?? input.chat_id]), [
      ['lark', OWNER.id], ['lark', OWNER.id], ['lark', 'oc_group12345678'],
    ]);

    const unknown = setup(t, { owners: {} });
    unknown.store.ingest(subjectEvent({ eventId: 'reminder-1' }));
    await assert.rejects(unknown.call('notify_owner', { markdown: 'x', decision_id: 'reminder-1' }),
      (error) => error.code === 'owner_unknown' && /lark-cli user login/.test(error.message));
    assert.equal(unknown.connectors.calls.length, 0);
  });

  // The owner's click on a card is the only thing that sends a mail.
  const PROFILE = 'test-profile';
  const CARD = 'om_card12345678';
  const mailSetup = (t) => setup(t, { ids: ['lark', 'email'], profile: PROFILE,
    run: (connector) => (connector === 'email' ? { sent: true } : { message_id: CARD, chat_id: 'oc_p2p12345678' }) });
  const click = (store, { choice = 'send', form = undefined, operator = OWNER.id, id = 'card-click-1' } = {}) => {
    const event = normalizeEvent(eventMessage('lark', {
      id, kind: 'message.action', occurred_at: Date.now(),
      subject: { type: 'message', id: CARD }, actor: { type: 'user', id: operator },
      message: { id: `ca_${id}`, type: 'card_action' }, content: { text: '[card action]' },
      data: { interaction: { message_id: CARD, conversation_id: 'oc_p2p12345678', tag: 'button',
        value: { lark_daemon_choice: choice }, ...(form ? { form } : {}) } },
    }));
    return resolveCardAction(store.db, event, PROFILE);
  };

  it('puts a mail reply on a card for the owner, whoever proposed it, and sends no mail', async (t) => {
    const { store, call, connectors } = mailSetup(t);
    // The reviewer's case: an old owner message, then a mail steering the model.
    store.ingest(chatEvent({ messageId: 'om_hello12345678', eventId: 'evt-hello', chatId: 'oc_p2p12345678', senderId: OWNER.id }));
    const mail = mailEvent({ uid: 7 });
    store.ingest(mail);
    store.ingest(chatEvent({ messageId: 'om_alice12345678', eventId: 'evt-alice', chatId: 'oc_group12345678',
      chatType: 'group', senderId: 'ou_alice12345678' }));
    // The mail line carries its reply target.
    assert.match(formatInboundLine(mail), /^\[source=email kind=email\.received msg=mail:1:7 event=imap:1:7 subject=thread:gmail:100 /);

    const reply = (decision, text) => call('reply_message', { message_id: 'mail:1:7', markdown: text, decision_id: decision });
    for (const [decision, text] of [['evt-hello', 'borrowed'], ['imap:1:7', 'proposed'], ['evt-alice', 'asked by a colleague']]) {
      const result = await reply(decision, text);
      assert.match(result.text, /^Nothing was sent yet: the draft is on a card in the owner's direct chat \(lark\)/);
    }
    // Three cards to the owner, no mail.
    assert.deepEqual(connectors.calls.map(({ connector, action, input }) => [connector, action, input.user_id, input.content.type]),
      Array(3).fill(['lark', 'message.send', OWNER.id, 'card']));
    const [card] = connectors.calls.map(({ input }) => input.content.card);
    assert.equal(card.schema, '2.0');
    const form = card.body.elements.find((element) => element.tag === 'form');
    assert.equal(form.elements[0].default_value, 'borrowed');
    // Exact, yet no email address for Lark's audit to refuse.
    assert.match(card.body.elements[0].text.content, /^收件人：alice＠example\.com\n主题：Re: 周四开会？$/);
    assert.doesNotMatch(JSON.stringify(card), /[\w.+-]+@[\w-]+\.[\w.]+/);
    const [question] = store.db.prepare('SELECT question_json FROM lark_cards').all().map((row) => JSON.parse(row.question_json));
    assert.deepEqual([question.kind, question.answerer_id, question.draft.message_id], ['approval', OWNER.id, 'mail:1:7']);

    await assert.rejects(call('reply_message', { source: 'email', message_id: 'mail:9:9', markdown: 'x', decision_id: 'evt-hello' }),
      (error) => error.code === 'invalid_target');

    // A card shows every recipient or none: past the limit, or with nobody to
    // answer, there is no card.
    store.ingest(mailEvent({ uid: 8, thread: 'gmail:108', reply: { subject: 'Re: x', recipients: 21 } }));
    store.ingest(mailEvent({ uid: 9, thread: 'gmail:109', reply: { subject: 'Re: x', to: [] } }));
    await assert.rejects(call('reply_message', { message_id: 'mail:1:8', markdown: 'x', decision_id: 'imap:1:8' }),
      (error) => error.code === 'unsupported' && /replies to go to 21 addresses/.test(error.message));
    await assert.rejects(call('reply_message', { message_id: 'mail:1:9', markdown: 'x', decision_id: 'imap:1:9' }),
      (error) => error.code === 'invalid_target' && /no address to reply to/.test(error.message));
    assert.equal(connectors.calls.length, 3);
  });

  it('sends the approved draft as the owner left it, once, and shows the outcome on the card', async (t) => {
    const { store, call, connectors } = mailSetup(t);
    // The owner's direct chat with the bot, where the card lands.
    store.ingest(chatEvent({ messageId: 'om_hello12345678', eventId: 'evt-hello', chatId: 'oc_p2p12345678', senderId: OWNER.id }));
    store.ingest(mailEvent({ uid: 7 }));
    await call('reply_message', { message_id: 'mail:1:7', markdown: '周四可以', decision_id: 'imap:1:7' });
    const mail = store.db.prepare("SELECT seq FROM connector_events WHERE event_id = 'imap:1:7'").get();

    // Only the owner can answer it.
    assert.throws(() => click(store, { operator: 'ou_alice12345678' }), /card answerer is not authorized/);
    const pressed = click(store, { form: { reply_body: '周五下午三点可以，回头见' } });
    assert.equal(store.ingest(pressed).inbound.status, 'DONE');
    const settled = await new ActionService({ config: { maxReplyChars: 1_000 }, store, connectors, logger }).settleApproval(pressed);
    assert.deepEqual([settled.state, settled.edited], ['sent', true]);
    const sent = connectors.calls.filter(({ connector }) => connector === 'email');
    // Sent to exactly the recipients the card showed.
    assert.deepEqual(sent.map(({ action, input }) => [action, input.message_id, input.content.text, input.to]),
      [['message.reply', 'mail:1:7', '周五下午三点可以，回头见', ['alice@example.com']]]);
    assert.deepEqual(connectors.updates.map(({ messageId, card }) => [messageId, card.header.title.content]), [[CARD, '已发送']]);
    // Recorded against the mail, with no chat.
    const row = store.db.prepare("SELECT chat_id, conv_key, inbound_seq FROM outbox WHERE connector = 'email'").get();
    assert.deepEqual({ ...row }, { chat_id: null, conv_key: null, inbound_seq: mail.seq });
    assert.match(outboundLines(store).at(-1),
      /^\[source=email action=message\.reply in_reply_to_event=imap:1:7 subject=thread:gmail:100 time=\S+ from=me\] 周五下午三点可以，回头见$/);

    // A second press does not settle it again.
    assert.equal(store.ingest(click(store, { id: 'card-click-2' })).filterReason, 'card_already_answered_or_expired');

    // The model then hears, in the owner's chat, what actually went out.
    const input = [];
    const harness = new Harness({ config: {}, store, logger, recordActivity() {},
      runtime: { snapshot: () => ({ session: { connected: true }, work: { turnInProgress: false } }),
        submit: (items) => { input.push(...items); return { accepted: true }; } } });
    await harness.deliverNote(pressed, approvalNote(pressed.question.draft, settled));
    assert.equal(input.length, 1);
    assert.equal(input[0].seq, null);
    assert.equal(input[0].text.replace(/ time=\S+/, ''), '[chat=oc_p2p12345678 source=lark msg=ca_card-click-1 event=card-click-1 '
      + `card=${CARD} from=${OWNER.id.slice(0, 11)} reply_to=me] [mail reply sent] `
      + '{"subject":"Re: 周四开会？","to":["alice@example.com"],"text":"周五下午三点可以，回头见","edited_by_owner":true}');
  });

  it('shows a draft too long for a card input read-only, and an empty edit falls back to the draft', () => {
    const draft = { text: 'x'.repeat(EDITABLE_CHARS + 1), to: [{ name: 'Bob', address: 'bob@example.com' }], subject: 'Re: hi' };
    const card = approvalCard(draft);
    assert.equal(card.body.elements.some((element) => element.tag === 'form'), false);
    assert.deepEqual(card.body.elements.filter((element) => element.tag === 'button')
      .map((element) => element.behaviors[0].value.lark_daemon_choice), ['send', 'cancel']);
    assert.equal(approvedText(draft, { reply_body: '   ' }), draft.text);
    // A card never carries an @ (Lark refuses addresses); the approved text gets them back.
    const signed = approvalCard({ ...draft, text: '好的\n— bob@example.com' });
    assert.equal(signed.body.elements.find((element) => element.tag === 'form').elements[0].default_value, '好的\n— bob＠example.com');
    assert.doesNotMatch(JSON.stringify(signed), /@/);
    assert.equal(approvedText(draft, { reply_body: '好的\n— bob＠example.com' }), '好的\n— bob@example.com');
    assert.equal(approvedText(draft, undefined), draft.text);
  });

  it('drops the draft when the owner declines it', async (t) => {
    const { store, call, connectors } = mailSetup(t);
    store.ingest(mailEvent({ uid: 7 }));
    await call('reply_message', { message_id: 'mail:1:7', markdown: '周四可以', decision_id: 'imap:1:7' });
    const declined = click(store, { choice: 'cancel' });
    store.ingest(declined);
    const settled = await new ActionService({ config: { maxReplyChars: 1_000 }, store, connectors, logger }).settleApproval(declined);
    assert.equal(settled.state, 'cancelled');
    assert.equal(approvalNote(declined.question.draft, settled), '[mail reply cancelled] {"subject":"Re: 周四开会？","to":["alice@example.com"]}');
    assert.equal(connectors.calls.filter(({ connector }) => connector === 'email').length, 0);
    assert.equal(connectors.updates[0].card.header.title.content, '已取消，没有发送');
  });
});

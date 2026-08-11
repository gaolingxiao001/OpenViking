import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { GenericDecisionAuthority } from '../src/meeting/decision-authority.mjs';
import { FlyReferenceRing } from '../src/meeting/fly-reference.mjs';
import { LiveSpool } from '../src/meeting/live-spool.mjs';

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function spoolPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-live-spool-'));
  directories.push(directory);
  return path.join(directory, 'live.sqlite3');
}

describe('live meeting foundations', () => {
  it('deduplicates a segment before allocating its per-session generation', () => {
    let now = 1_000;
    const databasePath = spoolPath();
    const spool = new LiveSpool(databasePath, { now: () => now });
    try {
      const first = spool.enqueue({
        inputId: 'meeting_input_stable_1',
        sessionEpoch: 'meeting-a:1',
        captureGeneration: 7,
        segmentId: 'segment-1',
        segmentSeq: 1,
        meetingId: 'meeting-a',
        meetingNumber: '123456789',
        targetChatId: 'oc_target',
        text: '最终句子',
        speaker: 'Alice',
        audioStartMs: 100.25,
        audioEndMs: 200.75,
        receivedAtMs: 900,
        isFinal: true,
      });
      assert.equal(first.inserted, true);
      assert.equal(first.duplicate, false);
      assert.equal(first.item.generation, 1);
      assert.equal(first.item.inputId, 'meeting_input_stable_1');
      assert.equal(first.item.key, first.item.inputId);
      assert.equal(first.item.captureGeneration, 7);
      assert.equal(first.item.targetChatId, 'oc_target');
      assert.equal(first.item.audioEndMs, 200.75);

      now += 1;
      const duplicate = spool.enqueue({
        sessionEpoch: 'meeting-a:1',
        segmentId: 'segment-1',
        text: 'provider retry must not replace the original',
        final: true,
      });
      assert.equal(duplicate.inserted, false);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.item.input.text, '最终句子');
      assert.equal(duplicate.item.generation, 1);
      assert.equal(duplicate.item.inputId, first.item.inputId);

      const second = spool.enqueue({
        sessionEpoch: 'meeting-a:1',
        segmentId: 'segment-2',
        text: '第二句',
        isFinal: true,
      });
      const otherSession = spool.enqueue({
        sessionEpoch: 'meeting-b:1',
        segmentId: 'segment-1',
        text: '另一个会议',
        isFinal: true,
      });
      assert.equal(second.item.generation, 2);
      assert.equal(otherSession.item.generation, 1);
      assert.deepEqual(spool.getBySegment('meeting-a:1', 'segment-1'), duplicate.item);
    } finally {
      spool.close();
    }

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(live_spool_inputs)').all()
        .map((row) => row.name);
      assert.equal(columns.includes('raw_audio'), false);
      assert.equal(columns.includes('partial'), false);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM live_spool_inputs').get().count, 3);
    } finally {
      db.close();
    }
  });

  it('persists finals only and moves pending work through an expiring inflight lease', () => {
    let now = 10_000;
    const spool = new LiveSpool(spoolPath(), {
      now: () => now,
      leaseMs: 50,
      retentionMs: 100,
    });
    try {
      assert.throws(() => spool.enqueue({
        sessionEpoch: 'epoch', segmentId: 'partial', text: '还没完', isFinal: false,
      }), /partial transcript/);
      assert.throws(() => spool.enqueue({
        sessionEpoch: 'epoch', segmentId: 'raw', text: 'final', rawAudio: Buffer.from('raw'),
      }), /unsupported field: rawAudio/);

      const inserted = spool.enqueue({
        sessionEpoch: 'epoch', segmentId: 'final', text: '完成', isFinal: true,
      }).item;
      assert.deepEqual(spool.stats(), {
        pending: 1, inflight: 0, consumed: 0, items: 1, sessions: 1,
      });
      const claimed = spool.claim({ limit: 1 });
      assert.equal(claimed[0].status, 'inflight');
      assert.equal(spool.claim({ limit: 1 }).length, 0);

      now += 51;
      const reclaimed = spool.claim({ limit: 1 });
      assert.equal(reclaimed[0].inputId, inserted.inputId);
      const consumed = spool.consume(inserted.inputId);
      assert.equal(consumed.status, 'consumed');
      assert.equal(spool.consume(inserted.inputId).consumedAtMs, now);
      assert.equal(spool.prune(), 0);
      now += 101;
      assert.equal(spool.prune(), 1);
      assert.deepEqual(spool.stats(), {
        pending: 0, inflight: 0, consumed: 0, items: 0, sessions: 0,
      });
    } finally {
      spool.close();
    }
  });

  it('keeps Fly references in a bounded TTL ring and filters snapshots without callbacks', () => {
    let now = 1_000;
    const ring = new FlyReferenceRing({ maxEntries: 2, ttlMs: 600, now: () => now });
    const a = { meetingId: 'a', startMs: 100, endMs: 200, ref: 'fly-a1' };
    const b = { meetingId: 'b', startMs: 150, endMs: 250, ref: 'fly-b1' };
    const c = { meetingId: 'a', startMs: 300, endMs: 400, ref: 'fly-a2' };
    ring.observe(a);
    now += 1;
    ring.observe(b);
    now += 1;
    ring.observe(c);
    assert.deepEqual(ring.snapshot(), [b, c], 'oldest reference is evicted at the bound');
    assert.deepEqual(ring.snapshot({ meetingId: 'a' }), [c]);
    assert.deepEqual(ring.snapshot({ startMs: 225, endMs: 325 }), [b, c]);
    now = 1_602;
    assert.deepEqual(ring.snapshot(), [], 'TTL expiry is lazy and deterministic');
    ring.observe(c);
    assert.equal(ring.clear(), 1);
    assert.deepEqual(ring.snapshot(), []);
  });

  it('claims exact opaque decisions once and checks generation, runtime, and Lark freshness', () => {
    let now = 5_000;
    const generations = new Map([['session-a', 2], ['session-b', 1]]);
    const latest = new Map([['chat-a', 8], ['chat-b', 3]]);
    const authority = new GenericDecisionAuthority({
      runtimeToken: 'runtime-1',
      getCurrentGeneration: (sessionEpoch) => generations.get(sessionEpoch),
      getLatestLarkSeq: (target) => latest.get(target),
      now: () => now,
      ttlMs: 100,
    });
    const issued = authority.issue({
      sessionEpoch: 'session-a',
      generation: 2,
      decisionKey: 'input-17:send-summary',
      action: 'send',
      target: 'chat-a',
      larkFenceSeq: 8,
    });
    const reissued = authority.issue({
      sessionEpoch: 'session-a',
      generation: 2,
      decisionKey: 'input-17:send-summary',
      action: 'send',
      target: 'chat-a',
      larkFenceSeq: 8,
    });
    assert.equal(reissued.capability, issued.capability);
    assert.equal(issued.decisionKey, 'input-17:send-summary');
    assert.match(issued.capability, /^decision_[A-Za-z0-9_-]+$/);
    assert.equal(JSON.stringify(issued).includes('runtime-1'), false);

    assert.throws(() => authority.claim(issued.capability, {
      runtimeToken: 'runtime-1', action: 'reply', target: 'chat-a',
    }), /exact action and target/);
    latest.set('chat-a', 9);
    assert.throws(() => authority.claim(issued.capability, {
      runtimeToken: 'runtime-1', action: 'send', target: 'chat-a',
    }), /freshness fence is stale/);
    latest.set('chat-a', 8);
    const claim = authority.claim(issued.capability, {
      runtimeToken: 'runtime-1', action: 'send', target: 'chat-a',
    });
    assert.equal(claim.decisionKey, 'input-17:send-summary');
    assert.throws(() => authority.claim(issued.capability, {
      runtimeToken: 'runtime-1', action: 'send', target: 'chat-a',
    }), /already claimed/);

    const staleGeneration = authority.issue({
      sessionEpoch: 'session-a', generation: 2, decisionKey: 'input-18',
      action: 'send', target: 'chat-a', larkFenceSeq: 8,
    });
    generations.set('session-a', 3);
    assert.throws(() => authority.claim(staleGeneration.capability, {
      runtimeToken: 'runtime-1', action: 'send', target: 'chat-a',
    }), /generation is stale/);

    const otherSession = authority.issue({
      sessionEpoch: 'session-b', generation: 1, decisionKey: 'input-b',
      action: 'react', target: 'chat-b', larkFenceSeq: 3,
    });
    const abandoned = authority.issue({
      sessionEpoch: 'session-b', generation: 1, decisionKey: 'input-abandoned',
      action: 'send', target: 'chat-b', larkFenceSeq: 3,
    });
    assert.equal(authority.revokeDecision('session-b', 1, 'input-abandoned'), true);
    assert.throws(() => authority.claim(abandoned.capability, {
      runtimeToken: 'runtime-1', action: 'send', target: 'chat-b',
    }), /unknown or revoked/);
    assert.notEqual(authority.issue({
      sessionEpoch: 'session-b', generation: 1, decisionKey: 'input-abandoned',
      action: 'send', target: 'chat-b', larkFenceSeq: 3,
    }).capability, abandoned.capability, 'an unspent abandoned decision can be issued afresh');
    assert.equal(authority.revokeSession('session-a'), 2);
    assert.equal(authority.claim(otherSession.capability, {
      runtimeToken: 'runtime-1', action: 'react', target: 'chat-b',
    }).decisionKey, 'input-b');
    assert.throws(() => authority.issue({
      sessionEpoch: 'session-a', generation: 3, decisionKey: 'later',
      action: 'send', target: 'chat-a', larkFenceSeq: 8,
    }), /session has been revoked/);
  });

  it('does not invalidate source-less meeting authority when newer chat input arrives', () => {
    let latestLarkSeq = 4;
    const authority = new GenericDecisionAuthority({
      runtimeToken: 'runtime-meeting',
      getCurrentGeneration: () => 1,
      getLatestLarkSeq: () => latestLarkSeq,
    });
    const issued = authority.issue({
      sessionEpoch: 'meeting-session',
      generation: 1,
      decisionKey: 'meeting-input',
      action: 'send',
      target: 'chat',
    });
    latestLarkSeq = 99;
    assert.equal(authority.claim(issued.capability, {
      runtimeToken: 'runtime-meeting', action: 'send', target: 'chat',
    }).decisionKey, 'meeting-input');
  });

  it('keeps ended-session tombstones fail-closed for the maximum authority window then prunes them', () => {
    let now = 1_000;
    const authority = new GenericDecisionAuthority({
      runtimeToken: 'runtime-tombstone',
      getCurrentGeneration: () => 1,
      revokedSessionTtlMs: 50,
      now: () => now,
    });
    authority.revokeSession('ended-session');
    assert.throws(() => authority.issue({
      sessionEpoch: 'ended-session', generation: 1, decisionKey: 'late-input',
      action: 'send', target: 'chat',
    }), /session has been revoked/);
    assert.equal(authority.stats().revokedSessions, 1);
    now += 50;
    assert.equal(authority.prune(), 1);
    assert.equal(authority.stats().revokedSessions, 0);
    assert.match(authority.issue({
      sessionEpoch: 'ended-session', generation: 1, decisionKey: 'new-after-window',
      action: 'send', target: 'chat',
    }).capability, /^decision_/);
  });

  it('expires capabilities and fences every old capability on runtime token rotation', () => {
    let now = 100;
    const authority = new GenericDecisionAuthority({
      runtimeToken: 'runtime-old',
      getCurrentGeneration: () => 1,
      getLatestLarkSeq: () => 4,
      now: () => now,
      ttlMs: 10,
    });
    const expired = authority.issue({
      sessionEpoch: 'one', generation: 1, decisionKey: 'expired',
      action: 'send', target: 'chat', larkFenceSeq: 4,
    });
    now = 110;
    assert.throws(() => authority.claim(expired.capability, {
      runtimeToken: 'runtime-old', action: 'send', target: 'chat',
    }), /expired/);

    const old = authority.issue({
      sessionEpoch: 'two', generation: 1, decisionKey: 'old-runtime',
      action: 'send', target: 'chat', larkFenceSeq: 4,
    });
    assert.equal(authority.setRuntimeToken('runtime-new'), 1);
    assert.throws(() => authority.claim(old.capability, {
      runtimeToken: 'runtime-old', action: 'send', target: 'chat',
    }), /unknown or revoked/);
    assert.deepEqual(authority.stats(), {
      active: 0,
      claimed: 0,
      capabilities: 0,
      claimedDecisions: 0,
      revokedSessions: 0,
      runtimeActive: true,
    });
  });
});

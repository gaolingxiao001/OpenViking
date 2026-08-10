import { createHash } from 'node:crypto';
import { opaqueRef, redactSensitive } from './logger.mjs';

export const MEETING_EVENT_TYPES = Object.freeze([
  'vc.bot.meeting_invited_v1',
  'vc.bot.meeting_activity_v1',
  'vc.bot.meeting_ended_v1',
]);

const MEETING_EVENT_SET = new Set(MEETING_EVENT_TYPES);

function safe(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function namedValue(value, names, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) && child !== undefined && child !== null && child !== '') return child;
  }
  for (const child of Object.values(value)) {
    const found = namedValue(child, names, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function textValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function timestampMs(value, fallback = Date.now()) {
  const source = String(value ?? '').trim();
  if (!source) return fallback;
  if (/^\d+$/.test(source)) {
    const number = Number.parseInt(source, 10);
    if (Number.isFinite(number)) return number < 10_000_000_000 ? number * 1_000 : number;
  }
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function eventTypeOf(input) {
  return textValue(
    input?.header?.event_type
      ?? input?.event_type
      ?? input?.data?.event_type
      ?? input?.data?.event?.event_type
      ?? input?.type,
  );
}

export function isMeetingEvent(input) {
  return MEETING_EVENT_SET.has(eventTypeOf(input));
}

export function normalizeMeetingEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('meeting event must be a JSON object');
  }
  const header = object(input.header ?? input.data?.header);
  // lark-cli raw subscriptions use {header,event}; SDK dispatchers flatten the
  // same event data, while mocks commonly wrap it as {data:{event}}.
  const event = object(input.event ?? input.data?.event ?? input.data ?? input);
  const eventType = eventTypeOf(input);
  if (!MEETING_EVENT_SET.has(eventType)) throw new Error(`unsupported meeting event type: ${eventType ?? 'missing'}`);
  const eventId = textValue(header.event_id ?? input.event_id)
    ?? createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const activityItems = Array.isArray(event.meeting_activity_items)
    ? event.meeting_activity_items
    : Array.isArray(event.meeting_actitivty_items) // historical gray-contract typo
      ? event.meeting_actitivty_items
      : [];
  const primaryActivity = object(activityItems[0]);
  const meeting = object(namedValue(primaryActivity, new Set(['meeting']))
    ?? namedValue(event, new Set(['meeting'])));
  const meetingId = textValue(namedValue(event, new Set(['meeting_id', 'meetingId']))
    ?? meeting.id);
  const meetingNumber = textValue(namedValue(event, new Set([
    'meeting_no', 'meeting_number', 'meetingNo', 'meetingNumber',
  ])));
  const callId = textValue(namedValue(event, new Set(['call_id', 'callId'])));
  const activityType = textValue(namedValue(primaryActivity, new Set([
    'activity_event_type', 'activity_type', 'activityEventType', 'event_type',
  ])) ?? namedValue(event, new Set([
    'activity_event_type', 'activity_type', 'activityEventType', 'event_type',
  ]))) ?? eventType;
  const sequenceRaw = namedValue(primaryActivity, new Set(['event_seq', 'activity_seq', 'sequence']))
    ?? namedValue(event, new Set(['event_seq', 'activity_seq', 'sequence']));
  const sequence = Number.parseInt(String(sequenceRaw ?? ''), 10);
  return {
    eventType,
    eventId,
    tenantKey: textValue(header.tenant_key ?? input.tenant_key),
    createTimeMs: timestampMs(header.create_time ?? input.create_time ?? input.timestamp),
    meetingId,
    meetingNumber,
    callId,
    activityType,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null,
    pageToken: textValue(namedValue(event, new Set(['page_token', 'pageToken']))),
    recoveryRequested: namedValue(event, new Set(['need_recovery', 'recovery_required', 'has_more'])) === true,
    activityItems,
    raw: input,
  };
}

function arraysNamed(value, names, output = [], depth = 0) {
  if (depth > 10 || !value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) && Array.isArray(child)) output.push(...child);
    else arraysNamed(child, names, output, depth + 1);
  }
  return output;
}

function firstText(value, names) {
  return textValue(namedValue(value, new Set(names)));
}

function cleanLine(value) {
  return String(value ?? '')
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ⏎ ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

function actorLabel(value, fallback = 'unknown') {
  return firstText(value, [
    'speaker_name', 'participant_name', 'display_name', 'user_name', 'label', 'name',
  ]) ?? fallback;
}

export function meetingContextLines(payload, activityType = 'meeting_activity') {
  const transcriptItems = arraysNamed(payload, new Set(['transcript_received_items', 'transcript_items']));
  const chatItems = arraysNamed(payload, new Set(['chat_received_items', 'chat_items']));
  const shareItems = arraysNamed(payload, new Set(['magic_share_started_items', 'share_started_items']));
  const outerActor = actorLabel(payload);
  const lines = [];
  for (const item of transcriptItems) {
    const content = firstText(item, ['content', 'text', 'transcript', 'sentence']);
    if (!content) continue;
    lines.push(`[transcript] ${actorLabel(item, outerActor)}: ${cleanLine(content)}`);
  }
  for (const item of chatItems) {
    const content = firstText(item, ['content', 'text', 'message']);
    if (!content) continue;
    lines.push(`[meeting chat] ${actorLabel(item, outerActor)}: ${cleanLine(content)}`);
  }
  for (const item of shareItems) {
    const title = firstText(item, ['title', 'name']) ?? 'shared content';
    lines.push(`[meeting share] ${actorLabel(item, outerActor)} shared ${cleanLine(title)}`);
  }
  if (lines.length === 0 && /transcript/i.test(String(activityType))) {
    const content = firstText(payload, ['content', 'text', 'transcript', 'sentence']);
    if (content) lines.push(`[transcript] ${outerActor}: ${cleanLine(content)}`);
  }
  if (lines.length === 0) lines.push(`[meeting activity] ${cleanLine(activityType)}`);
  return lines;
}

function semanticFragments(item, meetingId, activityType, fallbackAtMs) {
  const specs = [
    {
      kind: 'transcript',
      keys: ['transcript_received_items', 'transcript_items'],
      outputKey: 'transcript_received_items',
      idKeys: ['sentence_id', 'sentenceId'],
      timeKeys: ['end_time_ms', 'start_time_ms'],
    },
    {
      kind: 'chat',
      keys: ['chat_received_items', 'chat_items'],
      outputKey: 'chat_received_items',
      idKeys: ['message_id', 'messageId'],
      timeKeys: ['send_time', 'time'],
    },
    {
      kind: 'share_started',
      keys: ['magic_share_started_items', 'share_started_items'],
      outputKey: 'magic_share_started_items',
      idKeys: ['share_id', 'shareId'],
      timeKeys: ['time'],
    },
    {
      kind: 'share_ended',
      keys: ['magic_share_ended_items', 'share_ended_items'],
      outputKey: 'magic_share_ended_items',
      idKeys: ['share_id', 'shareId'],
      timeKeys: ['time'],
    },
    {
      kind: 'participant_joined',
      keys: ['participant_joined_items'],
      outputKey: 'participant_joined_items',
      idKeys: ['join_time'],
      timeKeys: ['join_time'],
    },
    {
      kind: 'participant_left',
      keys: ['participant_left_items'],
      outputKey: 'participant_left_items',
      idKeys: ['leave_time'],
      timeKeys: ['leave_time'],
    },
  ];
  const fragments = [];
  for (const spec of specs) {
    const children = arraysNamed(item, new Set(spec.keys));
    for (const child of children) {
      const providerId = firstText(child, spec.idKeys);
      const participantId = spec.kind.startsWith('participant_')
        ? firstText(child, ['id'])
        : null;
      const stableId = participantId && providerId
        ? `${participantId}:${providerId}`
        : providerId ?? createHash('sha256').update(JSON.stringify(child)).digest('hex');
      const key = createHash('sha256')
        // kind + provider item id is stable across raw push enums and the
        // lark-cli pull formatter's human-readable event_type.
        .update(`${meetingId}\0${spec.kind}\0${stableId}`)
        .digest('hex');
      fragments.push({
        eventKey: `meeting:${key}`,
        occurredAtMs: timestampMs(namedValue(child, new Set(spec.timeKeys)), fallbackAtMs),
        payload: {
          activity_event_type: activityType,
          ...(Array.isArray(item.actors) ? { actors: item.actors } : {}),
          [spec.outputKey]: [child],
        },
      });
    }
  }
  if (fragments.length > 0) return fragments;
  const digest = createHash('sha256')
    .update(`${meetingId}\0${activityType}\0${JSON.stringify(item)}`)
    .digest('hex');
  return [{
    eventKey: `meeting:${digest}`,
    occurredAtMs: fallbackAtMs,
    payload: item,
  }];
}

function joinMeetingFrom(value) {
  const meeting = value?.data?.meeting ?? value?.meeting ?? value?.data?.data?.meeting;
  const meetingId = textValue(meeting?.id ?? meeting?.meeting_id
    ?? namedValue(value, new Set(['meeting_id', 'meetingId'])));
  const meetingNumber = textValue(meeting?.meeting_no ?? meeting?.meeting_number);
  return { meetingId, meetingNumber };
}

function pullEnvelope(value) {
  const data = value?.data?.data ?? value?.data ?? value ?? {};
  const events = Array.isArray(data.events) ? data.events
    : Array.isArray(data.items) ? data.items
      : [];
  return {
    events,
    pageToken: textValue(data.page_token ?? data.pageToken ?? value?.page_token),
    hasMore: Boolean(data.has_more ?? data.hasMore),
  };
}

export class MeetingAdapter {
  constructor({
    store,
    lark,
    logger,
    batchDelayMs = 15_000,
    batchMaxEvents = 50,
    batchMaxChars = 30_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.store = store;
    this.lark = lark;
    this.logger = logger;
    this.batchDelayMs = batchDelayMs;
    this.batchMaxEvents = batchMaxEvents;
    this.batchMaxChars = batchMaxChars;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timers = new Map();
    this.ingress = Promise.resolve();
    this.stopped = false;
  }

  handleEvent(input) {
    const work = this.ingress.then(() => this._handleEvent(input));
    this.ingress = work.catch((error) => {
      this.logger.warn('meeting_event_failed', { error: safe(error) });
    });
    return work;
  }

  async _handleEvent(input) {
    if (this.stopped) return false;
    const event = normalizeMeetingEvent(input);
    if (event.eventType === 'vc.bot.meeting_invited_v1') return this._handleInvite(event);
    if (event.eventType === 'vc.bot.meeting_activity_v1' && event.activityItems.length > 0) {
      return this._handleActivityItems(event);
    }
    if (!event.meetingId) throw new Error(`${event.eventType} is missing meeting_id`);
    const sessionBeforeEvent = this.store.ensureMeetingSession(event.meetingId, {
      meetingNumber: event.meetingNumber,
      atMs: event.createTimeMs,
    });
    const inserted = this.store.ingestMeetingEvent({
      eventKey: `push:${event.eventId}`,
      meetingId: event.meetingId,
      eventType: event.eventType,
      activityType: event.activityType,
      occurredAtMs: event.createTimeMs,
      payload: event.raw,
    });
    const sequenceGap = this.store.meetingHasSequenceGap(event.meetingId, event.sequence);
    this.store.updateMeetingProgress(event.meetingId, {
      pageToken: event.pageToken,
      sequence: event.sequence,
      eventAtMs: event.createTimeMs,
    });
    if (inserted) this._schedule(event.meetingId);
    if (event.eventType === 'vc.bot.meeting_ended_v1') {
      // The event API remains readable for a short grace period after the
      // meeting ends. Reconcile from the saved cursor before sealing the batch
      // so late/out-of-order final sentences are not lost.
      await this._recoverMeeting(sessionBeforeEvent);
      await this.flushMeeting(event.meetingId, { all: true });
      this.store.finishMeeting(event.meetingId, event.createTimeMs);
    } else if (event.recoveryRequested || sequenceGap) {
      await this._recoverMeeting(this.store.meetingSessionById(event.meetingId));
    }
    return inserted;
  }

  async _handleActivityItems(event) {
    let insertedAny = false;
    const touched = new Set();
    for (const [index, itemValue] of event.activityItems.entries()) {
      const item = object(itemValue);
      const meeting = object(namedValue(item, new Set(['meeting'])));
      const meetingId = textValue(namedValue(item, new Set(['meeting_id', 'meetingId'])) ?? meeting.id);
      if (!meetingId) throw new Error('meeting activity item is missing meeting.id');
      const meetingNumber = textValue(namedValue(meeting, new Set([
        'meeting_no', 'meeting_number', 'meetingNo', 'meetingNumber',
      ])));
      const activityType = firstText(item, [
        'activity_event_type', 'activity_type', 'activityEventType', 'event_type',
      ]) ?? event.activityType;
      const sequenceRaw = namedValue(item, new Set(['event_seq', 'activity_seq', 'sequence']));
      const sequenceNumber = Number.parseInt(String(sequenceRaw ?? ''), 10);
      const sequence = Number.isSafeInteger(sequenceNumber) && sequenceNumber >= 0
        ? sequenceNumber
        : event.sequence;
      const itemAtMs = timestampMs(namedValue(item, new Set([
        'event_time', 'create_time', 'timestamp', 'start_time_ms', 'send_time', 'time',
      ])), event.createTimeMs);
      this.store.ensureMeetingSession(meetingId, { meetingNumber, atMs: itemAtMs });
      const sequenceGap = this.store.meetingHasSequenceGap(meetingId, sequence);
      let latestEventAtMs = itemAtMs;
      let inserted = false;
      for (const fragment of semanticFragments(item, meetingId, activityType, itemAtMs)) {
        latestEventAtMs = Math.max(latestEventAtMs, fragment.occurredAtMs);
        inserted = this.store.ingestMeetingEvent({
          eventKey: fragment.eventKey,
          meetingId,
          eventType: event.eventType,
          activityType,
          occurredAtMs: fragment.occurredAtMs,
          payload: fragment.payload,
        }) || inserted;
      }
      this.store.updateMeetingProgress(meetingId, {
        pageToken: event.pageToken,
        sequence,
        eventAtMs: latestEventAtMs,
      });
      if (inserted) {
        insertedAny = true;
        this._schedule(meetingId);
      }
      touched.add(meetingId);
      if (event.recoveryRequested || sequenceGap) {
        await this._recoverMeeting(this.store.meetingSessionById(meetingId));
      }
    }
    return insertedAny || touched.size > 0;
  }

  async _handleInvite(event) {
    if (!event.meetingNumber) throw new Error('meeting invite is missing meeting number');
    const sessionKey = event.meetingId
      ? `meeting:${event.meetingId}`
      : event.callId
        ? `call:${event.callId}`
        : `invite:${event.eventId}`;
    const session = this.store.upsertMeetingInvite({
      sessionKey,
      meetingId: event.meetingId,
      meetingNumber: event.meetingNumber,
      callId: event.callId,
      eventId: event.eventId,
      atMs: event.createTimeMs,
    });
    if (['JOINED', 'ACTIVE', 'ENDED', 'JOINING'].includes(session.status)) return false;
    this.store.markMeetingJoining(sessionKey, event.createTimeMs);
    try {
      const result = await this.lark.joinMeeting({
        meetingNumber: event.meetingNumber,
        callId: event.callId,
      });
      const joined = joinMeetingFrom(result);
      if (!joined.meetingId) throw new Error('meeting join returned no meeting.id');
      this.store.markMeetingJoined(sessionKey, {
        meetingId: joined.meetingId,
        meetingNumber: joined.meetingNumber ?? event.meetingNumber,
        atMs: Date.now(),
      });
      this.logger.info('meeting_joined', { meetingRef: opaqueRef(joined.meetingId) });
      return true;
    } catch (error) {
      this.store.markMeetingJoinFailed(sessionKey, safe(error), Date.now());
      throw error;
    }
  }

  _schedule(meetingId) {
    if (this.stopped || this.timers.has(meetingId)) return;
    const timer = this.setTimer(() => {
      this.timers.delete(meetingId);
      void this.flushMeeting(meetingId).catch((error) => {
        this.logger.warn('meeting_batch_flush_failed', { meetingRef: opaqueRef(meetingId), error: safe(error) });
      });
    }, this.batchDelayMs);
    timer?.unref?.();
    this.timers.set(meetingId, timer);
  }

  async flushMeeting(meetingId, { all = false } = {}) {
    const timer = this.timers.get(meetingId);
    if (timer) this.clearTimer(timer);
    this.timers.delete(meetingId);
    let batches = 0;
    do {
      const rows = this.store.pendingMeetingEvents(meetingId, this.batchMaxEvents);
      if (rows.length === 0) break;
      const selected = [];
      const lines = [];
      let chars = 0;
      for (const row of rows) {
        const rowLines = meetingContextLines(row.payload, row.activityType);
        const rendered = rowLines.join(' ⏎ ');
        if (selected.length > 0 && chars + rendered.length > this.batchMaxChars) break;
        selected.push(row);
        lines.push(rendered.slice(0, this.batchMaxChars));
        chars += rendered.length;
      }
      const first = selected[0];
      const last = selected.at(-1);
      const text = `[meeting=${meetingId} kind=context_batch events=${selected.length}] ${lines.join(' ⏎ ')}`;
      this.store.commitMeetingContextBatch(meetingId, selected, text, last.occurredAtMs, {
        dedupeKey: `meeting-context:${meetingId}:${first.id}-${last.id}`,
      });
      batches += 1;
      if (!all) break;
    } while (true);
    if (!all && this.store.pendingMeetingEvents(meetingId, 1).length > 0) this._schedule(meetingId);
    return batches;
  }

  async _recoverMeeting(session) {
    if (!session?.meetingId || session.status === 'ENDED') return false;
    try {
      const result = await this.lark.listMeetingEvents({
        meetingId: session.meetingId,
        pageToken: session.pageToken,
        startMs: session.pageToken ? null : session.lastEventAtMs,
      });
      const envelope = pullEnvelope(result);
      for (const item of envelope.events) {
        const activityType = firstText(item, ['event_type', 'activity_event_type', 'activity_type'])
          ?? 'recovered_activity';
        const occurredAtMs = timestampMs(namedValue(item, new Set([
          'occurred_at_ms', 'event_time', 'create_time', 'timestamp', 'start_time',
        ])), Date.now());
        for (const fragment of semanticFragments(item, session.meetingId, activityType, occurredAtMs)) {
          this.store.ingestMeetingEvent({
            eventKey: fragment.eventKey,
            meetingId: session.meetingId,
            eventType: 'vc.bot.meeting_activity_v1',
            activityType,
            occurredAtMs: fragment.occurredAtMs,
            payload: fragment.payload,
          });
        }
      }
      this.store.updateMeetingProgress(session.meetingId, {
        pageToken: envelope.pageToken,
        eventAtMs: Date.now(),
      });
      if (envelope.events.length > 0) this._schedule(session.meetingId);
      return true;
    } catch (error) {
      if (/20001|MEETING_END/i.test(String(error))) this.store.finishMeeting(session.meetingId, Date.now());
      this.logger.warn('meeting_recovery_failed', { meetingRef: opaqueRef(session.meetingId), error: safe(error) });
      return false;
    }
  }

  async start() {
    for (const meetingId of this.store.pendingMeetingIds()) this._schedule(meetingId);
    for (const session of this.store.activeMeetingSessions()) await this._recoverMeeting(session);
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    await this.ingress.catch(() => {});
    for (const meetingId of this.store.pendingMeetingIds()) await this.flushMeeting(meetingId, { all: true });
  }
}

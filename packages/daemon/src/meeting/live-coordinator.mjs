import { arraysNamed, firstText, namedValue } from './events.mjs';

export class MeetingGenerationClock {
  constructor() {
    this.values = new Map();
  }

  next(sessionEpoch) {
    const value = (this.values.get(sessionEpoch) ?? 0) + 1;
    this.values.set(sessionEpoch, value);
    return value;
  }

  current(sessionEpoch) {
    return this.values.get(sessionEpoch) ?? 0;
  }

  observe(sessionEpoch, generation) {
    const value = Number(generation);
    if (!Number.isSafeInteger(value) || value < 1) return this.current(sessionEpoch);
    this.values.set(sessionEpoch, Math.max(this.current(sessionEpoch), value));
    return this.current(sessionEpoch);
  }

  clear(sessionEpoch) {
    this.values.delete(sessionEpoch);
  }
}

function transcriptReference(input) {
  const items = arraysNamed(input.payload, new Set([
    'transcript_received_items',
    'transcript_items',
  ]));
  const first = items[0] ?? input.payload;
  return {
    meetingId: input.meetingId,
    eventKey: input.eventKey,
    occurredAtMs: input.occurredAtMs,
    startMs: Number(namedValue(first, new Set(['start_time_ms', 'startTimeMs']))) || null,
    endMs: Number(namedValue(first, new Set(['end_time_ms', 'endTimeMs']))) || null,
    speaker: firstText(first, ['speaker_name', 'user_name', 'display_name', 'name']) ?? 'unknown',
    text: firstText(first, ['content', 'text', 'transcript', 'sentence']) ?? '',
  };
}

// MeetingAdapter owns membership. This coordinator only starts/stops the media
// branch after those lifecycle decisions have already been made.
export class MeetingAudioCoordinator {
  constructor({
    media,
    flyReferences,
    authority,
    targetChatId,
    generationClock,
    mediaEndpointProvider = null,
    onSessionClosed = null,
    logger = null,
    restartBaseDelayMs = 1_000,
    restartMaxDelayMs = 30_000,
    restartMaxAttempts = 5,
    sessionCloseGraceMs = 300_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    Object.assign(this, {
      media,
      flyReferences,
      authority,
      targetChatId,
      generationClock,
      mediaEndpointProvider,
      onSessionClosed,
      logger,
      restartBaseDelayMs,
      restartMaxDelayMs,
      restartMaxAttempts,
      sessionCloseGraceMs,
      setTimer,
      clearTimer,
    });
    this.joined = new Map();
    this.closing = new Map();
    this.stopped = false;
  }

  async onJoined(session) {
    if (this.stopped) throw new Error('meeting audio coordinator is stopped');
    if (!session?.meetingId) throw new Error('joined meeting requires meetingId');
    let entry = this.joined.get(session.meetingId);
    if (!entry) {
      entry = {
        session: { ...session },
        restartAttempts: 0,
        restartTimer: null,
        starting: null,
        unavailableEpoch: null,
        liveEpoch: null,
      };
      this.joined.set(session.meetingId, entry);
    } else {
      entry.session = { ...entry.session, ...session };
    }
    return await this._start(entry);
  }

  activeJoinedSession(meetingId) {
    const entry = this.joined.get(meetingId);
    return entry ? { ...entry.session, restartAttempts: entry.restartAttempts } : null;
  }

  async _start(entry) {
    if (this.stopped || this.joined.get(entry.session.meetingId) !== entry) return null;
    const active = this.media.activeSession(entry.session.meetingId);
    if (active) return active;
    if (entry.starting) return await entry.starting;
    const work = (async () => {
      try {
        const mediaEndpoint = await this.mediaEndpointProvider?.(entry.session.meetingId) ?? null;
        if (!mediaEndpoint) throw new Error('meeting media endpoint is unavailable');
        if (this.stopped || this.joined.get(entry.session.meetingId) !== entry) return null;
        return await this.media.start({
          ...entry.session,
          mediaEndpoint,
          targetChatId: this.targetChatId,
        });
      } catch (error) {
        if (!this.stopped && this.joined.get(entry.session.meetingId) === entry) {
          this._scheduleRestart(entry, error);
        }
        this.logger?.warn?.('meeting_media_start_failed', { error: error?.message });
        return null;
      }
    })();
    entry.starting = work;
    try {
      return await work;
    } finally {
      if (entry.starting === work) entry.starting = null;
    }
  }

  _scheduleRestart(entry, error = null) {
    if (this.stopped || this.joined.get(entry.session.meetingId) !== entry
      || entry.restartTimer) return false;
    if (entry.restartAttempts >= this.restartMaxAttempts) {
      this.logger?.warn?.('meeting_media_restart_exhausted', {
        meetingId: entry.session.meetingId,
        attempts: entry.restartAttempts,
        error: error?.message,
      });
      return false;
    }
    const delayMs = Math.min(
      this.restartMaxDelayMs,
      this.restartBaseDelayMs * (2 ** entry.restartAttempts),
    );
    entry.restartAttempts += 1;
    entry.restartTimer = this.setTimer(() => {
      entry.restartTimer = null;
      void this._start(entry);
    }, delayMs);
    entry.restartTimer?.unref?.();
    return true;
  }

  onMediaState(session) {
    if (session?.state !== 'LIVE') return false;
    const entry = this.joined.get(session.meetingId);
    if (!entry || entry.liveEpoch === session.sessionEpoch) return false;
    entry.liveEpoch = session.sessionEpoch;
    entry.restartAttempts = 0;
    entry.unavailableEpoch = null;
    return true;
  }

  async onEnding({ meetingId, reason = 'meeting_ended' }) {
    const joined = this.joined.get(meetingId);
    if (joined) {
      this.joined.delete(meetingId);
      if (joined.restartTimer) this.clearTimer(joined.restartTimer);
      joined.restartTimer = null;
    }
    const session = this.media.state(meetingId);
    await this.media.stop(meetingId, reason);
    if (session?.sessionEpoch) this._deferSessionClose(session, { reason });
  }

  observeFlyTranscript(input) {
    const reference = transcriptReference(input);
    if (!reference.text) return false;
    this.flyReferences.observe(reference);
    return true;
  }

  async onUnavailable(session, reason = null) {
    const entry = this.joined.get(session?.meetingId);
    if (!entry || this.stopped || entry.unavailableEpoch === session?.sessionEpoch) return false;
    entry.unavailableEpoch = session?.sessionEpoch ?? null;
    await this.media.stop(session.meetingId, reason?.reason ?? 'worker_unavailable');
    if (session?.sessionEpoch) await this._closeSession(session, reason);
    this._scheduleRestart(entry, reason?.error);
    return true;
  }

  async _closeSession(session, reason) {
    this.authority?.revokeSession?.(session.sessionEpoch);
    await this.onSessionClosed?.(session, reason);
    this.generationClock?.clear?.(session.sessionEpoch);
  }

  _deferSessionClose(session, reason) {
    if (!session?.sessionEpoch || this.closing.has(session.sessionEpoch) || this.stopped) return false;
    const close = async () => {
      this.closing.delete(session.sessionEpoch);
      await this._closeSession(session, reason);
    };
    const timer = this.setTimer(() => {
      void close().catch((error) => {
        this.logger?.warn?.('meeting_session_close_failed', { error: error?.message });
      });
    }, this.sessionCloseGraceMs);
    timer?.unref?.();
    this.closing.set(session.sessionEpoch, { timer, session, reason });
    return true;
  }

  async stop() {
    this.stopped = true;
    const deferred = [...this.closing.values()];
    const current = [...this.joined.keys()]
      .map((meetingId) => this.media.state(meetingId))
      .filter((session) => session?.sessionEpoch);
    for (const entry of this.joined.values()) {
      if (entry.restartTimer) this.clearTimer(entry.restartTimer);
    }
    this.joined.clear();
    for (const value of deferred) this.clearTimer(value.timer);
    this.closing.clear();
    await this.media.stopAll('daemon_shutdown');
    const sessions = new Map();
    for (const value of deferred) sessions.set(value.session.sessionEpoch, value);
    for (const session of current) {
      sessions.set(session.sessionEpoch, { session, reason: { reason: 'daemon_shutdown' } });
    }
    await Promise.allSettled([...sessions.values()].map(({ session, reason }) => (
      this._closeSession(session, reason)
    )));
  }
}

import { createHash } from 'node:crypto';

const FORGED_METADATA = /^\s*\[[^\]\r\n]*(?:chat|msg|time|from|thread|idle|undecided)\s*=/i;

function inputId(sessionEpoch, segmentId) {
  const digest = createHash('sha256')
    .update(sessionEpoch).update('\0').update(segmentId)
    .digest('hex');
  return `meeting_input_${digest.slice(0, 32)}`;
}

function finiteOrNull(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

function ignored(reason) {
  return { accepted: false, ignored: reason };
}

// The only daemon boundary that accepts worker output. It knows sessions and
// normalized final text, but no Lark delivery implementation.
export class MeetingInputPort {
  constructor({ spool, onReady = null, maxTextChars = 3_000 }) {
    if (typeof spool?.enqueue !== 'function') throw new TypeError('spool.enqueue is required');
    Object.assign(this, { spool, onReady, maxTextChars });
  }

  accept(session, event) {
    if (event?.type !== 'final') return ignored('final_required');
    if (!session?.sessionEpoch || !session?.meetingId
      || event.sessionEpoch !== session.sessionEpoch
      || Number(event.captureGeneration) !== Number(session.captureGeneration)) {
      return ignored('stale_session');
    }
    const segmentId = typeof event.segmentId === 'string' ? event.segmentId.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(segmentId)) return ignored('invalid_segment_id');
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text || [...text].length > this.maxTextChars) return ignored('invalid_final_text');
    if (FORGED_METADATA.test(text)) return ignored('forged_metadata');
    let audioStartMs;
    let audioEndMs;
    try {
      audioStartMs = finiteOrNull(event.audioStartMs, 'audioStartMs');
      audioEndMs = finiteOrNull(event.audioEndMs, 'audioEndMs');
    } catch {
      return ignored('invalid_audio_time');
    }
    if (audioStartMs !== null && audioEndMs !== null && audioEndMs < audioStartMs) {
      return ignored('invalid_audio_range');
    }
    const normalized = {
      inputId: inputId(session.sessionEpoch, segmentId),
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
      meetingId: session.meetingId,
      meetingNumber: session.meetingNumber,
      targetChatId: session.targetChatId ?? null,
      segmentId,
      segmentSeq: Number.isSafeInteger(event.segmentSeq) && event.segmentSeq >= 0
        ? event.segmentSeq
        : null,
      text,
      audioStartMs,
      audioEndMs,
      receivedAtMs: Date.now(),
      speaker: 'unknown',
    };
    const stored = this.spool.enqueue(normalized);
    if (stored.inserted !== false && !stored.duplicate) {
      this.onReady?.(stored.item);
    }
    return {
      accepted: true,
      duplicate: Boolean(stored.duplicate),
      inputId: stored.item?.inputId,
      generation: stored.item?.generation,
    };
  }
}

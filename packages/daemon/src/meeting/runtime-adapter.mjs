function oneLine(value, maxLength = 8_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r?\n/g, ' ⏎ ')
    .slice(0, maxLength);
}

function field(value) {
  return encodeURIComponent(oneLine(value, 1_024));
}

const CLAIM_BATCH_SIZE = 100;
const MAX_BATCHES_PER_DRAIN = 5;

export function formatMeetingInput(item, capability, flyReferences = [], targetChatId) {
  const input = item.input ?? {};
  const startMs = input.audioStartMs ?? input.startMs ?? null;
  const endMs = input.audioEndMs ?? input.endMs ?? null;
  const metadata = [
    'meeting-audio',
    `meeting=${field(input.meetingId ?? 'unknown')}`,
    `session=${field(item.sessionEpoch)}`,
    `generation=${item.generation}`,
    `input=${field(item.inputId)}`,
    `speaker=${field(input.speakerName ?? input.speaker ?? 'unknown')}`,
    'source=local_asr',
    'no_source=true',
    `target_chat=${field(targetChatId)}`,
    `decision_capability=${field(capability)}`,
  ];
  if (startMs !== null) metadata.push(`audio_start_ms=${startMs}`);
  if (endMs !== null) metadata.push(`audio_end_ms=${endMs}`);
  const transcript = oneLine(input.text, 32_000);
  const references = flyReferences.slice(-3)
    .map((reference) => {
      const speaker = oneLine(reference?.speaker ?? 'unknown', 200);
      const text = oneLine(reference?.text ?? '', 2_000);
      return text ? `[Fly reference speaker=${field(speaker)}] ${text}` : '';
    })
    .filter(Boolean);
  return `[${metadata.join(' ')}] ${transcript}${references.length ? ` ⏎ ${references.join(' ⏎ ')}` : ''}`;
}

// Converts durable final-only inputs into optional runtime receipts. The daemon
// ingress barrier remains the single ordering authority; Fly references are
// sampled only while formatting a real ASR final and never wake the model.
export class MeetingRuntimeAdapter {
  constructor({
    spool,
    authority,
    generationClock,
    flyReferences,
    runtime,
    targetChatId,
    getRuntimeToken,
    submitIngress,
    flushBufferedIngress = null,
    logger = null,
    retryMs = 1_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (typeof spool?.claim !== 'function') throw new TypeError('live spool is required');
    if (typeof authority?.issue !== 'function') throw new TypeError('decision authority is required');
    if (typeof runtime?.deliverBatch !== 'function') throw new TypeError('runtime deliverBatch is required');
    if (typeof getRuntimeToken !== 'function') throw new TypeError('getRuntimeToken is required');
    if (typeof submitIngress !== 'function') throw new TypeError('submitIngress is required');
    Object.assign(this, {
      spool,
      authority,
      generationClock,
      flyReferences,
      runtime,
      targetChatId,
      getRuntimeToken,
      submitIngress,
      flushBufferedIngress,
      logger,
      retryMs,
      setTimer,
      clearTimer,
    });
    this.scheduled = false;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.scheduleDrain();
  }

  onReady() {
    this.scheduleDrain();
  }

  scheduleDrain(delayMs = 0) {
    if (this.stopped || this.scheduled || this.timer) return false;
    const run = () => {
      this.timer = null;
      if (this.stopped || this.scheduled) return;
      this.scheduled = true;
      void this.submitIngress(async () => {
        let nextDelayMs = null;
        try {
          nextDelayMs = await this._drain();
        } finally {
          this.scheduled = false;
          if (nextDelayMs !== null) this.scheduleDrain(nextDelayMs);
        }
      }).catch((error) => {
        this.scheduled = false;
        this.logger?.warn?.('meeting_runtime_drain_failed', { error: error?.message });
        this.scheduleDrain(this.retryMs);
      });
    };
    if (delayMs > 0) {
      this.timer = this.setTimer(run, delayMs);
      this.timer?.unref?.();
    } else {
      queueMicrotask(run);
    }
    return true;
  }

  async _drain() {
    this.flushBufferedIngress?.();
    for (let batchIndex = 0; batchIndex < MAX_BATCHES_PER_DRAIN; batchIndex += 1) {
      const items = this.spool.claim({ limit: CLAIM_BATCH_SIZE });
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        try {
          this.authority.setRuntimeToken?.(this.getRuntimeToken());
          this.generationClock.observe(item.sessionEpoch, item.generation);
          const issued = this.authority.issue({
            sessionEpoch: item.sessionEpoch,
            generation: item.generation,
            decisionKey: item.inputId,
            action: 'send_lark_message',
            target: this.targetChatId,
          });
          const references = this.flyReferences?.snapshot?.({
            meetingId: item.input?.meetingId,
          }) ?? [];
          const accepted = this.runtime.deliverBatch([{
            text: formatMeetingInput(item, issued.capability, references, this.targetChatId),
            seq: null,
            receiptId: item.inputId,
          }]);
          if (accepted === false) {
            this.authority.revokeDecision?.(item.sessionEpoch, item.generation, item.inputId);
            this.spool.release(item.inputId);
            for (const unprocessed of items.slice(itemIndex + 1)) {
              this.spool.release(unprocessed.inputId);
            }
            return this.retryMs;
          }
        } catch (error) {
          this.authority.revokeDecision?.(item.sessionEpoch, item.generation, item.inputId);
          try { this.spool.release(item.inputId); } catch {}
          for (const unprocessed of items.slice(itemIndex + 1)) {
            try { this.spool.release(unprocessed.inputId); } catch {}
          }
          this.logger?.warn?.('meeting_runtime_input_failed', { error: error?.message });
          return this.retryMs;
        }
      }
      if (items.length < CLAIM_BATCH_SIZE) return null;
    }
    // Yield the shared ingress barrier after a bounded amount of recovery work,
    // then continue immediately until the durable backlog is empty.
    return 0;
  }

  onTurnSucceeded({ receiptIds = [] } = {}) {
    for (const inputId of receiptIds) {
      try {
        const item = this.spool.get(inputId);
        if (item && this.authority.decisionStatus?.(
          item.sessionEpoch,
          item.generation,
          item.inputId,
        ) !== 'claimed') {
          // A successful silent turn is a real decision too. Revoke its unused
          // capability before consuming the receipt.
          this.authority.revokeDecision?.(item.sessionEpoch, item.generation, item.inputId);
        }
        this.spool.consume(inputId);
      } catch (error) {
        this.logger?.warn?.('meeting_spool_consume_failed', { error: error?.message });
      }
    }
  }

  onTurnFailed({ receiptIds = [] } = {}) {
    this._releaseReceipts(receiptIds);
  }

  onTurnAbandoned({ receiptIds = [] } = {}) {
    this._releaseReceipts(receiptIds);
  }

  _releaseReceipts(receiptIds) {
    for (const inputId of receiptIds) {
      const item = this.spool.get(inputId);
      if (!item) continue;
      if (this.authority.decisionStatus?.(
        item.sessionEpoch,
        item.generation,
        item.inputId,
      ) === 'claimed') {
        // Claim is the external side-effect boundary. Once crossed, retrying
        // the model input cannot authorize another send and would loop forever.
        try { this.spool.consume(inputId); } catch {}
        continue;
      }
      this.authority.revokeDecision?.(item.sessionEpoch, item.generation, item.inputId);
      try { this.spool.release(inputId); } catch {}
    }
    if (receiptIds.length) this.scheduleDrain(this.retryMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

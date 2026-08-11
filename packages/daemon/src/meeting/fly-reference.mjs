export const DEFAULT_FLY_REFERENCE_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_FLY_REFERENCE_LIMIT = 256;

// Deliberately volatile: Fly transcript arrives late and is correction/context
// only. It must never become a durable trigger or be replayed after restart.

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative millisecond timestamp`);
  }
  return value;
}

export class FlyReferenceRing {
  constructor({
    maxEntries = DEFAULT_FLY_REFERENCE_LIMIT,
    ttlMs = DEFAULT_FLY_REFERENCE_TTL_MS,
    now = Date.now,
  } = {}) {
    this.maxEntries = positiveInteger(maxEntries, 'maxEntries');
    this.ttlMs = positiveInteger(ttlMs, 'ttlMs');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
    this.entries = [];
  }

  _prune(atMs) {
    this.entries = this.entries.filter((entry) => entry.expiresAtMs > atMs);
  }

  observe(reference, options = {}) {
    if (reference === undefined || reference === null) {
      throw new TypeError('reference is required');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('observe options must be an object');
    }
    const observedAtMs = optionalTimestamp(options.atMs, 'atMs') ?? this.now();
    optionalTimestamp(observedAtMs, 'atMs');
    this._prune(observedAtMs);

    const meetingId = options.meetingId ?? reference?.meetingId ?? null;
    const startMs = optionalTimestamp(
      options.startMs ?? reference?.startMs ?? reference?.startedAtMs,
      'startMs',
    ) ?? observedAtMs;
    const endMs = optionalTimestamp(
      options.endMs ?? reference?.endMs ?? reference?.endedAtMs,
      'endMs',
    ) ?? startMs;
    if (endMs < startMs) throw new RangeError('endMs must not be earlier than startMs');
    const entry = {
      reference,
      meetingId: meetingId === null || meetingId === undefined ? null : String(meetingId),
      startMs,
      endMs,
      observedAtMs,
      expiresAtMs: observedAtMs + this.ttlMs,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return reference;
  }

  snapshot({ meetingId = null, startMs = null, endMs = null, atMs = this.now() } = {}) {
    const safeAtMs = optionalTimestamp(atMs, 'atMs');
    const safeStartMs = optionalTimestamp(startMs, 'startMs');
    const safeEndMs = optionalTimestamp(endMs, 'endMs');
    if (safeStartMs !== null && safeEndMs !== null && safeEndMs < safeStartMs) {
      throw new RangeError('endMs must not be earlier than startMs');
    }
    this._prune(safeAtMs);
    const safeMeetingId = meetingId === null || meetingId === undefined
      ? null
      : String(meetingId);
    return this.entries
      .filter((entry) => safeMeetingId === null || entry.meetingId === safeMeetingId)
      .filter((entry) => safeStartMs === null || entry.endMs >= safeStartMs)
      .filter((entry) => safeEndMs === null || entry.startMs <= safeEndMs)
      .map((entry) => entry.reference);
  }

  clear() {
    const removed = this.entries.length;
    this.entries = [];
    return removed;
  }
}

import { formatCognitionJournalLine } from '../src/cognition.mjs';
// Explicit fake OV /context response for native adapter tests.
export function ovFixture(rows = []) {
  return { sessionId: 'ov-test-session', latest_archive_overview: '',
    messages: rows.map((row) => ({ source_message_ids: [`lark:${row.epoch ?? 1}:${row.seq}`],
      parts: [{ type: 'text', text: formatCognitionJournalLine(row) }] })) };
}

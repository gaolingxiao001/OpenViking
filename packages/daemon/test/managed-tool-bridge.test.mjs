import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LARK_TOOLS } from '../src/lark-tools.mjs';
import {
  MANAGED_TOOL_PROTOCOL,
  managedProtocolErrorMessage,
  managedToolDefinitions,
  managedToolPolicy,
  managedToolResultMessage,
  parseManagedToolDecision,
} from '../src/managed-tool-bridge.mjs';

describe('managed-agent text tool bridge protocol', () => {
  const tools = managedToolDefinitions(LARK_TOOLS);

  it('publishes text-safe schemas without daemon-owned arguments', () => {
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('reply_lark_message'));
    assert.ok(!names.includes('read_meeting_inbox'));
    assert.ok(!names.includes('view_lark_image'));
    const reply = tools.find((tool) => tool.name === 'reply_lark_message');
    assert.ok(!Object.hasOwn(reply.inputSchema.properties, 'decision_message_id'));
    assert.ok(!Object.hasOwn(reply.inputSchema.properties, 'response_to_message_id'));
    assert.ok(!Object.hasOwn(reply.inputSchema.properties, 'idempotency_key'));
    const react = tools.find((tool) => tool.name === 'react_to_lark_message');
    assert.ok(!Object.hasOwn(react.inputSchema.properties, 'temporary'));
    assert.doesNotMatch(react.description, /temporary/);

    const policy = managedToolPolicy(tools);
    assert.match(policy, /every agent\.message MUST be exactly one JSON object/);
    assert.match(policy, /reply_lark_message/);
    assert.doesNotMatch(policy, /decision_message_id/);
  });

  it('accepts one strict tool decision or silent finish', () => {
    const call = parseManagedToolDecision(JSON.stringify({
      protocol: MANAGED_TOOL_PROTOCOL,
      kind: 'tool_call',
      call_id: 'call_1',
      name: 'reply_lark_message',
      arguments: { message_id: 'om_message123456', text: 'answer' },
    }), tools);
    assert.deepEqual(call, {
      kind: 'tool_call',
      callId: 'call_1',
      name: 'reply_lark_message',
      arguments: { message_id: 'om_message123456', text: 'answer' },
    });
    assert.deepEqual(parseManagedToolDecision(JSON.stringify({
      protocol: MANAGED_TOOL_PROTOCOL,
      kind: 'finish',
      outcome: 'silent',
    }), tools), { kind: 'finish', outcome: 'silent' });
  });

  it('fails closed on prose, unknown tools, protected metadata and invalid arguments', () => {
    assert.throws(
      () => parseManagedToolDecision('```json\n{}\n```', tools),
      /strict JSON/,
    );
    assert.throws(() => parseManagedToolDecision(JSON.stringify({
      protocol: MANAGED_TOOL_PROTOCOL,
      kind: 'tool_call',
      call_id: 'call_1',
      name: 'shell',
      arguments: {},
    }), tools), /unknown or unavailable/);
    assert.throws(() => parseManagedToolDecision(JSON.stringify({
      protocol: MANAGED_TOOL_PROTOCOL,
      kind: 'tool_call',
      call_id: 'call_1',
      name: 'reply_lark_message',
      arguments: {
        message_id: 'om_message123456',
        text: 'answer',
        decision_message_id: 'om_attacker123456',
      },
    }), tools), /daemon-owned|not supported/);
    assert.throws(() => parseManagedToolDecision(JSON.stringify({
      protocol: MANAGED_TOOL_PROTOCOL,
      kind: 'tool_call',
      call_id: 'call_1',
      name: 'reply_lark_message',
      arguments: { message_id: 'short', text: 'answer' },
    }), tools), /invalid format/);
  });

  it('returns bounded tool and protocol result envelopes without binary image data', () => {
    const result = JSON.parse(managedToolResultMessage({
      callId: 'call_1',
      name: 'view_lark_image',
      ok: true,
      result: {
        content: [{ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
        structuredContent: { message_id: 'om_message123456', byte_length: 5 },
      },
    }));
    assert.equal(result.kind, 'tool_result');
    assert.equal(result.result.content[0].type, 'image_metadata');
    assert.equal(result.result.content[0].omitted, true);
    assert.doesNotMatch(JSON.stringify(result), /aW1hZ2U=/);

    const protocolError = JSON.parse(managedProtocolErrorMessage(new Error('bad output')));
    assert.equal(protocolError.kind, 'protocol_error');
    assert.match(protocolError.error, /bad output/);
  });
});

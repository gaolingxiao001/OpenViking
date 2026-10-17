import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assembleConversationPolicy,
  assembleVolcConversationPolicy,
} from '../src/conversation-policy.mjs';

function writePrompt(name, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-'));
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, body);
  return { directory, filePath };
}

const defaultSystemPromptPath = fileURLToPath(new URL('../agent/system-prompt.md', import.meta.url));

describe('conversation policy assemble', () => {
  it('does not tell the agent to suppress final assistant output', () => {
    const text = assembleConversationPolicy({
      systemPromptPath: defaultSystemPromptPath,
    });

    assert.match(text, /Your final answer text, your thinking, and anything printed outside tool calls are internal telemetry/);
    assert.match(text, /The only way any user sees anything is a successful delivery tool call/);
    assert.match(text, /do not call a Lark delivery tool/);
    assert.doesNotMatch(text, /standard agent protocol/);
    assert.doesNotMatch(text, /DELIVERED/);
    assert.doesNotMatch(text, /NO_DELIVERY/);
    assert.doesNotMatch(text, /do nothing and end the turn/);
  });

  it('shares the MCP delivery policy across local runtimes and connector combinations', () => {
    const base = { systemPromptPath: defaultSystemPromptPath };
    const codex = assembleConversationPolicy({ ...base, connectors: ['lark', 'weixin'] });
    assert.match(codex, /`send_message`/);
    assert.match(codex, /never through `lark-cli`/);
    assert.match(codex, /source=weixin/);
    assert.doesNotMatch(codex, /send_lark_message|weixin-cli|Agent tools from bash/);

    const weixin = assembleConversationPolicy({ ...base, connectors: ['weixin'] });
    assert.match(weixin, /# Weixin conversation policy/);
    assert.match(weixin, /`reply_message` with the inbound msg=/);
    assert.match(weixin, /call `get_message_media`/);
    assert.doesNotMatch(weixin, /Agent tools from bash|actions\/cli\.mjs/);
  });

  it('stitches base, OpenViking, optional meeting audio, and harness', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-all-'));
    const files = {
      systemPromptPath: path.join(directory, 'system-prompt.md'),
      openVikingPromptPath: path.join(directory, 'openviking.md'),
      harnessPromptPath: path.join(directory, 'harness.md'),
      meetingAudioPromptPath: path.join(directory, 'meeting-audio.md'),
      openVikingConfigPath: path.join(directory, 'ovcli.conf'),
    };
    fs.writeFileSync(files.systemPromptPath, 'base {{AGENT_NAME}}\n');
    fs.writeFileSync(files.openVikingPromptPath, 'ov via skill and MCP\n');
    fs.writeFileSync(files.harnessPromptPath, 'profile={{LARK_PROFILE}}\n');
    fs.writeFileSync(files.meetingAudioPromptPath, 'meeting-audio plugin\n');
    try {
      const withoutAudio = assembleConversationPolicy({
        ...files,
        agentName: '斯斯',
        profile: 'cli_alpha',
      });
      assert.match(withoutAudio, /base 斯斯/);
      assert.match(withoutAudio, /ov via skill and MCP/);
      assert.match(withoutAudio, /<context-workdir>/);
      assert.match(withoutAudio, /only context workspace/);
      assert.match(withoutAudio, /profile=cli_alpha/);
      assert.doesNotMatch(withoutAudio, /meeting-audio plugin/);

      const withAudio = assembleConversationPolicy({
        ...files,
        agentName: '斯斯',
        profile: 'cli_alpha',
        meetingAudio: {},
      });
      assert.match(withAudio, /meeting-audio plugin/);

      // Without OpenViking configured, no OV section reaches the prompt.
      const withoutOV = assembleConversationPolicy({ ...files, openVikingConfigPath: '', agentName: '斯斯', profile: 'cli_alpha' });
      assert.match(withoutOV, /base 斯斯/);
      assert.match(withoutOV, /profile=cli_alpha/);
      assert.doesNotMatch(withoutOV, /ov via skill and MCP|<context-workdir>/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives Volc inbound grammar plus persona, not the whole markdown file', () => {
    const { directory, filePath } = writePrompt('system-prompt.md', [
      '# Lark conversation policy',
      '',
      '## Message format',
      '',
      'irrelevant filler the Volc policy already covers on its own.',
      '',
      '## Persona and voice',
      '',
      'CANONICAL_PERSONA_MARKER: friendly and terse.',
      '',
    ].join('\n'));
    try {
      const text = assembleVolcConversationPolicy({
        systemPromptPath: filePath,
        agentName: 'Zayn',
      });
      assert.match(text, /Chat input format/);
      assert.match(text, /source=github kind=issue.opened/);
      assert.match(text, /visible @names/);
      assert.match(text, /matching your injected identity/);
      assert.doesNotMatch(text, /mention=me\|other\|mixed/);
      assert.match(text, /## Persona and voice/);
      assert.match(text, /CANONICAL_PERSONA_MARKER/);
      assert.doesNotMatch(text, /irrelevant filler/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('injects the identity the daemon loaded, and nothing without one', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-id-'));
    const files = {
      systemPromptPath: path.join(directory, 'system-prompt.md'),
      openVikingPromptPath: path.join(directory, 'openviking.md'),
      harnessPromptPath: path.join(directory, 'empty.md'),
    };
    fs.writeFileSync(files.systemPromptPath, 'base\n');
    fs.writeFileSync(files.openVikingPromptPath, 'ov plugin\n');
    fs.writeFileSync(files.harnessPromptPath, '');
    try {
      const injected = assembleConversationPolicy({
        ...files,
        openVikingIdentity: { user: 'amy', uri: 'viking://user/amy/identity.md', text: '# I am Alice' },
      });
      assert.match(injected, /OpenViking identity/);
      assert.match(injected, /viking:\/\/user\/amy\/identity\.md/);
      assert.match(injected, /I am Alice/);
      assert.match(injected, /Identity boundary:/);
      assert.ok(
        injected.indexOf('Identity boundary:') > injected.indexOf('I am Alice'),
        'the routing boundary must follow untrusted identity prose',
      );

      for (const openVikingIdentity of [undefined, { user: 'amy', uri: 'viking://user/amy/identity.md', text: '' }]) {
        assert.doesNotMatch(assembleConversationPolicy({ ...files, openVikingIdentity }), /OpenViking identity/);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets Volc degrade when the prompt file is missing', () => {
    const text = assembleVolcConversationPolicy({
      systemPromptPath: '/no/such/file/system-prompt.md',
    });
    assert.match(text, /Chat input format/);
    assert.doesNotMatch(text, /## Persona and voice/);
  });
});

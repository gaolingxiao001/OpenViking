import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  assembleConversationPolicy,
  assembleVolcConversationPolicy,
  loadSystemPrompt,
} from '../src/conversation-policy.mjs';

function writePrompt(name, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-'));
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, body);
  return { directory, filePath };
}

describe('conversation policy assemble', () => {
  it('stitches base, OpenViking, optional meeting audio, and harness', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-all-'));
    const files = {
      systemPromptPath: path.join(directory, 'system-prompt.md'),
      openVikingPromptPath: path.join(directory, 'openviking.md'),
      harnessPromptPath: path.join(directory, 'harness.md'),
      meetingAudioPromptPath: path.join(directory, 'meeting-audio.md'),
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
      assert.match(withoutAudio, /profile=cli_alpha/);
      assert.doesNotMatch(withoutAudio, /meeting-audio plugin/);

      const withAudio = assembleConversationPolicy({
        ...files,
        agentName: '斯斯',
        profile: 'cli_alpha',
        meetingAudio: {},
      });
      assert.match(withAudio, /meeting-audio plugin/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps loadSystemPrompt as the native assemble', () => {
    const { directory, filePath } = writePrompt('system-prompt.md', 'policy {{TEAM_TASK_BOARD_URL}}\n');
    const empty = path.join(directory, 'empty.md');
    fs.writeFileSync(empty, '');
    try {
      const text = loadSystemPrompt({
        systemPromptPath: filePath,
        openVikingPromptPath: empty,
        harnessPromptPath: empty,
        teamTaskBoardUrl: 'https://board.example',
      });
      assert.equal(text, 'policy https://board.example');
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
      assert.match(text, /Lark conversation format/);
      assert.match(text, /## Persona and voice/);
      assert.match(text, /CANONICAL_PERSONA_MARKER/);
      assert.doesNotMatch(text, /irrelevant filler/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('injects OpenViking identity.md into the assembled prompt', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-id-'));
    const files = {
      systemPromptPath: path.join(directory, 'system-prompt.md'),
      openVikingPromptPath: path.join(directory, 'openviking.md'),
      harnessPromptPath: path.join(directory, 'empty.md'),
      openVikingConfigPath: path.join(directory, 'ov.json'),
    };
    fs.writeFileSync(files.systemPromptPath, 'base\n');
    fs.writeFileSync(files.openVikingPromptPath, 'ov plugin\n');
    fs.writeFileSync(files.harnessPromptPath, '');
    fs.writeFileSync(files.openVikingConfigPath, JSON.stringify({ user: 'amy' }));
    try {
      const reads = [];
      const injected = assembleConversationPolicy(files, {
        env: {},
        readResource: (uri) => {
          reads.push(uri);
          return uri === 'viking://user/amy/identity.md' ? '# I am Alice' : '';
        },
      });
      assert.deepEqual(reads, ['viking://user/amy/identity.md']);
      assert.match(injected, /OpenViking identity/);
      assert.match(injected, /viking:\/\/user\/amy\/identity\.md/);
      assert.match(injected, /I am Alice/);

      const fallback = assembleConversationPolicy(files, {
        env: {},
        readResource: (uri) => (uri === 'viking://user/amy/memories/identity.md' ? 'fallback identity' : ''),
      });
      assert.match(fallback, /memories\/identity\.md/);
      assert.match(fallback, /fallback identity/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets Volc degrade when the prompt file is missing', () => {
    const text = assembleVolcConversationPolicy({
      systemPromptPath: '/no/such/file/system-prompt.md',
    });
    assert.match(text, /Lark conversation format/);
    assert.doesNotMatch(text, /## Persona and voice/);
  });
});

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { actionEndpoint, callTool, listTools } from './client.mjs';

// Stdio MCP adapter for runtimes with an MCP client (Codex, Claude). It relays
// tools/list and tools/call to the Core and renders results; nothing else.
const MAX_INLINE_IMAGE_BYTES = 10_000_000;

function imageBlocks(media = []) {
  return media
    .filter((item) => item.mime_type?.startsWith('image/') && item.size <= MAX_INLINE_IMAGE_BYTES)
    .map((item) => ({ type: 'image', data: fs.readFileSync(item.path).toString('base64'), mimeType: item.mime_type }));
}

export function createMcpHandler(endpoint) {
  return async function handle(message) {
    const id = message?.id;
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (id === undefined) return null; // notifications
    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'personal-agent', version: '2.0.0' },
      } };
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: await listTools(endpoint) } };
    }
    if (message.method === 'tools/call') {
      try {
        const result = await callTool(endpoint, message.params?.name, message.params?.arguments ?? {});
        return { jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: result.text }, ...imageBlocks(result.media)],
          structuredContent: result.data,
        } };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true,
        } };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index].replace(/^--/, '')] = argv[index + 1];
  return values;
}

async function serve() {
  const args = parseArgs(process.argv.slice(2));
  const handle = createMcpHandler(actionEndpoint('mcp', {
    PERSONAL_AGENT_SOCKET: args.socket ?? process.env.PERSONAL_AGENT_SOCKET,
    PERSONAL_AGENT_AUTHORITY: args.authority ?? process.env.PERSONAL_AGENT_AUTHORITY,
  }));
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

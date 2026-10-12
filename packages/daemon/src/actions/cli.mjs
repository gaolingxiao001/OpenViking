#!/usr/bin/env node
import { actionEndpoint, callTool, listTools } from './client.mjs';

// The same agent tools for runtimes without an MCP client (Pi). Usage:
//   node cli.mjs <tool> '<json input>'
//   node cli.mjs <tool> <<'JSON'
//   {...}
//   JSON
//   node cli.mjs --list
async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const [tool, inline] = process.argv.slice(2);
  const endpoint = actionEndpoint('cli');
  if (!tool || tool === '--list' || tool === '--help') {
    for (const definition of await listTools(endpoint)) {
      process.stdout.write(`${definition.name}: ${definition.description}\n  input: ${JSON.stringify(definition.inputSchema.properties)}\n`);
    }
    return;
  }
  const raw = inline ?? await readStdin();
  let input;
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch {
    throw new Error('tool input must be one JSON object');
  }
  const result = await callTool(endpoint, tool, input);
  process.stdout.write(`${result.text}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

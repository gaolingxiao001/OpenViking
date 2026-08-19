import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const LARK_DELIVERY_TOOLS = new Set([
  'react_to_lark_message',
  'retract_lark_message',
  'reply_lark_message',
  'send_lark_message',
]);

export function isPiLarkDeliveryToolName(value) {
  return LARK_DELIVERY_TOOLS.has(String(value ?? ''));
}

function loadExtensionConfig(configPath = process.env.PI_LARK_TOOLS_CONFIG) {
  if (!configPath) throw new Error('PI_LARK_TOOLS_CONFIG is required');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('PI_LARK_TOOLS_CONFIG must be a JSON object');
  }
  if (!config.larkToolsModule) throw new Error('PI_LARK_TOOLS_CONFIG.larkToolsModule is required');
  return config;
}

function mcpResultToToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const mapped = content.map((block) => {
    if (!block || typeof block !== 'object') return { type: 'text', text: String(block ?? '') };
    if (block.type === 'image' && typeof block.data === 'string') {
      return {
        type: 'image',
        data: block.data,
        mimeType: block.mimeType || block.mime_type || 'image/png',
      };
    }
    if (typeof block.text === 'string') return { type: 'text', text: block.text };
    return { type: 'text', text: JSON.stringify(block) };
  });
  return {
    content: mapped.length > 0 ? mapped : [{ type: 'text', text: '' }],
    details: result?.structuredContent && typeof result.structuredContent === 'object'
      ? result.structuredContent
      : {},
  };
}

export async function registerLarkPiTools(pi, config, deps = {}) {
  const Type = deps.Type ?? (await import('typebox')).Type;
  const tools = deps.tools ?? await import(pathToFileURL(config.larkToolsModule).href);
  const service = deps.createService?.() ?? new tools.LarkToolService(config.serviceOptions);
  const handle = tools.createMcpHandler(service);
  const toParameters = typeof Type?.Unsafe === 'function'
    ? (schema) => Type.Unsafe(schema)
    : (schema) => schema;

  for (const tool of service.tools ?? []) {
    pi.registerTool({
      name: tool.name,
      label: tool.title || tool.name,
      description: tool.description,
      parameters: toParameters(tool.inputSchema ?? { type: 'object', properties: {} }),
      async execute(_toolCallId, params, signal) {
        if (signal?.aborted) throw new Error('lark tool call was aborted');
        const response = await handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool.name, arguments: params ?? {} },
        });
        const result = response?.result;
        if (!result) throw new Error(response?.error?.message || `lark tool ${tool.name} returned no result`);
        if (result.isError === true) {
          const detail = Array.isArray(result.content)
            ? result.content.map((block) => block?.text).filter(Boolean).join('\n')
            : '';
          throw new Error(detail || `${tool.name} failed`);
        }
        return mcpResultToToolResult(result);
      },
    });
  }

  pi.on('session_shutdown', async () => {
    try { await service.close?.(); } catch {}
  });

  return { service, tools: service.tools ?? [] };
}

export default function piLarkExtension(pi) {
  return registerLarkPiTools(pi, loadExtensionConfig());
}

// The local MCP server's protocol side (desktop, PLAN §131): JSON-RPC messages arrive from the Rust
// shell (src-tauri/src/mcp.rs, one line per message) and are answered from the local database with
// the same tool contracts as the server's /mcp (packages/mcp-contracts). Read tools always; the
// write tools only when the user allowed them on this device (each change approved in the app).
import { READ_TOOLS, toolJsonSchemas } from '@finplat/mcp-contracts';
import { callReadTool, FileResult, type ToolContext, ToolError } from './local-tools.ts';
import { type Approve, callWriteTool, LOCAL_WRITE_TOOLS, type WriteName } from './local-write.ts';

// Protocol errors are for the MCP client, not the UI (not translated).
const PARSE_ERROR = 'parse error';
const NO_METHOD = 'method not found: ';
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Personal finance data on this computer (the Finance Platform desktop app).
Read-only unless the user allowed changes: then each write tool call waits until the user approves
or rejects it in the app (up to 5 minutes; error codes rejected / approval_timeout).
Money is always {amount: decimal string, currency}; never assume floats. Prefer aggregate tools
(get_spending_by_category, get_financial_overview, get_cash_flow_forecast) over listing transactions.
Every result has meta.complete/warnings/missingRates: say so when data is incomplete. profileId defaults
to the profile open in the app. Data you read goes to your AI provider.`;

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

// No proposals locally (each change is approved as it is made): no preview_changes /
// apply_approved_changes.
const schemas = toolJsonSchemas();
const readTools = schemas.filter(
  (t) => READ_TOOLS.includes(t.name) && t.name !== 'preview_changes',
);
const writeTools = schemas.filter((t) => (LOCAL_WRITE_TOOLS as readonly string[]).includes(t.name));
const isWrite = (n: string): n is WriteName => (LOCAL_WRITE_TOOLS as readonly string[]).includes(n);

/** Answers one message; null when no reply is due (notifications, responses). `approve` is set
 * only while the user allows changes on this device: then the write tools exist. */
export async function handleMessage(
  ctx: () => ToolContext,
  line: string,
  approve?: Approve,
): Promise<string | null> {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return reply(null, undefined, { code: -32700, message: PARSE_ERROR });
  }
  if (req.id === undefined || typeof req.method !== 'string') return null;
  const p = req.params ?? {};
  switch (req.method) {
    case 'initialize': {
      const v = String(p.protocolVersion ?? '');
      return reply(req.id, {
        protocolVersion: VERSIONS.includes(v) ? v : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'finance-platform-local', version: '1' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(req.id, {});
    case 'tools/list':
      return reply(req.id, { tools: approve ? [...readTools, ...writeTools] : readTools });
    case 'tools/call':
      return reply(req.id, await callTool(ctx, String(p.name ?? ''), p.arguments, approve));
    default:
      return reply(req.id, undefined, { code: -32601, message: NO_METHOD + req.method });
  }
}

async function callTool(ctx: () => ToolContext, name: string, args: unknown, approve?: Approve) {
  try {
    const res =
      approve && isWrite(name)
        ? await callWriteTool(ctx(), name, args, approve)
        : await callReadTool(ctx(), name, args);
    if (res instanceof FileResult) {
      const text = JSON.stringify(res.result);
      const file = res.mime.startsWith('image/')
        ? { type: 'image', data: res.data, mimeType: res.mime }
        : { type: 'resource', resource: { uri: res.uri, mimeType: res.mime, blob: res.data } };
      return { content: [{ type: 'text', text }, file], structuredContent: res.result };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res };
  } catch (e) {
    // A failed tool is an isError result, never a protocol error, so the model can correct itself.
    const error =
      e instanceof ToolError
        ? { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }
        : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
    const res = { error };
    return {
      content: [{ type: 'text', text: JSON.stringify(res) }],
      structuredContent: res,
      isError: true,
    };
  }
}

function reply(id: Request['id'], result?: unknown, error?: { code: number; message: string }) {
  return JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
}

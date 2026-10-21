// Regenerates apps/api/internal/mcp/tools.json from packages/mcp-contracts (single source of tool
// names, descriptions, scopes and input schemas for the remote and the future local MCP server):
//   scripts/bun.sh run apps/api/internal/mcp/gen/tools.ts
import { writeFileSync } from 'node:fs';
import { TOOLS, type ToolName, toolJsonSchemas } from '../../../../../packages/mcp-contracts/src/index.ts';

const out = toolJsonSchemas().map((t) => ({ ...t, scopes: TOOLS[t.name as ToolName].scopes }));
writeFileSync('apps/api/internal/mcp/tools.json', `${JSON.stringify(out, null, 1)}\n`);

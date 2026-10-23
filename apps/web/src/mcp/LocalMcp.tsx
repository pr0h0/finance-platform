// Local MCP server (desktop, PLAN §131): the Settings card that turns it on and shows how to add it
// to an MCP client, and the listener (mounted in Layout) that answers requests while the app is open.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useData } from '../app/data.tsx';
import { Card, Checkbox, ErrorBox } from '../components/ui/index.tsx';
import { todayIso } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { localMcp, serveLocalMcp, setLocalMcp } from '../platform/native.ts';
import { handleMessage } from './local-server.ts';

/** Answers MCP clients from the open profile (requests made while the app is locked get an error). */
export function LocalMcpListener() {
  const { ds, profile } = useData();
  const ctx = useRef({ ds, profile });
  ctx.current = { ds, profile };
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void serveLocalMcp((line) => {
      const { ds, profile } = ctx.current;
      if (!ds || !profile) throw new Error('no profile open');
      return handleMessage(() => ({ ds, profile, today: todayIso() }), line);
    }).then((un) => {
      if (gone) un();
      else stop = un;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  return null;
}

export function LocalMcpCard() {
  const t = useT();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['native', 'mcp'], queryFn: localMcp });
  const toggle = useMutation({
    mutationFn: setLocalMcp,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['native', 'mcp'] }),
  });
  const cmd = st.data?.command ?? '';
  const json = JSON.stringify(
    { mcpServers: { 'finance-local': { command: cmd, args: ['--mcp'] } } },
    null,
    2,
  );
  return (
    <Card title={t('localMcp.title', 'Local MCP server')}>
      <p className="mb-3 text-sm text-muted">
        {t(
          'localMcp.intro',
          'Lets AI apps on this computer (Claude Desktop, Claude Code, …) read your finances from this app, without a server. Read-only. Works while the app is running and unlocked; what an agent reads goes to its AI provider.',
        )}
      </p>
      <Checkbox
        label={t('localMcp.enable', 'Allow AI apps on this computer to read my data')}
        checked={st.data?.on ?? false}
        disabled={!st.data || toggle.isPending}
        onChange={(e) => toggle.mutate(e.target.checked)}
      />
      <ErrorBox error={toggle.error} />
      {st.data?.on && (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p>{t('localMcp.claudeCode', 'Claude Code:')}</p>
          <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 text-xs">
            {`claude mcp add finance-local -- "${cmd}" --mcp`}
          </pre>
          <p>
            {t(
              'localMcp.config',
              'Other clients (e.g. claude_desktop_config.json in Claude Desktop):',
            )}
          </p>
          <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 text-xs">{json}</pre>
        </div>
      )}
    </Card>
  );
}

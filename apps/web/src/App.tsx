import { useEffect, useState } from 'react';
import { fetchServerStatus, type ServerStatus } from './lib/server-status.ts';

// Phase 0 shell: shows real server connectivity. The web agent replaces this with the app.
export function App() {
  const [status, setStatus] = useState<ServerStatus>({ state: 'checking' });
  useEffect(() => {
    fetchServerStatus().then(setStatus);
  }, []);
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">Finance Platform</h1>
      <p className="mt-4" role="status">
        {status.state === 'checking' && 'Checking server…'}
        {status.state === 'ok' &&
          `Server OK — API ${status.meta.apiVersion}, schema ${status.meta.schemaVersion}`}
        {status.state === 'incompatible' && `Incompatible server: ${status.reason}`}
        {status.state === 'unreachable' && `Server unreachable: ${status.reason}`}
      </p>
    </main>
  );
}

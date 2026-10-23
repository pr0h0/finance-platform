import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import './index.css';
import { restoreKeychainToken } from './app/store.ts';
import { initNative } from './platform/native.ts';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
// Native shell (Tauri): load its bridges (HTTP, OS) before anything talks to a server or a store.
initNative().finally(() => {
  restoreKeychainToken();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

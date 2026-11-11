import React from 'react';
import ReactDOM from 'react-dom/client';
import { ToastProvider } from '@aura/ui';
import { App } from './App';
import './styles/global.css';
import { installCrashRecording } from './diagnostics/crashRecords';

installCrashRecording();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);

// Tell the desktop shell the window has drawn. Without this it reloads a
// window that stays blank, then switches WebKit to software rendering
// (apps/desktop/src-tauri/src/render.rs). Two frames: the first one after
// mounting is the one that paints.
if ('__TAURI_INTERNALS__' in window) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('renderer_ready'))
      .catch(() => undefined);
  }));
}

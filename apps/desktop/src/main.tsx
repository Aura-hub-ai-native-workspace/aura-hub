import React from 'react';
import ReactDOM from 'react-dom/client';
import { ToastProvider } from '@aura/ui';
import { App } from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);

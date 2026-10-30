import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Handle non-fatal network/connack timeouts from third-party MQTT brokers
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    const msg = event?.message || event?.error?.message || '';
    if (typeof msg === 'string' && (msg.includes('connack timeout') || msg.includes('CONNACK'))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      console.warn('[Handled non-fatal error] MQTT connack timeout intercepted:', msg);
      return true;
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reasonMsg = event?.reason?.message || String(event?.reason || '');
    if (typeof reasonMsg === 'string' && (reasonMsg.includes('connack timeout') || reasonMsg.includes('CONNACK'))) {
      event.preventDefault();
      console.warn('[Handled non-fatal rejection] MQTT connack timeout intercepted:', reasonMsg);
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);


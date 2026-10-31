import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Intercept non-fatal network/connack/undefined errors from third-party MQTT brokers and resource loading
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event: any) => {
    // If event is a resource loading error or has undefined/empty error message
    if (!event.error && !event.message) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    const msg = String(event?.message || event?.error?.message || event?.error || '');
    if (
      msg === 'undefined' ||
      msg === '' ||
      msg.includes('connack timeout') ||
      msg.includes('CONNACK') ||
      msg.includes('WebSocket') ||
      msg.includes('Script error')
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      console.warn('[Handled non-fatal error intercepted]:', msg || 'unspecified error event');
      return true;
    }
  }, true);

  window.addEventListener('unhandledrejection', (event: any) => {
    if (!event.reason || event.reason === 'undefined') {
      event.preventDefault();
      return;
    }
    const reasonMsg = String(event?.reason?.message || event?.reason || '');
    if (
      reasonMsg === 'undefined' ||
      reasonMsg === '' ||
      reasonMsg.includes('connack timeout') ||
      reasonMsg.includes('CONNACK') ||
      reasonMsg.includes('WebSocket')
    ) {
      event.preventDefault();
      console.warn('[Handled non-fatal rejection intercepted]:', reasonMsg);
    }
  });

  const prevOnError = window.onerror;
  window.onerror = function (msg, source, lineno, colno, error) {
    const strMsg = String(msg || error?.message || '');
    if (
      !msg ||
      strMsg === 'undefined' ||
      strMsg === '' ||
      strMsg.includes('connack timeout') ||
      strMsg.includes('CONNACK') ||
      strMsg.includes('WebSocket')
    ) {
      return true;
    }
    if (typeof prevOnError === 'function') {
      return prevOnError(msg, source, lineno, colno, error);
    }
    return false;
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);


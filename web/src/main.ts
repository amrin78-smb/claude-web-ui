import './app.css';
import '@xterm/xterm/css/xterm.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { conn } from './lib/connection';

conn.connect();

// Installable as an app (see public/sw.js). Service workers need a secure
// context, which localhost and the HTTPS remote hostname both are; the Vite dev
// server is skipped so it never fights HMR.
if ('serviceWorker' in navigator && location.port !== '5173') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const app = mount(App, { target: document.getElementById('app')! });

export default app;

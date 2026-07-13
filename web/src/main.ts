import './app.css';
import '@xterm/xterm/css/xterm.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { conn } from './lib/connection';

conn.connect();

const app = mount(App, { target: document.getElementById('app')! });

export default app;

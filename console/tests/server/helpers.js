// Shared fixtures for the console server tests. Nothing here listens on
// a port of its own: supertest drives the app, and the backend is a
// fake fetch function that records what the proxy sent.

import argon2 from 'argon2';
import request from 'supertest';

import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';

export const OPERATOR = 'ops@example.com';
export const PASSWORD = 'correct horse battery staple';
export const ORIGIN = 'https://console.example.com';
export const ADMIN_KEY = 'backend-admin-key-for-tests';

let hashPromise;
export function operatorHash() {
  hashPromise ||= argon2.hash(PASSWORD, { type: argon2.argon2id });
  return hashPromise;
}

export async function makeEnv(overrides = {}) {
  return {
    CONSOLE_USERS: JSON.stringify([{ email: OPERATOR, password_hash: await operatorHash() }]),
    CONSOLE_SESSION_SECRET: 's'.repeat(48),
    CONSOLE_PUBLIC_ORIGIN: ORIGIN,
    BACKEND_URL: 'http://backend.internal:8000',
    ADMIN_OPS_KEY: ADMIN_KEY,
    ...overrides,
  };
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// A fake backend: records each call and answers with `respond(url, init)`.
export function fakeBackend(respond = () => jsonResponse({ ok: true })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  return { calls, fetchImpl };
}

export function fakeClock(start = Date.UTC(2026, 10, 8, 12, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

export async function makeApp({ env = {}, backend = fakeBackend(), now = fakeClock(), staticDir } = {}) {
  const config = loadConfig(await makeEnv(env));
  const events = [];
  const audit = (event, fields = {}) => events.push({ event, ...fields });
  const { app } = createApp(config, {
    audit, now, fetchImpl: backend.fetchImpl, staticDir: staticDir || '/nonexistent-console-dist',
  });
  return { app, config, events, backend, now };
}

export function sessionCookie(res) {
  const header = res.headers['set-cookie'] || [];
  const raw = header.find((c) => c.includes('cansee_console=') && !/Expires=Thu, 01 Jan 1970/.test(c));
  return raw ? raw.split(';')[0] : null;
}

export function login(app, { email = OPERATOR, password = PASSWORD, origin = ORIGIN } = {}) {
  const req = request(app).post('/auth/login').set('Content-Type', 'application/json');
  if (origin) req.set('Origin', origin);
  return req.send(JSON.stringify({ email, password }));
}

export async function signedIn(app) {
  const res = await login(app);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return sessionCookie(res);
}

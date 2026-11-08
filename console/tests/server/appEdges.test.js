// Request handling edges in server/app.js that the feature tests do not
// reach: cookie parsing, odd login bodies, the UI fallback and the error
// handler.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { ORIGIN, OPERATOR, login, makeApp, makeEnv, signedIn } from './helpers.js';

function builtUi() {
  const dir = mkdtempSync(path.join(tmpdir(), 'console-dist-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
  return dir;
}

describe('cookie parsing', () => {
  it('skips cookie parts without "=" and finds the session after them', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const res = await request(app).get('/auth/me').set('Cookie', `flag; ${cookie}`);
    expect(res.status).toBe(200);
  });

  it('does not match a cookie whose name only contains the session name', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const value = cookie.split('=').slice(1).join('=');
    const res = await request(app).get('/auth/me').set('Cookie', `x__Host-cansee_console=${value}`);
    expect(res.status).toBe(401);
  });
});

describe('login body shapes', () => {
  it.each(['null', '[]', '"text"', '42'])('refuses the JSON body %s with 400', async (body) => {
    const { app, events } = await makeApp();
    const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
      .set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(400);
    expect(events.filter((e) => e.event.startsWith('login.'))).toHaveLength(0);
  });

  it('refuses a login with no content type', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
      .send(Buffer.from(JSON.stringify({ email: OPERATOR, password: 'x' })));
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Send the login as JSON.' });
  });
});

describe('UI fallback', () => {
  it('answers a same-origin POST to a UI path with 404 JSON, not the page', async () => {
    const { app } = await makeApp({ staticDir: builtUi() });
    const res = await request(app).post('/users').set('Origin', ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });

  it('answers HEAD for a UI path', async () => {
    const { app } = await makeApp({ staticDir: builtUi() });
    const res = await request(app).head('/accounts');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('answers unknown paths with 404 JSON when no UI is built', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/users');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });
});

describe('error handler', () => {
  it('audits a thrown non-Error value and answers a generic 500', async () => {
    const config = loadConfig(await makeEnv());
    const events = [];
    const { app } = createApp(config, {
      audit: (event, fields) => events.push({ event, ...fields }),
      authenticate: async () => {
        throw 'plain string failure';
      },
      staticDir: '/nonexistent-console-dist',
    });
    const res = await login(app);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong.' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'server.error', path: '/auth/login', message: 'plain string failure' }));
  });
});

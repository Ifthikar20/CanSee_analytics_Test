// Session lifetime edges: the idle and absolute limits on both sides of
// the boundary, the sweep, and cookie handling over HTTP.

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '../../server/sessions.js';
import { ORIGIN, OPERATOR, fakeClock, login, makeApp, sessionCookie, signedIn } from './helpers.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function store(now = fakeClock()) {
  return { now, sessions: createSessionStore({ secret: 'x'.repeat(48), idleTimeoutMs: 30 * MINUTE, absoluteTimeoutMs: 8 * HOUR, now }) };
}

const me = (app, cookie) => request(app).get('/auth/me').set('Cookie', cookie);

describe('idle timeout (30 minutes)', () => {
  it('keeps a session idle for exactly 30 minutes', async () => {
    const { app, now } = await makeApp();
    const cookie = await signedIn(app);
    now.advance(30 * MINUTE);
    expect((await me(app, cookie)).status).toBe(200);
  });

  it('ends a session idle for 30 minutes and 1 ms', async () => {
    const { app, now } = await makeApp();
    const cookie = await signedIn(app);
    now.advance(30 * MINUTE + 1);
    expect((await me(app, cookie)).status).toBe(401);
    // Once ended it stays ended, even if the clock were read again at once.
    expect((await me(app, cookie)).status).toBe(401);
  });

  it('measures idleness from the last request, including data requests', async () => {
    const { app, now } = await makeApp();
    const cookie = await signedIn(app);
    now.advance(20 * MINUTE);
    // A data request (here answered by the fake backend) slides the window.
    expect((await request(app).get('/api/overview').set('Cookie', cookie)).status).toBe(200);
    now.advance(20 * MINUTE);
    expect((await me(app, cookie)).status).toBe(200);
  });

  it('does not slide the window on a request that was refused before the session check', async () => {
    const { app, now } = await makeApp();
    const cookie = await signedIn(app);
    now.advance(20 * MINUTE);
    // Cross-origin POST is refused by the origin check, never touching the session.
    await request(app).post('/auth/logout').set('Origin', 'https://evil.example.com').set('Cookie', cookie);
    now.advance(10 * MINUTE + 1);
    expect((await me(app, cookie)).status).toBe(401);
  });
});

describe('absolute timeout (8 hours)', () => {
  it('keeps an active session until exactly 8 hours and ends it 1 ms later', async () => {
    const { app, now } = await makeApp();
    const cookie = await signedIn(app);
    for (let i = 0; i < 16; i += 1) {
      now.advance(30 * MINUTE);
      expect((await me(app, cookie)).status, `after ${(i + 1) * 30} minutes`).toBe(200);
    }
    now.advance(1);
    const res = await me(app, cookie);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie'].join()).toMatch(/__Host-cansee_console=;.*Expires=Thu, 01 Jan 1970/);
  });

  it('starts a fresh 8 hours on a new login', async () => {
    const { app, now } = await makeApp();
    const first = await signedIn(app);
    for (let i = 0; i < 14; i += 1) {
      now.advance(30 * MINUTE);
      expect((await me(app, first)).status).toBe(200);
    }
    // 7 hours in: sign in again from the same browser.
    const second = sessionCookie(await login(app).set('Cookie', first));
    for (let i = 0; i < 6; i += 1) {
      now.advance(30 * MINUTE);
      expect((await me(app, second)).status, `${7 + (i + 1) / 2} hours after the first login`).toBe(200);
    }
    expect((await me(app, first)).status).toBe(401);
  });
});

describe('createSessionStore', () => {
  it('sweeps only expired sessions', () => {
    const { now, sessions } = store();
    const old = sessions.create('a@x.co');
    now.advance(20 * MINUTE);
    const fresh = sessions.create('b@x.co');
    now.advance(10 * MINUTE + 1);
    expect(sessions.size()).toBe(2);
    sessions.sweep();
    expect(sessions.size()).toBe(1);
    expect(sessions.touch(old)).toBeNull();
    expect(sessions.touch(fresh)).toMatchObject({ email: 'b@x.co' });
  });

  it('sweeps a session past the absolute limit even if it was active', () => {
    const { now, sessions } = store();
    const token = sessions.create('a@x.co');
    for (let i = 0; i < 16; i += 1) {
      now.advance(30 * MINUTE);
      expect(sessions.touch(token)).not.toBeNull();
    }
    sessions.sweep();
    expect(sessions.size()).toBe(1);
    now.advance(1);
    sessions.sweep();
    expect(sessions.size()).toBe(0);
  });

  it('keeps each session separate and destroys only the one named', () => {
    const { sessions } = store();
    const a = sessions.create('a@x.co');
    const b = sessions.create('b@x.co');
    expect(a).not.toBe(b);
    sessions.destroy(a);
    expect(sessions.touch(a)).toBeNull();
    expect(sessions.touch(b)).toMatchObject({ email: 'b@x.co' });
    sessions.destroy('not-a-token');
    sessions.destroy(undefined);
    expect(sessions.size()).toBe(1);
  });

  it.each([
    ['not a string', 12345],
    ['empty', ''],
    ['no dot', 'abcdef'],
    ['empty id', '.abcdef'],
    ['empty signature', 'abcdef.'],
    ['too long', `${'a'.repeat(150)}.${'b'.repeat(60)}`],
  ])('rejects a token that is %s', (_why, token) => {
    const { sessions } = store();
    sessions.create('a@x.co');
    expect(sessions.touch(token)).toBeNull();
  });

  it('rejects a valid id with a signature from another secret', () => {
    const now = fakeClock();
    const a = createSessionStore({ secret: 'a'.repeat(48), idleTimeoutMs: MINUTE, absoluteTimeoutMs: HOUR, now });
    const b = createSessionStore({ secret: 'b'.repeat(48), idleTimeoutMs: MINUTE, absoluteTimeoutMs: HOUR, now });
    const token = a.create('a@x.co');
    const [id] = token.split('.');
    const forged = `${id}.${b.create('b@x.co').split('.')[1]}`;
    expect(a.touch(forged)).toBeNull();
    expect(a.touch(token)).not.toBeNull();
  });
});

describe('session cookie over HTTP', () => {
  it('finds the session cookie among other cookies', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const res = await me(app, `theme=dark; ${cookie}; other=1`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(OPERATOR);
  });

  it('ignores a cookie without the __Host- prefix in production', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const value = cookie.split('=').slice(1).join('=');
    expect((await me(app, `cansee_console=${value}`)).status).toBe(401);
  });

  it('does not clear any cookie when none was sent', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('clears the cookie with the same attributes it was set with', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const res = await request(app).post('/auth/logout').set('Origin', ORIGIN).set('Cookie', cookie);
    const cleared = res.headers['set-cookie'].find((c) => c.startsWith('__Host-cansee_console='));
    expect(cleared).toMatch(/;\s*Path=\//);
    expect(cleared).toMatch(/;\s*HttpOnly/);
    expect(cleared).toMatch(/;\s*Secure/);
    expect(cleared).toMatch(/;\s*SameSite=Strict/);
  });

  it('logs out only the session presented', async () => {
    const { app } = await makeApp();
    const a = sessionCookie(await login(app));
    const b = sessionCookie(await login(app));
    await request(app).post('/auth/logout').set('Origin', ORIGIN).set('Cookie', a);
    expect((await me(app, a)).status).toBe(401);
    expect((await me(app, b)).status).toBe(200);
  });

  it('does not audit a logout without a live session', async () => {
    const { app, events } = await makeApp();
    await request(app).post('/auth/logout').set('Origin', ORIGIN).set('Cookie', '__Host-cansee_console=forged.value');
    expect(events.some((e) => e.event === 'logout')).toBe(false);
  });
});

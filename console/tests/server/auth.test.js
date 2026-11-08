import argon2 from 'argon2';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  ORIGIN, OPERATOR, PASSWORD, login, makeApp, sessionCookie, signedIn,
} from './helpers.js';
import { createAuthenticator } from '../../server/auth.js';

describe('POST /auth/login', () => {
  it('signs a valid operator in and sets a hardened session cookie', async () => {
    const { app, events } = await makeApp();
    const res = await login(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: OPERATOR });

    const raw = res.headers['set-cookie'].find((c) => c.startsWith('__Host-cansee_console='));
    expect(raw).toBeTruthy();
    expect(raw).toMatch(/;\s*HttpOnly/i);
    expect(raw).toMatch(/;\s*Secure/i);
    expect(raw).toMatch(/;\s*SameSite=Strict/i);
    expect(raw).toMatch(/;\s*Path=\//i);
    expect(raw).not.toMatch(/Domain=/i);
    expect(res.headers['cache-control']).toBe('no-store');

    expect(events).toContainEqual(expect.objectContaining({ event: 'login.success', operator: OPERATOR, status: 200 }));
  });

  it('accepts the email in any case and with surrounding spaces', async () => {
    const { app } = await makeApp();
    const res = await login(app, { email: `  ${OPERATOR.toUpperCase()} ` });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(OPERATOR);
  });

  it('omits Secure and the __Host- prefix on localhost', async () => {
    const { app } = await makeApp({ env: { CONSOLE_PUBLIC_ORIGIN: 'http://localhost:8080' } });
    const res = await login(app, { origin: 'http://localhost:8080' });
    expect(res.status).toBe(200);
    const raw = res.headers['set-cookie'].find((c) => c.startsWith('cansee_console='));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).not.toMatch(/;\s*Secure/i);
  });

  it('refuses a wrong password with a generic message and no cookie', async () => {
    const { app, events } = await makeApp();
    const res = await login(app, { password: 'wrong password entirely' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Email or password is incorrect.');
    expect(sessionCookie(res)).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({ event: 'login.failure', operator: OPERATOR, status: 401 }));
  });

  it('answers an unknown email exactly like a wrong password', async () => {
    const { app } = await makeApp();
    const wrongPassword = await login(app, { password: 'not the password' });
    const unknown = await login(app, { email: 'stranger@example.com', password: PASSWORD });
    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body).toEqual(wrongPassword.body);
  });

  it('never writes the password to the audit log', async () => {
    const { app, events } = await makeApp();
    await login(app);
    await login(app, { password: 'a-wrong-password-value' });
    const text = JSON.stringify(events);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('a-wrong-password-value');
  });

  it('requires a JSON body', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .type('form')
      .send({ email: OPERATOR, password: PASSWORD });
    expect(res.status).toBe(415);
  });

  it('rejects missing or oversized fields before checking credentials', async () => {
    const { app, events } = await makeApp();
    for (const body of [{}, { email: OPERATOR }, { email: OPERATOR, password: 7 }, { email: 'x'.repeat(300), password: 'p' }]) {
      const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
        .set('Content-Type', 'application/json').send(JSON.stringify(body));
      expect(res.status).toBe(400);
    }
    expect(events.filter((e) => e.event.startsWith('login.'))).toHaveLength(0);
  });

  it('answers malformed JSON with 400 and no stack trace', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
      .set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
  });

  it('issues a new session id on login and drops the one presented', async () => {
    const { app } = await makeApp();
    const first = await signedIn(app);
    const res = await login(app).set('Cookie', first);
    const second = sessionCookie(res);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect((await request(app).get('/auth/me').set('Cookie', first)).status).toBe(401);
    expect((await request(app).get('/auth/me').set('Cookie', second)).status).toBe(200);
  });
});

describe('session', () => {
  it('GET /auth/me requires a session', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /auth/me names the signed-in operator', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(OPERATOR);
  });

  it('rejects a cookie whose signature has been altered', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const tampered = `${cookie.slice(0, -2)}${cookie.endsWith('A') ? 'BB' : 'AA'}`;
    expect((await request(app).get('/auth/me').set('Cookie', tampered)).status).toBe(401);
    const [name, value] = cookie.split('=');
    const [id] = value.split('.');
    expect((await request(app).get('/auth/me').set('Cookie', `${name}=${id}`)).status).toBe(401);
    expect((await request(app).get('/auth/me').set('Cookie', `${name}=garbage.value`)).status).toBe(401);
  });

  it('rejects a cookie signed with a different secret', async () => {
    const a = await makeApp();
    const b = await makeApp({ env: { CONSOLE_SESSION_SECRET: 't'.repeat(48) } });
    const cookie = await signedIn(a.app);
    expect((await request(b.app).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('expires after 30 minutes idle', async () => {
    const { app, now } = await makeApp();
    const cookie = await signedIn(app);
    now.advance(29 * 60 * 1000);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
    now.advance(29 * 60 * 1000);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
    now.advance(30 * 60 * 1000 + 1);
    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie'].join()).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('expires after 8 hours even while active', async () => {
    const { app, now } = await makeApp();
    const cookie = await signedIn(app);
    for (let i = 0; i < 16; i += 1) {
      now.advance(29 * 60 * 1000);
      expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
    }
    now.advance(17 * 60 * 1000);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('logout ends the session and clears the cookie', async () => {
    const { app, events } = await makeApp();
    const cookie = await signedIn(app);
    const res = await request(app).post('/auth/logout').set('Origin', ORIGIN).set('Cookie', cookie);
    expect(res.status).toBe(204);
    const cleared = res.headers['set-cookie'].find((c) => c.startsWith('__Host-cansee_console='));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect(events).toContainEqual(expect.objectContaining({ event: 'logout', operator: OPERATOR }));
  });

  it('logout without a session still succeeds', async () => {
    const { app } = await makeApp();
    expect((await request(app).post('/auth/logout').set('Origin', ORIGIN)).status).toBe(204);
  });
});

describe('createAuthenticator at the production cost', () => {
  it('verifies a default-cost argon2id hash and refuses unknown emails', async () => {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const authenticate = createAuthenticator([{ email: OPERATOR, passwordHash: hash }]);
    expect(await authenticate(OPERATOR, PASSWORD)).toBe(OPERATOR);
    expect(await authenticate(OPERATOR, 'not the password')).toBeNull();
    expect(await authenticate('someone@example.com', PASSWORD)).toBeNull();
  });
});

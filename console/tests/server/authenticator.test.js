// The credential check and the login endpoint's input limits.

import argon2 from 'argon2';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, createAuthenticator, normalizeEmail } from '../../server/auth.js';
import {
  ORIGIN, OPERATOR, PASSWORD, TEST_HASH_OPTIONS, login, makeApp, operatorHash,
} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAuthenticator', () => {
  it('runs exactly one argon2id verification for a known and for an unknown email', async () => {
    const hash = await operatorHash();
    const authenticate = createAuthenticator([{ email: OPERATOR, passwordHash: hash }], { dummyHashOptions: TEST_HASH_OPTIONS });
    const verify = vi.spyOn(argon2, 'verify');

    expect(await authenticate('stranger@example.com', PASSWORD)).toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
    const [dummy, attempted] = verify.mock.calls[0];
    // The unknown email is checked against a real argon2id hash, not skipped.
    expect(dummy.startsWith('$argon2id$')).toBe(true);
    expect(dummy).not.toBe(hash);
    expect(attempted).toBe(PASSWORD);

    verify.mockClear();
    expect(await authenticate(OPERATOR, 'wrong password')).toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]).toEqual([hash, 'wrong password']);
  });

  it('uses the same dummy hash for every unknown email', async () => {
    const authenticate = createAuthenticator([{ email: OPERATOR, passwordHash: await operatorHash() }], { dummyHashOptions: TEST_HASH_OPTIONS });
    const verify = vi.spyOn(argon2, 'verify');
    await authenticate('a@example.com', 'x');
    await authenticate('b@example.com', 'y');
    expect(verify.mock.calls[0][0]).toBe(verify.mock.calls[1][0]);
  });

  it('refuses every password when the stored hash cannot be parsed', async () => {
    // Passes the config prefix check, but argon2.verify throws on it.
    const authenticate = createAuthenticator([{ email: OPERATOR, passwordHash: '$argon2id$not-a-real-hash' }], { dummyHashOptions: TEST_HASH_OPTIONS });
    await expect(authenticate(OPERATOR, PASSWORD)).resolves.toBeNull();
    await expect(authenticate(OPERATOR, '')).resolves.toBeNull();
  });

  it('picks the matching operator among several', async () => {
    const other = await argon2.hash('the other operator password', { ...TEST_HASH_OPTIONS, type: argon2.argon2id });
    const authenticate = createAuthenticator([
      { email: 'first@example.com', passwordHash: other },
      { email: OPERATOR, passwordHash: await operatorHash() },
    ], { dummyHashOptions: TEST_HASH_OPTIONS });
    expect(await authenticate(OPERATOR, PASSWORD)).toBe(OPERATOR);
    expect(await authenticate('first@example.com', 'the other operator password')).toBe('first@example.com');
    // One operator's password does not open another's account.
    expect(await authenticate('first@example.com', PASSWORD)).toBeNull();
  });

  it('normalizes only strings', () => {
    expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co');
    expect(normalizeEmail(42)).toBe('');
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(['a@b.co'])).toBe('');
  });
});

function emailOfLength(n) {
  const domain = '@example.com';
  return `${'a'.repeat(n - domain.length)}${domain}`;
}

describe('POST /auth/login input limits', () => {
  it(`checks an email of exactly ${MAX_EMAIL_LENGTH} characters and refuses one longer unchecked`, async () => {
    expect(MAX_EMAIL_LENGTH).toBe(254);
    const { app, events } = await makeApp();
    const atLimit = await login(app, { email: emailOfLength(254), password: PASSWORD });
    expect(atLimit.status).toBe(401);
    expect(events.filter((e) => e.event === 'login.failure')).toHaveLength(1);

    const over = await login(app, { email: emailOfLength(255), password: PASSWORD });
    expect(over.status).toBe(400);
    expect(over.body).toEqual({ error: 'Enter your email and password.' });
    expect(events.filter((e) => e.event === 'login.failure')).toHaveLength(1);
  });

  it(`checks a password of exactly ${MAX_PASSWORD_LENGTH} characters and refuses one longer unchecked`, async () => {
    expect(MAX_PASSWORD_LENGTH).toBe(1024);
    const { app, events } = await makeApp();
    const atLimit = await login(app, { password: 'p'.repeat(1024) });
    expect(atLimit.status).toBe(401);
    expect(events.filter((e) => e.event === 'login.failure')).toHaveLength(1);

    const over = await login(app, { password: 'p'.repeat(1025) });
    expect(over.status).toBe(400);
    expect(events.filter((e) => e.event === 'login.failure')).toHaveLength(1);
  });

  it('treats an email of only spaces as missing', async () => {
    const { app } = await makeApp();
    expect((await login(app, { email: '   ' })).status).toBe(400);
    expect((await login(app, { password: '' })).status).toBe(400);
  });

  it('refuses a body over 4 kB with 413 and checks nothing', async () => {
    const { app, events } = await makeApp();
    const body = JSON.stringify({ email: OPERATOR, password: PASSWORD, pad: 'x'.repeat(4200) });
    const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
      .set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Bad request.' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(events.filter((e) => e.event.startsWith('login.'))).toHaveLength(0);
  });

  it('accepts a body just under 4 kB', async () => {
    const { app } = await makeApp();
    const body = JSON.stringify({ email: OPERATOR, password: PASSWORD, pad: 'x'.repeat(3900) });
    const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
      .set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(200);
  });

  it('accepts application/json with a charset', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ email: OPERATOR, password: PASSWORD }));
    expect(res.status).toBe(200);
  });

  it('answers 401 with the same body for a known and an unknown email, and audits both', async () => {
    const { app, events } = await makeApp();
    const a = await login(app, { password: 'nope nope nope' });
    const b = await login(app, { email: 'nobody@example.com', password: 'nope nope nope' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(b.headers['set-cookie']).toBeUndefined();
    expect(events.filter((e) => e.event === 'login.failure').map((e) => e.operator))
      .toEqual([OPERATOR, 'nobody@example.com']);
  });
});

describe('GET /auth/me', () => {
  it('reports the idle timeout in seconds', async () => {
    const { app } = await makeApp();
    const res = await login(app);
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const me = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(me.body).toEqual({ email: OPERATOR, idle_timeout_seconds: 1800 });
  });
});

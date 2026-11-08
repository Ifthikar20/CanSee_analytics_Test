import { describe, expect, it } from 'vitest';

import { createLoginLimiter } from '../../server/rateLimit.js';
import { OPERATOR, fakeClock, login, makeApp } from './helpers.js';

const MINUTE = 60 * 1000;

describe('login rate limiting (HTTP)', () => {
  it('locks an email after 5 failures, even for the right password', async () => {
    const { app, events } = await makeApp();
    for (let i = 0; i < 5; i += 1) {
      expect((await login(app, { password: `wrong-${i}-password` })).status).toBe(401);
    }
    const res = await login(app);
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(events).toContainEqual(expect.objectContaining({ event: 'login.rate_limited', operator: OPERATOR, status: 429 }));
  });

  it('lets the operator in once the lock has passed', async () => {
    const { app, now } = await makeApp();
    for (let i = 0; i < 5; i += 1) await login(app, { password: `wrong-${i}-password` });
    expect((await login(app)).status).toBe(429);
    now.advance(MINUTE + 1);
    expect((await login(app)).status).toBe(200);
  });

  it('doubles the lock on each further failure', async () => {
    const { app, now } = await makeApp();
    for (let i = 0; i < 5; i += 1) await login(app, { password: `wrong-${i}-password` });
    now.advance(MINUTE + 1);
    expect((await login(app, { password: 'still-wrong-pass' })).status).toBe(401);
    const res = await login(app);
    expect(res.status).toBe(429);
    const wait = Number(res.headers['retry-after']);
    expect(wait).toBeGreaterThan(60);
    expect(wait).toBeLessThanOrEqual(120);
  });

  it('locks a client IP that fails across many emails', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 20; i += 1) {
      expect((await login(app, { email: `guess${i}@example.com`, password: 'guessing-password' })).status).toBe(401);
    }
    // A fresh email from the same IP is refused before the password is checked.
    expect((await login(app)).status).toBe(429);
  });

  it('cannot be bypassed by firing attempts in parallel', async () => {
    const { app } = await makeApp();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => login(app, { password: `parallel-wrong-${i}` })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
  });

  it('does not trust X-Forwarded-For unless TRUST_PROXY is set', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 20; i += 1) {
      await login(app, { email: `guess${i}@example.com`, password: 'guessing-password' })
        .set('X-Forwarded-For', `10.0.0.${i}`);
    }
    expect((await login(app).set('X-Forwarded-For', '10.9.9.9')).status).toBe(429);
  });
});

describe('createLoginLimiter', () => {
  it('clears an email on success but keeps the IP history', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 2, maxPerIp: 3 });
    limiter.recordFailure('1.1.1.1', 'a@x.co');
    limiter.recordSuccess('a@x.co');
    limiter.recordFailure('1.1.1.1', 'a@x.co');
    expect(limiter.retryAfter('1.1.1.1', 'a@x.co')).toBe(0);
    limiter.recordFailure('1.1.1.1', 'b@x.co');
    expect(limiter.retryAfter('1.1.1.1', 'c@x.co')).toBe(60 * 1000);
    expect(limiter.retryAfter('2.2.2.2', 'c@x.co')).toBe(0);
  });

  it('caps the lock and forgets a key after a quiet window', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 100, maxLockMs: 4 * MINUTE });
    for (let i = 0; i < 10; i += 1) {
      limiter.recordFailure('ip', 'e');
    }
    expect(limiter.retryAfter('ip', 'e')).toBe(4 * MINUTE);
    now.advance(4 * MINUTE + 15 * MINUTE + 1);
    expect(limiter.retryAfter('ip', 'e')).toBe(0);
    limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(MINUTE);
  });
});

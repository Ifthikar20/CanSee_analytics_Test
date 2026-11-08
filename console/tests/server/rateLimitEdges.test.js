// Edges of the failed-login limiter: thresholds at limit-1 and limit,
// lock lengths, the quiet window, the sweep, and parallel attempts.

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { createLoginLimiter } from '../../server/rateLimit.js';
import { ORIGIN, OPERATOR, PASSWORD, fakeClock, login, makeApp, makeEnv } from './helpers.js';

const MINUTE = 60 * 1000;

describe('createLoginLimiter', () => {
  it('uses the documented defaults: 5 per email, 20 per IP, 1 minute first lock', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now });
    for (let i = 0; i < 4; i += 1) limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(0);
    limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(MINUTE);
    expect(limiter.retryAfter('other-ip', 'e')).toBe(MINUTE);
    expect(limiter.retryAfter('ip', 'other-email')).toBe(0);

    for (let i = 0; i < 14; i += 1) limiter.recordFailure('ip', `x${i}`);
    expect(limiter.retryAfter('ip', 'fresh')).toBe(0);
    limiter.recordFailure('ip', 'x-last');
    expect(limiter.retryAfter('ip', 'fresh')).toBe(MINUTE);
  });

  it('doubles each further lock: 1, 2, 4, 8 minutes', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 2, maxPerIp: 1000 });
    limiter.recordFailure('ip', 'e');
    const waits = [];
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure('ip', 'e');
      waits.push(limiter.retryAfter('ip', 'e'));
    }
    expect(waits).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE]);
  });

  it('caps the lock at one hour by default', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1000 });
    for (let i = 0; i < 12; i += 1) limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(60 * MINUTE);
  });

  it('remembers a key during a lock longer than the quiet window', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1000 });
    // Sixth failure: 2^5 minutes = 32 minute lock, longer than the 15 minute window.
    for (let i = 0; i < 6; i += 1) limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(32 * MINUTE);
    now.advance(16 * MINUTE);
    expect(limiter.retryAfter('ip', 'e')).toBe(16 * MINUTE);
  });

  it('keeps the history until the quiet window after the lock has fully passed', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1000 });
    limiter.recordFailure('ip', 'e');
    // Lock ends at 1 minute; exactly 15 minutes later the history still counts.
    now.advance(MINUTE + 15 * MINUTE);
    limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(2 * MINUTE);
  });

  it('forgets the history 1 ms after the quiet window', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1000 });
    limiter.recordFailure('ip', 'e');
    now.advance(MINUTE + 15 * MINUTE + 1);
    limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(MINUTE);
  });

  it('reports the longest lock among the IP and the email', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1 });
    limiter.recordFailure('ip', 'a');
    limiter.recordFailure('ip', 'a');
    // The IP has now failed three times (4 minute lock); email b only once (1 minute).
    limiter.recordFailure('ip', 'b');
    expect(limiter.retryAfter('ip', 'b')).toBe(4 * MINUTE);
    expect(limiter.retryAfter('other', 'b')).toBe(MINUTE);
  });

  it('counts down the remaining lock', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1 });
    limiter.recordFailure('ip', 'e');
    now.advance(45 * 1000);
    expect(limiter.retryAfter('ip', 'e')).toBe(15 * 1000);
    now.advance(15 * 1000);
    expect(limiter.retryAfter('ip', 'e')).toBe(0);
  });

  it('sweep keeps keys that are still locked or recent', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1000 });
    limiter.recordFailure('ip', 'e');
    limiter.sweep();
    expect(limiter.retryAfter('ip', 'e')).toBe(MINUTE);
    now.advance(MINUTE + 10 * MINUTE);
    limiter.sweep();
    limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(2 * MINUTE);
  });

  it('sweep drops keys after the quiet window', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1000 });
    limiter.recordFailure('ip', 'e');
    now.advance(MINUTE + 15 * MINUTE + 1);
    limiter.sweep();
    limiter.recordFailure('ip', 'e');
    expect(limiter.retryAfter('ip', 'e')).toBe(MINUTE);
  });

  it('keeps IP and email keys apart even when the strings collide', () => {
    const now = fakeClock();
    const limiter = createLoginLimiter({ now, maxPerEmail: 1, maxPerIp: 1000 });
    limiter.recordFailure('same', 'same');
    // The email "same" is locked; the IP "same" has one failure of 1000.
    expect(limiter.retryAfter('same', 'other')).toBe(0);
  });
});

describe('login rate limiting edges (HTTP)', () => {
  it('lets the right password in after 4 failures', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 4; i += 1) expect((await login(app, { password: `wrong-${i}-password` })).status).toBe(401);
    expect((await login(app)).status).toBe(200);
  });

  it('a successful login resets the email count', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 4; i += 1) await login(app, { password: `wrong-${i}-password` });
    expect((await login(app)).status).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await login(app, { password: `again-${i}-password` })).status).toBe(401);
    expect((await login(app)).status).toBe(200);
  });

  it('rounds Retry-After up to whole seconds', async () => {
    const { app, now } = await makeApp();
    for (let i = 0; i < 5; i += 1) await login(app, { password: `wrong-${i}-password` });
    now.advance(500);
    const res = await login(app);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    now.advance(59 * 1000);
    expect((await login(app)).headers['retry-after']).toBe('1');
    now.advance(500);
    expect((await login(app)).status).toBe(200);
  });

  it('refuses a locked email without checking the password and without extending the lock', async () => {
    const { app, now, events } = await makeApp();
    for (let i = 0; i < 5; i += 1) await login(app, { password: `wrong-${i}-password` });
    for (let i = 0; i < 3; i += 1) expect((await login(app, { password: 'during-lock-wrong' })).status).toBe(429);
    expect(events.filter((e) => e.event === 'login.failure')).toHaveLength(5);
    now.advance(MINUTE);
    expect((await login(app)).status).toBe(200);
  });

  it('locks the email across client IPs when TRUST_PROXY is set', async () => {
    const { app } = await makeApp({ env: { TRUST_PROXY: '1' } });
    for (let i = 0; i < 5; i += 1) {
      expect((await login(app, { password: `wrong-${i}-password` }).set('X-Forwarded-For', `10.0.0.${i}`)).status).toBe(401);
    }
    expect((await login(app).set('X-Forwarded-For', '10.0.1.1')).status).toBe(429);
    // Another operator email from a fresh address is unaffected.
    expect((await login(app, { email: 'other@example.com', password: PASSWORD }).set('X-Forwarded-For', '10.0.1.2')).status).toBe(401);
  });

  it('keys the IP limit on the forwarded address when TRUST_PROXY is set', async () => {
    const { app } = await makeApp({ env: { TRUST_PROXY: '1' } });
    for (let i = 0; i < 20; i += 1) {
      await login(app, { email: `guess${i}@example.com`, password: 'guessing-password' }).set('X-Forwarded-For', '203.0.113.9');
    }
    expect((await login(app).set('X-Forwarded-For', '203.0.113.9')).status).toBe(429);
    expect((await login(app).set('X-Forwarded-For', '203.0.113.10')).status).toBe(200);
  });

  it('serializes parallel attempts on one email from many IPs', async () => {
    const { app, events } = await makeApp({ env: { TRUST_PROXY: '1' } });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (
      login(app, { password: `parallel-wrong-${i}` }).set('X-Forwarded-For', `198.51.100.${i + 1}`)
    )));
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(events.filter((e) => e.event === 'login.failure').length).toBeLessThanOrEqual(5);
    const inFlight = results.filter((r) => r.body.error === 'A sign-in attempt is already in progress.');
    for (const r of inFlight) expect(r.headers['retry-after']).toBe('1');
  });

  it('frees the in-flight slot after an attempt, so the next one is checked', async () => {
    const { app } = await makeApp();
    expect((await login(app, { password: 'first-wrong-password' })).status).toBe(401);
    expect((await login(app)).status).toBe(200);
  });

  it('frees the in-flight slot when the credential check throws', async () => {
    const config = loadConfig(await makeEnv());
    let calls = 0;
    const events = [];
    const { app } = createApp(config, {
      audit: (event, fields) => events.push({ event, ...fields }),
      authenticate: async () => {
        calls += 1;
        if (calls === 1) throw new Error('argon2 exploded');
        return OPERATOR;
      },
      staticDir: '/nonexistent-console-dist',
    });
    const first = await login(app);
    expect(first.status).toBe(500);
    expect(first.body).toEqual({ error: 'Something went wrong.' });
    expect(JSON.stringify(first.body)).not.toContain('exploded');
    expect(events).toContainEqual(expect.objectContaining({ event: 'server.error', message: 'argon2 exploded' }));
    expect((await login(app)).status).toBe(200);
  });

  it('applies the origin check before the limiter', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 10; i += 1) {
      expect((await login(app, { password: `x-${i}-wrong`, origin: 'https://evil.example.com' })).status).toBe(403);
    }
    expect((await login(app)).status).toBe(200);
  });

  it('a 400 for missing fields does not count as a failure', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).post('/auth/login').set('Origin', ORIGIN)
        .set('Content-Type', 'application/json').send(JSON.stringify({ email: OPERATOR }));
      expect(res.status).toBe(400);
    }
    expect((await login(app)).status).toBe(200);
  });
});

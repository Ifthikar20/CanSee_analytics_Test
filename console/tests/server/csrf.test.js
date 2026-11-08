import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ORIGIN, login, makeApp, signedIn } from './helpers.js';

describe('CSRF origin check', () => {
  it('refuses a login posted from another origin', async () => {
    const { app, events } = await makeApp();
    const res = await login(app, { origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ event: 'csrf.rejected' }));
    expect(events.some((e) => e.event === 'login.success')).toBe(false);
  });

  it('refuses a login with no Origin header', async () => {
    const { app } = await makeApp();
    expect((await login(app, { origin: null })).status).toBe(403);
  });

  it('refuses a look-alike origin', async () => {
    const { app } = await makeApp();
    for (const origin of [`${ORIGIN}.evil.com`, 'http://console.example.com', `${ORIGIN}:444`, 'null']) {
      expect((await login(app, { origin })).status).toBe(403);
    }
  });

  it('refuses a cross-origin logout, leaving the session intact', async () => {
    const { app } = await makeApp();
    const cookie = await signedIn(app);
    const res = await request(app).post('/auth/logout').set('Origin', 'https://evil.example.com').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
  });
});

describe('CSRF origin check on every state-changing method', () => {
  it.each(['put', 'patch', 'delete'])('refuses a cross-origin %s before any route answers', async (method) => {
    const { app, events } = await makeApp();
    const cookie = await signedIn(app);
    for (const path of ['/api/users', '/auth/login', '/auth/logout', '/healthz']) {
      const res = await request(app)[method](path).set('Origin', 'https://evil.example.com').set('Cookie', cookie);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden.' });
    }
    expect(events.filter((e) => e.event === 'csrf.rejected')).toHaveLength(4);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('lets the same-origin POST through and records the refused origin', async () => {
    const { app, events } = await makeApp();
    expect((await login(app)).status).toBe(200);
    await login(app, { origin: 'https://evil.example.com' });
    expect(events).toContainEqual(expect.objectContaining({
      event: 'csrf.rejected', path: '/auth/login', origin: 'https://evil.example.com',
    }));
    await login(app, { origin: null });
    expect(events.at(-1)).toMatchObject({ event: 'csrf.rejected', origin: null });
  });

  it('truncates a very long Origin in the audit log', async () => {
    const { app, events } = await makeApp();
    await login(app, { origin: `https://${'a'.repeat(400)}.example.com` });
    const rejected = events.find((e) => e.event === 'csrf.rejected');
    expect(rejected.origin).toHaveLength(200);
  });

  it('does not apply the check to reads', async () => {
    const { app } = await makeApp();
    expect((await request(app).get('/healthz').set('Origin', 'https://evil.example.com')).status).toBe(200);
    expect((await request(app).options('/healthz').set('Origin', 'https://evil.example.com')).status).not.toBe(403);
  });

  it('uses the localhost origin when that is the public origin', async () => {
    const { app } = await makeApp({ env: { CONSOLE_PUBLIC_ORIGIN: 'http://localhost:8080' } });
    expect((await login(app, { origin: ORIGIN })).status).toBe(403);
    expect((await login(app, { origin: 'http://localhost:8080' })).status).toBe(200);
  });
});

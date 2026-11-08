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

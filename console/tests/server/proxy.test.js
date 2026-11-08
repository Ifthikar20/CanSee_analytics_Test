import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ADMIN_KEY, ORIGIN, OPERATOR, fakeBackend, jsonResponse, makeApp, signedIn } from './helpers.js';

const USERS = { total: 1, limit: 50, offset: 0, rows: [{ id: 'u1', email: 'a@b.co', tokens_total: 1234 }] };

async function setup(respond) {
  const backend = fakeBackend(respond || (() => jsonResponse(USERS)));
  const ctx = await makeApp({ backend });
  const cookie = await signedIn(ctx.app);
  return { ...ctx, cookie };
}

describe('GET /api/* proxy', () => {
  it('requires a session and never calls the backend without one', async () => {
    const backend = fakeBackend();
    const { app } = await makeApp({ backend });
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
    expect(backend.calls).toHaveLength(0);
  });

  it('maps an allowlisted path to the backend internal admin API', async () => {
    const { app, cookie, backend, events } = await setup();
    const res = await request(app).get('/api/users?search=acme&limit=50&offset=100').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(USERS);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].url).toBe(
      'http://backend.internal:8000/api/v1/internal/admin/users/?search=acme&limit=50&offset=100',
    );
    expect(events).toContainEqual(expect.objectContaining({
      event: 'data.request', operator: OPERATOR, path: '/api/users', status: 200,
    }));
  });

  it('accepts a trailing slash and serves overview and accounts', async () => {
    const { app, cookie, backend } = await setup(() => jsonResponse({}));
    for (const path of ['/api/overview', '/api/overview/', '/api/accounts']) {
      expect((await request(app).get(path).set('Cookie', cookie)).status).toBe(200);
    }
    expect(backend.calls.map((c) => c.url)).toEqual([
      'http://backend.internal:8000/api/v1/internal/admin/overview/',
      'http://backend.internal:8000/api/v1/internal/admin/overview/',
      'http://backend.internal:8000/api/v1/internal/admin/accounts/',
    ]);
  });

  it('sends only its own headers: the admin key, never client headers or cookies', async () => {
    const { app, cookie, backend } = await setup();
    await request(app)
      .get('/api/users')
      .set('Cookie', `${cookie}; other=1`)
      .set('Authorization', 'Bearer client-token')
      .set('X-Admin-Key', 'client-supplied-key')
      .set('X-Forwarded-For', '6.6.6.6')
      .set('X-Custom', 'yes');
    const { init } = backend.calls[0];
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers).toEqual({
      accept: 'application/json',
      'user-agent': 'cansee-console',
      'x-admin-key': ADMIN_KEY,
    });
  });

  it('drops query parameters that are not allowlisted', async () => {
    const { app, cookie, backend } = await setup();
    await request(app).get('/api/users?q=x&format=api&debug=1&limit=10&offset[a]=1').set('Cookie', cookie);
    expect(backend.calls[0].url).toBe('http://backend.internal:8000/api/v1/internal/admin/users/?q=x&limit=10');
  });

  it('refuses paths outside the allowlist without calling the backend', async () => {
    const { app, cookie, backend, events } = await setup();
    for (const path of [
      '/api/', '/api/secrets', '/api/users/123', '/api/users/../overview', '/api/%2e%2e/accounts',
      '/api/users%2F..%2Fsecrets', '/api//users', '/api/Users',
    ]) {
      const res = await request(app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(404);
    }
    expect(backend.calls).toHaveLength(0);
    expect(events.some((e) => e.event === 'data.request' && e.status === 404)).toBe(true);
  });

  it('refuses every method other than GET', async () => {
    const { app, cookie, backend } = await setup();
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await request(app)[method]('/api/users').set('Origin', ORIGIN).set('Cookie', cookie);
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET');
    }
    expect(backend.calls).toHaveLength(0);
  });

  it('turns the backend 404 gate into a 502 with a configuration hint', async () => {
    const { app, cookie, events } = await setup(() => jsonResponse({ detail: 'Not found.' }, { status: 404 }));
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('ADMIN_OPS_ALLOWED_CIDRS');
    expect(events).toContainEqual(expect.objectContaining({ event: 'data.request', status: 502 }));
  });

  it('hides backend error bodies behind a generic 502', async () => {
    const { app, cookie } = await setup(() => jsonResponse({ trace: 'secret internals' }, { status: 500 }));
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
  });

  it('passes a backend rate limit through as 429', async () => {
    const { app, cookie } = await setup(() => jsonResponse({}, { status: 429 }));
    expect((await request(app).get('/api/users').set('Cookie', cookie)).status).toBe(429);
  });

  it('does not follow or pass on backend redirects', async () => {
    const { app, cookie } = await setup(
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/' } }),
    );
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.headers.location).toBeUndefined();
  });

  it('answers 504 when the backend times out', async () => {
    const { app, cookie } = await setup(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    expect((await request(app).get('/api/users').set('Cookie', cookie)).status).toBe(504);
  });

  it('applies the configured timeout to the backend request', async () => {
    const backend = fakeBackend((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const { app } = await makeApp({ backend, env: { BACKEND_TIMEOUT_MS: '1000' } });
    const cookie = await signedIn(app);
    const started = Date.now();
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('answers 502 when the backend cannot be reached', async () => {
    const { app, cookie } = await setup(() => {
      throw new TypeError('fetch failed');
    });
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('The backend could not be reached.');
  });

  it('refuses a body that is not JSON', async () => {
    const { app, cookie } = await setup(
      () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.text).not.toContain('<html>');
  });

  it('refuses malformed JSON', async () => {
    const { app, cookie } = await setup(
      () => new Response('{"rows": [', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect((await request(app).get('/api/users').set('Cookie', cookie)).status).toBe(502);
  });
});

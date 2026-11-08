// Edges of the read-only backend proxy: the query allowlist, value
// limits, every backend failure mode and the timeout.

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PATHS, ALLOWED_QUERY, BACKEND_PREFIX, createBackendClient, filterQuery, resolvePath,
} from '../../server/proxy.js';
import { ORIGIN, OPERATOR, fakeBackend, jsonResponse, makeApp, signedIn } from './helpers.js';

const BASE = 'http://backend.internal:8000/api/v1/internal/admin';
const MAX_BODY = 5 * 1024 * 1024;

async function setup(respond, env = {}) {
  const backend = fakeBackend(respond || (() => jsonResponse({ rows: [] })));
  const ctx = await makeApp({ backend, env });
  const cookie = await signedIn(ctx.app);
  const get = (path) => request(ctx.app).get(path).set('Cookie', cookie);
  return { ...ctx, cookie, get };
}

// A response whose body arrives in pieces and stalls until aborted.
function stalledBody(init, firstChunk = '{"rows": [') {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('allowlists', () => {
  it('names exactly the three read-only resources and six query keys', () => {
    expect([...ALLOWED_PATHS].sort()).toEqual(['accounts', 'overview', 'users']);
    expect([...ALLOWED_QUERY].sort()).toEqual(['limit', 'offset', 'page', 'page_size', 'q', 'search']);
    expect(BACKEND_PREFIX).toBe('/api/v1/internal/admin');
  });

  it('passes every allowlisted query key through to the backend', async () => {
    const { get, backend } = await setup();
    await get('/api/accounts?search=a&q=b&limit=10&offset=20&page=3&page_size=25');
    expect(backend.calls[0].url).toBe(`${BASE}/accounts/?search=a&q=b&limit=10&offset=20&page=3&page_size=25`);
  });

  it('keeps a value of exactly 200 characters and drops one of 201', async () => {
    const { get, backend } = await setup();
    await get(`/api/users?search=${'a'.repeat(200)}&q=${'b'.repeat(201)}`);
    expect(backend.calls[0].url).toBe(`${BASE}/users/?search=${'a'.repeat(200)}`);
  });

  it('keeps an empty value', async () => {
    const { get, backend } = await setup();
    await get('/api/users?search=&limit=5');
    expect(backend.calls[0].url).toBe(`${BASE}/users/?search=&limit=5`);
  });

  it('uses the first value of a repeated key', async () => {
    const { get, backend } = await setup();
    await get('/api/users?search=first&search=second&limit=1&limit=999');
    expect(backend.calls[0].url).toBe(`${BASE}/users/?search=first&limit=1`);
  });

  it('re-encodes values, so a client cannot smuggle extra parameters', async () => {
    const { get, backend } = await setup();
    await get('/api/users?search=a%26format%3Dapi%23x');
    const url = new URL(backend.calls[0].url);
    expect([...url.searchParams.keys()]).toEqual(['search']);
    expect(url.searchParams.get('search')).toBe('a&format=api#x');
    expect(url.hash).toBe('');
  });

  it('ignores prototype-looking keys', () => {
    expect(filterQuery({ __proto__: 'x', constructor: 'y', toString: 'z', limit: '5' }).toString()).toBe('limit=5');
    expect(filterQuery(null).toString()).toBe('');
    expect(filterQuery({ limit: ['a', 'b'], offset: [{}] }).toString()).toBe('limit=a');
  });

  it.each([
    ['/users', 'users'],
    ['/users/', 'users'],
    ['/overview', 'overview'],
    ['/accounts/', 'accounts'],
    ['users', null],
    ['/users//', null],
    ['/user', null],
    ['/usersx', null],
    ['/x/users', null],
    ['', null],
    [undefined, null],
    ['/constructor', null],
    ['/__proto__', null],
  ])('resolvePath(%s) is %s', (path, name) => {
    expect(resolvePath(path)).toBe(name);
  });

  it('refuses HEAD on the API as well as writes', async () => {
    const { app, cookie, backend } = await setup();
    const res = await request(app).head('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(405);
    expect(backend.calls).toHaveLength(0);
  });

  it('refuses writes before looking at the session', async () => {
    const { app, backend } = await setup();
    const res = await request(app).post('/api/users').set('Origin', ORIGIN);
    expect(res.status).toBe(405);
    expect(backend.calls).toHaveLength(0);
  });
});

describe('backend answers', () => {
  it('passes the backend JSON through unchanged, numbers included', async () => {
    const body = {
      totals: { tokens: { month: { total: 9007199254740991 }, all_time: { total: 0 } }, cost_usd: { month: '0.012345' } },
      rows: [{ seats_used: 5, seat_limit: -1 }],
    };
    const { get } = await setup(() => jsonResponse(body));
    const res = await get('/api/overview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
  });

  it('accepts a JSON content type in any case and with a charset', async () => {
    const { get } = await setup(() => new Response('{"ok":1}', {
      status: 200, headers: { 'content-type': 'Application/JSON; charset=utf-8' },
    }));
    const res = await get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: 1 });
  });

  it('refuses valid JSON sent with another content type', async () => {
    const { get } = await setup(() => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const res = await get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'The backend answered with something other than JSON.' });
  });

  it('refuses a body with no content type', async () => {
    const { get } = await setup(() => {
      const res = new Response(new TextEncoder().encode('{"ok":1}'), { status: 200 });
      res.headers.delete('content-type');
      return res;
    });
    expect((await get('/api/users')).status).toBe(502);
  });

  it.each([201, 204, 299].map((s) => [s]))('accepts a %s JSON answer as success', async (status) => {
    const { get } = await setup(() => new Response(status === 204 ? null : '{"ok":true}', {
      status, headers: { 'content-type': 'application/json' },
    }));
    const res = await get('/api/users');
    if (status === 204) {
      // No body to pass on: an empty answer is not valid JSON.
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('The backend answered with invalid JSON.');
    } else {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
  });

  it.each([[300], [301], [302], [304], [307], [308]])('treats a %s answer as an error, even with a JSON body', async (status) => {
    const { get } = await setup(() => new Response(status === 304 ? null : '{"rows":[]}', {
      status, headers: { 'content-type': 'application/json', location: 'https://elsewhere.example.com/' },
    }));
    const res = await get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: `The backend answered with an error (${status}).` });
    expect(res.headers.location).toBeUndefined();
  });

  it.each([[400], [401], [403], [500], [503]])('hides a %s answer behind a generic 502', async (status) => {
    const { get } = await setup(() => jsonResponse({ detail: 'internal detail' }, { status }));
    const res = await get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: `The backend answered with an error (${status}).` });
  });

  it('passes a 429 through with its own message', async () => {
    const { get, events } = await setup(() => jsonResponse({}, { status: 429 }));
    const res = await get('/api/users');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'The backend is rate limiting the console. Try again shortly.' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'data.request', status: 429, operator: OPERATOR }));
  });

  it('refuses a body whose declared length is over 5 MB without reading it', async () => {
    const { get } = await setup(() => new Response('{"rows":[]}', {
      status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) },
    }));
    const res = await get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'The backend answer was too large.' });
  });

  it('accepts a body of exactly 5 MB and refuses one byte more', async () => {
    const exact = `"${'a'.repeat(MAX_BODY - 2)}"`;
    const client = (text) => createBackendClient({
      backendUrl: 'http://b', adminKey: 'k', timeoutMs: 1000,
      fetchImpl: async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(client(exact)('users', {})).resolves.toHaveLength(MAX_BODY - 2);
    await expect(client(`${exact} `)('users', {})).rejects.toMatchObject({ status: 502, message: 'The backend answer was too large.' });
  });
});

describe('timeouts and network failures', () => {
  it('stops waiting at the configured timeout, not the default', async () => {
    const backend = fakeBackend((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const { app } = await makeApp({ backend, env: { BACKEND_TIMEOUT_MS: '1000' } });
    const cookie = await signedIn(app);
    const started = Date.now();
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'The backend did not answer in time.' });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });

  it('answers 504 for an AbortError too', async () => {
    const { get } = await setup(() => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const res = await get('/api/users');
    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'The backend did not answer in time.' });
  });

  it('answers 504 when the headers arrive but the body stalls past the timeout', async () => {
    const { get, events } = await setup((_url, init) => stalledBody(init), { BACKEND_TIMEOUT_MS: '1000' });
    const res = await get('/api/users');
    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'The backend did not answer in time.' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'data.request', status: 504 }));
  });

  it('answers 502 "could not be reached" when the connection drops mid-body', async () => {
    const { get } = await setup(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"rows": ['));
        controller.error(new TypeError('terminated'));
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'The backend could not be reached.' });
  });

  it('gives every request its own timeout signal', async () => {
    const { get, backend } = await setup();
    await get('/api/users');
    await get('/api/users');
    expect(backend.calls[0].init.signal).not.toBe(backend.calls[1].init.signal);
    expect(backend.calls[0].init.signal.aborted).toBe(false);
  });

  it('turns an unexpected client error into a generic 502', async () => {
    const { get } = await setup(() => {
      throw new Error('socket hang up with secret detail');
    });
    const res = await get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'The backend could not be reached.' });
  });
});

describe('createBackendClient', () => {
  it('builds the URL from the configured base and the resource name', async () => {
    const calls = [];
    const get = createBackendClient({
      backendUrl: 'https://api.example.com/prefix', adminKey: 'the-key', timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({});
      },
    });
    await get('overview', {});
    await get('users', { limit: '5', other: 'x' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.com/prefix/api/v1/internal/admin/overview/',
      'https://api.example.com/prefix/api/v1/internal/admin/users/?limit=5',
    ]);
    expect(calls[0].init.headers['X-Admin-Key']).toBe('the-key');
  });
});

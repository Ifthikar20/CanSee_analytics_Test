import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, getData, login, setUnauthorizedHandler } from '../../client/src/lib/api.js';
import { safeNext } from '../../client/src/lib/session.js';

function respond(status, body) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('api client', () => {
  it('requests same-origin data and leaves out empty parameters', async () => {
    const fetchMock = respond(200, { rows: [] });
    vi.stubGlobal('fetch', fetchMock);
    await getData('users', { search: 'acme co', q: '', limit: 50, offset: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/users?search=acme+co&limit=50&offset=0');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ Accept: 'application/json' });
  });

  it('reports a lost session to the unauthorized handler', async () => {
    vi.stubGlobal('fetch', respond(401, { error: 'Sign in required.' }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(getData('users')).rejects.toMatchObject({ status: 401, message: 'Sign in required.' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', respond(502, { error: 'The backend could not be reached.' }));
    const err = await getData('overview').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('The backend could not be reached.');
  });

  it('posts the login as JSON', async () => {
    const fetchMock = respond(200, { email: 'ops@example.com' });
    vi.stubGlobal('fetch', fetchMock);
    await login('ops@example.com', 'pw');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/auth/login');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ email: 'ops@example.com', password: 'pw' });
  });
});

describe('safeNext', () => {
  it('only allows same-site paths after login', () => {
    expect(safeNext('/users?q=a')).toBe('/users?q=a');
    expect(safeNext('//evil.example.com')).toBe('/');
    expect(safeNext('/\\evil.example.com')).toBe('/');
    expect(safeNext('https://evil.example.com')).toBe('/');
    expect(safeNext('/login')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});

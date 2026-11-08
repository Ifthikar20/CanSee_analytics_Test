import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { makeApp } from './helpers.js';

function builtUi() {
  const dir = mkdtempSync(path.join(tmpdir(), 'console-dist-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
  writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  return dir;
}

describe('security headers', () => {
  it('sets a strict CSP and related headers', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sends HSTS only when the public origin is https', async () => {
    const https = await makeApp();
    expect((await request(https.app).get('/healthz')).headers['strict-transport-security']).toMatch(/max-age=\d+/);
    const local = await makeApp({ env: { CONSOLE_PUBLIC_ORIGIN: 'http://localhost:8080' } });
    expect((await request(local.app).get('/healthz')).headers['strict-transport-security']).toBeUndefined();
  });

  it('never lets auth or data responses be cached', async () => {
    const { app } = await makeApp();
    expect((await request(app).get('/auth/me')).headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/users')).headers['cache-control']).toBe('no-store');
  });

  it('answers unknown auth routes with 404 JSON', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/auth/other');
    expect(res.status).toBe(404);
  });
});

describe('static UI', () => {
  it('serves index.html for app routes and hashed assets with long caching', async () => {
    const { app } = await makeApp({ staticDir: builtUi() });
    const page = await request(app).get('/users');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="app"');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");

    const asset = await request(app).get('/assets/index-abc.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    expect((await request(app).get('/assets/missing.js')).status).toBe(404);
  });

  it('does not answer API paths with the UI', async () => {
    const { app } = await makeApp({ staticDir: builtUi() });
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

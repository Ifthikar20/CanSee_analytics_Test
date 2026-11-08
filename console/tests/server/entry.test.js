// The entry point (server/index.js) and the audit logger. The entry point
// is imported with createApp replaced by a stub whose listen() only
// records its arguments, so no socket is ever opened.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuditLogger } from '../../server/audit.js';
import { makeEnv } from './helpers.js';

const REQUIRED = ['CONSOLE_USERS', 'CONSOLE_SESSION_SECRET', 'ADMIN_OPS_KEY', 'BACKEND_URL', 'CONSOLE_PUBLIC_ORIGIN'];
const OPTIONAL = ['PORT', 'HOST', 'BACKEND_TIMEOUT_MS', 'TRUST_PROXY'];

function stubApp() {
  const server = { close: vi.fn((cb) => cb && cb()) };
  const app = { listen: vi.fn(() => server) };
  const sessions = { sweep: vi.fn() };
  const limiter = { sweep: vi.fn() };
  const createApp = vi.fn(() => ({ app, sessions, limiter }));
  return { server, app, sessions, limiter, createApp };
}

let signalHandlers;
let stderr;
let stdout;

beforeEach(() => {
  vi.resetModules();
  for (const name of [...REQUIRED, ...OPTIONAL]) vi.stubEnv(name, '');
  // Fake timers: the shutdown fallback timer and the sweeper never fire
  // on their own, so a restored process.exit can never be reached.
  vi.useFakeTimers();
  signalHandlers = {};
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, fn) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      signalHandlers[event] = fn;
      return process;
    }
    return realOn(event, fn);
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.doUnmock('../../server/app.js');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function importEntry(stub) {
  vi.doMock('../../server/app.js', () => ({ createApp: stub.createApp }));
  return import('../../server/index.js');
}

describe('server/index.js', () => {
  it('refuses to start without the required environment, listing every problem', async () => {
    const stub = stubApp();
    await expect(importEntry(stub)).rejects.toThrow('process.exit(1)');
    const written = stderr.mock.calls.map((c) => c[0]).join('');
    for (const name of REQUIRED) expect(written).toContain(name);
    expect(stub.createApp).not.toHaveBeenCalled();
    expect(stub.app.listen).not.toHaveBeenCalled();
  });

  it.each(REQUIRED)('refuses to start when only %s is missing', async (missing) => {
    const env = await makeEnv();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, k === missing ? '' : v);
    const stub = stubApp();
    await expect(importEntry(stub)).rejects.toThrow('process.exit(1)');
    expect(stderr.mock.calls.map((c) => c[0]).join('')).toContain(missing);
    expect(stub.app.listen).not.toHaveBeenCalled();
  });

  it('refuses to start with an invalid optional setting', async () => {
    const env = await makeEnv({ PORT: '70000' });
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const stub = stubApp();
    await expect(importEntry(stub)).rejects.toThrow('process.exit(1)');
    expect(stderr.mock.calls.map((c) => c[0]).join('')).toContain('PORT must be an integer between 1 and 65535.');
  });

  it('with a complete environment, listens on the configured host and port with request timeouts', async () => {
    const env = await makeEnv({ PORT: '9123', HOST: '127.0.0.2' });
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const stub = stubApp();
    await importEntry(stub);
    expect(stub.createApp).toHaveBeenCalledTimes(1);
    const [config] = stub.createApp.mock.calls[0];
    expect(config).toMatchObject({ port: 9123, host: '127.0.0.2', publicOrigin: 'https://console.example.com' });
    expect(stub.app.listen).toHaveBeenCalledWith(9123, '127.0.0.2', expect.any(Function));
    expect(stub.server.headersTimeout).toBe(20 * 1000);
    expect(stub.server.requestTimeout).toBe(30 * 1000);
    expect(process.exit).not.toHaveBeenCalled();

    // The listen callback logs one JSON start line.
    stub.app.listen.mock.calls[0][2]();
    const line = stdout.mock.calls.map((c) => c[0]).find((l) => l.includes('server.start'));
    expect(JSON.parse(line)).toMatchObject({ event: 'server.start', host: '127.0.0.2', port: 9123 });
    expect(line.endsWith('\n')).toBe(true);
  });

  it('sweeps expired sessions and limiter entries every minute', async () => {
    const env = await makeEnv();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const stub = stubApp();
    await importEntry(stub);
    vi.advanceTimersByTime(59 * 1000);
    expect(stub.sessions.sweep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(stub.sessions.sweep).toHaveBeenCalledTimes(1);
    expect(stub.limiter.sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 1000);
    expect(stub.sessions.sweep).toHaveBeenCalledTimes(2);
    expect(stub.limiter.sweep).toHaveBeenCalledTimes(2);
  });

  it('closes the server on SIGTERM and SIGINT', async () => {
    const env = await makeEnv();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const stub = stubApp();
    stub.server.close = vi.fn();
    await importEntry(stub);
    expect(Object.keys(signalHandlers)).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT']));
    signalHandlers.SIGTERM();
    expect(stub.server.close).toHaveBeenCalledTimes(1);
    signalHandlers.SIGINT();
    expect(stub.server.close).toHaveBeenCalledTimes(2);
    // If close never calls back, a 5 second fallback still exits.
    expect(() => vi.advanceTimersByTime(5000)).toThrow('process.exit(0)');
  });

  it('exits 0 once the server has closed', async () => {
    const env = await makeEnv();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const stub = stubApp();
    await importEntry(stub);
    expect(() => signalHandlers.SIGTERM()).toThrow('process.exit(0)');
  });

  it('rethrows an error that is not a configuration problem', async () => {
    vi.doMock('../../server/config.js', async (importOriginal) => ({
      ...(await importOriginal()),
      loadConfig: () => {
        throw new RangeError('unexpected');
      },
    }));
    try {
      await expect(importEntry(stubApp())).rejects.toThrow('unexpected');
      expect(process.exit).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../server/config.js');
    }
  });
});

describe('createAuditLogger', () => {
  it('writes one JSON line with a timestamp, the event and its fields', () => {
    const lines = [];
    const audit = createAuditLogger((line) => lines.push(line));
    const before = Date.now();
    audit('login.failure', { operator: 'a@b.co', ip: '1.2.3.4', status: 401 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ event: 'login.failure', operator: 'a@b.co', ip: '1.2.3.4', status: 401 });
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
    expect(Date.parse(entry.ts)).toBeGreaterThanOrEqual(before - 1000);
    expect(lines[0]).not.toContain('\n');
  });

  it('works without fields', () => {
    const lines = [];
    createAuditLogger((line) => lines.push(line))('logout');
    expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(['event', 'ts']);
  });

  it('writes to stdout with a trailing newline by default', () => {
    createAuditLogger()('server.error', { message: 'x' });
    expect(stdout).toHaveBeenCalledTimes(1);
    const [line] = stdout.mock.calls[0];
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toMatchObject({ event: 'server.error', message: 'x' });
  });
});

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../server/config.js';
import { makeEnv } from './helpers.js';

function problemsFor(env) {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err.problems;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('refuses an empty environment and lists every missing variable', () => {
    const problems = problemsFor({});
    const text = problems.join('\n');
    for (const name of ['CONSOLE_USERS', 'CONSOLE_SESSION_SECRET', 'ADMIN_OPS_KEY', 'BACKEND_URL', 'CONSOLE_PUBLIC_ORIGIN']) {
      expect(text).toContain(name);
    }
  });

  it('accepts a complete environment', async () => {
    const config = loadConfig(await makeEnv());
    expect(config.operators).toHaveLength(1);
    expect(config.backendUrl).toBe('http://backend.internal:8000');
    expect(config.publicOrigin).toBe('https://console.example.com');
    expect(config.secureCookies).toBe(true);
    expect(config.https).toBe(true);
    expect(config.idleTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.absoluteTimeoutMs).toBe(8 * 60 * 60 * 1000);
    expect(config.trustProxy).toBe(false);
    expect(config.host).toBe('127.0.0.1');
  });

  it('requires a session secret of at least 32 characters', async () => {
    const problems = problemsFor(await makeEnv({ CONSOLE_SESSION_SECRET: 'x'.repeat(31) }));
    expect(problems.join()).toContain('CONSOLE_SESSION_SECRET');
  });

  it('rejects CONSOLE_USERS that is not a JSON list of argon2id operators', async () => {
    expect(problemsFor(await makeEnv({ CONSOLE_USERS: 'not json' })).join()).toContain('not valid JSON');
    expect(problemsFor(await makeEnv({ CONSOLE_USERS: '[]' })).join()).toContain('non-empty');
    expect(
      problemsFor(await makeEnv({ CONSOLE_USERS: '[{"email":"a@b.co","password_hash":"plaintext"}]' })).join(),
    ).toContain('argon2id');
    expect(
      problemsFor(await makeEnv({ CONSOLE_USERS: '[{"email":"nope","password_hash":"$argon2id$x"}]' })).join(),
    ).toContain('email');
  });

  it('rejects the same operator twice', async () => {
    const env = await makeEnv();
    const [op] = JSON.parse(env.CONSOLE_USERS);
    env.CONSOLE_USERS = JSON.stringify([op, { ...op, email: op.email.toUpperCase() }]);
    expect(problemsFor(env).join()).toContain('more than once');
  });

  it('requires https for a public origin that is not localhost', async () => {
    expect(problemsFor(await makeEnv({ CONSOLE_PUBLIC_ORIGIN: 'http://console.example.com' })).join())
      .toContain('https');
  });

  it('allows plain http on localhost and then does not mark cookies Secure', async () => {
    const config = loadConfig(await makeEnv({ CONSOLE_PUBLIC_ORIGIN: 'http://localhost:8080' }));
    expect(config.secureCookies).toBe(false);
    expect(config.https).toBe(false);
    expect(config.publicOrigin).toBe('http://localhost:8080');
  });

  it('validates numeric and proxy settings', async () => {
    expect(problemsFor(await makeEnv({ PORT: 'abc' })).join()).toContain('PORT');
    expect(problemsFor(await makeEnv({ BACKEND_TIMEOUT_MS: '5' })).join()).toContain('BACKEND_TIMEOUT_MS');
    expect(problemsFor(await makeEnv({ TRUST_PROXY: 'true' })).join()).toContain('TRUST_PROXY');
    expect(loadConfig(await makeEnv({ TRUST_PROXY: '1' })).trustProxy).toBe(1);
  });

  it('rejects a backend URL that is not http(s)', async () => {
    expect(problemsFor(await makeEnv({ BACKEND_URL: 'file:///etc/passwd' })).join()).toContain('BACKEND_URL');
  });
});

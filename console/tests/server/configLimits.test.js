// Boundaries of loadConfig: every limit is checked on both sides, and the
// defaults the README documents are asserted as values.

import { describe, expect, it } from 'vitest';

import { ConfigError, MIN_SECRET_LENGTH, loadConfig } from '../../server/config.js';
import { OPERATOR, login, makeApp, makeEnv, operatorHash } from './helpers.js';

function problemsFor(env) {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err.problems;
  }
  throw new Error('expected loadConfig to throw');
}

describe('CONSOLE_SESSION_SECRET', () => {
  it('accepts a secret of exactly the minimum length', async () => {
    expect(MIN_SECRET_LENGTH).toBe(32);
    const config = loadConfig(await makeEnv({ CONSOLE_SESSION_SECRET: 'k'.repeat(32) }));
    expect(config.sessionSecret).toBe('k'.repeat(32));
  });

  it('refuses one character less', async () => {
    expect(problemsFor(await makeEnv({ CONSOLE_SESSION_SECRET: 'k'.repeat(31) })))
      .toEqual(['CONSOLE_SESSION_SECRET is required and must be at least 32 characters.']);
  });
});

describe('CONSOLE_USERS password hashes', () => {
  it.each([
    ['argon2i', '$argon2i$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo'],
    ['argon2d', '$argon2d$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuuJ0123456789abcdefghijklmnopqrst'],
    ['plain sha256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['empty', ''],
  ])('refuses a %s hash: only argon2id is accepted', (_kind, hash) => {
    const problems = problemsFor({
      ...{ CONSOLE_SESSION_SECRET: 's'.repeat(48), ADMIN_OPS_KEY: 'k' },
      BACKEND_URL: 'http://backend.internal:8000',
      CONSOLE_PUBLIC_ORIGIN: 'https://console.example.com',
      CONSOLE_USERS: JSON.stringify([{ email: 'a@b.co', password_hash: hash }]),
    });
    expect(problems).toEqual([
      'CONSOLE_USERS[0].password_hash must be an argon2id hash (generate one with npm run hash-password).',
    ]);
  });

  it('refuses an entry that is not an object, naming its index', async () => {
    const env = await makeEnv();
    const [op] = JSON.parse(env.CONSOLE_USERS);
    env.CONSOLE_USERS = JSON.stringify([op, null]);
    expect(problemsFor(env)).toEqual(['CONSOLE_USERS[1].email is missing or not an email address.']);
  });

  it('refuses a JSON object that is not a list', async () => {
    expect(problemsFor(await makeEnv({ CONSOLE_USERS: '{"email":"a@b.co"}' })))
      .toEqual(['CONSOLE_USERS must be a non-empty JSON list.']);
  });

  it('stores operator emails trimmed and lower-cased, so they can sign in', async () => {
    const hash = await operatorHash();
    const env = await makeEnv({ CONSOLE_USERS: JSON.stringify([{ email: `  ${OPERATOR.toUpperCase()}  `, password_hash: hash }]) });
    const config = loadConfig(env);
    expect(config.operators).toEqual([{ email: OPERATOR, passwordHash: hash }]);
    const { app } = await makeApp({ env: { CONSOLE_USERS: env.CONSOLE_USERS } });
    const res = await login(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: OPERATOR });
  });

  it('treats the same email with spaces as a duplicate', async () => {
    const env = await makeEnv();
    const [op] = JSON.parse(env.CONSOLE_USERS);
    env.CONSOLE_USERS = JSON.stringify([op, { ...op, email: ` ${op.email} ` }]);
    expect(problemsFor(env)).toEqual([`CONSOLE_USERS lists ${OPERATOR} more than once.`]);
  });
});

describe('CONSOLE_PUBLIC_ORIGIN', () => {
  it.each(['http://127.0.0.1:8080', 'http://[::1]:8080', 'http://localhost'])(
    'allows plain http on the loopback host %s without Secure cookies',
    async (origin) => {
      const config = loadConfig(await makeEnv({ CONSOLE_PUBLIC_ORIGIN: origin }));
      expect(config.secureCookies).toBe(false);
      expect(config.https).toBe(false);
      expect(config.publicOrigin).toBe(new URL(origin).origin);
    },
  );

  it.each(['http://localhost.evil.com', 'http://127.0.0.1.nip.io', 'http://10.0.0.5', 'http://console.example.com'])(
    'requires https for %s, which only looks local',
    async (origin) => {
      expect(problemsFor(await makeEnv({ CONSOLE_PUBLIC_ORIGIN: origin })))
        .toEqual(['CONSOLE_PUBLIC_ORIGIN must use https unless it is localhost.']);
    },
  );

  it('keeps only the origin of a URL with a path', async () => {
    const config = loadConfig(await makeEnv({ CONSOLE_PUBLIC_ORIGIN: 'https://console.example.com/some/path?x=1' }));
    expect(config.publicOrigin).toBe('https://console.example.com');
    expect(config.secureCookies).toBe(true);
  });

  it('refuses a value that is not a URL', async () => {
    expect(problemsFor(await makeEnv({ CONSOLE_PUBLIC_ORIGIN: 'console.example.com' })))
      .toEqual(['CONSOLE_PUBLIC_ORIGIN is not a valid URL.']);
  });
});

describe('numeric settings', () => {
  it('defaults PORT to 8080 and BACKEND_TIMEOUT_MS to 10000', async () => {
    const config = loadConfig(await makeEnv());
    expect(config.port).toBe(8080);
    expect(config.backendTimeoutMs).toBe(10000);
  });

  it.each([
    ['PORT', '1', 1],
    ['PORT', '65535', 65535],
    ['BACKEND_TIMEOUT_MS', '1000', 1000],
    ['BACKEND_TIMEOUT_MS', '60000', 60000],
  ])('accepts %s=%s (an edge of the range)', async (name, raw, value) => {
    const config = loadConfig(await makeEnv({ [name]: raw }));
    expect(name === 'PORT' ? config.port : config.backendTimeoutMs).toBe(value);
  });

  it.each([
    ['PORT', '0', 'PORT must be an integer between 1 and 65535.'],
    ['PORT', '65536', 'PORT must be an integer between 1 and 65535.'],
    ['PORT', '80.5', 'PORT must be an integer between 1 and 65535.'],
    ['BACKEND_TIMEOUT_MS', '999', 'BACKEND_TIMEOUT_MS must be an integer between 1000 and 60000.'],
    ['BACKEND_TIMEOUT_MS', '60001', 'BACKEND_TIMEOUT_MS must be an integer between 1000 and 60000.'],
  ])('refuses %s=%s (just outside the range)', async (name, raw, message) => {
    expect(problemsFor(await makeEnv({ [name]: raw }))).toEqual([message]);
  });

  it('reads HOST from the environment', async () => {
    expect(loadConfig(await makeEnv({ HOST: '0.0.0.0' })).host).toBe('0.0.0.0');
  });
});

describe('TRUST_PROXY', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', 0],
    ['2', 2],
    ['loopback', 'loopback'],
    ['uniquelocal', 'uniquelocal'],
    ['linklocal', 'linklocal'],
  ])('reads %s as %s', async (raw, value) => {
    const env = await makeEnv();
    if (raw !== undefined) env.TRUST_PROXY = raw;
    expect(loadConfig(env).trustProxy).toBe(value);
  });

  it.each(['true', '*', '10.0.0.0/8', '-1'])('refuses %s', async (raw) => {
    expect(problemsFor(await makeEnv({ TRUST_PROXY: raw })))
      .toEqual(['TRUST_PROXY must be a hop count (for example 1), loopback, or false.']);
  });
});

describe('BACKEND_URL', () => {
  it('drops trailing slashes and keeps a path prefix', async () => {
    expect(loadConfig(await makeEnv({ BACKEND_URL: 'https://api.example.com/' })).backendUrl)
      .toBe('https://api.example.com');
    expect(loadConfig(await makeEnv({ BACKEND_URL: 'https://api.example.com/prefix//' })).backendUrl)
      .toBe('https://api.example.com/prefix');
  });
});

describe('ConfigError', () => {
  it('reports every problem at once in its message', () => {
    const err = (() => {
      try {
        return loadConfig({ PORT: 'x' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.name).toBe('ConfigError');
    expect(err.problems).toHaveLength(6);
    for (const problem of err.problems) expect(err.message).toContain(problem);
    expect(err.message.startsWith('Invalid console configuration:\n  - ')).toBe(true);
  });
});

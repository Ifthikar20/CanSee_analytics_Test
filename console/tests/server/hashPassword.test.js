import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { MIN_PASSWORD_LENGTH, hashPassword } from '../../scripts/hash-password.js';

describe('hash-password script', () => {
  it('produces an argon2id hash the server accepts', async () => {
    const hash = await hashPassword('a long operator password');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(hash, 'a long operator password')).toBe(true);
    expect(await argon2.verify(hash, 'another password')).toBe(false);
  });

  it(`refuses passwords shorter than ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(() => hashPassword('short')).toThrow(/at least/);
  });
});

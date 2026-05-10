import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../db.js';
import {
  createUser,
  seedRbacData,
  validateCredentials,
} from './user-service.js';

describe('user-service', () => {
  beforeEach(async () => {
    _initTestDatabase();
    await seedRbacData();
  });

  it('grants admin to the first user and defaults the password to admin123', async () => {
    const user = await createUser({ username: 'alice', password: 'admin123' });

    expect(user.roles).toContain('admin');

    const auth = await validateCredentials('alice', 'admin123');
    expect(auth?.roles).toContain('admin');
    expect(auth?.permissions).toContain('system.users');
  });

  it('keeps later users non-admin by default while still using admin123 when omitted', async () => {
    await createUser({ username: 'alice', password: 'admin123' });
    const user = await createUser({ username: 'bob', password: 'admin123' });

    expect(user.roles).toEqual([]);

    const auth = await validateCredentials('bob', 'admin123');
    expect(auth?.roles).toEqual([]);
  });
});

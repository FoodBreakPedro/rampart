import { describe, it, expect } from 'vitest';
import { forTenant } from '../lib/db';

describe('forTenant', () => {
  it('returns a scoped query helper', () => {
    expect(typeof forTenant('org_1').query).toBe('function');
  });
});

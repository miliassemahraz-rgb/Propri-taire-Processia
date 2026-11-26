import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@processia/ai', () => {
  it('expose le squelette du paquet', () => {
    expect(PACKAGE_NAME).toBe('@processia/ai');
  });
});

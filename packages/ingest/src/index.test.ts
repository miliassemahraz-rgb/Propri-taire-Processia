import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@processia/ingest', () => {
  it('expose le squelette du paquet', () => {
    expect(PACKAGE_NAME).toBe('@processia/ingest');
  });
});

import { describe, expect, it } from 'vitest';

import {
  _advanceLastTimestamp,
  _getLastTimestamp,
  _setLastTimestamp,
} from './index.js';

describe('realtime dispatch timestamp', () => {
  it('advances the seen cursor monotonically', () => {
    _setLastTimestamp('2024-01-01T00:00:05.000Z');

    _advanceLastTimestamp('2024-01-01T00:00:04.000Z');
    expect(_getLastTimestamp()).toBe('2024-01-01T00:00:05.000Z');

    _advanceLastTimestamp('2024-01-01T00:00:06.000Z');
    expect(_getLastTimestamp()).toBe('2024-01-01T00:00:06.000Z');
  });
});

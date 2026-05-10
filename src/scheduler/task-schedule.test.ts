import { describe, expect, it } from 'vitest';

import {
  computeInitialNextRun,
  normalizeScheduleValue,
} from './task-schedule.js';

describe('task schedule helpers', () => {
  it('normalizes positive interval values', () => {
    expect(normalizeScheduleValue('interval', '300000')).toBe('300000');
  });

  it('rejects zoned once timestamps', () => {
    expect(() =>
      normalizeScheduleValue('once', '2026-03-08T21:00:00Z'),
    ).toThrow(/timezone suffix/);
  });

  it('computes initial next run for once task', () => {
    const next = computeInitialNextRun('once', '2026-03-08T21:00:00');
    expect(Number.isNaN(new Date(next).getTime())).toBe(false);
  });
});

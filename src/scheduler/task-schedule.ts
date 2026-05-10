import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import type { ScheduledTask } from '../types.js';

export function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, {
      tz: TIMEZONE,
    });
    const next = interval.next().toISOString();
    if (!next) throw new Error('Invalid cron expression');
    return next;
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (Number.isNaN(ms) || ms <= 0) {
      throw new Error('Invalid interval milliseconds');
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const scheduled = new Date(scheduleValue);
  if (Number.isNaN(scheduled.getTime())) {
    throw new Error('Invalid local timestamp');
  }
  return scheduled.toISOString();
}

export function normalizeScheduleValue(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string {
  const value = scheduleValue.trim();

  if (scheduleType === 'cron') {
    CronExpressionParser.parse(value, { tz: TIMEZONE });
    return value;
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(value, 10);
    if (Number.isNaN(ms) || ms <= 0) {
      throw new Error('Interval must be positive milliseconds');
    }
    return String(ms);
  }

  if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    throw new Error(
      'Once timestamp must use local time without timezone suffix',
    );
  }

  const scheduled = new Date(value);
  if (Number.isNaN(scheduled.getTime())) {
    throw new Error('Invalid local timestamp');
  }
  return value;
}

import { describe, expect, it } from 'vitest';

import {
  getApprovalRemainingSeconds,
  sortApprovalsByCreatedAt,
} from './ApprovalOverlay';

describe('ApprovalOverlay helpers', () => {
  it('sorts approvals by creation time so the oldest pending request is shown first', () => {
    const approvals = sortApprovalsByCreatedAt([
      {
        id: 'b',
        toolCallId: 'tool-b',
        toolName: 'bash',
        command: 'echo b',
        createdAt: '2026-03-25T10:00:05.000Z',
        expiresAt: '2026-03-25T10:02:05.000Z',
      },
      {
        id: 'a',
        toolCallId: 'tool-a',
        toolName: 'bash',
        command: 'echo a',
        createdAt: '2026-03-25T10:00:00.000Z',
        expiresAt: '2026-03-25T10:02:00.000Z',
      },
    ]);

    expect(approvals.map((approval) => approval.id)).toEqual(['a', 'b']);
  });

  it('clamps remaining seconds at zero after expiry', () => {
    expect(
      getApprovalRemainingSeconds(
        '2026-03-25T10:00:00.000Z',
        Date.parse('2026-03-25T10:00:30.000Z'),
      ),
    ).toBe(0);
  });

  it('rounds up to the next second while approval is still active', () => {
    expect(
      getApprovalRemainingSeconds(
        '2026-03-25T10:02:00.000Z',
        Date.parse('2026-03-25T10:01:29.100Z'),
      ),
    ).toBe(31);
  });
});

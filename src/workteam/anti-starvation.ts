import { createModuleLogger } from '../logger.js';

const logger = createModuleLogger('workteam');

export class TaskTimeoutMonitor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  startTimer(taskId: string, timeoutMs: number, onTimeout: () => void): void {
    this.clearTimer(taskId);
    const handle = setTimeout(() => {
      this.timers.delete(taskId);
      onTimeout();
    }, timeoutMs);
    this.timers.set(taskId, handle);
  }

  clearTimer(taskId: string): void {
    const handle = this.timers.get(taskId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(taskId);
    }
  }

  clearAll(): void {
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
    }
    this.timers.clear();
  }
}

export class AgentHeartbeatMonitor {
  private lastHeartbeat = new Map<string, number>();
  private missedStreak = new Map<string, number>();
  private hungNotified = new Set<string>();
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private intervalMs = 0;
  private maxMissed = 0;
  private onHung: ((agentId: string) => void) | undefined;

  recordHeartbeat(agentId: string): void {
    this.lastHeartbeat.set(agentId, Date.now());
    this.missedStreak.set(agentId, 0);
    this.hungNotified.delete(agentId);
  }

  startMonitoring(
    intervalMs: number,
    maxMissed: number,
    onHung: (agentId: string) => void,
  ): void {
    this.stopMonitoring();
    this.intervalMs = intervalMs;
    this.maxMissed = maxMissed;
    this.onHung = onHung;
    this.intervalHandle = setInterval(() => this.tick(), intervalMs);
  }

  stopMonitoring(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.onHung = undefined;
  }

  private tick(): void {
    const now = Date.now();
    const threshold = this.intervalMs;
    for (const agentId of this.lastHeartbeat.keys()) {
      const last = this.lastHeartbeat.get(agentId) ?? 0;
      let streak = this.missedStreak.get(agentId) ?? 0;
      if (now - last >= threshold) {
        streak += 1;
        this.missedStreak.set(agentId, streak);
        if (streak >= this.maxMissed && !this.hungNotified.has(agentId)) {
          this.hungNotified.add(agentId);
          try {
            this.onHung?.(agentId);
          } catch (err) {
            logger.warn({ err, agentId }, 'workteam AgentHeartbeatMonitor onHung threw');
          }
        }
      } else {
        this.missedStreak.set(agentId, 0);
      }
    }
  }
}


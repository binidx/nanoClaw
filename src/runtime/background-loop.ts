import { logger } from '../logger.js';

export interface BackgroundLoopHandle {
  stop: () => void;
  isRunning: () => boolean;
}

export function startNonOverlappingBackgroundLoop(input: {
  name: string;
  intervalMs: number;
  runImmediately?: boolean;
  task: () => Promise<void>;
}): BackgroundLoopHandle {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  };

  const tick = () => {
    if (stopped) return;
    if (running) {
      logger.warn(
        { loop: input.name },
        'Background loop tick skipped because previous run is still active',
      );
      schedule(input.intervalMs);
      return;
    }

    running = true;
    input
      .task()
      .catch((err) => {
        logger.warn({ err, loop: input.name }, 'Background loop run failed');
      })
      .finally(() => {
        running = false;
        schedule(input.intervalMs);
      });
  };

  schedule(input.runImmediately ? 0 : input.intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    isRunning: () => running,
  };
}

export const CONSOLE_BUFFER_KEY = '__nanoclawConsoleBuffer';
export const PAGE_ERROR_BUFFER_KEY = '__nanoclawPageErrors';

export const CONSOLE_CAPTURE_SCRIPT = `
(() => {
  const win = window;
  if (win.${CONSOLE_BUFFER_KEY} && win.${PAGE_ERROR_BUFFER_KEY}) {
    return true;
  }
  const consoleBuffer = Array.isArray(win.${CONSOLE_BUFFER_KEY})
    ? win.${CONSOLE_BUFFER_KEY}
    : [];
  const errorBuffer = Array.isArray(win.${PAGE_ERROR_BUFFER_KEY})
    ? win.${PAGE_ERROR_BUFFER_KEY}
    : [];
  const MAX_CONSOLE = 200;
  const MAX_ERRORS = 100;
  const pushLimited = (buffer, value, maxSize) => {
    buffer.push(value);
    if (buffer.length > maxSize) buffer.splice(0, buffer.length - maxSize);
  };
  const safeText = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  win.${CONSOLE_BUFFER_KEY} = consoleBuffer;
  win.${PAGE_ERROR_BUFFER_KEY} = errorBuffer;
  if (!win.__nanoclawConsoleCaptureInstalled) {
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
      const original = originalConsole[level];
      console[level] = function (...args) {
        pushLimited(
          consoleBuffer,
          {
            level,
            text: args.map((arg) => safeText(arg)).join(' '),
            timestamp: new Date().toISOString(),
          },
          MAX_CONSOLE,
        );
        return original.apply(this, args);
      };
    });
    window.addEventListener('error', (event) => {
      pushLimited(
        errorBuffer,
        {
          message: event.message || 'Unknown error',
          timestamp: new Date().toISOString(),
          ...(event.filename ? { url: event.filename } : {}),
          ...(typeof event.lineno === 'number' ? { lineNumber: event.lineno } : {}),
        },
        MAX_ERRORS,
      );
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      pushLimited(
        errorBuffer,
        {
          message:
            reason && typeof reason === 'object' && typeof reason.message === 'string'
              ? reason.message
              : safeText(reason),
          description: 'Unhandled Promise rejection',
          timestamp: new Date().toISOString(),
        },
        MAX_ERRORS,
      );
    });
    win.__nanoclawConsoleCaptureInstalled = true;
  }
  return true;
})();
`.trim();

/**
 * Minimal leveled logger writing JSON lines to stderr, so stdout stays clean for
 * document output when the CLI is piped. Pino-compatible call shape
 * (`log.info(obj, msg)` / `log.info(msg)`) so it can be swapped for pino under Fastify.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100 };

export function createLogger(level = "info", bindings = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (lvl, a, b) => {
    if (LEVELS[lvl] < threshold) return;
    const [obj, msg] = typeof a === "string" ? [{}, a] : [a ?? {}, b];
    const line = { level: lvl, time: new Date().toISOString(), ...bindings, ...obj, msg };
    process.stderr.write(JSON.stringify(line) + "\n");
  };

  return {
    level,
    trace: (a, b) => emit("trace", a, b),
    debug: (a, b) => emit("debug", a, b),
    info: (a, b) => emit("info", a, b),
    warn: (a, b) => emit("warn", a, b),
    error: (a, b) => emit("error", a, b),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

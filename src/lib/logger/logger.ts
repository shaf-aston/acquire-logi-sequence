/**
 * Structured logger. Level + format driven by config (LOG_LEVEL, LOG_PRETTY).
 * Pretty mode for humans during dev; JSON-lines mode for machine ingestion.
 */
import { getConfig, type LogLevel } from "@/config/env";

type Fields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Returns a logger that injects `bindings` into every line — e.g. a request id. */
  child(bindings: Fields): Logger;
}

function emit(level: LogLevel, scope: string, bindings: Fields, msg: string, fields?: Fields): void {
  const cfg = getConfig().observability;
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[cfg.logLevel]) return;

  const record = { ts: new Date().toISOString(), level, scope, msg, ...bindings, ...fields };
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (cfg.logPretty) {
    const extra = { ...bindings, ...fields };
    const tail = Object.keys(extra).length ? " " + JSON.stringify(extra) : "";
    sink(`${record.ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`);
  } else {
    sink(JSON.stringify(record));
  }
}

function make(scope: string, bindings: Fields): Logger {
  return {
    debug: (msg, fields) => emit("debug", scope, bindings, msg, fields),
    info: (msg, fields) => emit("info", scope, bindings, msg, fields),
    warn: (msg, fields) => emit("warn", scope, bindings, msg, fields),
    error: (msg, fields) => emit("error", scope, bindings, msg, fields),
    child: (extra) => make(scope, { ...bindings, ...extra }),
  };
}

/** Create a scoped logger, e.g. `createLogger("ocr.mistral")`. */
export function createLogger(scope: string): Logger {
  return make(scope, {});
}

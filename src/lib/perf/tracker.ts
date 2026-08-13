/**
 * Lightweight performance tracker. Records named spans and emits a summary the
 * caller can log or return to the client. No-op cost stays minimal when
 * PERF_ENABLED=false (spans still measured cheaply but never block).
 */
import { getConfig } from "@/config/env";
import type { Logger } from "@/lib/logger/logger";

export interface SpanResult {
  readonly name: string;
  readonly durationMs: number;
}

export interface PerfReport {
  readonly totalMs: number;
  readonly spans: SpanResult[];
}

/** High-resolution monotonic clock; falls back to Date for non-perf environments. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class PerfTracker {
  private readonly startedAt = now();
  private readonly spans: SpanResult[] = [];
  private readonly enabled: boolean;

  constructor(private readonly logger?: Logger) {
    this.enabled = getConfig().observability.perfEnabled;
  }

  /** Time an async unit of work under `name`. Always returns the work's result. */
  async track<T>(name: string, work: () => Promise<T>): Promise<T> {
    const begin = now();
    try {
      return await work();
    } finally {
      const durationMs = Math.round((now() - begin) * 100) / 100;
      this.spans.push({ name, durationMs });
      if (this.enabled) this.logger?.debug("span", { span: name, durationMs });
    }
  }

  report(): PerfReport {
    return {
      totalMs: Math.round((now() - this.startedAt) * 100) / 100,
      spans: [...this.spans],
    };
  }
}

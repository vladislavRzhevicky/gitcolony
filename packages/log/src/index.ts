// ============================================================================
// Structured logger — single call-site shape across the monorepo.
//
// MVP sink: console.{info,warn,error} with JSON-serialized context. The shape
// is intentionally small so the BetterStack backend can later drop in behind
// this interface without touching call sites.
//
// Use:
//   log.info('city created', { cityId, repoFullName });
//   log.warn('rate limit approaching', { remaining });
//   log.error('job failed', err, { jobId });
//
// Rules of thumb:
//   - Never log secrets (PATs, cookies, bearer tokens). Context keys must
//     reference IDs or counts, not raw credentials.
//   - Message is a short human string. Details go in `ctx`.
//   - `log.error` takes the error as a separate arg so the sink can unpack
//     stack traces and `cause` chains uniformly.
// ============================================================================

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

export interface LogRecord {
  level: LogLevel;
  msg: string;
  ts: string; // ISO-8601
  ctx?: LogContext;
  err?: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  };
}

export interface LogSink {
  write(record: LogRecord): void;
}

// Console sink — MVP default. Emits one line per record so docker/kubectl
// logs stay grep-friendly; backends that want structured ingestion can use
// a different sink.
export const consoleSink: LogSink = {
  write(record) {
    const stream = record.level === 'error' ? console.error : record.level === 'warn' ? console.warn : console.log;
    // Compact one-liner: "LEVEL ts msg {ctx} [err]"
    const parts: string[] = [record.level.toUpperCase(), record.ts, record.msg];
    if (record.ctx && Object.keys(record.ctx).length > 0) {
      parts.push(safeStringify(record.ctx));
    }
    if (record.err) {
      parts.push(`err=${record.err.name}: ${record.err.message}`);
      if (record.err.stack) parts.push(`\n${record.err.stack}`);
    }
    stream(parts.join(' '));
  },
};

let activeSink: LogSink = consoleSink;

// Swap the sink at process start — e.g. BetterStack in production, console
// in dev. Kept as a mutable module-level binding so call sites don't need
// to know or care.
export function setLogSink(sink: LogSink): void {
  activeSink = sink;
}

function serializeError(err: unknown): LogRecord['err'] {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause,
    };
  }
  return { name: 'NonError', message: String(err) };
}

function emit(level: LogLevel, msg: string, ctx?: LogContext, err?: unknown): void {
  activeSink.write({
    level,
    msg,
    ts: new Date().toISOString(),
    ctx,
    err: err === undefined ? undefined : serializeError(err),
  });
}

export const log = {
  info(msg: string, ctx?: LogContext): void {
    emit('info', msg, ctx);
  },
  warn(msg: string, ctx?: LogContext): void {
    emit('warn', msg, ctx);
  },
  error(msg: string, err: unknown, ctx?: LogContext): void {
    emit('error', msg, ctx, err);
  },
};

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

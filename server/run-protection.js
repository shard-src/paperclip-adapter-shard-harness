// ── Run protection (MYL-49) ──────────────────────────────────────────────────
//
// Two wrapper-level guards around upstream claudeExecute (2026.1106.0):
//
// 1) Cancel watchdog. An operator cancel marks the run row `cancelled` in the
//    DB but never kills the CLI process (automaticRecovery policy
//    `preserve_without_replay_v1`, cause `legacy_execution_requires_reconciliation`,
//    adapterRecovery `unsupported_or_unknown`): the process keeps streaming —
//    burning provider-plan tokens — and holds the agent slot, so queued
//    comments and accepted retries (202) do not dispatch until the process
//    happens to exit on its own (observed: 9 minutes, MYL-48 run 14c7eee2).
//    The watchdog polls the run row over the embedded Postgres and kills the
//    process group itself: SIGTERM, then SIGKILL after a grace period.
//
// 2) thinking_tokens log tap. The CLI emits one
//    {"type":"system","subtype":"thinking_tokens",...} event per streaming
//    delta — ~5 events per thinking token, 91–95% of stored run-log bytes
//    (observed 16,912 events / 5.1 MB for 3,408 thinking tokens). The events
//    are local estimates (no API cost) but flood the logs. The tap forwards at
//    most one event per window, keeping logs readable and the server's
//    recent-output liveness signal alive during long thinking stretches.
//
// Both guards are best-effort: any internal failure disables the guard without
// affecting the run itself.

import { readFileSync } from "node:fs";
import path from "node:path";

export const CANCEL_POLL_MS_DEFAULT = 5_000;
export const CANCEL_KILL_GRACE_MS_DEFAULT = 10_000;
export const THINKING_WINDOW_MS_DEFAULT = 15_000;

// README-documented env override for the thinking_tokens tap window.
function thinkingWindowMs() {
  const raw = Number(process.env.SHARD_HARNESS_THINKING_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : THINKING_WINDOW_MS_DEFAULT;
}

// ── thinking_tokens tap ───────────────────────────────────────────────────────

function isThinkingTokensLine(line) {
  return line.includes('"subtype":"thinking_tokens"');
}

// Wraps the adapter onLog channel. Only "stdout" chunks are filtered; stderr
// and other streams pass through untouched. Returns the wrapped onLog plus a
// dispose() that flushes any pending state.
export function createThinkingTap(onLog, { now = Date.now, windowMs = THINKING_WINDOW_MS_DEFAULT } = {}) {
  let carry = ""; // partial line across chunk boundaries
  let pending = null; // latest thinking_tokens line held for the window
  let lastSentAt = 0;
  let flushTimer = null;
  let disposed = false;

  const forward = (chunk) => {
    try {
      onLog("stdout", chunk);
    } catch { /* logging must never break a run */ }
  };

  const armFlushTimer = () => {
    if (flushTimer || !pending) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (disposed || !pending) return;
      const line = pending;
      pending = null;
      lastSentAt = now();
      forward(line);
    }, Math.max(windowMs, 1));
    flushTimer.unref?.();
  };

  const flushPending = () => {
    if (!pending) return;
    const line = pending;
    pending = null;
    lastSentAt = now();
    forward(line);
  };

  const handleLine = (line) => {
    if (isThinkingTokensLine(line)) {
      pending = line;
      if (now() - lastSentAt >= windowMs) flushPending();
      else armFlushTimer();
      return;
    }
    // Preserve ordering: a held estimate precedes any later event.
    flushPending();
    forward(line);
  };

  const tappedOnLog = (stream, chunk) => {
    if (stream !== "stdout" || typeof chunk !== "string" || disposed) {
      return onLog(stream, chunk);
    }
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? ""; // last element: partial line ("" when chunk ended with \n)
    for (const line of lines) handleLine(line);
  };

  return {
    onLog: tappedOnLog,
    dispose() {
      disposed = true;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      // Best-effort final flush so the last estimate is not lost.
      flushPending();
      carry = "";
    },
  };
}

// ── Cancel watchdog ──────────────────────────────────────────────────────────

// Reads the embedded Postgres port from the instance config. Returns null when
// the layout is unknown — the watchdog then stays disabled.
function embeddedDbConfig() {
  const home = process.env.PAPERCLIP_HOME;
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID || "default";
  if (!home) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(home, "instances", instanceId, "config.json"), "utf8"));
  } catch {
    return null;
  }
  const port = Number(config?.database?.embeddedPostgresPort) || 54329;
  if (config?.database?.mode && config.database.mode !== "embedded-postgres") return null;
  return { host: "127.0.0.1", port, user: "paperclip", password: "paperclip", database: "paperclip" };
}

async function defaultConnectDb() {
  const cfg = embeddedDbConfig();
  if (!cfg) return null;
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client(cfg);
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

function defaultKill(pgid, signal) {
  process.kill(-pgid, signal);
}

// Polls the run row; when the server has marked the run `cancelled` (operator
// cancel) the CLI process group is SIGTERMed and, if it survives the grace
// period, SIGKILLed. Never touches other statuses.
export function startCancelWatchdog({
  runId,
  onLog,
  deps = {},
}) {
  const {
    connectDb = defaultConnectDb,
    kill = defaultKill,
    pollMs = CANCEL_POLL_MS_DEFAULT,
    graceMs = CANCEL_KILL_GRACE_MS_DEFAULT,
  } = deps;

  let stopped = false;
  let client = null;
  let connecting = false;
  let termSentAt = null;
  let killSent = false;

  const note = (text) => {
    try {
      onLog?.("stderr", `[shard-harness] ${text}\n`);
    } catch { /* ignore */ }
  };

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (client) {
      const c = client;
      client = null;
      c.end().catch(() => { });
    }
  };

  const timer = setInterval(async () => {
    if (stopped) return;
    if (!client) {
      if (connecting) return;
      connecting = true;
      try {
        client = await connectDb();
        if (!client) stop(); // layout unknown / db unreachable: stay disabled
      } catch {
        client = null;
      } finally {
        connecting = false;
      }
      if (!client) return;
    }
    let row;
    try {
      const res = await client.query(
        "SELECT status, process_pid, process_group_id FROM heartbeat_runs WHERE id = $1",
        [runId],
      );
      row = res.rows[0];
    } catch {
      return; // transient query error: retry on the next tick
    }
    if (!row) { stop(); return; } // row gone: nothing left to guard
    if (row.status !== "cancelled") return;

    const pgid = Number(row.process_group_id) || Number(row.process_pid);
    if (!pgid) return;
    try {
      if (killSent) return;
      if (termSentAt == null) {
        kill(pgid, "SIGTERM");
        termSentAt = Date.now();
        note(`run cancelled by operator — SIGTERM to process group ${pgid}`);
        return;
      }
      if (Date.now() - termSentAt >= graceMs) {
        kill(pgid, "SIGKILL");
        killSent = true;
        note(`process group ${pgid} survived SIGTERM — SIGKILL sent`);
        stop();
      }
    } catch (err) {
      // ESRCH: the group is already gone — exactly what we wanted.
      if (err && (err.code === "ESRCH" || /no such process/i.test(String(err?.message)))) {
        note(`cancelled run's process group ${pgid} is gone`);
        stop();
        return;
      }
      // Anything else (EPERM…): report once and stop trying.
      note(`cancel kill failed for pgid ${pgid}: ${err?.code || err?.message}`);
      stop();
    }
  }, Math.max(pollMs, 1));
  timer.unref?.();

  return { stop };
}

// ── execute() wrapper wiring ─────────────────────────────────────────────────

// Wraps ctx for claudeExecute: installs the thinking tap on onLog and arms the
// cancel watchdog; both are torn down when the run settles.
export function protectExecute(claudeExecute, repair) {
  return (ctx) => {
    const baseOnLog = ctx.onLog ?? (() => { });
    const tap = createThinkingTap(baseOnLog, { windowMs: thinkingWindowMs() });
    const watchdog = ctx.runId
      ? startCancelWatchdog({ runId: ctx.runId, onLog: tap.onLog })
      : null;
    const wrappedCtx = { ...ctx, onLog: tap.onLog };
    return claudeExecute(wrappedCtx)
      .finally(() => {
        watchdog?.stop();
        tap.dispose();
      })
      .then(repair);
  };
}

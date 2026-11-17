// ── Run protection (MYL-49 / MYL-56) ─────────────────────────────────────────
//
// Three wrapper-level guards around upstream claudeExecute (2026.1106.0):
//
// 1) Signal-based cancel (MYL-56, replaces the v1.3.0 DB watchdog). The
//    wrapper adopts the CLI process group from ctx.onSpawn and kills it when
//    ctx.signal aborts: SIGTERM, then SIGKILL after a grace period. The
//    server owns cancellation for legacy runs too (operator cancel in
//    run-control and budget-cancel abort exactly ctx.signal, once the adapter
//    registered an execution control via ctx.onCancellationReady), so the
//    v1.3.0 DB round-trip, its pg dependency and its poll loop are gone.
//    Upstream claudeExecute itself never touches ctx.signal, so without this
//    guard a cancelled run keeps streaming — burning provider-plan tokens and
//    holding the agent slot (observed: 9 minutes, MYL-48 run 14c7eee2).
// 2) thinking_tokens log tap (MYL-49). The CLI emits one
//    {"type":"system","subtype":"thinking_tokens",...} event per streaming
//    delta — ~5 events per thinking token, 91–95% of stored run-log bytes
//    (observed 16,912 events / 5.1 MB for 3,408 thinking tokens). The events
//    are local estimates (no API cost) but flood the logs. The tap forwards at
//    most one event per window, keeping logs readable and the server's
//    recent-output liveness signal alive during long thinking stretches.
// 3) Runtime progress reporter (MYL-56). Upstream claude_local never reports
//    live progress for local runs (adapter-utils forwards onRuntimeProgress
//    only for remote sandbox targets). The reporter watches the stream-json
//    lines already flowing through onLog and calls ctx.onRuntimeProgress with
//    phase "run_activity": the running tool name and the last assistant
//    snippet, throttled to at most one call per interval.
// 4) Operator-stop receipt (MYL-60). The server's operator-cancel answer
//    re-reads the run after the adapter settles and returns 409 "provider
//    termination could not be verified" unless the terminal row carries
//    resultJson.executionCancellation.state = "acknowledged" (run-control.js
//    941-946 on 2026.1106.0). acpx-engine adapters stamp that receipt into
//    their returned result (adapter-utils acpx-engine/execute.js 3172/4814);
//    claude_local never implemented the contract, so every fast cancel of an
//    active legacy run conflicted. After the CLI settles, the wrapper stamps
//    the receipt — but only when it can honestly verify termination itself:
//    kill(-pgid, 0) reporting ESRCH (the same OS-level standard as the
//    server's completedRunTerminationProof local_process_exit), or no process
//    having been spawned at all. No proof, no stamp: the honest 409 remains.
//
// All guards are best-effort: any internal failure disables the guard without
// affecting the run itself.

export const CANCEL_KILL_GRACE_MS_DEFAULT = 10_000;
export const PROGRESS_INTERVAL_MS_DEFAULT = 5_000;
export const PROGRESS_SNIPPET_MAX_CHARS = 200;
export const THINKING_WINDOW_MS_DEFAULT = 15_000;
export const STOP_RECEIPT_VERIFY_MS_DEFAULT = 2_000;
export const STOP_RECEIPT_POLL_MS_DEFAULT = 25;

// README-documented env override for the thinking_tokens tap window.
function thinkingWindowMs() {
  const raw = Number(process.env.SHARD_HARNESS_THINKING_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : THINKING_WINDOW_MS_DEFAULT;
}

// README-documented env override for the cancel escalation grace.
function cancelGraceMs() {
  const raw = Number(process.env.SHARD_HARNESS_CANCEL_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : CANCEL_KILL_GRACE_MS_DEFAULT;
}

// README-documented env override for the runtime-progress throttle. The
// server touches progress TTL from stdout chunks at a 5 s cadence, so the
// throttle floor is 5 s; smaller values fall back to the default.
function progressIntervalMs() {
  const raw = Number(process.env.SHARD_HARNESS_PROGRESS_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= PROGRESS_INTERVAL_MS_DEFAULT
    ? raw
    : PROGRESS_INTERVAL_MS_DEFAULT;
}

// README-documented env override for the operator-stop receipt verification
// window: how long the wrapper polls the adopted process group for ESRCH
// before giving up (and leaving the honest 409 in place). Default covers the
// guard's own SIGKILL escalation (grace + 2 s): group members that ignore
// SIGTERM must still die within the window for the receipt to be honest.
function stopReceiptVerifyMs(graceMs = cancelGraceMs()) {
  const raw = Number(process.env.SHARD_HARNESS_STOP_RECEIPT_VERIFY_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return Math.max(graceMs + 2_000, STOP_RECEIPT_VERIFY_MS_DEFAULT);
}

// ── thinking_tokens tap ───────────────────────────────────────────────────────

function isThinkingTokensLine(line) {
  return line.includes('"subtype":"thinking_tokens"');
}

// Wraps the adapter onLog channel. Only "stdout" chunks are filtered; stderr
// and other streams pass through untouched. `onLine` (MYL-56) observes every
// reassembled stdout line before tap filtering — the progress reporter hooks
// in here, sharing the same line reassembly. Returns the wrapped onLog plus a
// dispose() that flushes any pending state.
//
// Every re-emitted stdout chunk keeps its trailing "\n": the Paperclip UI
// reassembles transcript lines by splitting chunk text on newlines, so a
// newline-less chunk stream glues lines together and the run transcript
// renders empty (MYL-55).
export function createThinkingTap(onLog, { now = Date.now, windowMs = THINKING_WINDOW_MS_DEFAULT, onLine = null } = {}) {
  let carry = ""; // partial line across chunk boundaries
  let pending = null; // latest thinking_tokens line held for the window
  let lastSentAt = 0;
  let flushTimer = null;
  let disposed = false;

  const forward = (line) => {
    try {
      onLog("stdout", `${line}\n`);
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
    if (onLine) {
      try {
        onLine(line);
      } catch { /* observers must never break a run */ }
    }
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
      // A trailing partial line still matters (final result event when the
      // CLI dies without a newline): flush it through the normal path.
      if (carry) {
        const line = carry;
        carry = "";
        handleLine(line);
      }
      disposed = true;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      // Best-effort final flush so the last estimate is not lost.
      flushPending();
    },
  };
}

// ── Runtime progress reporter (MYL-56) ───────────────────────────────────────

function liveToolName(event) {
  if (event.type === "content_block_start") {
    const block = event.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name) {
      return block.name;
    }
    return null;
  }
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === "tool_use" && typeof block.name === "string" && block.name) {
        return block.name;
      }
    }
  }
  return null;
}

function liveAssistantSnippet(event, maxChars) {
  if (event.type !== "assistant") return null;
  const content = event.message?.content;
  const blocks = Array.isArray(content)
    ? content
    : typeof content === "string" ? [{ type: "text", text: content }] : [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      const text = block.text.replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, maxChars);
    }
  }
  return null;
}

// Observes stream-json stdout lines and reports live run status through
// ctx.onRuntimeProgress. The update mirrors the server's own
// buildRunEventRuntimeProgress shape: phase "run_activity", message
// "Using <tool>" when a tool is running (snippet kept as context), the
// snippet otherwise. Sends at most one update per intervalMs and keeps the
// latest state. A change held back by the throttle is marked dirty and
// flushes with the next observed line once the window has elapsed, so held
// state surfaces as soon as the stream produces any further line. Never
// throws and never leaves a rejection unhandled: progress is best-effort.
export function createProgressReporter({
  onProgress,
  now = Date.now,
  intervalMs = PROGRESS_INTERVAL_MS_DEFAULT,
  snippetMaxChars = PROGRESS_SNIPPET_MAX_CHARS,
} = {}) {
  let lastSentAt = 0;
  let currentToolName = null;
  let lastAssistantSnippet = null;
  let dirty = false;
  let disposed = false;

  const emit = (at) => {
    const message = currentToolName ? `Using ${currentToolName}` : lastAssistantSnippet;
    if (!message) return;
    const update = {
      phase: "run_activity",
      message,
      currentToolName,
      lastAssistantSnippet,
      lastEventAt: new Date(at).toISOString(),
    };
    lastSentAt = at;
    dirty = false;
    try {
      const result = onProgress(update);
      result?.catch?.(() => { /* reporter must never break a run */ });
    } catch { /* reporter must never break a run */ }
  };

  return {
    observeLine(line) {
      if (disposed || typeof line !== "string" || !line.startsWith("{")) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return; // non-JSON stdout (CLI banners, command echo, …)
      }
      if (!event || typeof event !== "object") return;
      let changed = false;
      const tool = liveToolName(event);
      if (tool && tool !== currentToolName) {
        currentToolName = tool;
        changed = true;
      }
      const snippet = liveAssistantSnippet(event, snippetMaxChars);
      if (snippet && snippet !== lastAssistantSnippet) {
        lastAssistantSnippet = snippet;
        changed = true;
      }
      if (changed) dirty = true;
      const at = now();
      if ((changed || dirty) && at - lastSentAt >= intervalMs) emit(at);
    },
    dispose() {
      disposed = true;
      currentToolName = null;
      lastAssistantSnippet = null;
      dirty = false;
    },
  };
}

// ── Signal-based cancel (MYL-56) ─────────────────────────────────────────────

function isProcessGone(err) {
  return Boolean(err) && (err.code === "ESRCH" || /no such process/i.test(String(err?.message)));
}

function defaultKill(pgid, signal) {
  process.kill(-pgid, signal);
}

// Arms ctx.signal — the run's AbortSignal: SIGTERM the adopted process group
// on abort, escalate to SIGKILL after the grace period. The group is adopted
// through adopt() from the wrapped ctx.onSpawn; a cancel that wins the race
// against the spawn kills as soon as the group is known. A killed group is
// success (ESRCH); anything else is reported once and the guard stands down.
// Without a signal (older server) the guard stays armed but inert. dispose()
// removes the abort listener and any pending escalation — call it when the
// run settles.
export function createSignalCancelGuard({
  signal,
  kill = defaultKill,
  graceMs = CANCEL_KILL_GRACE_MS_DEFAULT,
  note = () => { },
} = {}) {
  let pgid = null;
  let killTimer = null;
  let done = false;

  const safeNote = (text) => {
    try {
      note(text);
    } catch { /* notes are best-effort */ }
  };

  const killGroup = (sig) => {
    if (pgid == null || done) return;
    try {
      kill(pgid, sig);
    } catch (err) {
      if (isProcessGone(err)) safeNote(`cancelled run's process group ${pgid} is gone`);
      else safeNote(`cancel ${sig} failed for pgid ${pgid}: ${err?.code || err?.message}`);
      done = true;
      return;
    }
    if (sig === "SIGKILL") {
      safeNote(`process group ${pgid} survived SIGTERM — SIGKILL sent`);
      done = true;
      return;
    }
    safeNote(`run cancelled — SIGTERM to process group ${pgid}`);
    killTimer = setTimeout(() => {
      killTimer = null;
      killGroup("SIGKILL");
    }, Math.max(graceMs, 1));
    killTimer.unref?.();
  };

  const onAbort = () => killGroup("SIGTERM");
  signal?.addEventListener("abort", onAbort);

  return {
    // Records the CLI process group (call sites fall back to the pid when the
    // runner did not report one) and handles a cancel that already fired.
    adopt(captured) {
      const value = Number(captured);
      if (!Number.isFinite(value) || value <= 0) return;
      if (pgid == null) pgid = value;
      if (signal?.aborted) killGroup("SIGTERM");
    },
    // The adopted group (or null): the receipt's verification target.
    adoptedGroup() {
      return pgid;
    },
    note: safeNote,
    dispose() {
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    },
  };
}

// ── Operator-stop receipt (MYL-60) ────────────────────────────────────────────

// Probes the adopted process group with signal 0 (existence check, delivers
// nothing). ESRCH / "no such process" is the OS-level death proof; anything
// else counts as still alive.
function probeGroupGone(kill, pgid) {
  try {
    kill(pgid, 0);
    return false;
  } catch (err) {
    return isProcessGone(err);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Builds the adapter-verified stop receipt the server's operator-cancel
// answer requires (run-control conflict branch passes only when the terminal
// row carries executionCancellation.state = "acknowledged"; the terminal write
// spreads the adapter result over the row, run-completion 374-379 on
// 2026.1106.0). Mirrors the acpx-engine contract:
//
// - not aborted → null (a normal run reports nothing);
// - aborted with no adopted group → acknowledged / forced:false — nothing was
//   spawned, mirroring acpx "Stopped before provider startup";
// - aborted with the group verified gone (ESRCH on kill(-pgid, 0), polled for
//   up to verifyMs) → acknowledged / forced:true;
// - still alive, or the probe stays inconclusive → null: no honest proof, the
//   server keeps its verifiable conflict answer.
export async function operatorStopReceipt({
  aborted,
  processGroupId,
  kill = defaultKill,
  pollMs = STOP_RECEIPT_POLL_MS_DEFAULT,
  verifyMs = STOP_RECEIPT_VERIFY_MS_DEFAULT,
} = {}) {
  if (!aborted) return null;
  const acknowledgedAt = new Date().toISOString();
  if (processGroupId == null) {
    return { state: "acknowledged", acknowledgedAt, forced: false };
  }
  const deadline = Date.now() + Math.max(verifyMs, 0);
  for (;;) {
    if (probeGroupGone(kill, processGroupId)) {
      return { state: "acknowledged", acknowledgedAt, forced: true };
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.max(pollMs, 1));
  }
}

// ── execute() wrapper wiring ─────────────────────────────────────────────────

// Wraps ctx for claudeExecute: installs the thinking tap on onLog (with the
// progress reporter observing the same lines), adopts the CLI process group
// from onSpawn for signal-based cancel, and announces cancel-readiness via
// ctx.onCancellationReady — the server aborts ctx.signal only for runs whose
// adapter registered an execution control, so skipping the call would leave
// the legacy never-kill path in place. All guards are torn down when the run
// settles. After repair, an aborted run gets the operator-stop receipt
// (MYL-60) merged into resultJson so the server's cancel answer can verify
// provider termination instead of conflicting. `deps.kill` is a test seam for
// the cancel escalation and the receipt probe; `deps.pollMs`/`deps.verifyMs`
// for the receipt window.
export function protectExecute(claudeExecute, repair, deps = {}) {
  const { kill = defaultKill } = deps;
  return async (ctx) => {
    const baseOnLog = ctx.onLog ?? (() => { });

    const reporter = typeof ctx.onRuntimeProgress === "function"
      ? createProgressReporter({ onProgress: ctx.onRuntimeProgress, intervalMs: progressIntervalMs() })
      : null;
    const tap = createThinkingTap(baseOnLog, {
      windowMs: thinkingWindowMs(),
      onLine: reporter ? (line) => reporter.observeLine(line) : null,
    });

    const guard = createSignalCancelGuard({
      signal: ctx.signal,
      kill,
      graceMs: cancelGraceMs(),
      note: (text) => tap.onLog("stderr", `[shard-harness] ${text}\n`),
    });
    const baseOnSpawn = ctx.onSpawn;
    const wrappedCtx = {
      ...ctx,
      onLog: tap.onLog,
      onSpawn: async (meta) => {
        guard.adopt(meta?.processGroupId ?? meta?.pid);
        await baseOnSpawn?.(meta);
      },
    };

    // Best-effort: a registration failure must not stop the run — cancel
    // then falls back to the server's legacy path.
    try {
      await ctx.onCancellationReady?.();
    } catch { /* cancel-readiness is best-effort */ }

    let result;
    // guard.dispose() deliberately runs AFTER the stop receipt: the pending
    // SIGKILL escalation is what guarantees group members that ignored SIGTERM
    // die inside the receipt's verification window. Disposing first (the
    // pre-1.5.0 order) cancelled the escalation and left the group half-alive,
    // so the receipt could not verify termination and the honest 409 remained.
    try {
      try {
        result = await claudeExecute(wrappedCtx);
      } finally {
        reporter?.dispose();
        tap.dispose();
      }
      result = repair(result);

      // MYL-60: attach the adapter-verified stop receipt. The receipt only
      // claims what this wrapper proved: no process was spawned, or the adopted
      // group is gone per the OS. Best-effort like every guard here — a
      // receipt failure never affects the returned run result.
      try {
        const receipt = await operatorStopReceipt({
          aborted: ctx.signal?.aborted === true,
          processGroupId: guard.adoptedGroup(),
          kill,
          pollMs: deps.pollMs,
          verifyMs: deps.verifyMs ?? stopReceiptVerifyMs(),
        });
        if (receipt && result && typeof result === "object"
          && (result.resultJson == null || typeof result.resultJson === "object")) {
          result = {
            ...result,
            resultJson: { ...result.resultJson, executionCancellation: receipt },
          };
          guard.note(`operator stop receipt: ${receipt.state} (${receipt.forced
            ? `process group ${guard.adoptedGroup()} exit verified`
            : "no process spawned"})`);
        }
      } catch { /* the receipt is best-effort */ }
      return result;
    } finally {
      guard.dispose();
    }
  };
}

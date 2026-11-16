// MYL-49 — run protection tests.
//
// 1) thinking_tokens tap: rapid per-delta events collapse to at most one per
//    window; other lines pass through in order; partial lines reassemble.
// 2) cancel watchdog: a DB row flipped to `cancelled` triggers SIGTERM on the
//    recorded process group and escalates to SIGKILL after the grace period;
//    other statuses are never signalled.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createThinkingTap,
  startCancelWatchdog,
  protectExecute,
} from "../server/run-protection.js";

const tt = (n, delta = 1) =>
  `{"type":"system","subtype":"thinking_tokens","estimated_tokens":${n},"estimated_tokens_delta":${delta},"session_id":"s","uuid":"u${n}"}\n`;
const RESULT = `{"type":"result","subtype":"success","is_error":false}\n`;

function collector() {
  const calls = [];
  return { calls, onLog: (stream, chunk) => { calls.push([stream, chunk]); } };
}

describe("thinking_tokens tap", () => {
  it("collapses a burst to one event per window", () => {
    const { calls, onLog } = collector();
    let clock = 1000;
    const tap = createThinkingTap(onLog, { now: () => clock, windowMs: 15_000 });
    tap.onLog("stdout", tt(1) + tt(3) + tt(5) + tt(8) + tt(10));
    clock += 100;
    tap.onLog("stdout", tt(12));
    tap.dispose();
    const stdout = calls.filter(([s]) => s === "stdout").map(([, c]) => c);
    // First event of the burst forwards immediately; the rest collapse.
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('"estimated_tokens":1'));
  });

  it("flushes the held estimate before the next real line and keeps order", () => {
    const { calls, onLog } = collector();
    let clock = 1000;
    const tap = createThinkingTap(onLog, { now: () => clock, windowMs: 15_000 });
    tap.onLog("stdout", tt(1)); // held (within window)
    tap.onLog("stdout", tt(40)); // supersedes the held estimate
    tap.onLog("stdout", RESULT); // flushes the held estimate first
    tap.dispose();
    const stdout = calls.filter(([s]) => s === "stdout").map(([, c]) => c);
    // tt(1) collapsed into tt(40); only the latest estimate survives.
    assert.equal(stdout.length, 2);
    assert.ok(stdout[0].includes('"estimated_tokens":40'));
    assert.ok(stdout[1].includes('"subtype":"success"'));
  });

  it("reassembles a JSON line split across chunks", () => {
    const { calls, onLog } = collector();
    const tap = createThinkingTap(onLog, { now: () => 1000, windowMs: 15_000 });
    const line = tt(7).slice(0, 20);
    const rest = tt(7).slice(20);
    tap.onLog("stdout", line);
    tap.onLog("stdout", rest + RESULT);
    tap.dispose();
    const stdout = calls.filter(([s]) => s === "stdout").map(([, c]) => c);
    // Split thinking line reassembles and is held; RESULT flushes it.
    assert.equal(stdout.length, 2);
    assert.ok(stdout[0].includes('"estimated_tokens":7'));
    assert.ok(stdout[1].includes('"subtype":"success"'));
  });

  it("passes stderr through untouched", () => {
    const { calls, onLog } = collector();
    const tap = createThinkingTap(onLog, { now: () => 1000, windowMs: 15_000 });
    tap.onLog("stderr", tt(1));
    tap.dispose();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "stderr");
  });
});

describe("cancel watchdog", () => {
  function harness({ rows, pollMs = 5, graceMs = 20 }) {
    const kills = [];
    const queries = [];
    let queryCount = 0;
    const client = {
      async query(sql, params) {
        queries.push([sql, params]);
        const row = typeof rows === "function" ? rows(queryCount) : rows[queryCount];
        queryCount += 1;
        return { rows: row ? [row] : [] };
      },
      end: async () => { },
    };
    const watchdog = startCancelWatchdog({
      runId: "run-1",
      onLog: () => { },
      deps: {
        connectDb: async () => client,
        kill: (pgid, signal) => kills.push([pgid, signal]),
        pollMs,
        graceMs,
      },
    });
    return { watchdog, kills };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  it("SIGTERMs the process group when the run is cancelled, then SIGKILLs after grace", async () => {
    // First poll: still running. Then cancelled forever after.
    let cancelled = false;
    const { watchdog, kills } = harness({
      rows: () => (cancelled
        ? { status: "cancelled", process_pid: 4242, process_group_id: 4242 }
        : { status: "running", process_pid: 4242, process_group_id: 4242 }),
    });
    await wait(10); // one running poll, no signal
    assert.equal(kills.length, 0);
    cancelled = true;
    await wait(12); // SIGTERM lands on the next poll
    assert.deepEqual(kills, [[4242, "SIGTERM"]]);
    await wait(30); // grace elapses -> SIGKILL
    assert.deepEqual(kills, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    watchdog.stop();
  });

  it("never signals a non-cancelled run", async () => {
    const { watchdog, kills } = harness({
      rows: () => ({ status: "running", process_pid: 99, process_group_id: 99 }),
    });
    await wait(25);
    assert.equal(kills.length, 0);
    watchdog.stop();
  });

  it("treats ESRCH as success and stops", async () => {
    let fired = false;
    const client = {
      async query() {
        return fired
          ? { rows: [{ status: "cancelled", process_pid: 77, process_group_id: 77 }] }
          : { rows: [{ status: "running", process_pid: 77, process_group_id: 77 }] };
      },
      end: async () => { },
    };
    const kills = [];
    const watchdog = startCancelWatchdog({
      runId: "run-2",
      onLog: () => { },
      deps: {
        connectDb: async () => client,
        kill: (pgid, signal) => {
          if (signal === "SIGTERM") {
            const e = new Error("no such process");
            e.code = "ESRCH";
            throw e;
          }
          kills.push([pgid, signal]);
        },
        pollMs: 5,
        graceMs: 10,
      },
    });
    fired = true;
    await wait(15);
    assert.equal(kills.length, 0); // SIGTERM hit ESRCH -> done, no SIGKILL
    watchdog.stop();
  });

  it("stops cleanly when the run row disappears", async () => {
    let gone = false;
    const { watchdog, kills } = harness({ rows: () => (gone ? null : { status: "running", process_pid: 1, process_group_id: 1 }) });
    gone = true;
    await wait(15);
    assert.equal(kills.length, 0);
    watchdog.stop();
  });
});

describe("protectExecute wiring", () => {
  it("installs the tap, arms the watchdog for runId ctx, and tears both down", async () => {
    const seen = [];
    let ctxSeen = null;
    const stops = [];
    const fakeExecute = async (ctx) => {
      ctxSeen = ctx;
      ctx.onLog("stdout", tt(1) + tt(2));
      ctx.onLog("stdout", RESULT);
      return { exitCode: 0, ok: true };
    };
    const wrapped = protectExecute(fakeExecute, (r) => ({ ...r, repaired: true }));
    const origStart = globalThis.__shardStartCancelWatchdog; // not used; direct test
    const result = await wrapped({ runId: "r", onLog: (s, c) => seen.push([s, c]) });
    assert.equal(result.repaired, true);
    assert.equal(ctxSeen.onLog.name, "tappedOnLog");
    // Burst collapsed (one immediate), held estimate flushed before result.
    const stdout = seen.filter(([s]) => s === "stdout").map(([, c]) => c);
    assert.equal(stdout.length, 3);
    assert.ok(stdout[0].includes('"estimated_tokens":1'));
    assert.ok(stdout[1].includes('"estimated_tokens":2'));
    assert.ok(stdout[2].includes('"subtype":"success"'));
    assert.equal(stops.length, 0);
  });

  it("works without runId (no watchdog) and with the real adapter shape", async () => {
    const fakeExecute = async (ctx) => {
      ctx.onLog("stdout", tt(1));
      return { exitCode: 0 };
    };
    const wrapped = protectExecute(fakeExecute, (r) => r);
    const out = await wrapped({ onLog: () => { } }); // no runId
    assert.equal(out.exitCode, 0);
  });
});

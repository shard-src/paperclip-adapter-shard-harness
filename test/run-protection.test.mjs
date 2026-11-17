// MYL-49 / MYL-56 — run protection tests.
//
// 1) thinking_tokens tap: rapid per-delta events collapse to at most one per
//    window; other lines pass through in order; partial lines reassemble; the
//    onLine hook observes every reassembled stdout line.
// 2) signal-based cancel: abort fires SIGTERM on the adopted process group
//    and escalates to SIGKILL after the grace period; ESRCH is success; a
//    cancel that beats the spawn kills on adopt; without a signal the guard
//    is inert; dispose removes the listener and the pending escalation.
// 3) progress reporter: content_block_start tool_use and assistant events map
//    to run_activity updates, throttled per interval; garbage lines are
//    ignored; reporter failures never break the caller.
// 4) protectExecute wiring: tap + guard + reporter + onCancellationReady.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createThinkingTap,
  createProgressReporter,
  createSignalCancelGuard,
  operatorStopReceipt,
  protectExecute,
} from "../server/run-protection.js";

const tt = (n, delta = 1) =>
  `{"type":"system","subtype":"thinking_tokens","estimated_tokens":${n},"estimated_tokens_delta":${delta},"session_id":"s","uuid":"u${n}"}\n`;
const RESULT = `{"type":"result","subtype":"success","is_error":false}\n`;
const TOOLUSE = `{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}\n`;
const ASSISTANT = `{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Checking the deploy pipeline now"}]},"session_id":"s"}\n`;
const ASSISTANT_TOOL = `{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Read","input":{}}]},"session_id":"s"}\n`;
const TEXT_BLOCK_START = `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n`;
const GARBAGE = `claude code v2.1.0 — starting headless session\n`;

function collector() {
  const calls = [];
  return { calls, onLog: (stream, chunk) => { calls.push([stream, chunk]); } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

  it("onLine observes every reassembled stdout line, held ones included", () => {
    const observed = [];
    const { onLog } = collector();
    const tap = createThinkingTap(onLog, { now: () => 1000, windowMs: 15_000, onLine: (l) => observed.push(l) });
    tap.onLog("stdout", tt(1)); // held by the tap, still observed
    const split = TOOLUSE.slice(0, 30);
    tap.onLog("stdout", split);
    tap.onLog("stdout", TOOLUSE.slice(30) + RESULT);
    tap.dispose();
    // tt(1), reassembled TOOLUSE, RESULT — three logical lines.
    assert.equal(observed.length, 3);
    assert.ok(observed[0].includes("thinking_tokens"));
    assert.ok(observed[1].includes("content_block_start"));
    assert.ok(observed[2].includes('"type":"result"'));
  });

  it("an throwing onLine observer never breaks the tap", () => {
    const { calls, onLog } = collector();
    const tap = createThinkingTap(onLog, {
      now: () => 1000,
      windowMs: 15_000,
      onLine: () => { throw new Error("observer exploded"); },
    });
    tap.onLog("stdout", RESULT);
    tap.dispose();
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1].includes('"type":"result"'));
  });

  it("emits newline-terminated stdout chunks so UI line reassembly works (MYL-55)", () => {
    const { calls, onLog } = collector();
    const tap = createThinkingTap(onLog, { now: () => 1000, windowMs: 15_000 });
    tap.onLog("stdout", TOOLUSE + ASSISTANT + RESULT);
    tap.dispose();
    const stdout = calls.filter(([s]) => s === "stdout").map(([, c]) => c);
    assert.ok(stdout.length >= 3);
    for (const chunk of stdout) {
      assert.ok(chunk.endsWith("\n"), `chunk must end with newline: ${chunk.slice(0, 60)}`);
    }
    // Each chunk is exactly one parseable JSON line.
    for (const chunk of stdout) {
      assert.doesNotThrow(() => JSON.parse(chunk));
    }
  });

  it("keeps newlines on thinking flushes and split chunks across boundaries", () => {
    const { calls, onLog } = collector();
    let clock = 1000;
    const tap = createThinkingTap(onLog, { now: () => clock, windowMs: 15_000 });
    tap.onLog("stdout", tt(1).slice(0, 20)); // partial thinking line
    clock += 100;
    tap.onLog("stdout", tt(1).slice(20) + RESULT); // completes + a real line
    tap.dispose();
    const stdout = calls.filter(([s]) => s === "stdout").map(([, c]) => c);
    for (const chunk of stdout) {
      assert.ok(chunk.endsWith("\n"));
      assert.doesNotThrow(() => JSON.parse(chunk));
    }
  });

  it("flushes a trailing partial line on dispose with a newline", () => {
    const { calls, onLog } = collector();
    const tap = createThinkingTap(onLog, { now: () => 1000, windowMs: 15_000 });
    tap.onLog("stdout", RESULT.slice(0, 25)); // no trailing newline yet
    tap.dispose();
    const stdout = calls.filter(([s]) => s === "stdout").map(([, c]) => c);
    assert.equal(stdout.length, 1);
    assert.equal(stdout[0], RESULT.slice(0, 25) + "\n");
  });
});

describe("signal-based cancel", () => {
  function guardHarness({ graceMs = 20 } = {}) {
    const kills = [];
    const notes = [];
    const controller = new AbortController();
    const guard = createSignalCancelGuard({
      signal: controller.signal,
      kill: (pgid, sig) => kills.push([pgid, sig]),
      graceMs,
      note: (t) => notes.push(t),
    });
    return { guard, controller, kills, notes };
  }

  it("SIGTERMs the adopted group on abort, then SIGKILLs after grace", async () => {
    const { guard, controller, kills } = guardHarness({ graceMs: 20 });
    guard.adopt(4242);
    controller.abort();
    assert.deepEqual(kills, [[4242, "SIGTERM"]]);
    await wait(60); // grace elapses -> SIGKILL
    assert.deepEqual(kills, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    guard.dispose();
  });

  it("never signals without an adopted group", async () => {
    const { guard, controller, kills } = guardHarness({ graceMs: 10 });
    controller.abort();
    await wait(30);
    assert.equal(kills.length, 0);
    guard.dispose();
  });

  it("a cancel that wins the race against the spawn kills on adopt", async () => {
    const { guard, controller, kills } = guardHarness({ graceMs: 20 });
    controller.abort(); // abort before onSpawn ever ran
    await wait(5);
    guard.adopt(777);
    assert.deepEqual(kills, [[777, "SIGTERM"]]);
    await wait(40);
    assert.deepEqual(kills, [[777, "SIGTERM"], [777, "SIGKILL"]]);
    guard.dispose();
  });

  it("keeps the first adopted group and ignores invalid ones", async () => {
    const { guard, controller, kills } = guardHarness({ graceMs: 20 });
    guard.adopt(4242);
    guard.adopt(999); // second spawn meta must not retarget
    controller.abort();
    assert.deepEqual(kills, [[4242, "SIGTERM"]]);
    guard.dispose();
  });

  it("treats ESRCH as success and skips escalation", async () => {
    const controller = new AbortController();
    const esrch = new Error("kill ESRCH");
    esrch.code = "ESRCH";
    const guard = createSignalCancelGuard({
      signal: controller.signal,
      kill: () => { throw esrch; },
      graceMs: 10,
      note: () => { },
    });
    guard.adopt(77);
    controller.abort();
    await wait(30);
    // Guard stood down after SIGTERM hit a dead group: no crash, no timer left.
    guard.dispose();
  });

  it("without a signal the guard stays armed but inert", async () => {
    const kills = [];
    const guard = createSignalCancelGuard({
      signal: null, // older server: no ctx.signal
      kill: (pgid, sig) => kills.push([pgid, sig]),
      graceMs: 10,
    });
    guard.adopt(5);
    await wait(25);
    assert.equal(kills.length, 0);
    guard.dispose();
  });

  it("dispose removes the listener and the pending escalation", async () => {
    const { guard, controller, kills } = guardHarness({ graceMs: 15 });
    guard.adopt(9);
    controller.abort();
    guard.dispose(); // run settled before the grace elapsed
    await wait(40);
    assert.deepEqual(kills, [[9, "SIGTERM"]]); // escalation cancelled
    controller.abort(); // listener removed: no second delivery
    await wait(20);
    assert.deepEqual(kills, [[9, "SIGTERM"]]);
  });
});

describe("progress reporter", () => {
  function reporterHarness({ intervalMs = 5_000, clock = 1_000_000 } = {}) {
    const updates = [];
    let now = clock;
    const reporter = createProgressReporter({
      onProgress: async (u) => { updates.push(u); },
      now: () => now,
      intervalMs,
    });
    return { reporter, updates, tick: (ms) => { now += ms; } };
  }

  it("maps content_block_start tool_use to a Using <tool> update", () => {
    const { reporter, updates } = reporterHarness();
    reporter.observeLine(TOOLUSE);
    reporter.dispose();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].phase, "run_activity");
    assert.equal(updates[0].currentToolName, "Bash");
    assert.equal(updates[0].message, "Using Bash");
    assert.equal(updates[0].lastAssistantSnippet, null);
    assert.ok(updates[0].lastEventAt);
  });

  it("maps assistant text to the lastAssistantSnippet", () => {
    const { reporter, updates } = reporterHarness();
    reporter.observeLine(ASSISTANT);
    reporter.dispose();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].currentToolName, null);
    assert.equal(updates[0].lastAssistantSnippet, "Checking the deploy pipeline now");
    assert.equal(updates[0].message, "Checking the deploy pipeline now");
  });

  it("prefers the tool name and keeps the snippet as context", () => {
    const { reporter, updates, tick } = reporterHarness();
    reporter.observeLine(ASSISTANT);
    tick(6_000);
    reporter.observeLine(ASSISTANT_TOOL);
    reporter.dispose();
    assert.equal(updates.length, 2);
    assert.equal(updates[1].currentToolName, "Read");
    assert.equal(updates[1].message, "Using Read");
    assert.equal(updates[1].lastAssistantSnippet, "Checking the deploy pipeline now");
  });

  it("truncates long snippets to 200 chars", () => {
    const { reporter, updates } = reporterHarness();
    const long = `{"type":"assistant","message":{"content":[{"type":"text","text":"${"x".repeat(500)}"}]}}\n`;
    reporter.observeLine(long);
    reporter.dispose();
    assert.equal(updates[0].lastAssistantSnippet.length, 200);
  });

  it("throttles to one update per interval; held state flushes on a later line", () => {
    const { reporter, updates, tick } = reporterHarness({ intervalMs: 1_000 });
    reporter.observeLine(TOOLUSE); // t=0: first update goes out
    reporter.observeLine(ASSISTANT); // t=0: within the window -> held, dirty
    reporter.observeLine(TEXT_BLOCK_START); // t=0: dirty but window not elapsed
    tick(500);
    reporter.observeLine(TEXT_BLOCK_START); // t=500: still inside the window
    assert.equal(updates.length, 1);
    tick(600); // t=1100: window elapsed
    reporter.observeLine(TEXT_BLOCK_START); // unchanged line flushes the held state
    reporter.dispose();
    assert.equal(updates.length, 2);
    assert.equal(updates[1].currentToolName, "Bash"); // tool stays until replaced
    assert.equal(updates[1].lastAssistantSnippet, "Checking the deploy pipeline now");
  });

  it("a fresh change after the window goes out immediately", () => {
    const { reporter, updates, tick } = reporterHarness({ intervalMs: 1_000 });
    reporter.observeLine(TOOLUSE); // sent
    tick(2_000);
    reporter.observeLine(ASSISTANT_TOOL); // tool changed, window elapsed: sent at once
    reporter.dispose();
    assert.equal(updates.length, 2);
    assert.equal(updates[1].currentToolName, "Read");
  });

  it("ignores non-JSON and malformed lines", () => {
    const { reporter, updates } = reporterHarness();
    reporter.observeLine(GARBAGE);
    reporter.observeLine('{"type":"assistant"'); // truncated JSON
    reporter.observeLine("null");
    reporter.observeLine(42);
    reporter.observeLine(undefined);
    reporter.dispose();
    assert.equal(updates.length, 0);
  });

  it("never breaks the caller: sync throw and rejected promise are swallowed", async () => {
    const attempts = [];
    let clock = 1_000_000;
    const reporter = createProgressReporter({
      onProgress: (u) => {
        attempts.push(u.message);
        if (attempts.length === 1) throw new Error("sync boom");
        return Promise.reject(new Error("async boom"));
      },
      now: () => (clock += 6_000), // every observation lands past the window
      intervalMs: 5_000,
    });
    assert.doesNotThrow(() => reporter.observeLine(TOOLUSE));
    reporter.observeLine(ASSISTANT_TOOL); // interval elapsed -> second emit
    await wait(10); // let the rejected promise settle
    reporter.dispose();
    assert.deepEqual(attempts, ["Using Bash", "Using Read"]);
  });
});

describe("protectExecute wiring", () => {
  it("installs the tap, forwards onSpawn, and calls onCancellationReady", async () => {
    const seen = [];
    const spawnMetas = [];
    const ready = [];
    let ctxSeen = null;
    const fakeExecute = async (ctx) => {
      ctxSeen = ctx;
      ctx.onLog("stdout", tt(1) + tt(2));
      ctx.onLog("stdout", RESULT);
      return { exitCode: 0, ok: true };
    };
    const wrapped = protectExecute(fakeExecute, (r) => ({ ...r, repaired: true }));
    const result = await wrapped({
      onLog: (s, c) => seen.push([s, c]),
      onSpawn: async (meta) => { spawnMetas.push(meta); },
      onCancellationReady: async () => { ready.push(true); },
    });
    assert.equal(result.repaired, true);
    assert.equal(ready.length, 1); // awaited before execute
    assert.equal(ctxSeen.onLog.name, "tappedOnLog");
    // Wrapped onSpawn still reaches the original (server persist) seam.
    await ctxSeen.onSpawn({ pid: 4242, processGroupId: 4242, startedAt: "t" });
    assert.deepEqual(spawnMetas, [{ pid: 4242, processGroupId: 4242, startedAt: "t" }]);
    // Burst collapsed (one immediate), held estimate flushed before result.
    const stdout = seen.filter(([s]) => s === "stdout").map(([, c]) => c);
    assert.equal(stdout.length, 3);
    assert.ok(stdout[0].includes('"estimated_tokens":1'));
    assert.ok(stdout[2].includes('"subtype":"success"'));
  });

  it("arms signal cancel: abort inside the run SIGTERMs then SIGKILLs the adopted group", async () => {
    const origGrace = process.env.SHARD_HARNESS_CANCEL_GRACE_MS;
    process.env.SHARD_HARNESS_CANCEL_GRACE_MS = "10";
    try {
      const controller = new AbortController();
      const kills = [];
      const fakeExecute = async (ctx) => {
        await ctx.onSpawn({ pid: 4242, processGroupId: 4242 });
        controller.abort();
        await wait(60); // SIGTERM at once, SIGKILL after the 10ms grace
        return { exitCode: 0 };
      };
      const wrapped = protectExecute(fakeExecute, (r) => r, {
        kill: (pgid, sig) => kills.push([pgid, sig]),
        pollMs: 1,
        verifyMs: 5,
      });
      await wrapped({ onLog: () => { }, signal: controller.signal });
      const sigs = kills.map(([, sig]) => sig);
      assert.deepEqual(sigs.slice(0, 2), ["SIGTERM", "SIGKILL"]);
      assert.ok(sigs.slice(2).every((s) => s === 0)); // MYL-60 receipt probes only
    } finally {
      if (origGrace === undefined) delete process.env.SHARD_HARNESS_CANCEL_GRACE_MS;
      else process.env.SHARD_HARNESS_CANCEL_GRACE_MS = origGrace;
    }
  });

  it("falls back to the pid when no processGroupId is reported", async () => {
    const controller = new AbortController();
    const kills = [];
    const fakeExecute = async (ctx) => {
      await ctx.onSpawn({ pid: 3113 }); // runner without a group id
      controller.abort();
      return { exitCode: 0 };
    };
    const wrapped = protectExecute(fakeExecute, (r) => r, {
      kill: (pgid, sig) => kills.push([pgid, sig]),
      pollMs: 1,
      verifyMs: 5,
    });
    await wrapped({ onLog: () => { }, signal: controller.signal });
    assert.equal(kills[0][0], 3113);
    assert.equal(kills[0][1], "SIGTERM");
    assert.ok(kills.slice(1).every(([pgid, sig]) => pgid === 3113 && sig === 0)); // receipt probes
  });

  it("reports runtime progress from stream-json lines and works without one", async () => {
    const updates = [];
    const withProgress = protectExecute(async (ctx) => {
      ctx.onLog("stdout", TOOLUSE + ASSISTANT + RESULT);
      return { exitCode: 0 };
    }, (r) => r);
    await withProgress({ onLog: () => { }, onRuntimeProgress: async (u) => { updates.push(u); } });
    // One burst: the tool name goes out at once, the snippet is held for the
    // next eligible line (throttle), and the run ends before one arrives.
    assert.equal(updates.length, 1);
    assert.equal(updates[0].phase, "run_activity");
    assert.equal(updates[0].currentToolName, "Bash");
    assert.equal(updates[0].lastAssistantSnippet, null);

    const updates2 = [];
    const withoutProgress = protectExecute(async (ctx) => {
      ctx.onLog("stdout", TOOLUSE);
      return { exitCode: 0 };
    }, (r) => r);
    await withoutProgress({ onLog: () => { } }); // no onRuntimeProgress: reporter absent
    assert.equal(updates2.length, 0);
  });

  it("works without signal, onSpawn, onCancellationReady or runId (legacy ctx)", async () => {
    const fakeExecute = async (ctx) => {
      await ctx.onSpawn({ pid: 1 }); // wrapped onSpawn must stay harmless
      ctx.onLog("stdout", tt(1));
      return { exitCode: 0 };
    };
    const wrapped = protectExecute(fakeExecute, (r) => r);
    const out = await wrapped({ onLog: () => { } });
    assert.equal(out.exitCode, 0);
  });

  it("a onCancellationReady rejection never stops the run", async () => {
    const fakeExecute = async () => ({ exitCode: 0, done: true });
    const wrapped = protectExecute(fakeExecute, (r) => r);
    const out = await wrapped({
      onLog: () => { },
      onCancellationReady: async () => { throw new Error("registration failed"); },
    });
    assert.equal(out.done, true);
  });
});

describe("operator stop receipt (MYL-60)", () => {
  const esrch = () => {
    const err = new Error("kill failed: no such process");
    err.code = "ESRCH";
    throw err;
  };

  it("aborted + group gone (ESRCH on the signal-0 probe) → acknowledged/forced", async () => {
    const probes = [];
    const kill = (pgid, sig) => { probes.push([pgid, sig]); esrch(); };
    const receipt = await operatorStopReceipt({ aborted: true, processGroupId: 4242, kill });
    assert.equal(receipt.state, "acknowledged");
    assert.equal(receipt.forced, true);
    assert.ok(!Number.isNaN(Date.parse(receipt.acknowledgedAt)));
    assert.deepEqual(probes, [[4242, 0]]); // one probe, no polling needed
  });

  it("a group dying mid-poll is caught within the window", async () => {
    let probes = 0;
    const kill = () => { probes += 1; if (probes >= 3) esrch(); }; // alive twice, then gone
    const receipt = await operatorStopReceipt({
      aborted: true, processGroupId: 7, kill, pollMs: 1, verifyMs: 5_000,
    });
    assert.equal(receipt?.state, "acknowledged");
    assert.equal(receipt.forced, true);
    assert.equal(probes, 3);
  });

  it("a group still alive after the window → no receipt (the honest conflict stays)", async () => {
    const kill = () => { }; // probe succeeds: group alive
    const receipt = await operatorStopReceipt({
      aborted: true, processGroupId: 9, kill, pollMs: 1, verifyMs: 8,
    });
    assert.equal(receipt, null);
  });

  it("probe errors other than ESRCH count as alive → no receipt", async () => {
    const kill = (pgid, sig) => {
      if (sig === 0) {
        const err = new Error("operation not permitted");
        err.code = "EPERM";
        throw err;
      }
    };
    const receipt = await operatorStopReceipt({
      aborted: true, processGroupId: 5, kill, pollMs: 1, verifyMs: 5,
    });
    assert.equal(receipt, null);
  });

  it("aborted with no adopted group → acknowledged/forced:false (nothing spawned)", async () => {
    const receipt = await operatorStopReceipt({ aborted: true, processGroupId: null, kill: () => { } });
    assert.equal(receipt.state, "acknowledged");
    assert.equal(receipt.forced, false);
  });

  it("not aborted → null", async () => {
    assert.equal(await operatorStopReceipt({ aborted: false, processGroupId: 1, kill: () => esrch() }), null);
    assert.equal(await operatorStopReceipt({}), null);
  });
});

describe("protectExecute stop-receipt wiring (MYL-60)", () => {
  const esrch = () => {
    const err = new Error("kill failed: no such process");
    err.code = "ESRCH";
    throw err;
  };

  it("an aborted run with a verified-dead group returns executionCancellation acknowledged", async () => {
    const controller = new AbortController();
    const kills = [];
    const kill = (pgid, sig) => {
      kills.push([pgid, sig]);
      if (sig === 0) esrch();
    };
    const fakeExecute = async (ctx) => {
      await ctx.onSpawn({ pid: 4242, processGroupId: 4242 });
      controller.abort();
      return { exitCode: 143, resultJson: { subtype: "success", is_error: false, costUsd: 0.5 } };
    };
    const wrapped = protectExecute(fakeExecute, (r) => r, { kill, pollMs: 1, verifyMs: 50 });
    const result = await wrapped({ onLog: () => { }, signal: controller.signal });
    assert.equal(result.resultJson.executionCancellation.state, "acknowledged");
    assert.equal(result.resultJson.executionCancellation.forced, true);
    assert.ok(!Number.isNaN(Date.parse(result.resultJson.executionCancellation.acknowledgedAt)));
    assert.equal(result.resultJson.subtype, "success"); // CLI result fields survive the merge
    assert.equal(result.resultJson.costUsd, 0.5);
    assert.ok(kills.some(([pgid, sig]) => pgid === 4242 && sig === "SIGTERM"));
    assert.ok(kills.some(([pgid, sig]) => pgid === 4242 && sig === 0));
  });

  it("an aborted run whose group survives keeps the honest no-receipt result", async () => {
    const controller = new AbortController();
    const killsRecorded = [];
    const kill = (pgid, sig) => { if (sig !== 0) killsRecorded.push([pgid, sig]); };
    const fakeExecute = async (ctx) => {
      await ctx.onSpawn({ pid: 8484, processGroupId: 8484 });
      controller.abort();
      return { exitCode: 143, resultJson: { subtype: "error_max_turns" } };
    };
    const wrapped = protectExecute(fakeExecute, (r) => r, { kill, pollMs: 1, verifyMs: 10 });
    const result = await wrapped({ onLog: () => { }, signal: controller.signal });
    assert.equal(result.resultJson.executionCancellation, undefined);
    assert.equal(result.resultJson.subtype, "error_max_turns");
    assert.deepEqual(killsRecorded, [[8484, "SIGTERM"]]); // cancel still ran
  });

  it("an aborted run that never spawned gets acknowledged/forced:false", async () => {
    const controller = new AbortController();
    const fakeExecute = async () => {
      controller.abort();
      return { exitCode: 0, resultJson: {} };
    };
    const wrapped = protectExecute(fakeExecute, (r) => r, { kill: () => { }, pollMs: 1, verifyMs: 5 });
    const result = await wrapped({ onLog: () => { }, signal: controller.signal });
    assert.equal(result.resultJson.executionCancellation.state, "acknowledged");
    assert.equal(result.resultJson.executionCancellation.forced, false);
  });

  it("a non-aborted run result is untouched", async () => {
    const fakeExecute = async () => ({ exitCode: 0, resultJson: { subtype: "success" } });
    const wrapped = protectExecute(fakeExecute, (r) => r, { kill: () => esrch(), pollMs: 1, verifyMs: 5 });
    const result = await wrapped({ onLog: () => { } });
    assert.deepEqual(result, { exitCode: 0, resultJson: { subtype: "success" } });
  });

  it("a null adapter result stays null (the receipt path never throws)", async () => {
    const controller = new AbortController();
    const fakeExecute = async () => { controller.abort(); return null; };
    const wrapped = protectExecute(fakeExecute, (r) => r, { kill: () => esrch(), pollMs: 1, verifyMs: 5 });
    const result = await wrapped({ onLog: () => { }, signal: controller.signal });
    assert.equal(result, null);
  });

  it("a throwing kill probe never breaks the returned result", async () => {
    const controller = new AbortController();
    const fakeExecute = async (ctx) => {
      await ctx.onSpawn({ pid: 99, processGroupId: 99 });
      controller.abort();
      return { exitCode: 143, resultJson: { subtype: "success", is_error: false } };
    };
    const wrapped = protectExecute(fakeExecute, (r) => r, {
      kill: () => { throw new Error("probe exploded"); },
      pollMs: 1,
      verifyMs: 5,
    });
    const result = await wrapped({ onLog: () => { }, signal: controller.signal });
    assert.equal(result.resultJson.subtype, "success");
    assert.equal(result.resultJson.executionCancellation, undefined);
  });

  it("a group ignoring SIGTERM still gets its receipt after the SIGKILL escalation (canary follow-up)", async () => {
    const origGrace = process.env.SHARD_HARNESS_CANCEL_GRACE_MS;
    process.env.SHARD_HARNESS_CANCEL_GRACE_MS = "30";
    try {
      const controller = new AbortController();
      const kills = [];
      let groupAlive = true;
      const kill = (pgid, sig) => {
        kills.push([pgid, sig]);
        if (sig === "SIGKILL") groupAlive = false; // only the escalation kills it
        if (sig === 0 && groupAlive) return;
        if (sig === 0) {
          const err = new Error("kill failed: no such process");
          err.code = "ESRCH";
          throw err;
        }
      };
      const fakeExecute = async (ctx) => {
        await ctx.onSpawn({ pid: 555, processGroupId: 555 });
        controller.abort();
        return { exitCode: 143, resultJson: { stdout: "x", stderr: "y" } };
      };
      const wrapped = protectExecute(fakeExecute, (r) => r, { kill, pollMs: 1, verifyMs: 500 });
      const result = await wrapped({ onLog: () => { }, signal: controller.signal });
      assert.equal(result.resultJson.executionCancellation.state, "acknowledged");
      assert.equal(result.resultJson.executionCancellation.forced, true);
      // The successful ESRCH probe must follow the SIGKILL escalation: dispose
      // no longer cancels the escalation before the receipt verifies.
      const sigs = kills.map(([, s]) => s);
      assert.ok(sigs.indexOf("SIGKILL") !== -1);
      assert.ok(sigs.lastIndexOf(0) > sigs.indexOf("SIGKILL"));
    } finally {
      if (origGrace === undefined) delete process.env.SHARD_HARNESS_CANCEL_GRACE_MS;
      else process.env.SHARD_HARNESS_CANCEL_GRACE_MS = origGrace;
    }
  });
});

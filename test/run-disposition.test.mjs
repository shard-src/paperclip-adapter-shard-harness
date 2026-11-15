// MYL-44 — run-disposition repair tests.
//
// Unit level: repairRunDisposition on synthetic adapter results.
// E2E level: real execute() through the bundled claudeExecute with a stub CLI
// process, so terminal_result_cleanup actually fires (no mocks).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServerAdapter, repairRunDisposition } from "../server/index.js";
import { execute as rawClaudeExecute } from "@paperclipai/adapter-claude-local/server";

const STUB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-harness.mjs");
chmodSync(STUB_PATH, 0o755);

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CLEANUP_EVIDENCE = {
  kind: "terminal_result_cleanup",
  stopped: true,
  stopReason: "unmanaged_background_task_stopped",
  reason: "unmanaged background task stopped; no durable live path",
  terminalResultSeen: true,
  signal: "SIGTERM",
  forceKilled: false,
};

// Shape mirrors what claudeExecute returns for a successful run that got
// SIGTERMed by terminal_result_cleanup (run 9791a680, MYL-43 §8).
function successResultAfterCleanup(overrides = {}) {
  return {
    exitCode: 143,
    signal: null,
    timedOut: false,
    usageComplete: true,
    usage: { inputTokens: 1200, cachedInputTokens: 575000, outputTokens: 3400 },
    usageBasis: "per_run",
    provider: "anthropic",
    biller: "anthropic",
    model: "GLM-5.3",
    billingType: "api",
    costUsd: 0.53,
    errorMessage: null,
    errorCode: "claude_auth_required", // bug B: "unauthorized" skill echo in stdout
    errorFamily: null,
    retryNotBefore: null,
    errorMeta: { loginUrl: "https://claude.ai/oauth/authorize?x=1" },
    sessionId: SESSION_ID,
    sessionParams: { sessionId: SESSION_ID, cwd: "/tmp/ws" },
    sessionDisplayId: SESSION_ID,
    resultJson: {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: SESSION_ID,
      result: "done",
      usage: { input_tokens: 1, cache_read_input_tokens: 575000, output_tokens: 3 },
      total_cost_usd: 0.53,
      unmanagedBackgroundTask: CLEANUP_EVIDENCE,
    },
    summary: "done",
    clearSession: false,
    ...overrides,
  };
}

function testContext(config = {}, scenario = "success-linger") {
  return {
    runId: "test-run",
    agent: { id: "agent-test", companyId: "company-test", adapterType: "claude_local" },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      engine: "cli",
      command: STUB_PATH,
      terminalResultCleanupGraceMs: 150,
      graceSec: 1,
      timeoutSec: 30,
      extraArgs: [scenario],
      ...config,
    },
    context: {},
    onLog: async () => {},
  };
}

describe("repairRunDisposition (unit)", () => {
  it("bug A+B: success result after cleanup SIGTERM (exit 143) is settled as success, no errorCode", () => {
    const repaired = repairRunDisposition(successResultAfterCleanup());
    assert.equal(repaired.exitCode, 0);
    assert.equal(repaired.signal, null);
    assert.equal(repaired.errorCode, null);
    assert.equal(repaired.errorFamily, null);
    assert.equal(repaired.errorMessage, null);
    assert.equal(repaired.errorMeta, null);
    assert.equal(repaired.retryNotBefore, null);
    // Work evidence is preserved.
    assert.equal(repaired.resultJson.subtype, "success");
    assert.equal(repaired.costUsd, 0.53);
    assert.equal(repaired.sessionId, SESSION_ID);
  });

  it("bug A edge: unparsed result with terminalResultSeen is settled as success (no parsed error fields)", () => {
    const repaired = repairRunDisposition({
      exitCode: 137,
      signal: "SIGKILL",
      timedOut: false,
      costUsd: null,
      errorMessage: "Claude exited with code 137",
      errorCode: null,
      resultJson: {
        stdout: '{"type":"result","subtype":"success","is_error":false,"result":"done"}',
        stderr: "",
        unmanagedBackgroundTask: { ...CLEANUP_EVIDENCE, signal: "SIGKILL", forceKilled: true },
      },
      clearSession: false,
    });
    assert.equal(repaired.exitCode, 0);
    assert.equal(repaired.signal, null);
    assert.equal(repaired.errorCode, null);
    assert.equal(repaired.errorMessage, null);
  });

  it("parsed error result is never promoted to success even with terminalResultSeen", () => {
    const repaired = repairRunDisposition(successResultAfterCleanup({
      exitCode: 1,
      errorCode: null,
      errorMeta: null,
      errorMessage: "Claude run failed: subtype=error: boom",
      resultJson: {
        type: "result",
        subtype: "error",
        is_error: true,
        session_id: SESSION_ID,
        result: "boom",
        unmanagedBackgroundTask: CLEANUP_EVIDENCE,
      },
    }));
    assert.equal(repaired.exitCode, 1);
    assert.equal(repaired.errorMessage, "Claude run failed: subtype=error: boom");
  });

  it("bug B: auth_required from stdout-only echo on a failed run is suppressed", () => {
    const repaired = repairRunDisposition({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude run failed: subtype=error: API Error: 500 upstream exploded",
      errorCode: "claude_auth_required",
      errorFamily: null,
      resultJson: {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "API Error: 500 upstream exploded",
        // raw stdout echo is not part of resultJson in the parsed path; the
        // adapter-level stderr is empty, so no terminal auth marker exists
        stderr: "",
      },
    });
    assert.equal(repaired.errorCode, null);
    assert.equal(repaired.errorMeta, null);
    assert.match(repaired.errorMessage, /upstream exploded/);
  });

  it("bug B: genuine terminal auth failure keeps claude_auth_required", () => {
    const repaired = repairRunDisposition({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude run failed: subtype=error: Invalid API key · Please run /login",
      errorCode: "claude_auth_required",
      errorFamily: null,
      errorMeta: { loginUrl: "https://claude.ai/oauth/authorize?x=1" },
      resultJson: {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Invalid API key · Please run /login",
      },
    });
    assert.equal(repaired.errorCode, "claude_auth_required");
    assert.deepEqual(repaired.errorMeta, { loginUrl: "https://claude.ai/oauth/authorize?x=1" });
  });

  it("bug B: token-failure marker in parsed error fields keeps claude_auth_required", () => {
    const repaired = repairRunDisposition({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude run failed: subtype=error: authentication failed: access token expired",
      errorCode: "claude_auth_required",
      resultJson: {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "authentication failed: access token expired",
      },
    });
    assert.equal(repaired.errorCode, "claude_auth_required");
  });

  it("bug C: credit usage limit maps to provider_quota with errorFamily", () => {
    const repaired = repairRunDisposition({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude run failed: subtype=error: You've reached your credit usage limit. Please upgrade.",
      errorCode: null,
      errorFamily: null,
      resultJson: {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "You've reached your credit usage limit. Please upgrade.",
      },
    });
    assert.equal(repaired.errorCode, "provider_quota");
    assert.equal(repaired.errorFamily, "provider_quota");
  });

  it("bug C: 429 [1302] Rate limit reached maps to claude_transient_upstream", () => {
    const repaired = repairRunDisposition({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: 'Claude run failed: subtype=error: API Error: 429 [1302] Rate limit reached',
      errorCode: "claude_auth_required", // unstable upstream classification
      errorFamily: null,
      errorMeta: { loginUrl: "https://claude.ai/oauth/authorize?x=1" },
      resultJson: {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "API Error: 429 [1302] Rate limit reached",
        stderr: "",
      },
    });
    assert.equal(repaired.errorCode, "claude_transient_upstream");
    assert.equal(repaired.errorFamily, "transient_upstream");
    assert.equal(repaired.errorMeta, null);
  });

  it("bug C: quota outranks transient when a credit-limit body embeds 429", () => {
    const repaired = repairRunDisposition({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: 'Claude run failed: subtype=error: API Error: 429 You\'ve reached your credit usage limit.',
      errorCode: "claude_transient_upstream", // upstream transient classification
      errorFamily: "transient_upstream",
      resultJson: {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "API Error: 429 You've reached your credit usage limit.",
      },
    });
    assert.equal(repaired.errorCode, "provider_quota");
    assert.equal(repaired.errorFamily, "provider_quota");
  });

  it("leaves timeouts untouched", () => {
    const original = {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      errorMessage: "Timed out after 30s",
      errorCode: "timeout",
      resultJson: {},
    };
    assert.deepEqual(repairRunDisposition(original), original);
  });

  it("leaves max_turns and refusal codes untouched", () => {
    for (const errorCode of ["max_turns_exhausted", "claude_refusal", "claude_poisoned_previous_message_id", "model_not_found"]) {
      const original = {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "x",
        errorCode,
        resultJson: { type: "result", subtype: "error", is_error: true, result: "x" },
      };
      assert.deepEqual(repairRunDisposition(original), original, errorCode);
    }
  });

  it("plain success with exit 0 stays clean", () => {
    const repaired = repairRunDisposition(successResultAfterCleanup({ exitCode: 0, errorCode: null, errorMeta: null }));
    assert.equal(repaired.exitCode, 0);
    assert.equal(repaired.errorCode, null);
    assert.equal(repaired.resultJson.subtype, "success");
  });
});

describe("execute (e2e, real process + terminal_result_cleanup)", () => {
  it("raw claudeExecute reproduces bug A+B: exit 143 + claude_auth_required on a successful run", async () => {
    // No repair: the upstream adapter misclassifies exactly as in production.
    const result = await rawClaudeExecute(testContext({}));
    assert.equal(result.exitCode, 143);
    assert.equal(result.errorCode, "claude_auth_required");
    assert.equal(result.resultJson?.subtype, "success");
  });

  it("adapter execute settles the cleanup-SIGTERM success run with no errorCode", async () => {
    const adapter = createServerAdapter();
    const result = await adapter.execute(testContext({}));
    assert.equal(result.exitCode, 0, JSON.stringify({ exitCode: result.exitCode, errorCode: result.errorCode, errorMessage: result.errorMessage }));
    assert.equal(result.signal, null);
    assert.equal(result.errorCode, null);
    assert.equal(result.errorMessage, null);
    assert.equal(result.resultJson?.subtype, "success");
    assert.equal(result.costUsd, 0.53);
  });

  it("quota failure maps to provider_quota", async () => {
    const adapter = createServerAdapter();
    const result = await adapter.execute(testContext({}, "quota"));
    assert.equal(result.errorCode, "provider_quota", JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }));
    assert.equal(result.errorFamily, "provider_quota");
  });

  it("rate-limit failure maps to claude_transient_upstream", async () => {
    const adapter = createServerAdapter();
    const result = await adapter.execute(testContext({}, "rate-limit"));
    assert.equal(result.errorCode, "claude_transient_upstream", JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }));
    assert.equal(result.errorFamily, "transient_upstream");
  });

  it("genuine auth failure still classifies as claude_auth_required", async () => {
    const adapter = createServerAdapter();
    const result = await adapter.execute(testContext({}, "auth-invalid-key"));
    assert.equal(result.errorCode, "claude_auth_required", JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }));
  });
});

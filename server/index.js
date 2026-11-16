import {
  execute as claudeExecute,
  testEnvironment as claudeTestEnvironment,
  sessionCodec,
  listClaudeSkills,
  syncClaudeSkills,
} from "@paperclipai/adapter-claude-local/server";

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

export const type = "claude_local";
export const label = "Shard Harnesses (Z.ai GLM)";

// Qoder support was removed (subscription cancelled, adapter uninstalled):
// only the Z.ai GLM coding-plan lane remains. Legacy "qoder" harness values
// fall back to plain Claude Code.
const ZAI_MODELS = [
  { id: "GLM-5.3", label: "Z.ai: GLM 5.3 — full reasoning" },
  { id: "GLM-5.3-Flash", label: "Z.ai: GLM 5.3 Flash — fast, cheap" },
];

export const models = [...ZAI_MODELS];

const ZAI_IDS = new Set(ZAI_MODELS.map((m) => m.id));

// ── Run-disposition repair (MYL-44) ───────────────────────────────────────────
//
// Upstream claudeExecute (adapter-claude-local 2026.1106.0) misclassifies
// healthy runs in three systematic ways on the Z.ai GLM lane:
//
//   A) Liveness-kill + false failed. When the CLI has printed its terminal
//      result event but the process lingers (open MCP/HTTP handles),
//      terminal_result_cleanup SIGTERMs it and the process exits 143 (or dies
//      by signal). The server settles a run as succeeded only on exitCode 0
//      with no signal and no errorMessage, so a fully successful run is
//      recorded as failed.
//   B) False claude_auth_required. detectClaudeLoginRequired tests EVERY
//      stdout line against CLAUDE_LOGIN_PROMPT_RE, whose alternatives include
//      the bare word "unauthorized". Transcript echo of skill texts ("rejects
//      unknown or unauthorized recipients") therefore flips finished runs to
//      claude_auth_required and the UI shows "Login to Claude Code".
//   C) Z.ai quota/rate-limit texts unmapped. "You've reached your credit
//      usage limit" misses CLAUDE_PROVIDER_QUOTA_RE (no "credit" alternative),
//      landing as a generic adapter_failed; 429 "[1302] Rate limit reached"
//      unstably surfaces as claude_auth_required whenever (B) fires first.
//
// repairRunDisposition post-processes the adapter result WITHOUT masking
// genuine auth failures: a claude_auth_required survives whenever the login
// marker also appears in terminal fields (parsed result error text, adapter
// fallback message, CLI stderr) — the channels the CLI actually reports auth
// problems on — and is dropped only when it matched transcript echo in stdout.

// Verbatim from claude-local dist/server/parse.js @ 2026.1106.0 (the
// dependency is exact-pinned in package.json; re-diff these when bumping).
const CLAUDE_LOGIN_PROMPT_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i;
const CLAUDE_AUTH_TOKEN_FAILURE_RE = /(?:authentication[_\s-](?:failed|error)|failed\s+to\s+authenticate|invalid\s+bearer\s+token|(?:invalid|expired|revoked)[\s\S]{0,40}(?:bearer|oauth|access)\s+token|(?:bearer|oauth|access)\s+token[\s\S]{0,40}(?:is\s+)?(?:invalid|expired|revoked))/i;

// Z.ai (GLM coding plan) failure texts upstream claude-local does not know.
const ZAI_PROVIDER_QUOTA_RE = /credit\s+usage\s+limit|you(?:'|’)ve\s+reached\s+your\s+credit/i;
const ZAI_TRANSIENT_UPSTREAM_RE = /\b429\b|\[1302\]\s*rate\s+limit|rate[-\s]?limit(?:ed)?\s+reached|too\s+many\s+requests/i;

function boolish(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

// Success predicate mirroring upstream parsedSucceeded: subtype "success"
// without an error flag.
function parsedTerminalSuccess(resultJson) {
  if (!resultJson || typeof resultJson !== "object") return false;
  const subtype = asText(resultJson.subtype).trim().toLowerCase();
  return subtype === "success" && !boolish(resultJson.is_error);
}

// terminal_result_cleanup evidence recorded by the upstream execute seam.
function terminalResultSeen(resultJson) {
  const evidence = resultJson?.unmanagedBackgroundTask;
  return evidence?.terminalResultSeen === true;
}

function claudeErrorMessages(resultJson) {
  const raw = Array.isArray(resultJson?.errors) ? resultJson.errors : [];
  const messages = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const msg = [entry.message, entry.error, entry.code]
      .find((value) => typeof value === "string" && value.trim().length > 0);
    messages.push(msg?.trim() || JSON.stringify(entry));
  }
  return messages;
}

// Parsed terminal fields indicate the run itself failed (mirrors the upstream
// claudeResultIndicatesAuthFailure gate).
function parsedIndicatesFailure(resultJson) {
  if (!resultJson || typeof resultJson !== "object") return false;
  const subtype = asText(resultJson.subtype).trim().toLowerCase();
  const status = Number(resultJson.api_error_status) || Number(resultJson.error_status) || 0;
  return boolish(resultJson.is_error)
    || subtype.startsWith("error")
    || asText(resultJson.error).trim().length > 0
    || claudeErrorMessages(resultJson).length > 0
    || status === 401
    || status === 403;
}

// Everything the CLI/adapter reports OUTSIDE the raw stdout transcript:
// parsed terminal result fields, the adapter fallback message, CLI stderr.
// Raw stdout is exactly the channel whose transcript echo causes bug B, so it
// is deliberately excluded here.
function terminalFailureText(result, resultJson) {
  return [
    asText(resultJson?.subtype),
    asText(resultJson?.result),
    asText(resultJson?.error),
    asText(resultJson?.message),
    ...claudeErrorMessages(resultJson),
    asText(result?.errorMessage),
    asText(resultJson?.stderr),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

// Bug C: map Z.ai provider quota / transient rate-limit texts to typed codes.
// Quota outranks transient: a credit-exhaustion body that embeds 429 must not
// be retried as a transient upstream blip.
function zaiFailurePatch(result, resultJson) {
  const text = terminalFailureText(result, resultJson);
  if (ZAI_PROVIDER_QUOTA_RE.test(text)) {
    return { errorCode: "provider_quota", errorFamily: "provider_quota" };
  }
  if (ZAI_TRANSIENT_UPSTREAM_RE.test(text)
    && (result.errorCode == null || result.errorCode === "adapter_failed")) {
    return { errorCode: "claude_transient_upstream", errorFamily: "transient_upstream" };
  }
  return null;
}

export function repairRunDisposition(result) {
  if (!result || typeof result !== "object") return result;
  // Real timeouts keep their own disposition; the native lane classifies itself.
  if (result.timedOut || result.nativeFinalization) return result;
  const resultJson = result.resultJson && typeof result.resultJson === "object" ? result.resultJson : {};

  // Bug A (and bug B on success runs): the terminal result says success. The
  // server settles succeeded only on exitCode 0 with no signal and no
  // errorMessage, so a cleanup SIGTERM (exit 143) must not leak through and
  // neither may an errorCode derived from the wide stdout scan. The
  // terminalResultSeen arm covers the unparsed edge (result seen but the final
  // flush was killed) and is honored only when the parsed fields do NOT
  // describe an error, so a real error result is never promoted to success.
  if (parsedTerminalSuccess(resultJson) || (terminalResultSeen(resultJson) && !parsedIndicatesFailure(resultJson))) {
    return {
      ...result,
      exitCode: 0,
      signal: null,
      errorMessage: null,
      errorCode: null,
      errorFamily: null,
      retryNotBefore: null,
      errorMeta: null,
    };
  }

  // Failed runs: keep genuine auth failures (marker visible in terminal
  // fields), drop wide-scan-only ones, and map Z.ai quota/rate-limit texts.
  if (result.errorCode === "claude_auth_required") {
    const text = terminalFailureText(result, resultJson);
    const terminalAuth = CLAUDE_LOGIN_PROMPT_RE.test(text)
      || (parsedIndicatesFailure(resultJson) && CLAUDE_AUTH_TOKEN_FAILURE_RE.test(text));
    if (terminalAuth) return result;
    // The auth code was wide-scan noise: strip it, then reclassify.
    const patch = zaiFailurePatch({ ...result, errorCode: null }, resultJson);
    return { ...result, errorMeta: null, errorCode: null, errorFamily: null, ...(patch ?? {}) };
  }
  if (result.errorCode == null || result.errorCode === "adapter_failed" || result.errorCode === "claude_transient_upstream") {
    const patch = zaiFailurePatch(result, resultJson);
    if (patch && (patch.errorCode !== result.errorCode || patch.errorFamily !== result.errorFamily)) {
      return { ...result, ...patch };
    }
  }
  return result;
}

// Routing: GLM ids run through Claude Code against the Z.ai Messages API;
// anything else falls back to the agent's configured harness (or plain
// Claude Code). A leftover harness="qoder" is treated as the claude fallback.
function routeFor(config) {
  const model = String(config?.model ?? "").trim();
  if (ZAI_IDS.has(model)) return "zai";
  if (config?.harness === "zai") return "zai";
  return "claude";
}

function withDefaults(ctx) {
  const config = { ...(ctx.config ?? {}) };
  const route = routeFor(config);
  config.engine = "cli";
  if (route === "zai") {
    if (!config.command) config.command = "claude";
    if (!config.model) config.model = "GLM-5.3";
    const env = { ...(config.env ?? {}) };
    if (!env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = ZAI_BASE_URL;
    if (!env.API_TIMEOUT_MS) env.API_TIMEOUT_MS = "600000";
    config.env = env;
  }
  return { ...ctx, config, route };
}

export async function testEnvironment(ctx) {
  return claudeTestEnvironment(withDefaults(ctx));
}

export function getConfigSchema() {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        default: "GLM-5.3",
        options: models.map((m) => ({ value: m.id, label: m.label })),
        hint: "GLM ids run through Claude Code against the Z.ai Messages API; anything else runs plain Claude Code.",
      },
      {
        key: "harness",
        label: "Fallback harness",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Infer from model" },
          { value: "zai", label: "Z.ai GLM (Claude Code)" },
          { value: "claude", label: "Plain Claude Code" },
        ],
        hint: "Used only when the model id is not in the Z.ai catalog.",
      },
      {
        key: "effort",
        label: "Reasoning effort",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Model default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Skip permission prompts",
        type: "boolean",
        default: true,
        hint: "Required for autonomous headless runs. Govern work with Paperclip budgets and approvals.",
      },
      { key: "timeoutSec", label: "Run timeout (seconds)", type: "number", default: 0 },
      { key: "graceSec", label: "SIGTERM grace (seconds)", type: "number", default: 15 },
    ],
  };
}

export const agentConfigurationDoc = `# Shard Harnesses — claude_local override

This adapter overrides Paperclip's built-in claude_local harness so that the
per-task model picker (composer "custom model" lane) works with the Z.ai GLM
coding plan. Pause the override (Adapters → claude_local → pause) to restore
the built-in implementation.

## Routing

| Model id | Execution |
|----------|-----------|
| GLM-5.3, GLM-5.3-Flash | Claude Code CLI → https://api.z.ai/api/anthropic |
| anything else | fallback harness field, else plain Claude Code |

A per-task model override therefore also switches the API endpoint for that
run. Qoder support was removed (subscription cancelled); a leftover
harness="qoder" value falls back to plain Claude Code.

## Prerequisites

- Claude Code CLI: npm install -g @anthropic-ai/claude-code
- Z.ai coding plan key as a company secret, referenced from the agent env:
  env.ANTHROPIC_AUTH_TOKEN = { "type": "secret_ref", "secretId": "<uuid>" }
  (set it on every agent that may receive a GLM model override)

## Fields

model, harness (fallback), effort, dangerouslySkipPermissions, timeoutSec,
graceSec, command, env.

## Run disposition repair

Run results are post-processed (repairRunDisposition) to stop upstream
claude_local misclassification:

- A successful terminal result (subtype=success, is_error=false) — or a run
  whose result event was seen before terminal_result_cleanup SIGTERMed a
  lingering process (exit 143 / signal) — is settled as success with a clean
  exit status; no errorCode/errorMessage leaks to the UI.
- claude_auth_required is kept only when the login marker appears in terminal
  fields (parsed result error text, fallback message, CLI stderr); a marker
  that only matched transcript echo in stdout is dropped.
- Z.ai failure texts are mapped: "credit usage limit" → provider_quota;
  429 / "[1302] Rate limit reached" → claude_transient_upstream. Genuine auth
  failures (revoked token, terminal authorization errors) still classify as
  claude_auth_required.
`;

export function createServerAdapter() {
  return {
    type,
    label,
    runtimeToolDelivery: "native_mcp",
    execute: (ctx) => claudeExecute(withDefaults(ctx)).then(repairRunDisposition),
    testEnvironment,
    models,
    listModels: async () => models,
    refreshModels: async () => models,
    sessionCodec,
    sessionManagement: {
      supportsSessionResume: true,
      nativeContextManagement: "confirmed",
    },
    listSkills: listClaudeSkills,
    syncSkills: syncClaudeSkills,
    getConfigSchema,
    supportsToolRefreshOnResume: true,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec: (config) => ({
      command: config?.command || "claude",
      detectCommand: "claude",
      installCommand: null,
    }),
    agentConfigurationDoc,
  };
}
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  execute as claudeExecute,
  testEnvironment as claudeTestEnvironment,
  sessionCodec,
  listClaudeSkills,
  syncClaudeSkills,
} from "@paperclipai/adapter-claude-local/server";

const require = createRequire(import.meta.url);
const { parseStdoutLine } = require("../ui-parser.cjs");

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM_PATH = path.join(PACKAGE_ROOT, "bin", "claude");
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

export const type = "claude_local";
export const label = "Shard Harnesses (Qoder + Z.ai)";

const QODER_MODELS = [
  { id: "Auto", label: "Qoder: Auto — smart routing (~1.0x)" },
  { id: "Cantus", label: "Qoder: Cantus — top agentic coding (premium)" },
  { id: "Ultimate", label: "Qoder: Ultimate — deep reasoning (~1.6x)" },
  { id: "Efficient", label: "Qoder: Efficient — routine, cheap (~0.3x)" },
  { id: "Sonus", label: "Qoder: Sonus — flagship, very expensive (~8x)" },
  { id: "Qwen4-Max-Preview", label: "Qoder: Qwen4 Max Preview" },
  { id: "Qwen3.8-Max", label: "Qoder: Qwen3.8 Max (~0.5x)" },
  { id: "Qwen3.8-Flash", label: "Qoder: Qwen3.8 Flash" },
  { id: "Kimi-K3.1-Pro", label: "Qoder: Kimi K3.1 Pro (~0.8x)" },
  { id: "Kimi-K2.8-Preview", label: "Qoder: Kimi K2.8 Preview" },
  { id: "DeepSeek-V4-Pro", label: "Qoder: DeepSeek V4 Pro (~0.8x)" },
  { id: "DeepSeek-Flash", label: "Qoder: DeepSeek Flash (~0.3x)" },
  { id: "MiniMax-M3.1-Flash", label: "Qoder: MiniMax M3.1 Flash (~0.2x)" },
];

const ZAI_MODELS = [
  { id: "GLM-5.3", label: "Z.ai: GLM 5.3 — full reasoning" },
  { id: "GLM-5.3-Flash", label: "Z.ai: GLM 5.3 Flash — fast, cheap" },
];

export const models = [...QODER_MODELS, ...ZAI_MODELS];

const QODER_IDS = new Set(QODER_MODELS.map((m) => m.id));
const ZAI_IDS = new Set(ZAI_MODELS.map((m) => m.id));

// Routing: Qoder-exclusive model ids run through qodercli; GLM ids run through
// Claude Code against the Z.ai Messages API; anything else falls back to the
// agent's configured harness (or plain Claude Code).
function routeFor(config) {
  const model = String(config?.model ?? "").trim();
  if (QODER_IDS.has(model)) return "qoder";
  if (ZAI_IDS.has(model)) return "zai";
  if (config?.harness === "qoder") return "qoder";
  if (config?.harness === "zai") return "zai";
  return "claude";
}

function withDefaults(ctx) {
  const config = { ...(ctx.config ?? {}) };
  const route = routeFor(config);
  config.engine = "cli";
  if (route === "qoder") {
    if (!config.command) config.command = SHIM_PATH;
    if (!config.model) config.model = "Auto";
    const extraArgs = Array.isArray(config.extraArgs) ? [...config.extraArgs] : [];
    if (config.contextWindow && !extraArgs.includes("--context-window")) {
      extraArgs.push("--context-window", String(config.contextWindow));
    }
    if (extraArgs.length > 0) config.extraArgs = extraArgs;
  } else if (route === "zai") {
    if (!config.command) config.command = "claude";
    if (!config.model) config.model = "GLM-5.3";
    const env = { ...(config.env ?? {}) };
    if (!env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = ZAI_BASE_URL;
    if (!env.API_TIMEOUT_MS) env.API_TIMEOUT_MS = "600000";
    config.env = env;
  }
  return { ...ctx, config, route };
}

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runHelloProbe(command, env, timeoutSec) {
  return new Promise((resolve) => {
    execFile(
      command,
      ["--print", "--output-format", "stream-json", "--dangerously-skip-permissions", "Reply with exactly: ok"],
      { timeout: timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024, env },
      (error, stdout, stderr) => resolve({ error, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

async function qoderTestEnvironment(ctx) {
  const { config } = withDefaults(ctx);
  const checks = [];
  const timeoutSec = Number(config.helloProbeTimeoutSec) > 0 ? Number(config.helloProbeTimeoutSec) : 60;
  if (!(await isExecutable(config.command))) {
    checks.push({ code: "qoder_command_unresolvable", level: "error", message: `Shim is not executable: ${config.command}` });
    return { status: "fail", checks };
  }
  checks.push({ code: "qoder_command_resolvable", level: "info", message: `Shim is executable: ${config.command}` });
  const qoderBin = config.env?.QODER_CLI_PATH || process.env.QODER_CLI_PATH || "qodercli";
  const env = { ...process.env, ...(config.env ?? {}), QODER_CLI_PATH: qoderBin };
  const probe = await runHelloProbe(config.command, env, timeoutSec);
  const events = probe.stdout.split("\n").flatMap((line) => (line.trim() ? parseStdoutLine(line, Date.now()) : []));
  const result = events.find((e) => e.kind === "result");
  if (result && !result.isError) {
    checks.push({ code: "qoder_hello_probe_passed", level: "info", message: "Qoder CLI hello probe succeeded.", detail: result.text?.slice(0, 200) });
    return { status: "pass", checks };
  }
  checks.push({
    code: probe.error?.code === "ETIMEDOUT" ? "qoder_hello_probe_timed_out" : "qoder_hello_probe_failed",
    level: "error",
    message: "Qoder CLI hello probe failed. Sign in with `qodercli login` on the Paperclip host.",
    detail: (probe.stderr || probe.stdout || String(probe.error ?? "")).slice(-400),
  });
  return { status: "fail", checks };
}

export async function testEnvironment(ctx) {
  const routed = withDefaults(ctx);
  if (routed.route === "qoder") return qoderTestEnvironment(ctx);
  return claudeTestEnvironment(routed);
}

export function getConfigSchema() {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        default: "Auto",
        options: models.map((m) => ({ value: m.id, label: m.label })),
        hint: "Qoder ids run through qodercli; GLM ids run through Claude Code against Z.ai. Per-task overrides switch provider automatically.",
      },
      {
        key: "harness",
        label: "Fallback harness",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Infer from model" },
          { value: "qoder", label: "Qoder CLI" },
          { value: "zai", label: "Z.ai GLM (Claude Code)" },
          { value: "claude", label: "Plain Claude Code" },
        ],
        hint: "Used only when the model id is not in the Qoder/Z.ai catalogs.",
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
        key: "contextWindow",
        label: "Context window (Qoder)",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Model default" },
          { value: "200000", label: "200K" },
          { value: "400000", label: "400K" },
          { value: "1000000", label: "1M" },
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
per-task model picker (composer "custom model" lane) works with Qoder and
Z.ai GLM coding plans. Pause the override (Adapters → claude_local → pause)
to restore the built-in implementation.

## Routing

| Model id | Execution |
|----------|-----------|
| Auto, Cantus, Ultimate, Efficient, Sonus, Qwen*, Kimi*, DeepSeek*, MiniMax* | qodercli via bundled shim |
| GLM-5.3, GLM-5.3-Flash | Claude Code CLI → https://api.z.ai/api/anthropic |
| anything else | fallback harness field, else plain Claude Code |

A per-task model override therefore also switches provider for that run.

## Prerequisites

- Qoder CLI signed in on the host: qodercli login (PATH or QODER_CLI_PATH)
- Claude Code CLI: npm install -g @anthropic-ai/claude-code
- Z.ai coding plan key as a company secret, referenced from the agent env:
  env.ANTHROPIC_AUTH_TOKEN = { "type": "secret_ref", "secretId": "<uuid>" }
  (set it on every agent that may receive a GLM model override)

## Fields

model, harness (fallback), effort, contextWindow (Qoder),
dangerouslySkipPermissions, timeoutSec, graceSec, command, env.
`;

export function createServerAdapter() {
  return {
    type,
    label,
    runtimeToolDelivery: "native_mcp",
    execute: (ctx) => claudeExecute(withDefaults(ctx)),
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
      command: config?.command || (routeFor(config) === "qoder" ? SHIM_PATH : "claude"),
      detectCommand: routeFor(config) === "qoder" ? (process.env.QODER_CLI_PATH || "qodercli") : "claude",
      installCommand: null,
    }),
    agentConfigurationDoc,
  };
}
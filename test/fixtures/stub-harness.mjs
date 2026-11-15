#!/usr/bin/env node
// Stub "claude CLI" for local run-disposition tests. Usage:
//   stub-harness.mjs <scenario>
// Scenarios: success-linger | quota | rate-limit | auth-invalid-key
//
// success-linger mimics the production bug-A shape: the CLI prints its
// terminal result event, then lingers on an open handle, terminal_result_cleanup
// SIGTERMs it, and the process exits 143 (SIGTERM caught, like the real CLI).
// The assistant text deliberately contains the word "unauthorized" (bug B:
// Paperclip skill text echoed into the transcript).
import fs from "node:fs";

// The scenario token arrives via extraArgs somewhere among the CLI's own
// flags, so scan argv instead of relying on a fixed position.
const SCENARIOS = ["success-linger", "quota", "rate-limit", "auth-invalid-key"];
const scenario = process.argv.find((arg) => SCENARIOS.includes(arg)) ?? "success-linger";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

fs.readFileSync(0, "utf8"); // consume the stdin prompt like the real CLI

const out = (event) => console.log(JSON.stringify(event));

out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "stub-model" });

if (scenario === "success-linger") {
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: {
      id: "msg_1",
      content: [{ type: "text", text: "The server rejects unknown or unauthorized recipients" }],
    },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SESSION_ID,
    result: "ok",
    usage: { input_tokens: 1, cache_read_input_tokens: 575000, output_tokens: 3 },
    total_cost_usd: 0.53,
  });
  process.on("SIGTERM", () => process.exit(143)); // real CLI exits 143 on SIGTERM
  const linger = setTimeout(() => {}, 60_000);
  linger.unref?.();
  setInterval(() => {}, 1_000); // keep the event loop alive until SIGTERM
} else if (scenario === "quota") {
  out({
    type: "result",
    subtype: "error",
    is_error: true,
    session_id: SESSION_ID,
    result: 'API Error: 429 {"error":{"code":"1302"}} You\'ve reached your credit usage limit.',
  });
  process.exit(1);
} else if (scenario === "rate-limit") {
  out({
    type: "result",
    subtype: "error",
    is_error: true,
    session_id: SESSION_ID,
    result: "API Error: 429 {\"error\":{\"code\":\"1302\",\"message\":\"[1302] Rate limit reached\"}}",
  });
  process.exit(1);
} else if (scenario === "auth-invalid-key") {
  out({
    type: "result",
    subtype: "error",
    is_error: true,
    session_id: SESSION_ID,
    result: "Invalid API key · Please run /login",
  });
  process.exit(1);
} else {
  console.error(`unknown scenario: ${scenario}`);
  process.exit(2);
}

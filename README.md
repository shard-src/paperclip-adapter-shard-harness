# @shard-src/paperclip-adapter-shard-harness

**Z.ai GLM** harness override for
[Paperclip](https://github.com/paperclipai/paperclip)'s built-in `claude_local`
adapter.

## Why an override?

Paperclip's per-task model picker (the composer's custom-model lane) is
currently limited to the built-in `claude_local`, `codex_local` and
`opencode_local` harnesses. External adapter types get agent-level model
selection but not per-task overrides. Paperclip's adapter registry explicitly
supports external overrides of built-in types (with pause/rollback), so this
plugin registers as `claude_local` and routes each run by model id:

| Model id | Execution |
|----------|-----------|
| `GLM-5.3`, `GLM-5.3-Flash` | Claude Code CLI → `https://api.z.ai/api/anthropic` |
| anything else | `harness` fallback field, else plain Claude Code |

Because routing follows the model id, **a per-task model override also
switches the API endpoint for that run**.

Qoder support was removed in v1.2.0 (subscription cancelled, adapter
uninstalled); a leftover `harness: "qoder"` value falls back to plain
Claude Code. Companion standalone adapter:
[@shard-src/paperclip-adapter-zai](https://github.com/shard-src/paperclip-adapter-zai).

## Run protection (v1.4.0)

Three wrapper-level guards around the vendored upstream `claudeExecute`
(adapter-claude-local 2026.1106.0), all in [`server/run-protection.js`](server/run-protection.js):

- **Signal-based cancel.** Upstream never touches `ctx.signal`: an operator
  cancel (or budget cancel) marks the run cancelled and aborts the run's
  `AbortSignal`, but the CLI process keeps streaming — burning provider-plan
  tokens — and holds the agent slot, so queued comments and accepted retries
  do not dispatch until the process exits on its own. The wrapper adopts the
  CLI process group from `ctx.onSpawn`, announces cancel-readiness via
  `ctx.onCancellationReady` (the server aborts `ctx.signal` only for runs
  whose adapter registered an execution control), and kills the process group
  when `ctx.signal` aborts: `SIGTERM`, then `SIGKILL` after a 10 s grace.
  Without a signal (older server) the guard stays inert. This replaces the
  v1.3.0 DB watchdog — no more run-row polling, and the `pg` dependency is
  gone.
- **Runtime progress reporter.** Upstream reports live progress only for
  remote sandbox targets, so local runs show no activity. The reporter watches
  the stream-json lines already flowing through the log tap and calls
  `ctx.onRuntimeProgress` with phase `run_activity`: the running tool name
  (`Using Bash`) and the last assistant snippet (first ~200 characters). At
  most one update per 5 s; a change held back by the throttle flushes with the
  next observed line after the window. Reporter failures never affect the run.
- **thinking_tokens log tap.** The CLI emits one
  `{"type":"system","subtype":"thinking_tokens",...}` event per streaming
  delta — ~5 events per thinking token, 91–95 % of stored run-log bytes. The
  tap forwards at most one event per 15 s window (the latest estimate), keeping
  run logs readable while preserving the recent-output liveness signal.

All guards are best-effort: any internal failure disables the guard without
affecting the run.

### Environment overrides

| Variable | Default | Meaning |
|----------|---------|---------|
| `SHARD_HARNESS_CANCEL_GRACE_MS` | `10000` | SIGTERM → SIGKILL grace on cancel |
| `SHARD_HARNESS_PROGRESS_INTERVAL_MS` | `5000` | progress throttle (floor 5 s) |
| `SHARD_HARNESS_THINKING_WINDOW_MS` | `15000` | thinking_tokens tap window |

## Requirements

- Paperclip self-hosted instance (Node.js >= 24.11)
- Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
- Z.ai GLM coding plan key stored as a company secret and referenced from
  agent env: `ANTHROPIC_AUTH_TOKEN = { "type": "secret_ref", "secretId": "<uuid>" }`
  — set on every agent that may receive a GLM override

## Install

```bash
npm install
paperclipai adapter install --payload-json \
  '{"packageName":"/absolute/path/to/paperclip-adapter-shard-harness","isLocalPath":true}'
```

Restart the Paperclip service if the CLI reports `requiresRestart`.

The adapter module supports hot reload without a server restart:
`POST /api/adapters/claude_local/reload` (instance admin). New runs pick up
the reloaded code; in-flight runs finish on the previously loaded module.

Run results are post-processed (`repairRunDisposition`, MYL-44) so successful
runs killed by `terminal_result_cleanup` (exit 143) are not recorded as
failed, `claude_auth_required` is only reported when the login marker appears
in terminal fields rather than transcript echo, and Z.ai quota / rate-limit
texts map to `provider_quota` / `claude_transient_upstream`.
Tests: `node --test test/`.

## Rollback

Adapters → `claude_local` → pause override (or
`paperclipai adapter override claude_local --payload-json '{"paused":true}'`).
The built-in implementation is restored; switch agents to the standalone
`zai_local` adapter if you used it before.

## License

MIT

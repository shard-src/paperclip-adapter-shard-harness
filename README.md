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

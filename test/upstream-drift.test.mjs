// MYL-49 — upstream drift guard.
//
// server/index.js copies CLAUDE_LOGIN_PROMPT_RE / CLAUDE_AUTH_TOKEN_FAILURE_RE
// verbatim from the pinned claude-local (2026.1106.0) parse.js. The copies
// intentionally stay frozen so classification behavior cannot change under a
// reinstall; the trade-off is that a dependency bump requires re-diffing them
// by hand. This test fails loudly when the vendored source no longer matches
// the copies, instead of letting the drift pass silently.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_LOGIN_PROMPT_RE,
  CLAUDE_AUTH_TOKEN_FAILURE_RE,
} from "../server/index.js";

const VENDORED_PARSE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@paperclipai",
  "adapter-claude-local",
  "dist",
  "server",
  "parse.js",
);

function vendoredRegex(name) {
  const text = readFileSync(VENDORED_PARSE, "utf8");
  // The declarations are single-line: const NAME = /.../flags;
  const line = text.match(new RegExp(`^const ${name} = (/.*/[a-z]*);$`, "m"));
  if (!line) {
    throw new Error(
      `${name} not found in vendored parse.js — the upstream layout changed; ` +
      "re-diff the copied regexes in server/index.js and update this test's extractor.",
    );
  }
  const literal = line[1].match(/^\/(.*)\/([a-z]*)$/);
  return { source: literal[1], flags: literal[2] };
}

describe("upstream drift guard (claude-local 2026.1106.0)", () => {
  it("CLAUDE_LOGIN_PROMPT_RE still matches the vendored source verbatim", () => {
    const vendored = vendoredRegex("CLAUDE_LOGIN_PROMPT_RE");
    assert.equal(CLAUDE_LOGIN_PROMPT_RE.source, vendored.source);
    assert.equal(CLAUDE_LOGIN_PROMPT_RE.flags, vendored.flags);
  });

  it("CLAUDE_AUTH_TOKEN_FAILURE_RE still matches the vendored source verbatim", () => {
    const vendored = vendoredRegex("CLAUDE_AUTH_TOKEN_FAILURE_RE");
    assert.equal(CLAUDE_AUTH_TOKEN_FAILURE_RE.source, vendored.source);
    assert.equal(CLAUDE_AUTH_TOKEN_FAILURE_RE.flags, vendored.flags);
  });
});

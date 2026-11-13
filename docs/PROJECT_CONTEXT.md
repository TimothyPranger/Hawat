# Hawat: project context

Hand-over notes from the research-and-build session in claude.ai chat. Claims are labelled
**established** (with a source), **verified in code/tests**, or **UNVERIFIED**. Where these notes and the
code disagree, the code wins; fix the notes.

## Goal

Use Claude Code with Claude models as the orchestrator. The orchestrator decides per task whether bulk work
goes to a local model in LM Studio (Qwen3.8 27B MLX 4bit, about 16 tok/s, server at `http://localhost:1234`).
The point is to save Claude tokens.

**Hard constraint:** the user is on a Claude subscription (no API key), so the claude.ai login must stay
active. Claude Code's requests to Anthropic must pass through unchanged.

## Setup and preferences

- macOS. LM Studio is the local model server. Proxyman is also installed (no conflict: localhost traffic
  bypasses the system proxy).
- Claude Code is mostly used through chat interfaces (desktop app), not the terminal.
- Distrusts tools with little adoption or review. Verify claims with sources, say plainly what is unverified,
  do not oversell.
- Remote: https://github.com/TimothyPranger/Hawat. Ask before any `git push`; never force-push.

## What was established (sources)

1. Claude Code has one `ANTHROPIC_BASE_URL` per session, so subagents cannot natively use a different
   server. Per-subagent routing is only an open feature request (anthropics/claude-code issues 38698, 74073).
2. Anthropic docs (code.claude.com/docs/en/gateways, /llm-gateway-protocol, /subagents):
   - Setting only `ANTHROPIC_BASE_URL` (no `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`) keeps the claude.ai
     login and subscription limits. A gateway credential switches the login off.
   - A gateway must forward `Authorization`, `anthropic-version`, `anthropic-beta` (carries the OAuth
     capability; stripping it causes 401), `cache_control` and the `system` array unchanged, or prompt caching
     silently breaks.
   - Subagent requests carry `x-claude-code-agent-id`; main-session requests do not.
   - A subagent's `model` frontmatter accepts an alias, a full model ID, or `inherit`. Claude can also pass a
     model per invocation. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides every subagent's model: never set it.
   - Anthropic does not support routing Claude Code to non-Claude models through any gateway. This project
     does it anyway, at the user's own risk.
3. LM Studio serves an Anthropic-compatible `POST /v1/messages` at `http://localhost:1234` (no `/v1` in the
   base URL) (lmstudio.ai/docs/integrations/claude-code). It recommends a context above about 25k. A bug
   report exists for LM Studio 0.4.19 build 2 breaking `/v1/messages` for Qwen models with custom thinking
   templates (lmstudio-bug-tracker issue 2164).

## Rejected options

- **Claude Code Router** (musistudio, 37.9k stars): cannot keep the subscription login. From source and
  issues: `mergeUpstreamProviderHeaders` in `packages/core/src/gateway/core-runtime/upstream-header-sanitizer.ts`
  drops client `authorization`/`x-api-key`; `local-agent-auth-provider-hook.ts` reads the Claude Code OAuth
  token itself and uses it as its own; its Claude Code profile writes an auth token into
  `~/.claude/settings.json` (issue 1830).
- **Janus** (risadams/janus): fits technically, 1 star, rejected on adoption.
- Keyless-passthrough alternatives exist (Tailscale Aperture, TrueFoundry, workweave/router,
  hishamkaram/claude-code-router) but are enterprise-heavy or very small.
- **Fallback that needs no proxy:** a headless `claude -p` worker started with
  `ANTHROPIC_BASE_URL=http://localhost:1234`, `ANTHROPIC_AUTH_TOKEN=lmstudio`,
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0` in its own process, so the main session stays untouched.

## What Hawat is

Zero-dependency Node 20+ proxy named after Thufir Hawat, the Mentat of House Atreides in *Dune* (it watches
everything and reports what it means; the Caladan Projects folder is the Atreides homeworld).

- Listens on `127.0.0.1:8719`. Claude Code uses it through `ANTHROPIC_BASE_URL` only.
- Routes by the request body's `model` field. Default rule: `local-qwen` goes to LM Studio (model rewritten;
  `"auto"` picks the first non-embedding model LM Studio lists). Everything else goes to Anthropic byte for
  byte, built from `req.rawHeaders` (original case and order); the response is piped back unchanged.
- Local-route rewrite (`src/router.js`, `src/hawat.js`): always removes `authorization`, `x-api-key`,
  `api-key`, `cookie`, `proxy-authorization`, `anthropic-beta` (not configurable); removes body fields
  `thinking`, `context_management`, `output_config`, tool fields `defer_loading` / `strict` /
  `eager_input_streaming`, and `cache_control` markers (all configurable in `hawat.config.json`); drops the
  `?beta` query; sends only LM Studio's own token.
- Fallbacks: a GUI switch turns local routing off; local-worker requests then go to Anthropic with
  `fallbackModel` (`claude-haiku-5-5`), credentials intact. If LM Studio is down: 502 in Anthropic's error
  shape (`fallbackOnLocalDown` is off by default so no Claude tokens are spent silently).
- Inspector at `/__hawat/` (plain HTML/CSS/JS, `script-src 'self'`, no inline styles): live request list; per
  request URL, query, masked headers, body, a Decision tab (rule matched, what was stripped/rewritten), a
  "Sent upstream" tab, and the response (streams reassembled into thinking, text, tool calls, usage). A bar
  shows tokens handled locally versus by Anthropic, and there is a local-routing switch.
- Security: loopback only, Host header check (DNS rebinding), requests with an `Origin` header refused, GUI
  write actions need `x-hawat-ui: 1`, credentials masked in stored records.

## Verification status

- **Verified:** 13 `node:test` tests against fake Anthropic and LM Studio servers (byte-identical
  passthrough incl. gzip, no credential leaks to LM Studio, streaming, outage, fallback, client abort, guards).
  Re-run on Node 22.23.5: 13/13 pass. GUI exercised in headless Chromium in the chat session.
- **Not yet run** against the real LM Studio or the real Anthropic API.

## UNVERIFIED (check first)

1. Whether LM Studio's `/v1/messages` accepts requests after the strip lists, or returns 400s that need more
   stripping.
2. Whether Claude Code accepts a non-Claude model name such as `local-qwen` in a subagent's `model`
   frontmatter behind a custom base URL. Also whether the other frontmatter in `examples/local-worker.md`
   (`isolation`, `omitClaudeMd`, `maxTurns`) is valid in the installed Claude Code version.
3. Whether Claude Code behaves behind a custom base URL for tool search (`ENABLE_TOOL_SEARCH` may be needed
   with many MCP servers) and for `/v1/messages/count_tokens` against the local route (Hawat routes that
   path to LM Studio too; LM Studio support is unknown).
4. Whether prompt caching survives: main-session requests should show `cache_read` tokens in the inspector.
5. Whether `isolation: worktree` behaves as wanted. The worktree starts from the default branch, not
   uncommitted work.
6. Whether the settings `env` block applies in the Claude desktop/chat surfaces the user uses.
7. Anthropic's stance on subscription traffic through a self-run proxy. One secondary source claims a 2026
   terms update bars OAuth tokens in third-party tools; pass-through of the official CLI's own requests is a
   documented gateway pattern, but no explicit Anthropic statement was found. Requests to Anthropic leave
   from Node rather than Claude Code's network stack; no evidence of blocking was found.

## Real-world verification plan

In a throwaway project: (1) LM Studio server running, model loaded, 32k+ context; (2) `npm start`; (3) one
tiny `curl` with `model: local-qwen` through Hawat, read the inspector; (4) run Claude Code with only
`ANTHROPIC_BASE_URL` set; `/status` must still show the claude.ai login; (5) install
`examples/local-worker.md` as a subagent; (6) delegate one small task; check `/tasks` and the inspector.
Fix whatever breaks (for example extend the strip lists), with a test for each change, and record results
here, including failures.

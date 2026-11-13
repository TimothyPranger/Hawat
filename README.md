# Hawat

*Named after Thufir Hawat, Mentat and Master of Assassins of House Atreides: the one who watches everything that comes and goes, and tells you what it means.*

Hawat is a small local proxy for Claude Code. It sits between Claude Code and Anthropic and does two things:

1. **Routes by model name.** A request for a model name you choose (default `local-qwen`) goes to LM Studio. Every other request goes to Anthropic **byte for byte, with your Claude login untouched**.
2. **Shows you everything.** A live inspector at `/__hawat/` lists every request: URL, query parameters, headers, body, which route it took, what Hawat changed, and the response (streams are reassembled into readable text, tool calls and token usage).

Claude (the orchestrator) decides per task whether to hand work to a subagent whose model is `local-qwen`. Those requests run on your local model and cost no Claude tokens.

Zero dependencies. Node 20 or newer.

## Why the name

In Frank Herbert's *Dune*, **Thufir Hawat** is the Mentat of House Atreides. Mentats are trained as human computers: they take in large amounts of information, weigh it, and report what is likely to be true. As Master of Assassins, Hawat is also the household's head of security and intelligence. Nothing reaches the Duke without Hawat having looked at it first.

That is the job of this tool, and the parallels are deliberate:

| In Dune | In this project |
| --- | --- |
| Hawat stands between the Duke and the outside world and screens everything that arrives. | Hawat sits between Claude Code and the network and inspects every request and response. |
| A Mentat computes: he reads the data and tells you what it means. | The inspector turns raw headers, bodies and event streams into a readable account: where each request went, what was changed, what came back. |
| Hawat decides who may carry a message and by which road. | Hawat routes each request by model name: some go to the local model, the rest to Anthropic. |
| Hawat guards the Duke's secrets. | Hawat never sends your Claude credentials to the local server, and masks them in everything it shows you. |
| Hawat is only as good as the information he is given. | Hawat shows you the real traffic so you do not have to guess. Check what it tells you against the raw view. |

The project lives in the Caladan Projects folder, and Caladan is the Atreides homeworld. The inspector's look follows the same theme: an Atreides green-and-black ground, Arrakis sand for requests that go to Anthropic, Fremen-eye blue for requests that stay on your machine, and sapho plum (the stain a Mentat's lips carry) for the selected request.

## Quick start

```bash
cd "/Users/admin_OLD/Projects/Caladan Projects/hawat"
node -v            # must be 20 or higher
npm test           # 19 tests against pretend Anthropic and LM Studio servers
npm run demo       # pretend traffic so you can explore the inspector: open the URL it prints
npm start          # the real thing
```

`npm start` prints the inspector URL and the exact command to start Claude Code through it. Use `--open` to open the inspector in your browser.

## Connect Claude Code

Set only the base URL. Do **not** set `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`: Anthropic's gateway documentation says setting only `ANTHROPIC_BASE_URL` keeps your saved claude.ai login (and its subscription limits) active, while a gateway credential switches the login off.

- One session: `ANTHROPIC_BASE_URL=http://127.0.0.1:8719 claude`
- One project: copy `examples/settings.local.json` to `<project>/.claude/settings.local.json`
- Check: run `/status` in Claude Code and confirm it still shows your Claude login. In the inspector, ordinary requests should say "Sent to Anthropic untouched" and show cache read tokens once a conversation is going (that proves prompt caching survives).

Hawat has to be running while Claude Code uses it. If you stop Hawat, Claude Code cannot connect until you start it again or remove the setting.

## Use it from the Claude desktop app (HTTPS proxy mode)

The desktop app always sets its own `ANTHROPIC_BASE_URL`, so the base-URL route above does not work there. What does work (verified 2026-11-13 with Claude Code 2.1.321 in desktop app 5.11492.2) is making Hawat the session's HTTPS proxy:

1. `node bin/hawat.js certs` creates a small local certificate authority limited to `api.anthropic.com`, signs one certificate, and **deletes the authority's private key**. Files go to `~/.hawat/certs`. Nothing is added to your keychain.
2. In the desktop app, set two environment variables **for the project folder** (this is the app's own editor, not a settings file): open the environment settings for the folder, choose *Environment variables*, and enter `.env` format, one `KEY=value` per line, no quotes or braces:
   ```
   HTTPS_PROXY=http://127.0.0.1:8719
   NODE_EXTRA_CA_CERTS=/Users/you/.hawat/certs/ca.pem
   ```
   Click *Done*. Only sessions started in that folder afterwards get them.
3. Start Hawat, then start a **new** session in that folder. Claude Code connects to Hawat with `CONNECT`. Traffic to `api.anthropic.com` is decrypted by Hawat so it can read the model name; everything else (login, token refresh, GitHub, MCP servers, telemetry) is a blind tunnel that Hawat does not read or record.

Why not a settings file: when the app's launch environment already sets `HTTPS_PROXY` (it copies the macOS system proxy, for example Proxyman on port 9090), Claude Code ignores the settings-file value. The app's environment editor does override it. Other apps keep using the system proxy untouched.

Routing, header handling and the guarantees below are the same as in base-URL mode. If Hawat is not running, a session started with these variables cannot reach the API until you start Hawat or remove the variables. Tunnels are counted in the inspector's state (`/__hawat/api/state`), not listed. Set `intercept.tunnel` to `false` to refuse all non-intercepted hosts.

## Add the local worker

1. Copy `examples/local-worker.md` to `~/.claude/agents/local-worker.md` (or a project's `.claude/agents/`). Its `model: local-qwen` is what Hawat matches on.
2. Add the text in `examples/CLAUDE.md.snippet` to your `CLAUDE.md` so the orchestrator knows when to delegate.
3. In LM Studio: start the server (default port 1234), load your model, and give it a context length of at least 32k (Claude Code prompts are large).
4. In Claude Code, ask for work as usual. Claude decides when to use the worker. To force it, @-mention it: `@"local-worker (agent)" rename ...`.
5. Check `/tasks` while it runs; the subagent row shows its model. In Hawat the request appears as "Redirected to LM Studio".

Note: `isolation: worktree` gives each worker its own git worktree, which starts from your default branch, **not** your uncommitted changes. Remove that line if the worker must see work in progress.

## Configuration

`hawat.config.json` (and an optional, git-ignored `hawat.config.local.json` on top of it). Restart Hawat after editing.

| Setting | Meaning |
| --- | --- |
| `port`, `host` | Where Hawat listens. Default `8719` on `127.0.0.1`. Keep it on loopback. |
| `anthropic.baseUrl` | Upstream for everything that is not redirected. |
| `local.baseUrl`, `local.apiKey` | LM Studio. The base URL has no `/v1`. The key is only needed if you turned on "Require Authentication" in LM Studio; the default placeholder is fine otherwise. |
| `localEnabled` | Start with local routing on or off. Also a switch in the inspector. |
| `routes[].match` | `model`, `modelPrefix`, `modelRegex`, and/or `header: {name, value}`. All given conditions must match. |
| `routes[].rewriteModel` | Model name sent to LM Studio. `"auto"` picks the first non-embedding model LM Studio lists. |
| `routes[].fallbackModel` | Used when local routing is switched off (and optionally when LM Studio is down): the request goes to Anthropic with this model, credentials intact. |
| `routes[].fallbackOnLocalDown` | `false` (default): if LM Studio is down you get a clear error and spend no Claude tokens. `true`: retry on Anthropic with `fallbackModel`. |
| `routes[].stripBodyFields`, `thinking`, `stripToolFields`, `stripCacheControl` | Fields Claude Code sends that a local server may reject. Adjust if LM Studio returns 400 errors; the inspector shows exactly what was removed. |
| `intercept.hosts`, `intercept.certDir`, `intercept.tunnel` | HTTPS proxy mode: hosts to decrypt (default `api.anthropic.com`), where `hawat certs` keeps its files (default `~/.hawat/certs`), and whether other hosts may be tunnelled. Re-run `hawat certs --force` after changing the hosts. |
| `keepRecords`, `maxBodyBytes`, `maxTotalBytes` | How much traffic is kept in memory for the inspector. |
| `logToFile`, `logDir` | Off by default. When on, each finished request is appended to a daily `.jsonl` file. Bodies contain your code and prompts. |

## What Hawat guarantees (and the tests prove)

- Requests that are not redirected reach Anthropic with **identical body bytes and headers** (only `Host` and connection-level headers differ), and the response is streamed back unchanged, still compressed if it was compressed.
- One exception: a browser page request (`Accept: text/html`) for exactly `/` is redirected to the inspector. Claude Code never asks for that; Anthropic's API answers 404 there.
- Your Claude credentials (`authorization`, `x-api-key`, cookies, `anthropic-beta`) are **never sent to LM Studio**, whatever the rules say. LM Studio only ever sees its own token.
- Stored records mask credentials (first few characters only). Request and response bodies are shown unmasked because they are your own data; they stay in memory unless you enable file logging.
- In HTTPS proxy mode only the hosts you list are decrypted, with a name-constrained certificate whose authority key is deleted after signing; other hosts are never read.
- Hawat listens on loopback only, rejects unexpected `Host` headers (DNS rebinding), rejects requests that carry a browser `Origin`, and the inspector's write actions need a same-origin header.
- If the local model is down you get an error in Anthropic's error format. Nothing falls back to Claude unless you asked for it.

## Known limits and risks

- **Unsupported by Anthropic.** Their gateway documentation says routing Claude Code to non-Claude models through a gateway is not supported. This works with documented mechanisms (`ANTHROPIC_BASE_URL`, subagent `model` values) but is at your own risk.
- **Prompt caching** only survives because the Anthropic path forwards the body unchanged. Do not add features that rewrite those requests. Watch for "read from cache" tokens in the inspector.
- **Not Claude Code's own network stack.** Requests to Anthropic go out from Node. Some third-party tools go to lengths to imitate Claude Code's TLS fingerprint; I found no evidence that Anthropic blocks proxies, and enterprise gateways forward normally, but it is not guaranteed.
- **Local model limits.** LM Studio's Anthropic-compatible endpoint may reject some fields; use the strip settings. The response's `model` field names the LM Studio model, not `local-qwen`.
- **Single user.** Not built to be exposed to a network.

## Layout

```
bin/hawat.js        CLI
src/hawat.js        proxy, routing glue, inspector API
src/router.js       rule matching and the local request rewrite
src/certs.js        local certificate for HTTPS proxy mode
src/capture.js      response observer (decode, reassemble streams)
src/sse.js          Anthropic stream parser
src/store.js        in-memory request records
ui/                 the inspector (plain HTML, CSS, JavaScript)
test/               node:test suite
scripts/demo.js     pretend traffic
examples/           subagent, settings and CLAUDE.md snippets
```

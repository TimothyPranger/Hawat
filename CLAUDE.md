# Hawat

Zero-dependency Node 20+ proxy that routes chosen Claude Code subagent requests to LM Studio and passes
everything else to Anthropic untouched. Full background, sources and the list of unverified items:
[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md). Usage: [README.md](README.md).

Commands: `npm test` (node:test, needs Node 20+; `.nvmrc` says 22), `npm start`, `npm run demo`.

## Working rules

- Never set `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` for the main session (the user's claude.ai
  subscription login must stay active). Never set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.
- Keep the guarantees: unredirected requests are forwarded unchanged; Claude credentials never reach
  LM Studio; secrets are masked in stored records; loopback only.
- Keep Hawat dependency-free. No behaviour change without a test.
- Do not push, publish or run destructive commands without asking first. Never force-push.
- Verify before asserting. Label anything unverified. Where docs and code disagree, trust the code and say so.

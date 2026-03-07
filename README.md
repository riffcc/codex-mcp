# Codex MCP

`codex-mcp` is Riff Labs' fork and rewrite path of the open source [`cexll/codex-mcp-server`](https://github.com/cexll/codex-mcp-server).

This repository keeps that project's core idea, exposing Codex through MCP, but the intent here is broader: build a durable MCP layer for full Codex automation, long-running orchestration, job control, and deeper autonomous workflows. It is expected to diverge substantially over time.

## Credit

This project is based on the upstream work in `cexll/codex-mcp-server`, which itself credits inspiration from `jamubc/gemini-mcp-tool`. That lineage should remain visible anywhere this fork is published.

## What This Fork Is For

- Running Codex through MCP-compatible clients
- Supporting asynchronous and blocking Codex execution flows
- Managing longer-lived Codex jobs and thread-oriented workflows
- Acting as a foundation for more complete Codex automation over time

## Current Shape

The server currently includes MCP tools for:

- `ask-codex`
- `ask-codex-command`
- `batch-codex`
- `brainstorm`
- `get-codex-job`
- `fetch-chunk`
- `list-codex-threads`
- `close-codex-thread`
- `ping`
- `Help`
- `version`
- `timeout-test`

## Local Development

Requirements:

- Node.js `>=18`
- `codex` CLI installed and authenticated

Install and build:

```bash
npm install
npm run build
```

Run the stdio server:

```bash
npm start
```

Run the HTTP entrypoint:

```bash
npm run start:http
```

## Repository Layout

- `src/` TypeScript source
- `src/tools/` MCP tool definitions
- `src/utils/` execution and parsing helpers
- `docs/` project documentation
- `dist/` compiled output

## Documentation

- Contributor guidance: [docs/contributing.md](docs/contributing.md)
- Repository maintainer guidance: [AGENTS.md](AGENTS.md)
- Claude-specific maintainer guidance: [CLAUDE.md](CLAUDE.md)

## Status

This is an actively evolving fork. Expect implementation churn, interface changes, and increasing divergence from upstream as the automation layer becomes more capable.

## License

MIT.

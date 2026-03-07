# Contributing

This project accepts pull requests and issue reports. Keep contributions small, reproducible, and aligned with the current MCP server architecture.

## Before You Start

- Use Node `>=16`
- Install and authenticate the `codex` CLI locally
- Run `npm install`

## Local Workflow

```bash
npm install
npm run build
npm run lint
npm start
```

For docs work:

```bash
npm run docs:dev
```

## Development Notes

- Source lives under `src/`
- MCP tools live under `src/tools/`
- Shared execution and parsing helpers live under `src/utils/`
- Docs live under `docs/`

When adding a new tool:

1. Create `src/tools/your-tool.tool.ts`
2. Define a `zod` schema for its arguments
3. Export a `UnifiedTool`
4. Register it in `src/tools/index.ts`
5. Add or update docs under `docs/`

## Coding Expectations

- Use TypeScript ESM imports with `.js` extensions
- Use 2-space indentation
- Prefer single quotes
- Keep filenames in `kebab-case`
- Do not commit secrets, tokens, or local machine configuration

## Validation Checklist

Before opening a PR:

- Run `npm run build`
- Run `npm run lint`
- Verify affected tools still work through the MCP server
- Update docs when behavior, parameters, or setup changed

## Pull Requests

- Explain what changed and why
- Include reproduction steps for bug fixes
- Include sample MCP usage when it clarifies behavior
- Keep unrelated work out of the same PR

## Issues

When reporting bugs, include:

- What you ran
- What you expected
- What happened instead
- Node version, OS, and Codex CLI version
- Relevant stderr or MCP error output

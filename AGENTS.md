# Working on Syncw

Syncw is a post office for AI agents: a Claude scheduler hires Codex workers, each in its own git worktree, through an MCP server. The design is in `docs/DESIGN.md` (in Chinese).

## The contract

`src/schema/types.ts` is the shared contract that every module is written against, often by several workers in parallel. **Implement it; do not edit it.** If it looks wrong or incomplete for your task, keep going with the closest reasonable reading and say what you found in `open_questions`.

## Code conventions

- TypeScript runs directly on Node >= 22.18 (native type stripping, no build step). That means:
  - Only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties, no decorators.
  - Relative imports include the `.ts` extension: `import { x } from './x.ts'`.
  - Type-only imports use `import type`.
- Strict TypeScript (see `tsconfig.json`). `npm run typecheck` must pass.
- Tests use `node:test` and `node:assert/strict`, in files named `test/**/<name>.test.ts`. `npm test` must pass.
- Don't add runtime dependencies unless your task says so.
- Match the existing style: small modules, doc comments that explain *why*, and error messages that say what went wrong and how to fix it.

## Environment

- Windows 11 with PowerShell. Use `node:path` for paths, because they may contain backslashes.
- To run a Node script from code, spawn `process.execPath` with the script path. Do not go through a shell or `.cmd` shims.
- Command output may be GBK-encoded. Never parse human-readable command output when a structured alternative exists.

## Scope

- Work only inside your own worktree, and never push.
- Only change the paths your task allows.

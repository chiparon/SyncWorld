# SyncWorld

> A post office for AI agents: Claude scheduler hires Codex workers in isolated git worktrees.

**SyncWorld** lets AI agents work like a small company — one judicious scheduler (Claude) delegates coding tasks to multiple workers (Codex), each in their own git branch, then reviews and merges the results.

---

## Why?

You pay for both Claude (judgment, expensive) and ChatGPT (execution, included in your subscription). Why not use them together?

- **Claude**: Splits tasks, writes specifications, reviews diffs, makes decisions
- **Codex**: Reads code, writes code, runs tests, iterates on feedback
- **Cross-checking**: Different model families naturally catch each other's mistakes

Each worker runs in an isolated git worktree, so they can work in parallel without conflicts.

---

## Quick Start

### 1. Install

```bash
npm ci
```

### 2. Register the MCP server

```bash
claude mcp add --scope user syncw -- node /absolute/path/to/SyncWorld/src/postoffice/main.ts
```

Restart your Claude Code session.

### 3. Try it

Open a Claude Code session in any git repository:

```javascript
// The scheduler (you talking to Claude) can now:

spawn_agent({
  task: {
    goal: "Add a new feature X",
    acceptance: ["Tests pass", "Code follows project style"],
    constraints: ["Only change src/features/"]
  },
  role: "engineer"
})

// Wait for results
wait()

// Review, send feedback if needed
send_message({ to: "engineer-1", text: "Please also add error handling" })

// Merge when approved
// (manually: git merge --no-ff syncw/engineer-1)
```

---

## How It Works

```
You (human)
 └─> Claude Code session (scheduler)
      └─> MCP: spawn_agent, send_message, wait
           └─> Post office (Node.js server)
                ├─> Codex worker 1 (git worktree + branch syncw/engineer-1)
                ├─> Codex worker 2 (git worktree + branch syncw/engineer-2)
                └─> ...
```

**Each worker:**
- Gets a fresh git worktree from your repo
- Works on its own `syncw/<name>` branch
- Runs Codex CLI with the task prompt
- Reports results in structured JSON
- Auto-commits after every turn

**The scheduler:**
- Spawns workers in parallel
- Collects results via `wait()`
- Reviews diffs (or delegates to verifier subagent)
- Sends follow-up messages if changes needed
- Merges approved branches

---

## Project Status

**Milestone 1** ✅ (2026-10-14)
- Post office MCP server
- Codex engine integration
- Verifier subagent
- Batch lifecycle management
- 182 tests passing

**Milestone 2** (planned)
- Worker-to-worker direct communication
- Shared context board
- Worker spawning workers (with permission constraints)

**Milestone 3** (planned)
- Unattended scheduler (run without keeping a chat open)
- DeepSeek engine

---

## Documentation

- [Design doc (Chinese)](docs/DESIGN.md) — Architecture, concepts, and rationale
- [Role templates](roles/) — Engineer, architect, researcher templates
- [Contract](src/schema/types.ts) — Shared TypeScript interfaces

---

## Development

```bash
# Type check
npm run typecheck

# Run tests
npm test

# Check project status
node src/cli/syncw.ts status
```

**Conventions:**
- Node >= 22.18 (native TypeScript via `--experimental-strip-types`)
- Only erasable TS syntax (no `enum`, `namespace`, decorators)
- Relative imports include `.ts` extension
- Tests use `node:test` and `node:assert/strict`

---

## Requirements

- Node.js >= 22.18
- Git
- Claude Code CLI
- Codex CLI (authenticated with ChatGPT account)

---

## License

MIT

---

## Credits

Built with Claude Opus 5.5 and Codex workers, using the architecture it recommended for itself.

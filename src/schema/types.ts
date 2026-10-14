/**
 * Syncw shared contract.
 *
 * Every post office module is written against this file, often by different
 * workers in parallel. That only works if this file is the single source of
 * truth: workers implement it, they do not change it. A worker that finds it
 * wrong or incomplete should raise an open question instead of editing it -
 * two workers "fixing" the contract in different directions is exactly the
 * kind of conflicting implicit decision this project exists to prevent.
 *
 * TYPE-ONLY on purpose (no runtime exports), so Node's native type stripping
 * erases it and every module can use `import type`.
 *
 * Design: docs/DESIGN.md, cited below as DESIGN §n.
 */

// ---------------------------------------------------------------------------
// Task and result: what crosses the boundary between a hirer and a worker
// ---------------------------------------------------------------------------

/** What a hirer hands a new agent (DESIGN §5). */
export interface Task {
  /** Required. The outcome wanted, not the method. */
  goal: string;
  /** Checkable signals that the task is done. */
  acceptance?: string[];
  /** Hard limits, e.g. "only change src/engines/". */
  constraints?: string[];
  /** What to read before starting: file paths, doc sections, short notes. */
  context?: string[];
}

export type ResultStatus = 'done' | 'failed' | 'blocked';

/**
 * What a worker reports at the end of every turn. Codex is forced into this
 * shape by `--output-schema src/schema/result.schema.json`, which must stay in
 * sync with this interface.
 *
 * This is the worker's own account, and the post office never relies on it
 * alone: see TurnFacts for what is measured independently.
 */
export interface WorkerResult {
  /** done: acceptance met. failed: tried and could not. blocked: needs a decision or access. */
  status: ResultStatus;
  /** One or two sentences; the first thing the hirer reads. */
  summary: string;
  details: string;
  /** Paths relative to the worktree. */
  files_changed: string[];
  /** Questions only the hirer can answer. */
  open_questions: string[];
}

/** Token usage of one turn, from the engine's event stream. */
export interface TurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

/**
 * What the post office measured about a turn itself. Where this disagrees
 * with the WorkerResult, this wins.
 */
export interface TurnFacts {
  /** 1-based. */
  turn: number;
  /** ISO-8601. */
  started_at: string;
  /** ISO-8601. */
  finished_at: string;
  duration_ms: number;
  /** Process exit code; null when the process was killed. */
  exit_code: number | null;
  /** Files the event stream says were changed; relative to the worktree when inside it. */
  files_touched: string[];
  /** The auto-commit made after this turn. Absent when nothing changed. */
  commit?: string;
  /** `git show --stat` of that commit. */
  diff_stat?: string;
  usage?: TurnUsage;
  timed_out: boolean;
  cancelled: boolean;
  /** Engine-level failure: crash, timeout, or a missing or invalid result. */
  error?: string;
}

export interface TurnRecord {
  /** What started this turn: the full prompt for turn 1, the follow-up messages after that. */
  input: string;
  /** null when the worker produced no valid result (crash, timeout, invalid JSON). */
  result: WorkerResult | null;
  facts: TurnFacts;
  /** Set once `wait` has handed this turn to the scheduler, so each turn is reported exactly once. */
  reported: boolean;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 *   queued       has a turn waiting for a free slot (max_parallel)
 *   running      a turn is in progress
 *   idle         the last turn finished; wakes on send_message
 *   cancelled    stopped by cancel_agent; send_message resumes it
 *   interrupted  was queued or running when the post office stopped; send_message resumes it
 *   closed       worktree removed; final
 */
export type AgentStatus = 'queued' | 'running' | 'idle' | 'cancelled' | 'interrupted' | 'closed';

export type EngineKind = 'codex';

export interface AgentRecord {
  /**
   * `<role>-<n>`, e.g. "engineer-1". Unique within its run, and never the name
   * of a `syncw/<name>` branch or worktree directory that already existed in
   * its repository (see Worktrees.usedNames).
   */
  name: string;
  /** Template name from roles/, or "custom" when only a brief was given. */
  role: string;
  /** The full role text used in the prompt: template, brief, or both. */
  brief: string;
  task: Task;
  engine: EngineKind;
  /** Who hired this agent. Always "scheduler" in milestone 1. */
  hired_by: string;
  /** Absolute path of the main repository. */
  repo: string;
  /** Commit sha the branch was created from. */
  base: string;
  /** "syncw/<name>". */
  branch: string;
  /** Absolute path of this agent's worktree. */
  worktree: string;
  /** Engine session id (the Codex thread id). Known once the first turn has started. */
  session_id?: string;
  status: AgentStatus;
  turns: TurnRecord[];
  /**
   * Messages not delivered yet, oldest first. The next follow-up turn delivers
   * all of them together, and they stay here until that turn starts, so a
   * restart of the post office cannot lose them.
   */
  queued_messages: string[];
  /** ISO-8601. */
  created_at: string;
}

// ---------------------------------------------------------------------------
// Engine: runs one turn of one agent (DESIGN §6).
// Implemented by src/engines/codex.ts.
// ---------------------------------------------------------------------------

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface EngineTurnRequest {
  /** The agent's worktree. The engine process runs here. */
  cwd: string;
  /** Full text for this turn. Sent on stdin, never on the command line. */
  prompt: string;
  /** Present => resume this session instead of starting a new one. */
  session_id?: string;
  /** JSON Schema the final message must follow (src/schema/result.schema.json). */
  result_schema_path: string;
  /** Where the engine writes its final message. */
  result_path: string;
  /** Every stdout line is appended here verbatim. */
  events_path: string;
  /** stderr is appended here. */
  stderr_path: string;
  timeout_ms: number;
}

export interface EngineTurnOutcome {
  /** From the event stream; for a resumed turn, falls back to the requested session_id. */
  session_id?: string;
  exit_code: number | null;
  /** Parsed and validated against WorkerResult; null when missing or invalid. */
  result: WorkerResult | null;
  files_touched: string[];
  usage?: TurnUsage;
  timed_out: boolean;
  cancelled: boolean;
  error?: string;
}

export interface RunningTurn {
  /** Resolves as soon as the session id is known, or with undefined if the process ends without one. */
  readonly sessionId: Promise<string | undefined>;
  /** Resolves once the process has exited. Never rejects: failures are reported in the outcome. */
  readonly done: Promise<EngineTurnOutcome>;
  /** Kills the whole process tree; `done` then resolves with cancelled: true. Idempotent. */
  cancel(): void;
}

export interface Engine {
  readonly kind: EngineKind;
  startTurn(req: EngineTurnRequest): RunningTurn;
}

// ---------------------------------------------------------------------------
// Worktrees (DESIGN §6).
// Implemented by src/postoffice/worktrees.ts.
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  /** "syncw/<name>". */
  branch: string;
  /** Absolute path: <repo parent>/<repo name>.worktrees/<name>. */
  worktree: string;
  /** The resolved commit sha. */
  base: string;
}

export interface CommitInfo {
  commit: string;
  diff_stat: string;
}

export interface Worktrees {
  /** `base` is any commit-ish and defaults to the repo's HEAD. Fails if the path or branch already exists. */
  create(repo: string, name: string, base?: string): Promise<WorktreeInfo>;
  /** Stages and commits everything; resolves undefined when there was nothing to commit. */
  commitAll(
    worktree: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<CommitInfo | undefined>;
  /** Force-removes the worktree; optionally deletes a branch too. */
  remove(repo: string, worktree: string, opts?: { deleteBranch?: string }): Promise<void>;
  /**
   * Every name `create` would refuse in this repository: the `<name>` of each
   * branch `syncw/<name>`, and each entry of the `<repo name>.worktrees/`
   * directory (none when it does not exist). `repo` may be any path inside the
   * repository, as for `create`. Agent numbers restart at 1 in every run, but
   * branches and worktrees outlive runs, so new names are allocated around these.
   */
  usedNames(repo: string): Promise<Set<string>>;
}

// ---------------------------------------------------------------------------
// Registry: the post office's memory, persisted under runs/<run-id>/ (DESIGN §8).
// Implemented by src/postoffice/registry.ts.
//
// A run is one batch of work, and it can outlive the post office that started
// it: a restarted post office continues its repository's unfinished run (see
// OpenRegistryOptions), so the scheduler finds its agents again.
//
// A new run exists only in memory until its first write (add, update,
// appendTurn, agentDir or log). A post office that never hires anyone, such as
// one started by `claude mcp list` to check health, leaves nothing on disk.
//
// Ownership. At most one post office uses a run at a time: two processes
// writing one agents.json lose each other's updates, and a newcomer would mark
// the live owner's running agents interrupted. The claim is a file
// runs/<run-id>/owner-<pid>.json holding {"pid", "started_at"}. A post office
// writes it when it continues a run, or when it creates one (before
// agents.json), and close() removes it. A claim is live when its pid is not
// this process's own and process.kill(pid, 0) succeeds or fails with EPERM;
// any other claim is stale and may be deleted. To claim a run, write your own
// file, then look for another live claim; if there is one, delete your own
// file and give up. Two post offices racing for one run may both give up, but
// never both win. A dead owner whose pid was reused looks live, which errs on
// the safe side: the newcomer starts a new run.
// ---------------------------------------------------------------------------

export interface Registry {
  /** Fixed when the registry opens, also for a new run that is not on disk yet. */
  readonly runId: string;
  /** Absolute path of runs/<run-id>. */
  readonly runDir: string;
  /** "<role>-<n>" with the smallest n such that the name is neither used in this run nor in `taken`. */
  allocateName(role: string, taken?: ReadonlySet<string>): string;
  /** Adds and persists. Throws if the name is taken. */
  add(record: AgentRecord): void;
  get(name: string): AgentRecord | undefined;
  list(): AgentRecord[];
  /** Shallow-merges the patch, persists, and returns the updated record. Throws on an unknown name. */
  update(name: string, patch: Partial<Omit<AgentRecord, 'name'>>): AgentRecord;
  /** Appends a turn, persists, and returns the updated record. */
  appendTurn(name: string, turn: TurnRecord): AgentRecord;
  /** Absolute path of runs/<run-id>/<name>/, created on first use. */
  agentDir(name: string): string;
  /** Appends {"ts", "event", ...data} as one line to runs/<run-id>/log.jsonl. */
  log(event: string, data?: Record<string, unknown>): void;
  /**
   * Releases this post office's claim on the run, if it holds one. Idempotent.
   * Call it last: the registry must not be written afterwards.
   */
  close(): void;
}

export interface OpenRegistryOptions {
  /** The directory holding all runs, e.g. <syncw>/runs. */
  runsDir: string;
  /**
   *   continue  (default) Continue this repository's latest run if one of its
   *             agents is not closed and no live post office owns it.
   *             Otherwise start a new run.
   *   new       Always start a new run.
   *
   * This repository's latest run is the newest run whose agents.json lists an
   * agent working in `repo` (any agent at all when `repo` is absent), with runs
   * ordered by id as in `syncw status`. Older runs are never continued.
   * Continuing a run marks its queued and running agents interrupted, because
   * their processes did not survive the restart, and logs "registry.reopened"
   * with their names.
   */
  mode?: 'continue' | 'new';
  /**
   * The post office's default repository. An agent works in it when its
   * AgentRecord.repo is the same path, compared after path.resolve and
   * case-insensitively on Windows. Every repository shares one runs
   * directory, so without this a post office could continue another
   * project's run.
   */
  repo?: string;
}

// ---------------------------------------------------------------------------
// Post office: the API behind the MCP tools (DESIGN §5).
// Implemented by src/postoffice/core.ts; src/postoffice/server.ts maps each
// MCP tool 1:1 onto it.
// ---------------------------------------------------------------------------

export interface PostOfficeLimits {
  /** Default 4. */
  max_parallel: number;
  /** Default 12. */
  max_agents: number;
  /** Default 10. */
  max_turns: number;
  /** Default 30 minutes. */
  turn_timeout_ms: number;
}

export interface SpawnAgentInput {
  task: Task;
  /** A template in roles/<role>.md. */
  role?: string;
  /** Custom role text, appended after the template when both are given. At least one of role/brief is required. */
  brief?: string;
  /** Repository to work in. Defaults to the post office's working directory. */
  repo?: string;
  /** Commit-ish to branch from. Defaults to the repo's HEAD. */
  base?: string;
}

export interface SpawnAgentOutput {
  name: string;
  branch: string;
  worktree: string;
  /** "running", or "queued" when every slot is busy. */
  status: AgentStatus;
}

export interface SendMessageInput {
  to: string;
  text: string;
}

export interface SendMessageOutput {
  /** started: a new turn began. queued: waiting for the current turn or a free slot. */
  delivery: 'started' | 'queued';
}

export interface WaitInput {
  /** Defaults to every agent. */
  agents?: string[];
  /** How long to wait for at least one unreported turn. Default 600; 0 means just check. */
  timeout_s?: number;
}

/** One finished turn, as handed to the scheduler. Deliberately compact: never a transcript. */
export interface TurnReport {
  agent: string;
  turn: number;
  result: WorkerResult | null;
  facts: TurnFacts;
}

export interface WaitOutput {
  /** Finished turns not reported before. Each turn is reported exactly once. */
  finished: TurnReport[];
  /** The agents asked about that are still queued or running. */
  pending: string[];
}

export interface AgentSummary {
  name: string;
  role: string;
  status: AgentStatus;
  branch: string;
  worktree: string;
  turns: number;
  queued_messages: number;
  /** Seconds since the current turn started, while running. */
  running_for_s?: number;
  last_summary?: string;
}

/** What `createPostOffice` in src/postoffice/core.ts needs. Everything is injected, so tests can swap any part. */
export interface PostOfficeOptions {
  registry: Registry;
  worktrees: Worktrees;
  engine: Engine;
  /** Directory of role templates, one `<role>.md` per role. */
  roles_dir: string;
  /** Repository used when spawn_agent names none. */
  default_repo: string;
  /** Absolute path of src/schema/result.schema.json. */
  result_schema_path: string;
  /** Merged over the defaults in PostOfficeLimits. */
  limits?: Partial<PostOfficeLimits>;
}

export interface PostOffice {
  spawnAgent(input: SpawnAgentInput): Promise<SpawnAgentOutput>;
  /**
   * While the agent is queued or running, the text joins queued_messages for
   * its next turn. Otherwise it starts a turn, or queues one behind
   * max_parallel: a follow-up in the agent's session that delivers every
   * queued message, oldest first, or, when the agent's first turn never
   * started, that first turn, with the messages delivered in the turn after.
   * Throws for an agent that has finished turns but no session to resume.
   */
  sendMessage(input: SendMessageInput): Promise<SendMessageOutput>;
  wait(input: WaitInput): Promise<WaitOutput>;
  listAgents(): AgentSummary[];
  cancelAgent(name: string): Promise<void>;
  closeAgent(name: string, opts?: { delete_branch?: boolean }): Promise<void>;
  /**
   * Stops the post office for good, when the MCP client disconnects or the
   * process is asked to stop. No Codex process may outlive its post office,
   * because the next one would resume the same session in the same worktree.
   *
   * Once called, spawnAgent and sendMessage throw, and no new turn starts.
   * Queued agents become interrupted. Running turns are cancelled, then
   * recorded as usual, auto-commit included, with a facts.error saying that
   * the post office shut down; their agents end interrupted, not cancelled.
   * Queued messages stay queued. Pending wait calls reject without marking any
   * turn reported, so the next post office reports those turns. Resolves once
   * every running turn is recorded. Idempotent.
   */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Status: what `syncw status` shows a human about one run (DESIGN §8).
// src/status/read.ts builds it from runs/<run-id>/ on disk, and
// src/status/format.ts turns it into text. Both only read: the command never
// changes a run, and it works whether or not a post office is running.
// ---------------------------------------------------------------------------

/** One agent as `syncw status` shows it. */
export interface AgentStatusView {
  name: string;
  role: string;
  status: AgentStatus;
  branch: string;
  /** task.goal, verbatim; it may span several lines. */
  goal: string;
  /** Finished turns. */
  turns: number;
  queued_messages: number;
  /** Only while running: seconds since the current turn started. Absent when unknown. */
  running_for_s?: number;
  /** The last finished turn. Absent until the first turn finishes. */
  last_turn?: Pick<TurnRecord, 'result' | 'facts'>;
}

export interface RunStatus {
  run_id: string;
  /** Absolute path of runs/<run-id>. */
  run_dir: string;
  /** In hiring order, as in agents.json. */
  agents: AgentStatusView[];
}

export interface StatusFormatOptions {
  /**
   * Terminal width in columns. When set, no line may be wider, counting East
   * Asian wide characters (such as Chinese) as two columns. When absent, for
   * example because the output is piped, nothing is cut.
   */
  width?: number;
}

// ---------------------------------------------------------------------------
// Board (milestone 2). Used by src/runtime/world.ts, kept from M0.
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'markdown' | 'number' | 'boolean' | 'json';

/** How concurrent writes to one board entry reconcile. */
export type MergeStrategy =
  | 'replace'
  | 'append'
  | 'last_write_wins'
  | 'first_write_wins'
  | 'sum'
  | 'max';

export interface WorldField {
  type: FieldType;
  merge: MergeStrategy;
  /** If set, only this agent may write the entry. */
  owner?: string;
  description?: string;
}

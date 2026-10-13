/**
 * Syncw core type vocabulary.
 *
 * This file is intentionally TYPE-ONLY (no runtime exports) so it can be
 * imported with `import type` and erased by Node's native type stripping.
 *
 * The central design claim lives here: an `AgentSpec` has NO model field.
 * A `NodeSpec` binds an agent to a *policy*, never to a concrete model.
 * `ProviderConfig` never mentions a model. `ModelProfile` never mentions a
 * prompt. Three registries, zero cross-references.
 */

// ---------------------------------------------------------------------------
// Models: the capability profile registry
// ---------------------------------------------------------------------------

export type Capability =
  | 'native_tool_calls'
  | 'parallel_tool_calls'
  | 'json_schema'
  | 'reasoning'
  | 'vision'
  | 'prompt_caching';

/**
 * A model is described by *what it can do and what it costs* - never by what
 * it should be used for. Selection is the binding engine's job.
 */
export interface ModelProfile {
  /** Globally unique, e.g. "anthropic/claude-sonnet-4-5". */
  id: string;
  label?: string;
  /** Provider registry key, e.g. "anthropic". */
  provider: string;
  /** Model lineage. Used for `family:` / `not_family_of:` cross-checks. */
  family: string;
  /** Context window in tokens. */
  ctx: number;
  /** Max output tokens, if known. */
  maxOut?: number;
  caps: Capability[];
  /** USD per 1M tokens. */
  cost: { in: number; out: number };
  /** Rough p50 latency for a typical call, ms. Used by `prefer: latency`. */
  latencyP50Ms?: number;
  /**
   * Static 0..1 prior. Overwritten at runtime by eval history once M3 lands -
   * this field is the seam where "self-tuning routing" plugs in.
   */
  quality?: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Agents: the behaviour registry (model-free by construction)
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'markdown' | 'number' | 'boolean' | 'json';

export interface FieldSpec {
  type: FieldType;
  /** Optional named contract in `contracts/` for structured payloads. */
  schema?: string;
  required?: boolean;
  /** Default applied when a run does not supply this input. */
  default?: unknown;
}

/**
 * What a node's input/output contract looks like. Contracts are how
 * information crosses a *model boundary* without being silently mangled.
 */
export type Contract = Record<string, FieldSpec>;

export interface AgentSpec {
  name: string;
  /** One-line identity, injected into the prompt header. */
  role: string;
  /** The behaviour. Model-agnostic by policy. */
  instructions: string;
  /** Tool grants (MCP tool names). */
  tools?: string[];
  in?: Contract;
  out: Contract;
  /**
   * Prompt portability escape hatch. A prompt tuned for Claude often degrades
   * on DeepSeek. Family-specific overrides are appended, not substituted.
   */
  promptByFamily?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Providers: the access registry
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  name: string;
  kind: 'mock' | 'openai-compat';
  baseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Informational only - routing authority belongs to ModelProfile. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Workflow: orchestration as data
// ---------------------------------------------------------------------------

/**
 * How concurrent writes to one world field reconcile. This is what makes
 * "Synchronized" a technical property rather than a name.
 */
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
  /** If set, only this node id may write the field. */
  owner?: string;
  description?: string;
}

/**
 * A binding policy is a *query over model space*, not a hardcoded model.
 * `pin` is deliberately listed last in the docs: pinning is the exception.
 */
export interface BindPolicy {
  /** Absolute override. Escape hatch, not the default mode. */
  pin?: string;
  /** Hard constraints. All must hold. e.g. ["ctx>=128k", "json_schema"]. */
  require?: string[];
  /** Soft ordering among survivors. */
  prefer?: 'cost' | 'quality' | 'latency' | 'balanced';
  /** Glob patterns tried in order when the primary pick fails at runtime. */
  fallback?: string[];
  /**
   * Heterogeneous fan-out: item i of a `for_each` gets byIndex[i].
   * This is the single most valuable primitive in cross-model orchestration -
   * it makes "three vendors research independently" a one-liner.
   */
  byIndex?: string[];
  /** Recovery policy after `retries` attempts fail. */
  escalateIf?: { retries?: number; to?: 'quality' | 'cost' | 'latency' };
  /** Per-binding spend ceiling in USD. */
  maxUsd?: number;
}

export type NodeKind = 'agent' | 'human_gate';

export interface NodeSpec {
  id: string;
  kind?: NodeKind;
  /** Agent registry key. Required when kind === 'agent'. */
  agent?: string;
  bind?: BindPolicy;
  /** Input wiring: localName -> ref expression (see runtime/refs.ts). */
  in?: Record<string, string>;
  /** Output wiring: worldField -> contract field name. */
  out?: Record<string, string>;
  /**
   * Explicit dependencies. Defaults to `[previous node id]`, so a linear
   * workflow reads top-to-bottom with no ceremony.
   */
  needs?: string[];
  /** Fan-out source ref. Item is addressable as `$` inside this node. */
  forEach?: string;
  /** How fan-out results reconcile. See runtime/engine.ts. */
  join?: string;
  /** Guard expression, e.g. "$.world.verdict.confidence < 0.7". */
  when?: string;
  /** Hard ceiling for a single fan-out item. */
  budget?: { maxUsd?: number; maxParallel?: number };
  retries?: number;
}

export interface WorkflowSpec {
  name: string;
  description?: string;
  /** The shared world state schema - the "evermind". */
  world: Record<string, WorldField>;
  /** Run inputs. */
  input?: Contract;
  /** Global spend ceiling; the run aborts when exceeded. */
  budget?: { maxUsd?: number };
  nodes: NodeSpec[];
}

// ---------------------------------------------------------------------------
// Binding decisions (the explainability surface)
// ---------------------------------------------------------------------------

export interface CandidateReport {
  id: string;
  ok: boolean;
  reasons: string[];
  score?: number;
}

export interface BindingDecision {
  /** The chosen model, or null if no candidate survived. */
  model: ModelProfile | null;
  source: 'pin' | 'byIndex' | 'policy' | 'escalation' | 'fallback' | 'human_gate';
  candidates: CandidateReport[];
  /** Human-readable account of why this model won. Goes into the chronicle. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Wire format for model calls
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxOut?: number;
  temperature?: number;
  /** Hint for the mock provider; ignored by real providers. */
  expect?: Contract;
  /** Stable key for the content-addressed cache. */
  cacheKey: string;
}

export interface CompletionResponse {
  text: string;
  /** Parsed structured payload when the agent declares an out contract. */
  data?: Record<string, unknown>;
  usage: { in: number; out: number };
  latencyMs: number;
  /** True when served from the content-addressed cache. */
  cached?: boolean;
  model: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// Chronicle events
// ---------------------------------------------------------------------------

export type TraceEventType =
  | 'run.start'
  | 'run.end'
  | 'node.start'
  | 'node.skip'
  | 'bind.resolve'
  | 'bind.escalate'
  | 'llm.call'
  | 'llm.result'
  | 'llm.error'
  | 'world.write'
  | 'human.gate'
  | 'budget.exceeded';

export interface TraceEvent {
  seq: number;
  ts: string;
  type: TraceEventType;
  node?: string;
  item?: number;
  data: Record<string, unknown>;
}

export interface NodeRunRecord {
  node: string;
  status: 'ok' | 'skipped' | 'failed';
  model?: string;
  provider?: string;
  bindingSource?: string;
  bindingReasons?: string[];
  costUsd: number;
  tokens: { in: number; out: number };
  latencyMs: number;
  attempts: number;
  cacheHits: number;
  items?: number;
  output?: unknown;
  error?: string;
}

export interface RunMeta {
  runId: string;
  workflow: string;
  startedAt: string;
  finishedAt: string;
  input: Record<string, unknown>;
  nodes: NodeRunRecord[];
  totalCostUsd: number;
  totalTokens: { in: number; out: number };
  /** runId -> node -> model, enabling replay to reuse cached calls. */
  bindings: Record<string, string>;
  replayOf?: string;
  swaps?: Record<string, string>;
  status: 'ok' | 'failed' | 'budget_exceeded';
  error?: string;
}

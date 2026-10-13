/**
 * Mock provider - the reason `git clone && npm start` works with no API keys.
 *
 * It is a *synthesiser*, not a stub: responses are deterministic per
 * (model, messages), structurally valid against the agent's `out` contract,
 * and deliberately stylised per model family. That last property matters -
 * a cross-model diff is only meaningful if the models actually differ, so the
 * mock makes Claude hedge, Gemini enumerate, and DeepSeek stay terse. Swap in
 * real providers and every downstream mechanism (binding, cache, replay, diff,
 * escalation) behaves identically.
 *
 * Set SYNCW_MOCK_FAIL="openai/*,google/*" to exercise fallback/escalation.
 */

import type { CompletionRequest, CompletionResponse, FieldSpec, ModelProfile } from '../schema/types.ts';
import type { Provider } from './types.ts';
import { ProviderError } from './types.ts';
import { globMatch } from '../util/glob.ts';

interface Voice {
  tag: string;
  verbs: string[];
  frame: string;
}

const VOICES: Record<string, Voice> = {
  claude: {
    tag: 'C',
    verbs: ['carefully bound', 'explicitly scoped', 'hedged against', 'conservatively sized'],
    frame: 'Primary risk is under-specification; prefer narrowing scope before committing.',
  },
  gpt: {
    tag: 'G',
    verbs: ['sequenced', 'checklisted', 'decomposed', 'instrumented'],
    frame: 'Decompose into verifiable checkpoints and gate each on an observable signal.',
  },
  gemini: {
    tag: 'M',
    verbs: ['enumerated', 'broadened', 'cross-referenced', 'surveyed'],
    frame: 'Several adjacent approaches are viable; breadth-first beats depth-first here.',
  },
  deepseek: {
    tag: 'D',
    verbs: ['reduced', 'formalised', 'minimised', 'derived'],
    frame: 'Reduce to the smallest invariant and prove the rest is mechanical.',
  },
  llama: {
    tag: 'L',
    verbs: ['pragmatised', 'shipped', 'trimmed', 'iterated'],
    frame: 'Ship the thinnest end-to-end slice, then widen on real feedback.',
  },
  qwen: {
    tag: 'Q',
    verbs: ['tabulated', 'indexed', 'aligned', 'reconciled'],
    frame: 'Tabulate the options against the constraints before choosing.',
  },
};

const FALLBACK_VERBS = ['considered', 'outlined', 'sketched', 'framed'];

/**
 * Every family gets a distinct voice, including ones we have never heard of.
 *
 * The synthesiser exists to make cross-model diffs meaningful, and a diff is
 * only meaningful if different models actually differ. A shared generic voice
 * for unknown families would quietly make every unlisted model look identical -
 * which is exactly the failure mode this mock is supposed to prevent.
 */
function voiceFor(family: string): Voice {
  const known = VOICES[family];
  if (known) return known;
  return {
    tag: (family.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '??').toUpperCase(),
    verbs: FALLBACK_VERBS,
    frame: `${family}-lineage prior: take the most reversible option and say what would change your mind.`,
  };
}

export interface MockProviderOptions {
  lookupModel: (id: string) => ModelProfile | undefined;
  /** Patterns forced to fail, for exercising fallback/escalation. */
  failPatterns?: string[];
  /** Injected clock, for deterministic tests. */
  now?: () => number;
}

export class MockProvider implements Provider {
  readonly name = 'mock';
  private readonly opts: MockProviderOptions;
  private readonly failPatterns: string[];

  constructor(opts: MockProviderOptions) {
    this.opts = opts;
    this.failPatterns = opts.failPatterns ?? parseFailPatterns(process.env['SYNCW_MOCK_FAIL']);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = this.opts.lookupModel(req.model);
    if (!model) {
      throw new ProviderError(
        `mock provider has no profile for "${req.model}"`,
        this.name,
        req.model,
        false,
      );
    }

    if (this.failPatterns.some((p) => globMatch(p, req.model))) {
      throw new ProviderError(
        `mock failure injected for "${req.model}" via SYNCW_MOCK_FAIL`,
        this.name,
        req.model,
      );
    }

    const seed = fnv1a(`${req.model}\u0000${req.messages.map((m) => m.content).join('\u0000')}`);
    const rand = mulberry32(seed);
    const voice = voiceFor(model.family);

    const data = req.expect ? synthesise(req.expect, voice, rand, req, model) : undefined;
    const text = data ? JSON.stringify(data, null, 2) : `${voice.tag}:${voice.frame}`;

    const inTokens = estimateTokens(req.messages.map((m) => m.content).join('\n'));
    const outTokens = estimateTokens(text);
    const latencyMs = Math.round((model.latencyP50Ms ?? 900) * (0.75 + rand() * 0.6));

    return {
      text,
      ...(data ? { data } : {}),
      usage: { in: inTokens, out: outTokens },
      latencyMs,
      model: model.id,
      provider: model.provider,
    };
  }
}

export function parseFailPatterns(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// ---------------------------------------------------------------------------
// Contract-driven synthesis
// ---------------------------------------------------------------------------

function synthesise(
  contract: Record<string, FieldSpec>,
  voice: Voice,
  rand: () => number,
  req: CompletionRequest,
  model: ModelProfile,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const goal = extractGoal(req);
  for (const [field, spec] of Object.entries(contract)) {
    out[field] = synthesisField(field, spec, voice, rand, goal, model);
  }
  return out;
}

function synthesisField(
  field: string,
  spec: FieldSpec,
  voice: Voice,
  rand: () => number,
  goal: string,
  model: ModelProfile,
): unknown {
  const name = field.toLowerCase();

  if (name === 'plan' || name === 'steps' || name === 'approach') {
    const n = 3 + Math.floor(rand() * 2);
    return {
      steps: Array.from({ length: n }, (_, i) => ({
        id: `s${i + 1}`,
        title: `${voice.tag}${i + 1}. ${capitalise(pick(voice.verbs, rand))} ${topic(goal, i)}`,
        detail: `${voice.frame} (step ${i + 1}/${n})`,
      })),
      open_questions: [
        `${topic(goal, 0)}: what is the actual acceptance signal?`,
        `${topic(goal, 1)}: which constraint is load-bearing vs cosmetic?`,
      ],
      produced_by: model.id,
    };
  }

  if (name === 'questions' || name === 'items' || name === 'topics') {
    const n = 2 + Math.floor(rand() * 2);
    return Array.from({ length: n }, (_, i) => `${topic(goal, i)} (${voice.tag} view)`);
  }

  if (name === 'findings' || name === 'results' || name === 'research') {
    const n = 2 + Math.floor(rand() * 2);
    return Array.from({ length: n }, (_, i) => ({
      question: topic(goal, i),
      answer: `${voice.tag}: ${capitalise(pick(voice.verbs, rand))} - ${voice.frame}`,
      source: `${model.provider}/${model.family}`,
      confidence: round2(0.55 + rand() * 0.4),
    }));
  }

  if (name === 'verdict' || name === 'review' || name === 'judgement') {
    const passed = rand() > 0.3;
    return {
      passed,
      confidence: round2(0.5 + rand() * 0.45),
      rationale: `${voice.tag} judgement: ${voice.frame}`,
      issues: passed
        ? []
        : [`${topic(goal, 0)} lacks a measurable acceptance criterion`, `ownership of ${topic(goal, 1)} is unassigned`],
      judged_by: model.id,
    };
  }

  if (name === 'patches' || name === 'changes' || name === 'edits') {
    const n = 1 + Math.floor(rand() * 2);
    return Array.from({ length: n }, (_, i) => ({
      file: `src/${slug(topic(goal, i))}.ts`,
      change: `${voice.tag}: ${pick(voice.verbs, rand)} the ${topic(goal, i)} path`,
      confidence: round2(0.5 + rand() * 0.45),
    }));
  }

  if (name === 'confidence' || name === 'score') {
    return round2(0.5 + rand() * 0.45);
  }

  if (name === 'summary' || name === 'text' || name === 'note' || name === 'rationale') {
    return `${voice.tag} summary of "${truncate(goal, 60)}": ${voice.frame}`;
  }

  // Generic fallback honouring the declared type.
  switch (spec.type) {
    case 'number':
      return round2(rand() * 10);
    case 'boolean':
      return rand() > 0.5;
    case 'json':
      return { voice: voice.tag, model: model.id, note: voice.frame };
    case 'string':
    case 'markdown':
    default:
      return `${voice.tag}: ${voice.frame}`;
  }
}

function extractGoal(req: CompletionRequest): string {
  const user = [...req.messages].reverse().find((m) => m.role === 'user');
  const text = user?.content ?? '';
  const m = /"(?:goal|task|objective|question)"\s*:\s*"([^"]{4,200})"/i.exec(text);
  if (m) return m[1]!;
  const firstLine = text.split('\n').find((l) => l.trim().length > 8);
  return (firstLine ?? 'the task').replace(/^[^:]*:\s*/, '').slice(0, 160);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'a', 'an', 'of', 'to', 'in', 'on',
  'is', 'are', 'be', 'it', 'we', 'you', 'our', 'their', 'as', 'at', 'by', 'or', 'if', 'then',
]);

function topic(goal: string, index: number): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length === 0) return `aspect-${index + 1}`;
  const start = index % Math.max(1, words.length - 1);
  return words.slice(start, start + 2).join('-') || words[0]!;
}

function pick(list: readonly string[], rand: () => number): string {
  return list[Math.floor(rand() * list.length)] ?? list[0]!;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'module';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateTokens(text: string): number {
  // ~4 chars/token is the usual English rule of thumb; good enough for budgeting.
  return Math.max(1, Math.ceil(text.length / 4));
}

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

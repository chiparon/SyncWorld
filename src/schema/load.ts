/**
 * Registry loading + hand-rolled validation.
 *
 * We deliberately avoid a schema library in M0: the DSL is the product, so its
 * diagnostics should be ours. Every error names the file, the path, and the fix.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  AgentSpec,
  BindPolicy,
  MergeStrategy,
  ModelProfile,
  NodeSpec,
  ProviderConfig,
  FieldSpec,
  FieldType,
  WorkflowSpec,
  WorldField,
} from './types.ts';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SyncwConfigError extends Error {
  readonly file: string | undefined;
  readonly path: string | undefined;

  constructor(message: string, file?: string, path?: string) {
    super(file ? `${file}${path ? `:${path}` : ''}: ${message}` : message);
    this.name = 'SyncwConfigError';
    this.file = file;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Primitive coercion helpers
// ---------------------------------------------------------------------------

const FIELD_TYPES: readonly FieldType[] = ['string', 'markdown', 'number', 'boolean', 'json'];
const MERGE_STRATEGIES: readonly MergeStrategy[] = [
  'replace',
  'append',
  'last_write_wins',
  'first_write_wins',
  'sum',
  'max',
];

function asRecord(v: unknown, file: string, path: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new SyncwConfigError(`expected a mapping, got ${describe(v)}`, file, path);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, file: string, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new SyncwConfigError(`expected a non-empty string, got ${describe(v)}`, file, path);
  }
  return v;
}

function asOptionalString(v: unknown, file: string, path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return asString(v, file, path);
}

function asStringArray(v: unknown, file: string, path: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) {
    throw new SyncwConfigError(`expected a list of strings, got ${describe(v)}`, file, path);
  }
  return v.map((item, i) => asString(item, file, `${path}[${i}]`));
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `a list of ${v.length}`;
  return typeof v;
}

// ---------------------------------------------------------------------------
// Field / world specs
// ---------------------------------------------------------------------------

function parseFieldSpec(v: unknown, file: string, path: string): FieldSpec {
  const raw = asRecord(v, file, path);
  const type = asString(raw['type'], file, `${path}.type`) as FieldType;
  if (!FIELD_TYPES.includes(type)) {
    throw new SyncwConfigError(
      `unknown type "${type}". Expected one of: ${FIELD_TYPES.join(', ')}`,
      file,
      `${path}.type`,
    );
  }
  const spec: FieldSpec = { type };
  const schema = asOptionalString(raw['schema'], file, `${path}.schema`);
  if (schema) spec.schema = schema;
  if (typeof raw['required'] === 'boolean') spec.required = raw['required'];
  if (raw['default'] !== undefined) spec.default = raw['default'];
  return spec;
}

function parseContract(v: unknown, file: string, path: string): Record<string, FieldSpec> {
  const raw = asRecord(v, file, path);
  const out: Record<string, FieldSpec> = {};
  for (const [key, val] of Object.entries(raw)) {
    out[key] = parseFieldSpec(val, file, `${path}.${key}`);
  }
  return out;
}

function parseWorld(v: unknown, file: string): Record<string, WorldField> {
  const raw = asRecord(v, file, 'world');
  const out: Record<string, WorldField> = {};
  for (const [key, val] of Object.entries(raw)) {
    const f = asRecord(val, file, `world.${key}`);
    const type = asString(f['type'], file, `world.${key}.type`) as FieldType;
    if (!FIELD_TYPES.includes(type)) {
      throw new SyncwConfigError(
        `unknown type "${type}". Expected one of: ${FIELD_TYPES.join(', ')}`,
        file,
        `world.${key}.type`,
      );
    }
    const merge = asString(f['merge'], file, `world.${key}.merge`) as MergeStrategy;
    if (!MERGE_STRATEGIES.includes(merge)) {
      throw new SyncwConfigError(
        `unknown merge strategy "${merge}". Expected one of: ${MERGE_STRATEGIES.join(', ')}`,
        file,
        `world.${key}.merge`,
      );
    }
    const field: WorldField = { type, merge };
    const owner = asOptionalString(f['owner'], file, `world.${key}.owner`);
    if (owner) field.owner = owner;
    const description = asOptionalString(f['description'], file, `world.${key}.description`);
    if (description) field.description = description;
    out[key] = field;
  }
  if (Object.keys(out).length === 0) {
    throw new SyncwConfigError('a workflow must declare at least one world field', file, 'world');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bind policy
// ---------------------------------------------------------------------------

const PREFER_VALUES = new Set(['cost', 'quality', 'latency', 'balanced']);

function parseBind(v: unknown, file: string, path: string): BindPolicy {
  const raw = asRecord(v, file, path);
  const bind: BindPolicy = {};

  const pin = asOptionalString(raw['pin'], file, `${path}.pin`);
  if (pin) bind.pin = pin;

  const require = asStringArray(raw['require'], file, `${path}.require`);
  if (require.length) bind.require = require;

  const prefer = asOptionalString(raw['prefer'], file, `${path}.prefer`);
  if (prefer) {
    if (!PREFER_VALUES.has(prefer)) {
      throw new SyncwConfigError(
        `unknown prefer "${prefer}". Expected one of: ${[...PREFER_VALUES].join(', ')}`,
        file,
        `${path}.prefer`,
      );
    }
    bind.prefer = prefer as BindPolicy['prefer'];
  }

  const fallback = asStringArray(raw['fallback'], file, `${path}.fallback`);
  if (fallback.length) bind.fallback = fallback;

  const byIndex = asStringArray(raw['by_index'], file, `${path}.by_index`);
  if (byIndex.length) bind.byIndex = byIndex;

  const esc = raw['escalate_if'];
  if (esc !== undefined && esc !== null) {
    const e = asRecord(esc, file, `${path}.escalate_if`);
    const escalateIf: NonNullable<BindPolicy['escalateIf']> = {};
    if (typeof e['retries'] === 'number') escalateIf.retries = e['retries'];
    const to = asOptionalString(e['to'], file, `${path}.escalate_if.to`);
    if (to) {
      if (!PREFER_VALUES.has(to)) {
        throw new SyncwConfigError(
          `unknown escalation target "${to}". Expected one of: ${[...PREFER_VALUES].join(', ')}`,
          file,
          `${path}.escalate_if.to`,
        );
      }
      escalateIf.to = to as NonNullable<BindPolicy['escalateIf']>['to'];
    }
    bind.escalateIf = escalateIf;
  }

  if (typeof raw['max_usd'] === 'number') bind.maxUsd = raw['max_usd'];

  return bind;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

function parseNode(v: unknown, file: string, index: number): NodeSpec {
  const raw = asRecord(v, file, `nodes[${index}]`);
  const id = asString(raw['id'], file, `nodes[${index}].id`);

  const kindRaw = asOptionalString(raw['kind'], file, `nodes.${id}.kind`) ?? 'agent';
  if (kindRaw !== 'agent' && kindRaw !== 'human_gate') {
    throw new SyncwConfigError(
      `unknown node kind "${kindRaw}". Expected "agent" or "human_gate"`,
      file,
      `nodes.${id}.kind`,
    );
  }
  const node: NodeSpec = { id, kind: kindRaw };

  const agent = asOptionalString(raw['agent'], file, `nodes.${id}.agent`);
  if (agent) node.agent = agent;
  if (kindRaw === 'agent' && !agent) {
    throw new SyncwConfigError('an agent node requires `agent:`', file, `nodes.${id}`);
  }

  if (raw['bind'] !== undefined && raw['bind'] !== null) {
    node.bind = parseBind(raw['bind'], file, `nodes.${id}.bind`);
  }
  if (raw['in'] !== undefined && raw['in'] !== null) {
    node.in = asRecord(raw['in'], file, `nodes.${id}.in`) as Record<string, string>;
  }
  if (raw['out'] !== undefined && raw['out'] !== null) {
    // Two accepted forms:
    //   out: [plan, findings]              world field == contract field
    //   out: { plan: plan, notes: text }   explicit rename
    if (Array.isArray(raw['out'])) {
      const mapping: Record<string, string> = {};
      raw['out'].forEach((entry, i) => {
        const name = asString(entry, file, `nodes.${id}.out[${i}]`);
        mapping[name] = name;
      });
      node.out = mapping;
    } else {
      node.out = asRecord(raw['out'], file, `nodes.${id}.out`) as Record<string, string>;
    }
  }
  const needs = asStringArray(raw['needs'], file, `nodes.${id}.needs`);
  if (needs.length) node.needs = needs;

  const forEach = asOptionalString(raw['for_each'], file, `nodes.${id}.for_each`);
  if (forEach) node.forEach = forEach;

  const join = asOptionalString(raw['join'], file, `nodes.${id}.join`);
  if (join) node.join = join;

  const when = asOptionalString(raw['when'], file, `nodes.${id}.when`);
  if (when) node.when = when;

  if (raw['budget'] !== undefined && raw['budget'] !== null) {
    const b = asRecord(raw['budget'], file, `nodes.${id}.budget`);
    const budget: NonNullable<NodeSpec['budget']> = {};
    if (typeof b['max_usd'] === 'number') budget.maxUsd = b['max_usd'];
    if (typeof b['max_parallel'] === 'number') budget.maxParallel = b['max_parallel'];
    node.budget = budget;
  }

  if (typeof raw['retries'] === 'number') node.retries = raw['retries'];

  return node;
}

export function parseWorkflow(text: string, file: string): WorkflowSpec {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new SyncwConfigError(`YAML parse failed: ${(err as Error).message}`, file);
  }
  const raw = asRecord(doc, file, '<root>');

  const spec: WorkflowSpec = {
    name: asString(raw['name'], file, 'name'),
    world: parseWorld(raw['world'], file),
    nodes: [],
  };
  const description = asOptionalString(raw['description'], file, 'description');
  if (description) spec.description = description;

  if (raw['input'] !== undefined && raw['input'] !== null) {
    spec.input = parseContract(raw['input'], file, 'input');
  }

  if (raw['budget'] !== undefined && raw['budget'] !== null) {
    const b = asRecord(raw['budget'], file, 'budget');
    spec.budget = {};
    if (typeof b['max_usd'] === 'number') spec.budget.maxUsd = b['max_usd'];
  }

  const nodesRaw = raw['nodes'];
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    throw new SyncwConfigError('a workflow must declare a non-empty `nodes:` list', file, 'nodes');
  }
  spec.nodes = nodesRaw.map((n, i) => parseNode(n, file, i));

  validateGraph(spec, file);
  return spec;
}

function validateGraph(spec: WorkflowSpec, file: string): void {
  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (ids.has(node.id)) {
      throw new SyncwConfigError(`duplicate node id "${node.id}"`, file, 'nodes');
    }
    ids.add(node.id);
  }

  // Default dependency: the previous node in declaration order. Keeps linear
  // workflows ceremony-free while staying explicit in the graph.
  spec.nodes.forEach((node, i) => {
    if (!node.needs) {
      node.needs = i === 0 ? [] : [spec.nodes[i - 1]!.id];
    }
  });

  for (const node of spec.nodes) {
    for (const dep of node.needs ?? []) {
      if (!ids.has(dep)) {
        throw new SyncwConfigError(
          `node "${node.id}" depends on unknown node "${dep}"`,
          file,
          `nodes.${node.id}.needs`,
        );
      }
      if (dep === node.id) {
        throw new SyncwConfigError(`node "${node.id}" depends on itself`, file, `nodes.${node.id}`);
      }
    }
    for (const field of Object.keys(node.out ?? {})) {
      if (!(field in spec.world)) {
        throw new SyncwConfigError(
          `node "${node.id}" writes undeclared world field "${field}". ` +
            `Add it under \`world:\` with an explicit merge strategy.`,
          file,
          `nodes.${node.id}.out`,
        );
      }
      const owner = spec.world[field]!.owner;
      if (owner && owner !== node.id) {
        throw new SyncwConfigError(
          `node "${node.id}" writes world field "${field}", which is owned by "${owner}"`,
          file,
          `nodes.${node.id}.out`,
        );
      }
    }
  }

  detectCycles(spec, file);
}

function detectCycles(spec: WorkflowSpec, file: string): void {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(' -> ');
      throw new SyncwConfigError(`dependency cycle detected: ${cycle}`, file, 'nodes');
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.needs ?? []) visit(dep);
    stack.pop();
    state.set(id, 'done');
  };

  for (const node of spec.nodes) visit(node.id);
}

// ---------------------------------------------------------------------------
// Registry loaders
// ---------------------------------------------------------------------------

export function readYamlFile(path: string): unknown {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new SyncwConfigError('file not found', abs);
  }
  const text = readFileSync(abs, 'utf8');
  try {
    return parseYaml(text);
  } catch (err) {
    throw new SyncwConfigError(`YAML parse failed: ${(err as Error).message}`, abs);
  }
}

export function loadWorkflow(path: string): WorkflowSpec {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new SyncwConfigError('file not found', abs);
  return parseWorkflow(readFileSync(abs, 'utf8'), abs);
}

export function loadAgents(dir: string): Map<string, AgentSpec> {
  const out = new Map<string, AgentSpec>();
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new SyncwConfigError('agents directory not found', abs);

  for (const name of readdirSync(abs).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    const file = join(abs, name);
    const raw = asRecord(readYamlFile(file), file, '<root>');
    const spec: AgentSpec = {
      name: asString(raw['name'], file, 'name'),
      role: asString(raw['role'], file, 'role'),
      instructions: asString(raw['instructions'], file, 'instructions'),
      out: {},
    };
    const tools = asStringArray(raw['tools'], file, 'tools');
    if (tools.length) spec.tools = tools;
    if (raw['in'] !== undefined && raw['in'] !== null) {
      spec.in = parseContract(raw['in'], file, 'in');
    }
    if (raw['out'] === undefined || raw['out'] === null) {
      throw new SyncwConfigError(
        'an agent must declare an `out:` contract - it is the seam that keeps ' +
          'information intact across model boundaries',
        file,
        'out',
      );
    }
    spec.out = parseContract(raw['out'], file, 'out');

    if (raw['prompt_by_family'] !== undefined && raw['prompt_by_family'] !== null) {
      const pbf = asRecord(raw['prompt_by_family'], file, 'prompt_by_family');
      const map: Record<string, string> = {};
      for (const [fam, text] of Object.entries(pbf)) {
        map[fam] = asString(text, file, `prompt_by_family.${fam}`);
      }
      spec.promptByFamily = map;
    }

    const key = basename(name).replace(/\.ya?ml$/, '');
    if (out.has(key)) throw new SyncwConfigError(`duplicate agent "${key}"`, abs);
    out.set(key, spec);
  }
  return out;
}

export function loadModels(dir: string): ModelProfile[] {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new SyncwConfigError('models directory not found', abs);
  const models: ModelProfile[] = [];

  for (const name of readdirSync(abs).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    const file = join(abs, name);
    const raw = asRecord(readYamlFile(file), file, '<root>');
    const list = raw['models'];
    if (!Array.isArray(list)) {
      throw new SyncwConfigError('expected a top-level `models:` list', file);
    }
    list.forEach((entry, i) => {
      const m = asRecord(entry, file, `models[${i}]`);
      const cost = asRecord(m['cost'], file, `models[${i}].cost`);
      const profile: ModelProfile = {
        id: asString(m['id'], file, `models[${i}].id`),
        provider: asString(m['provider'], file, `models[${i}].provider`),
        family: asString(m['family'], file, `models[${i}].family`),
        ctx: Number(m['ctx'] ?? 0),
        caps: asStringArray(m['caps'], file, `models[${i}].caps`) as ModelProfile['caps'],
        cost: {
          in: Number(cost['in'] ?? 0),
          out: Number(cost['out'] ?? 0),
        },
      };
      const label = asOptionalString(m['label'], file, `models[${i}].label`);
      if (label) profile.label = label;
      if (typeof m['max_out'] === 'number') profile.maxOut = m['max_out'];
      if (typeof m['latency_p50_ms'] === 'number') profile.latencyP50Ms = m['latency_p50_ms'];
      if (typeof m['quality'] === 'number') profile.quality = m['quality'];
      const notes = asOptionalString(m['notes'], file, `models[${i}].notes`);
      if (notes) profile.notes = notes;
      models.push(profile);
    });
  }

  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) throw new SyncwConfigError(`duplicate model id "${m.id}"`, abs);
    seen.add(m.id);
  }
  return models;
}

export function loadProviders(dir: string): Map<string, ProviderConfig> {
  const out = new Map<string, ProviderConfig>();
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new SyncwConfigError('providers directory not found', abs);

  for (const name of readdirSync(abs).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    const file = join(abs, name);
    const raw = asRecord(readYamlFile(file), file, '<root>');
    const kind = asString(raw['kind'], file, 'kind');
    if (kind !== 'mock' && kind !== 'openai-compat') {
      throw new SyncwConfigError(
        `unknown provider kind "${kind}". Expected "mock" or "openai-compat"`,
        file,
        'kind',
      );
    }
    const cfg: ProviderConfig = { name: asString(raw['name'], file, 'name'), kind };
    const baseUrl = asOptionalString(raw['base_url'], file, 'base_url');
    if (baseUrl) cfg.baseUrl = baseUrl;
    const apiKeyEnv = asOptionalString(raw['api_key_env'], file, 'api_key_env');
    if (apiKeyEnv) cfg.apiKeyEnv = apiKeyEnv;
    if (typeof raw['timeout_ms'] === 'number') cfg.timeoutMs = raw['timeout_ms'];
    if (typeof raw['max_retries'] === 'number') cfg.maxRetries = raw['max_retries'];
    const notes = asOptionalString(raw['notes'], file, 'notes');
    if (notes) cfg.notes = notes;

    const key = basename(name).replace(/\.ya?ml$/, '');
    out.set(key, cfg);
  }
  return out;
}

/** Resolve the project root by walking up from cwd looking for `syncw.yaml`. */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'syncw.yaml')) || existsSync(join(dir, 'workflows'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

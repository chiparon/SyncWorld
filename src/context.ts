/**
 * Project context: loads syncw.yaml plus the three registries.
 *
 * Everything the CLI does starts here, and nothing here knows about any
 * specific model vendor. That is the point.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { AgentSpec, ModelProfile, ProviderConfig, WorkflowSpec } from './schema/types.ts';
import { SyncwConfigError, loadAgents, loadModels, loadProviders, loadWorkflow } from './schema/load.ts';
import { createProviderRegistry } from './providers/index.ts';
import type { ProviderRegistry } from './providers/index.ts';
import { CallCache } from './runtime/cache.ts';
import { RunStore } from './runtime/trace.ts';

export interface SyncwConfig {
  name: string;
  paths: {
    agents: string;
    models: string;
    providers: string;
    workflows: string;
  };
}

const DEFAULT_CONFIG: SyncwConfig = {
  name: 'syncw',
  paths: { agents: 'agents', models: 'models', providers: 'providers', workflows: 'workflows' },
};

export interface ContextOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  failPatterns?: string[];
  /** Force offline synthesis. `undefined` = auto-detect from credentials. */
  offline?: boolean;
}

export interface ProjectContext {
  root: string;
  config: SyncwConfig;
  agents: Map<string, AgentSpec>;
  models: ModelProfile[];
  providers: ProviderRegistry;
  providerConfigs: Map<string, ProviderConfig>;
  modelById: Map<string, ModelProfile>;
  runStore: RunStore;
  cache: CallCache;
  /** True when no real credentials were found and traffic is being synthesised. */
  offline: boolean;
}

export function loadConfig(root: string): SyncwConfig {
  const path = join(root, 'syncw.yaml');
  if (!existsSync(path)) return DEFAULT_CONFIG;

  const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG;

  const paths = (raw['paths'] ?? {}) as Record<string, string>;
  const config: SyncwConfig = {
    name: typeof raw['name'] === 'string' ? raw['name'] : DEFAULT_CONFIG.name,
    paths: { ...DEFAULT_CONFIG.paths },
  };
  for (const key of Object.keys(DEFAULT_CONFIG.paths) as Array<keyof SyncwConfig['paths']>) {
    if (typeof paths[key] === 'string') config.paths[key] = paths[key];
  }
  return config;
}

export function loadContext(opts: ContextOptions = {}): ProjectContext {
  const root = resolve(opts.root ?? process.cwd());
  const config = loadConfig(root);
  const abs = (p: string): string => (isAbsolute(p) ? p : join(root, p));

  const env = opts.env ?? process.env;
  const agents = loadAgents(abs(config.paths.agents));
  const models = loadModels(abs(config.paths.models));
  const providerConfigs = loadProviders(abs(config.paths.providers));

  // A model whose provider is not in the registry at all is a config bug, not a
  // runtime condition: surface it immediately.
  const orphaned = models.filter((m) => !providerConfigs.has(m.provider));
  if (orphaned.length > 0) {
    const byProvider = [...new Set(orphaned.map((m) => m.provider))];
    throw new SyncwConfigError(
      `model registry references unknown provider(s): ${byProvider.join(', ')}. ` +
        `Add providers/<name>.yaml for each, or fix the \`provider:\` field in models/.`,
      abs(config.paths.models),
    );
  }

  // Offline resolution:
  //   SYNCW_OFFLINE=1  -> force on
  //   SYNCW_OFFLINE=0  -> force off
  //   unset            -> auto: on iff no *real* provider has credentials.
  // The mock provider is excluded from that probe on purpose - it is always
  // ready, and counting it would mean offline mode could never activate.
  // Auto-on means `git clone && npm start` works; a machine with real keys
  // silently uses them. Either way `syncw providers` prints the actual routing.
  const offlineOverride = opts.offline ?? envFlag(env['SYNCW_OFFLINE']);
  const anyRealProviderReady = [...providerConfigs.values()].some((cfg) => {
    if (cfg.kind !== 'openai-compat' || !cfg.baseUrl) return false;
    const apiKeyEnv = cfg.apiKeyEnv ?? `${cfg.name.toUpperCase()}_API_KEY`;
    return Boolean(env[apiKeyEnv]);
  });
  const offline = offlineOverride ?? !anyRealProviderReady;

  const providers = createProviderRegistry(providerConfigs, models, {
    env,
    offline,
    ...(opts.failPatterns ? { failPatterns: opts.failPatterns } : {}),
  });

  return {
    root,
    config,
    agents,
    models,
    providers,
    providerConfigs,
    modelById: new Map(models.map((m) => [m.id, m])),
    runStore: RunStore.open(root),
    cache: CallCache.open(root, env['SYNCW_NO_CACHE'] !== '1'),
    offline,
  };
}

function envFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export function resolveWorkflowPath(ctx: ProjectContext, arg: string): string {
  if (existsSync(arg)) return resolve(arg);
  const candidate = join(ctx.root, ctx.config.paths.workflows, arg);
  if (existsSync(candidate)) return candidate;
  const withExt = `${candidate}.yaml`;
  if (existsSync(withExt)) return withExt;
  throw new SyncwConfigError(
    `no workflow found for "${arg}". Looked in ${join(ctx.root, ctx.config.paths.workflows)}/`,
  );
}

/** Apply declared defaults, then validate that every required input is present. */
export function buildInput(
  workflow: WorkflowSpec,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...provided };
  for (const [name, spec] of Object.entries(workflow.input ?? {})) {
    if (out[name] === undefined || out[name] === null || out[name] === '') {
      if (spec.default !== undefined) out[name] = spec.default;
    }
    if ((out[name] === undefined || out[name] === null || out[name] === '') && spec.required) {
      throw new SyncwConfigError(
        `workflow "${workflow.name}" requires input "${name}". ` +
          `Pass it with \`--input ${name}=...\``,
      );
    }
  }
  return out;
}

export function loadWorkflowFor(ctx: ProjectContext, arg: string): WorkflowSpec {
  return loadWorkflow(resolveWorkflowPath(ctx, arg));
}

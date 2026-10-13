/**
 * Provider registry + availability.
 *
 * Availability is a first-class concept: the binding engine needs to know not
 * just which models *could* do the work, but which ones this machine can
 * actually reach right now. A missing API key should downgrade a candidate,
 * never crash a run - and `syncw bind` should still be able to show you the
 * plan you *would* get if you configured the key.
 */

import type { ModelProfile, ProviderConfig } from '../schema/types.ts';
import type { Provider } from './types.ts';
import type { ProviderAvailability } from '../runtime/binding.ts';
import { MockProvider, parseFailPatterns } from './mock.ts';
import { OpenAiCompatProvider } from './openai-compat.ts';

export interface ProviderRegistry extends ProviderAvailability {
  get(providerName: string): Provider | undefined;
  names(): string[];
  describe(): Array<{ name: string; kind: string; ready: boolean; detail: string }>;
}

export interface RegistryOptions {
  env?: Record<string, string | undefined>;
  failPatterns?: string[];
  /**
   * Route every model through the offline synthesiser, whatever its declared
   * provider. The capability registry, the binding policy, and the trace are
   * all unchanged - only the wire is substituted. This is what makes the whole
   * system - including cross-model binding and replay/diff - runnable with no
   * credentials at all.
   */
  offline?: boolean;
}

export function createProviderRegistry(
  configs: Map<string, ProviderConfig>,
  models: readonly ModelProfile[],
  options: RegistryOptions = {},
): ProviderRegistry {
  const env = options.env ?? process.env;
  const offline = options.offline ?? false;
  const lookupModel = (id: string): ModelProfile | undefined => models.find((m) => m.id === id);
  const instances = new Map<string, Provider>();

  const mock = new MockProvider({ lookupModel, failPatterns: options.failPatterns });

  for (const [key, cfg] of configs) {
    if (offline) {
      // Every declared provider answers, so `require: provider:anthropic` and
      // per-vendor fallback chains stay meaningful in offline mode.
      instances.set(key, mock);
      continue;
    }
    if (cfg.kind === 'mock') {
      instances.set(key, mock);
      continue;
    }
    if (cfg.kind === 'openai-compat') {
      const apiKeyEnv = cfg.apiKeyEnv ?? `${key.toUpperCase()}_API_KEY`;
      const apiKey = env[apiKeyEnv];
      if (!apiKey || !cfg.baseUrl) continue; // not configured -> no instance, availability explains why
      instances.set(
        key,
        new OpenAiCompatProvider({
          providerName: cfg.name,
          baseUrl: cfg.baseUrl,
          apiKey,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(cfg.maxRetries !== undefined ? { maxRetries: cfg.maxRetries } : {}),
          lookupModel,
        }),
      );
    }
  }

  const registry: ProviderRegistry = {
    get: (name) => instances.get(name),
    names: () => [...instances.keys()].sort(),
    check: (provider, modelId) => {
      const cfg = configs.get(provider);
      if (!cfg) {
        return {
          ok: false,
          reason: `no provider config for "${provider}" (add providers/${provider}.yaml)`,
        };
      }
      if (offline) {
        return { ok: true, reason: `offline mode: "${provider}" served by the synthesiser` };
      }
      if (cfg.kind === 'mock') return { ok: true, reason: 'mock provider (no credentials needed)' };
      const apiKeyEnv = cfg.apiKeyEnv ?? `${provider.toUpperCase()}_API_KEY`;
      if (!cfg.baseUrl) {
        return { ok: false, reason: `provider "${provider}" has no base_url configured` };
      }
      if (!env[apiKeyEnv]) {
        return { ok: false, reason: `needs $${apiKeyEnv} (not set) for ${modelId}` };
      }
      return { ok: true, reason: `credentials present via $${apiKeyEnv}` };
    },
    describe: () =>
      [...configs.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, cfg]) => {
          if (offline) {
            const fail = parseFailPatterns(
              options.failPatterns ? options.failPatterns.join(',') : env['SYNCW_MOCK_FAIL'],
            );
            return {
              name: key,
              kind: `${cfg.kind} -> offline`,
              ready: true,
              detail: fail.length
                ? `routed via synthesiser; injecting failures for ${fail.join(', ')}`
                : 'routed via offline synthesiser',
            };
          }
          if (cfg.kind === 'mock') {
            const fail = parseFailPatterns(
              options.failPatterns ? options.failPatterns.join(',') : env['SYNCW_MOCK_FAIL'],
            );
            return {
              name: key,
              kind: cfg.kind,
              ready: true,
              detail: fail.length ? `injecting failures for ${fail.join(', ')}` : 'offline synthesiser',
            };
          }
          const apiKeyEnv = cfg.apiKeyEnv ?? `${key.toUpperCase()}_API_KEY`;
          const ready = Boolean(env[apiKeyEnv] && cfg.baseUrl);
          return {
            name: key,
            kind: cfg.kind,
            ready,
            detail: ready ? `${cfg.baseUrl}` : `set $${apiKeyEnv}${cfg.baseUrl ? '' : ' and base_url'}`,
          };
        }),
  };

  return registry;
}

/** An availability oracle that pretends every provider is wired up. */
export function optimisticAvailability(): ProviderAvailability {
  return { check: () => ({ ok: true, reason: 'preview mode' }) };
}

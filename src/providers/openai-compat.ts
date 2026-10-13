/**
 * OpenAI-compatible HTTP provider.
 *
 * One adapter, N vendors: OpenAI, DeepSeek, OpenRouter, Together, Groq, vLLM,
 * Ollama, LM Studio, and anything else speaking /chat/completions. This is the
 * deliberate "do not build a provider zoo" decision - Syncw's value is
 * selection and orchestration, not protocol translation.
 */

import type { CompletionRequest, CompletionResponse, ModelProfile } from '../schema/types.ts';
import type { Provider } from './types.ts';
import { ProviderError } from './types.ts';
import { estimateTokens } from './mock.ts';

export interface OpenAiCompatOptions {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  lookupModel?: (id: string) => ModelProfile | undefined;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

export class OpenAiCompatProvider implements Provider {
  readonly name: string;
  private readonly opts: OpenAiCompatOptions;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: OpenAiCompatOptions) {
    this.opts = opts;
    this.name = opts.providerName;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const wantsJson = req.expect !== undefined && Object.values(req.expect).some(
      (f) => f.type === 'json' || f.schema !== undefined,
    );

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    const profile = this.opts.lookupModel?.(req.model);
    if (req.maxOut ?? profile?.maxOut) body['max_tokens'] = req.maxOut ?? profile?.maxOut;
    if (wantsJson) body['response_format'] = { type: 'json_object' };

    const started = Date.now();
    let lastError: Error | undefined;
    let attempts = 0;

    while (attempts <= this.maxRetries) {
      attempts++;
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          const err = new ProviderError(
            `${this.name} returned HTTP ${res.status}: ${truncate(text, 400)}`,
            this.name,
            req.model,
            retryable,
          );
          if (!retryable) throw err;
          lastError = err;
        } else {
          const parsed = JSON.parse(text) as ChatCompletionResponse;
          const content = parsed.choices?.[0]?.message?.content ?? '';
          const usage = {
            in: parsed.usage?.prompt_tokens ?? estimateTokens(req.messages.map((m) => m.content).join('\n')),
            out: parsed.usage?.completion_tokens ?? estimateTokens(content),
          };
          const response: CompletionResponse = {
            text: content,
            usage,
            latencyMs: Date.now() - started,
            model: req.model,
            provider: this.name,
          };
          const data = req.expect ? tryParseJson(content) : undefined;
          if (data) response.data = data;
          return response;
        }
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        lastError = err as Error;
      }

      if (attempts <= this.maxRetries) {
        await sleep(Math.min(4000, 2 ** attempts * 250));
      }
    }

    throw new ProviderError(
      `${this.name} failed after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`,
      this.name,
      req.model,
    );
  }
}

/** Models routinely wrap JSON in prose or fences. Be forgiving. */
export function tryParseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

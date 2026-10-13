import type { CompletionRequest, CompletionResponse } from '../schema/types.ts';

/**
 * The provider boundary. Deliberately tiny.
 *
 * Syncw does not want to own model access - that is a solved, commoditised
 * problem (LiteLLM, OpenRouter, and every vendor's own gateway). Syncw owns
 * *selection and orchestration*. Anything that can answer a chat completion
 * plugs in here.
 */
export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly retryable: boolean;

  constructor(message: string, provider: string, model: string, retryable = true) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.model = model;
    this.retryable = retryable;
  }
}

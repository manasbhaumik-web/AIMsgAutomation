import { Injectable } from '@nestjs/common';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { GeminiAdapter } from './adapters/gemini.adapter';
import { OpenAiCompatibleAdapter } from './adapters/openai.adapter';
import { LlmAdapter, ProviderKind } from './types';

/** Maps provider kinds to adapters. Azure OpenAI and Ollama are the remaining planned kinds. */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<ProviderKind, LlmAdapter>();

  constructor() {
    this.register(new AnthropicAdapter());
    this.register(new OpenAiCompatibleAdapter('openai'));
    this.register(new OpenAiCompatibleAdapter('xai'));
    this.register(new GeminiAdapter());
  }

  register(a: LlmAdapter): void {
    this.adapters.set(a.kind, a);
  }

  get(kind: ProviderKind): LlmAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new Error(`No adapter available for provider kind "${kind}"`);
    return a;
  }

  supported(): ProviderKind[] {
    return [...this.adapters.keys()];
  }

  supportsEmbed(kind: ProviderKind): boolean {
    return typeof this.adapters.get(kind)?.embed === 'function';
  }
}

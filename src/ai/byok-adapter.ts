import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'

export type Provider = 'anthropic' | 'openai' | 'perplexity'

interface ProviderConfig {
  label: string
  placeholder: string
  defaultModel: string
  streamingModel: string
}

export const PROVIDER_CONFIGS: Record<Provider, ProviderConfig> = {
  anthropic: {
    label: 'Claude (Anthropic)',
    placeholder: 'sk-ant-...',
    defaultModel: 'claude-sonnet-4-20250514',
    streamingModel: 'claude-sonnet-4-20250514',
  },
  openai: {
    label: 'GPT-4o mini (OpenAI)',
    placeholder: 'sk-...',
    defaultModel: 'gpt-4o-mini',
    streamingModel: 'gpt-4o-mini',
  },
  perplexity: {
    label: 'Sonar (Perplexity)',
    placeholder: 'pplx-...',
    defaultModel: 'sonar',
    streamingModel: 'sonar',
  },
}

export function createModel(
  provider: Provider,
  apiKey: string,
  model?: string
) {
  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey })
      return anthropic(model ?? PROVIDER_CONFIGS.anthropic.defaultModel)
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey })
      return openai(model ?? PROVIDER_CONFIGS.openai.defaultModel)
    }
    case 'perplexity': {
      const perplexity = createOpenAI({
        apiKey,
        baseURL: 'https://api.perplexity.ai/',
      })
      return perplexity(model ?? PROVIDER_CONFIGS.perplexity.defaultModel)
    }
  }
}

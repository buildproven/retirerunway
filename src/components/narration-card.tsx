'use client'

import { useState } from 'react'
import { useCompletion } from '@ai-sdk/react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useApiKeyStore } from '@/store/api-key-store'
import { PROVIDER_CONFIGS } from '@/ai/byok-adapter'
import type { Provider } from '@/ai/byok-adapter'
import type { NarrationContext } from '@/ai/narration'

interface NarrationCardProps {
  context: NarrationContext
}

export function NarrationCard({ context }: NarrationCardProps) {
  const provider = useApiKeyStore(s => s.provider)
  const setProvider = useApiKeyStore(s => s.setProvider)
  const apiKey = useApiKeyStore(s => s.apiKey)
  const setApiKey = useApiKeyStore(s => s.setApiKey)
  const [showConfig, setShowConfig] = useState(true)

  const { completion, isLoading, complete, error } = useCompletion({
    api: '/api/narrate',
    streamProtocol: 'text',
  })

  async function handleGenerate() {
    if (!apiKey) return
    setShowConfig(false)
    await complete('', {
      body: { context, provider, apiKey },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Summary</CardTitle>
        <CardDescription>
          Get a plain-language explanation of your results
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {showConfig && !completion && (
          <form
            className="space-y-3"
            onSubmit={event => {
              event.preventDefault()
              void handleGenerate()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="narration-provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={v => setProvider(v as Provider)}
              >
                <SelectTrigger id="narration-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(PROVIDER_CONFIGS) as [
                      Provider,
                      (typeof PROVIDER_CONFIGS)[Provider],
                    ][]
                  ).map(([key, config]) => (
                    <SelectItem key={key} value={key}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="narration-api-key">API Key</Label>
              <Input
                id="narration-api-key"
                type="password"
                placeholder={PROVIDER_CONFIGS[provider].placeholder}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Your key is sent to RetireRunway&apos;s server for the requested
                provider and never stored.
              </p>
            </div>
            <Button
              type="submit"
              disabled={!apiKey || isLoading}
              className="w-full"
            >
              Generate Summary
            </Button>
          </form>
        )}

        {isLoading && !completion && (
          <div className="flex items-center gap-2">
            <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
            <span className="text-muted-foreground text-sm">
              Generating summary...
            </span>
          </div>
        )}

        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            Failed to generate summary. Check your API key and try again.
          </div>
        )}

        {completion && (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            {completion
              .split('\n')
              .map((paragraph: string, i: number) =>
                paragraph.trim() ? <p key={i}>{paragraph}</p> : null
              )}
          </div>
        )}

        {completion && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowConfig(true)
            }}
          >
            Regenerate
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

function source(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

describe('marketing claims', () => {
  it('describes the server-relayed AI path and the supported providers', () => {
    const pricing = source('src/app/pricing/page.tsx')
    const faq = source('src/app/faq/page.tsx')
    const narrationCard = source('src/components/narration-card.tsx')

    expect(pricing).toContain('Perplexity')
    expect(pricing).toContain('relayed')
    expect(pricing).toContain('through RetireRunway')
    expect(pricing).not.toContain('goes directly to the')
    expect(faq).toContain('through its server')
    expect(narrationCard).toContain('sent to RetireRunway&apos;s server')
    expect(narrationCard).not.toContain('sent directly to the provider')
  })

  it('keeps risk-score, export, and MVP pricing claims aligned with shipped behavior', () => {
    const pricing = source('src/app/pricing/page.tsx')
    const features = source('src/app/features/page.tsx')
    const faq = source('src/app/faq/page.tsx')

    expect(pricing).toContain('1–10 score')
    expect(pricing).toContain('browser print-to-PDF')
    expect(pricing).toContain('Paid packaging is planned')
    expect(pricing).not.toContain("'Data stays in your browser'")
    expect(pricing).toContain("price: 'Planned'")
    expect(pricing).not.toContain("billingIncrement: 'P1M'")
    expect(features).toContain('1–10 score')
    expect(features).not.toContain(
      'No account required. Your data never leaves your browser.'
    )
    expect(faq).toContain('1–10 scale')
    expect(faq).not.toContain('available in the Pro tier')
  })

  it('does not claim that an absent narration validator enforces citations', () => {
    const skill = source('skills/retire-runway/SKILL.md')

    expect(skill).toContain('does not ship an automated narration validator')
    expect(skill).not.toContain('validate-narration.ts')
  })
})

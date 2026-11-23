'use client'

import { useState } from 'react'

export function FinancialDisclaimer() {
  const [expanded, setExpanded] = useState(false)

  return (
    <footer className="border-t bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          Important Disclosures {expanded ? '(hide)' : '(show)'}
        </button>

        {expanded && (
          <div className="text-muted-foreground mt-3 space-y-3 text-xs leading-relaxed">
            <p>
              <strong>Not Financial Advice.</strong> RetireRunway is an
              educational tool that provides hypothetical portfolio projections
              and scenario analysis. It does not constitute financial, tax,
              investment, or legal advice. All outputs are for informational
              purposes only.
            </p>
            <p>
              <strong>No Fiduciary Relationship.</strong> Use of this tool does
              not create an advisory, fiduciary, or professional-client
              relationship. RetireRunway is not a registered investment adviser,
              broker-dealer, or financial planner.
            </p>
            <p>
              <strong>Hypothetical Projections.</strong> All scenario results,
              Monte Carlo simulations, and projected balances are based on
              simplified models using historical assumptions. They do not
              guarantee future performance. Actual returns will vary. Past
              performance is not indicative of future results.
            </p>
            <p>
              <strong>Tax Information.</strong> Any tax-related information
              (brackets, Roth conversions, Rule of 55 analysis) is general in
              nature and should not be relied upon for tax planning. Consult a
              qualified tax professional for advice specific to your situation.
            </p>
            <p>
              <strong>Data Privacy.</strong> Portfolio data uploaded or entered
              is processed in your browser. When AI narration features are used,
              summary data may be sent to third-party AI providers (Anthropic,
              OpenAI) using your own API keys (BYOK). We do not store or share
              your financial data.
            </p>
            <p>
              <strong>Consult a Professional.</strong> Before making any
              financial decisions, consult with a qualified financial advisor,
              tax professional, or attorney who can evaluate your individual
              circumstances.
            </p>
          </div>
        )}

        <p className="text-muted-foreground/60 mt-3 text-[10px]">
          &copy; {new Date().getFullYear()} RetireRunway. For educational use
          only. Not FDIC insured. Not a deposit. May lose value.
        </p>
      </div>
    </footer>
  )
}

export function InlineDisclaimer() {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <strong>Disclaimer:</strong> These projections are hypothetical and for
      educational purposes only. They are not financial advice. Past performance
      does not guarantee future results. Consult a qualified financial advisor
      before making investment decisions.
    </div>
  )
}

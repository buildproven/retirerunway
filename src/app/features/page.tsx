import type { Metadata } from 'next'
import Link from 'next/link'
import { MarketingLayout } from '@/components/marketing-layout'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'Features | RetireRunway - Retirement Scenario Analysis',
  description:
    'Explore RetireRunway features: Monte Carlo simulation, sequence of returns risk modeling, 4 market scenarios, actionable trade plans, CD analysis, and AI-powered narration.',
  keywords: [
    'retirement planning tool',
    'Monte Carlo simulation',
    'sequence of returns risk',
    'retirement scenario analysis',
    'pre-retirement calculator',
    'CD penalty analysis',
    'retirement trade plan',
  ],
  openGraph: {
    title: 'Features | RetireRunway - Retirement Scenario Analysis',
    description:
      'Monte Carlo simulation, sequence of returns risk modeling, actionable trade plans, and AI-powered narration.',
    type: 'website',
    url: '/features',
  },
}

const CORE_FEATURES = [
  {
    title: 'Four Market Scenarios',
    description:
      'See your portfolio projected across bull, base, early bear, and prolonged bear markets. Understand how different market conditions affect your retirement runway.',
    details: [
      'Bull scenario: Strong early returns, then normalization',
      'Base scenario: Historical average returns throughout',
      'Early bear: Downturn in first 3 years, then recovery',
      'Prolonged bear: Extended downturn with slow recovery',
    ],
  },
  {
    title: 'Sequence of Returns Risk Analysis',
    description:
      'The biggest risk for pre-retirees is retiring into a market downturn. We specifically model this risk and show you exactly how vulnerable your portfolio is.',
    details: [
      'Visualize early-retirement volatility impact',
      'Compare outcomes across different timing scenarios',
      'Understand why the first 5 years matter most',
      'Get specific de-risking recommendations',
    ],
  },
  {
    title: 'Actionable Trade Plan',
    description:
      'Not just "you need to de-risk" but specific trades to consider: which positions to reduce, target allocations, and cash ladder recommendations.',
    details: [
      'Position-specific de-risk suggestions',
      'Target allocation recommendations',
      'Cash ladder planning (2-3 years of expenses)',
      'Priority ordering for implementation',
    ],
  },
  {
    title: 'CD Break/Hold Analysis',
    description:
      'Already have CDs? We analyze whether breaking them for higher rates makes sense, factoring in early withdrawal penalties and opportunity costs.',
    details: [
      'Early withdrawal penalty calculation',
      'Break-even analysis for new rates',
      'Hold vs. break recommendations',
      'Laddering strategy suggestions',
    ],
  },
]

const ADDITIONAL_FEATURES = [
  {
    title: 'Portfolio Risk Score',
    description:
      'A simple 1–10 score that summarizes sequence-of-returns risk based on asset allocation, timeline, and cash position.',
  },
  {
    title: 'AI-Powered Narration',
    description:
      'Plain-English explanations of your results using your own API key (BYOK). AI requests are sent only when you explicitly use the feature.',
  },
  {
    title: 'Multi-Brokerage Support',
    description:
      'Upload CSV exports from Fidelity, Schwab, Vanguard, and more. Our parser handles various formats automatically.',
  },
  {
    title: 'Privacy-First Architecture',
    description:
      'All calculations run in your browser. Optional AI requests pass through our server to your selected provider and are not persisted.',
  },
  {
    title: '30-Year Projections',
    description:
      'See how your portfolio performs over a full retirement horizon with year-by-year breakdowns.',
  },
  {
    title: 'Expense Modeling',
    description:
      'Factor in your planned annual expenses, Social Security timing, pension income, and other retirement income sources.',
  },
]

export default function FeaturesPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'RetireRunway',
    description:
      'Pre-retirement planning tool with Monte Carlo simulation, sequence of returns risk analysis, and actionable trade recommendations.',
    category: 'Financial Software',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free core features',
    },
  }

  return (
    <MarketingLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="mx-auto max-w-5xl px-6 py-16">
        <header className="mb-16 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl dark:text-zinc-50">
            Features
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
            Everything you need to understand your retirement readiness and take
            action. No black boxes, no hidden assumptions.
          </p>
        </header>

        <section className="mb-16">
          <h2 className="mb-8 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Core Features
          </h2>
          <div className="space-y-8">
            {CORE_FEATURES.map(feature => (
              <Card key={feature.title}>
                <CardHeader>
                  <CardTitle className="text-xl">{feature.title}</CardTitle>
                  <CardDescription className="text-base">
                    {feature.description}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {feature.details.map(detail => (
                      <li
                        key={detail}
                        className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400"
                      >
                        <svg
                          className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        {detail}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="mb-16">
          <h2 className="mb-8 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Additional Features
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {ADDITIONAL_FEATURES.map(feature => (
              <Card key={feature.title}>
                <CardHeader>
                  <CardTitle className="text-base">{feature.title}</CardTitle>
                  <CardDescription>{feature.description}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        <section className="mb-16 rounded-xl bg-zinc-100 p-8 dark:bg-zinc-900">
          <h2 className="mb-4 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            How It Works
          </h2>
          <ol className="space-y-6">
            <li className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white dark:bg-zinc-50 dark:text-zinc-900">
                1
              </span>
              <div>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                  Upload Your Portfolio
                </h3>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Export your holdings as CSV from your brokerage (Fidelity,
                  Schwab, Vanguard) and upload. All processing happens in your
                  browser.
                </p>
              </div>
            </li>
            <li className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white dark:bg-zinc-50 dark:text-zinc-900">
                2
              </span>
              <div>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                  Enter Your Profile
                </h3>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Tell us your retirement timeline, annual expenses, Social
                  Security expectations, and any pension income.
                </p>
              </div>
            </li>
            <li className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white dark:bg-zinc-50 dark:text-zinc-900">
                3
              </span>
              <div>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                  Get Actionable Results
                </h3>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  See 30-year projections across 4 scenarios, a de-risk trade
                  plan, risk score, cash ladder recommendations, and optional AI
                  narration.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <div className="text-center">
          <h2 className="mb-4 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Ready to Analyze Your Portfolio?
          </h2>
          <p className="mb-8 text-zinc-600 dark:text-zinc-400">
            Local portfolio calculations work without an account. Your portfolio
            data stays in your browser; optional AI features require an account
            and relay summary data through our server without persistence.
          </p>
          <Button asChild size="lg">
            <Link href="/">Get Started Free</Link>
          </Button>
        </div>
      </div>
    </MarketingLayout>
  )
}

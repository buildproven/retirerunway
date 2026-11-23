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
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = {
  title: 'Pricing | RetireRunway - Free Retirement Planning Tool',
  description:
    'RetireRunway pricing: the current MVP is free with scenario analysis, trade recommendations, Monte Carlo simulation, and optional AI narration. Paid packaging is planned.',
  keywords: [
    'retirement planning tool pricing',
    'free retirement calculator',
    'pre-retirement planning cost',
    'Monte Carlo simulation free',
    'retirement scenario analysis pricing',
  ],
  openGraph: {
    title: 'Pricing | RetireRunway - Free Retirement Planning Tool',
    description:
      'Free scenario analysis, trade recommendations, Monte Carlo simulation, and optional AI narration. Paid packaging is planned.',
    type: 'website',
    url: '/pricing',
  },
}

const TIERS = [
  {
    name: 'Free',
    price: '$0',
    period: undefined,
    description: 'Everything you need to analyze your retirement readiness.',
    features: [
      'Upload portfolio from any brokerage',
      '4 market scenario projections',
      '30-year balance projections',
      'De-risk trade recommendations',
      'Cash ladder planning',
      'CD break/hold analysis',
      'Portfolio risk score',
      'Portfolio data stays in your browser for local analysis',
      'Monte Carlo simulation (currently available in the MVP)',
      'AI narration with your own API key (BYOK)',
      'Report export (.md and browser print-to-PDF)',
    ],
    cta: 'Get Started Free',
    ctaLink: '/',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: 'Planned',
    description: 'Planned features for serious retirement planners.',
    features: [
      'Paid packaging is planned; no Pro charges or feature gates are active yet.',
      'Tax optimization insights (planned)',
      'Roth conversion analysis (planned)',
      'Multiple scenario comparison (planned)',
      'Priority support (planned)',
    ],
    cta: 'Coming Soon',
    ctaLink: '#',
    highlighted: true,
    badge: 'Coming Soon',
  },
]

const FREE_FEATURES = [
  {
    title: 'Four Market Scenarios',
    description:
      'See your portfolio in bull, base, early bear, and prolonged bear conditions.',
  },
  {
    title: '30-Year Projections',
    description:
      'Understand your runway with year-by-year balance projections.',
  },
  {
    title: 'Trade Recommendations',
    description: 'Get specific de-risk trades and allocation targets.',
  },
  {
    title: 'Cash Ladder Planning',
    description: 'Know exactly how much cash to hold for the first 2-3 years.',
  },
  {
    title: 'CD Analysis',
    description: 'Break or hold? We calculate the math for your specific CDs.',
  },
  {
    title: 'Risk Score',
    description: 'A simple 1–10 score summarizing sequence-of-returns risk.',
  },
]

export default function PricingPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'RetireRunway',
    description: 'Pre-retirement planning tool with scenario analysis.',
    offers: [
      {
        '@type': 'Offer',
        name: 'Free',
        price: '0',
        priceCurrency: 'USD',
        description: 'Core features for retirement analysis',
      },
    ],
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
            Simple, Transparent Pricing
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
            Core analysis is available now. Paid packaging and additional
            features are planned, but no upgrade is active yet.
          </p>
        </header>

        <section className="mb-16">
          <div className="grid gap-8 md:grid-cols-2">
            {TIERS.map(tier => (
              <Card
                key={tier.name}
                className={
                  tier.highlighted
                    ? 'border-2 border-zinc-900 dark:border-zinc-50'
                    : ''
                }
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-xl">{tier.name}</CardTitle>
                    {tier.badge && (
                      <Badge variant="secondary">{tier.badge}</Badge>
                    )}
                  </div>
                  <div className="mt-2">
                    <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-50">
                      {tier.price}
                    </span>
                    {tier.period && (
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {tier.period}
                      </span>
                    )}
                  </div>
                  <CardDescription className="mt-2">
                    {tier.description}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="mb-6 space-y-3">
                    {tier.features.map(feature => (
                      <li
                        key={feature}
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
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Button
                    asChild
                    className="w-full"
                    variant={tier.highlighted ? 'default' : 'outline'}
                    disabled={tier.badge === 'Coming Soon'}
                  >
                    <Link href={tier.ctaLink}>{tier.cta}</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="mb-16">
          <h2 className="mb-8 text-center text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Everything in Free
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FREE_FEATURES.map(feature => (
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
          <h2 className="mb-6 text-center text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Frequently Asked Questions
          </h2>
          <div className="mx-auto max-w-2xl space-y-6">
            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                Is the Free tier really free?
              </h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                Yes. Core features are free forever with no hidden limits. We
                believe everyone deserves access to quality retirement planning
                tools.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                What does BYOK mean for AI features?
              </h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                BYOK means &ldquo;Bring Your Own Key.&rdquo; For AI narration
                features, you provide your own API key from Anthropic, OpenAI,
                or Perplexity. This means you control costs. Your request is
                relayed through RetireRunway&apos;s server to the provider you
                choose and is not persisted.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                Is my financial data safe?
              </h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                Your portfolio data is processed entirely in your browser. We
                never see or store your holdings. When using AI features,
                summary data (not raw holdings) is relayed through
                RetireRunway&apos;s server to the AI provider using your API
                key.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                Can I cancel Pro anytime?
              </h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                Paid packaging is not active yet, so there is currently nothing
                to cancel. Billing and cancellation terms will be documented
                before paid features launch.
              </p>
            </div>
          </div>
          <div className="mt-8 text-center">
            <Link
              href="/faq"
              className="text-sm font-medium text-zinc-900 underline underline-offset-4 hover:text-zinc-600 dark:text-zinc-50 dark:hover:text-zinc-400"
            >
              View all FAQs
            </Link>
          </div>
        </section>

        <div className="text-center">
          <h2 className="mb-4 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Start Analyzing Your Portfolio
          </h2>
          <p className="mb-8 text-zinc-600 dark:text-zinc-400">
            No credit card required. Local portfolio analysis works without an
            account; optional AI features require an account and relay summary
            data through our server.
          </p>
          <Button asChild size="lg">
            <Link href="/">Get Started Free</Link>
          </Button>
        </div>
      </div>
    </MarketingLayout>
  )
}

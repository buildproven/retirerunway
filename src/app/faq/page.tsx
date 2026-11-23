import type { Metadata } from 'next'
import Link from 'next/link'
import { MarketingLayout } from '@/components/marketing-layout'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'FAQ | RetireRunway - Retirement Planning Questions Answered',
  description:
    'Frequently asked questions about RetireRunway: sequence of returns risk, Monte Carlo simulation, privacy, pricing, and how our retirement planning tool works.',
  keywords: [
    'retirement planning FAQ',
    'sequence of returns risk explained',
    'Monte Carlo simulation retirement',
    'pre-retirement calculator questions',
    'retirement scenario analysis help',
  ],
  openGraph: {
    title: 'FAQ | RetireRunway - Retirement Planning Questions Answered',
    description:
      'Answers to common questions about retirement planning, sequence of returns risk, and how RetireRunway works.',
    type: 'website',
    url: '/faq',
  },
}

const FAQ_CATEGORIES = [
  {
    title: 'Getting Started',
    questions: [
      {
        q: 'What is RetireRunway?',
        a: 'RetireRunway is a retirement planning tool designed for pre-retirees (typically 3-10 years from retirement). Unlike traditional calculators that just tell you if you have "enough," we analyze your actual portfolio and tell you what specific actions to take: which trades to consider, how much cash to hold, and whether to break or keep your CDs.',
      },
      {
        q: 'Do I need to create an account?',
        a: 'No. RetireRunway works entirely in your browser with no account required. Your data is processed locally and never stored on our servers.',
      },
      {
        q: 'Which brokerages are supported?',
        a: 'We support CSV exports from Fidelity, Schwab, Vanguard, and most other major brokerages. Our parser automatically detects common formats. If your format is not recognized, you can use our manual entry option.',
      },
      {
        q: 'Is my financial data safe?',
        a: 'Yes. Your portfolio data is processed in your browser using client-side JavaScript. When you use optional AI narration, summary data and your API key are sent to our API, which relays the request to the provider you selected. We do not persist your key or that AI request data.',
      },
    ],
  },
  {
    title: 'Understanding Sequence of Returns Risk',
    questions: [
      {
        q: 'What is sequence of returns risk?',
        a: 'Sequence of returns risk is the danger that you retire into a market downturn. Even if long-term average returns are good, poor returns in the first 3-5 years of retirement can permanently damage your portfolio because you are withdrawing from a shrinking balance. This is the #1 risk for pre-retirees and is often overlooked by simple retirement calculators.',
      },
      {
        q: 'Why do the first few years of retirement matter so much?',
        a: 'When you start withdrawing from your portfolio, a market drop hits you twice: your balance falls and you withdraw from that reduced balance. This creates a "sequence risk" that can cause you to run out of money even if average returns over 30 years are positive. Our early bear scenario specifically models this risk.',
      },
      {
        q: 'How can I reduce sequence of returns risk?',
        a: 'Common strategies include: (1) Building a 2-3 year cash ladder before retirement so you do not sell during downturns, (2) De-risking your equity allocation as you approach retirement, (3) Having flexible spending plans, and (4) Delaying retirement if entering a downturn. RetireRunway provides specific recommendations based on your portfolio.',
      },
    ],
  },
  {
    title: 'Features & Analysis',
    questions: [
      {
        q: 'What are the four market scenarios?',
        a: 'We model your portfolio across four scenarios: (1) Bull - strong early returns then normalization, (2) Base - historical average returns throughout, (3) Early Bear - downturn in years 1-3 then recovery, and (4) Prolonged Bear - extended downturn with slow recovery. This shows how your portfolio performs across conditions, not just average expectations.',
      },
      {
        q: 'How does the trade plan work?',
        a: 'Based on your current allocation and retirement timeline, we suggest specific de-risk trades: which equity positions to reduce, target allocation percentages, and priority ordering. These are suggestions for consideration, not financial advice. Always consult a professional before making trades.',
      },
      {
        q: 'What is the CD break/hold analysis?',
        a: 'If you have existing CDs, we calculate whether breaking them early for higher rates makes financial sense. We factor in early withdrawal penalties, remaining time to maturity, current rates, and opportunity cost to give you a break vs. hold recommendation for each CD.',
      },
      {
        q: 'What is Monte Carlo simulation?',
        a: 'Monte Carlo simulation runs thousands of seeded return sequences based on historical assumptions to show the probability distribution of outcomes. Instead of showing one projected path, it shows the range of possibilities and your success rate across many scenarios. It is available in the current MVP; paid packaging is not active yet.',
      },
      {
        q: 'How is the risk score calculated?',
        a: 'The sequence-of-returns risk score is reported on a 1–10 scale and combines equity allocation relative to timeline, sequence risk exposure, cash position for near-term expenses, concentration in individual positions, and overall portfolio diversity. Lower scores indicate more conservative positioning.',
      },
    ],
  },
  {
    title: 'AI Features',
    questions: [
      {
        q: 'What does BYOK mean?',
        a: 'BYOK means "Bring Your Own Key." For AI narration features, you provide your own key for Anthropic (Claude), OpenAI (GPT), or Perplexity. You control costs directly. Optional AI features require an account; RetireRunway relays each requested AI call through its server to the provider you choose and does not persist your key or request data.',
      },
      {
        q: 'What data is sent to the AI?',
        a: 'When using AI narration, we relay summary data only: total portfolio value, asset allocation percentages, scenario projections, and risk metrics. We do not send individual holdings, account numbers, or personally identifiable information. The AI explains your results in plain English.',
      },
      {
        q: 'Do I need AI features to use RetireRunway?',
        a: 'No. All core calculations, scenario projections, and trade recommendations work without AI. AI narration is an optional feature that provides plain-English explanations of your results. The tool is fully functional without it.',
      },
    ],
  },
  {
    title: 'Pricing & Plans',
    questions: [
      {
        q: 'Is RetireRunway really free?',
        a: 'Yes. Core features are free forever with no hidden limits: portfolio upload, four scenario projections, trade recommendations, cash ladder planning, CD analysis, and risk scoring. We believe everyone deserves access to quality retirement planning tools.',
      },
      {
        q: 'What does Pro include?',
        a: 'Paid packaging is planned but is not active yet, so there are currently no Pro charges or feature gates. The current MVP includes the local analysis tools, Monte Carlo simulation, browser report export, and optional BYOK narration; planned paid features will be documented before launch.',
      },
      {
        q: 'Can I cancel anytime?',
        a: 'Yes. Cancel anytime and you will keep access until the end of your billing period. No questions asked, no cancellation fees.',
      },
    ],
  },
  {
    title: 'Important Disclaimers',
    questions: [
      {
        q: 'Is RetireRunway financial advice?',
        a: 'No. RetireRunway is an educational tool that provides hypothetical projections and scenario analysis. It does not constitute financial, tax, investment, or legal advice. All outputs are for informational purposes only. Consult a qualified financial advisor before making investment decisions.',
      },
      {
        q: 'Are the projections guaranteed?',
        a: 'No. All projections are hypothetical and based on simplified models using historical assumptions. Actual returns will vary. Past performance is not indicative of future results. The scenarios are designed to illustrate a range of possibilities, not predict the future.',
      },
      {
        q: 'Should I make trades based on RetireRunway recommendations?',
        a: 'RetireRunway provides suggestions for consideration, not instructions. Always consult with a qualified financial advisor who can evaluate your complete financial picture, tax situation, and personal circumstances before making any trades or financial decisions.',
      },
    ],
  },
]

export default function FAQPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_CATEGORIES.flatMap(category =>
      category.questions.map(item => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.a,
        },
      }))
    ),
  }

  return (
    <MarketingLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl dark:text-zinc-50">
            Frequently Asked Questions
          </h1>
          <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
            Everything you need to know about RetireRunway and retirement
            planning concepts.
          </p>
        </header>

        <nav className="mb-12">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Jump to Section
          </h2>
          <ul className="flex flex-wrap gap-2">
            {FAQ_CATEGORIES.map(category => (
              <li key={category.title}>
                <a
                  href={`#${category.title.toLowerCase().replace(/\s+/g, '-')}`}
                  className="inline-block rounded-md bg-zinc-100 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                >
                  {category.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {FAQ_CATEGORIES.map(category => (
          <section
            key={category.title}
            id={category.title.toLowerCase().replace(/\s+/g, '-')}
            className="mb-12"
          >
            <h2 className="mb-6 text-xl font-bold text-zinc-900 dark:text-zinc-50">
              {category.title}
            </h2>
            <div className="space-y-6">
              {category.questions.map(item => (
                <div
                  key={item.q}
                  className="rounded-lg border bg-white p-6 dark:bg-zinc-900"
                >
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                    {item.q}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {item.a}
                  </p>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="mt-16 rounded-xl bg-zinc-100 p-8 text-center dark:bg-zinc-900">
          <h2 className="mb-4 text-xl font-bold text-zinc-900 dark:text-zinc-50">
            Still Have Questions?
          </h2>
          <p className="mb-6 text-zinc-600 dark:text-zinc-400">
            Check out our{' '}
            <Link
              href="/features"
              className="font-medium text-zinc-900 underline underline-offset-4 hover:text-zinc-600 dark:text-zinc-50 dark:hover:text-zinc-400"
            >
              features page
            </Link>{' '}
            for more details, or try the tool yourself - no account required.
          </p>
          <Button asChild size="lg">
            <Link href="/">Try RetireRunway Free</Link>
          </Button>
        </section>
      </div>
    </MarketingLayout>
  )
}

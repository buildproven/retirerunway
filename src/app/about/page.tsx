import type { Metadata } from 'next'
import Link from 'next/link'
import { MarketingLayout } from '@/components/marketing-layout'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'About RetireRunway | Pre-Retirement Planning Tool',
  description:
    'Learn about RetireRunway, the retirement planning tool built by pre-retirees for pre-retirees. We help you understand sequence of returns risk and make actionable decisions.',
  keywords: [
    'retirement planning tool',
    'pre-retirement calculator',
    'sequence of returns risk',
    'retirement scenario analysis',
    'about RetireRunway',
  ],
  openGraph: {
    title: 'About RetireRunway | Pre-Retirement Planning Tool',
    description:
      'Learn about RetireRunway, the retirement planning tool built by pre-retirees for pre-retirees.',
    type: 'website',
    url: '/about',
  },
}

export default function AboutPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'RetireRunway',
    description:
      'Pre-retirement planning tool that provides actionable portfolio analysis and scenario projections.',
    url: 'https://retirerunway.com',
  }

  return (
    <MarketingLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <article className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl dark:text-zinc-50">
            About RetireRunway
          </h1>
          <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
            Built by pre-retirees, for pre-retirees
          </p>
        </header>

        <section className="prose prose-zinc mx-auto max-w-none dark:prose-invert">
          <h2>Why We Built RetireRunway</h2>
          <p>
            Traditional retirement calculators ask one question: &ldquo;Do you
            have enough?&rdquo; But that question misses the point. The real
            question is: &ldquo;What should I <strong>do</strong>?&rdquo;
          </p>
          <p>
            RetireRunway was born from the frustration of being 3-5 years from
            retirement with a complex portfolio and no clear guidance on
            specific actions to take. Should I de-risk now or wait? How much
            cash should I hold? Is it worth breaking my CDs for better rates?
          </p>
          <p>
            We built the tool we wished existed: one that analyzes your actual
            portfolio against multiple market scenarios and gives you specific,
            actionable recommendations.
          </p>

          <h2>Our Philosophy</h2>

          <h3>Transparency Over Black Boxes</h3>
          <p>
            Every calculation in RetireRunway is deterministic and auditable.
            Unlike many financial tools that hide their assumptions, we show you
            exactly how we model each scenario. The{' '}
            <Link href="/features" className="text-primary hover:underline">
              scenario engine
            </Link>{' '}
            uses clear, documented assumptions you can verify.
          </p>

          <h3>Education, Not Advice</h3>
          <p>
            RetireRunway is an educational tool, not a financial advisor. We
            help you understand your options and their trade-offs, but you make
            the decisions. We believe informed investors make better choices
            than those who blindly follow recommendations.
          </p>

          <h3>Privacy First</h3>
          <p>
            Your financial data is sensitive. RetireRunway processes your
            portfolio data entirely in your browser. When you use optional AI
            narration, the selected summary data and your BYOK key are sent to
            our API, which relays the request to the AI provider. We do not
            persist that request data or your key.
          </p>

          <h2>What Makes Us Different</h2>
          <ul>
            <li>
              <strong>Action-oriented:</strong> We don&apos;t just project
              numbers; we tell you which trades to consider, how much cash to
              hold, and whether to break or keep your CDs.
            </li>
            <li>
              <strong>Scenario-based:</strong> Four market scenarios (bull,
              base, early bear, prolonged bear) help you understand how your
              portfolio performs across conditions.
            </li>
            <li>
              <strong>Sequence risk aware:</strong> We specifically model the
              danger of retiring into a downturn, the #1 risk for pre-retirees.
            </li>
            <li>
              <strong>AI-enhanced, not AI-dependent:</strong> Core calculations
              are deterministic. AI only narrates and explains results in plain
              English.
            </li>
          </ul>

          <h2>Get Started</h2>
          <p>
            Ready to see what actions your portfolio analysis reveals? Upload
            your holdings and get personalized scenario projections in minutes.
          </p>
        </section>

        <div className="mt-12 flex justify-center">
          <Button asChild size="lg">
            <Link href="/">Try RetireRunway Free</Link>
          </Button>
        </div>
      </article>
    </MarketingLayout>
  )
}

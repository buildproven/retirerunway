import type { Metadata } from 'next'
import Link from 'next/link'
import { MarketingLayout } from '@/components/marketing-layout'

export const metadata: Metadata = {
  title: 'Terms of Service | RetireRunway',
  description:
    'Terms of service for RetireRunway. An educational retirement modelling tool — not financial, tax, or investment advice.',
  openGraph: {
    title: 'Terms of Service | RetireRunway',
    description:
      'Terms of service for RetireRunway, an educational retirement modelling tool.',
    type: 'website',
    url: '/terms',
  },
}

const LAST_UPDATED = 'July 26, 2026'

export default function TermsPage() {
  return (
    <MarketingLayout>
      <article className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Terms of Service
          </h1>
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        <section className="prose prose-zinc dark:prose-invert mx-auto max-w-none">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 not-prose dark:border-amber-900 dark:bg-amber-950/40">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              RetireRunway is an educational modelling tool. It is not
              financial, investment, tax, or legal advice, and it does not
              create an advisory relationship. Consult a qualified professional
              before acting on anything you see here.
            </p>
          </div>

          <h2>What RetireRunway is</h2>
          <p>
            RetireRunway models retirement scenarios from figures{' '}
            <strong>you</strong> provide. It projects how a portfolio might
            behave under a set of assumptions, and produces illustrative outputs
            such as scenario projections, risk scores, suggested trades, cash
            ladders, and tax estimates.
          </p>

          <h2>What it is not</h2>
          <ul>
            <li>
              It is <strong>not</strong> financial, investment, tax, or legal
              advice.
            </li>
            <li>
              It does <strong>not</strong> determine your actual tax liability,
              Social Security entitlement, or retirement-plan eligibility.
            </li>
            <li>
              Suggested trades are illustrative modelling output, not
              recommendations to buy or sell any security.
            </li>
            <li>
              It is not a substitute for a licensed financial adviser,
              accountant, or attorney.
            </li>
          </ul>

          <h2>Results depend entirely on your inputs and assumptions</h2>
          <p>
            Every projection rests on assumptions — future returns, inflation,
            tax rates, spending, and life expectancy among them. Real outcomes
            will differ, often substantially.
          </p>
          <p>
            <strong>Past performance does not predict future results.</strong>{' '}
            Market returns are uncertain, and a plan that appears sound under
            one set of assumptions can fail under another. Where the tool shows
            stress scenarios or probability ranges, treat them as illustrations
            of uncertainty rather than forecasts.
          </p>
          <p>
            Tax calculations use simplified federal brackets and a flat state
            rate. They omit many real-world provisions and should not be relied
            on for filing or planning.
          </p>

          <h2>Your responsibilities</h2>
          <ul>
            <li>
              Provide accurate information — outputs are only as good as inputs
            </li>
            <li>Verify results independently before making any decision</li>
            <li>Keep your account credentials and any API keys secure</li>
            <li>Use the service lawfully</li>
          </ul>

          <h2>Availability</h2>
          <p>
            The service is provided &ldquo;as is&rdquo; and &ldquo;as
            available&rdquo;, without warranties of any kind. We may change or
            discontinue features at any time. Because your data is stored in
            your browser by default, you are responsible for retaining your own
            copies of anything you wish to keep.
          </p>

          <h2>Limitation of liability</h2>
          <p>
            To the fullest extent permitted by law, RetireRunway and its authors
            are not liable for any loss or damage — including financial loss,
            lost profits, or lost data — arising from your use of, or reliance
            on, this service or its output.
          </p>

          <h2>Third-party services</h2>
          <p>
            Optional features rely on third parties: Supabase for account sync,
            Stripe for any payments, and your chosen AI provider for narration.
            Their terms and privacy policies govern their handling of data. See
            our <Link href="/privacy">Privacy Policy</Link> for what is shared
            and when.
          </p>

          <h2>Changes to these terms</h2>
          <p>
            If these terms change materially, we will update the date at the top
            of this page. Continued use constitutes acceptance.
          </p>

          <h2>Contact</h2>
          <p>
            Questions can be raised via the{' '}
            <Link href="/about">about page</Link>.
          </p>
        </section>
      </article>
    </MarketingLayout>
  )
}

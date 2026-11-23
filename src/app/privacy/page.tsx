import type { Metadata } from 'next'
import Link from 'next/link'
import { MarketingLayout } from '@/components/marketing-layout'

export const metadata: Metadata = {
  title: 'Privacy Policy | RetireRunway',
  description:
    'How RetireRunway handles your financial data. All calculations run in your browser; your portfolio is never sent to our servers.',
  openGraph: {
    title: 'Privacy Policy | RetireRunway',
    description:
      'How RetireRunway handles your financial data. All calculations run in your browser.',
    type: 'website',
    url: '/privacy',
  },
}

const LAST_UPDATED = 'July 26, 2026'

export default function PrivacyPage() {
  return (
    <MarketingLayout>
      <article className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Privacy Policy
          </h1>
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        <section className="prose prose-zinc dark:prose-invert mx-auto max-w-none">
          <h2>The short version</h2>
          <p>
            Every financial calculation RetireRunway performs runs{' '}
            <strong>inside your browser</strong>. Your portfolio holdings,
            account balances, and personal profile are not transmitted to our
            servers, and we do not run analytics or tracking of any kind.
          </p>
          <p>
            There are exactly two cases where data leaves your device, both
            described below: if you create an account to sync your data, and if
            you use the optional AI narration feature.
          </p>

          <h2>What stays in your browser</h2>
          <p>
            When you upload a CSV or enter details manually, that data is stored
            locally using your browser&rsquo;s <code>localStorage</code> under
            these keys:
          </p>
          <ul>
            <li>
              <code>retirerunway_portfolio</code> — your accounts and holdings
            </li>
            <li>
              <code>retirerunway_userprofile</code> — your age, expenses, and
              income assumptions
            </li>
            <li>
              <code>retire-runway-saved-scenarios</code> — scenarios you save
            </li>
          </ul>
          <p>
            All scenario projections, risk scoring, Monte Carlo simulation,
            trade plans, cash ladders and tax calculations are computed on your
            device from this local data. Clearing your browser storage deletes
            it permanently — we have no copy unless you have signed in.
          </p>

          <h2>If you create an account</h2>
          <p>
            Creating an account is optional. RetireRunway works fully without
            one.
          </p>
          <p>
            If you do sign in, your portfolio and profile are additionally
            synced to our database (hosted by Supabase) so you can access them
            from another device. This data is protected by row-level security
            policies, meaning it is readable only by your own authenticated user
            account.
          </p>
          <p>
            We store your account identifier, portfolio data, profile data, and
            creation/update timestamps. You can delete your saved portfolio at
            any time from within the app.
          </p>

          <h2>If you use AI narration</h2>
          <p>
            The AI narration and &ldquo;what if&rdquo; features are optional and
            require you to supply your own API key for Anthropic, OpenAI, or
            Perplexity.
          </p>
          <p>
            When you use them, a <strong>summary</strong> of your results is
            sent to our server, which relays it to whichever provider you chose
            — for example the number of accounts and your total portfolio value,
            along with computed outputs such as projected runway and risk score.
            Individual holdings, ticker symbols, cost basis, and account numbers
            are <strong>not</strong> included.
          </p>
          <p>
            We do not persist your API key or the AI request data. The
            provider&rsquo;s handling is governed by their privacy policy. If
            you never enter an API key, no data is ever sent to an AI provider.
          </p>

          <h2>Analytics and tracking</h2>
          <p>
            RetireRunway does not use Google Analytics, advertising pixels,
            session recording, or any third-party analytics service. We do not
            set tracking cookies and we do not sell or share personal
            information.
          </p>

          <h2>Payments</h2>
          <p>
            If paid features become available, payment processing will be
            handled by Stripe. We would not receive or store your card details.
          </p>

          <h2>Your choices</h2>
          <ul>
            <li>
              Use the tool without an account — nothing leaves your browser
            </li>
            <li>Clear browser storage to erase all local data</li>
            <li>Delete your saved portfolio to remove synced data</li>
            <li>Omit an API key to disable all AI features</li>
          </ul>

          <h2>Changes to this policy</h2>
          <p>
            If this policy changes materially, we will update the date at the
            top of this page.
          </p>

          <h2>Contact</h2>
          <p>
            Questions about privacy can be raised via the{' '}
            <Link href="/about">about page</Link>.
          </p>

          <hr />
          <p className="text-sm">
            RetireRunway is an educational modelling tool, not financial advice.
            See our <Link href="/terms">Terms of Service</Link> for details.
          </p>
        </section>
      </article>
    </MarketingLayout>
  )
}

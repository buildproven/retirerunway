'use client'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface LandingHeroProps {
  onChoosePortfolio: () => void
  onChoosePlan: () => void
}

const FEATURES = [
  {
    title: 'Upload Your Portfolio',
    description:
      'Import CSV exports from Fidelity, Schwab, or Vanguard. Your data stays in your browser.',
  },
  {
    title: '4 Market Scenarios',
    description:
      'See how your portfolio performs in bull, base, early bear, and prolonged bear markets over 30 years.',
  },
  {
    title: 'Actionable Trade Plan',
    description:
      'Get specific de-risk trades, cash ladder plans, and CD break/hold recommendations.',
  },
  {
    title: 'AI-Powered Narration',
    description:
      'Plain-English explanations of your results using your own API key. Optional AI requests require an account and relay summary data through our server without persistence.',
  },
]

export function LandingHero({
  onChoosePortfolio,
  onChoosePlan,
}: LandingHeroProps) {
  return (
    <div className="space-y-12">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl dark:text-zinc-50">
          Know what to do
          <br />
          <span className="text-primary">before you stop working</span>
        </h1>
        <p className="text-muted-foreground mt-4 text-lg">
          Choose a fast portfolio analysis or model the full retirement
          transition: income, spending, healthcare, account access, life events,
          and deterministic bad-start stress cases.
        </p>
        <p className="text-muted-foreground mt-3 text-xs">
          Both modes run core calculations locally. AI narration remains
          optional and separate from the deterministic math.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle>Portfolio analysis</CardTitle>
            <CardDescription>
              Upload brokerage data to see four market scenarios, Monte Carlo,
              cash ladders, and specific de-risk trades.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={onChoosePortfolio}>Upload a portfolio</Button>
          </CardContent>
        </Card>
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle>Retirement plan</CardTitle>
            <CardDescription>
              Enter your timeline, cash flows, healthcare, accounts, and life
              events to get GO / CAUTION / DELAY plus a stress-tested bridge.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={onChoosePlan}>Build a retirement plan</Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map(feature => (
          <Card key={feature.title}>
            <CardHeader>
              <CardTitle className="text-base">{feature.title}</CardTitle>
              <CardDescription>{feature.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">How It Works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="text-muted-foreground space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="bg-primary text-primary-foreground inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                1
              </span>
              <span>
                Export your holdings as CSV from your brokerage (Fidelity,
                Schwab, Vanguard) and upload it here.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="bg-primary text-primary-foreground inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                2
              </span>
              <span>
                Enter your retirement details: target age, annual expenses,
                Social Security, pension income.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="bg-primary text-primary-foreground inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                3
              </span>
              <span>
                Get scenario projections, a de-risk trade plan, cash ladder,
                risk score, and AI-narrated summary — all in seconds.
              </span>
            </li>
          </ol>
        </CardContent>
      </Card>

      <div className="text-center">
        <Button size="lg" variant="outline" onClick={onChoosePlan}>
          Start with the retirement plan
        </Button>
      </div>
    </div>
  )
}

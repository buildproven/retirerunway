'use client'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { usePortfolioStore } from '@/store/portfolio-store'
import type { Account, AssetClass } from '@/engine/types'

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  us_equity: 'US Equity',
  intl_equity: 'Intl Equity',
  emerging_equity: 'Emerging',
  us_bond: 'US Bond',
  intl_bond: 'Intl Bond',
  tips: 'TIPS',
  money_market: 'Money Market',
  cd: 'CD',
  reit: 'REIT',
  commodity: 'Commodity',
  crypto: 'Crypto',
  cash: 'Cash',
  other: 'Other',
}

function AccountCard({ account }: { account: Account }) {
  const totalHoldings = account.holdings.reduce((s, h) => s + h.currentValue, 0)
  const totalCDs = account.cds.reduce((s, c) => s + c.principal, 0)
  const total = totalHoldings + totalCDs + account.cashBalance

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="truncate">{account.name}</span>
          <span className="text-lg">{formatCurrency(total)}</span>
        </CardTitle>
        <CardDescription>
          {account.institution} · {account.accountType.replace(/_/g, ' ')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {account.holdings.map(h => (
            <div
              key={h.id}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{h.symbol}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {ASSET_CLASS_LABELS[h.assetClass]}
                </Badge>
              </div>
              <span>{formatCurrency(h.currentValue)}</span>
            </div>
          ))}
          {account.cds.map(cd => (
            <div
              key={cd.id}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">CD</span>
                <Badge variant="secondary" className="text-[10px]">
                  {cd.apy * 100}% · {cd.termMonths}mo
                </Badge>
              </div>
              <span>{formatCurrency(cd.principal)}</span>
            </div>
          ))}
          {account.cashBalance > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Cash</span>
              <span>{formatCurrency(account.cashBalance)}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function AllocationBar({
  allocations,
}: {
  allocations: { label: string; value: number; pct: number }[]
}) {
  const colors = [
    'bg-chart-1',
    'bg-chart-2',
    'bg-chart-3',
    'bg-chart-4',
    'bg-chart-5',
    'bg-muted-foreground/40',
  ]

  return (
    <div className="space-y-2">
      <div className="flex h-3 overflow-hidden rounded-full">
        {allocations.map((a, i) =>
          a.pct > 0 ? (
            <div
              key={a.label}
              className={`${colors[i % colors.length]} transition-all`}
              style={{ width: `${a.pct}%` }}
            />
          ) : null
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {allocations.map((a, i) =>
          a.pct > 0 ? (
            <div key={a.label} className="flex items-center gap-1.5">
              <div
                className={`h-2 w-2 rounded-full ${colors[i % colors.length]}`}
              />
              <span>
                {a.label} {a.pct.toFixed(1)}%
              </span>
            </div>
          ) : null
        )}
      </div>
    </div>
  )
}

export function DashboardStep() {
  const portfolio = usePortfolioStore(s => s.portfolio)

  if (!portfolio) return null

  const totalValue = portfolio.accounts.reduce((sum, a) => {
    const holdings = a.holdings.reduce((s, h) => s + h.currentValue, 0)
    const cds = a.cds.reduce((s, c) => s + c.principal, 0)
    return sum + holdings + cds + a.cashBalance
  }, 0)

  const byClass: Record<string, number> = {}
  for (const a of portfolio.accounts) {
    byClass['Cash'] = (byClass['Cash'] ?? 0) + a.cashBalance
    for (const h of a.holdings) {
      const label = ASSET_CLASS_LABELS[h.assetClass]
      byClass[label] = (byClass[label] ?? 0) + h.currentValue
    }
    for (const cd of a.cds) {
      byClass['CD'] = (byClass['CD'] ?? 0) + cd.principal
    }
  }

  const allocations = Object.entries(byClass)
    .map(([label, value]) => ({
      label,
      value,
      pct: totalValue > 0 ? (value / totalValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value)

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold tracking-tight">
          Portfolio Overview
        </h2>
        <p className="text-muted-foreground mt-1">
          {portfolio.accounts.length} accounts · {formatCurrency(totalValue)}{' '}
          total
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Asset Allocation</CardTitle>
        </CardHeader>
        <CardContent>
          <AllocationBar allocations={allocations} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {portfolio.accounts.map(account => (
          <AccountCard key={account.id} account={account} />
        ))}
      </div>
    </div>
  )
}

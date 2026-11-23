'use client'

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePortfolioStore } from '@/store/portfolio-store'
import type { Account, AccountType, AssetClass, Holding } from '@/engine/types'

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  brokerage: 'Brokerage',
  traditional_ira: 'Traditional IRA',
  roth_ira: 'Roth IRA',
  rollover_ira: 'Rollover IRA',
  '401k': '401(k)',
  roth_401k: 'Roth 401(k)',
  '403b': '403(b)',
  '457b': '457(b)',
  nqdc: 'Non-qualified deferred comp (NQDC)',
  hsa: 'HSA',
}

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  us_equity: 'US Equity',
  intl_equity: 'International Equity',
  emerging_equity: 'Emerging Markets',
  us_bond: 'US Bonds',
  intl_bond: 'International Bonds',
  tips: 'TIPS',
  money_market: 'Money Market',
  cd: 'CD',
  reit: 'REIT',
  commodity: 'Commodity',
  crypto: 'Crypto',
  cash: 'Cash',
  other: 'Other',
}

interface HoldingDraft {
  symbol: string
  name: string
  assetClass: AssetClass
  shares: string
  currentPrice: string
  costBasis: string
}

const emptyHolding: HoldingDraft = {
  symbol: '',
  name: '',
  assetClass: 'us_equity',
  shares: '',
  currentPrice: '',
  costBasis: '',
}

interface ManualEntryFormProps {
  onComplete: () => void
}

export function ManualEntryForm({ onComplete }: ManualEntryFormProps) {
  const setPortfolio = usePortfolioStore(s => s.setPortfolio)

  const [accountName, setAccountName] = useState('My Account')
  const [institution, setInstitution] = useState('')
  const [accountType, setAccountType] = useState<AccountType>('brokerage')
  const [cashBalance, setCashBalance] = useState('')
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [draft, setDraft] = useState<HoldingDraft>({ ...emptyHolding })
  const [error, setError] = useState<string | null>(null)

  const addHolding = useCallback(() => {
    const shares = parseFloat(draft.shares)
    const price = parseFloat(draft.currentPrice)
    const costBasis = draft.costBasis
      ? parseFloat(draft.costBasis)
      : shares * price

    if (!draft.symbol.trim()) {
      setError('Symbol is required.')
      return
    }
    if (isNaN(shares) || shares <= 0) {
      setError('Shares must be a positive number.')
      return
    }
    if (isNaN(price) || price <= 0) {
      setError('Price must be a positive number.')
      return
    }

    const holding: Holding = {
      id: crypto.randomUUID(),
      symbol: draft.symbol.trim().toUpperCase(),
      name: draft.name.trim() || draft.symbol.trim().toUpperCase(),
      assetClass: draft.assetClass,
      shares,
      costBasis: isNaN(costBasis) ? shares * price : costBasis,
      currentPrice: price,
      currentValue: shares * price,
    }

    setHoldings(prev => [...prev, holding])
    setDraft({ ...emptyHolding })
    setError(null)
  }, [draft])

  const removeHolding = useCallback((id: string) => {
    setHoldings(prev => prev.filter(h => h.id !== id))
  }, [])

  const handleSubmit = useCallback(() => {
    if (holdings.length === 0 && !cashBalance) {
      setError('Add at least one holding or a cash balance.')
      return
    }

    const account: Account = {
      id: crypto.randomUUID(),
      name: accountName.trim() || 'My Account',
      institution: institution.trim() || 'Manual Entry',
      accountType,
      holdings,
      cds: [],
      cashBalance: parseFloat(cashBalance) || 0,
    }

    setPortfolio({
      id: crypto.randomUUID(),
      name: 'Manual Portfolio',
      accounts: [account],
      asOfDate: new Date().toISOString().split('T')[0],
    })

    onComplete()
  }, [
    holdings,
    cashBalance,
    accountName,
    institution,
    accountType,
    setPortfolio,
    onComplete,
  ])

  const totalValue =
    holdings.reduce((sum, h) => sum + h.currentValue, 0) +
    (parseFloat(cashBalance) || 0)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Account Details</CardTitle>
          <CardDescription>Set up your account information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="account-name">Account Name</Label>
              <Input
                id="account-name"
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                placeholder="e.g. Fidelity Brokerage"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="institution">Institution</Label>
              <Input
                id="institution"
                value={institution}
                onChange={e => setInstitution(e.target.value)}
                placeholder="e.g. Fidelity"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Account Type</Label>
              <Select
                value={accountType}
                onValueChange={v => setAccountType(v as AccountType)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cash-balance">Cash Balance ($)</Label>
              <Input
                id="cash-balance"
                type="number"
                min="0"
                step="0.01"
                value={cashBalance}
                onChange={e => setCashBalance(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add Holdings</CardTitle>
          <CardDescription>
            Add stocks, ETFs, funds, or other positions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-6 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Symbol</Label>
              <Input
                value={draft.symbol}
                onChange={e =>
                  setDraft(d => ({ ...d, symbol: e.target.value }))
                }
                placeholder="VTI"
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Name (optional)</Label>
              <Input
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                placeholder="Vanguard Total Stock Market"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Shares</Label>
              <Input
                type="number"
                min="0"
                step="0.001"
                value={draft.shares}
                onChange={e =>
                  setDraft(d => ({ ...d, shares: e.target.value }))
                }
                placeholder="100"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Price ($)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={draft.currentPrice}
                onChange={e =>
                  setDraft(d => ({ ...d, currentPrice: e.target.value }))
                }
                placeholder="250.00"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cost Basis ($)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={draft.costBasis}
                onChange={e =>
                  setDraft(d => ({ ...d, costBasis: e.target.value }))
                }
                placeholder="Auto"
              />
            </div>
          </div>
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Asset Class</Label>
              <Select
                value={draft.assetClass}
                onValueChange={v =>
                  setDraft(d => ({ ...d, assetClass: v as AssetClass }))
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ASSET_CLASS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={addHolding} variant="outline">
              Add Holding
            </Button>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}

          {holdings.length > 0 && (
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-zinc-50 dark:bg-zinc-900">
                    <th className="px-3 py-2 text-left font-medium">Symbol</th>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-right font-medium">Shares</th>
                    <th className="px-3 py-2 text-right font-medium">Price</th>
                    <th className="px-3 py-2 text-right font-medium">Value</th>
                    <th className="px-3 py-2 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map(h => (
                    <tr key={h.id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-mono font-medium">
                        {h.symbol}
                      </td>
                      <td className="text-muted-foreground px-3 py-2">
                        {h.name}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {h.shares.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right">
                        $
                        {h.currentPrice.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        $
                        {h.currentValue.toLocaleString(undefined, {
                          maximumFractionDigits: 0,
                        })}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => removeHolding(h.id)}
                          className="text-muted-foreground hover:text-destructive text-xs"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(holdings.length > 0 || parseFloat(cashBalance) > 0) && (
            <div className="flex items-center justify-between rounded-md bg-zinc-50 px-4 py-3 dark:bg-zinc-900">
              <span className="text-sm font-medium">Total Portfolio Value</span>
              <span className="text-lg font-bold">
                $
                {totalValue.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Button
        className="w-full"
        onClick={handleSubmit}
        disabled={holdings.length === 0 && !cashBalance}
      >
        Continue to Profile
      </Button>
    </div>
  )
}

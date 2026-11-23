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
import { parsePortfolioCSV } from '@/engine/csv-parser'
import { usePortfolioStore } from '@/store/portfolio-store'
import { ManualEntryForm } from '@/components/manual-entry-form'
import { AuthCard } from '@/components/auth-card'
import { PortfolioPersistence } from '@/components/portfolio-persistence'
import type { ImportResult } from '@/engine/types'

interface UploadStepProps {
  onComplete: () => void
}

type EntryMode = 'csv' | 'manual'

export function UploadStep({ onComplete }: UploadStepProps) {
  const [mode, setMode] = useState<EntryMode>('csv')
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const setPortfolio = usePortfolioStore(s => s.setPortfolio)

  const processFile = useCallback(
    (file: File) => {
      setError(null)
      setImportResult(null)

      if (!file.name.endsWith('.csv')) {
        setError('Please upload a CSV file.')
        return
      }

      const reader = new FileReader()
      reader.onload = e => {
        try {
          const text = e.target?.result as string
          if (!text || text.trim().length === 0) {
            setError('The CSV file is empty. Please upload a valid file.')
            return
          }

          const result = parsePortfolioCSV(text)

          if (result.warnings.length > 0 && result.accounts.length === 0) {
            // Parsing failed - show first warning as error
            setError(
              result.warnings[0] ||
                'Unable to parse the CSV file. Please check the format.'
            )
            return
          }

          if (result.accounts.length === 0) {
            setError(
              'No accounts found in the CSV. Please check that your file contains holdings data with columns like Symbol, Quantity, and Value.'
            )
            return
          }

          setImportResult(result)
          setPortfolio({
            id: crypto.randomUUID(),
            name: 'Imported Portfolio',
            accounts: result.accounts,
            asOfDate: new Date().toISOString().split('T')[0],
          })
        } catch (err) {
          console.error('Unexpected error during CSV import:', err)
          setError(
            'An unexpected error occurred while reading the file. Please ensure it is a valid CSV file.'
          )
        }
      }

      reader.onerror = () => {
        setError('Failed to read the file. Please try again.')
      }

      reader.readAsText(file)
    },
    [setPortfolio]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const file = e.dataTransfer.files[0]
      if (file) processFile(file)
    },
    [processFile]
  )

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) processFile(file)
    },
    [processFile]
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold tracking-tight">
          Add Your Portfolio
        </h2>
        <p className="text-muted-foreground mt-2">
          Upload a CSV or enter your holdings manually.
        </p>
      </div>

      <AuthCard />
      <PortfolioPersistence onLoadPortfolio={onComplete} />

      <div className="flex justify-center gap-2">
        <button
          onClick={() => setMode('csv')}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            mode === 'csv'
              ? 'bg-primary text-primary-foreground'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
          }`}
        >
          Upload CSV
        </button>
        <button
          onClick={() => setMode('manual')}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            mode === 'manual'
              ? 'bg-primary text-primary-foreground'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
          }`}
        >
          Enter Manually
        </button>
      </div>

      {mode === 'manual' ? (
        <ManualEntryForm onComplete={onComplete} />
      ) : (
        <>
          <Card>
            <CardContent>
              <div
                onDragOver={e => {
                  e.preventDefault()
                  setDragActive(true)
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`flex min-h-[200px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                  dragActive
                    ? 'border-primary bg-primary/5'
                    : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                }`}
                onClick={() => document.getElementById('csv-input')?.click()}
              >
                <svg
                  className="text-muted-foreground mb-4 h-10 w-10"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                  />
                </svg>
                <p className="text-sm font-medium">
                  Drop your CSV here or click to browse
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Fidelity, Schwab, Vanguard, or generic CSV
                </p>
                <input
                  id="csv-input"
                  type="file"
                  accept=".csv"
                  aria-label="Upload portfolio CSV"
                  className="hidden"
                  onChange={handleFileInput}
                />
              </div>
            </CardContent>
          </Card>

          {error && (
            <Card className="border-destructive">
              <CardContent>
                <p className="text-destructive text-sm">{error}</p>
              </CardContent>
            </Card>
          )}

          {importResult && (
            <Card>
              <CardHeader>
                <CardTitle>Import Summary</CardTitle>
                <CardDescription>
                  Detected {importResult.format} format
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold">
                      {importResult.accounts.length}
                    </p>
                    <p className="text-muted-foreground text-xs">Accounts</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {importResult.rowsImported}
                    </p>
                    <p className="text-muted-foreground text-xs">Holdings</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      $
                      {importResult.accounts
                        .reduce(
                          (sum, a) =>
                            sum +
                            a.cashBalance +
                            a.holdings.reduce((s, h) => s + h.currentValue, 0),
                          0
                        )
                        .toLocaleString(undefined, {
                          maximumFractionDigits: 0,
                        })}
                    </p>
                    <p className="text-muted-foreground text-xs">Total Value</p>
                  </div>
                </div>

                {importResult.warnings.length > 0 && (
                  <div className="rounded-md bg-amber-50 p-3 dark:bg-amber-950/30">
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                      Warnings:
                    </p>
                    <ul className="text-xs text-amber-700 dark:text-amber-300">
                      {importResult.warnings.map((w, i) => (
                        <li key={i}>• {w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <Button className="w-full" onClick={onComplete}>
                  Continue to Profile
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  setPortfolio: vi.fn(),
}))

vi.mock('@/components/auth-card', () => ({
  AuthCard: () => <div data-testid="auth-card" />,
}))
vi.mock('@/components/portfolio-persistence', () => ({
  PortfolioPersistence: () => <div data-testid="portfolio-persistence" />,
}))
vi.mock('@/components/manual-entry-form', () => ({
  ManualEntryForm: () => <div data-testid="manual-entry" />,
}))
vi.mock('@/store/portfolio-store', () => ({
  usePortfolioStore: (selector: (state: unknown) => unknown) =>
    selector({ setPortfolio: mocks.setPortfolio }),
}))

import { UploadStep } from '../upload-step'

const csv = readFileSync(
  resolve(
    process.cwd(),
    'skills/retire-runway/fixtures/csv/generic-sample.csv'
  ),
  'utf8'
)

describe('UploadStep behavior', () => {
  const originalReader = globalThis.FileReader
  const originalRandomUUID = crypto.randomUUID

  beforeEach(() => {
    mocks.setPortfolio.mockReset()
    class ImmediateFileReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null

      readAsText() {
        this.onload?.({ target: { result: csv } } as ProgressEvent<FileReader>)
      }
    }
    globalThis.FileReader = ImmediateFileReader as unknown as typeof FileReader
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: () => 'portfolio-test-id',
    })
  })

  afterEach(() => {
    globalThis.FileReader = originalReader
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: originalRandomUUID,
    })
  })

  it('imports a CSV, persists it, and advances to the profile step', async () => {
    const onComplete = vi.fn()
    const { container } = render(<UploadStep onComplete={onComplete} />)
    const input = container.querySelector('#csv-input')
    expect(input).not.toBeNull()

    const file = new File([csv], 'portfolio.csv', { type: 'text/csv' })
    fireEvent.change(input!, { target: { files: [file] } })

    expect(await screen.findByText('Import Summary')).toBeInTheDocument()
    expect(mocks.setPortfolio).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'portfolio-test-id',
        name: 'Imported Portfolio',
        accounts: expect.arrayContaining([
          expect.objectContaining({ name: 'Taxable' }),
        ]),
      })
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue to Profile' })
    )
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
  })
})

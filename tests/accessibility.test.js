/**
 * Accessibility tests for the customer-facing workflow.
 *
 * These tests run axe against rendered React components. Browser-level checks
 * remain useful for layout and interaction, but this gate must fail when a
 * semantic accessibility regression reaches the component tree.
 */

import { createElement } from 'react'
import { render } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'
import Home from '../src/app/page'
import { UploadStep } from '../src/components/upload-step'

async function runAxe(container) {
  return axe.run(container, {
    rules: {
      // jsdom cannot calculate real rendered color contrast. Keep contrast in
      // the browser review, where computed styles and layout are available.
      'color-contrast': { enabled: false },
    },
  })
}

function violationSummary(violations) {
  return violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map(node => node.target),
  }))
}

describe('Accessibility tests', () => {
  it('has no axe violations on the landing workflow', async () => {
    const { container } = render(createElement(Home))
    const results = await runAxe(container)

    expect(violationSummary(results.violations)).toEqual([])
  })

  it('starts with one primary heading and does not skip heading levels', () => {
    const { container } = render(createElement(Home))
    const headings = Array.from(
      container.querySelectorAll('h1, h2, h3, h4, h5, h6')
    )

    expect(headings.filter(heading => heading.tagName === 'H1')).toHaveLength(1)

    let previousLevel = 0
    for (const heading of headings) {
      const level = Number(heading.tagName.slice(1))
      expect(level).toBeLessThanOrEqual(previousLevel + 1)
      previousLevel = level
    }
  })

  it('has no axe violations on the portfolio upload workflow', async () => {
    const { container } = render(
      createElement(UploadStep, { onComplete: () => undefined })
    )
    const results = await runAxe(container)

    expect(violationSummary(results.violations)).toEqual([])
  })

  it('gives every rendered input an accessible label', () => {
    const { container } = render(
      createElement(UploadStep, { onComplete: () => undefined })
    )

    for (const input of container.querySelectorAll('input')) {
      const hasLabel =
        input.hasAttribute('aria-label') ||
        input.hasAttribute('aria-labelledby') ||
        Boolean(input.id && container.querySelector(`label[for="${input.id}"]`))

      expect(
        hasLabel,
        `Input ${input.id || input.type} has no accessible label`
      ).toBe(true)
    }
  })
})

export function filterByImpact(violations, levels = ['critical', 'serious']) {
  return violations.filter(violation => levels.includes(violation.impact))
}

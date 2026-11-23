import Link from 'next/link'
import { Button } from '@/components/ui/button'

interface MarketingLayoutProps {
  children: React.ReactNode
}

const NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/faq', label: 'FAQ' },
  { href: '/about', label: 'About' },
]

const FOOTER_LINKS = {
  product: [
    { href: '/features', label: 'Features' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/faq', label: 'FAQ' },
  ],
  company: [{ href: '/about', label: 'About' }],
  legal: [
    { href: '/privacy', label: 'Privacy Policy' },
    { href: '/terms', label: 'Terms of Service' },
  ],
}

export function MarketingLayout({ children }: MarketingLayoutProps) {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-zinc-950">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link
            href="/"
            className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50"
          >
            RetireRunway
          </Link>
          <nav className="hidden items-center gap-6 md:flex">
            {NAV_LINKS.map(link => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <Button asChild size="sm">
            <Link href="/">Get Started</Link>
          </Button>
        </div>
      </header>

      <main>{children}</main>

      <footer className="border-t bg-zinc-100 dark:bg-zinc-900">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <div className="grid gap-8 md:grid-cols-4">
            <div>
              <Link
                href="/"
                className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50"
              >
                RetireRunway
              </Link>
              <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                The pre-retirement planning tool that tells you what to do, not
                just whether you have enough.
              </p>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Product
              </h3>
              <ul className="space-y-2">
                {FOOTER_LINKS.product.map(link => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Company
              </h3>
              <ul className="space-y-2">
                {FOOTER_LINKS.company.map(link => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Legal
              </h3>
              <ul className="space-y-2">
                {FOOTER_LINKS.legal.map(link => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-8 border-t border-zinc-200 pt-8 dark:border-zinc-800">
            <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
              &copy; {new Date().getFullYear()} RetireRunway. For educational
              use only. Not financial advice. Not FDIC insured. Not a deposit.
              May lose value.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

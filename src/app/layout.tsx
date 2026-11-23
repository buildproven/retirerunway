import type { Metadata } from 'next'
import './globals.css'
import { AuthListener } from '@/components/auth-listener'

export const metadata: Metadata = {
  title: 'RetireRunway - Retirement Portfolio Scenario Planner',
  description:
    'The pre-retirement tool that answers what you should actually DO — not just whether you have enough.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <AuthListener />
        {children}
      </body>
    </html>
  )
}

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components'

interface FirstStepsEmailProps {
  userEmail: string
}

export function FirstStepsEmail({ userEmail }: FirstStepsEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        Your first steps with RetireRunway - Upload your portfolio in 2 minutes
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Let&apos;s Get You Started</Heading>
          <Text style={text}>Hi again,</Text>
          <Text style={text}>
            You signed up for RetireRunway yesterday with{' '}
            <strong>{userEmail}</strong>. Here&apos;s a quick guide to help you
            get the most out of your account.
          </Text>

          <Section style={stepSection}>
            <Heading as="h2" style={stepHeading}>
              Step 1: Upload Your Portfolio
            </Heading>
            <Text style={stepText}>
              Export your holdings from your brokerage (Fidelity, Schwab,
              Vanguard, etc.) as a CSV file. Most brokerages have this option
              under &quot;Download&quot; or &quot;Export&quot; in your positions
              view.
            </Text>
            <Text style={stepText}>
              Then drag and drop it into RetireRunway. We&apos;ll automatically
              detect the format.
            </Text>
          </Section>

          <Section style={stepSection}>
            <Heading as="h2" style={stepHeading}>
              Step 2: Set Your Retirement Parameters
            </Heading>
            <Text style={stepText}>
              Tell us your planned retirement age, expected annual spending, and
              Social Security start date. These inputs power our projection
              engine.
            </Text>
          </Section>

          <Section style={stepSection}>
            <Heading as="h2" style={stepHeading}>
              Step 3: Run Your First Scenario
            </Heading>
            <Text style={stepText}>
              Click &quot;Run Analysis&quot; to see a 30-year projection of your
              retirement finances. Try adjusting parameters to see how different
              decisions affect your runway.
            </Text>
          </Section>

          <Hr style={hr} />

          <Text style={text}>
            <strong>Pro tip:</strong> Use the &quot;What If&quot; scenarios to
            model life events like a market downturn, unexpected expenses, or
            delaying retirement by a few years.
          </Text>

          <Text style={text}>
            <Link href="https://retirerunway.app" style={link}>
              Open RetireRunway and upload your portfolio
            </Link>
          </Text>

          <Text style={footer}>
            Need help? Reply to this email and we&apos;ll assist you personally.
          </Text>
          <Text style={footer}>- The RetireRunway Team</Text>
        </Container>
      </Body>
    </Html>
  )
}

const main = {
  backgroundColor: '#f6f9fc',
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
}

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '40px 20px',
  maxWidth: '600px',
  borderRadius: '8px',
}

const h1 = {
  color: '#1a1a1a',
  fontSize: '28px',
  fontWeight: '700',
  margin: '0 0 24px',
  padding: '0',
}

const stepSection = {
  margin: '24px 0',
  padding: '20px',
  backgroundColor: '#f9fafb',
  borderRadius: '6px',
  borderLeft: '4px solid #2563eb',
}

const stepHeading = {
  color: '#1a1a1a',
  fontSize: '18px',
  fontWeight: '600',
  margin: '0 0 12px',
  padding: '0',
}

const stepText = {
  color: '#4a4a4a',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '8px 0',
}

const text = {
  color: '#4a4a4a',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 0',
}

const link = {
  color: '#2563eb',
  textDecoration: 'underline',
}

const hr = {
  borderColor: '#e6e6e6',
  margin: '24px 0',
}

const footer = {
  color: '#8898aa',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '8px 0',
}

export default FirstStepsEmail

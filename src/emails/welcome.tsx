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

interface WelcomeEmailProps {
  userEmail: string
}

export function WelcomeEmail({ userEmail }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        Welcome to RetireRunway - Your retirement planning journey starts here
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Welcome to RetireRunway</Heading>
          <Text style={text}>Hi there,</Text>
          <Text style={text}>
            Thanks for signing up with <strong>{userEmail}</strong>.
            RetireRunway helps pre-retirees model different financial scenarios
            to plan for a confident retirement.
          </Text>

          <Section style={featureSection}>
            <Heading as="h2" style={h2}>
              What you can do with RetireRunway:
            </Heading>
            <Text style={featureText}>
              <strong>Upload Your Portfolio</strong> - Import your holdings via
              CSV to get a complete picture of your retirement assets.
            </Text>
            <Text style={featureText}>
              <strong>Run Scenarios</strong> - Model different retirement dates,
              spending levels, and market conditions to see how your money will
              last.
            </Text>
            <Text style={featureText}>
              <strong>AI-Powered Insights</strong> - Get plain-English
              explanations of your financial projections.
            </Text>
            <Text style={featureText}>
              <strong>Tax Planning</strong> - Understand the tax implications of
              different withdrawal strategies.
            </Text>
          </Section>

          <Hr style={hr} />

          <Text style={text}>
            Ready to get started?{' '}
            <Link href="https://retirerunway.app" style={link}>
              Log in to RetireRunway
            </Link>{' '}
            and upload your first portfolio.
          </Text>

          <Text style={footer}>
            Questions? Just reply to this email - we read every message.
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

const h2 = {
  color: '#1a1a1a',
  fontSize: '20px',
  fontWeight: '600',
  margin: '0 0 16px',
  padding: '0',
}

const text = {
  color: '#4a4a4a',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 0',
}

const featureSection = {
  backgroundColor: '#f9fafb',
  borderRadius: '6px',
  padding: '24px',
  margin: '24px 0',
}

const featureText = {
  color: '#4a4a4a',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '12px 0',
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

export default WelcomeEmail

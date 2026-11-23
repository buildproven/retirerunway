# Security Policy

## Automated Security Scanning

This project uses multiple layers of automated security scanning:

### Secret Detection

- **Tool**: Gitleaks
- **Configuration**: `.gitleaks.toml`
- **Coverage**: API keys, passwords, tokens, certificates
- **Pre-commit**: Blocks commits containing secrets
- **CI/CD**: Scans all pull requests

### Dependency Scanning

- **Tool**: npm audit
- **Level**: High and critical vulnerabilities only
- **Auto-fix**: Enabled for compatible updates
- **CI/CD**: Fails builds on high/critical vulnerabilities

The license gate permits `LGPL-3.0-or-later` only for the platform-specific
`@img/sharp-libvips-*` runtime packages that Next.js installs for image
optimization. The package identity is checked separately from the general
license allowlist. This is a runtime dependency, not an application source
license.

### Code Security Scanning

- **Tool**: ESLint security plugin
- **Configuration**: `eslint-security.config.js`
- **Coverage**: Injection attacks, unsafe patterns, crypto issues
- **Pre-commit**: Blocks commits with security violations

### Workflow Security

- **Tool**: actionlint
- **Coverage**: GitHub Actions workflow security issues
- **CI/CD**: Validates workflow syntax and security

## Manual Security Commands

```bash
# Check dependencies for known vulnerabilities
npm run security:audit

# Check for secrets
npm run security:secrets

# Run the Semgrep application scan
npm run security:scan

# Check dependency license allowlist
npm run license:check
```

## Reporting Security Issues

If you discover a security vulnerability:

1. **DO NOT** create a public GitHub issue
2. Email security reports to: [Your security email]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if known)

## Security Best Practices

### For Developers

- Never commit secrets, API keys, or passwords
- Use environment variables for sensitive configuration
- Run `npm run security:audit`, `npm run security:scan`, and
  `npm run license:check` before pushing
- Keep dependencies updated
- Review security scanner output carefully

### For CI/CD

- All security checks must pass before merge
- Dependency updates require security review
- Secrets stored in secure environment variables
- Regular security audits in automated schedules

## Security Contact

For security-related questions: [Your contact information]

## Policy Updates

This security policy is reviewed and updated quarterly.
Last updated: [Current date]

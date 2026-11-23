#!/usr/bin/env bash
set -euo pipefail

# Keep the scanner status separate from the validator status. Command
# substitution exits under `set -e` when license-checker fails, so a partial
# or failed scan cannot be reported as a clean audit.
AUDIT_JSON="$(license-checker --json --excludePrivatePackages)"
printf '%s' "$AUDIT_JSON" | node scripts/license-audit.js

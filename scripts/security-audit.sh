#!/usr/bin/env bash
# Production dependencies: any high-severity finding is a hard failure.
# Full tree: only the documented dev-only advisories in security-audit.js pass.
set -euo pipefail

AUDIT_STDERR="$(mktemp)"
cleanup() {
  rm -f "$AUDIT_STDERR"
}
trap cleanup EXIT

set +e
AUDIT_JSON="$(npm audit --audit-level high --json 2>"$AUDIT_STDERR")"
AUDIT_STATUS=$?
set -e

if [ "$AUDIT_STATUS" -gt 1 ]; then
  cat "$AUDIT_STDERR" >&2
  echo "npm audit failed with exit status $AUDIT_STATUS" >&2
  exit 1
fi

npm audit --omit=dev --audit-level high >/dev/null || {
  echo "npm audit found high-severity vulnerabilities in production dependencies" >&2
  exit 1
}

printf '%s' "$AUDIT_JSON" | NPM_AUDIT_STATUS="$AUDIT_STATUS" node scripts/security-audit.js

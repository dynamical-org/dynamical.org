#!/usr/bin/env bash
set -euo pipefail

# Use uvx (uv) locally, fall back to pipx in environments like Cloudflare Pages
run_tool() {
  if command -v uvx &>/dev/null; then
    uvx "$@"
  else
    pipx run "$@"
  fi
}

echo "==> stac-validator: schema validation"
run_tool stac-validator validate docs/stac/catalog.json --recursive

echo ""
echo "==> stac-check: best practices"
FAILED=0
for f in docs/stac/catalog.json docs/stac/*/collection.json; do
  output=$(run_tool stac-check "$f" 2>&1)
  warnings=$(echo "$output" | awk '/STAC Best Practices:/{found=1; next} /Additional Information:/{found=0} found && /[^ \t]/')
  if [ -n "$warnings" ]; then
    echo "FAIL: $f"
    echo "$warnings"
    FAILED=1
  fi
done

if [ "$FAILED" -eq 1 ]; then
  exit 1
fi
echo "All STAC files passed."

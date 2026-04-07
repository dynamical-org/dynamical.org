#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STAC_DIR="$PROJECT_DIR/docs/stac"
VALIDATOR_DIR="$PROJECT_DIR/.cache/gostac-validator"
VALIDATOR_BIN="$VALIDATOR_DIR/stac-cli"
VALIDATOR_REPO="https://github.com/StacLabs/gostac-validator.git"

# Build the validator if not already present
if [ ! -x "$VALIDATOR_BIN" ]; then
  echo "Building gostac-validator..."
  rm -rf "$VALIDATOR_DIR"
  git clone --depth 1 "$VALIDATOR_REPO" "$VALIDATOR_DIR"
  cd "$VALIDATOR_DIR"
  go build -o stac-cli ./cmd/cli
  cd "$PROJECT_DIR"
  echo "gostac-validator built successfully."
fi

# Check that the STAC output directory exists
if [ ! -d "$STAC_DIR" ]; then
  echo "Error: STAC output directory not found at $STAC_DIR"
  echo "Run 'npm run build' first to generate the STAC catalog."
  exit 1
fi

# Find all STAC JSON files and validate them
STAC_FILES=$(find "$STAC_DIR" -name '*.json' -type f)
FILE_COUNT=$(echo "$STAC_FILES" | wc -l)
echo "Validating $FILE_COUNT STAC file(s) in $STAC_DIR..."

FAILED=0
for file in $STAC_FILES; do
  RELATIVE=$(echo "$file" | sed "s|$PROJECT_DIR/||")
  OUTPUT=$("$VALIDATOR_BIN" "$file" 2>&1) || true

  if echo "$OUTPUT" | grep -q '"valid": true'; then
    echo "  ✓ $RELATIVE"
  else
    echo "  ✗ $RELATIVE"
    echo "$OUTPUT" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
  fi
done

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "STAC validation failed: $FAILED file(s) invalid."
  exit 1
else
  echo "All $FILE_COUNT STAC file(s) are valid."
fi

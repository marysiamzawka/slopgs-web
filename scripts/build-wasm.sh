#!/usr/bin/env bash
# build-wasm.sh -- clones slopgs at the commit pinned in SLOPGS_COMMIT and
# compiles msgs.wasm, copying it next to index.html. Shared by setup.sh
# (local dev) and .github/workflows/deploy.yml (the public Pages build),
# so both ever produce is this one, named, unmodified snapshot -- see
# SLOPGS_COMMIT's own comment in setup.sh for why that pin matters here
# beyond the usual reproducibility reasons.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$HERE/vendor/slopgs"
REPO_URL="https://github.com/sloptainment/slopgs.git"
SLOPGS_COMMIT="$(cat "$HERE/SLOPGS_COMMIT")"

if ! command -v clang >/dev/null 2>&1; then
  echo "error: clang not found -- msgs.wasm is compiled with clang --target=wasm32" >&2
  exit 1
fi

if [ ! -d "$VENDOR_DIR" ]; then
  echo "cloning slopgs (pinned to $SLOPGS_COMMIT)..."
  git clone "$REPO_URL" "$VENDOR_DIR"
  git -C "$VENDOR_DIR" checkout "$SLOPGS_COMMIT"
elif [ "$(git -C "$VENDOR_DIR" rev-parse HEAD)" != "$SLOPGS_COMMIT" ]; then
  echo "vendor/slopgs is at a different commit than SLOPGS_COMMIT pins -- checking out $SLOPGS_COMMIT..."
  git -C "$VENDOR_DIR" fetch origin "$SLOPGS_COMMIT"
  git -C "$VENDOR_DIR" checkout "$SLOPGS_COMMIT"
fi

echo "building dist/msgs.wasm..."
make -C "$VENDOR_DIR" dist/msgs.wasm

cp "$VENDOR_DIR/dist/msgs.wasm" "$HERE/msgs.wasm"
echo "copied msgs.wasm to $HERE/msgs.wasm"

#!/usr/bin/env bash
# Packaging gate: build each publishable package, pack it the way publishing
# would (pnpm pack applies publishConfig), and verify the artifact with
# publint (manifest correctness) and arethetypeswrong (type resolution).
# The packages are ESM-only, so attw runs the esm-only profile.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/.packcheck"
rm -rf "$out"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT

for pkg in protocol client server yjs; do
  dir="$root/packages/$pkg"
  echo "── @cf-sync/$pkg ─────────────────────────────────────"
  (cd "$dir" && pnpm pack --out "$out/$pkg.tgz" > /dev/null)
  (cd "$dir" && pnpm exec publint --pack pnpm)
  pnpm exec attw --profile esm-only "$out/$pkg.tgz"
done

echo "── packaging checks passed ───────────────────────────"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUN_PI_SMOKE="${RUN_PI_SMOKE:-0}"
RUN_KITTY_SMOKE="${RUN_KITTY_SMOKE:-0}"
ARTIFACT_ROOT="${ARTIFACT_ROOT:-$(mktemp -d /tmp/pi-ephemeral-installed-smoke-XXXXXX)}"
if [[ "$ARTIFACT_ROOT" != /* ]]; then
  ARTIFACT_ROOT="$(pwd -P)/$ARTIFACT_ROOT"
fi

mkdir -p "$ARTIFACT_ROOT"
echo "Artifacts: $ARTIFACT_ROOT"

assert_no_missing_catalog() {
  local path="$1"
  if grep -Eq '(^|[^[:alnum:]_])(ERROR )?missing_catalog([^[:alnum:]_]|$)' "$path"; then
    echo "Unexpected missing_catalog in $path" >&2
    exit 1
  fi
}

cd "$ROOT"
npm test | tee "$ARTIFACT_ROOT/npm-test.log"
npm run typecheck | tee "$ARTIFACT_ROOT/typecheck.log"
npm run build | tee "$ARTIFACT_ROOT/build.log"
npm run test:package | tee "$ARTIFACT_ROOT/test-package.log"
npm run pack:check | tee "$ARTIFACT_ROOT/pack-check.log"
git diff --check | tee "$ARTIFACT_ROOT/diff-check.log"

PACK_DIR="$ARTIFACT_ROOT/pack"
HOST_DIR="$ARTIFACT_ROOT/host"
AGENT_DIR="$ARTIFACT_ROOT/agent"
PROJECT_DIR="$ARTIFACT_ROOT/project"
mkdir -p "$PACK_DIR" "$AGENT_DIR" "$PROJECT_DIR"
TARBALL_NAME="$(npm pack --pack-destination "$PACK_DIR" | tail -n 1)"
TARBALL="$PACK_DIR/$TARBALL_NAME"
cp -R "$ROOT/examples/minimal-skill-package" "$HOST_DIR"
node - "$HOST_DIR/package.json" "$TARBALL" <<'NODE'
const fs = require('fs');
const [pkgPath, tarball] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@tarmo-randma/pi-ephemeral'] = tarball;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
NODE
npm install --prefix "$HOST_DIR" | tee "$ARTIFACT_ROOT/host-npm-install.log"
node "$HOST_DIR/node_modules/@tarmo-randma/pi-ephemeral/dist/cli.js" list --package "$HOST_DIR" --agent-dir "$AGENT_DIR" --cwd "$PROJECT_DIR" | tee "$ARTIFACT_ROOT/list.txt"
assert_no_missing_catalog "$ARTIFACT_ROOT/list.txt"
node "$HOST_DIR/node_modules/@tarmo-randma/pi-ephemeral/dist/cli.js" info skill ephemeral-example --package "$HOST_DIR" --agent-dir "$AGENT_DIR" --cwd "$PROJECT_DIR" | tee "$ARTIFACT_ROOT/info.txt"
assert_no_missing_catalog "$ARTIFACT_ROOT/info.txt"
node "$HOST_DIR/node_modules/@tarmo-randma/pi-ephemeral/dist/cli.js" enable skill ephemeral-example --global --package "$HOST_DIR" --agent-dir "$AGENT_DIR" --cwd "$PROJECT_DIR" | tee "$ARTIFACT_ROOT/enable.txt"
node "$HOST_DIR/node_modules/@tarmo-randma/pi-ephemeral/dist/cli.js" status --package "$HOST_DIR" --agent-dir "$AGENT_DIR" --cwd "$PROJECT_DIR" | tee "$ARTIFACT_ROOT/status.txt"
assert_no_missing_catalog "$ARTIFACT_ROOT/status.txt"
node "$HOST_DIR/node_modules/@tarmo-randma/pi-ephemeral/dist/cli.js" disable skill ephemeral-example --global --package "$HOST_DIR" --agent-dir "$AGENT_DIR" --cwd "$PROJECT_DIR" | tee "$ARTIFACT_ROOT/disable.txt"

if [[ "$RUN_PI_SMOKE" == "1" ]]; then
  PI_AGENT_DIR="$ARTIFACT_ROOT/pi-agent"
  mkdir -p "$PI_AGENT_DIR"
  PI_CODING_AGENT_DIR="$PI_AGENT_DIR" pi install "$HOST_DIR" | tee "$ARTIFACT_ROOT/pi-install.log"
  PI_CODING_AGENT_DIR="$PI_AGENT_DIR" pi --print '/pi-ephemeral list' | tee "$ARTIFACT_ROOT/pi-command-list.log"
fi

if [[ "$RUN_KITTY_SMOKE" == "1" ]]; then
  echo "RUN_KITTY_SMOKE=1 requested. Use a local kitty remote-control smoke pattern to open Pi with PI_CODING_AGENT_DIR under $ARTIFACT_ROOT and capture /pi-ephemeral screens." | tee "$ARTIFACT_ROOT/kitty-smoke-note.log"
  echo "This script intentionally does not assume a universal kitty socket in public CI." | tee -a "$ARTIFACT_ROOT/kitty-smoke-note.log"
fi

echo "Smoke complete: $ARTIFACT_ROOT"

#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev-install.sh [--dev | --all] [--uninstall] [--help]

Targets:
  default  Install to ~/Library/Application Support/Continuo/Plugins/<plugin-id>/
  --dev    Install to ~/Library/Application Support/Continuo Dev/Plugins/<plugin-id>/
  --all    Install to both packaged and dev userData paths

Options:
  --uninstall  Remove the target plugin directory instead of installing
  --help       Show this help
EOF
}

MODE=packaged
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)
      MODE=dev
      shift
      ;;
    --all)
      MODE=all
      shift
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[git-viewer] ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f manifest.json ]]; then
  echo "[git-viewer] ERROR: manifest.json not found; run from repo root" >&2
  exit 1
fi

PLUGIN_ID=$(node -p "require('./manifest.json').id" 2>/dev/null)
if [[ -z "$PLUGIN_ID" || "$PLUGIN_ID" == "undefined" ]]; then
  echo "[git-viewer] ERROR: cannot read .id from manifest.json" >&2
  exit 1
fi

if [[ "$UNINSTALL" == false ]]; then
  for path in manifest.json dist README.md; do
    if [[ ! -e "$path" ]]; then
      echo "[git-viewer] ERROR: missing $path; run 'pnpm build' first" >&2
      exit 1
    fi
  done
fi

install_to_userdata() {
  local label="$1"
  local userdata="$2"
  local target="$userdata/Plugins/$PLUGIN_ID"

  if [[ "$UNINSTALL" == true ]]; then
    if [[ -d "$target" ]]; then
      rm -rf "$target"
      echo "[git-viewer] [$label] uninstalled: $target"
    else
      echo "[git-viewer] [$label] not installed: $target"
    fi
    return
  fi

  echo "[git-viewer] [$label] installing to: $target"
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  mkdir -p "$target"
  cp manifest.json "$target/"
  cp -R dist "$target/"
  cp README.md "$target/"
  echo "[git-viewer] [$label] installed"
}

PACKAGED_USER_DATA="$HOME/Library/Application Support/Continuo"
DEV_USER_DATA="$HOME/Library/Application Support/Continuo Dev"

case "$MODE" in
  packaged)
    install_to_userdata packaged "$PACKAGED_USER_DATA"
    ;;
  dev)
    install_to_userdata dev "$DEV_USER_DATA"
    ;;
  all)
    install_to_userdata packaged "$PACKAGED_USER_DATA"
    install_to_userdata dev "$DEV_USER_DATA"
    ;;
esac

echo "[git-viewer] restart Continuo to load the plugin"

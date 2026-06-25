#!/usr/bin/env bash
# Hemiunu installer - clones the app, installs deps, and exposes the `hemiunu`
# command. Re-run any time to update.
#
#   curl -fsSL https://raw.githubusercontent.com/AntoineF23/hemiunu/main/install.sh | bash
#
# Overrides: HEMIUNU_REPO, HEMIUNU_DIR, HEMIUNU_BIN_DIR.
set -euo pipefail

REPO_URL="${HEMIUNU_REPO:-https://github.com/AntoineF23/hemiunu.git}"
APP_DIR="${HEMIUNU_DIR:-$HOME/.hemiunu/app}"
BIN_DIR="${HEMIUNU_BIN_DIR:-$HOME/.local/bin}"

sand() { printf '\033[38;5;180m%s\033[0m\n' "$*"; }
sage() { printf '\033[38;5;108m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

sand "Installing Hemiunu..."

# 1. Prerequisites: git + Node 20+.
command -v git >/dev/null 2>&1 || { err "git is required. Install it and re-run."; exit 1; }
command -v node >/dev/null 2>&1 || { err "Node.js 20+ is required - https://nodejs.org"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node 20+ is required (found $(node -v)). Upgrade at https://nodejs.org and re-run."
  exit 1
fi

# Resolve a pnpm runner: an installed pnpm, else corepack (ships with Node but
# isn't always on PATH), else a one-off npx download of the pinned pnpm.
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then
  PNPM="corepack pnpm"
elif command -v npx >/dev/null 2>&1; then
  PNPM="npx --yes pnpm@11.8.0"
else
  err "Could not find pnpm, corepack, or npx. Install pnpm (https://pnpm.io/installation) and re-run."
  exit 1
fi

# 2. Clone or update.
if [ -d "$APP_DIR/.git" ]; then
  sand "Updating $APP_DIR ..."
  git -C "$APP_DIR" pull --ff-only --quiet
else
  sand "Cloning into $APP_DIR ..."
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 --quiet "$REPO_URL" "$APP_DIR"
fi

# 3. Install dependencies (buildless - tsx runs the TypeScript directly).
# pnpm may exit non-zero only to flag an un-approved (but harmless, already
# satisfied) esbuild build script - deps still link and tsx still runs. So we
# don't abort on that; instead we verify tsx is runnable below.
sand "Installing dependencies..."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
LOG="$(mktemp)"
( cd "$APP_DIR" && $PNPM install ) >"$LOG" 2>&1 || true
if ! "$APP_DIR/node_modules/.bin/tsx" -e 'process.exit(0)' >/dev/null 2>&1; then
  err "Dependency install failed:"
  cat "$LOG" >&2
  rm -f "$LOG"
  exit 1
fi
rm -f "$LOG"

# 4. Expose the `hemiunu` command (symlink resolves back to the install dir).
mkdir -p "$BIN_DIR"
chmod +x "$APP_DIR/bin/hemiunu.mjs"
ln -sf "$APP_DIR/bin/hemiunu.mjs" "$BIN_DIR/hemiunu"

# 5. PATH guidance (keys are collected by `hemiunu` on first run - no file editing).
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) sand "Add this to your shell profile so 'hemiunu' is found:"
     printf '    export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
esac

sage "Done. Run:  hemiunu   (it will ask for your API key the first time)"

#!/usr/bin/env bash
# Links the Gloomberb host and its React into this plugin's node_modules so
# `bun run typecheck` and `bun test` resolve `gloomberb/*` the way the app does.
# A packaged Gloomberb (the .app or Homebrew cask) has no source tree to link,
# so a source checkout at the installed version is used instead.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${GLOOMBERB_VERSION:-$(gloomberb --version 2>/dev/null | awk '/Version/ {print $2}')}"
HOST="${GLOOMBERB_SRC:-$HOME/.cache/gloomberb-host/gloomberb}"
if [ ! -d "$HOST/.git" ]; then
  mkdir -p "$(dirname "$HOST")"
  git clone --depth 1 --branch "v${VERSION}" https://github.com/gloom-sh/gloomberb.git "$HOST"
  (cd "$HOST" && bun install)
fi
mkdir -p node_modules
ln -sfn "$HOST" node_modules/gloomberb
ln -sfn "$HOST/node_modules/react" node_modules/react
echo "Linked gloomberb from $HOST"

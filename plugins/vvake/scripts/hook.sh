#!/bin/sh
# VVake's UserPromptSubmit hook. Needs Node.js 18+ (no other dependency). Without Node it never blocks
# anything and says so once.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1; then
  exec node "$dir/vvake.mjs" hook
fi
home="${VVAKE_HOME:-$HOME/.vvake}/claude"
if [ ! -f "$home/no-node-shown" ]; then
  mkdir -p "$home" && : > "$home/no-node-shown"
  printf '%s' '{"systemMessage":"VVake needs Node.js 18 or later (https://nodejs.org). Until then nothing is ever locked."}'
fi
exit 0

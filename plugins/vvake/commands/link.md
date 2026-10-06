---
description: "VVake: link your VVake app (QR code), or 'local' to use it without the app"
argument-hint: "[local]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/vvake.mjs" link "$ARGUMENTS"`

Show the VVake output above to the user exactly as it is, with no comment.

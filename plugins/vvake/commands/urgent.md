---
description: "VVake: urgent work, no lock and no nudges (2h, 30m, today, off)"
argument-hint: "[2h|30m|today|off]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/vvake.mjs" urgent $ARGUMENTS`

Show the VVake output above to the user exactly as it is, with no comment.

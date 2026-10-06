---
description: "VVake: postpone the lock (30m, 1h or 4h; 3 a day, each adds 10% of moving), or off"
argument-hint: "[30m|1h|4h|off]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/vvake.mjs" urgent "$ARGUMENTS"`

Show the VVake output above to the user exactly as it is, with no comment.

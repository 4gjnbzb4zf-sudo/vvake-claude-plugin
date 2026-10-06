---
description: "VVake: last resort, unlock Claude now (always works; 'anyway' while postpones or skips are left)"
argument-hint: "[anyway]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/vvake.mjs" unlock "$ARGUMENTS"`

Show the VVake output above to the user exactly as it is, with no comment.

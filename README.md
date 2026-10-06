# VVake for Claude Code

**Lock Claude until you move.** Builders lose hours at the desk. After a long stretch (90 min by default), Claude
takes a break with you: new prompts wait until you've moved 10 minutes. A walk your VVake watch or phone logs
unlocks it by itself. Urgent work can always go through: postpone, skip, or a last-resort unlock, each with a small
price, from the terminal, your phone or your watch.

## Install

In Claude Code:

```
/plugin marketplace add 4gjnbzb4zf-sudo/vvake-claude-plugin
/plugin install vvake@vvake
```

Or from your shell: `claude plugin marketplace add 4gjnbzb4zf-sudo/vvake-claude-plugin && claude plugin install vvake@vvake`.

Needs Node.js 18 or later on your PATH (no other dependency). Without Node the plugin never locks anything and says
so once.

## Link your VVake

On your next prompt the plugin shows a QR code and a link like `https://vvake.com/claude/X7K2-9QPM` instead of
blocking anything. Scan it with your iPhone camera, VVake opens and asks "Link Claude Code on <your Mac>?". One tap
on **Link** and you're done: the plugin picks it up by itself (it polls for 10 minutes).

`/vvake:link` shows the QR again. No app? `/vvake:link local` uses the same rule without it: unlocks after 10 minutes
away from the keyboard.

## How it works

- **Desk time** comes from your prompt times only: prompts less than 5 minutes apart are one stretch, a 5-minute gap
  starts it over.
- **A heads-up** 10 minutes before ("a good moment to wrap up").
- **The lock**: at 90 minutes the next new prompt is held: "92 min at the desk. Move 10 minutes and Claude is back."
  Never in the middle of a running task: only a new prompt is ever held.
- **Your phone and watch know**: the moment Claude locks, VVake sends one alert to your phone (and your watch):
  "Claude is waiting for you to move · Move 10 min to unlock Claude", with **Start** (starts the walk on the watch, or
  on the phone) and **Urgent…** (postpone or skip). The same lock screen is in the app any time (Today, or You →
  Connections → Claude Code) and on the watch's Today, so you can postpone or skip with the computer closed: the
  plugin picks it up on your next prompt.
- **Unlocks by moving**: any real session your watch or phone logs after the lock counts (the daily move too). The
  next prompt goes through once it's done, and on macOS a notification says "Claude is back".
- **Your rule lives in the app** (You → Connections → Claude Code): after X minutes, Y minutes of moving, whether
  time away also counts, on or off.

## Escapes, with a price

Nobody is ever stuck, but getting out of a lock costs a little more moving next time. The VVake API keeps the
counters for your account (phone, watch and every linked computer share them); without the app, or offline, this
plugin keeps the same count on your computer.

| | |
| --- | --- |
| `urgent: …` at the start of a message | A **30-minute postpone**: the message goes through, no lock until then. (`urgence`, `!urgent`, `#urgent` work too, but in the terminal a leading `!` switches Claude Code to bash mode, so `urgent:` is the one to use.) |
| `/vvake:urgent [30m\|1h\|4h\|off]` | **Postpone** 30 min, 1 h or 4 h. **3 a day.** Each one makes the next unlock need **10% more moving**, compounding and rounded up (10 → 11 → 13 → 14 min). `off` ends it early (still counted). |
| `/vvake:skip` | **Skip** this lock without moving. **2 a week** (Monday to Sunday). Type it twice, at least 10 s apart (within 2 min), to confirm. Desk time starts over. |
| `/vvake:unlock` | **Last resort**, always works, never limited: the next unlock needs two more 10% steps. While you still have postpones or skips it lists them first; `/vvake:unlock anyway` goes ahead. |
| **Claude lock** in the app / on the watch | The same postpone, skip (with a 10-s countdown) and last resort, plus **Start moving**. Works with the computer asleep. |
| `/vvake:status` | Desk time, the rule, what the next unlock needs, postpones and skips left, link. |
| `/vvake:unlink` | Unlinks this computer (or unlink it from the app). Then nothing locks. |

The price resets at local midnight, and as soon as you unlock by moving. Postpones reset at midnight, skips on Monday.
The `/vvake:` commands are answered by the plugin itself: they never reach Claude and cost nothing.

## What is sent, and what isn't

**Never sent anywhere:** your prompts, code, file names, file contents, transcripts. The prompt text is only read on
your machine to spot `/vvake:` commands and the `urgent:` prefix, and it is not stored.

**Sent to the VVake API** (`https://vvake-api.val-54e.workers.dev`, or `$VVAKE_API`):

| When | What |
| --- | --- |
| Pairing | Your computer's name (e.g. "Alex's MacBook Pro", ≤ 60 chars), shown on your phone. |
| Polling while pairing | The secret pairing code. |
| Near the lock, while locked, and every 5 min at most otherwise | Continuous desk minutes, when the lock started, the time since which to count your moving minutes, and your time zone (for local days and weeks). |
| A postpone, skip or last resort | Which one (and 30, 60 or 240 minutes), and your time zone. |
| `/vvake:unlink` | The unlink request. |

What comes back: your rule, whether a postpone is running, what the next unlock needs, postpones and skips left,
and the minutes you've moved since the lock. When the plugin reports a new lock, the API sends one alert to your
phone (if you allowed notifications in VVake).

**On your machine** (`~/.vvake/claude/`, or `$VVAKE_HOME/claude`): `state.json` (prompt times, counters), `token.json`
(the desk token, mode 0600), `cache.json` (your rule), `pairing.json` while pairing, `watch.json` while locked.

**macOS:** while locked, a small background process reads keyboard / mouse idle time (`ioreg` `HIDIdleTime`, never
keystrokes) so time away only counts when you're really away, and shows the "Claude is back" notification.
It stops when the lock ends.

## Develop

```
npm test                                    # node:test, no dependencies (core rules, QR, the real hook vs a fake API)
claude plugin validate . && claude plugin validate ./plugins/vvake
claude --plugin-dir ./plugins/vvake         # try it without installing
VVAKE_API=http://localhost:8787 VVAKE_HOME=/tmp/vvake claude --plugin-dir ./plugins/vvake   # against wrangler dev
```

- `plugins/vvake/lib/core.mjs`: the rules, pure. They mirror `@vvfit/game-core` `focus.ts` (`focusDecision`,
  `nextDeskMinutes`) and `deskLock.ts` (the escapes) in the VVake monorepo; this plugin ships on its own, so they're
  copied. Keep both in sync.
- `plugins/vvake/lib/qr.mjs`: a small QR encoder adapted from Project Nayuki's QR Code generator (MIT).
- `plugins/vvake/scripts/vvake.mjs`: the hook, the commands, the pairing poller and the lock watcher.
- API contract: `docs/05-tech/api-v1.md`, "Desk (Claude Code)", in the VVake monorepo.

MIT License.

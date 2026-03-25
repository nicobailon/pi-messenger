<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T16:24:25Z -->

# 011 — Planning Transcript

**Participants:** PureStorm (pi/claude-opus-4-6, proposer) × TrueDragon (crew-challenger, pi/claude-opus-4-6)
**Date:** 2026-03-25
**Rounds:** 2 (review → challenge → revise → approved)

## Round 1: PureStorm presents plan

6 tasks covering all Shape B parts. Detailed code for collision guard fix, resolveSettingsEntry, health-check.sh, setup-machine.sh, post-receive hook update.

## Round 2: TrueDragon challenges (6 concerns, 3 critical)

| # | Concern | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Wrapper fallback gap: exit(0) overrides exitCode=1 when jiti missing | 🔴 | Preserved two-branch pattern: success → exit(0), fail → exit(1) |
| 2 | resolveSettingsEntry throws → catch swallows → falls through to extension copy | 🔴 | Dedicated try/catch inside collision block, exits(1) on failure |
| 3 | Post-receive swallows ALL install.mjs output (stdout + stderr) | 🔴 | Changed to `>/dev/null` (stdout only), stderr visible |
| 4 | Shell→JS injection in setup-machine.sh node -e | 🟡 | Use env vars: `SETTINGS=... REPO_PATH=... node -e "...process.env..."` |
| 5 | "messenger" grep too loose — false positives | 🟡 | Changed to `grep -q 'pi-messenger'` |
| 6 | No automated verification for deploy-parity spec | 🟡 | Added scripts/test-deploy.sh integration test |

TrueDragon verified correct: startsWith fix, three-way resolution logic, health-check.sh structure, post-receive CWD handling, dependency ordering.

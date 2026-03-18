<!-- codex-review:approved:v1 | harness: codex/gpt-5.4 | date: 2026-03-18T20:45:00Z | rounds: 3 -->

No blocking findings.

**Adversarial Gate**
1. Riskiest assumption: the common dev-flow install still hits the collision guard. I re-verified that the repo is registered in Pi settings `[settings.json#L21](/Users/dalecarman/.pi/agent/settings.json#L21)`, and the revised plan now explicitly converts that path to exit 0 when wrapper creation succeeded `[claude-plan-edb641a7.md#L127](/tmp/claude-plan-edb641a7.md#L127)` `[claude-plan-edb641a7.md#L131](/tmp/claude-plan-edb641a7.md#L131)`. That closes the R3/AC4 gap.

2. Riskiest assumption: T9 really exercises crew-spawned mode instead of the easier external-agent bootstrap. I checked the real CLI bootstrap path `[cli/index.ts#L249](/Users/dalecarman/Groove%20Jones%20Dropbox/Dale%20Carman/Projects/dev/pi-messenger/cli/index.ts#L249)` `[cli/index.ts#L255](/Users/dalecarman/Groove%20Jones%20Dropbox/Dale%20Carman/Projects/dev/pi-messenger/cli/index.ts#L255)`, and the revised plan now includes pre-registration plus `PI_CREW_WORKER=1`, `PI_AGENT_NAME`, and `PI_MESSENGER_DIR` in T9 `[claude-plan-edb641a7.md#L179](/tmp/claude-plan-edb641a7.md#L179)` `[claude-plan-edb641a7.md#L182](/tmp/claude-plan-edb641a7.md#L182)` `[claude-plan-edb641a7.md#L185](/tmp/claude-plan-edb641a7.md#L185)` `[claude-plan-edb641a7.md#L189](/tmp/claude-plan-edb641a7.md#L189)`. That now matches AC5.

3. Riskiest assumption: the PATH-validation claim is now precise. The current code still builds `env` after runtime-command validation `[runtime-spawn.ts#L48](/Users/dalecarman/Groove%20Jones%20Dropbox/Dale%20Carman/Projects/dev/pi-messenger/crew/runtime-spawn.ts#L48)` `[runtime-spawn.ts#L64](/Users/dalecarman/Groove%20Jones%20Dropbox/Dale%20Carman/Projects/dev/pi-messenger/crew/runtime-spawn.ts#L64)`, and the plan now scopes the env-aware fix specifically to the new CLI check `[claude-plan-edb641a7.md#L139](/tmp/claude-plan-edb641a7.md#L139)` `[claude-plan-edb641a7.md#L151](/tmp/claude-plan-edb641a7.md#L151)`. That is accurate and no longer overclaims.

A skeptical senior engineer’s first objection would have been “does the dev install still fail, or does T9 still hit the wrong bootstrap path?” I checked both against source, and this revision answers both.

What the plan still does not cover for a broader production hardening pass: wrapper ownership-safe overwrite/remove behavior and Pi install layouts beyond the current npm/Homebrew+jiti path. Those remain real future concerns, but they are outside the spec 007 acceptance criteria as written.

What I verified: I re-read the updated `/tmp` plan, re-checked `[install.mjs](/Users/dalecarman/Groove%20Jones%20Dropbox/Dale%20Carman/Projects/dev/pi-messenger/install.mjs)`, `[runtime-spawn.ts](/Users/dalecarman/Groove%20Jones%20Dropbox/Dale%20Carman/Projects/dev/pi-messenger/crew/runtime-spawn.ts)`, `[cli/index.ts](/Users/dalecarman/Groove%20Jones%20Dropbox/Dale%20Carman/Projects/dev/pi-messenger/cli/index.ts)`, and `[settings.json](/Users/dalecarman/.pi/agent/settings.json)`, and I retested the 3 assumptions that previously blocked approval. The revised plan now covers the spec’s required path cleanly enough to implement.

VERDICT: APPROVED

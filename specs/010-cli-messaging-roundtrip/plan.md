---
title: "CLI Messaging Round-Trip — Implementation Plan"
date: 2026-03-25
bead: pi-messenger-75c
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T10:44:51Z -->
<!-- Codex Review: APPROVED after 3 rounds (session 2) | model: gpt-5.3-codex | date: 2026-03-25 -->
<!-- Status: REVISED -->
<!-- Revisions: CWD fallback disabled for explicit --self-model (R7), read-only ambiguity errors (not swallow), R0 AC narrowed to inbox-level, readInboxMessages shape validation, double-wait guard, async test helper, join-only session gate, fail-fast timeout -->

# 010 — Implementation Plan

## Architecture Overview

All three bootstrap paths (registering, read-only, leave) share the same three-step session lookup chain:

```
1. detectModel() in try/catch
2. Exact key: readCliSession(dirs, cwd, model)
3. CWD fallback: findSessionByCwd(dirs, cwd) — ONLY when --self-model was NOT explicitly provided
```

**Critical rule (R7):** CWD fallback is DISABLED when `--self-model` is explicitly provided. Explicit model → exact key only. This prevents `join --self-model new-model` from reusing an existing session keyed on a different model.

When CWD fallback provides the session, `resolvedModel = session.model` (not detectModel's result). Both name AND model are stable.

## Codex Review Revisions

Revisions incorporated from 5 rounds of Codex review (gpt-5.3-codex):

1. **send --wait double-wait guard** — `executeSend()` already blocks for collaborator replies (handlers.ts:373-463). CLI poll loop skips if `details.reply || details.conversationComplete` is set. Prevents double-wait or spurious timeout.
2. **Async test helper** — `runCliAsync()` using `child_process.spawn` for send --wait tests. `execFileSync` blocks the event loop, preventing delayed inbox writes.
3. **Join-only session creation** — Only `action === "join"` creates new sessions. Non-join commands error if no session exists. Pseudocode made explicit.
4. **findSessionByCwd field validation** — Validates `name/model/cwd/startedAt` before accepting match, same as `readCliSession()` at line 231.
5. **Shared `readInboxMessages()` utility** — Single inbox reader for both `receive` and `send --wait` to prevent drift.
6. **Fail-fast timeout** — Invalid `--timeout` (NaN, ≤0) → usage error, not silent fallback.
7. **Test 15 dropped** — CLI-to-CLI two-process integration test deferred. PID-liveness validation (store.ts:1155) makes pure two-CLI tests fragile without a dedicated multi-process test harness. R0 round-trip coverage provided by Test 13 + tests 8-10. Total: 14 tests.

## Implementation Details

### Task 1: Extract `findSessionByCwd()`

**File:** `cli/index.ts`, after `writeCliSession()` (~line 260)

```typescript
function findSessionByCwd(dirs: Dirs, cwd: string): CliSession | null {
  const sessionsDir = getCliSessionsDir(dirs);
  if (!fs.existsSync(sessionsDir)) return null;

  const matches: CliSession[] = [];
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    try {
      const candidate = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, f), "utf-8")
      ) as CliSession;
      // Same field validation as readCliSession (line 231)
      if (!candidate.name || !candidate.model || !candidate.cwd || !candidate.startedAt) continue;
      if (candidate.cwd === cwd) {
        const age = Date.now() - new Date(candidate.startedAt).getTime();
        if (age <= CLI_SESSION_TTL_MS) {
          matches.push(candidate);
        }
      }
    } catch { /* skip malformed */ }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  throw new Error(
    "Multiple sessions found for this CWD. Use --self-model to specify which session."
  );
}
```

### Task 2: Restructure `bootstrapExternal()`

**File:** `cli/index.ts` (lines 275-318)
**New signature:** `bootstrapExternal(dirs, cwd, modelFlag?, action?)`

**Action threading:** `bootstrap()` passes `cmd.action` → `bootstrapExternal()`. Callers updated:
- `bootstrap()` signature gains `action?: string` in options
- `runCommand()` passes `cmd.action` in bootstrap options
- `bootstrapExternal()` receives it as 4th parameter

Session creation is **join-only**. CWD fallback is **disabled when --self-model is explicit**.

```
const explicitModel = !!modelFlag;
let resolvedModel: string | undefined;
let session: CliSession | null = null;

try {
  resolvedModel = detectModel(modelFlag);
  session = readCliSession(dirs, cwd, resolvedModel);
  if (!session && !explicitModel) {
    // CWD fallback ONLY when model was auto-detected
    const cwdSession = findSessionByCwd(dirs, cwd);
    if (cwdSession) { session = cwdSession; resolvedModel = cwdSession.model; }
  }
} catch (e) {
  if (e instanceof Error && e.message.includes("Multiple sessions")) throw e;
  // detectModel threw — always try CWD fallback
  const cwdSession = findSessionByCwd(dirs, cwd);
  if (cwdSession) { session = cwdSession; resolvedModel = cwdSession.model; }
}

if (session) {
  name = session.name
} else if (action === "join" && resolvedModel) {
  name = generateMemorableName()
  writeCliSession(dirs, cwd, resolvedModel, name)
} else if (action === "join") {
  exit("No model detected. Use --self-model <model> to join.")
} else {
  exit("No active session. Run: pi-messenger-cli join --self-model <model>")
}
```

### Task 3: Update read-only `bootstrap()` path

**File:** `cli/index.ts` (lines 441-456)

Same chain with explicit-model guard: exact key → CWD fallback (only if no --self-model) → anonymous. **Ambiguity (2+ matches) produces error with guidance** (consistent with registering and leave paths) — not swallowed to anonymous.

### Task 4: Refactor `leave` to use `findSessionByCwd()`

**File:** `cli/index.ts` (lines 609-695)

Same three-step chain. Ambiguity guard surfaces error. Both detectModel-success-but-miss AND detectModel-throw paths use CWD fallback.

### Task 5: Rename `READ_ONLY_COMMANDS` → `NO_REGISTER_COMMANDS`

Add `"receive"` to the set. Update comment: "Commands that must NOT re-register — prevents PID clobber of long-running processes."

### Task 6: Extract shared `readInboxMessages()` + Add `receive` command

**Shared utility with shape validation** (prevents drift between receive and send --wait):

```typescript
interface InboxMessage { msg: AgentMailMessage; filePath: string; }

function isValidInboxMessage(obj: unknown): obj is AgentMailMessage {
  return typeof obj === "object" && obj !== null
    && typeof (obj as any).from === "string"
    && typeof (obj as any).text === "string"
    && typeof (obj as any).timestamp === "string";
}

function readInboxMessages(inboxDir: string): { messages: InboxMessage[]; malformed: string[] } {
  if (!fs.existsSync(inboxDir)) return { messages: [], malformed: [] };
  const files = fs.readdirSync(inboxDir)
    .filter(f => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  const messages: InboxMessage[] = [];
  const malformed: string[] = [];
  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isValidInboxMessage(parsed)) throw new Error("missing required fields");
      messages.push({ msg: parsed, filePath });
    } catch {
      malformed.push(file);
    }
  }
  return { messages, malformed };
}
```

**`receive` command:** Uses `readInboxMessages()`. Prints `[SenderName YYYY-MM-DDTHH:MM:SSZ] text`. Deletes after print. Warns on malformed (stderr, file NOT deleted). Anonymous → guidance. Empty → "No new messages."

### Task 7: Add `send --wait` (with double-wait guard)

**File:** `cli/index.ts` — modify existing `send` case

**Critical:** Skip CLI poll when `executeSend()` already returned a collaborator reply.

```typescript
case "send": {
  const to = cmd.args.to as string;
  const message = cmd.args.message as string;
  const wait = cmd.args.wait === true;
  const rawTimeout = cmd.args.timeout ? parseInt(cmd.args.timeout as string, 10) : undefined;
  if (rawTimeout !== undefined && (isNaN(rawTimeout) || rawTimeout <= 0)) {
    process.stderr.write("✗ Invalid --timeout value. Must be a positive integer (seconds).\n");
    process.exitCode = 1;
    return;
  }
  const timeoutSec = rawTimeout ?? 300;
  
  if (!to || !message) { /* usage error */ }
  
  const sendResult = await handlers.executeSend(state, dirs, cwd, to, false, message);
  printResult(sendResult);
  
  const details = sendResult.details as Record<string, unknown>;
  // Skip wait if: error, reply already received (collaborator), or conversation complete
  if (!wait || details.error || details.reply || details.conversationComplete) break;
  
  // Non-collaborator: poll inbox using shared utility
  const inboxDir = path.join(dirs.inbox, state.agentName);
  const deadline = Date.now() + (timeoutSec * 1000);
  const failedFiles = new Set<string>();
  process.stderr.write(`Waiting for reply from ${to}... (timeout: ${timeoutSec}s)\n`);
  
  while (Date.now() < deadline) {
    const { messages, malformed } = readInboxMessages(inboxDir);
    for (const mf of malformed) {
      if (!failedFiles.has(mf)) {
        failedFiles.add(mf);
        process.stderr.write(`⚠ Skipping malformed inbox file: ${mf}\n`);
      }
    }
    for (const { msg, filePath } of messages) {
      if (msg.from === to) {
        try { fs.unlinkSync(filePath); } catch {}  // race-safe
        process.stdout.write(`\n✓ Reply from ${to}:\n\n${msg.text}\n`);
        return;
      }
    }
    await sleep(100);
  }
  
  process.stderr.write(`✗ No reply from ${to} within ${timeoutSec}s. Check later with: pi-messenger-cli receive\n`);
  process.exitCode = 1;
  break;
}
```

### Task 8: UX guidance text

1. `join` output: "To check for messages: pi-messenger-cli receive"
2. `executeStatus()` in handlers.ts: if `agentName === "anonymous"`, append guidance
3. `printHelp()`: add `receive`, `--wait`, `--timeout`

### Task 9: Tests (14 scenarios)

**Async helper** for send --wait tests:

```typescript
function runCliAsync(
  args: string[], env?: Record<string, string>, cwd?: string
): { proc: ChildProcess; stdout: () => string; stderr: () => string; waitForExit: () => Promise<number> } {
  const proc = spawn("npx", ["tsx", CLI_PATH, ...args], {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...env },
  });
  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (d: Buffer) => { stdoutBuf += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
  return {
    proc,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    waitForExit: () => new Promise(resolve => proc.on("exit", (code) => resolve(code ?? 1))),
  };
}
```

**14 tests:**

| # | Test | Validates | Helper |
|---|------|-----------|--------|
| 1 | Identity stable: join --self-model X → send (no flag) → same name | R1 | runCli |
| 2 | Identity stable: join → detectModel throw → CWD fallback → same name | R1 | runCli |
| 3 | CWD ambiguity: two sessions same CWD → error mentions --self-model | R7 | runCli |
| 4 | Receive reads inbox: write msg → receive → prints → file deleted | R2 | runCli |
| 5 | Receive malformed: invalid JSON → stderr, file NOT deleted | R8 | runCli |
| 6 | Receive before join: anonymous → guidance | R3 | runCli |
| 7 | Receive empty: "No new messages." | R9 | runCli |
| 8 | Send --wait gets reply | R5 | runCliAsync |
| 9 | Send --wait timeout (--timeout 1) | R5 | runCliAsync |
| 10 | Send --wait non-consumption: other agent msg untouched | R5 | runCliAsync |
| 11 | UX: join mentions receive | R4 | runCli |
| 12 | UX: status anonymous mentions join | R3 | runCli |
| 13 | Full round-trip: join → send → receive reply | R0 | runCli |
| 14 | Leave ambiguity: two sessions → error | R7 | runCli |

**Tests 8-10:** Use `runCliAsync` to spawn send --wait in background, then `setTimeout` writes reply file to inbox while CLI polls.

**Deferred:** CLI-to-CLI two-process integration test. PID-liveness validation (store.ts:1155) makes pure two-CLI tests fragile. Requires dedicated multi-process test harness.

### Task 10: Verify no regressions

Run `npx vitest run` — all existing tests pass.

## Requirement Traceability

| Requirement | Tasks | Tests |
|-------------|-------|-------|
| R0 (round-trip) | All | 13 |
| R1 (identity stable) | 1, 2, 3 | 1, 2 |
| R2 (receive) | 6 | 4 |
| R3 (pre-join guidance) | 8 | 6, 12 |
| R4 (post-join guidance) | 8 | 11 |
| R5 (send --wait) | 7 | 8, 9, 10 |
| R6 (tests) | 9 | All |
| R7 (no identity theft) | 1, 2, 4 | 3, 14 |
| R8 (malformed warning) | 6 | 5 |
| R9 (output format) | 6 | 4, 7 |

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| CWD scan performance | Sessions have 8h TTL; directory is small |
| send --wait 100ms poll CPU | Same pattern as spawn, runs up to 15min without issues |
| Breaking change (no auto-create) | Intentional. Error tells agent to `join` first. |
| Leave ambiguity guard | Better UX than silent first-match |
| Double-wait on collaborator sends | Gated on `details.reply \|\| details.conversationComplete` |

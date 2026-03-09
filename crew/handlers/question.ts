/**
 * Crew - Question Handler
 * 
 * Inter-agent question/answer protocol for mid-task communication.
 * Operations: ask, answer, list
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { MessengerState } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import * as store from "../store.js";
import { logFeedEvent } from "../../feed.js";

// =============================================================================
// Types
// =============================================================================

export interface QuestionEntry {
  id: string;
  from: string;
  to: string;
  question: string;
  context: string | null;
  taskId: string | null;         // Task ID of the asking agent (for progress logging)
  timestamp: string;
  status: "pending" | "answered" | "timeout";
  answer: string | null;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Timeout for pending questions before they are marked as 'timeout'.
 * Configurable via MESSENGER_QUESTION_TIMEOUT_MS env var. Default: 60 seconds.
 * When timeout fires without an answer, workers should proceed with best-guess
 * rather than blocking indefinitely.
 */
const QUESTION_TIMEOUT_MS = parseInt(process.env.MESSENGER_QUESTION_TIMEOUT_MS ?? '60000', 10);

// =============================================================================
// Store helpers
// =============================================================================

function getQuestionsPath(cwd: string): string {
  return path.join(store.getCrewDir(cwd), "questions.json");
}

function loadQuestions(cwd: string): QuestionEntry[] {
  const p = getQuestionsPath(cwd);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function saveQuestions(cwd: string, questions: QuestionEntry[]): void {
  const p = getQuestionsPath(cwd);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(questions, null, 2));
  fs.renameSync(tmpPath, p);
}

/**
 * Sweep pending questions and mark any that have exceeded the timeout as 'timeout'.
 * Workers should proceed with best-guess when a question times out rather than blocking.
 * Returns the number of questions that were timed out.
 */
function sweepTimeouts(cwd: string, questions: QuestionEntry[]): number {
  const now = Date.now();
  let timedOut = 0;
  for (const q of questions) {
    if (q.status === "pending") {
      const age = now - new Date(q.timestamp).getTime();
      if (age >= QUESTION_TIMEOUT_MS) {
        q.status = "timeout";
        timedOut++;
        // Log warning so asking workers know to proceed with best-guess
        console.warn(
          `[pi-messenger] Question ${q.id} from ${q.from} to ${q.to} timed out after ${Math.round(age / 1000)}s. ` +
          `Workers should proceed with best-guess. Question: "${q.question}"`
        );
        // Append timeout notice to the asking task's progress log
        if (q.taskId) {
          try {
            store.appendTaskProgress(
              cwd,
              q.taskId,
              "system",
              `Question ${q.id} to ${q.to} timed out after ${Math.round(age / 1000)}s — proceed with best-guess. Question: "${q.question}"`
            );
          } catch {
            // appendTaskProgress may fail if crew dir doesn't exist yet
          }
        }
      }
    }
  }
  if (timedOut > 0) {
    saveQuestions(cwd, questions);
  }
  return timedOut;
}

// =============================================================================
// Main handler
// =============================================================================

export async function execute(
  op: string,
  params: CrewParams,
  state: MessengerState,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();

  switch (op) {
    case "ask":
      return questionAsk(cwd, params, state);
    case "answer":
      return questionAnswer(cwd, params, state);
    case "list":
      return questionList(cwd, state);
    default:
      return result(`Unknown question operation: ${op}`, {
        mode: "question",
        error: "unknown_operation",
        operation: op,
      });
  }
}

// =============================================================================
// ask
// =============================================================================

function questionAsk(cwd: string, params: CrewParams, state: MessengerState) {
  const from = state.agentName || "unknown";
  const to = params.to;
  const question = params.question;
  const context = params.context ?? null;
  const taskId = params.id ?? null;

  if (!to) {
    return result("Error: 'to' required for ask action.", {
      mode: "question.ask",
      error: "missing_to",
    });
  }

  if (!question) {
    return result("Error: 'question' required for ask action.", {
      mode: "question.ask",
      error: "missing_question",
    });
  }

  const id = `q-${crypto.randomUUID().slice(0, 8)}`;
  const toAgent = typeof to === "string" ? to : to[0];
  const entry: QuestionEntry = {
    id,
    from,
    to: toAgent,
    question,
    context,
    taskId,
    timestamp: new Date().toISOString(),
    status: "pending",
    answer: null,
  };

  const questions = loadQuestions(cwd);
  questions.push(entry);
  saveQuestions(cwd, questions);

  logFeedEvent(cwd, from, "question.ask", id, `→ ${entry.to}: ${question}`);

  // Deliver to target agent's inbox
  const inboxDir = path.join(cwd, ".pi", "messenger", "inbox", toAgent);
  fs.mkdirSync(inboxDir, { recursive: true });
  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = path.join(inboxDir, `${Date.now()}-${random}.json`);
  const inboxMsg = {
    id: `${id}-inbox`,
    from,
    to: toAgent,
    text: `Question from ${from}: ${question}${context ? `\nContext: ${context}` : ""}`,
    timestamp: new Date().toISOString(),
    replyTo: null,
    type: "question",
    questionId: id,
    taskId,
  };
  fs.writeFileSync(msgFile, JSON.stringify(inboxMsg, null, 2));

  // Append to asking task's progress log (if taskId known)
  if (taskId) {
    store.appendTaskProgress(cwd, taskId, "system", `Question asked to ${toAgent}: ${question}`);
  }

  return result(
    `Question sent to **${entry.to}**:\n> ${question}\n\nQuestion ID: \`${id}\``,
    {
      mode: "question.ask",
      questionId: id,
      to: entry.to,
    },
  );
}

// =============================================================================
// answer
// =============================================================================

function questionAnswer(cwd: string, params: CrewParams, state: MessengerState) {
  const questionId = params.questionId;
  const answer = params.answer;
  const from = state.agentName || "unknown";

  if (!questionId) {
    return result("Error: 'questionId' required for answer action.", {
      mode: "question.answer",
      error: "missing_questionId",
    });
  }

  if (!answer) {
    return result("Error: 'answer' required for answer action.", {
      mode: "question.answer",
      error: "missing_answer",
    });
  }

  const questions = loadQuestions(cwd);
  const entry = questions.find((q) => q.id === questionId);

  if (!entry) {
    return result(`Error: question '${questionId}' not found.`, {
      mode: "question.answer",
      error: "question_not_found",
      questionId,
    });
  }

  entry.status = "answered";
  entry.answer = answer;
  saveQuestions(cwd, questions);

  logFeedEvent(cwd, from, "question.answer", questionId, answer);

  // Deliver answer to the asking worker's inbox
  const askedBy = entry.from;
  const inboxDir = path.join(cwd, ".pi", "messenger", "inbox", askedBy);
  fs.mkdirSync(inboxDir, { recursive: true });
  const ts = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const inboxFile = path.join(inboxDir, `${ts}-answer-${questionId}.json`);
  const inboxMsg = {
    type: "question.answer",
    questionId,
    question: entry.question,
    answer,
    from,
    timestamp: new Date(ts).toISOString(),
  };
  fs.writeFileSync(inboxFile, JSON.stringify(inboxMsg, null, 2));

  // Append answer to asking task's progress log (if taskId known)
  // Timeout sweep is implemented via sweepTimeouts() in the questions list handler,
  // but it is passive — timeouts are only evaluated when the question list is fetched,
  // not on a background timer. Questions that are never listed will wait indefinitely.
  if (entry.taskId) {
    store.appendTaskProgress(cwd, entry.taskId, "system", `Answer from ${from}: ${answer}`);
  }

  return result(
    `Answered question \`${questionId}\` from **${entry.from}**:\n> ${entry.question}\n\n**Answer:** ${answer}`,
    {
      mode: "question.answer",
      questionId,
      from: entry.from,
    },
  );
}

// =============================================================================
// list
// =============================================================================

function questionList(cwd: string, state: MessengerState) {
  const agentName = state.agentName || "unknown";
  const questions = loadQuestions(cwd);

  // Sweep timeouts before listing
  sweepTimeouts(cwd, questions);

  const pending = questions.filter(
    (q) => q.to === agentName && q.status === "pending",
  );

  if (pending.length === 0) {
    return result("No pending questions.", {
      mode: "question.list",
      count: 0,
      questions: [],
    });
  }

  const lines = pending.map(
    (q) =>
      `- **${q.id}** from ${q.from}: ${q.question}${q.context ? ` (context: ${q.context})` : ""}`,
  );

  return result(
    `# Pending Questions (${pending.length})\n\n${lines.join("\n")}`,
    {
      mode: "question.list",
      count: pending.length,
      questions: pending,
    },
  );
}

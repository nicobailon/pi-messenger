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
  timestamp: string;
  status: "pending" | "answered" | "timeout";
  answer: string | null;
}

// =============================================================================
// Constants
// =============================================================================

const TIMEOUT_MS = 60_000; // 60 seconds

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
  fs.writeFileSync(p, JSON.stringify(questions, null, 2));
}

/**
 * Sweep pending questions and mark any that have exceeded the timeout as 'timeout'.
 * Returns the number of questions that were timed out.
 */
function sweepTimeouts(cwd: string, questions: QuestionEntry[]): number {
  const now = Date.now();
  let timedOut = 0;
  for (const q of questions) {
    if (q.status === "pending") {
      const age = now - new Date(q.timestamp).getTime();
      if (age >= TIMEOUT_MS) {
        q.status = "timeout";
        timedOut++;
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
  const entry: QuestionEntry = {
    id,
    from,
    to: typeof to === "string" ? to : to[0],
    question,
    context,
    timestamp: new Date().toISOString(),
    status: "pending",
    answer: null,
  };

  const questions = loadQuestions(cwd);
  questions.push(entry);
  saveQuestions(cwd, questions);

  logFeedEvent(cwd, from, "question.ask", id, `→ ${entry.to}: ${question}`);

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

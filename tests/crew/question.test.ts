import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerState } from "../../lib.js";
import * as store from "../../crew/store.js";
import { createMockContext } from "../helpers/mock-context.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

function createState(agentName: string = "AgentA"): MessengerState {
  return { agentName } as MessengerState;
}

describe("crew/question handler", () => {
  let dirs: TempCrewDirs;
  let cwd: string;
  let questionHandler: typeof import("../../crew/handlers/question.js");

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
    questionHandler = await import("../../crew/handlers/question.js");
  });

  describe("ask action", () => {
    it("creates a question entry and returns question ID", async () => {
      const response = await questionHandler.execute(
        "ask",
        {
          to: "AgentB",
          question: "What API format should I use?",
          context: "Implementing REST endpoints",
        },
        createState("AgentA"),
        createMockContext(cwd),
      );

      expect(response.details.error).toBeUndefined();
      expect(response.details.mode).toBe("question.ask");
      expect(response.details.questionId).toBeDefined();
      expect(typeof response.details.questionId).toBe("string");

      // Verify question stored in questions.json
      const questionsPath = path.join(cwd, ".pi", "messenger", "crew", "questions.json");
      expect(fs.existsSync(questionsPath)).toBe(true);
      const questions = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
      expect(questions).toHaveLength(1);
      expect(questions[0].from).toBe("AgentA");
      expect(questions[0].to).toBe("AgentB");
      expect(questions[0].question).toBe("What API format should I use?");
      expect(questions[0].context).toBe("Implementing REST endpoints");
      expect(questions[0].status).toBe("pending");
      expect(questions[0].answer).toBeNull();
    });

    it("requires 'to' parameter", async () => {
      const response = await questionHandler.execute(
        "ask",
        { question: "Something?" },
        createState("AgentA"),
        createMockContext(cwd),
      );

      expect(response.details.error).toBe("missing_to");
    });

    it("requires 'question' parameter", async () => {
      const response = await questionHandler.execute(
        "ask",
        { to: "AgentB" },
        createState("AgentA"),
        createMockContext(cwd),
      );

      expect(response.details.error).toBe("missing_question");
    });
  });

  describe("answer action", () => {
    it("updates a pending question with an answer", async () => {
      // First create a question
      const askResponse = await questionHandler.execute(
        "ask",
        { to: "AgentB", question: "What format?" },
        createState("AgentA"),
        createMockContext(cwd),
      );
      const questionId = askResponse.details.questionId as string;

      // Now answer it
      const answerResponse = await questionHandler.execute(
        "answer",
        { questionId, answer: "Use JSON" },
        createState("AgentB"),
        createMockContext(cwd),
      );

      expect(answerResponse.details.error).toBeUndefined();
      expect(answerResponse.details.mode).toBe("question.answer");

      // Verify question updated in store
      const questionsPath = path.join(cwd, ".pi", "messenger", "crew", "questions.json");
      const questions = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
      const answered = questions.find((q: any) => q.id === questionId);
      expect(answered.status).toBe("answered");
      expect(answered.answer).toBe("Use JSON");
    });

    it("returns error for non-existent question", async () => {
      const response = await questionHandler.execute(
        "answer",
        { questionId: "q-nonexistent", answer: "something" },
        createState("AgentB"),
        createMockContext(cwd),
      );

      expect(response.details.error).toBe("question_not_found");
    });

    it("requires questionId parameter", async () => {
      const response = await questionHandler.execute(
        "answer",
        { answer: "some answer" },
        createState("AgentB"),
        createMockContext(cwd),
      );

      expect(response.details.error).toBe("missing_questionId");
    });
  });

  describe("list action", () => {
    it("returns pending questions for the current agent", async () => {
      // Create questions to different agents
      await questionHandler.execute(
        "ask",
        { to: "AgentB", question: "Q1?" },
        createState("AgentA"),
        createMockContext(cwd),
      );
      await questionHandler.execute(
        "ask",
        { to: "AgentC", question: "Q2?" },
        createState("AgentA"),
        createMockContext(cwd),
      );

      // List for AgentB — should only see Q1
      const response = await questionHandler.execute(
        "list",
        {},
        createState("AgentB"),
        createMockContext(cwd),
      );

      expect(response.details.mode).toBe("question.list");
      expect(response.details.count).toBe(1);
      const pending = response.details.questions as any[];
      expect(pending).toHaveLength(1);
      expect(pending[0].question).toBe("Q1?");
    });

    it("excludes already-answered questions", async () => {
      // Create and answer a question
      const askResp = await questionHandler.execute(
        "ask",
        { to: "AgentB", question: "Q1?" },
        createState("AgentA"),
        createMockContext(cwd),
      );
      await questionHandler.execute(
        "answer",
        { questionId: askResp.details.questionId as string, answer: "done" },
        createState("AgentB"),
        createMockContext(cwd),
      );

      const response = await questionHandler.execute(
        "list",
        {},
        createState("AgentB"),
        createMockContext(cwd),
      );

      expect(response.details.count).toBe(0);
    });
  });

  describe("timeout behavior", () => {
    it("marks question as timeout after expiry", async () => {
      // Create a question
      const askResp = await questionHandler.execute(
        "ask",
        { to: "AgentB", question: "Urgent Q?" },
        createState("AgentA"),
        createMockContext(cwd),
      );
      const questionId = askResp.details.questionId as string;

      // Manually backdate the timestamp to simulate 60s+ ago
      const questionsPath = path.join(cwd, ".pi", "messenger", "crew", "questions.json");
      const questions = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
      const q = questions.find((q: any) => q.id === questionId);
      q.timestamp = new Date(Date.now() - 61_000).toISOString();
      fs.writeFileSync(questionsPath, JSON.stringify(questions, null, 2));

      // Listing should trigger timeout check and mark it
      const response = await questionHandler.execute(
        "list",
        {},
        createState("AgentB"),
        createMockContext(cwd),
      );

      // The timed-out question should not appear as pending
      expect(response.details.count).toBe(0);

      // Verify the question is marked as timeout in store
      const updatedQuestions = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
      const timedOut = updatedQuestions.find((q: any) => q.id === questionId);
      expect(timedOut.status).toBe("timeout");
    });
  });
});

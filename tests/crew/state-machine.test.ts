import { describe, expect, it } from "vitest";
import {
  validateTransition,
  enforceTransition,
  getLegalTransitions,
} from "../../crew/state-machine.js";

describe("crew/state-machine", () => {
  // =========================================================================
  // validateTransition
  // =========================================================================

  describe("validateTransition", () => {
    describe("legal transitions succeed", () => {
      const legalCases: [string, string][] = [
        ["todo", "assigned"],
        ["todo", "blocked"],
        ["assigned", "starting"],
        ["assigned", "todo"],
        ["assigned", "blocked"],
        ["starting", "in_progress"],
        ["starting", "todo"],
        ["starting", "blocked"],
        ["in_progress", "done"],
        ["in_progress", "blocked"],
        ["in_progress", "todo"],
        ["done", "todo"],
        ["blocked", "todo"],
      ];

      for (const [from, to] of legalCases) {
        it(`${from} → ${to} returns true`, () => {
          expect(validateTransition(from, to)).toBe(true);
        });
      }
    });

    describe("illegal transitions return false", () => {
      const illegalCases: [string, string][] = [
        ["todo", "in_progress"],
        ["done", "in_progress"],
        ["done", "assigned"],
        ["done", "blocked"],
        ["done", "starting"],
        ["blocked", "in_progress"],
        ["blocked", "done"],
      ];

      for (const [from, to] of illegalCases) {
        it(`${from} → ${to} returns false`, () => {
          expect(validateTransition(from, to)).toBe(false);
        });
      }
    });

    it("returns false for unknown source state", () => {
      expect(validateTransition("unknown_state", "todo")).toBe(false);
    });
  });

  // =========================================================================
  // enforceTransition
  // =========================================================================

  describe("enforceTransition", () => {
    describe("legal transitions do not throw", () => {
      it("todo → assigned succeeds", () => {
        expect(() => enforceTransition("task-1", "todo", "assigned")).not.toThrow();
      });

      it("in_progress → done succeeds", () => {
        expect(() => enforceTransition("task-2", "in_progress", "done")).not.toThrow();
      });
    });

    describe("illegal transitions throw", () => {
      it("todo → in_progress throws", () => {
        expect(() => enforceTransition("task-1", "todo", "in_progress")).toThrow(
          /Illegal state transition/
        );
      });

      it("done → in_progress throws", () => {
        expect(() => enforceTransition("task-2", "done", "in_progress")).toThrow(
          /Illegal state transition/
        );
      });

      it("done → assigned throws", () => {
        expect(() => enforceTransition("task-3", "done", "assigned")).toThrow(
          /Illegal state transition/
        );
      });

      it("error message includes task ID and states", () => {
        expect(() => enforceTransition("task-99", "todo", "in_progress")).toThrow(
          /task-99/
        );
      });

      it("error message includes legal transitions hint", () => {
        try {
          enforceTransition("task-1", "todo", "done");
          expect.fail("should have thrown");
        } catch (err: unknown) {
          const msg = (err as Error).message;
          expect(msg).toContain("assigned");
          expect(msg).toContain("blocked");
        }
      });
    });
  });

  // =========================================================================
  // Full lifecycle paths
  // =========================================================================

  describe("full lifecycle", () => {
    it("happy path: todo → assigned → starting → in_progress → done", () => {
      const steps: [string, string][] = [
        ["todo", "assigned"],
        ["assigned", "starting"],
        ["starting", "in_progress"],
        ["in_progress", "done"],
      ];

      for (const [from, to] of steps) {
        expect(() => enforceTransition("task-1", from, to)).not.toThrow();
      }
    });

    it("reset paths: in_progress → todo works", () => {
      expect(() => enforceTransition("task-1", "in_progress", "todo")).not.toThrow();
    });

    it("reset paths: blocked → todo works", () => {
      expect(() => enforceTransition("task-1", "blocked", "todo")).not.toThrow();
    });

    it("reset paths: done → todo works", () => {
      expect(() => enforceTransition("task-1", "done", "todo")).not.toThrow();
    });
  });

  // =========================================================================
  // getLegalTransitions
  // =========================================================================

  describe("getLegalTransitions", () => {
    it("todo can go to [assigned, blocked]", () => {
      expect(getLegalTransitions("todo")).toEqual(["assigned", "blocked"]);
    });

    it("assigned can go to [starting, todo, blocked]", () => {
      expect(getLegalTransitions("assigned")).toEqual(["starting", "todo", "blocked"]);
    });

    it("starting can go to [in_progress, todo, blocked]", () => {
      expect(getLegalTransitions("starting")).toEqual(["in_progress", "todo", "blocked"]);
    });

    it("in_progress can go to [done, blocked, todo]", () => {
      expect(getLegalTransitions("in_progress")).toEqual(["done", "blocked", "todo"]);
    });

    it("done can go to [todo]", () => {
      expect(getLegalTransitions("done")).toEqual(["todo"]);
    });

    it("blocked can go to [todo]", () => {
      expect(getLegalTransitions("blocked")).toEqual(["todo"]);
    });

    it("unknown state returns empty array", () => {
      expect(getLegalTransitions("nonexistent")).toEqual([]);
    });
  });
});

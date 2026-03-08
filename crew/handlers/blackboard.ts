/**
 * Crew - Blackboard Handler
 *
 * Routes blackboard.* actions to the blackboard module.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import * as blackboard from "../blackboard.js";

/**
 * Execute a blackboard operation.
 *
 * @param op - The sub-action (post, read, challenge, resolve, list)
 * @param params - CrewParams with key, value, reasoning, challenge, resolution
 * @param state - MessengerState (for agent name)
 * @param ctx - ExtensionContext (for cwd)
 */
export function execute(
  op: string,
  params: CrewParams,
  state: MessengerState,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();
  const agentName = state.agentName || "unknown";

  switch (op) {
    case "post": {
      if (!params.key) {
        return result("Error: key required for blackboard.post.", {
          mode: "blackboard.post",
          error: "missing_key",
        });
      }
      if (!params.value) {
        return result("Error: value required for blackboard.post.", {
          mode: "blackboard.post",
          error: "missing_value",
        });
      }

      const entry = blackboard.postEntry(cwd, {
        key: params.key,
        value: params.value,
        reasoning: params.reasoning ?? "",
        postedBy: agentName,
      });

      return result(
        `Posted to blackboard: "${entry.key}" = "${entry.value}"`,
        { mode: "blackboard.post", entry }
      );
    }

    case "read": {
      if (!params.key) {
        // No key → list all entries
        const entries = blackboard.listEntries(cwd);
        if (entries.length === 0) {
          return result("Blackboard is empty.", {
            mode: "blackboard.read",
            entries: [],
          });
        }
        const summary = entries
          .map((e) => `• ${e.key}: ${e.value} (by ${e.postedBy}, ${e.challenges.length} challenges)`)
          .join("\n");
        return result(`Blackboard entries:\n${summary}`, {
          mode: "blackboard.read",
          entries,
        });
      }

      const entry = blackboard.readEntry(cwd, params.key);
      if (!entry) {
        return result(`No blackboard entry found for key "${params.key}".`, {
          mode: "blackboard.read",
          error: "not_found",
          key: params.key,
        });
      }

      let text = `Blackboard "${entry.key}": ${entry.value}\nReasoning: ${entry.reasoning}\nPosted by: ${entry.postedBy}`;
      if (entry.challenges.length > 0) {
        text += `\n\nChallenges (${entry.challenges.length}):`;
        entry.challenges.forEach((c, i) => {
          text += `\n  ${i}. ${c.challengedBy}: ${c.challenge}`;
          if (c.resolution) text += ` → Resolved: ${c.resolution}`;
        });
      }

      return result(text, { mode: "blackboard.read", entry });
    }

    case "challenge": {
      if (!params.key) {
        return result("Error: key required for blackboard.challenge.", {
          mode: "blackboard.challenge",
          error: "missing_key",
        });
      }
      if (!params.challenge) {
        return result("Error: challenge required for blackboard.challenge.", {
          mode: "blackboard.challenge",
          error: "missing_challenge",
        });
      }

      const entry = blackboard.challengeEntry(
        cwd,
        params.key,
        agentName,
        params.challenge
      );
      if (!entry) {
        return result(`No blackboard entry found for key "${params.key}".`, {
          mode: "blackboard.challenge",
          error: "not_found",
          key: params.key,
        });
      }

      return result(
        `Challenge added to "${entry.key}" by ${agentName}: ${params.challenge}`,
        { mode: "blackboard.challenge", entry }
      );
    }

    case "resolve": {
      if (!params.key) {
        return result("Error: key required for blackboard.resolve.", {
          mode: "blackboard.resolve",
          error: "missing_key",
        });
      }
      if (!params.resolution) {
        return result("Error: resolution required for blackboard.resolve.", {
          mode: "blackboard.resolve",
          error: "missing_resolution",
        });
      }

      // Read entry to find the latest unresolved challenge
      const current = blackboard.readEntry(cwd, params.key);
      if (!current) {
        return result(`No blackboard entry found for key "${params.key}".`, {
          mode: "blackboard.resolve",
          error: "not_found",
          key: params.key,
        });
      }

      // Find the first unresolved challenge
      const unresolvedIdx = current.challenges.findIndex(
        (c) => !c.resolution
      );
      if (unresolvedIdx === -1) {
        return result(
          `No unresolved challenges on "${params.key}".`,
          { mode: "blackboard.resolve", error: "no_unresolved", key: params.key }
        );
      }

      const entry = blackboard.resolveChallenge(
        cwd,
        params.key,
        unresolvedIdx,
        params.resolution
      );

      return result(
        `Resolved challenge ${unresolvedIdx} on "${params.key}": ${params.resolution}`,
        { mode: "blackboard.resolve", entry }
      );
    }

    case "list": {
      const entries = blackboard.listEntries(cwd);
      if (entries.length === 0) {
        return result("Blackboard is empty.", {
          mode: "blackboard.list",
          entries: [],
        });
      }

      const summary = entries
        .map(
          (e) =>
            `• ${e.key}: ${e.value} (by ${e.postedBy}, ${e.challenges.length} challenges)`
        )
        .join("\n");

      return result(`Blackboard (${entries.length} entries):\n${summary}`, {
        mode: "blackboard.list",
        entries,
      });
    }

    default:
      return result(`Unknown blackboard operation: ${op}`, {
        mode: "blackboard",
        error: "unknown_operation",
        operation: op,
      });
  }
}

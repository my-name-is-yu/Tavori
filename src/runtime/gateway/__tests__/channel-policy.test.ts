import { describe, expect, it } from "vitest";
import { evaluateChannelAccess, resolveChannelRoute } from "../channel-policy.js";

describe("channel policy", () => {
  it("denies sender denylist before allow_all", () => {
    const decision = evaluateChannelAccess(
      { allowAll: true, deniedSenderIds: ["user-1"] },
      { platform: "discord", senderId: "user-1", conversationId: "chan-1" }
    );

    expect(decision).toMatchObject({ allowed: false, reason: "sender_denied" });
  });

  it("requires sender allowlist when allow_all is false", () => {
    const decision = evaluateChannelAccess(
      { allowedSenderIds: ["user-1"] },
      { platform: "signal", senderId: "user-2" }
    );

    expect(decision).toMatchObject({ allowed: false, reason: "sender_not_allowed" });
  });

  it("marks runtime control approval independently of routing", () => {
    const decision = evaluateChannelAccess(
      { allowAll: true, runtimeControlAllowedSenderIds: ["admin"] },
      { platform: "slack", senderId: "admin" }
    );

    expect(decision).toEqual({ allowed: true, runtimeControlApproved: true });
  });

  it("routes conversation before sender and default", () => {
    const route = resolveChannelRoute(
      {
        conversationGoalMap: { "thread-1": "goal-thread" },
        senderGoalMap: { "user-1": "goal-user" },
        defaultGoalId: "goal-default",
        identityKey: "shared",
      },
      { platform: "telegram", conversationId: "thread-1", senderId: "user-1" }
    );

    expect(route.goalId).toBe("goal-thread");
    expect(route.identityKey).toBe("shared");
    expect(route.metadata).toMatchObject({ routed_goal_id: "goal-thread" });
  });
});

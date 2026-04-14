export interface ChannelAccessDecision {
  allowed: boolean;
  reason?: string;
  runtimeControlApproved: boolean;
}

export function evaluateChannelAccess(policy: {
  allowedSenderIds?: string[];
  deniedSenderIds?: string[];
  runtimeControlAllowedSenderIds?: string[];
}, context: {
  senderId?: string;
}): ChannelAccessDecision {
  if (context.senderId && policy.deniedSenderIds?.includes(context.senderId)) {
    return { allowed: false, reason: "sender_denied", runtimeControlApproved: false };
  }
  if ((policy.allowedSenderIds?.length ?? 0) > 0 && !policy.allowedSenderIds?.includes(context.senderId ?? "")) {
    return { allowed: false, reason: "sender_not_allowed", runtimeControlApproved: false };
  }
  return {
    allowed: true,
    runtimeControlApproved: context.senderId !== undefined &&
      (policy.runtimeControlAllowedSenderIds?.includes(context.senderId) ?? false),
  };
}

export function resolveChannelRoute(policy: {
  identityKey?: string;
  senderGoalMap?: Record<string, string>;
  defaultGoalId?: string;
}, context: {
  platform: string;
  senderId?: string;
  conversationId?: string;
}): { goalId?: string; identityKey?: string; metadata: Record<string, unknown> } {
  const goalId = (context.senderId ? policy.senderGoalMap?.[context.senderId] : undefined) ?? policy.defaultGoalId;
  return {
    goalId,
    identityKey: policy.identityKey,
    metadata: {
      platform: context.platform,
      ...(context.senderId ? { sender_id: context.senderId } : {}),
      ...(context.conversationId ? { conversation_id: context.conversationId } : {}),
      ...(goalId ? { routed_goal_id: goalId } : {}),
    },
  };
}

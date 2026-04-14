export interface ChannelAccessPolicy {
  /** When true, every sender is accepted unless denylist rejects it. */
  allowAll?: boolean;
  /** Sender/user allowlist. Empty means no allowlist restriction. */
  allowedSenderIds?: string[];
  /** Sender/user denylist. Denylist wins over allowAll and allowlist. */
  deniedSenderIds?: string[];
  /** Conversation/channel allowlist. Empty means no conversation restriction. */
  allowedConversationIds?: string[];
  /** Conversation/channel denylist. Denylist wins over allowlist. */
  deniedConversationIds?: string[];
  /** Senders allowed to run runtime-control commands from this channel. */
  runtimeControlAllowedSenderIds?: string[];
}

export interface ChannelRoutingPolicy {
  defaultGoalId?: string;
  conversationGoalMap?: Record<string, string>;
  channelGoalMap?: Record<string, string>;
  senderGoalMap?: Record<string, string>;
  identityKey?: string;
}

export interface ChannelMessageContext {
  platform: string;
  senderId?: string;
  conversationId?: string;
  channelId?: string;
}

export interface ChannelAccessDecision {
  allowed: boolean;
  reason?: "sender_denied" | "sender_not_allowed" | "conversation_denied" | "conversation_not_allowed";
  runtimeControlApproved: boolean;
}

export interface ChannelRouteDecision {
  goalId?: string;
  identityKey?: string;
  metadata: Record<string, unknown>;
}

function normalizeList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function includes(values: readonly string[] | undefined, value: string | undefined): boolean {
  if (!value) return false;
  return normalizeList(values).includes(value);
}

function isRestrictedByAllowlist(values: readonly string[] | undefined): boolean {
  return normalizeList(values).length > 0;
}

export function evaluateChannelAccess(
  policy: ChannelAccessPolicy | undefined,
  context: ChannelMessageContext
): ChannelAccessDecision {
  const denySenders = policy?.deniedSenderIds;
  if (includes(denySenders, context.senderId)) {
    return { allowed: false, reason: "sender_denied", runtimeControlApproved: false };
  }

  const denyConversations = policy?.deniedConversationIds;
  if (
    includes(denyConversations, context.conversationId) ||
    includes(denyConversations, context.channelId)
  ) {
    return { allowed: false, reason: "conversation_denied", runtimeControlApproved: false };
  }

  const allowAll = policy?.allowAll ?? false;
  const allowSenders = policy?.allowedSenderIds;
  if (!allowAll && isRestrictedByAllowlist(allowSenders) && !includes(allowSenders, context.senderId)) {
    return { allowed: false, reason: "sender_not_allowed", runtimeControlApproved: false };
  }

  const allowConversations = policy?.allowedConversationIds;
  if (
    isRestrictedByAllowlist(allowConversations) &&
    !includes(allowConversations, context.conversationId) &&
    !includes(allowConversations, context.channelId)
  ) {
    return { allowed: false, reason: "conversation_not_allowed", runtimeControlApproved: false };
  }

  return {
    allowed: true,
    runtimeControlApproved: includes(policy?.runtimeControlAllowedSenderIds, context.senderId),
  };
}

export function resolveChannelRoute(
  policy: ChannelRoutingPolicy | undefined,
  context: ChannelMessageContext
): ChannelRouteDecision {
  const goalId =
    (context.conversationId ? policy?.conversationGoalMap?.[context.conversationId] : undefined) ??
    (context.channelId ? policy?.channelGoalMap?.[context.channelId] : undefined) ??
    (context.senderId ? policy?.senderGoalMap?.[context.senderId] : undefined) ??
    policy?.defaultGoalId;

  return {
    goalId,
    identityKey: policy?.identityKey,
    metadata: {
      platform: context.platform,
      ...(context.senderId ? { sender_id: context.senderId } : {}),
      ...(context.conversationId ? { conversation_id: context.conversationId } : {}),
      ...(context.channelId ? { channel_id: context.channelId } : {}),
      ...(goalId ? { routed_goal_id: goalId } : {}),
    },
  };
}

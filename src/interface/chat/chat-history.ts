// ─── ChatHistory ───
//
// Manages conversation history for a chat session.
// Persists via StateManager.writeRaw (persist-before-execute principle).

import { z } from "zod";
import type { StateManager } from "../../base/state/state-manager.js";

// ─── Schemas ───

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(), // ISO 8601
  turnIndex: z.number().int().min(0),
}).passthrough();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatSessionAgentLoopMetadataSchema = z.object({
  statePath: z.string().nullable().optional(),
  status: z.enum(["running", "completed", "failed"]).nullable().optional(),
  resumable: z.boolean().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
}).passthrough();
export type ChatSessionAgentLoopMetadata = z.infer<typeof ChatSessionAgentLoopMetadataSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(), // git root at session start
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  messages: z.array(ChatMessageSchema),
  compactionSummary: z.string().optional(),
  agentLoopStatePath: z.string().nullable().optional(),
  agentLoopStatus: z.enum(["running", "completed", "failed"]).nullable().optional(),
  agentLoopResumable: z.boolean().nullable().optional(),
  agentLoopUpdatedAt: z.string().nullable().optional(),
  agentLoop: ChatSessionAgentLoopMetadataSchema.optional(),
}).passthrough();
export type ChatSession = z.infer<typeof ChatSessionSchema>;

// ─── ChatHistory ───

export class ChatHistory {
  private readonly stateManager: StateManager;
  private readonly sessionId: string;
  private readonly session: ChatSession;

  constructor(stateManager: StateManager, sessionId: string, cwd: string, existingSession?: ChatSession) {
    this.stateManager = stateManager;
    this.sessionId = sessionId;
    if (existingSession) {
      this.session = {
        ...existingSession,
        id: existingSession.id,
        cwd: existingSession.cwd,
        updatedAt: existingSession.updatedAt ?? existingSession.createdAt,
        messages: [...existingSession.messages],
      };
    } else {
      const createdAt = new Date().toISOString();
      this.session = {
        id: sessionId,
        cwd,
        createdAt,
        updatedAt: createdAt,
        messages: [],
      };
    }
  }

  static fromSession(stateManager: StateManager, session: ChatSession): ChatHistory {
    return new ChatHistory(stateManager, session.id, session.cwd, session);
  }

  /** Append a user message and persist to disk BEFORE adapter execution. */
  async appendUserMessage(content: string): Promise<void> {
    this.session.messages.push({
      role: "user",
      content,
      timestamp: new Date().toISOString(),
      turnIndex: this.session.messages.length,
    });
    await this.persist();
  }

  /** Append an assistant message and persist it as the committed assistant turn. */
  async appendAssistantMessage(content: string): Promise<void> {
    this.session.messages.push({
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
      turnIndex: this.session.messages.length,
    });
    await this.persist();
  }

  /** Clear all messages and persist the empty state. */
  async clear(): Promise<void> {
    this.session.messages = [];
    delete this.session.compactionSummary;
    await this.persist();
  }

  /** Persist a compacted summary and keep only the latest turns in message history. */
  async compact(summary: string, keepMessageCount = 4): Promise<{ before: number; after: number }> {
    const before = this.session.messages.length;
    const keepCount = Math.max(0, keepMessageCount);
    const kept = keepCount === 0 ? [] : this.session.messages.slice(-keepCount);
    this.session.messages = kept.map((message, index) => ({
      ...message,
      turnIndex: index,
    }));
    this.session.compactionSummary = summary;
    await this.persist();
    return { before, after: this.session.messages.length };
  }

  async removeLastTurn(): Promise<number> {
    if (this.session.messages.length === 0) return 0;

    let removed = 0;
    while (this.session.messages.length > 0) {
      const message = this.session.messages.pop();
      if (!message) break;
      removed += 1;
      if (message.role === "user") break;
    }

    this.session.messages = this.session.messages.map((message, index) => ({
      ...message,
      turnIndex: index,
    }));
    await this.persist();
    return removed;
  }

  getMessages(): ChatMessage[] {
    return [...this.session.messages];
  }

  getSessionData(): ChatSession {
    return { ...this.session, messages: [...this.session.messages] };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setTitle(title: string | null): void {
    if (title && title.trim().length > 0) {
      this.session.title = title.trim();
    } else {
      delete this.session.title;
    }
  }

  setAgentLoopStatePath(statePath: string | null): void {
    if (statePath) {
      this.session.agentLoopStatePath = statePath;
    } else {
      delete this.session.agentLoopStatePath;
    }
  }

  async persist(): Promise<void> {
    this.session.updatedAt = new Date().toISOString();
    await this.stateManager.writeRaw(
      `chat/sessions/${this.sessionId}.json`,
      this.session
    );
  }
}

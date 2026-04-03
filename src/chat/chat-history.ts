// ─── ChatHistory ───
//
// Manages conversation history for a chat session.
// Persists via StateManager.writeRaw (persist-before-execute principle).

import { z } from "zod";
import type { StateManager } from "../state/state-manager.js";

// ─── Schemas ───

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(), // ISO 8601
  turnIndex: z.number().int().min(0),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(), // git root at session start
  createdAt: z.string(),
  messages: z.array(ChatMessageSchema),
  compactionSummary: z.string().optional(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

// ─── ChatHistory ───

export class ChatHistory {
  private readonly stateManager: StateManager;
  private readonly sessionId: string;
  private readonly session: ChatSession;

  constructor(stateManager: StateManager, sessionId: string, cwd: string) {
    this.stateManager = stateManager;
    this.sessionId = sessionId;
    this.session = {
      id: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      messages: [],
    };
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

  /** Append an assistant message. Fire-and-forget persistence is acceptable here. */
  appendAssistantMessage(content: string): void {
    this.session.messages.push({
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
      turnIndex: this.session.messages.length,
    });
    void this.persist();
  }

  /** Clear all messages and persist the empty state. */
  clear(): void {
    this.session.messages = [];
    void this.persist();
  }

  getMessages(): ChatMessage[] {
    return [...this.session.messages];
  }

  getSessionData(): ChatSession {
    return { ...this.session, messages: [...this.session.messages] };
  }

  async persist(): Promise<void> {
    await this.stateManager.writeRaw(
      `chat/sessions/${this.sessionId}.json`,
      this.session
    );
  }
}

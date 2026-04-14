import * as fs from "node:fs";
import * as path from "node:path";

export class HomeChatStore {
  private readonly configPath: string;
  private chatId: number | undefined;

  constructor(pluginDir: string, initialChatId?: number) {
    this.configPath = path.join(pluginDir, "config.json");
    this.chatId = initialChatId;
  }

  get(): number | undefined {
    return this.chatId;
  }

  set(chatId: number): void {
    this.chatId = chatId;

    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      current = {};
    }

    current["chat_id"] = chatId;
    fs.writeFileSync(this.configPath, JSON.stringify(current, null, 2), "utf-8");
  }
}

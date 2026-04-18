import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import type { Logger } from "../logger.js";

export class EventServerFileIngestion {
  private fileWatcher: fs.FSWatcher | null = null;
  private readonly processingFiles = new Set<string>();
  private readonly eventFileAttempts = new Map<string, number>();
  private readonly eventFileRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fileWatcherGeneration = 0;

  constructor(
    private readonly eventsDir: string,
    private readonly logger: Logger | undefined,
    private readonly eventFileMaxAttempts: number,
    private readonly eventFileRetryDelayMs: number,
    private readonly dispatchEvent: (eventData: Record<string, unknown>) => Promise<void>
  ) {}

  start(): void {
    if (this.fileWatcher) return;

    fs.mkdirSync(this.eventsDir, { recursive: true });
    const generation = ++this.fileWatcherGeneration;
    void this.rescanEventFiles(generation);

    this.fileWatcher = fs.watch(this.eventsDir, (eventType, filename) => {
      if (generation !== this.fileWatcherGeneration) return;
      if ((eventType !== "rename" && eventType !== "change") || !filename) return;
      this.queueEventFile(String(filename), 0, generation);
    });
  }

  stop(): void {
    this.fileWatcherGeneration += 1;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    for (const timer of this.eventFileRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.eventFileRetryTimers.clear();
  }

  isWatching(): boolean {
    return this.fileWatcher !== null;
  }

  private async processEventFile(filePath: string, filename: string): Promise<void> {
    let stat;
    try {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          stat = await fsp.stat(filePath);
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw err;
          lastErr = err;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      if (!stat) {
        void lastErr;
        return;
      }
    } catch {
      return;
    }
    if (!stat.isFile()) return;

    const content = await fsp.readFile(filePath, "utf-8");
    const raw = JSON.parse(content) as unknown;
    const event = PulSeedEventSchema.parse(raw);

    await this.dispatchEvent(event as Record<string, unknown>);

    const processedDir = path.join(this.eventsDir, "processed");
    await fsp.mkdir(processedDir, { recursive: true });
    await fsp.rename(filePath, path.join(processedDir, filename));
    this.eventFileAttempts.delete(filename);
  }

  private async rescanEventFiles(generation: number): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.eventsDir);
    } catch {
      return;
    }
    if (generation !== this.fileWatcherGeneration) return;
    for (const entry of entries) {
      this.queueEventFile(entry, 0, generation);
    }
  }

  private queueEventFile(filename: string, delayMs = 0, generation = this.fileWatcherGeneration): void {
    if (generation !== this.fileWatcherGeneration) return;
    if (!this.shouldProcessEventFilename(filename)) return;
    if (this.eventFileRetryTimers.has(filename)) return;
    if (delayMs <= 0 && this.processingFiles.has(filename)) return;

    const run = (): void => {
      if (generation !== this.fileWatcherGeneration) {
        this.eventFileRetryTimers.delete(filename);
        return;
      }
      this.eventFileRetryTimers.delete(filename);
      if (this.processingFiles.has(filename)) return;
      this.processingFiles.add(filename);
      const filePath = path.join(this.eventsDir, filename);
      void (async () => {
        try {
          await this.processEventFile(filePath, filename);
        } catch (err) {
          await this.handleEventFileFailure(filePath, filename, err);
        } finally {
          this.processingFiles.delete(filename);
        }
      })();
    };

    if (delayMs <= 0) {
      run();
      return;
    }

    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    this.eventFileRetryTimers.set(filename, timer);
  }

  private shouldProcessEventFilename(filename: string): boolean {
    if (path.basename(filename) !== filename) return false;
    if (!filename.endsWith(".json") || filename.endsWith(".tmp")) return false;
    return filename !== "daemon-token.json";
  }

  private async handleEventFileFailure(
    filePath: string,
    filename: string,
    err: unknown
  ): Promise<void> {
    const attempt = (this.eventFileAttempts.get(filename) ?? 0) + 1;
    this.eventFileAttempts.set(filename, attempt);
    const message = err instanceof Error ? err.message : String(err);

    if (attempt < this.eventFileMaxAttempts) {
      this.logger?.warn(
        `EventServer: failed to process event file "${filename}", retrying (${attempt}/${this.eventFileMaxAttempts}): ${message}`
      );
      this.queueEventFile(filename, this.eventFileRetryDelayMs);
      return;
    }

    this.logger?.error(
      `EventServer: failed to process event file "${filename}" after ${attempt} attempts; moving to failed/: ${message}`
    );
    this.eventFileAttempts.delete(filename);
    await this.moveFailedEventFile(filePath, filename);
  }

  private async moveFailedEventFile(filePath: string, filename: string): Promise<void> {
    try {
      const failedDir = path.join(this.eventsDir, "failed");
      await fsp.mkdir(failedDir, { recursive: true });
      let dstPath = path.join(failedDir, filename);
      try {
        await fsp.access(dstPath);
        const parsed = path.parse(filename);
        dstPath = path.join(failedDir, `${parsed.name}-${Date.now()}${parsed.ext}`);
      } catch {
        // Destination is free.
      }
      await fsp.rename(filePath, dstPath);
    } catch (moveErr) {
      this.logger?.error(
        `EventServer: failed to quarantine event file "${filename}": ${String(moveErr)}`
      );
    }
  }
}

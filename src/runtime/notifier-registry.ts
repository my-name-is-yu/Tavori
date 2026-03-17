import type { INotifier, NotificationEventType } from "../types/plugin.js";

// ─── NotifierRegistry ───

/**
 * Registry for INotifier plugin instances.
 * Stores notifiers by name and allows lookup by supported event type.
 * Thread-safety note: MVP runs single-threaded; no locking required.
 */
export class NotifierRegistry {
  private notifiers: Map<string, INotifier> = new Map();

  /**
   * Register a notifier under the given name.
   * If a notifier with the same name already exists, it is replaced.
   */
  register(name: string, notifier: INotifier): void {
    this.notifiers.set(name, notifier);
  }

  /**
   * Return all registered notifiers that support the given event type.
   * Returns an empty array when no notifiers match.
   */
  findForEvent(eventType: NotificationEventType): INotifier[] {
    return Array.from(this.notifiers.values()).filter((n) =>
      n.supports(eventType)
    );
  }

  /** Return the number of registered notifiers. */
  get size(): number {
    return this.notifiers.size;
  }

  /** Check if a notifier with the given name is registered. */
  has(name: string): boolean {
    return this.notifiers.has(name);
  }

  /** Return all registered notifier names. */
  names(): string[] {
    return Array.from(this.notifiers.keys());
  }
}

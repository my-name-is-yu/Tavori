// ─── ToolsetLock ───
//
// Snapshots a set of tools at strategy activation and validates that the
// set has not changed during execution. Supports the toolset immutability
// constraint: once a session starts with a tool snapshot, that snapshot
// cannot change mid-session (preserves prompt cache integrity).

export class ToolsetLock {
  private readonly _snapshot: readonly string[];
  private _locked: boolean;

  constructor(tools: string[]) {
    this._snapshot = Object.freeze([...tools].sort());
    this._locked = false;
  }

  lock(): void {
    this._locked = true;
  }

  get locked(): boolean {
    return this._locked;
  }

  get tools(): readonly string[] {
    return this._snapshot;
  }

  /**
   * Validate that currentTools matches the snapshot.
   * If not locked, always returns valid (no constraint enforced yet).
   */
  validate(currentTools: string[]): { valid: boolean; added: string[]; removed: string[] } {
    if (!this._locked) {
      return { valid: true, added: [], removed: [] };
    }
    const current = [...currentTools].sort();
    const added = current.filter((t) => !this._snapshot.includes(t));
    const removed = this._snapshot.filter((t) => !current.includes(t));
    return { valid: added.length === 0 && removed.length === 0, added, removed };
  }

  toJSON(): { tools: string[]; locked: boolean } {
    return { tools: [...this._snapshot], locked: this._locked };
  }

  static fromJSON(data: { tools: string[]; locked: boolean }): ToolsetLock {
    const lock = new ToolsetLock(data.tools);
    if (data.locked) lock.lock();
    return lock;
  }
}

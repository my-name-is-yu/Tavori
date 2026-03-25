// ─── ToolsetLock ───
//
// Snapshots a set of tools at strategy activation and validates that the
// set has not changed during execution. Supports the toolset immutability
// constraint: once a session starts with a tool snapshot, that snapshot
// cannot change mid-session (preserves prompt cache integrity).

export class ToolsetLock {
  private readonly _snapshot: readonly string[];
  private readonly _snapshotSet: ReadonlySet<string>;
  private _locked: boolean;

  constructor(tools: string[]) {
    this._snapshot = Object.freeze([...tools].sort());
    this._snapshotSet = new Set(this._snapshot);
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
    const currentSet = new Set(current);
    const added = current.filter((t) => !this._snapshotSet.has(t));
    const removed = this._snapshot.filter((t) => !currentSet.has(t));
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

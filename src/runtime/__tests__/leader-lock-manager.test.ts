import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { LeaderLockManager } from "../leader-lock-manager.js";

describe("LeaderLockManager", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("acquire writes a durable record and read returns it", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    const record = await manager.acquire({ now: 1000, ownerToken: "leader-a" });

    expect(record).not.toBeNull();
    expect(record!.owner_token).toBe("leader-a");
    expect(record!.lease_until).toBe(2000);

    const loaded = await manager.read();
    expect(loaded).toEqual(record);
    expect(fs.existsSync(path.join(tmpDir, "leader", "leader.json"))).toBe(true);
  });

  it("renew extends the lease only for the current owner", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    const acquired = await manager.acquire({ now: 1000, ownerToken: "leader-a" });
    const renewed = await manager.renew("leader-a", { now: 1500, leaseMs: 2_000 });

    expect(renewed).not.toBeNull();
    expect(renewed!.owner_token).toBe(acquired!.owner_token);
    expect(renewed!.lease_until).toBe(3500);
    expect(await manager.renew("wrong-owner", { now: 1600 })).toBeNull();
  });

  it("release removes the record only for the matching owner", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    const acquired = await manager.acquire({ now: 1000, ownerToken: "leader-a" });
    expect(await manager.release("wrong-owner")).toBe(false);
    expect(await manager.read()).not.toBeNull();

    expect(await manager.release(acquired!.owner_token)).toBe(true);
    expect(await manager.read()).toBeNull();
  });

  it("acquire reclaims a stale leader lock", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    const stalePath = path.join(tmpDir, "leader", "leader.json");
    await fsp.mkdir(path.dirname(stalePath), { recursive: true });
    await fsp.writeFile(
      stalePath,
      JSON.stringify({
        owner_token: "stale-owner",
        pid: process.pid,
        acquired_at: 100,
        last_renewed_at: 100,
        lease_until: 150,
      }),
      "utf-8"
    );

    const acquired = await manager.acquire({ now: 200, ownerToken: "leader-b" });
    expect(acquired).not.toBeNull();
    expect(acquired!.owner_token).toBe("leader-b");
    expect(await manager.read()).toEqual(acquired);
  });

  it("acquire reclaims an unexpired lock when the recorded process is dead", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    const stalePath = path.join(tmpDir, "leader", "leader.json");
    await fsp.mkdir(path.dirname(stalePath), { recursive: true });
    await fsp.writeFile(
      stalePath,
      JSON.stringify({
        owner_token: "dead-owner",
        pid: 999_999_999,
        acquired_at: 100,
        last_renewed_at: 100,
        lease_until: 10_000,
      }),
      "utf-8"
    );

    const acquired = await manager.acquire({ now: 200, ownerToken: "leader-b" });
    expect(acquired).not.toBeNull();
    expect(acquired!.owner_token).toBe("leader-b");
    expect(await manager.read()).toEqual(acquired);
  });

  it("acquire keeps an unexpired lock when the recorded process is alive", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    const stalePath = path.join(tmpDir, "leader", "leader.json");
    await fsp.mkdir(path.dirname(stalePath), { recursive: true });
    await fsp.writeFile(
      stalePath,
      JSON.stringify({
        owner_token: "live-owner",
        pid: process.pid,
        acquired_at: 100,
        last_renewed_at: 100,
        lease_until: 10_000,
      }),
      "utf-8"
    );

    const acquired = await manager.acquire({ now: 200, ownerToken: "leader-b" });
    expect(acquired).toBeNull();
    expect((await manager.read())?.owner_token).toBe("live-owner");
  });

  it("reapStale removes expired lock files", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    await manager.acquire({ now: 1000, ownerToken: "leader-a" });
    expect(await manager.reapStale(1500)).toBeNull();
    expect(await manager.reapStale(2500)).not.toBeNull();
    expect(await manager.read()).toBeNull();
  });

  it("does not leave tmp files after writes", async () => {
    tmpDir = makeTempDir();
    const manager = new LeaderLockManager(tmpDir, 1_000);

    await manager.acquire({ now: 1000, ownerToken: "leader-a" });
    await manager.renew("leader-a", { now: 1100 });

    const files = fs.readdirSync(path.join(tmpDir, "leader"));
    expect(files.some((file) => file.includes(".tmp"))).toBe(false);
  });

  it("resolves a relative runtime root to an absolute path", async () => {
    tmpDir = makeTempDir();
    const relativeRoot = path.relative(process.cwd(), tmpDir);
    const manager = new LeaderLockManager(relativeRoot, 1_000);

    await manager.acquire({ now: 1000, ownerToken: "leader-a" });

    expect(fs.existsSync(path.join(tmpDir, "leader", "leader.json"))).toBe(true);
  });
});

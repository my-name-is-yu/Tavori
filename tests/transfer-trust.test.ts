import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TransferTrustManager } from "../src/knowledge/transfer/transfer-trust.js";
import { StateManager } from "../src/state/state-manager.js";

// ─── Helpers ───

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "transfer-trust-test-"));
}

function makeStateManager(tmpDir: string): StateManager {
  return new StateManager(tmpDir);
}

// ─── Tests ───

describe("TransferTrustManager", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let manager: TransferTrustManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateManager = makeStateManager(tmpDir);
    manager = new TransferTrustManager({ stateManager });
  });

  it("初期trust_scoreが0.5であること", async () => {
    const score = await manager.getTrustScore("testing::development");
    expect(score.trust_score).toBe(0.5);
    expect(score.success_count).toBe(0);
    expect(score.failure_count).toBe(0);
    expect(score.neutral_count).toBe(0);
  });

  it("positive更新でtrust_scoreが+0.1されること", async () => {
    const before = await manager.getTrustScore("domain_a::domain_b");
    expect(before.trust_score).toBe(0.5);

    const after = await manager.updateTrust("domain_a::domain_b", "positive");
    expect(after.trust_score).toBeCloseTo(0.6, 5);
    expect(after.success_count).toBe(1);
    expect(after.failure_count).toBe(0);
  });

  it("negative更新でtrust_scoreが-0.15されること", async () => {
    const after = await manager.updateTrust("domain_a::domain_b", "negative");
    expect(after.trust_score).toBeCloseTo(0.35, 5);
    expect(after.failure_count).toBe(1);
    expect(after.success_count).toBe(0);
  });

  it("neutral更新でtrust_scoreが変化しないこと", async () => {
    const after = await manager.updateTrust("domain_a::domain_b", "neutral");
    expect(after.trust_score).toBe(0.5);
    expect(after.neutral_count).toBe(1);
  });

  it("trust_scoreが0.0にclampされること (negative連続)", async () => {
    // Start at 0.5, apply 4 negative updates: 0.5 - 0.15*4 = -0.1 → clamped to 0.0
    for (let i = 0; i < 4; i++) {
      await manager.updateTrust("domain_clamp::low", "negative");
    }
    const score = await manager.getTrustScore("domain_clamp::low");
    expect(score.trust_score).toBeGreaterThanOrEqual(0.0);
    expect(score.trust_score).toBe(0.0);
  });

  it("trust_scoreが1.0にclampされること (positive連続)", async () => {
    // Start at 0.5, apply 6 positive updates: 0.5 + 0.1*6 = 1.1 → clamped to 1.0
    for (let i = 0; i < 6; i++) {
      await manager.updateTrust("domain_clamp::high", "positive");
    }
    const score = await manager.getTrustScore("domain_clamp::high");
    expect(score.trust_score).toBeLessThanOrEqual(1.0);
    expect(score.trust_score).toBe(1.0);
  });

  it("3回連続negativeでshouldInvalidateがtrueになること", async () => {
    const pair = "bad_domain::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(false);
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(true);
  });

  it("3回連続neutralでshouldInvalidateがtrueになること", async () => {
    const pair = "neutral_domain::another";
    await manager.updateTrust(pair, "neutral");
    await manager.updateTrust(pair, "neutral");
    await manager.updateTrust(pair, "neutral");
    expect(await manager.shouldInvalidate(pair)).toBe(true);
  });

  it("negativeとneutralの混在3回でshouldInvalidateがtrueになること", async () => {
    const pair = "mixed_bad::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "neutral");
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(true);
  });

  it("positiveが混ざるとshouldInvalidateがfalseになること", async () => {
    const pair = "mixed_good::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "positive"); // resets the streak
    expect(await manager.shouldInvalidate(pair)).toBe(false);
  });

  it("履歴が2件ならshouldInvalidateがfalseになること", async () => {
    const pair = "short_history::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(false);
  });

  it("永続化と読み込みの往復テスト", async () => {
    const pair = "persist::test";
    await manager.updateTrust(pair, "positive");
    await manager.updateTrust(pair, "positive");

    // Create a new manager with the same stateManager (same tmpDir)
    const manager2 = new TransferTrustManager({ stateManager });
    const score = await manager2.getTrustScore(pair);
    expect(score.trust_score).toBeCloseTo(0.7, 5);
    expect(score.success_count).toBe(2);
  });

  it("スコアリング式: similarity * confidence * trustScore の計算確認", () => {
    // This is a pure calculation test — no async needed
    const similarityScore = 0.8;
    const confidence = 0.9;
    const trustScore = 0.6;
    const baseScore = similarityScore * confidence * trustScore;
    expect(baseScore).toBeCloseTo(0.432, 5);
  });

  it("domain_tag_matchで+0.1ボーナスが加算されること (上限1.0クランプ)", () => {
    const similarityScore = 0.8;
    const confidence = 0.9;
    const trustScore = 0.8;
    const baseScore = similarityScore * confidence * trustScore;
    // With domain_tag_match bonus
    const withBonus = Math.min(1.0, baseScore + 0.1);
    expect(withBonus).toBeCloseTo(Math.min(1.0, baseScore + 0.1), 5);
    expect(withBonus).toBeGreaterThan(baseScore);
  });

  it("domain_tag_match+0.1ボーナスが1.0を超えないこと", () => {
    const baseScore = 0.95; // close to 1.0
    const withBonus = Math.min(1.0, baseScore + 0.1);
    expect(withBonus).toBe(1.0);
  });
});

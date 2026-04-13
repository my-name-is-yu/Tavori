import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { writeJsonFileAtomic } from "../../../../base/utils/json-io.js";
import type { ToolCallContext } from "../../../types.js";
import { SoilRebuildTool } from "../SoilRebuildTool.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

describe("SoilRebuildTool", () => {
  it("has write_local metadata", () => {
    const tool = new SoilRebuildTool();
    expect(tool.metadata.name).toBe("soil_rebuild");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isReadOnly).toBe(false);
  });

  it("rebuilds Soil from a baseDir", async () => {
    const baseDir = makeTempDir("soil-rebuild-tool-");
    try {
      await writeJsonFileAtomic(path.join(baseDir, "schedules.json"), []);

      const tool = new SoilRebuildTool();
      const result = await tool.call({ baseDir }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { index: { page_count: number }; projected: { system: number; identity: number } };
      expect(data.index.page_count).toBeGreaterThan(0);
      expect(data.projected.system).toBe(7);
      expect(data.projected.identity).toBe(3);
    } finally {
      cleanupTempDir(baseDir);
    }
  });
});

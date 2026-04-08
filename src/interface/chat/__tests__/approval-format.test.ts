import { describe, expect, it } from "vitest";
import { parseApprovalDecision } from "../approval-format.js";

describe("parseApprovalDecision()", () => {
  it("accepts approve aliases including Japanese responses", () => {
    expect(parseApprovalDecision("approve")).toBe("approve");
    expect(parseApprovalDecision("承認")).toBe("approve");
    expect(parseApprovalDecision("はい")).toBe("approve");
    expect(parseApprovalDecision("進めて")).toBe("approve");
    expect(parseApprovalDecision("実行して")).toBe("approve");
  });

  it("accepts reject aliases including Japanese responses", () => {
    expect(parseApprovalDecision("reject")).toBe("reject");
    expect(parseApprovalDecision("拒否")).toBe("reject");
    expect(parseApprovalDecision("いいえ")).toBe("reject");
    expect(parseApprovalDecision("やめて")).toBe("reject");
    expect(parseApprovalDecision("中止")).toBe("reject");
  });

  it("treats clarification requests as clarify", () => {
    expect(parseApprovalDecision("clarify")).toBe("clarify");
    expect(parseApprovalDecision("詳細")).toBe("clarify");
    expect(parseApprovalDecision("詳しく")).toBe("clarify");
    expect(parseApprovalDecision("なぜ")).toBe("clarify");
  });
});

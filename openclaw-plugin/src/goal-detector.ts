// ─── goal-detector.ts — detect goal-like requests from user messages ───

export interface ILLMClient {
  sendMessage(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options?: { system?: string }
  ): Promise<{ content: string }>;
}

export interface GoalDetectionResult {
  isGoal: boolean;
  description?: string;
  dimensions?: string[];
  confidence: number;
}

const NUMERIC_RE = /(\d+%|少なくとも\d+|最低\d+|\d+以上|\d+以下|100%)/;
const PERSISTENT_RE = /(カバレッジ|coverage|リファクタ|refactor|最適化|optim|migration|移行|全テスト|all tests)/i;
const NON_GOAL_RE = /^(何|なぜ|どう|explain|show me|見せて|教えて)/i;

function ruleDetect(msg: string): GoalDetectionResult | null {
  if (NON_GOAL_RE.test(msg.trim())) return { isGoal: false, confidence: 0.9 };
  if (NUMERIC_RE.test(msg)) {
    return { isGoal: true, description: msg, dimensions: ["numeric_target"], confidence: 0.9 };
  }
  if (PERSISTENT_RE.test(msg)) {
    return { isGoal: true, description: msg, dimensions: ["persistent_work"], confidence: 0.85 };
  }
  return null;
}

const SYSTEM = "You are a classifier. Respond only with valid JSON, no markdown fences.";

const buildPrompt = (msg: string) =>
  `Analyze this user message and determine if it describes a persistent goal \
(requiring multiple iterations and measurable progress) or a one-shot task.

Message: "${msg}"

Respond in JSON:
{ "isGoal": boolean, "description": "...", "dimensions": ["..."], "confidence": 0.0-1.0 }`;

async function llmDetect(msg: string, client: ILLMClient): Promise<GoalDetectionResult> {
  const res = await client.sendMessage([{ role: "user", content: buildPrompt(msg) }], { system: SYSTEM });
  const cleaned = res.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const raw = JSON.parse(cleaned) as Partial<GoalDetectionResult>;
  return {
    isGoal: raw.isGoal === true,
    description: typeof raw.description === "string" ? raw.description : undefined,
    dimensions: Array.isArray(raw.dimensions) ? raw.dimensions : undefined,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
  };
}

export async function detectGoal(message: string, llmClient: ILLMClient): Promise<GoalDetectionResult> {
  const rule = ruleDetect(message);
  if (rule !== null) return rule;
  try {
    return await llmDetect(message, llmClient);
  } catch {
    return { isGoal: false, confidence: 0 };
  }
}

/**
 * Server-side only singleton accessors for PulSeed core modules.
 * Web route handlers use this file so they do not depend on build-time `dist/`
 * artifacts.
 */
import path from 'node:path';
import { StateManager } from '../../../src/base/state/state-manager.js';
import type { ILLMClient } from '../../../src/base/llm/llm-client.js';
import { ReportingEngine } from '../../../src/reporting/reporting-engine.js';
import { KnowledgeManager } from '../../../src/platform/knowledge/knowledge-manager.js';
import { VectorIndex } from '../../../src/platform/knowledge/vector-index.js';
import { MockEmbeddingClient, OpenAIEmbeddingClient } from '../../../src/platform/knowledge/embedding-client.js';
import { LearningPipeline } from '../../../src/platform/knowledge/learning/learning-pipeline.js';
import { KnowledgeTransfer } from '../../../src/platform/knowledge/transfer/knowledge-transfer.js';
import { TransferTrustManager } from '../../../src/platform/knowledge/transfer/transfer-trust.js';
import type { SharedKnowledgeEntry } from '../../../src/platform/knowledge/types/knowledge.js';
import type {
  TransferCandidate,
  TransferEffectivenessRecord,
  TransferResult,
} from '../../../src/orchestrator/strategy/types/cross-portfolio.js';

type KnowledgeSearchHit = SharedKnowledgeEntry & { similarity: number };

type KnowledgeTransferItem = TransferCandidate & {
  result: TransferResult | null;
  effectiveness: TransferEffectivenessRecord | null;
};

type KnowledgeTransferSnapshot = {
  transfers: KnowledgeTransferItem[];
  results: TransferResult[];
  effectiveness_records: TransferEffectivenessRecord[];
};

let stateManager: InstanceType<typeof StateManager> | null = null;
let reportingEngine: InstanceType<typeof ReportingEngine> | null = null;
let embeddingClient: MockEmbeddingClient | OpenAIEmbeddingClient | null = null;
let vectorIndexPromise: Promise<VectorIndex | null> | null = null;
let knowledgeManagerPromise: Promise<KnowledgeManager> | null = null;
let knowledgeTransferPromise: Promise<KnowledgeTransfer> | null = null;

function createNoopLLMClient(): ILLMClient {
  return {
    async sendMessage() {
      return {
        content: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      };
    },
    parseJSON<T>(content: string, schema: { parse: (input: unknown) => T }): T {
      return schema.parse(JSON.parse(content) as unknown);
    },
    supportsToolCalling: () => false,
  } as ILLMClient;
}

function getEmbeddingClient(): MockEmbeddingClient | OpenAIEmbeddingClient {
  if (!embeddingClient) {
    embeddingClient = process.env.OPENAI_API_KEY
      ? new OpenAIEmbeddingClient(process.env.OPENAI_API_KEY)
      : new MockEmbeddingClient();
  }
  return embeddingClient;
}

async function getVectorIndex(): Promise<VectorIndex | null> {
  if (!vectorIndexPromise) {
    vectorIndexPromise = (async () => {
      const baseDir = getStateManager().getBaseDir();
      const indexPath = path.join(baseDir, 'memory', 'vector-index.json');
      const client = getEmbeddingClient();
      try {
        return await VectorIndex.create(indexPath, client);
      } catch {
        try {
          return new VectorIndex(indexPath, client);
        } catch {
          return null;
        }
      }
    })();
  }
  return vectorIndexPromise;
}

async function getKnowledgeManager(): Promise<KnowledgeManager> {
  if (!knowledgeManagerPromise) {
    knowledgeManagerPromise = (async () => {
      const state = getStateManager();
      const vectorIndex = await getVectorIndex();
      return new KnowledgeManager(
        state,
        createNoopLLMClient(),
        vectorIndex ?? undefined,
        getEmbeddingClient()
      );
    })();
  }
  return knowledgeManagerPromise;
}

async function getKnowledgeTransfer(): Promise<KnowledgeTransfer> {
  if (!knowledgeTransferPromise) {
    knowledgeTransferPromise = (async () => {
      const state = getStateManager();
      const vectorIndex = await getVectorIndex();
      const knowledgeManager = await getKnowledgeManager();
      const learningPipeline = new LearningPipeline(
        createNoopLLMClient(),
        vectorIndex,
        state
      );
      const transferTrust = new TransferTrustManager({ stateManager: state });
      const ethicsGate = {
        check: async () => ({
          verdict: 'pass' as const,
          reasoning: 'web knowledge listing',
          confidence: 1,
        }),
      };

      return new KnowledgeTransfer({
        llmClient: createNoopLLMClient(),
        knowledgeManager,
        vectorIndex,
        learningPipeline,
        ethicsGate: ethicsGate as never,
        stateManager: state,
        transferTrust,
      });
    })();
  }
  return knowledgeTransferPromise;
}

export function getStateManager(): InstanceType<typeof StateManager> {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}

export function getReportingEngine(): InstanceType<typeof ReportingEngine> {
  if (!reportingEngine) {
    reportingEngine = new ReportingEngine(getStateManager());
  }
  return reportingEngine;
}

export async function searchKnowledge(
  query: string,
  topK: number = 5
): Promise<KnowledgeSearchHit[]> {
  const knowledgeManager = await getKnowledgeManager();
  const results = await knowledgeManager.searchByEmbedding(query, topK);
  return results.map(({ entry, similarity }) => ({
    ...entry,
    similarity,
  }));
}

export async function listKnowledgeTransfers(): Promise<KnowledgeTransferSnapshot> {
  const knowledgeTransfer = await getKnowledgeTransfer();
  const snapshot = await knowledgeTransfer.listTransferSnapshot();
  const transfers = snapshot.transfers;
  const results = snapshot.results;
  const effectivenessRecords = snapshot.effectiveness_records;

  const resultsByCandidateId = new Map(results.map((result) => [result.candidate_id, result]));
  const effectivenessByTransferId = new Map(
    effectivenessRecords.map((record) => [record.transfer_id, record])
  );

  return {
    transfers: transfers.map((candidate) => {
      const result = resultsByCandidateId.get(candidate.candidate_id) ?? null;
      return {
        ...candidate,
        result,
        effectiveness: result
          ? effectivenessByTransferId.get(result.transfer_id) ?? null
          : null,
      };
    }),
    results,
    effectiveness_records: effectivenessRecords,
  };
}

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { IEmbeddingClient } from "./embedding-client.js";
import type { EmbeddingEntry, VectorSearchResult } from "../types/embedding.js";
import { EmbeddingEntrySchema } from "../types/embedding.js";
import { cosineSimilarity } from "./embedding-client.js";

export class VectorIndex {
  private readonly entries: Map<string, EmbeddingEntry> = new Map();

  constructor(
    private readonly indexPath: string,
    private readonly embeddingClient: IEmbeddingClient
  ) {
    // Sync loading removed. Use VectorIndex.create() for async load on construction,
    // or call _load() manually after construction.
  }

  /**
   * Factory method: constructs a VectorIndex and loads existing data from disk.
   */
  static async create(
    indexPath: string,
    embeddingClient: IEmbeddingClient
  ): Promise<VectorIndex> {
    const index = new VectorIndex(indexPath, embeddingClient);
    const fileExisted = await index._load();
    if (!fileExisted) {
      // Persist empty index on first run so the file exists for next time
      await index._save();
    }
    return index;
  }

  /**
   * Embed text and add an entry to the index.
   */
  async add(
    id: string,
    text: string,
    metadata: Record<string, unknown> = {}
  ): Promise<EmbeddingEntry> {
    const vector = await this.embeddingClient.embed(text);
    const entry: EmbeddingEntry = EmbeddingEntrySchema.parse({
      id,
      text,
      vector,
      model: "embedding",
      created_at: new Date().toISOString(),
      metadata,
    });
    this.entries.set(id, entry);
    await this._save();
    return entry;
  }

  /**
   * Embed a query string and search for the most similar entries.
   */
  async search(
    query: string,
    topK: number = 5,
    threshold: number = 0.0
  ): Promise<VectorSearchResult[]> {
    const queryVector = await this.embeddingClient.embed(query);
    return this.searchByVector(queryVector, topK, threshold);
  }

  /**
   * Search using a pre-computed vector.
   */
  searchByVector(
    queryVector: number[],
    topK: number = 5,
    threshold: number = 0.0
  ): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      const similarity = cosineSimilarity(queryVector, entry.vector);
      if (similarity >= threshold) {
        results.push({
          id: entry.id,
          text: entry.text,
          similarity,
          metadata: entry.metadata,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Remove an entry by id. Returns true if removed, false if not found.
   */
  async remove(id: string): Promise<boolean> {
    const existed = this.entries.has(id);
    if (existed) {
      this.entries.delete(id);
      await this._save();
    }
    return existed;
  }

  /**
   * Return the number of entries in the index.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Retrieve a single entry by id.
   */
  getEntry(id: string): EmbeddingEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Alias for getEntry — returns a single entry by id.
   */
  getEntryById(id: string): EmbeddingEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Embed a query string and return id + similarity + metadata only (no text).
   * Useful for Progressive Disclosure: fetch metadata first, then load full text
   * only for selected candidates.
   */
  async searchMetadata(
    query: string,
    topK: number = 20,
    threshold: number = 0.0
  ): Promise<Array<{ id: string; similarity: number; metadata: Record<string, unknown> }>> {
    const queryVector = await this.embeddingClient.embed(query);
    return this.searchMetadataByVector(queryVector, topK, threshold);
  }

  /**
   * Search using a pre-computed vector; returns id + similarity + metadata only.
   */
  searchMetadataByVector(
    queryVector: number[],
    topK: number = 20,
    threshold: number = 0.0
  ): Array<{ id: string; similarity: number; metadata: Record<string, unknown> }> {
    const results: Array<{ id: string; similarity: number; metadata: Record<string, unknown> }> = [];
    for (const entry of this.entries.values()) {
      const similarity = cosineSimilarity(queryVector, entry.vector);
      if (similarity >= threshold) {
        results.push({ id: entry.id, similarity, metadata: entry.metadata ?? {} });
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Remove all entries from the index and persist.
   */
  async clear(): Promise<void> {
    this.entries.clear();
    await this._save();
  }

  async _load(): Promise<boolean> {
    try {
      await fsp.access(this.indexPath);
    } catch {
      return false;
    }
    try {
      const raw = await fsp.readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as Array<EmbeddingEntry>;
      for (const item of parsed) {
        const entry = EmbeddingEntrySchema.parse(item);
        this.entries.set(entry.id, entry);
      }
    } catch {
      // Corrupt or empty file — start fresh
    }
    return true;
  }

  private async _save(): Promise<void> {
    const dir = path.dirname(this.indexPath);
    await fsp.mkdir(dir, { recursive: true });

    const data = JSON.stringify(Array.from(this.entries.values()), null, 2);
    const tmpPath = `${this.indexPath}.tmp`;
    await fsp.writeFile(tmpPath, data, "utf-8");
    await fsp.rename(tmpPath, this.indexPath);
  }
}

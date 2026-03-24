import { z } from "zod";

export const IterationBudgetSchema = z.object({
  total: z.number().int().positive(),
  consumed: z.number().int().min(0),
  per_node_limit: z.number().int().positive().optional(),
  warning_thresholds: z.array(z.number().min(0).max(1)).default([0.7, 0.9]),
});
export type IterationBudgetData = z.infer<typeof IterationBudgetSchema>;

export class IterationBudget {
  private _total: number;
  private _consumed: number;
  private _perNodeLimit: number | undefined;
  private _warningThresholds: number[];
  private _emittedWarnings: Set<number> = new Set();

  constructor(total: number, perNodeLimit?: number) {
    this._total = total;
    this._consumed = 0;
    this._perNodeLimit = perNodeLimit;
    this._warningThresholds = [0.7, 0.9];
  }

  get total(): number { return this._total; }
  get consumed(): number { return this._consumed; }
  get remaining(): number { return this._total - this._consumed; }
  get perNodeLimit(): number | undefined { return this._perNodeLimit; }
  get exhausted(): boolean { return this._consumed >= this._total; }
  get utilizationRatio(): number { return this._consumed / this._total; }

  consume(count: number = 1): { allowed: boolean; warnings: string[] } {
    const warnings: string[] = [];
    if (this._consumed + count > this._total) {
      return { allowed: false, warnings: [`Budget exhausted: ${this._consumed}/${this._total} iterations consumed`] };
    }
    this._consumed += count;
    if (this._emittedWarnings.size < this._warningThresholds.length) {
      for (const threshold of this._warningThresholds) {
        if (this.utilizationRatio >= threshold && !this._emittedWarnings.has(threshold)) {
          this._emittedWarnings.add(threshold);
          warnings.push(`Budget warning: ${Math.round(this.utilizationRatio * 100)}% consumed (${this._consumed}/${this._total})`);
        }
      }
    }
    return { allowed: true, warnings };
  }

  toJSON(): IterationBudgetData {
    return {
      total: this._total,
      consumed: this._consumed,
      per_node_limit: this._perNodeLimit,
      warning_thresholds: this._warningThresholds,
    };
  }

  static fromJSON(data: IterationBudgetData): IterationBudget {
    const budget = new IterationBudget(data.total, data.per_node_limit);
    budget._consumed = data.consumed;
    budget._warningThresholds = data.warning_thresholds;
    return budget;
  }
}

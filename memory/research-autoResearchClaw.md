# AutoResearchClaw — Deep Research Summary

**Source**: https://github.com/aiming-lab/AutoResearchClaw
**Researched**: 2026-03-18
**Confidence**: Confirmed (from source code + README)

---

## 1. What Is AutoResearchClaw?

AutoResearchClaw is a fully autonomous research pipeline that takes a single research idea as input and produces a conference-ready academic paper as output — with no human intervention required beyond optional approval gates.

**Tagline**: "Chat an Idea. Get a Paper. Fully Autonomous & Self-Evolving."

**Core problem it solves**: The bottleneck of translating research intuitions into validated, written, publishable results. It automates: literature discovery, hypothesis formation, experiment coding + execution, result analysis, decision-making about direction, paper writing, peer review, and citation verification.

**Scale**: 23 stages, 8 phases, Python 3.11+, 1,284 passing tests, MIT license, 5.9k+ GitHub stars.

---

## 2. Architecture: 23-Stage Pipeline in 8 Phases

### Phase A — Research Scoping (Stages 1–2)
- **Stage 1 (TOPIC_INIT)**: Parses research idea → produces `goal.md` + `hardware_profile.json`. No retries; failure here aborts everything.
- **Stage 2 (PROBLEM_DECOMPOSE)**: Hierarchical decomposition into ≥3 prioritized sub-questions → `problem_tree.md`.

### Phase B — Literature Discovery (Stages 3–6)
- **Stage 3 (SEARCH_STRATEGY)**: Formulates search queries (≤60 chars; stop words stripped for API compatibility) + identifies sources (OpenAlex, Semantic Scholar, arXiv).
- **Stage 4 (LITERATURE_COLLECT)**: Multi-source parallel collection. Fallback chain: real APIs → seminal paper injection → LLM-generated candidates → placeholder templates. Up to 2 retries.
- **Stage 5 (LITERATURE_SCREEN)**: Dual screening (relevance + quality). Human-in-the-loop gate. Rejection rolls back to Stage 4.
- **Stage 6 (KNOWLEDGE_EXTRACT)**: One structured knowledge card per shortlisted paper → `cards/` directory.

### Phase C — Knowledge Synthesis (Stages 7–8)
- **Stage 7 (SYNTHESIS)**: Aggregates cards → identifies ≥2 research gaps → `synthesis.md`.
- **Stage 8 (HYPOTHESIS_GEN)**: Multi-agent debate generates ≥2 *falsifiable* hypotheses → `hypotheses.md`. This is a rollback target for PIVOT decisions. Novelty check against collected literature (non-blocking).

### Phase D — Experiment Design (Stages 9–11)
- **Stage 9 (EXPERIMENT_DESIGN)**: Produces experiment plan with baselines, ablations, metrics. Human gate; rejection sends back to Stage 8. Zero retries.
- **Stage 10 (CODE_GENERATION)**: Hardware-aware Python code generation. Detects NVIDIA CUDA, Apple MPS, or CPU-only. Up to 5 iterative repair attempts on failures.
- **Stage 11 (RESOURCE_PLANNING)**: GPU/time estimates → `schedule.json`.

### Phase E — Experiment Execution (Stages 12–13)
- **Stage 12 (EXPERIMENT_RUN)**: Sandbox execution with real-time monitoring. Up to 2 retries.
- **Stage 13 (ITERATIVE_REFINE)**: Self-healing loop. Uses Abstract Syntax Tree validation + LLM-targeted repair. Max 10 refinement iterations. Converges or hits limit. Up to 2 retries. Rollback target for REFINE decisions.

### Phase F — Analysis & Decision (Stages 14–15)
- **Stage 14 (RESULT_ANALYSIS)**: Multi-agent result interpretation with statistical testing → `analysis.md`.
- **Stage 15 (RESEARCH_DECISION)**: Autonomous decision node (see Section 4 below).

### Phase G — Paper Writing (Stages 16–19)
- **Stage 16 (PAPER_OUTLINE)**: Section-level outline → `outline.md`.
- **Stage 17 (PAPER_DRAFT)**: Full 5,000–6,500 word draft.
- **Stage 18 (PEER_REVIEW)**: Multi-agent peer review with ≥2 perspectives, evidence consistency checking → `reviews.md`.
- **Stage 19 (PAPER_REVISION)**: Addresses review comments with tracked changes → `paper_revised.md`.

### Phase H — Finalization (Stages 20–23)
- **Stage 20 (QUALITY_GATE)**: Human approval gate with PRM scoring (see Section 4). Zero retries. Rejection rolls back to Stage 16.
- **Stage 21 (KNOWLEDGE_ARCHIVE)**: Retrospective + reproducibility bundle. Noncritical — failure here does not abort the pipeline.
- **Stage 22 (EXPORT_PUBLISH)**: LaTeX export targeting NeurIPS 2025, ICLR 2026, or ICML 2026 formats.
- **Stage 23 (CITATION_VERIFY)**: Four-layer citation integrity check (see Section 6).

---

## 3. Hypothesis Generation and Verification

### Generation (Stage 8)
- Uses **multi-agent debate**: multiple LLM roles argue different perspectives before synthesizing consensus hypotheses.
- Requires hypotheses to be explicitly **falsifiable** (the DoD spec mandates this).
- Performs **novelty check** against collected literature to prevent redundant directions (non-blocking — warns but continues).
- Prompts are adversarial: roles are designed to challenge each other before convergence.

### Verification Mechanism
Hypothesis verification is distributed across the pipeline rather than a single stage:

1. **Experimental verification (Stages 12–13)**: Code runs produce metrics that either support or undermine the hypothesis.
2. **Runtime validity checks**: The system detects NaN/Inf metrics, diverging losses (>100), and suspiciously uniform metrics (indicating placeholder/broken experiments) — these signal failed verification.
3. **Result analysis (Stage 14)**: Multi-agent interpretation of results with statistical significance tests.
4. **Decision gate (Stage 15)**: Formal PROCEED/PIVOT/REFINE judgment based on evidence sufficiency.
5. **Peer review (Stage 18)**: Evidence consistency checking — reviewers assess whether claims are supported by results.
6. **PRM gate (Stage 20)**: LLM-as-judge evaluates novelty, methodology, experimental support, and writing quality.

---

## 4. The RESEARCH_DECISION Stage — Autonomous Branching

This is the core "is the hypothesis validated?" decision point.

### Decision Outcomes
Three possible outcomes:
- **PROCEED**: Results are sufficient → advance to paper writing.
- **REFINE**: Results are weak but promising → loop back to Stage 13 (ITERATIVE_REFINE) with modified parameters. Artifacts versioned (e.g., `stage-08/` → `stage-08_v1/`) before re-running.
- **PIVOT**: Hypothesis is refuted or approach is fundamentally broken → loop back to Stage 8 (HYPOTHESIS_GEN) for new hypotheses. Maximum **2 pivot attempts** hard-coded to prevent infinite loops.

### Loop Termination Safeguards
- If both current and previous refinement cycles produce empty metrics (two consecutive failures), the system **forces progression** rather than continuing futile iterations.
- After exhausting MAX_DECISION_PIVOTS, quality is checked: if zero metrics, identical condition results (broken implementation), or analysis quality score below threshold → warnings written to log but pipeline proceeds to paper writing anyway.
- This reflects a "satisficing" philosophy: avoid perfection-chasing.

### PRM Gate (Process Reward Model)
- Applied at Stages 5, 9, 15, and 20.
- Uses **LLM-as-judge** with 3 parallel evaluators.
- Scoring: +1 (pass), -1 (fail), 0 (ambiguous). Aggregation: majority vote.
- Default temperature: 0.6. Outputs truncated to 6,000 chars before evaluation.
- If all judges fail (API error), defaults to 0.0 (neutral/ambiguous) — graceful degradation.
- Stage 15 criteria: evidence sufficiency, alternative interpretations considered, logical soundness.
- Stage 9 criteria: baselines present, ablations planned, statistics specified, reproducibility.

---

## 5. Iterative Refinement Techniques

### Self-Healing Code (Stage 13)
- Up to 10 refinement iterations per experiment run.
- Loop: run → detect failure → parse error/stderr → generate repair prompt with failure context → LLM patches code → re-run.
- Uses AST validation to catch syntax errors before execution.
- Repair budget was increased from 3 to 5 (noted in codebase as "BUG-14: more chances for critical bugs").
- Exponential backoff retry logic on persistent failures.

### Self-Healing Code Generation (Stage 10)
- 5 iterative repair attempts when generated code fails initial tests.

### Iterative Paper Improvement
`execute_iterative_pipeline()` wraps the full pipeline for multi-pass improvement:
- After initial full run (Stages 1–22), extracts quality scores.
- Conditionally reruns Stages 16–22 with review feedback injected as context.
- Termination: quality threshold met, OR convergence detection (score variance < 0.5 across recent rounds), OR max iterations.
- Logs iteration-by-iteration scores for reproducibility.

### Graceful Degradation Throughout
- Literature collection has a 4-level fallback chain ending in placeholder generation.
- Every stage has defined error codes (E01–E23) and retry budgets.
- Stage 21 (knowledge archival) is explicitly noncritical.
- JSON/YAML parsing uses multiple strategies to handle LLM output variance.

---

## 6. Evidence-Based Decision Making and Self-Correction

### Citation Integrity (Stage 23)
Four-layer verification:
1. arXiv ID validation (API lookup)
2. CrossRef/DataCite DOI confirmation
3. Semantic Scholar title matching
4. LLM-based relevance assessment

Fabricated references are removed automatically. LaTeX cite-key repair strips orphaned references. Bibliography entries deduplicated. Final compilation validated via LaTeX (with auto-fix application).

### Quality Gate (Stage 20)
Three checks:
1. NaN/Inf detection in results
2. Paper-evidence consistency validation (claims match experiment outcomes)
3. Anti-fabrication checks

Template content detection system (quality.py):
- 12 pattern types: "[INSERT...]", "TODO", "lorem ipsum", future-tense constructions ("this section will describe"), etc.
- Computes template_ratio = template chars / total chars.
- Strict threshold: default 5% max template content.
- Reports top 5 offending examples for diagnosis.

### Artifact Lineage
- `_read_prior_artifact()` queries earlier stage outputs with version sorting (supports `_v1/`, `_v2/` directories).
- All rollbacks create versioned copies before overwriting, preserving full decision history.
- Checkpoint files written atomically (temp file → rename) after each successful stage.

---

## 7. MetaClaw: Cross-Run Self-Evolution

MetaClaw is the cross-session learning system that makes the pipeline "self-evolving."

### Lesson Extraction (evolution.py)
The system monitors all `StageResult` objects at run completion and extracts lessons from:
- Stage failures
- Blocked stages
- PIVOT/REFINE decision rationale
- Runtime anomalies (NaN values, stderr warnings)
- Slow stages

Lessons are classified into 6 categories: system failures, experiment bugs, writing quality, analysis gaps, literature problems, pipeline orchestration.

### Persistence and Decay
- Stored as JSONL with metadata: stage name, severity, timestamp, description.
- **Time-decay weighting**: exponential decay with 30-day half-life, 90-day maximum age. Recent lessons dominate; stale lessons fade.

### Skill Generation (lesson_to_skill.py)
Lessons above severity threshold are passed to an LLM that generates:
- Named skills (prefixed "arc-")
- Usage description + category
- Markdown content with steps and anti-patterns

Skills are persisted as `SKILL.md` files in category-specific directories.

### Prompt Injection (evolution.py)
At stage start, `_get_evolution_overlay()` queries relevant lessons + arc-* skills and injects them as guidance text into the LLM prompt for that stage.

### MetaClaw Bridge (metaclaw_bridge/)
- `session.py`: Wraps pipeline execution; injects session headers into LLM API requests for downstream processing.
- `stage_skill_map.py`: Maps stage IDs to relevant skill categories.
- `skill_feedback.py`: Feedback loop for skill quality.
- `prm_gate.py`: PRM scoring (see Section 4).
- `lesson_to_skill.py`: Lesson → skill conversion.

### Claimed Impact
- +18.3% robustness improvement
- 24.8% reduction in retry rates
- 40% improvement in refinement cycle efficiency

---

## 8. Multi-Agent Debate Pattern

Used in three places:
1. **Stage 8 (Hypothesis Generation)**: Multiple LLM roles argue before consensus.
2. **Stage 14 (Result Analysis)**: Multi-perspective interpretation of experiment results.
3. **Stage 18 (Peer Review)**: ≥2 reviewers with distinct evaluation criteria.

The debate pattern is not just parallel calls — it uses adversarial role prompting to elicit disagreement before synthesis. This prevents single-model anchoring bias.

---

## 9. Key Patterns Relevant to Motiva

### Autonomous Loop with Bounded Retries
- PIVOT max = 2; REFINE max = (implicit, convergence-checked). Same as Motiva's satisficing design.
- Consecutive empty result detection → force progression. Motiva equivalent: stall detection → escalate.

### Evidence-Based Decision Gate
- Stage 15 is purely evidence-in → decision-out. No human involvement by default.
- Decision artifacts (decision.md) are versioned and archived — full audit trail.
- Motiva analogy: SatisficingJudge + research decision could be split like this.

### Artifact Lineage as Ground Truth
- Each stage writes named files; downstream stages pull from prior artifacts.
- Versioned rollback directories preserve history without overwriting.
- Motiva uses similar pattern: observation logs, gap history, task outputs.

### Graceful Degradation with Explicit Fallbacks
- Every stage has: primary path, fallback chain, template safety valve.
- Motiva's `--yes` flag and `observeWithLLM` fallback reflect same principle.

### LLM-as-Judge for Quality Scoring
- PRM gate is a generalized scorer, not task-specific.
- 3 parallel votes + majority consensus reduces single-LLM bias.
- Applicable to Motiva's dimension scoring or task verification.

### Lesson → Skill Injection
- MetaClaw's `_get_evolution_overlay()` injecting into prompts is very close to Motiva's KnowledgeManager injecting context into task generation.
- Key difference: MetaClaw uses time-decay weighting; Motiva's current KnowledgeManager does not (potential enhancement).

### Self-Healing with AST Validation
- Pre-execution syntax validation before sandbox run reduces wasted compute.
- Motiva's L1 mechanical verification does similar pre-flight checking.

---

## 10. Gaps and Uncertainties

- **Confirmed**: All architecture details from source code (stages.py, runner.py, contracts.py, executor.py, evolution.py, quality.py, prm_gate.py, session.py, lesson_to_skill.py).
- **Likely**: The 18.3%/24.8%/40% MetaClaw improvement figures are self-reported; no independent benchmark found.
- **Uncertain**: How domain detection accuracy affects downstream hypothesis quality — no evaluation data seen.
- **Not found**: The actual content of `feedback/FEEDBACK_ANALYSIS_PROMPT.md` (directory listed but raw content not fetched).
- **Not found**: Internal KnowledgeBase implementation (knowledge/base.py content not fetched).
- **Not found**: BenchmarkAgent and FigureAgent implementations (agents/benchmark_agent/, agents/figure_agent/).

---

## Summary Table

| Concern | AutoResearchClaw Approach |
|---------|--------------------------|
| Hypothesis generation | Multi-agent debate + novelty check, must be falsifiable |
| Hypothesis verification | Distributed: experiment execution → runtime anomaly detection → statistical analysis → PRM gate |
| Refutation handling | PIVOT → rollback to Stage 8, max 2 pivots, artifacts versioned |
| Iterative refinement | REFINE → rollback to Stage 13, convergence detection, forced progression on consecutive empty results |
| Self-correction | MetaClaw: lesson extraction → time-decay storage → skill generation → prompt injection |
| Quality scoring | LLM-as-judge PRM gate at 4 checkpoints, 3-vote majority |
| Evidence integrity | 4-layer citation verification, template content detection, paper-evidence consistency |
| Loop termination | Hard caps (MAX_DECISION_PIVOTS=2), convergence detection (variance < 0.5), consecutive-failure detection |
| Graceful degradation | Multi-level fallback chains at every stage, noncritical stage flags |

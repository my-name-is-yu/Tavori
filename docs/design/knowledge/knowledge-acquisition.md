# Knowledge Acquisition Design

> PulSeed does not start with all the knowledge needed to achieve a goal. But it can investigate, learn, and understand on its own.
> This document defines the mechanism by which PulSeed actively investigates, acquires, stores, and applies knowledge in unfamiliar domains.

> Related: `observation.md`, `task-lifecycle.md`, `execution-boundary.md`, `session-and-context.md`, `curiosity.md`, `stall-detection.md`

---

## 1. Role of Knowledge Acquisition

### Role in the Core Loop

Knowledge acquisition cuts across every step of the task discovery loop (mechanism.md §2), but it is triggered primarily at two points.

```
Observation → Gap Recognition → Strategy Selection → Task Definition → (back to Observation)
                   ↑                    ↑
         Knowledge gap detected  Knowledge gap detected
                   │                    │
                   ↓                    ↓
         Investigation task generated   Investigation task generated
```

**Trigger 1: During Gap Recognition**
When interpreting observation results, PulSeed may detect a state of "I don't know what this observed value means" or "I don't know the normal range for this dimension." This is a sign that domain knowledge needed for interpretation is lacking.

**Trigger 2: During Strategy Selection**
When generating strategies to close a Gap, PulSeed may detect "I don't know effective approaches in this area" or "I have no baseline to compare against." This is a sign that knowledge needed to form a plan is lacking.

### The Nature of Knowledge Acquisition

Knowledge acquisition is a means to achieving a goal, not an end in itself. PulSeed does not "learn for the sake of learning" — it "acquires the knowledge needed to make progress toward its goal." This distinction matters. Knowledge acquisition must always be tied to a node in the goal tree.

---

## 2. Detecting Knowledge Gaps

Knowledge gaps are detected via five types of signals. All of them arise naturally within the core loop.

### 2.1 Difficulty Interpreting Observations

```
Signal: An observation value was obtained, but it is unclear whether it is "good" or "bad"
Occurs at: Gap Recognition step
```

Example: A dog's breathing rate is observed at 28 breaths per minute. However, the normal range for this breed, age, and health condition is unknown. There is no domain knowledge to determine whether 28 is dangerous or normal.

**Detection logic**: During LLM-based Gap recognition, if it is judged that "baseline knowledge needed to evaluate this value is lacking." The result is tagged with a `knowledge_gap: true` flag and a `missing_knowledge: string` field.

### 2.2 Blocked Strategy Generation

```
Signal: The Gap is clear, but no viable strategy hypothesis can be generated
Occurs at: Strategy Selection step
```

Example: It is known that a SaaS product has a high churn rate. However, there is no domain knowledge about common churn reduction methods (cohort analysis, types of retention initiatives, industry benchmarks), making it impossible to generate specific hypotheses.

**Detection logic**: When the strategy selection LLM call returns zero hypotheses, or all hypotheses have extremely low confidence (below 0.3).

### 2.3 "Insufficient Information" Diagnosis After Stall Detection

```
Signal: After stall detection, the root cause classification returns "insufficient information"
Occurs at: stall-detection.md §3.1
```

When a stall is detected and its cause is classified as "the stall is occurring in a dimension with low observation confidence," knowledge gaps may be the underlying cause. Knowledge acquisition tasks are included in the "generate investigation and verification tasks" response described in `stall-detection.md` §3.1.

### 2.4 New Domain Detected During Goal Negotiation

```
Signal: The goal's domain is a new area not present in PulSeed's experience log
Occurs at: Goal Negotiation step (mechanism.md §3)
```

When a user sets a new goal, if its domain does not exist in the experience log, domain knowledge will be needed for dimension decomposition, baseline setting, and feasibility assessment. The "caution flag (for new domains or low evaluation confidence)" in `goal-negotiation.md` serves as the initial trigger for knowledge acquisition.

### 2.5 Missing Prerequisite Knowledge During Task Definition

```
Signal: When defining a task concretely, the prerequisite knowledge needed for execution is unclear
Occurs at: Task Definition step
```

Example: When trying to generate the task "create a care plan for a dog with respiratory disease," the task cannot be defined with clear success criteria or scope because there is no knowledge of respiratory disease staging, recommended care for each stage, or medication types and side effects.

**Detection logic**: When the task definition LLM call fails to define success criteria, or returns "unknown" for the scope boundary.

---

## 3. Generating Investigation Tasks

When a knowledge gap is detected, PulSeed generates an **investigation task** within the normal task discovery loop. Investigation tasks share the same structure as normal tasks (`task-lifecycle.md` §2), but differ in several ways.

### 3.1 Structure of an Investigation Task

```
KnowledgeAcquisitionTask extends Task {
  task_category: "knowledge_acquisition"   // Distinguishes from normal tasks
  knowledge_target: string                 // What knowledge is being sought
  knowledge_questions: string[]            // Specific questions to answer (3–5)
  knowledge_scope: string                  // Boundary on the investigation scope
  expected_output_format: string           // Expected form of the deliverable
}
```

### 3.2 Differences from Normal Tasks

| Attribute | Normal Task | Investigation Task |
|-----------|-------------|-------------------|
| Purpose | Reduce the Gap | Understand the Gap |
| Success criteria | Change in the state vector | Answers to specific questions |
| State change | `current_value` changes | `confidence` / knowledge base changes |
| Reversibility | Depends on the task | Always `reversible` (information gathering is reversible) |
| Estimated duration | Depends on the task | Default investigation task threshold applies (`stall-detection.md` §2.2: 4 hours) |
| Scope | May involve changes | Limited to information gathering. No changes involved |

### 3.3 Designing Success Criteria

Success criteria for investigation tasks are defined as "answers to specific questions," not "vague understanding."

```
Bad success criteria: "Understand canine respiratory disease"
Good success criteria:
  questions:
    - "What is the normal breathing rate range for this breed?"
    - "What is the urgency classification when breathing rate exceeds the normal range?"
    - "What is the recommended initial response for each urgency level?"
  criterion:
    description: "Answers to all three questions are obtained from reliable sources"
    verification_method: "Confirm that answers include citations (literature, guidelines, etc.)"
    is_blocking: true
```

### 3.4 Scope Constraints

Investigation tasks tend to sprawl. They can expand indefinitely in the direction of "I want to investigate more." To prevent this, investigation tasks have explicit constraints.

**Limit on number of questions**: 3–5 specific questions per investigation task. If more are needed, split the task.

**Depth limit**: The purpose of investigation is "to obtain the knowledge needed to generate the next task," not "to build a comprehensive knowledge system." Exploration in directions not directly relevant to the purpose is explicitly excluded as `out_of_scope`.

**Time limit**: The `estimated_duration` for investigation tasks is set longer than for normal tasks, but there is an upper bound. Open-ended investigation is not allowed.

---

## 4. Means of Knowledge Acquisition

Execution of knowledge acquisition tasks is fully delegated to agents, in accordance with `execution-boundary.md`. PulSeed does not conduct investigations itself.

### 4.1 Delegatable Investigation Methods

| Method | Description | Example Delegate | Typical Confidence |
|--------|-------------|------------------|--------------------|
| Web search | Searching and summarizing publicly available information | External agent (with web search tool), dedicated research agent | Medium |
| Document reading | Reading existing technical documents, papers, and guidelines | Agent via LLM provider | Medium–High (depends on source) |
| Data analysis | Discovering patterns from existing data | Data analysis agent | High (depends on data quality) |
| Expert question generation | Structuring questions to ask a human expert | LLM (question generation) → Human (answering) | High |
| Benchmark research | Identifying industry standards and comparison targets | Research agent | Medium |

### 4.2 Criteria for Selecting Investigation Methods

PulSeed selects methods in the following priority order when generating investigation tasks:

```
1. Analysis of existing data (lowest cost, highest confidence)
   → Is the answer in a data source PulSeed already has access to?

2. Document reading (avoids going outside)
   → Documents provided by the user, known resources

3. Web search (broad, shallow information gathering)
   → Acquire basic domain knowledge from public information

4. Expert question generation (highest cost, but also highest confidence)
   → If unresolved by the above, structure the questions to ask a human
```

Method selection references the Capability Registry in `execution-boundary.md` §5. If no method is available, escalate to a human.

### 4.3 Incremental Knowledge Acquisition

Do not expect to obtain complete knowledge in a single investigation. Leverage the self-correcting nature of the core loop to deepen knowledge gradually.

```
Loop 1: Get basic concepts via web search
  → "Canine respiratory diseases include brachycephalic obstructive airway syndrome,
     tracheal collapse, and pneumonia"

Loop 2: More specific investigation based on the obtained classification
  → "This dog is a French Bulldog. High risk of brachycephalic obstructive airway syndrome"

Loop 3: Investigate specific care standards
  → "Breathing rate monitoring criteria for brachycephalic obstructive airway syndrome are..."
```

The investigation results from each loop refine the questions for the next. This feedback structure means that even without precise questions from the start, the necessary knowledge converges with each iteration.

---

## 5. Storing Acquired Knowledge

Acquired knowledge is integrated and stored in the three memory tiers described in `session-and-context.md` §8.

### 5.1 Mapping to the Memory Hierarchy

| Memory Tier | What Knowledge Is Stored | Lifetime |
|-------------|--------------------------|---------|
| Working memory | Excerpts of knowledge needed for the current task | Until session ends |
| Goal state | Domain knowledge related to achieving the goal | As long as the goal exists |
| Experience log | A record of "what was learned in this investigation" | As long as the PulSeed instance exists |

### 5.2 Domain Knowledge File

Domain knowledge is saved as a dedicated file, as part of the goal state.

```
~/.pulseed/goals/<goal_id>/domain_knowledge.json
```

```
DomainKnowledge {
  goal_id: string
  domain: string                          // Domain identifier (e.g., "canine_respiratory")
  entries: KnowledgeEntry[]
  last_updated: timestamp
}

KnowledgeEntry {
  entry_id: string                        // UUID
  question: string                        // The original question
  answer: string                          // The answer obtained
  sources: Source[]                       // Information sources
  confidence: number                      // 0.0–1.0
  acquired_at: timestamp                  // When the knowledge was acquired
  acquisition_task_id: string             // ID of the investigation task that acquired it
  superseded_by: string | null            // Set if overwritten by a newer entry
  tags: string[]                          // Search tags (e.g., ["breathing_rate", "normal_range", "french_bulldog"])
}

Source {
  type: "web" | "document" | "data_analysis" | "expert" | "llm_inference"
  reference: string                       // URL, document name, expert identifier, etc.
  reliability: "high" | "medium" | "low"  // Reliability of the source
}
```

### 5.3 Knowledge Reference Path

Stored knowledge is passed to sessions through the context selection algorithm (`session-and-context.md` §4).

```
During task generation:
  Context selection
    → Search for domain knowledge entries related to the target dimension
    → Extract relevant entries by matching tags with dimension_name
    → Include as priority 6 (relevant excerpts from experience log) in context
```

### 5.4 MVP vs Phase 2

| Stage | Storage Method | Search Method |
|-------|----------------|---------------|
| **MVP** | Per-goal JSON files. Keyword matching via `tags` field | Exact tag match filtering |
| **Phase 2** | Cross-goal knowledge base. Vector search via semantic embeddings | Similarity-based search. Knowledge sharing across different goals |

In the MVP, knowledge is stored and referenced independently per goal. Applying knowledge gained from Goal A to Goal B requires an explicit transfer proposal through the curiosity mechanism (`curiosity.md` §4.3 Cross-Goal Transfer). With semantic search in Phase 2, implicit knowledge sharing becomes possible.

---

## 6. Verifying Knowledge

Acquired knowledge is not trusted unconditionally. Confidence is evaluated and contradictions are detected.

### 6.1 Confidence Evaluation

The `confidence` of a knowledge entry is determined by the following factors:

| Factor | Contributes to High Confidence | Contributes to Low Confidence |
|--------|-------------------------------|-------------------------------|
| Type of source | Expert answers, peer-reviewed literature | LLM inference only, single web article |
| Number of sources | Multiple independent sources agree | Single source only |
| Freshness of information | Recent (within 1 year) | Old (5+ years ago) |
| Domain stability | Stable field (physical laws, etc.) | Rapidly changing field (tech trends, etc.) |

```
Confidence guidelines:
  Expert + multiple sources agree        → 0.85–0.95
  Peer-reviewed literature               → 0.75–0.90
  Multiple web sources agree             → 0.60–0.80
  Single web source                      → 0.40–0.60
  LLM inference only (no source)         → 0.20–0.40
```

### 6.2 Contradiction Detection

When a new knowledge entry is added, contradictions with existing entries are detected.

**Detection method**: LLM judgment is used to determine whether the `answer` of entries sharing the same `tags` are contradictory.

**Handling a detected contradiction**:

```
Contradiction detected
  │
  ├─ Confidence difference is significant (diff >= 0.2)
  │    → Adopt the higher-confidence entry
  │    → Set superseded_by on the lower-confidence entry
  │
  ├─ Confidence levels are similar (diff < 0.2)
  │    → Keep both, flag with contradiction marker
  │    → Generate an additional investigation task to resolve the contradiction
  │
  └─ Both have low confidence (both < 0.5)
       → Keep both, but neither is used as a basis for task generation
       → Treat this area as "knowledge is uncertain"
```

### 6.3 Knowledge Staleness

Domain knowledge may become stale over time. The following mechanisms address this.

**Periodic re-verification**: During goal review sessions (`observation.md` §2 Layer 2), consider re-verifying old knowledge entries (where `acquired_at` is older than a certain threshold). If re-verification is deemed necessary, a new investigation task is generated for the same question.

**Re-verification triggers**: When the time elapsed since `acquired_at` for a knowledge entry exceeds the threshold corresponding to the domain's stability.

| Domain Stability | Re-verification Guideline |
|-----------------|--------------------------|
| Stable (basic medical knowledge, etc.) | 12 months |
| Moderate (industry practices, etc.) | 6 months |
| Volatile (tech trends, etc.) | 3 months |

---

## 7. Applying Knowledge

How acquired knowledge feeds back into each step of the core loop.

### 7.1 Impact on Task Generation

Domain knowledge directly improves the quality of task definition.

```
Before knowledge acquisition:
  Task: "Monitor dog health"
  Success criteria: Unclear
  Scope: Too broad

After knowledge acquisition:
  Task: "Continuously monitor breathing rate of French Bulldog,
         and set an alert when it exceeds 30 breaths per minute"
  Success criteria: "Breathing rate sensor is running and notifications are received on threshold breach"
  Scope: Limited to breathing rate monitoring
```

By including acquired knowledge in the context during task generation, the LLM can produce more specific and verifiable tasks.

### 7.2 Impact on Strategy Selection

Domain knowledge improves the quality of strategy hypotheses.

```
Before knowledge acquisition:
  Strategy hypothesis: "Reduce churn rate" (no specifics)

After knowledge acquisition:
  Strategy hypotheses:
    1. "Improve onboarding completion rate (industry benchmark: 65%, current: 40%)"
    2. "Run NPS survey on Day 7 and intervene early with detractors"
    3. "Introduce annual contract discounts (average churn reduction for similar SaaS: 15%)"
```

### 7.3 Impact on Observation Accuracy

Domain knowledge improves the accuracy of interpreting observation results.

```
Before knowledge acquisition:
  Observed value: 28 breaths/min
  Interpretation: Unknown (knowledge gap)
  confidence: 0.30

After knowledge acquisition:
  Observed value: 28 breaths/min
  Interpretation: Within the normal resting range for brachycephalic breeds (15–30/min),
                  but close to the upper limit. Watchful monitoring recommended
  confidence: 0.80
```

### 7.4 Impact on Goal Negotiation

When setting a new goal, accumulated domain knowledge improves the accuracy of feasibility assessment.

```
First time setting a dog health goal:
  Feasibility assessment: "New domain. Evaluation confidence is low" → Caution flag

Second time setting a different dog health goal:
  Feasibility assessment: References accumulated domain knowledge,
                          enabling assessment based on specific figures
```

---

## 8. MVP vs Phase 2

### MVP

| Element | MVP Implementation |
|---------|-------------------|
| Knowledge gap detection | Add `knowledge_gap` flag to LLM judgment results. Prioritize §2.1 (interpretation difficulty) and §2.2 (strategy blockage) |
| Investigation task generation | Generated as a normal task with `task_category: "knowledge_acquisition"`. Structure follows §3.1 |
| Investigation methods | Limited to web search (via agent tools) and document reading. Expert question generation treated as escalation |
| Knowledge storage | Per-goal JSON file (`domain_knowledge.json`). Tag-based exact match search |
| Knowledge verification | Automatic confidence setting based on source type and count. Contradiction detection via simple LLM judgment |
| Knowledge application | Include relevant knowledge entries in context during task generation |
| Staleness handling | Not implemented. Relies on manual re-investigation |

### Phase 2

| Element | Phase 2 Enhancement |
|---------|---------------------|
| Knowledge storage | Cross-goal knowledge base. Vector search via semantic embeddings |
| Knowledge sharing | Automatic knowledge sharing across goals. Knowledge from Goal A automatically included in Goal B's context |
| Contradiction detection | Comprehensive contradiction detection via embedding similarity. Consistency check on the knowledge graph |
| Staleness handling | Automated re-verification schedule based on domain stability |
| Investigation methods | Dedicated research agents, structured data retrieval via external APIs |
| Knowledge structuring | Knowledge graph with relationships between concepts. Inference-based knowledge generation |

---

## Summary of Design Principles

| Principle | Specific Design Decision |
|-----------|--------------------------|
| Knowledge acquisition is part of goal pursuit | Triggered naturally within the core loop, not as a separate learning mode |
| Driven by specific questions | Success criterion is "answer these three questions," not "investigate" |
| Adhere to the delegation model | PulSeed instructs investigation. Agents execute it |
| Incremental deepening | Do not expect complete knowledge in one pass. Refine through loop iterations |
| Verify knowledge | Evaluate the confidence of acquired knowledge and detect contradictions |
| Control scope | Prevent investigation from sprawling. Limit the number and depth of questions |

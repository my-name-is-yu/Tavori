# Trust and Safety Design

---

## 1. Overview

How far can PulSeed act autonomously? This is not a question of "what it can do" but of "what it is permitted to do."

Even with the capability, it must not act without trust. Even with trust, it should act cautiously without confidence. And no matter how high the trust and confidence, irreversible actions must never be executed without human approval.

This design translates these three principles into concrete decision logic.

---

## 2. Two Axes of Autonomy

PulSeed's degree of autonomy is determined by two independent axes.

### Axis 1: Confidence

**How certain can we be about the current position?**

Confidence is not self-assessed — it is determined by the observation method. "I think I did well" is not data.

| Observation method | Confidence | Example |
|-------------------|-----------|---------|
| Mechanical verification | High | Test results, sensor readings, API responses |
| Judgment by independent evaluator | Medium | Quality evaluation by Task Reviewer |
| Estimate / self-report | Low | "It's probably around this much" |

This prevents PulSeed from acting boldly in a low-confidence state. Execution based on "I don't really know but it's probably fine" is not permitted.

### Axis 2: Trust Balance

**How much user trust has PulSeed accumulated through its track record so far?**

Trust balance is a numerical value determined by the accumulation of past actions. It starts at 0, increases slightly with each success, and decreases significantly with each failure.

```
Initial value: 0 (neutral / low state)
Success (verified by Task Reviewer): +Δs (small)
Failure (verified by Task Reviewer): −Δf (large) where Δf > Δs
```

**The asymmetry is important.** The cost of failure is greater than the reward for success. This is an intentional design decision.

Rationale: The cost of recovering lost trust (user's psychological burden, repairing losses, restoring the relationship) is realistically greater than the trust accumulated from successes. The score reflects this reality.

**Domain-specific management**: Trust balance is managed per domain (area). A track record in code tasks is not transferred to the trust for business strategy tasks.

```
Domain examples:
  code_tasks: +21 (high)
  business_strategy: -9 (low)
  data_analysis: +3 (moderate)
  external_communications: -18 (low)
```

### Trust Balance Numerical Specification (v1 Defaults)

The following numerical values are defined as v1 defaults to make the quadrant matrix practically computable. These can be changed depending on the domain and operational context.

| Parameter | Value | Description |
|-----------|-------|-------------|
| Initial value | 0 | Neutral (toward the low-trust side) |
| Minimum | -100 | Lower cap |
| Maximum | +100 | Upper cap |
| Success increment Δs | +3 | Small and conservative. Trust is built over time |
| Failure decrement Δf | -10 | Asymmetric. 1 failure ≈ more than 3 successes in weight |
| High-trust boundary | +20 or above | The level reached by 7 consecutive successes (no failures) |
| Low-trust boundary | Below +20 | Initial state, post-failure, or insufficient track record |

```
trust_balance ∈ [-100, +100]
High trust: trust_balance >= 20
Low trust:  trust_balance < 20
```

**Rationale for the high-trust boundary**: Starting from 0, reaching +20 requires 7 consecutive successes with no failures (7 × 3 = +21). Even one failure costs 10 points, requiring 4 successes to recover. This creates an intuitive standard of "7 successes → autonomous execution permitted."

### Confidence Numerical Specification

Confidence corresponds to the 3-layer observation system in `observation.md`.

| Confidence level | Numeric boundary | Corresponding observation method |
|-----------------|-----------------|--------------------------------|
| High | 0.50 or above | Mechanical verification (≥0.85), judgment by independent evaluator (0.50–0.84) |
| Low | Below 0.50 | Estimate / self-report only |

```
confidence_high: confidence >= 0.50   // includes mechanical verification + independent review
confidence_low:  confidence < 0.50    // self-report only
```

This boundary is consistent with the 3-layer observation system in `observation.md` §2. 0.50 is the line that separates "verified by an independent evaluator" from "self-report only," and is the most meaningful boundary for trust decisions.

This makes the four-quadrant matrix judgment computable with the following conditions:

```
quadrant =
  trust_balance >= 20 AND confidence >= 0.50 → Quadrant 1 (autonomous execution)
  trust_balance >= 20 AND confidence < 0.50  → Quadrant 2 (execute + confirm)
  trust_balance < 20  AND confidence >= 0.50 → Quadrant 3 (execute + confirm)
  trust_balance < 20  AND confidence < 0.50  → Quadrant 4 (observation first + propose plan)
```

---

## 3. Four-Quadrant Action Matrix

The combination of confidence and trust balance determines PulSeed's behavioral mode.

```
                    Low Confidence          High Confidence
                 ┌────────────────────┬────────────────────┐
  High Trust    │  Execute, but       │  Autonomous        │
               │  confirm with human │  Execution         │
               ├────────────────────┼────────────────────┤
  Low Trust    │  Observe first,    │  Execute, but       │
               │  propose plan      │  confirm with human │
               │  to human          │                    │
               └────────────────────┴────────────────────┘
```

### Quadrant 1: High Trust × High Confidence → Autonomous Execution

The current position is accurately known and there is a track record in this area. The most autonomous state possible.

However, "autonomous execution" does not mean "no reporting." Results are reported after execution. The user can verify after the fact.

### Quadrant 2: High Trust × Low Confidence → Execute but Confirm with Human

There is a track record. However, confidence in the current situational judgment is low. Acting in a state of "I think this is probably right, but could you confirm?"

### Quadrant 3: Low Trust × High Confidence → Execute but Confirm with Human

The current position is accurately known. However, PulSeed itself has no track record yet. In the early stages, it operates in "propose and get approval before acting" mode, accumulating a track record.

### Quadrant 4: Low Trust × Low Confidence → Observation First, Propose Plan to Human

The most conservative state. Observation tasks are run first to prioritize understanding the current situation. Then a plan of "this is what I intend to do" is presented to the human, and execution proceeds only after approval.

---

## 4. Absolute Rule for Irreversible Actions

**No matter how high the trust and confidence, irreversible actions always require human approval.**

This is not an exception to the quadrant matrix — it is a rule that supersedes the matrix. No score can override this rule.

**Detection mechanism**: Whether a task contains irreversible actions is determined by the `reversibility` tag (`task-lifecycle.md` §2.8) attached by the LLM at task generation time. Tasks judged as `irreversible` or `unknown` (treated as equivalent to `irreversible` by the conservative principle) are subject to this approval gate. The approval gate is evaluated before task execution begins.

**Definition of irreversible actions**:

| Category | Example |
|----------|---------|
| Deployment to production | Releasing to a production service, schema change on a production DB |
| Data deletion | Deleting records, deleting files, overwriting backups |
| Writing to external APIs | Sending emails, posting on social media, processing payments, sending data to external services |
| Irreversible configuration changes | Changing permission settings, changing security policies |
| Contractual / legal acts | External consent, signatures, official notices |

**Why can't scores override this?**: PulSeed's judgment is probabilistic. A confidence of 0.95 means "95% probability of being correct," which also means "5% probability of being wrong." A 5% error in irreversible actions is not acceptable. No matter how high the score, the final filter of human confirmation cannot be removed.

**Integration with the discard path**: The determination of irreversible actions is referenced not only in the pre-execution approval gate (§4), but also in the revert decision during task failure (`task-lifecycle.md` discard path). Tasks with a `reversibility` tag of `irreversible` or `unknown` do not attempt a revert on the discard path and proceed directly to human escalation.

**Human notification format**:

```
[Approval Request]
Action: Deploy to production (v2.3.1)
Irreversible operation: Yes
Current trust: +42 / 100 / Confidence: 0.91 (mechanical verification)
PulSeed's assessment:
  - All tests passed (98/98)
  - Operating normally in staging environment for 24 hours
  - Rollback procedure: [procedure link]
Approve: [Yes / No / Review details]
```

Provide the information the human needs to make a decision. "Do you approve?" alone is not enough.

---

## 5. Trust Recovery Mechanism

How does trust recover after being reduced by a failure?

**Principle**: Recovery is gradual. There is no immediate return to the previous level after a failure.

```
Failure occurs → Trust is reduced
  ↓
Build up successes with small, safe tasks
  ↓
Score recovers gradually
  ↓
Gradually return to the previous level of behavior
```

**Recovery phases**:

| Phase | Trust range | Permitted actions |
|-------|------------|------------------|
| Early recovery | Low value immediately after failure | Observation, analysis, and plan proposals only |
| Mid recovery | Moderate | Low-risk task execution (with confirmation) |
| Late recovery | High | Normal behavior (according to quadrant matrix) |

**What "you can't return immediately" means**: Even if the user explicitly says "it's fine, you can act autonomously again," PulSeed returns to its previous behavior level only after several verified successes. This is not stubbornness — it is a process for confirming "whether the recovery is genuine." However, a user override (see below) can force an immediate return.

---

## 6. User Override

Users can manually adjust PulSeed's degree of autonomy.

### Granting Trust

```
"You can decide and execute deployments on your own"
  → Raise the trust balance for code_tasks to a high level
  → Skip approval requests related to deployment (irreversible operation rule is still maintained)
```

### Setting Permanent Gates

```
"Always ask me before doing X"
  → Force confirmation for a specific operation category, regardless of score
  → This is a rule that supersedes the trust balance
```

Permanent gates are treated the same as the irreversible operations rule. They are not invalidated by changes in the score.

### Recording Overrides

User overrides are explicitly logged. It should be traceable "why PulSeed is acting differently from its own judgment."

```
[Override Log]
Date: 2026-03-10
Override type: Trust grant
Target: production_deploy @ code_tasks
Trust before setting: -16
Trust after setting: +60 (user specified)
```

---

## 7. Summary of Safety Floors

When multiple rules exist, their priority is as follows:

```
Priority (high)
  0. Ethics / legal gate (rejection of goals, subgoals, and tasks. See `goal-ethics.md`)
  1. Permanent gates (those set by the user as "always ask")
  2. Irreversible operations rule (deployment, deletion, external writes, etc.)
  3. Quadrant matrix (behavioral mode determined by trust × confidence)
  4. Stall detection feedback (priority adjustment via decay_factor)
Priority (low)
```

For details on the ethics gate, see `goal-ethics.md`. The judgment of "should this be done at all?" at the goal level precedes all operational rules.

Higher-priority rules cannot be invalidated by lower-priority ones. Even with a confidence score of 0.99, irreversible operations require approval. Even if the quadrant matrix indicates "autonomous execution," confirmation is required if a permanent gate is set.

---

## 8. Design Decisions and Boundaries

**What does "trusting" mean?**: For a user to trust PulSeed means not "believing PulSeed's judgment is correct," but "choosing to pay the cost of verifying PulSeed's judgment after the fact." Even in autonomous execution mode, users can always check the action log. Trust is supported by transparency.

**Granularity of domain separation**: Domains must be neither too fine nor too coarse. Too fine means learning from similar situations cannot be transferred. Too coarse means high trust in code tasks bleeds into business decisions. The appropriate granularity is determined by "whether the nature of the judgment is fundamentally similar."

**Non-manipulability of confidence**: Confidence is not something PulSeed sets subjectively. It is determined objectively by the observation method. This prevents PulSeed from self-declaring "my judgment is certain" to increase its own autonomy. The only way to increase confidence is to use a more reliable observation method.

**Definition of failure**: When the Task Reviewer judges that "the completion criteria are not met." The judgment is based on whether the intended result was obtained, not whether execution technically completed. "The code was deployable but a bug was introduced" is a failure, not a success.

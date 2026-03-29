# Goal Negotiation Mechanism Design

> `mechanism.md` "3. Handling Goals" defines the concept of goal negotiation. This document defines the concrete design of that negotiation mechanism — specifically how to achieve the honest assessment that "10× is difficult, but 2× is achievable."

---

## 1. The Role of Goal Negotiation

Goal negotiation is the process of not simply "accepting" a user-provided goal as-is, but rather "agreeing on it after evaluating its feasibility."

The reason negotiation is necessary is simple. If a goal is unachievable, running the loop indefinitely is pointless. Blindly complying while knowing a goal is unachievable is a breach of honesty with the user. PulSeed evaluates the feasibility of a goal, communicates problems honestly, and commits fully only to goals it has agreed upon.

Goal negotiation is not a one-time process. If new information emerges during execution, renegotiation may occur.

---

## 2. Negotiation Flow (6 Steps)

```
Step 0: Ethics and Legal Gate (see goal-ethics.md)
  ↓
Step 1: Receive goal (interpret user input)
  ↓
Step 2: Dimension decomposition probe (convert to measurable dimensions)
  ↓
Step 3: Baseline observation (establish current state)
  ↓
Step 4: Feasibility evaluation (hybrid method)
  ↓
Step 5: Response (Accept / Counter-propose / Flag-as-ambitious)
```

Step 0 (ethics and legal gate) determines whether the purpose and means of the goal are ethically and legally acceptable. See `goal-ethics.md` for details. If a rejection is issued, the flow does not proceed to Step 1 or beyond.

### Step 1: Receive Goal

Users provide goals in vague natural language. "I want to grow revenue significantly," "I want to be healthier," "I want to launch a new service."

At this stage, PulSeed does two things.

**Accepting ambiguity**: Do not demand a precise definition from the start. The purpose of negotiation is not to resolve ambiguity, but to evaluate feasibility. Evaluation can begin even with an ambiguous goal.

**Confirming scope**: Grasp the rough scope of the goal. Time horizon ("by when"), scale ("how much"), constraints ("what cannot be done"). When these are unclear, PulSeed assumes default values and proceeds, confirming later.

### Step 2: Dimension Decomposition Probe

Decompose the received goal into measurable dimensions. This decomposition is performed by an LLM.

Decomposition serves two purposes:
- Define "what to measure" for the feasibility evaluation
- Recognize that the goal has multiple independent aspects

**Example decomposition**:

```
User goal: "I want to double revenue from the new service in 3 months"

Decomposed dimensions:
  [Monthly revenue]      Current: ¥500k   → Target: ¥1M (min(1000000))
  [Active customers]     Current: 20       → Target: 40+ (min(40))
  [Customer acquisition cost] Current: unknown → Target: at or below current (max(current))
  [Churn rate]           Current: unknown → Target: 5% or below (max(0.05))
```

This decomposition is provisional. It may be revised after the baseline observation.

### Step 3: Baseline Observation

Run the first observation cycle on the decomposed dimensions. This observation establishes "where we are right now."

Information obtained from the baseline observation:
- Current value of each dimension (`current_value`)
- Observation confidence for each dimension (`confidence`)
- Dimensions that cannot be observed (no data source exists, etc.)
- Trend of change (when historical data is available)

**Interpreting observation results**: Distinguish between dimensions that could and could not be observed. Dimensions that could not be observed are recorded as "no data" and use the qualitative path (described below) in the feasibility evaluation.

### Step 4: Feasibility Evaluation (Hybrid Method)

Evaluation branches based on whether a dimension has historical data or is in a new domain.

---

## 3. Two Paths for Feasibility Evaluation

### 3.1 Quantitative Evaluation Path (with Historical Data)

**Applicable condition**: Historical data exists for the target dimension from which a rate of change can be calculated.

Quantitative evaluation consists of three checks.

#### Check 1: Rate of Change Analysis

```
Required change = |target value - current value|
Available time = goal deadline (in days)
Required rate of change = required change / available time

Observed rate of change = average daily change calculated from historical data
```

**Judgment**:

| Condition | Assessment |
|-----------|-----------|
| Required rate ≤ observed rate × 1.5 | Realistic |
| Required rate ≤ observed rate × 3.0 | Ambitious |
| Required rate > observed rate × 3.0 | Infeasible |

The coefficients 1.5 and 3.0 are default values. The Advisor can adjust them at goal setup time.

**Handling cases where rate of change cannot be calculated**: When historical data exists but there are too few data points (fewer than 3), the rate of change is unreliable. In this case, the weight of quantitative evaluation is reduced and combined with qualitative evaluation.

#### Check 2: Capability Check

Cross-reference the capabilities PulSeed can delegate (Capability Registry) with the capabilities required to achieve the goal.

```
Required capabilities = list of actions and data sources needed to achieve the goal
Available capabilities = current state of the Capability Registry

Capability gap = required capabilities - available capabilities
```

**Judgment**:

| State | Impact on assessment |
|-------|---------------------|
| Capability gap = none | No impact on assessment |
| Gap exists, can be added | Recorded as "capability addition is a prerequisite" |
| Gap exists, cannot be added | Downgrade feasibility assessment |

#### Check 3: Resource Check

Confirm whether the external resources (data sources, APIs, external services) required to achieve the goal are available.

```
Required resources = list of resources that are prerequisites for achieving the goal
Available resources = resources currently accessible

Resource gap = required resources - available resources
```

**Judgment**:

| State | Impact on assessment |
|-------|---------------------|
| Resource gap = none | No impact on assessment |
| Gap exists, can be acquired | Recorded as "resource acquisition is a prerequisite" |
| Gap exists, cannot be acquired | Downgrade feasibility assessment |

#### Overall Judgment for Quantitative Evaluation

Integrate the results of the three checks to produce a per-dimension feasibility score.

```
Dimension feasibility = the most restrictive check result

// Example: if the rate of change is "realistic" but there is an unaddressable capability gap,
// the overall judgment is "infeasible"
```

### 3.2 Qualitative Evaluation Path (New Domain)

**Applicable condition**: No data was found in the baseline observation from which to calculate a rate of change, or the goal is in a category with no historical data.

Qualitative evaluation is handled by an LLM. The LLM is given the goal structure, constraints, and domain knowledge, and evaluates the following.

**Evaluation inputs**:
- Goal definition and target dimensions
- Available capabilities and resources
- Time horizon and constraints
- Typical growth patterns in the domain (LLM's prior knowledge)

**Evaluation output**:

```
{
  "assessment": "Realistic" | "Ambitious" | "Infeasible",
  "confidence": "High" | "Medium" | "Low",
  "reasoning": "Basis for the assessment (1–3 sentences)",
  "key_assumptions": ["List of assumptions the assessment depends on"],
  "main_risks": ["List of key risk factors"]
}
```

**Conservative bias principle**: Qualitative evaluation carries high uncertainty. When uncertain, lean toward "flag-as-ambitious" rather than "accept." "Probably fine" does not become "accept." "Unclear but might be okay" becomes "flag-as-ambitious."

---

## 4. Step 5: Response (3 Types)

Based on the evaluation results, PulSeed returns one of three response types.

### Response A: Accept

**Condition**: All dimensions assess as "realistic" or "ambitious," and the key capabilities and resources are in place.

PulSeed accepts the goal as-is and begins the task discovery loop.

```
Example response:
"I've accepted the goal of doubling revenue in 3 months. Based on the current
 growth rate and available resources, it is ambitious but achievable.
 If we maintain the current monthly growth rate (+8%/month) and keep
 customer acquisition costs low, we can reach the target in 3 months.
 Starting to track."
```

### Response B: Counter-propose

**Condition**: Some dimensions received an "infeasible" assessment, but an alternative goal is judged to be achievable.

PulSeed does not reject the original goal outright, but proposes a feasible alternative.

**Structure of a counter-proposal**:
1. Assessment of the current situation (why the original goal is difficult)
2. Alternative goal proposal (specific numbers and rationale)
3. Intermediate milestones (a phased path to achievement)
4. Options if the user wants to maintain the original goal

```
Example response:
"Doubling revenue in 3 months is difficult based on the current growth rate (+8%/month).
 Here are some realistic alternatives:

 [Option 1] Double revenue in 6 months (requires acceleration to +12%/month)
 [Option 2] 1.5× revenue in 3 months (requires 2× acceleration of current growth rate)

 Intermediate milestones (for Option 1):
   After 1 month: ¥600k (+20%)
   After 3 months: ¥750k (+50%)
   After 6 months: ¥1M (+100%)

 If you maintain the original goal (2× in 3 months), tracking will continue
 but the initial confidence will be set to 'low'."
```

#### Counter-proposal Trigger Conditions

```
gap_to_time_ratio = required change / available time
feasibility_ratio = gap_to_time_ratio / observed rate of change

if feasibility_ratio > 3.0:
    → Generate a counter-proposal

Alternative target calculation:
  realistic_target = current value + (observed rate of change × available time × 1.5)
  // Realistic upper bound assuming 1.5× acceleration of the current rate of change
```

### Response C: Flag-as-ambitious

**Condition**: Evaluation confidence is low (new domain, insufficient data), or qualitative evaluation identified key risks.

PulSeed accepts the goal but makes the uncertainty and risks explicit.

```
Example response:
"This goal involves entering a new domain, so we do not have sufficient data
 to evaluate its feasibility. The goal is accepted and tracking will begin,
 but the initial confidence is set to 'low'.

 Key risks:
  - Market size may be smaller than assumed
  - Competitor landscape is not yet understood
  - Terms of service for required APIs need to be confirmed

 The first 4 weeks are set as an 'exploration phase' to prioritize
 confirming feasibility. The assessment will be updated after 4 weeks."
```

---

## 5. When the User Insists on a Difficult Goal

If the user chooses to maintain the original goal in response to a counter-proposal, PulSeed accepts that decision. However, the following are set:

```
goal.confidence = "low"           // Initial confidence set to low
goal.flag = "user-override"       // Record that the user chose to maintain the goal
goal.feasibility_note = "Estimated feasibility at time of evaluation: Infeasible"
```

The user's will is respected, but the evaluation result remains on record. Not "blindly comply," but "evaluate, record the user's choice, and then track."

---

## 6. Renegotiation Triggers

Goal negotiation does not happen only at the start. Renegotiation is triggered by the following.

### Trigger 1: After Stall Detection

When `stall-detection.md` detects a stall, if the cause of the stall is "the feasibility of the goal itself," renegotiation is initiated.

Decision flow:
```
Stall detected
  ↓
Analyze the cause of the stall
  ↓
If determined to be "inappropriate goal setting"
  ↓
Restart goal negotiation (baseline observation → evaluation → response)
```

### Trigger 2: Change in Feasibility Due to New Information

When information obtained during execution significantly changes the assumptions made in the initial evaluation.

Specific examples:
- The observed rate of change diverges greatly from the initial prediction (e.g., predicted +10%/month vs. actual +2%/month persisting for 3 months)
- A capability or resource constraint is discovered (e.g., a key API is being discontinued)
- The domain situation changes drastically (e.g., a large competitor enters the market)

```
Rate of change divergence detection condition:
  Observed rate of change < assumed rate of change at evaluation × 0.5  // dropped to below 50%
  AND that state continues for N consecutive loops (N is specified at goal setup, default 3)

When the above condition is met, initiate the renegotiation process
```

### Trigger 3: Explicit Re-evaluation Request from the User

If the user explicitly states "I'd like to revisit this goal," renegotiation is initiated immediately.

---

## 7. Relationship Between Goal Negotiation and the Goal Tree

Goal negotiation can occur at any level of the goal tree.

**Top-level goal negotiation**: Evaluate the overall feasibility of the goal. If the top-level goal is infeasible, propose an alternative top-level goal.

**Sub-goal negotiation**: After accepting the top-level goal, feasibility is evaluated individually for each sub-goal when they are defined. Even if a sub-goal is infeasible, that does not necessarily mean the top-level goal negotiation must restart. If the top-level goal can be achieved by revising the sub-goal, a counter-proposal is made at the sub-goal level.

```
Top-level goal: "Double revenue in 6 months" (accepted)
  ↓
Sub-goal A: "Triple customer count" ← Feasibility: Infeasible
  ↓
Counter-proposal for Sub-goal A: "Double customer count and increase unit price 1.5×"
  ↓
Keep the top-level goal (double revenue) intact while revising the path to achieve it
```

---

## 8. Recording and Transparency of Negotiations

All steps of the negotiation are recorded in a persistent file.

```
goal_negotiation_log:
  goal_id: "goal_001"
  timestamp: "2026-03-10T09:00:00Z"

  step2_decomposition:
    dimensions: [monthly_revenue, active_customers, churn_rate]
    method: "LLM decomposition"

  step3_baseline:
    observations:
      - dimension: monthly_revenue
        value: 500000
        confidence: 0.98
        method: "accounting DB"
      - dimension: churn_rate
        value: null
        confidence: 0.0
        method: "unobservable (no data source)"

  step4_evaluation:
    path: "hybrid"  // mix of quantitative + qualitative
    dimensions:
      - name: monthly_revenue
        path: "quantitative"
        feasibility_ratio: 2.1
        assessment: "Ambitious"
      - name: churn_rate
        path: "qualitative"
        assessment: "Unknown"
        confidence: "Low"
        reasoning: "No data source exists. Assumed risk."

  step5_response:
    type: "flag-as-ambitious"
    accepted: true
    initial_confidence: "Low"
    user_acknowledged: true
```

This record makes it possible to retroactively trace "why this goal was set with this confidence level."

---

## 9. Design Decisions and Rationale

**Why the hybrid method?**

Quantitative evaluation alone cannot assess goals in new domains where historical data does not exist. Qualitative evaluation alone unnecessarily introduces uncertainty for goals that can be expressed numerically. Combining both enables greater accuracy where data exists, while honestly expressing uncertainty where it does not.

**Why require numerical rationale for counter-proposals?**

Saying "3 months seems difficult" alone does not give the user enough to decide. The rationale "based on the current growth rate, the upper bound achievable in 3 months is X% growth" is what allows the user to choose "then let's revise the target" or "we'll do it in 3 months anyway." A counter-proposal without rationale is shifting responsibility to the user.

**Why impose a conservative bias on qualitative evaluation?**

The cost of carelessly accepting an uncertain goal is resource waste and opportunity loss. The cost of flagging an uncertain goal as ambitious is only the cost of confirming with the user. This asymmetric cost structure leads to conservative judgment when uncertain.

**Why ultimately respect the user's will?**

PulSeed is an advisor, not a decision-maker. Having communicated the evaluation honestly, the final choice is left to the user. Not "they didn't listen when I said it was difficult," but "evaluated as difficult, recorded the user's choice, and then committed fully."

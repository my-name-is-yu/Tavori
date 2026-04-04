# PulSeed --- Core Mechanism

---

## 1. What Is PulSeed?

PulSeed is a **task discovery engine**. It accepts long-term goals and keeps discovering "what should be done next."

### The Problem It Solves

"I want to double revenue." "I want to stay healthy." "I want to get a new business off the ground." Goals like these share a common difficulty: what needs to be done is not self-evident, the situation keeps changing, and reaching completion takes months to years.

Humans dealing with this kind of goal continually think every day: "What's the current situation?" "What's missing?" "What should I do next?" PulSeed performs this thinking process on your behalf.

### What It Does and Doesn't Do

PulSeed does exactly one thing: **discover the next task from the gap between the goal and reality.**

Execution is left to existing systems. If code needs to be written, an external agent. If an API needs to be called, the appropriate tool. If human judgment is needed, ask a human. If a persistent process is needed, use a daemon or cron. PulSeed is the brain that decides "what should be done" — it is not the body that "does it."

---

## 2. Core --- The Task Discovery Loop

At the center of PulSeed is a 4-step loop. This loop does not depend on the goal's domain. Whether health management, business, or education, the same structure operates. (In implementation, this expands to 6 steps: observe → gap → score → task → execute → verify. Drive scoring and execution/verification are internal steps of §2.3 and §2.4)

```
Observe → Gap Recognition → Strategy Selection → Task Concretization → (back to Observe)
```

The loop never stops. It keeps running until the goal is achieved or the user stops it. One loop cycle may take hours or days. The nature of the goal and the situation determine the rotation speed.

---

### 2.1 Observation --- Knowing the World's Current State

To discover tasks, we must first know reality. PulSeed observes the real-world state relevant to the goal.

#### What to Observe

Observation targets change by goal. IoT sensor data, business metrics, database values, API responses, file states, external service conditions. PulSeed's observation is not confined to codebases. Any information source related to the goal is a target.

#### Observation via Read-Only Tools

The highest-trust layer of observation (mechanical verification) can now be performed directly by PulSeed without launching an agent session. Read-only tools — Shell (for running commands like `npx vitest run`), Read/Glob/Grep (for inspecting files and code), HttpFetch (for checking API health), and JsonQuery (for querying configs) — let PulSeed perceive the world synchronously within the core loop. Agent sessions are still used for observations that require multi-step work or interpretation.

#### Observation Confidence

Not all observations carry the same confidence level.

| Observation Type | Confidence | Example |
|-----------------|------------|---------|
| Mechanical verification (direct tool) | Highest | Test results via Shell, file state via Read/Glob, API health via HttpFetch |
| Mechanical verification (via agent) | High | Sensor values, complex data queries |
| Independent evaluator judgment | Medium | Quality evaluation from a third-party perspective |
| Estimates and self-reports | Low | "Roughly this amount" estimates |

Low-confidence observations mean "we don't really know yet." To avoid treating what's unknown as "no problem," confidence directly affects subsequent gap recognition.

#### Observation Timing

Observation has two rhythms.

**Periodic observation**: Confirming state at regular intervals. Like a heartbeat, observing continuously as long as the goal is alive. The interval is determined by the nature of the goal. Hourly for health monitoring, daily for business metrics, weekly for long-term projects.

**Event-driven observation**: Observing immediately upon detecting a situational change. Sensor values exceeding a threshold, sharp metric fluctuations, external notifications. There's no reason to wait when a change occurs.

Combining these two, PulSeed prevents both "missed signals" and "overreaction."

---

### 2.2 Gap Recognition --- What Is Missing?

Once the observation establishes a picture of reality, the difference from the goal is examined. This difference is the gap.

#### Multi-Dimensional Gap

A goal cannot be represented by a single number. "I want to grow the business," for example, has multiple facets: revenue, customer satisfaction, team structure, technical foundation, market position. Each facet has its own goal state and current value, and each has its own gap.

```
Goal State         Current Value        Gap
Revenue: 200       Revenue: 120        → 80 (large)
Satisfaction: 90   Satisfaction: 85    → 5  (small)
Team: 10 people    Team: 6 people      → 4  (medium)
Foundation: stable Foundation: unstable → large (large)
```

By capturing gaps across multiple dimensions this way, "what is most deficient" becomes visible.

#### Weighting Gaps by Confidence

Here, the observation confidence from §2.1 comes into play. Gaps based on low-confidence observations are estimated to be larger.

The reason is simple: treating what's not well understood as "fine" is dangerous. Low-confidence dimensions are handled conservatively as "not yet confirmed = a problem may be lurking."

This weighting causes PulSeed to generate confirmation tasks with priority, rather than leaving unconfirmed areas unattended.

#### What Gaps Tell Us

A gap is not just a difference. It is a signal indicating "what is missing," "where is the weakness," and "what should be done next." Large gaps draw attention; small gaps provide reassurance. The pattern of gaps drives the next step: strategy selection.

---

### 2.3 Strategy Selection --- How to Attack?

Once gaps are understood, how to close them is determined. This is strategy selection.

#### Generating Hypotheses

For a single gap, there are multiple ways to close it. For the gap "customers are leaving," hypotheses such as "improve onboarding," "strengthen support," "revisit pricing," and "add features" are all possible.

PulSeed doesn't look for a single right answer — it generates multiple hypotheses and evaluates which are promising.

#### Three Drive Forces

Prioritization of which gap to tackle now is determined by three drive forces.

**Deadline-driven**: "What state must we be in by when." Priority is low while the deadline is far, but rises sharply as it approaches. A deadline six months away has almost no influence on today's actions, but a deadline next week takes precedence over everything.

**Dissatisfaction-driven**: "The current state is insufficient relative to the goal, so fix it." Attack the dimension with the largest gap. However, continued neglect causes habituation, and priority gradually decreases. Dimensions that were recently tried and failed also temporarily decrease in priority (to avoid hitting the same wall repeatedly).

**Opportunity-driven**: "Now is a good time to act." Opportunities don't last long. "If we fix this now, three subsequent things become easier." "This person is available right now." "This data can be captured right now." Opportunity-driven scores decay rapidly with freshness.

The combination of these three drive forces means that even for the same goal, the task that should be prioritized today differs from next week.

#### Portfolio Approach

When possible, run multiple strategies in parallel. Rather than betting everything on one hypothesis, spread the investment. Concentrate on strategies where results are visible; cut strategies where they're not.

The **PortfolioManager** implemented in Stage 9 is the concrete implementation of this approach. Each strategy is modeled as an explicit entity (`Strategy`) and managed as a state machine: `candidate → active → evaluating → suspended → completed → terminated`. Resource allocation ratios are automatically readjusted (rebalanced) based on effectiveness measurement results. See `design/execution/portfolio-management.md` for details.

#### "Waiting" as a Strategy

Measuring effectiveness immediately after taking action is sometimes premature. Accounting for the time it takes for effects to appear after an initiative is launched, "wait now and measure N days later" is also one of PulSeed's strategies. While waiting, other gaps can be tackled.

This "waiting" judgment is implemented as a formal strategy type called `WaitStrategy` and is treated as a member of the strategy portfolio managed by PortfolioManager.

#### Pivot and Continue

Measure whether the strategy is working, and switch if it isn't. However, don't judge based on short-term results alone. There's a need to distinguish between "a strategy that takes time to show effects" and "a strategy that genuinely isn't working." Set a measurement period, and pivot if the gap hasn't narrowed after that period. PortfolioManager maintains an effectiveness tracking log for each strategy and provides effectiveness measurement data to StrategyManager's pivot decisions.

---

### 2.4 Task Concretization --- The Next Move

Once the strategy is determined, convert it into executable tasks.

#### Narrowing Scope

A strategy indicates direction, but is often too large to execute all at once. PulSeed splits it into sizes that can be completed in a single execution unit.

The splitting criterion is simple: a size at which the executor (human or AI) who receives the task can begin without additional information and can determine when it's complete.

#### Defining Success Criteria

Every task must define "what constitutes completion." Not "improve" but "this metric exceeds this value." Not "research" but "obtain answers to these three questions." Vague completion criteria degrade execution quality and make verification impossible.

#### Handing Off to Execution

The concretized task is passed to the appropriate execution means. If code needs to be written, an external agent. If an API needs to be called, the appropriate tool. If human judgment is needed, confirm with a human.

PulSeed's job ends at deciding "what should be done." The execution itself is left to the most suitable means.

#### Execution Result Feedback

Task results are reflected in the next loop's observation. If a task succeeds, the gap narrows; if it fails, a different approach is tried. These results become the input of the next loop, closing the loop.

---

### 2.5 Knowledge Acquisition --- Integration into the Core Loop

While running the core loop, PulSeed may encounter a state of "I don't know what this observation value means" or "I don't know what effective approaches exist in this domain." This is not an information shortage but a **domain knowledge shortage**. PulSeed detects this state and actively generates knowledge acquisition tasks within the core loop.

#### When Knowledge Deficiencies Are Detected

Knowledge deficiency signals occur primarily at two steps.

**During gap recognition**: At the stage of interpreting observation values, the state of "the normal value for this dimension is unknown" or "I don't know what this number means" is detected. When ObservationEngine processes observation data, it detects a lack of domain knowledge needed for interpretation and emits a signal.

**During strategy selection**: At the stage of generating strategies to close the gap, the state of "effective approaches in this domain are unknown" or "there's no baseline to compare against" is detected. When StrategyManager cannot generate strategy candidates, it emits a knowledge deficiency signal.

#### Simple Codebase Research via Tools

Before delegating a knowledge acquisition task to an agent, PulSeed first attempts lightweight research using tools directly. Grep (for searching code patterns), Read (for reading specific files), and Glob (for discovering file structure) handle simple codebase questions without the overhead of an agent session. Only when the question requires reasoning, synthesis, or multi-step exploration is a full `KnowledgeAcquisitionTask` delegated to a research agent.

#### KnowledgeAcquisitionTask

When a knowledge deficiency is detected and tools alone cannot resolve it, a task with the dedicated category `task_category: "knowledge_acquisition"` is generated. This is a formal task type handled in parallel with regular goal-achievement tasks. It is delegated to a research agent, and execution results are persisted in `domain_knowledge.json`.

#### Knowledge Feedback

Acquired knowledge is immediately utilized from the next loop. By SessionManager injecting the content of `domain_knowledge.json` into subsequent loop contexts, knowledge becomes referenceable across all task types (observation, gap analysis, strategy selection, task generation). This closes the research→utilization cycle within the core loop.

See `design/knowledge/knowledge-acquisition.md` for details.

---

### Overall Loop Properties

This loop has three important properties.

**Self-correcting**: Even if one loop is imperfect, the next loop corrects it. If observation is insufficient, re-observe in the next loop. If the strategy is wrong, it switches in the next loop. The continuity of the loop running is more important than the precision of individual steps.

**Domain-agnostic**: The loop structure itself does not depend on the goal's content. Whether health management, business, or research, the structure of "observe → gap recognition → strategy selection → task concretization" is the same. What changes is only the content of each step (what to observe, what to regard as a gap).

**Pace-adaptive**: Loop rotation speed is not fixed. It rotates fast when urgency is high and slowly during stable periods. When a "wait" strategy is selected, the loop may temporarily pause. The pace naturally changes based on the nature and situation of the goal.

---

## 3. Handling Goals

### Receiving Goals

Users give goals in vague natural language. "I want to stay healthy." "I want to grow the business." "I want to solve this problem." PulSeed accepts this vagueness. It doesn't require a precise definition from the start. As the loop runs, understanding of the goal deepens.

### Goal Negotiation

Upon receiving a goal, PulSeed first evaluates feasibility in 6 steps. The honest evaluation of "10x is difficult, but 2x is achievable" comes from here. The first step (Step 0) is an ethics/legal gate that determines whether the goal's purpose and means are permissible.

**Negotiation flow:**

0. **Ethics/Legal Gate** — Determines whether the goal's purpose and means are ethically and legally permissible. If rejected, no subsequent steps are taken (see `design/goal/goal-ethics.md` for details).
1. **Goal Reception** — Interprets the vague natural-language goal. Doesn't require a precise definition from the start.
2. **Dimension Decomposition Probe** — LLM decomposes the goal into multiple measurable dimensions (e.g., revenue, customer count, churn rate).
3. **Baseline Observation** — Executes the first observation cycle to establish current values and observation confidence for each dimension.
4. **Feasibility Evaluation (hybrid method)** — Dimensions with historical data are evaluated quantitatively; new domains are evaluated qualitatively by LLM. Quantitative evaluation compares "required rate of change vs. observed rate of change" and confirms capability/resource sufficiency. Qualitative evaluation applies a conservative bias due to high uncertainty.
5. **Response** — Returns 3 types of responses based on evaluation results: acceptance (realistic) / counter-proposal (alternative target + intermediate milestones) / cautionary flag (for new domains or when evaluation confidence is low).

**When the user pushes through a difficult goal**: PulSeed accepts it. However, initial confidence is set to "low" and evaluation results are recorded. Rather than following blindly, it evaluates and then records and tracks the user's choice.

**Renegotiation**: Renegotiation occurs after stall detection, when new information during execution causes premise changes, or upon explicit user request for re-evaluation. Once a target is agreed upon, it is pursued with full effort.

See `design/goal/goal-negotiation.md` for details.

### Goal Decomposition

Large goals cannot be pursued as-is. They are decomposed into a recursive goal tree.

```
Top-level goal
  ├── Sub-goal A
  │     ├── Sub-goal A-1
  │     └── Sub-goal A-2
  ├── Sub-goal B
  └── Sub-goal C
```

Each node has its own goal state, current values, gap, and constraints. That is, the task discovery loop from §2 runs independently at each node. The state of a parent goal is determined by aggregating the states of its child goals.

The goal tree is not a static plan. It's a dynamic structure that is discovered, added to, deleted from, and restructured during execution. Don't try to plan everything from the start.

### Completion Judgment (Satisficing)

Don't aim for perfection. Judge "good enough."

Set thresholds for each dimension, and determine completion when all dimensions exceed their thresholds. However, dimensions whose thresholds are exceeded only by low-confidence observations generate verification tasks for confirmation before declaring completion.

Satisficing functions not only at the goal level but also at the task level. Rather than attacking all gaps at once, select a manageable subset and delineate "up to here for now." Iterating small is a better use of the loop's corrective power than making a perfect plan and executing all at once.

### Stall Detection

When progress stops, detect it and respond.

The detection indicators are simple: the gap hasn't narrowed after N loops. The same kind of task repeatedly fails. The estimated time is being significantly exceeded.

When a stall is detected, PulSeed responds autonomously.

- **Insufficient information** → Generate a research task to gather information
- **Wrong approach** → Pivot the strategy
- **Capability limit** → Escalate to user
- **External dependency** → Switch to another goal and wait

Not leaving stalls unaddressed is itself an important function of PulSeed.

Note that when the cause of the stall is the unrealistic nature of the goal itself or changes in premises, stall detection triggers goal renegotiation. See `design/goal/goal-negotiation.md` §6 for renegotiation details.

---

## 4. Learning

PulSeed learns from experience.

### Accumulating Experience

Every loop is recorded as a log of "observed state → chosen strategy → execution result." As this log accumulates, the pattern of "what approach worked in what situation" becomes visible.

This accumulation is implemented as a **3-layer memory model**. Working Memory (information referenced in the current loop), Short-term Memory (experience logs from the most recent loops), and Long-term Memory (patterns and knowledge retained beyond goals) operate in coordination. See `design/knowledge/memory-lifecycle.md` for details.

### Improving Discovery Accuracy

Accumulated experience improves each step of the loop.

- Observation: learning which information sources are reliable
- Gap recognition: adjusting weights for which dimensions are important
- Strategy selection: prioritizing strategies that succeeded in the past, avoiding those that failed
- Task concretization: learning appropriate scope sizes

### Meta-Iteration (Curiosity)

When all goals are satisfied, PulSeed doesn't stop — it proposes new goals. This emerges from accumulated experience. From past patterns, it notices "there's still room for improvement in this domain" or "this approach might be effective in another context" and proposes to the user.

Curiosity is always just a proposal. If the user doesn't accept it, it isn't pursued.

### Learning Pipeline

Accumulating experience (described above) alone doesn't constitute learning. A mechanism to analyze accumulated logs and feed back into each step is necessary. The learning pipeline defines the flow of "experience log → analysis → feedback → improvement."

#### Analysis Method: LLM Batch Analysis

LLM is used to analyze experience logs. Not real-time analysis, but batch processing of a bulk of logs at specific timings.

```
analyze_experience_log(goal, log_entries):
    // Extract success and failure patterns
    patterns = llm_extract_patterns(log_entries)
    // Calculate confidence for each pattern (from occurrence frequency and result consistency)
    scored_patterns = score_patterns(patterns)
    // Register high-confidence patterns as feedback
    for pattern in scored_patterns:
        if pattern.confidence >= 0.6:
            register_feedback(goal, pattern)
    // Reflect PortfolioManager's effectiveness tracking data to StrategyManager
    portfolio_insights = portfolio_manager.get_effectiveness_log(goal)
    strategy_manager.update_strategy_weights(portfolio_insights)
    // KnowledgeManager persists acquired knowledge to domain_knowledge.json
    knowledge_manager.flush_to_domain_knowledge(goal)
```

The input of analysis is triplets of "state → action → result." LLM extracts reproducible patterns from these triplets. The insight is "taking this approach in this type of situation tends to produce this kind of result." PortfolioManager's effectiveness tracking logs quantitatively reinforce this pattern extraction, and domain knowledge accumulated by KnowledgeManager is utilized as strategy selection and task generation context from subsequent loops onward.

#### Feedback Destinations

Extracted patterns are fed back into the four steps of the task discovery loop.

| Feedback Destination | Learning Content | Example |
|---------------------|-----------------|---------|
| **Observation accuracy** | Which observation means are reliable, which tend to over/underestimate | "This API metric lags reality by 30 minutes" → adjust observation timing |
| **Strategy selection** | Which strategies were effective/ineffective in which situations | "Onboarding improvement was most effective for churn reduction" → adjust strategy priority for similar situations |
| **Scope sizing** | Appropriate task sizing | "This type of task tends to take twice the estimate" → adjust task splitting granularity |
| **Task generation** | How to define success criteria, setting preconditions | "This type of task should have included ○○ as a precondition" → improve task templates |

Feedback is persisted in the `learned_patterns` section of experience logs and is included in the LLM's context at strategy selection time and task concretization time.

#### Learning Loop Frequency

The learning pipeline runs at the following timings.

| Trigger | Analysis Scope | Purpose |
|---------|---------------|---------|
| **Goal completion** | All experience logs for that goal | Extracting patterns across the entire goal. The most comprehensive learning opportunity |
| **Milestone reached** | Experience logs for the milestone period | Mid-point review. Evaluate strategy effectiveness early |
| **Stall detected** | Recent experience logs related to the stall | Identify stall cause patterns and devise countermeasures |
| **Periodic review** | Experience logs for specified period | Regular review. Detecting gradual changes |

---

## 5. Integration with Existing Systems

PulSeed is an engine that discovers "what should be done." For everything else, it uses existing systems.

### Execution

Executing tasks is not PulSeed's job. What PulSeed does is judge "what should be executed" and select "who to delegate to." Various AI agents (CLI type, API type, custom adapters), human actions. The optimal delegation target is chosen based on the nature of the goal and task. See `design/goal/execution-boundary.md` for the detailed delegation model.

### Persistent Infrastructure

For PulSeed to keep running over the long term, a persistent mechanism is needed. This is realized with existing infrastructure. Daemon processes, cron, heartbeat mechanisms. Periodically launching PulSeed's loop to perform observation and task discovery.

### Capability Management

The tools and data sources PulSeed can use are dynamically added and removed. When a user provides an API key, a new data source becomes available; when permissions are granted, new actions become possible.

Capability management is implemented as **CapabilityDetector**, which goes beyond lazy loading to perform **proactive deficiency detection**. When a required capability is unregistered at task generation time, it automatically issues an escalation to the user. This design prevents the after-the-fact failure of "tried something thinking it was possible, but didn't have permission" before task delegation.

### Communication

Reports to users, urgent notifications, approval requests. These use existing communication means such as messaging platforms and email.

### State Persistence

PulSeed's state (goal tree, observation logs, learning data) is saved in a file-based format. Transparent, human-readable, and manageable with git. Rather than a black-box database, it's kept in a format that can always be inspected.

### PulSeed's Position

```
User
  │ Provides goals
  ↓
PulSeed (task discovery engine)
  │ Discovers "what should be done next"
  ↓
Existing system group
  ├── Execution: AI agents, humans
  ├── Persistence: daemon, cron, heartbeat
  ├── Capabilities: tools, data sources, APIs
  ├── Communication: messaging, email, alerts
  └── Persistence: files, git
```

PulSeed is the brain. The body already exists. What was missing was only a mechanism to keep discovering "what should be done next" for long-term goals.

---

## 6. Execution Boundary

**PulSeed perceives the world directly through read-only tools; all mutations and multi-step work are delegated to agents.**

### What PulSeed Does Directly

PulSeed processes the following itself:

- LLM calls for goal decomposition, observation result analysis, strategy selection, and task concretization
- Read-only tool invocations: Glob, Read, Grep (file/code inspection), Shell (running read-only commands like test runs or metric checks), HttpFetch (API health checks), JsonQuery (config queries)
- Reading and writing the goal tree, observation logs, and learning data to files

### What PulSeed Delegates

Everything that mutates state or requires multi-step work is delegated.

- Code implementation, multi-step data collection, file mutations → dedicated agents
- External service integrations, write API calls → appropriate agents
- Notification and report delivery → messaging systems
- Approval for irreversible actions → humans (mandatory)

### What "PulSeed Did ○○" Means

Expressions like "PulSeed wrote the code" or "PulSeed built the system" are shorthand. More precisely, they mean "PulSeed instructed an agent to implement the code and verified the results" and "PulSeed delegated construction tasks to a group of agents and confirmed the integration." Expressions like "PulSeed checked the tests" mean "PulSeed ran `npx vitest run` via Shell tool and parsed the output directly."

See `design/goal/execution-boundary.md` for the full delegation model and shorthand mapping.

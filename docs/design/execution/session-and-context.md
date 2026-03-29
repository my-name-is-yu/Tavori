# Session and Context Management

> How PulSeed manages finite context windows while pursuing long-term goals.

---

## 1. The Core Problem

An LLM's context window is finite. Even if it reaches hundreds of thousands of tokens, that only covers "this session, right now." The goals PulSeed pursues can span months or even years.

How do we resolve this contradiction?

The answer lies in controlling session boundaries. PulSeed takes the active role of deciding when to start a session and when to end it. Rather than passively consuming context, it manages context deliberately.

---

## 2. Sessions Are Stateless Execution Units

A session is an independent execution unit that does not carry over the context of previous sessions.

Each session is launched for a single purpose: task execution, observation, or review. It receives only the information it needs from PulSeed at startup, and returns results when it finishes. It has no memory of what happened in previous sessions — and it doesn't need to.

The rationale for this design is straightforward. Knowing "what came before" can sometimes be a liability. If an execution session carries memories of past failures, those memories introduce bias into the next attempt. If an observation session knows the struggles of the execution session, it may evaluate results too generously. Ignorance is a prerequisite for independent judgment.

Continuity across sessions is maintained by PulSeed's persistent state files. The sessions themselves remember nothing. The files remember everything.

---

## 3. Determining Session Boundaries

PulSeed controls when sessions begin and end according to the following principles.

### Natural Boundaries

**Goal tree node boundaries**: Goals are decomposed hierarchically. The basic pattern is one subgoal or one task per session. When a node ends, the session ends.

**Task completion**: End the session when a task is complete. There is no "while I'm at it, one more thing." The one-session-one-task principle is enforced.

### Forced Boundaries

**Approaching context limits**: When a session's context usage nears its ceiling, PulSeed terminates the session before completion. It saves state and launches a new session to carry on. This is a preemptive termination to prevent quality degradation from context exhaustion.

**Stall detection**: If there is no progress on the same approach, PulSeed terminates the session and restarts it with a different approach. Starting from a clean state often produces better results than switching approaches mid-session.

---

## 4. Context Selection Algorithm

Even when passing "minimal context," there must be a clear basis for deciding what to include and in what order. Context selection is priority-based.

### Context Budget

Each session type has a token limit (context budget).

- Default: 50% of the model's context window
- Configurable via `context_budget_ratio` in `config.yaml`
- If the budget is exceeded, lower-priority items are excluded

### Priority-Based Inclusion Rules

Information is added in the following priority order, stopping when the budget runs out.

| Priority | Content | Condition |
|----------|---------|-----------|
| 1 | Task definition and success criteria | Always include (cannot be omitted) |
| 2 | Current state of target dimensions (from state vector) | Always include |
| 3 | Recent observation summary for target dimensions | Always include |
| 4 | Relevant constraints from the goal definition | Always include |
| 5 | Result summary from the immediately preceding session | Only for retries or continuations |
| 6 | Relevant excerpts from experience logs | Only if similar past experience exists |

Priorities 1–4 are "always include," but if they still exceed the budget, they are summarized and compressed. Priorities 5–6 are added only when budget remains.

### MVP Simplification

The following simplified rules apply for MVP:

- Priorities 1–4 are always included. Priorities 5–6 are not included.
- Budget management is approximate (character-count estimation is sufficient).
- Dynamic selection logic is not required. Per-session-type templates are enough.

### Exclusion Rules (Per Session Type)

In addition to priority rules, certain information is forcibly excluded for each session type — even when budget permits.

| Session Type | Forcibly Excluded Information |
|-------------|-------------------------------|
| Observation session | Execution session details (execution history, attempt contents) |
| Task review session | Executor's self-report, background of task generation |
| Goal review session | Individual task execution details, entire execution history |

The purpose of exclusion rules is bias prevention. Observers are better off not knowing the difficulties of execution. Reviewers are better off not hearing the executor's justifications.

---

## 5. Context Assembly Per Session Type

When launching a session, PulSeed assembles and passes the minimum context appropriate for that session type. "Minimum" is not about frugality — it is about maintaining focus. Extraneous information becomes noise and distorts judgment.

(Specific inclusion and exclusion rules follow the selection algorithm in Section 4. The details of each session type are described below.)

### Task Execution Session

Information passed:
- Goal definition (scoped to what is relevant to this task, not the whole goal)
- Task definition and success criteria
- Constraints (those applicable to this task)
- Relevant current state (the parts related to the task's preconditions)
- For retries: results of the previous attempt

Information not passed:
- The full history and background of the goal
- Information about other goals
- The strategic rationale for why this task was generated

The executor only needs to know what is necessary to complete the task. It does not need to know why the task exists.

### Observation Session

Information passed:
- Goal definition and dimension definitions (what to observe, and by what criteria)
- Observation methods (data sources, verification approaches)
- Previous observation results (for detecting changes)

Information not passed:
- Details of the immediately preceding task
- Contents of the execution session's attempts

The purpose of observation is to view the current state plainly. Knowing the history of execution biases the observation.

### Task Review Session

Information passed:
- Task definition and success criteria
- Task deliverables (access means or content)

Information not passed:
- Goal-level context (why this task exists)
- How the task was generated
- The execution session's self-report

Task review independently judges whether the deliverables satisfy the success criteria. The only subject of judgment is the deliverables.

### Goal Review Session

Information passed:
- Full goal definition
- Complete state vector and recent changes
- Achievement thresholds

Information not passed:
- Individual task execution details
- The full execution history

Goal review evaluates the current state from the perspective of the goal as a whole. Individual task details are unnecessary. Detailed information is intentionally withheld to avoid missing the forest for the trees.

---

## 6. State Handoff

Sessions are stateless, but the pursuit of goals continues. This continuity is maintained through persistent files.

```
Session A ends
    │
    ↓ Extract results
State file updated (goal state, task results, observation records)
    │
    ↓ Read out the necessary information
Session B begins (new context, only the required information)
```

Session A never passes anything directly to Session B. All information flows through the state file. This design has a secondary benefit of transparency. State files are maintained in a human-readable format, making it possible to verify at any time what PulSeed knows and what basis it is using for its decisions.

---

## 7. Context Isolation Across Multiple Goals

When PulSeed manages multiple goals simultaneously, the context of each goal is fully isolated.

- Information about Goal B is not included in Goal A's sessions
- A failure in Goal A does not affect decisions for Goal B
- Each goal has its own independent state file

This prevents context contamination. When information from an unrelated goal bleeds in, judgment becomes inconsistent. Structural isolation ensures clean, independent judgment for each goal.

When dependencies exist between goals, they are managed explicitly. If the outcome of Goal A is a precondition for Goal B, PulSeed extracts the result of Goal A and explicitly includes it as information to be passed to Goal B's sessions. There is no implicit information sharing.

---

## 8. Three Tiers of Memory

PulSeed's information is divided into three tiers. Each has a different role and a different way of being accessed from sessions.

### Working Memory

- **Physical form**: The current session's context window
- **Lifespan**: Disappears when the session ends
- **Contents**: Only what is needed for the current task
- **Access**: PulSeed assembles and passes it at session startup

The context window is a notepad. It is where you write what you need for the current task, not a place for long-term memory.

### Goal State

- **Physical form**: Persistent files such as the goal tree, state vector, and strategy records
- **Lifespan**: Persists as long as the goal exists
- **Contents**: Goal progress, current strategy, accumulated observations
- **Access**: Selectively loaded — only the necessary parts — at session startup

Goal state is PulSeed's "working memory" in the operational sense. It remembers what is needed to achieve the current goal. It is the core element that maintains continuity across sessions.

### Experience Log

- **Physical form**: Records of state → action → result
- **Lifespan**: Persists as long as the PulSeed instance exists
- **Contents**: Past attempts, their outcomes, and learned patterns
- **Access**: Not directly loaded into ordinary sessions. Referenced as summaries at the time of strategy selection or stall detection

The experience log is PulSeed's "long-term learning foundation." It is rarely referenced in individual sessions, but it improves the quality of task generation over time. Knowledge such as "this approach has failed before" and "in situations like this, that strategy was effective" accumulates here.

---

## 9. Managing Inter-Goal Dependencies

> §7 stated that context is fully isolated for each goal. However, in practice, dependencies exist between multiple goals. This section defines the types of dependencies, how they are defined, the data structures used to manage them, and their effect on scheduling.

### Types of Dependencies

Inter-goal dependencies are classified into four types.

| Type | Meaning | Example |
|------|---------|---------|
| **prerequisite** | Goal A must be achieved before Goal B can begin | "Infrastructure Setup" → "Service Launch" |
| **resource_conflict** | Both goals share a resource (time, API, execution environment, etc.) | Two goals that both write to the same database |
| **synergy** | Progress in one goal has a positive effect on the other | "Improve Customer Satisfaction" ⇔ "Reduce Churn Rate" |
| **conflict** | Progress in one goal has a negative effect on the other | "Reduce Costs" ⇔ "Improve Quality" (on some dimensions) |

These types are not mutually exclusive — two goals can have multiple types of relationships simultaneously. For example, "Reduce Costs" and "Improve Quality" may conflict on some dimensions, while both having a synergistic relationship with a higher-level goal of "Retain Customers."

### How Dependencies Are Defined

Dependencies can be defined in two ways.

**Method 1: Explicit declaration by the user at goal registration**

When registering a new goal, the user can explicitly declare its relationship to existing goals.

```
goal_dependency:
  from: goal_infrastructure
  to: goal_service_launch
  type: prerequisite
  description: "The service cannot launch without the infrastructure running"
  condition: "goal_infrastructure.achievement >= 0.9"  // specific threshold for the prerequisite
```

**Method 2: Automatic detection by LLM**

At goal registration time, PulSeed has the LLM analyze the relationship between the new goal and existing goals.

```
auto_detect_dependencies(new_goal, existing_goals):
    for each existing_goal in existing_goals:
        analysis = llm_analyze_relationship(new_goal, existing_goal)
        if analysis.has_dependency:
            proposed_dependency = {
                type: analysis.dependency_type,
                detection_confidence: analysis.detection_confidence,  // confidence in dependency detection, separate from observation confidence (state-vector.md §3)
                reasoning: analysis.reasoning
            }
            // Auto-register if confidence is high; ask the user if low
            if proposed_dependency.detection_confidence >= 0.8:
                register_dependency(proposed_dependency)
            else:
                propose_to_user(proposed_dependency)  // Ask the user for approval
```

Automatic detection runs once at goal registration, and also re-evaluates existing dependencies during goal reviews. New dependencies may emerge, or existing ones may be resolved, as circumstances change.

### Management Data Structure (Dependency Graph)

Inter-goal dependencies are managed as a directed graph.

```
dependency_graph:
  nodes:
    - goal_id: "goal_infrastructure"
    - goal_id: "goal_service_launch"
    - goal_id: "goal_cost_reduction"
    - goal_id: "goal_quality_improvement"

  edges:
    - from: "goal_infrastructure"
      to: "goal_service_launch"
      type: prerequisite
      condition: "goal_infrastructure.achievement >= 0.9"
      status: active  // active | satisfied | invalidated

    - from: "goal_cost_reduction"
      to: "goal_quality_improvement"
      type: conflict
      affected_dimensions: ["material_cost", "inspection_frequency"]
      mitigation: "Cost reduction is limited to areas that do not directly affect quality"
      status: active
```

**Preventing circular dependencies**: Prerequisite-type dependencies do not allow cycles. DAG validation is performed at goal registration, and the user is warned if a cycle is detected. Synergy and conflict dependencies are bidirectional, so the concept of cycles does not apply to them.

**Status management**: Each edge has a status of `active` (in effect), `satisfied` (prerequisite has been met), or `invalidated` (invalidated by changed circumstances). Statuses are automatically updated in response to changes in goal state.

### Effect on Scheduling

Dependencies affect the scheduling of the task discovery loop as follows.

**Prerequisites**: Task generation is suppressed for goals whose prerequisites are not yet satisfied. However, observation continues (to track whether the prerequisite is being satisfied).

```
before_task_generation(goal):
    for each dep in prerequisites(goal):
        if dep.status != "satisfied":
            skip_task_generation(goal)
            // Instead, give a bonus to the drive score of the prerequisite goal
            boost_drive_score(dep.from_goal, prerequisite_boost)
            return
```

**Resource conflicts**: Tasks from goals that share a resource are not executed simultaneously. One task must complete before the other begins.

**Synergy**: When one goal in a synergistic pair makes progress, the other goal's state vector is immediately re-observed. This is because progress may have propagated.

**Conflicts**: Simultaneous intervention on conflicting dimensions is avoided. Tasks whose `affected_dimensions` overlap are not scheduled at the same time. When conflicts are severe, the user is asked to decide on priorities.

### Relationship to §7

The "context isolation across multiple goals" principle from §7 is maintained. Dependency management is handled at PulSeed's scheduling layer, not through context mixing at the session level. Sessions remain stateless and independent. Dependencies affect "when and for which goal to run the loop" — not "what to include inside a session."

The only exception is the explicit information handoff described in §7. When a prerequisite is satisfied, the result of the prerequisite goal is included in the dependent goal's sessions. This is a structured handoff based on the dependency graph's edge information, not implicit information sharing.

---

## Summary of Design Principles

| Principle | Description |
|-----------|-------------|
| Sessions are stateless | No carryover of previous context. Each session is an independent execution unit |
| Priority-based selection | Context is assembled in priority order within the budget |
| Minimum context | Each session receives only the information needed to fulfill its purpose |
| Files carry memory | Continuity across sessions is guaranteed by persistent files |
| Full isolation between goals | Context for multiple goals is structurally segregated |
| PulSeed controls boundaries | Session start and end are managed actively, not passively |
| Dependencies managed at scheduling layer | Inter-goal dependencies are controlled while maintaining session-level context isolation |

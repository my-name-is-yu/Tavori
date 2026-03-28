# PulSeed — Vision Document

---

## 1. In a Nutshell

An AI partner that autonomously and persistently pursues your goals.

Tell PulSeed your goal, and it will keep chasing it — for days, months, or years. PulSeed is not an "assistant waiting for instructions." It takes ownership of your objectives and keeps moving toward them.

---

## 2. The Problem It Solves

You have goals you want to achieve. But nothing autonomously pursues them on your behalf.

AI assistants answer questions. Agents execute tasks. Automation tools run workflows. None of them take ownership of your goals and chase them persistently over the long term.

Monitoring the health of a chronically ill dog. Doubling revenue. Getting a new business off the ground. These goals don't end with a single instruction. Situations change, new problems emerge, and strategies need to be revised. Right now, humans have to make those judgments and issue new instructions every time.

What's missing isn't AI intelligence. It's **something that carries your goals as its own and pursues them autonomously**.

---

## 3. The World PulSeed Enables

### Tell It Your Goal, Then Let Go

"I want to live happily with my dog." "I want to double revenue." — Just tell it your goal. PulSeed takes it on, figures out what needs to be done, delegates to agents, observes the results, and decides the next action. When a session ends, when a day passes, when a month passes — it keeps moving until the goal is achieved.

### Operating for Years

PulSeed is not a one-time task runner. If a dog owner who has a chronically ill elderly dog says, "I want to live happily with this dog," PulSeed works as a dedicated partner for three years until that dog's life comes to an end. Daily health reports, urgent notifications, stage-appropriate care recommendations. As long as the goal continues, so does PulSeed.

### Reporting Proactively, Asking When Needed

PulSeed doesn't just work silently. Morning reports, instant notifications of important changes, proposals for strategy shifts. Users don't need to check in on the situation. PulSeed reaches out at the right time with the right level of detail. In emergencies, it sends alerts immediately.

### Negotiating Honestly

When the CEO of a SaaS company says, "I want to 10x revenue in six months," PulSeed responds: "10x will be difficult, but 2x is achievable." Rather than following blindly, it evaluates feasibility and proposes a realistic target. Once a target is agreed upon, it pursues it with full effort.

### Connecting to the Real World

PulSeed's activity is not confined to codebases. It reads data from wearable sensors, monitors business metrics, and integrates with external APIs. A dog's breathing pattern, a SaaS company's churn rate, conversion numbers — the metrics PulSeed tracks are not "did the tests pass?" but "are we getting closer to the goal?"

### Acquiring Knowledge Autonomously

PulSeed doesn't start with all the knowledge needed to achieve a goal. But it researches, learns, and builds understanding. About care for dogs with respiratory disease. About techniques for reducing SaaS churn. Acquiring domain knowledge is part of pursuing the goal.

### Sourcing Needed Tools Autonomously

If existing tools are insufficient, PulSeed instructs agents to build them. Health monitoring code for dogs, data analysis pipelines, alert notification systems. Whatever is needed to achieve the goal is built through agents. PulSeed's role is to judge what is needed and to verify when the build is complete.

### The Human Role Changes

From "implement this" and "look into that" to "I want things to be in this state." From task instructor to goal setter. From one-time requester to one half of a long-term partnership.

---

## 4. How PulSeed Differs from Existing Approaches

| Approach | What It Can Do | What It Lacks |
|----------|---------------|---------------|
| AI assistants (ChatGPT, Claude) | Answer questions, process tasks | Forgets when the session ends. Doesn't autonomously pursue goals |
| AI agents (Claude Code, Devin, various autonomous agents) | Execute complex tasks autonomously | Task-scoped only. No long-term goal pursuit, strategy planning, or revision |
| Autonomous agents (AutoGPT, BabyAGI) | Decompose goals into tasks and execute them | Can't determine completion and diverges. Doesn't know what "good enough" is |
| Business automation (Zapier, n8n) | Auto-execute predefined workflows | Doesn't work backward from goals. Can't adjust strategy based on situation |
| Project management AI (Linear, Asana) | Assist with task management | Doesn't execute tasks. Optimizes management, not goal pursuit |
| **PulSeed** | **Takes on goals and pursues them autonomously and persistently** | **Completion via satisficing, honest goal negotiation, multi-year sustained operation** |

PulSeed differs in two fundamental ways. First, **persistent goal pursuit**: it operates in units of goals, not sessions or tasks. Second, **satisficing**: rather than diverging in pursuit of perfection, it judges "good enough" and moves forward realistically. This combination exists in no other approach.

---

## 5. Design as an Autonomous Partner

### 5.1 The Scale of Goals

Goals given to PulSeed are ambiguous, long-term, and require multi-stage decomposition — like "live happily with my dog" or "double revenue."

"Implement feature X" is not a goal. It's one task that emerges along the path to achieving a goal. PulSeed's job is to discover the path from an ambiguous high-level goal down to that task, build it, and realize it through agents.

### 5.2 Recursive Goal Tree

Goals are decomposed into an N-level tree structure.

Each node has its own state, completion criteria, and satisficing threshold. The state of a parent goal is determined by aggregating the states of its child goals. The goal tree is not a static plan — it's a dynamic structure that is discovered, modified, and pruned during execution.

Example: live happily with dog → continuous health monitoring → build monitoring code → analyze sensor data
Example: 2x revenue → halve churn rate → improve onboarding → implement tutorial

> **Implementation status (Stage 14 complete)**: Implemented as the `GoalTreeManager` class in `src/goal-tree-manager.ts`. Supports N-level decomposition, validation, pruning, and reconstruction. `StateAggregator` in `src/state-aggregator.ts` aggregates child node states and controls completion cascades. `TreeLoopOrchestrator` in `src/tree-loop-orchestrator.ts` runs each node's independent loop in parallel. Launchable from the CLI with the `--tree` option.

### 5.3 Capability Registry (Dynamic Capability Management)

PulSeed doesn't start with all capabilities. Each time a user grants permissions, tools, or data sources, what it can do expands.

Sensor data from a dog's collar, a SaaS database, the Stripe API, IoT devices, business dashboards — PulSeed understands these as "capabilities" and incorporates them into goal decomposition. When a new kind of capability is added, the architecture doesn't change.

Furthermore, PulSeed extends its own capabilities. It instructs agents to create needed code, delegates the building of needed tools, and keeps acquiring the means needed to achieve goals. PulSeed doesn't "build" — PulSeed "has things built."

### 5.4 Strategy Engine (Discovering and Executing Strategies)

"What should be done" is not given to PulSeed. PulSeed discovers it.

It generates hypotheses, prioritizes them, experiments, measures effectiveness, and decides whether to continue, retreat, or pivot. The criterion is not "was the task completed?" but "did we get closer to the goal?"

"Waiting" is also a judgment. It takes time for initiatives to show results after being launched. Knowing when to measure for meaningful results — this sense of timing is also part of strategy.

### 5.5 Portfolio Management

Multiple strategies are run in parallel and managed as a portfolio. Focus on what's working, cut what isn't. Not sequential execution, but optimization of resource allocation.

> **Implementation status (Stage 14 complete)**: `CrossGoalPortfolio` in `src/cross-goal-portfolio.ts` implements cross-goal priority calculation, resource allocation, and rebalancing. `StrategyTemplateRegistry` in `src/strategy-template-registry.ts` manages strategy templates and applies them to similar situations. `KnowledgeTransfer` in `src/knowledge-transfer.ts` handles cross-goal knowledge and strategy transfer and meta-pattern extraction.

### 5.6 Time Horizon and Milestones

Goals have deadlines. For "2x revenue in 6 months," at the 3-month mark the pace is evaluated, and if insufficient, the strategy is changed. Make the best use of finite time.

Some goals have no deadline. "Live happily with my dog" has no end. PulSeed can handle this kind of goal too. Precisely because there's no end, operating at a sustainable pace becomes important.

### 5.7 Observing the External World

State observation is not limited to codebases.

Wearable sensors, databases, analytics, APIs, IoT devices, business metrics. The indicators PulSeed tracks are "is the dog's breathing stable?" "has churn rate decreased?" "have conversions increased?" It observes changes in the real world and judges progress toward the goal.

### 5.8 Delegation Layer

To pursue goals, PulSeed uses every available agent. Instructions to AI agents, delegation of API calls, requests for code execution, configuration of external service integrations. PulSeed never does these itself. It instructs agents to implement, asks other agents to review, and delegates deployment to appropriate systems — these are all orchestrated by PulSeed, not executed by PulSeed itself.

PulSeed is always the orchestrator. As a partner that keeps pursuing goals, it continually decides "what to delegate, to whom, and when." The execution itself is always carried out by the delegatee.

### 5.9 The Big Picture

```
User
  │
  ├── Goals: "I want to live happily with my dog" / "I want to double revenue"
  ├── Capabilities: sensor data, DB, API, agents, IoT, ...
  └── Constraints: "respect the vet's judgment" / "don't share customer data externally"

PulSeed (autonomous partner)
  │
  ├── Goal Tree (recursive goal hierarchy)
  │     Live happily with dog
  │     ├── Continuous health monitoring
  │     │    ├── Build monitoring code
  │     │    └── Set up emergency alerts
  │     └── Provide optimal care
  │          ├── Stage-appropriate care recommendations
  │          └── Coordination with vet
  │
  ├── Capability Registry (catalog of delegatable capabilities)
  │     Catalog of available delegation targets
  │     - AI agents (Claude Code CLI, Claude API, OpenAI Codex CLI, ...)
  │     - Data observation (sensors, DB, Analytics, ...)
  │     - External actions (notifications, API integrations, IoT, ...)
  │     - Tool acquisition (instruct agents to build)
  │
  ├── Strategy Engine (strategy discovery + portfolio)
  │     Hypothesis generation → prioritization → parallel delegation → effectiveness measurement → rebalancing
  │
  ├── Delegation Layer
  │     Adapter selection → session launch → context provision → result observation
  │
  └── State (state management + external metrics)
        Goal progress + observation data + time elapsed + capability catalog
```

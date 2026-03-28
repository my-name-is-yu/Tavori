# PulSeed --- Defining the Execution Boundary

---

## 1. Core Principle

**PulSeed does not execute on its own. PulSeed always delegates to agents.**

"PulSeed wrote the code," "PulSeed collected the data," "PulSeed built the system" — none of these are accurate. The precise statements are: "PulSeed instructed an agent to implement the code," "PulSeed asked an agent to collect the data," "PulSeed delegated system construction to an agent."

PulSeed is the brain, not the body. It decides; it does not act.

---

## 2. What PulSeed Is Responsible For

The only thing PulSeed does directly is **LLM calls for its own thinking process**.

| What PulSeed does directly | Purpose |
|---------------------------|---------|
| LLM calls for goal decomposition | Convert ambiguous goals into a tree of sub-goals |
| LLM calls for observation analysis | Interpret results received from agents and recognize gaps |
| LLM calls for strategy selection | Decide which gap to address and with what approach |
| LLM calls for task concretization | Convert a strategy into a single executable task and define success criteria |
| LLM calls for completion judgment | Evaluate whether a goal is "good enough" against satisficing criteria |
| State read/write | Save and load goal trees, observation logs, and learning data to files |

Everything else is delegated to agents.

---

## 3. What PulSeed Delegates

Anything related to execution is outside PulSeed's scope.

| Delegation category | Examples | Delegate targets |
|--------------------|---------|-----------------|
| Code implementation | Feature development, scripting, test implementation | Code implementation agents (e.g., Claude Code, OpenAI Codex CLI) |
| Data collection | API calls, sensor data acquisition, scraping | Specialized agents, tools |
| Data analysis | Statistical processing, pattern recognition, report generation | Data analysis agents |
| File operations | Read/write, conversion, moving | General-purpose agents |
| External service integration | API integration, webhook setup, auth flows | Specialized agents |
| System construction | Monitoring infrastructure, alert configuration, pipelines | Code implementation agents |
| Communication and notifications | Sending reports, firing alerts, approval requests | Messaging systems |
| Human confirmation | Approval requests for irreversible actions | Humans (directly) |

Think of it this way: "PulSeed has no body." PulSeed observes, thinks, and instructs. It is always another entity that moves its hands.

---

## 4. The Delegation Model

PulSeed's delegation to agents consists of four steps.

```
1. Adapter selection
   ↓
   Evaluate the nature of the task and choose the most suitable agent
   (code agent for code, specialized agent for data analysis, etc.)

2. Session launch
   ↓
   Start an agent session through the selected adapter

3. Context provision
   ↓
   Pass the necessary information to the agent:
   - Task content and success criteria
   - Relevant goals and their current state
   - Available tools and data sources
   - Constraints (e.g., "do not send customer data externally")

4. Result observation
   ↓
   Receive the agent's execution results:
   - Confirm whether success criteria were met
   - Check for side effects or unexpected outcomes
   - Provide feedback for the next loop
```

Through these four steps, PulSeed controls "what to ask for" while leaving "how to execute it" to the agent.

---

## 5. Capability Registry

PulSeed knows "what agents can do," but it does not do those things itself.

The Capability Registry is a catalog of capabilities PulSeed can delegate to.

```
Capability Registry
├── Agent capabilities
│     ├── Code implementation agents (Claude Code CLI, OpenAI Codex CLI, etc.) — code implementation, file operations, test execution
│     ├── LLM providers (Claude API, OpenAI API, etc.) — text generation, analysis, summarization
│     └── Custom agents — domain-specific tasks
│
├── Data source capabilities
│     ├── Sensor data (IoT, wearables)
│     ├── Business data (DB, Analytics, CRM)
│     └── External APIs (Stripe, Slack, etc.)
│
├── Action capabilities
│     ├── Notification delivery (Push, email, Slack)
│     ├── API execution (writes to external services)
│     └── Schedule control (cron, timers)
│
└── Human capabilities
      └── Judgment and approval (irreversible actions, escalations)
```

The capability catalog changes dynamically. When a user provides an API key, data sources expand; when permissions are granted, available actions expand. PulSeed consults the catalog's current state when designing tasks.

However, PulSeed does not "use" the capability catalog — it "references" it. The actual exercise of a capability is performed by the delegated agent or system.

---

## 5.1 Detecting Capability Gaps

PulSeed determines it "cannot handle this with the current capabilities" when any of the following signals occur.

**Signal 1: A required capability is missing from the registry at task generation time**

When generating a task, if a tool, permission, or data source that the LLM has determined is necessary is not registered in the Capability Registry. This is the lowest-cost signal, since it is detected before the task is even delegated.

```
Example:
  Task generation → "Fetch payment data via Stripe API"
  Check Capability Registry → Stripe API not registered
  → Capability gap detected before task execution
```

**Signal 2: Task execution repeatedly fails due to a capability gap**

The task was delegated, but the agent cannot execute it due to "no permission," "tool does not exist," "no API key," etc., and the same type of task fails consecutively. When `consecutive_failure_count` in `task-lifecycle.md` §2.8 reaches the escalation threshold (default: 3), the failure cause is analyzed and the capability gap is confirmed.

```
Example:
  Execute task "Analyze queries on the production DB"
  Agent: "No read permission for the production environment"
  Same type of task fails 3 times in a row → Confirmed as capability gap
```

**Signal 3: Stall detection diagnoses the cause as "capability ceiling"**

When diagnosed as "capability ceiling" under `stall-detection.md` §3.3. Stall detection can identify capability gaps not only from individual task failures, but also from situations where the gap in a given dimension is not shrinking.

```
Example:
  The gap in the "health data monitoring" dimension does not shrink over 5 loops
  Root cause → "No capability to read sensor data"
  → Confirmed as capability gap
```

---

## 5.2 Dynamic Acquisition Flow

Once a capability gap is confirmed, PulSeed acquires the capability through the following flow.

```
1. Confirm the capability gap
   ↓ Identify which capability is missing
   ↓ Classify the type of missing capability (tool / permission / data source / knowledge)

2. Select an acquisition method
   ↓ Choose an acquisition method based on the type (see §5.3)
   ↓ In MVP, prioritize escalation to humans

3. Generate an acquisition task
   ↓ Generate using the same structure as a normal task (see task-lifecycle.md §2)
   ↓ Explicitly label the task category as "capability acquisition task"
   ↓ Include "new capability registered in the registry" in the success criteria

4. Execute the acquisition task
   ↓ Delegate just like a normal task
   ↓ Delegate to an agent or request human confirmation (see §5.3)

5. Verify the new capability
   ↓ Confirm that the acquired capability functions as expected (see §5.4)

6. Register in the Capability Registry
   ↓ Add the verified capability to the catalog
   ↓ After registration, resume the tasks that were waiting
```

The acquisition flow runs concurrently with the normal task lifecycle. Tasks blocked by the capability gap enter a waiting state until the acquisition task completes. Other goals and tasks are not affected.

---

## 5.3 Types of Acquisition Methods

Choose from the following three acquisition methods based on the type of missing capability.

### Delegating Tool/Code Creation to an Agent

**Applicable case**: The capability gap is caused by a tool or code that has not yet been created. It is possible to create a new tool or integration code within the capabilities of an existing agent.

```
Example:
  Missing capability: "Functionality to read data from a dog collar sensor"
  Acquisition method: Delegate "implement a sensor data reading script" to a code implementation agent
  Success criteria: The script runs correctly and returns sample data
```

The default delegate target is a code implementation agent (Claude Code CLI, OpenAI Codex CLI, etc.). The task content should explicitly state "what to build," "what the success criteria are," and "where to integrate it in the existing codebase."

### Requesting Permissions/API Keys from the User

**Applicable case**: The capability gap is caused by missing credentials, permissions, or access to an external service. This is a type of capability that PulSeed can request but cannot acquire autonomously.

```
Example:
  Missing capability: "Read permission for the production database"
  Acquisition method: Request permission grant from the user
  Escalation content:
    - What is needed: Read-only access to the production DB
    - Why it is needed: To execute the churn analysis task
    - Alternative: Provide an anonymized DB dump
    - Impact without permission: Cannot close the gap in this dimension
```

Requests should be specific. Not just "we need permission," but "we need this specific permission for this reason, and the alternative is this."

### Proposing External Service Integration

**Applicable case**: The required capability exists as an external SaaS or API service and can be acquired through integration configuration.

```
Example:
  Missing capability: "Ability to send notifications to Slack"
  Acquisition method: Propose Slack Webhook configuration to the user
  Proposal content:
    - Service to integrate: Slack
    - Capability gained: Send notifications to the #pulseed-alerts channel
    - Setup steps: Generate and provide an Incoming Webhook URL
```

---

## 5.4 Verifying New Capabilities

Before registering a capability in the Capability Registry, verify that the acquired capability functions as expected. Verification uses the same three-layer structure as normal task verification (`task-lifecycle.md` §5).

**What the verification session checks**:

| Check item | Verification method |
|-----------|-------------------|
| Basic operation | Give a sample input and confirm the expected output is returned |
| Error handling | Verify it fails gracefully on invalid input, network failures, etc. |
| Constraint conformance | Confirm it does not violate constraints inherited from the goal (e.g., don't send customer data externally) |
| Scope boundary | Confirm it only performs the intended operations and causes no side effects |

**When verification fails**:
- For tool/code creation: Re-delegate the fix to an agent
- For permissions/API keys: Report "the credentials provided do not work" to the user and request re-confirmation
- If verification fails 3 times: Abort the acquisition flow and escalate to the user

---

## 5.5 MVP and Phase 2 Scope

### MVP (Human Escalation Focused)

In MVP, no autonomous capability acquisition is performed. When a capability gap is detected, it is always handled by escalating to a human.

**MVP behavior**:
1. Detect the capability gap
2. Notify the user, explicitly stating the missing capability, alternatives, and impact
3. When the user provides the capability (API key, permission, tool), register it in the registry
4. Resume the tasks that were waiting

No acquisition tasks are delegated to agents. No automatic code generation is performed. Humans remain the providers of capabilities.

### Phase 2 (Autonomous Acquisition)

In Phase 2, autonomous acquisition is introduced based on capability type.

**Phased autonomy**:

| Capability type | Phase 2 behavior |
|----------------|-----------------|
| Tool/code | Delegate creation to an agent; auto-register after verification |
| Permission/API key | Continue escalating to the user (no change) |
| External service integration | Auto-generate setup guides; complete integration after user approval |

Autonomously acquired capabilities are registered in the registry in a form reusable for other goals. To avoid re-acquiring a capability that has already been obtained, the context of "which goal this was acquired for" is recorded at registration time.

---

## 6. What "PulSeed Did X" Actually Means

An explicit mapping of expressions:

| Shorthand (imprecise) | Precise meaning |
|----------------------|----------------|
| PulSeed wrote the code | PulSeed instructed a code implementation agent to implement the code and confirmed the result |
| PulSeed collected the data | PulSeed delegated a data collection task to an agent and received the result |
| PulSeed built the system | PulSeed sequentially delegated construction tasks to multiple agents and verified the integration |
| PulSeed called the API | PulSeed instructed an agent to perform that action and observed the response |
| PulSeed sent the notification | PulSeed delegated message delivery to the notification system |
| PulSeed built the tool | PulSeed instructed a code implementation agent to create the tool and verified its operation |
| PulSeed investigated | PulSeed delegated an investigation task to an agent and analyzed the result |

The shorthand is convenient in conversation, but use the precise form when discussing design.

---

## 7. Handling Irreversible Actions

A special case during delegation is irreversible actions.

**Examples of irreversible actions:**
- Deleting or overwriting production data
- API calls that incur charges to external services
- Sending mass emails to customers
- Modifying or destroying existing infrastructure

Actions in this category **always require human approval**, regardless of trust level or goal confidence. Even if PulSeed judges something to be "sufficiently certain," it must not delegate without human confirmation.

The approval flow is itself a form of delegation. The question "is it okay to perform this action?" is handed to the human, and the delegation to the agent takes place only after a "yes" is received.

---

## 8. Summary

PulSeed's execution boundary in one sentence:

> **PulSeed thinks. Agents act.**

PulSeed's value lies in continuously discovering "what should be done next" from the gap between goals and reality. It is always agents, humans, or existing systems that carry out the results of that discovery.

This separation makes PulSeed scalable. No matter how complex the goal, PulSeed keeps deciding "what should be done." "How to execute it" is handled by whichever agent is best suited at that moment.

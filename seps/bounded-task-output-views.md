# SEP-{NUMBER}: Bounded Task-Output Views

- **Status**: Draft
- **Type**: Extensions Track
- **Created**: 2026-11-18
- **Author(s)**: Girish Konda (@girishkvs)
- **Sponsor**: None (seeking sponsor)
- **Extension Identifier**: `io.modelcontextprotocol/tasks`
- **Amends**: the Tasks extension ([SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension)), using Events ([SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), `io.modelcontextprotocol/events`) and, when available, Task Event Sources ([ext-events#2](https://github.com/modelcontextprotocol/ext-events/pull/2)). Proposes three changes to Events.
- **Issue**: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3237, https://github.com/modelcontextprotocol/agents-wg/issues/26
- **PR**: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/{NUMBER}

## Abstract

This proposal defines a bounded view of a running task's output: a size-limited snapshot of the task's current output that replaces the previous one, not an unbounded log. A client can show what is done so far, and a client that joins late or misses updates reads the current view instead of replaying history.

Each view carries a revision, so duplicate and late copies do not change what a client shows. An empty view, an unavailable view and a message that carries no view mean different things. The task's final result stays separate and is never built from views.

The proposal adds no task status, retry mechanism or replay. The existing Tasks rules for authorization, retention, cancellation and final results stay authoritative.

This is a draft for the Tasks and Events Working Group, which owns both extensions, and it has no sponsor yet. The view travels as one event type of the Events extension (SEP-3415), subscribed to with the task's ID, so Tasks does not get a second output channel. When Task Event Sources (ext-events#2) is available, its `eventSource` field also names the view for a task. In three places Events does not yet fit a view: a client that joins without a cursor, sending only the newest view after a gap, and ending a subscription when the task completes. For each, this proposal suggests a change to Events and gives an alternative that needs no Events change. It builds on SEP-2509, SEP-2679 and the Intermediary Results discussion in agents-wg#26.

## Motivation

The [Tasks extension](https://github.com/modelcontextprotocol/ext-tasks/blob/cc9aaac1047a9440b07486e38f37060bbebeef4c/specification/draft/tasks.md) gives a running task a status, an optional `statusMessage` and, at the end, a result. `tasks/get` returns, and `notifications/tasks` carries, a `DetailedTask`, and a `working` task carries no output. `notifications/progress` and `notifications/message` are not supported on tasks. [Intermediary Results (agents-wg#26)](https://github.com/modelcontextprotocol/agents-wg/issues/26) describes this gap and the options for closing it.

[modelcontextprotocol#3237](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3237) reports the same gap from a computer-use server: there is "no standard surface for partial output while the task is still running", so "every client reinvents live-run visibility". It asks the Working Group for a common shape "so it's interoperable rather than per-vendor", and until then plans a vendor-private `_meta` key and its own `task-log://{taskId}` resource. The Tasks and Events Working Group listed intermediate results as a P1 item on its 13 Nov 2026 agenda ("Steering, intermediate results, related tasks").

Servers can already expose partial output through their own tools or resources. [ext-tasks#26](https://github.com/modelcontextprotocol/ext-tasks/pull/26) (write-up in [agents-wg#28](https://github.com/modelcontextprotocol/agents-wg/pull/28)) would also let a client name a running task when it calls a sibling tool, such as `get_ci_logs` next to `run_ci`, so that tool can read the task's output. With Events and Task Event Sources, a server can also send intermediate results as events tied to the task. This proposal does not claim that MCP prevents any of that.

What a generic client cannot do is interpret that output without learning each server's own rules:

- The event stream appends either way, but a client can read each event's `data` in two ways. After `["A"]` and then `["A", "B"]`, one client shows `A, B` because it replaces the output, and another shows `A, A, B` because it adds to it. Two clients can accept the same JSON and show different output. This proposal picks replace.
- An absent field, an empty list and output that is not available right now are not the same thing.
- A final result is not necessarily the last view, or all views joined together.

Events leaves `data` to each event type's `payloadSchema` (SEP-3415 L181), and Task Event Sources "does not mandate an event type naming convention" (ext-events#2 L140), so intermediate results sent as events raise the same three questions.

These are examples of how clients can read the same output differently, not defects observed in named implementations.

### What Events Gives

Line numbers refer to [SEP-3415 at `60b15c16`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/60b15c16f2e7265ea34ac51099dc5be62f734692/seps/3415-events-extension.md?plain=1) (final) and, as `#2 L`, to [ext-events#2 at `0e4939d1`](https://github.com/modelcontextprotocol/ext-events/blob/0e4939d1e91b3fa5d74f28c3f49f0d58f29cdd64/proposals/XXXX-task-event-sources.md?plain=1) (draft). Together they cover how a view would be delivered:

- **Binding.** `CreateTaskResult` gains an optional `eventSource` with the event type `name`, its subscription `input` and an optional `initialCursor` (#2 L48-L68).
- **Negotiation.** "Servers **MUST NOT** include `eventSource` in `CreateTaskResult` unless the server and client have declared the Events capability." (#2 L98)
- **Authorization.** "Servers **MUST** enforce the same authorization checks on event subscriptions as on `tasks/get`." (#2 L322)
- **Delivery.** Poll, push and webhook, advertised per event type, and "No mode is mandatory." (L179). A cursor lets a client resume (L17), and `eventId` deduplicates within a subscription (L236).
- **Lifecycle.** "The server **MUST** terminate the event stream when the task reaches a terminal status" (#2 L126), and "The client **MUST NOT** treat the event stream as a substitute for task status observation." (#2 L114)

Neither defines the payload: whether an event adds to earlier output or replaces it, how a client orders two copies, and how empty, unavailable and oversized output differ. That is the contract this proposal adds.

### Where a View Does Not Fit Events Yet

Three rules in SEP-3415 are written for discrete messages, and they work against a view:

1. **Late join.** "Passing `cursor: null` in any mode means "start from now". ... No historical events are replayed." (L692). For poll, "`null` means "start from now": the server returns no events and a fresh cursor for later polls." (L297). `initialCursor` is only on `CreateTaskResult` (#2 L103). A client that has the task ID but no cursor, such as one that restarts from a persisted task ID, gets nothing until the view next changes, which can take a long time for a task in `input_required`.
2. **Coalescing.** A view reader needs only the newest view, so after a gap the server should send just that. But "Servers MAY also apply their own replay ceiling independent of `maxAgeMs`, and MUST signal it with `truncated: true` when they do." (L702), and "`truncated: true` is the single signal that the server started delivery from a position later than the cursor the client supplied, which means events were skipped." (L705). The client is told that something was lost when nothing it needs was.
3. **Normal end.** "A server ends a subscription when the principal's access is revoked ..., or when the event type is removed or changed incompatibly ... The termination signal carries the same nested `error` shape in every mode" (L717-L723), and clients branch on the code: "`NotFound` and `Unsupported` mean rediscover and resubscribe, `Forbidden` means stop" (L988). Task Event Sources requires termination at terminal status (#2 L126), but Events has no signal for a subscription whose source finished normally.

### Prior Work

This proposal does not claim snapshots or the separation of partial and final output as new.

| Work                                                                                                                                                                                   | What it contributes                                                                                                                                                                                                                                                                                    | How this proposal relates                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), final                                                                                              | Events: event types, three delivery modes, cursors, `truncated` and `eventId`                                                                                                                                                                                                                          | The carrier. The proposed changes below are to its text                                                                                                                                                                                         |
| [ext-events#2](https://github.com/modelcontextprotocol/ext-events/pull/2), draft                                                                                                       | `eventSource` on `CreateTaskResult`, with authorization and lifecycle rules                                                                                                                                                                                                                            | An optional binding between a task and its view, and the source of its authorization and lifecycle rules                                                                                                                                        |
| [SEP-2509](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2509), closed without merging                                                                             | `tasks/read` for the current output snapshot of a running task, with an `available` flag, while `tasks/result` stayed final-only                                                                                                                                                                       | Same core idea, adapted to the current Tasks extension, adding revisions and ruling out truncated output presented as the complete view                                                                                                         |
| [SEP-2679](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2679), closed without merging when Tasks moved to the extension track                                     | Pushed `notifications/tasks/partial` chunks with sequence numbers, duplicate detection and gap warnings                                                                                                                                                                                                | The append model. This proposal takes the bounded replacement alternative and does not require push                                                                                                                                             |
| [agents-wg#26](https://github.com/modelcontextprotocol/agents-wg/issues/26)                                                                                                            | Use cases, and open questions on the carrier, the unit of increment and delivery                                                                                                                                                                                                                       | One concrete answer: the unit is a whole snapshot with a revision, not chunks or deltas                                                                                                                                                         |
| [modelcontextprotocol#3237](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3237)                                                                                  | Asks for an interoperable partial-output surface and suggests a task-scoped log resource. A [comment there](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3237#issuecomment-6299543124) proposes a `task-log://` append log with sequence numbers and resume, the opposite model | The same need, with a bounded view instead of an ordered log. On Events, an ordered log is a message-style event type with replay                                                                                                               |
| [ext-events#19](https://github.com/modelcontextprotocol/ext-events/pull/19), draft                                                                                                     | Resource Events, where "A server MAY coalesce undelivered events for one subscription into the newest"                                                                                                                                                                                                 | The same coalescing need, for resources                                                                                                                                                                                                         |
| [ext-tasks#26](https://github.com/modelcontextprotocol/ext-tasks/pull/26) and [agents-wg#28](https://github.com/modelcontextprotocol/agents-wg/pull/28)                                | `relatedTaskIds`, which would let a client name a running task on a call to a sibling tool that reads its state                                                                                                                                                                                        | The application-specific route. The rules here are meant to hold on that route too                                                                                                                                                              |
| [A2A `TaskArtifactUpdateEvent`](https://github.com/a2aproject/A2A/blob/98279d62316361ba8451eaef300f72b72e169185/specification/a2a.proto#L308-L319)                                     | Artifact chunks with explicit `append` and `last_chunk` flags                                                                                                                                                                                                                                          | Another answer to replace or append: the producer labels each chunk. This proposal replaces the whole view instead                                                                                                                              |
| [Agents WG meeting, 2026-08-21](https://github.com/modelcontextprotocol/agents-wg/blob/137d88bd7e23f9ce17933248c6924505a6f5ec00/meetings/2026-08-21.md#tasks-and-intermediate-outputs) | Discussed intermediate outputs on tasks, and task management through resource namespaces (Resources 2.0)                                                                                                                                                                                               | Background                                                                                                                                                                                                                                      |
| [ext-tasks#24](https://github.com/modelcontextprotocol/ext-tasks/issues/24)                                                                                                            | How a client learns about status changes it missed after a `subscriptions/listen` reconnect                                                                                                                                                                                                            | The same catch-up problem for status, where a [snapshot on subscribe](https://github.com/modelcontextprotocol/ext-tasks/issues/24#issuecomment-6134860437) was suggested. A fresh read of the current view is this proposal's answer for output |

## Specification

### Scope and Terms

This proposal covers **one size-limited current view per task**. It is not a log, a set of separate artifacts, or a stream of every intermediate event. The view is output, not status: it sits next to the task status and does not change it.

- An **observation** is one statement about the view: a revision, its availability, and the content when there is any.
- An **available** view is the complete current output. It has at least one content block.
- An **empty** view says that the current output has nothing in it.
- An **unavailable** observation says there is no current value, for example because the output does not fit the size bound.

### Event Type and Binding

A server that offers views lists this event type in `events/list`, and a client subscribes to it with the task's ID. When ext-events#2 is available, the server can also name the view in `CreateTaskResult` with `eventSource`:

```jsonc
// events/list entry
{
  "name": "mcp.task.output.updated",
  "description": "The current output view of a running task.",
  "delivery": ["poll", "push"],
  "inputSchema": {
    "type": "object",
    "properties": { "taskId": { "type": "string", "x-mcp-header": "TaskId" } },
    "required": ["taskId"],
  },
  "payloadSchema": { "...": "TaskOutputView, below" },
}

// eventSource in CreateTaskResult, when ext-events#2 is available
{
  "name": "mcp.task.output.updated",
  "input": { "taskId": "786512e2-9e0d-44bd-8f29-789f320fe840" },
  "initialCursor": "c-100", // only if the event type supports replay (#2 L103)
}
```

- A client that has the task ID **MAY** subscribe with `{ "taskId": <the task's ID> }` as the subscription `arguments`, without `eventSource`.
- When the server includes `eventSource` for the view, it **MUST** set `eventSource.name` to `mcp.task.output.updated` and `eventSource.input` to `{ "taskId": <the task's ID> }`. The client passes `input` as the subscription `arguments`.
- The event type **MUST** list `"poll"` in `delivery`. It **MAY** also list `"push"` and `"webhook"`.
- `taskId` **SHOULD** carry the `x-mcp-header` annotation, so that load balancers can route the subscription to the instance that holds the task, as `Mcp-Name` does for `tasks/get`.
- The `mcp.` prefix follows the names sketched in SEP-3415 Open Questions 2 and 4 (L982, L986). Whether that prefix is reserved is still open there.

These three rules come from ext-events#2, and this proposal requires them with or without it:

- The server **MUST** enforce the same authorization checks on a view subscription as on `tasks/get` for that task (#2 L322).
- The server **MUST** end the view's event stream when the task reaches a terminal status (#2 L126).
- The client **MUST NOT** treat the view's event stream as a substitute for task status observation (#2 L114).

### Payload

`data` of each occurrence is one observation:

```typescript
type TaskOutputView =
  | {
      revision: number;
      availability: "available";
      maxBytes: number;
      content: ContentBlock[];
    }
  | { revision: number; availability: "empty"; maxBytes: number }
  | { revision: number; availability: "unavailable"; maxBytes: number };
```

- `revision` is an integer from 1 to 2^53 - 1, so it stays exact in parsers that read numbers as doubles.
- `maxBytes` is the declared size bound for this task's view. It **MUST** be the same in every observation of a task.
- `content` uses the core `ContentBlock` types, the same blocks a `CallToolResult` uses. A view is not a `CallToolResult`, and it does not have to match the tool's `outputSchema`.
- The server **MUST** give the same observation the same `eventId`, and **MUST** give two observations with the same revision but different content or availability different `eventId`s, for example by deriving it from the task ID, the revision and a hash of `data`. SDKs deduplicate by `eventId` (L1176), so an `eventId` built from the revision alone would hide a conflict.
- `timestamp` is when the server made the observation. A client **MUST NOT** order views by `timestamp`.

### Identity and Revisions

A server **MUST** tie each observation to the server, the task and the caller's authorization context. A client **MUST NOT** reuse a cached view under a different server or authorization context just because the task ID matches.

A revision **MUST** always mean the same availability and content for that task. Any change to the view or its availability **MUST** get a greater revision. Revisions do not have to be consecutive, and they do not count events or order task status messages.

A server **MUST NOT** reuse a revision for different content after a restart or a replica change. It either keeps its revision state across the change or stops offering the view.

### Replacement, Duplicates and Conflicts

An available or empty observation that a client accepts **MUST** replace the previous view completely. The client **MUST NOT** append it, merge it or apply it as a patch, and **MUST NOT** treat missing items as unchanged.

A repeated observation with the same revision and the same content **MUST NOT** change what the client shows. An older revision **MUST NOT** replace a newer one. A gap between revisions **MUST NOT** be treated as a count of missed updates.

Two observations with the same revision and different content or availability **MUST** make the client stop treating its view as current, and the client **MUST** report the inconsistency. It **MUST NOT** keep whichever copy arrived last. A newer valid revision can restore the view. Receiving one of the conflicting copies again does not.

### Available, Empty, Unavailable and Omitted

An unavailable observation **MUST** be distinguishable from an empty view, which is why they are separate `availability` values. A client **MAY** keep an earlier value as history, but **MUST NOT** show it as the current view.

A message that carries no observation tells the client nothing new about the output. That includes a `tasks/get` result, a `notifications/tasks` notification, a heartbeat and an empty poll result. A client **MUST NOT** read it as an empty view, a deletion, or a sign that a cached view is still fresh.

### Size Bound

A server **MUST** declare and enforce a size bound for the view. If the output does not fit, the server **MUST NOT** present a truncated tail or a summary as the complete view. In this proposal it reports the view as unavailable while the task continues.

The bound is `maxBytes`, measured as the UTF-8 byte length of the `content` array serialized as JSON. A view over the bound **MUST** be sent as `unavailable`, never cut. A client **MAY** treat a view whose `content` is larger than `maxBytes` as invalid. This is not `truncated`, which in Events means skipped events (L705).

### Final Result, Late Output and Cancellation

The existing Tasks terminal statuses and results stay authoritative. A client **MUST NOT** build the final result by joining or merging views. A task that completes with `isError: true` is still a completed task with a tool-error result.

A server **MUST NOT** make a new observation after the task reaches a terminal status. The final result comes only from `tasks/get` or `notifications/tasks`.

After a client accepts a terminal status, late non-terminal output **MUST NOT** overwrite that status or its result, and the client **MUST** stop treating any view as current. Conflicting terminal messages are reported, and output revisions do not decide between them.

A `tasks/cancel` acknowledgement **MUST NOT** be treated as proof that the task was cancelled. Later output or a final result still follows the existing task lifecycle.

### Lost Visibility and Fresh Reads

A disconnect, a task TTL that has run out, a not-found response, a change in the caller's authorization, `truncated: true` or an ended subscription **MUST** make the client stop treating its cached view as current. None of these means the task failed, and none is a reason to send the call again.

To treat a view as current again, the client **MUST** get a fresh observation from the server, through a new poll or subscription that returns the current view (see [Late Join](#1-late-join)). Messages buffered from before the loss **MUST NOT** restore it on their own. A fresh read can confirm an unchanged revision, but does not by itself resolve a conflict.

### Delivery and Negotiation

The view **MUST** be optional and negotiated before a server relies on the client understanding it. A client that does not negotiate it keeps ordinary Tasks behavior. Negotiation is the Events capability, so a client that has not declared it gets no view. When ext-events#2 is available, a server names the view for a task in `eventSource` only after both sides have declared the Events capability (#2 L98).

The view **MUST** work with polling alone, which is why the event type lists `poll`. Push and webhook delivery **MAY** be offered, but are not required. This proposal does not add a method to Tasks, bring back `tasks/result`, or reuse progress or logging notifications, which are not supported on tasks. A server **SHOULD NOT** grant a webhook subscription a TTL that ends after the task's own TTL.

### Error Handling

Invalid view data is not a task failure. Rejecting a view does not change the task's status or create a result, and the client stops treating its cached view as current. An invalid event occurrence stays subject to SEP-3415's handling. A client reports validation failures and revision conflicts to its host, not to the server, and this draft allocates no error codes.

### Proposed Changes to Events

SEP-3415 is now final, and its spec is moving to the ext-events repository at Beta ([ext-events#24](https://github.com/modelcontextprotocol/ext-events/pull/24)), so these changes would be proposed against that spec. Changes 1 and 2 apply only to event types that carry state, such as this one. Message-style event types keep SEP-3415's behavior. Change 3 applies to any event type whose source can end.

#### 1. Late Join

**Proposed:** an event type **MAY** declare in `events/list` that it carries state, for example with `"semantics": "state"` (default `"message"`), as [suggested on SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415#issuecomment-6215900591). For a state-style type, the server **MUST** send the current value as the first event after a poll or subscribe with `cursor: null`, and changes follow. This changes L297 and L692 for state-style types only. `mcp.task.output.updated` is state-style.

**Alternative, no Events change:** `tasks/get` also returns `eventSource` for a task that is not terminal, with `initialCursor` set to the position just before the newest view, so the first poll from it returns the current view. `tasks/get` could also carry the current view revision, so a reader can tell whether its cached view is current. This needs replay support for the event type and a change to Tasks. The cursor and the revision change with every view, so `DetailedTask` would change too, and `notifications/tasks` would repeat it, since each notification carries "a complete `DetailedTask`". This alternative needs ext-events#2, since `eventSource` is defined there. Without it, late join needs change 1.

#### 2. Coalescing

**Proposed:** for a state-style type, a server **MAY** send only the newest value after a gap, and this **MUST NOT** set `truncated: true`. `truncated: true` keeps its meaning for message-style types, and for a state-style type when the server cannot send the newest value. This changes L702 and L705 for state-style types only. The SEP-3415 author [agreed](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415#issuecomment-6215654779) that coalescing "shouldn't truncate".

**Alternative, no Events change:** the server sets `truncated: true` when it coalesces, as L702 requires, and this event type tells clients that `truncated: true` followed by a view needs no further action, since each view is complete. Generic SDKs still report a gap ("Clients SHOULD treat it as one", L705), and a real gap looks the same as coalescing.

#### 3. Normal End

**Proposed:** allow a termination without `error`, meaning that the source ended normally: `notifications/events/terminated` with no `error` on push, `{"type":"terminated"}` with no `error` on webhook, and `terminated: true` on a poll result. The client SDK removes the subscription, does not resubscribe and reports no failure. A server ends a view subscription this way when the task reaches a terminal status (#2 L126).

**Alternative, no Events change:** the server stops without a signal. It closes push streams, answers polls with no events and lets webhook TTLs run out. The client ends the subscription when it sees the terminal status through `tasks/get` or `notifications/tasks`, as ext-events#2 already asks (#2 L128). A closed push stream does not say why it closed, so a client may reconnect (L385). An error code does not fit, because clients resubscribe on `NotFound` (L988).

### Non-Normative Example

A task checks five repositories and builds a report. The view is a list of finished checks.

| Step | Client receives                                                       | Client shows                                                                |
| ---- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | Revision 1, empty, as the first event of a poll with `cursor: null`   | An empty view. Nothing is done yet                                          |
| 2    | Revision 3, available, text `repo-a: ok`                              | `repo-a: ok`                                                                |
| 3    | Revision 5, available, text `repo-a: ok` and `repo-b: 2 issues`       | Both lines. The value replaces the old view and is not appended to it       |
| 4    | Revision 5 again, same value                                          | No change. It is a duplicate                                                |
| 5    | Revision 4, arriving late                                             | No change. It is older than the current view                                |
| 6    | A `notifications/tasks` update or a heartbeat, with no view           | No change. It says nothing about the output                                 |
| 7    | Revision 6, unavailable, because the output no longer fits `maxBytes` | No current view. The old lines can stay as history, not as the current view |
| 8    | The task completes, and the subscription ends                         | The final result from `tasks/get`, which is not built from the views        |

## Rationale

### Events as the Carrier

The proposal needs one carrier. Two competing ways to carry the same view would defeat the point of a common contract. Events already gives delivery and resume, and Task Event Sources gives authorization and a lifecycle tied to the task. This proposal states those rules itself, so it does not depend on Task Event Sources, and adds only what a view needs on top: the payload and the client rules. This follows a suggestion in the Working Group to start from Events, and change Events where it does not fit, rather than add an equivalent mechanism to Tasks.

### State-Style Event Types

A view, a task status (SEP-3415 Open Question 4) and a resource (ext-events#19) are all state: a reader needs the newest value, not every change. The SEP-3415 author put the question this way on ext-events#2: "Events can be lossy whereas a state machine always has a "current state" that you can always retrieve via polling." ([comment](https://github.com/modelcontextprotocol/ext-events/pull/2#discussion_r3316702303)). Declaring state once per event type fixes late join and coalescing for all of them, and needs no replay history. The alternative for late join needs ext-events#2, replay support, a Tasks change and a second place for view state.

### Replacement Over Append

Whole replacement is the smallest model that lets a late reader, or a client that missed updates, catch up with one bounded read. The producer keeps the running output, so a generic client never has to guess between append and replace. The revision only orders views, so a reader needs no history: a cursor only helps delivery, and nothing has to be replayed.

The cost is resending data, and the producer has to keep or rebuild the current view. Replacement is a poor fit for unbounded logs. If the main use case needs full history, the group should choose that explicitly rather than add cursors, retention and patches to this proposal. On Events, an ordered log like the one #3237 asks for can sit next to this view as a message-style event type.

### Application-Specific Tools

ext-tasks#26 would let a server offer a sibling tool that reads a running task, and that route works without this proposal. The question here is what a generic client can assume without knowing the tool. The same rules can describe what such a tool returns. A known event type, and `eventSource` when ext-events#2 is available, let a generic client find and read the view on its own.

### Revisions Rather Than Timestamps

Tasks already carries `lastUpdatedAt`, and [ext-tasks#24](https://github.com/modelcontextprotocol/ext-tasks/issues/24) uses it to discard a stale snapshot. Timestamps can tie or drift across replicas, and two equal timestamps do not mean the same content. A revision does. The same holds for an event's `timestamp`, which SEP-3415 suggests for ordering webhook deliveries (L741).

### Scope Boundaries

This proposal does not change progress notifications ([SEP-2632](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2632)), and it leaves resumable delivery to Events cursors rather than [SEP-2694](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2694). A revision orders views of the output. It is not a transport or event sequence and does not promise delivery.

### Objections

Consensus is not established. A comment on agents-wg#26 prefers a lossy, best-effort event feed, and application-specific tools may be enough for many servers. Those are alternatives to weigh, not support for this proposal. The same comment asks for an upper bound on what servers buffer. The size bound here is one answer, at the cost that output larger than the bound becomes unavailable instead of truncated.

On ext-events#2, the SEP-3415 author asked for intermediate results "_without_ needing events", with events as "purely a latency optimisation" ([comment](https://github.com/modelcontextprotocol/ext-events/pull/2#discussion_r3316563118)). This proposal requires `poll`, but `events/poll` is still part of Events, so a client without Events gets no view and keeps ordinary Tasks behavior. On #3237, the ext-events#2 author [asked](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3237#issuecomment-6962793499) whether SEP-3415 already covers that use case. For the view, the Motivation lists what it covers and what is left.

## Backward Compatibility

The view is optional. Clients that do not negotiate it keep ordinary Tasks behavior, and final results, cancellation and error responses do not change. Existing application-specific tools keep working.

Being additive is not enough on its own. Before acceptance, the group should test a client without the capability, a peer that drops unknown extension data, and any relevant intermediary. The proposal cannot rely on a peer that does not support it passing a new field through. [ext-tasks#32](https://github.com/modelcontextprotocol/ext-tasks/pull/32) showed the risk: before v0.2.3, the TypeScript package in ext-tasks dropped unknown fields from `tasks/get` and `CreateTaskResult`, which would drop `eventSource`.

The proposed Events changes leave message-style event types as they are: `semantics` is optional and defaults to `"message"`. A `terminated` signal without `error` makes a required field optional, so a client that requires `error` would reject it until it is updated. SEP-3415's reference implementation in an official SDK is still outstanding (L972).

## Security Implications

- **Untrusted content.** Views are untrusted content, not instructions and not evidence that the work succeeded. A view gets no authority that the final result would not have. Hosts keep their normal approval and origin rules. SEP-3415 says the same of every event payload (L941).
- **Privacy.** Servers apply the same redaction and filtering to views as to final results. A view can expose intermediate data that the final result would not.
- **Authorization.** Servers **MUST** apply the same authentication and authorization checks to a view read that they apply to `tasks/get` for that task, as ext-events#2 requires for subscriptions (#2 L322). Cached views stay tied to the caller, so a change in permissions does not expose a previous caller's view.
- **Headers.** The `x-mcp-header` annotation puts `taskId` in an HTTP header. Tasks already sends it in `Mcp-Name` for `tasks/get`, so this adds no new exposure.
- **Resource limits.** Clients enforce `maxBytes` and nesting limits before accepting a view, on top of normal transport and parser limits. SEP-3415 asks servers to "keep event payloads minimal" (L951). A view carries content by design, so it departs from that SHOULD, within its declared bound. A view can use `ResourceLink` blocks instead of large inline content.
- **Conflicts.** Same-revision conflicts are reported, not hidden by last-write-wins or by `eventId` deduplication. Invalid or conflicting views cannot make a task look completed.
- **References.** A resource reference inside a view does not grant permission to fetch its target, and normal approval, authorization and origin rules apply. A revision does not freeze the content behind a URI that can change.

## Reference Implementation

There is no MCP implementation yet. A local Python model of the client rules (37 cases, October 2026) exists, but it is unpublished, predates the Events payload and does not use MCP messages, so it is not offered as evidence. SEP-3415's SDK implementation is outstanding (L972), and ext-events#2 lists none. The plan is a small producer and client over existing MCP transports, Events and Tasks support, including a client that does not negotiate the view, using synthetic data. A prototype is required before the proposal can be accepted, and a second, independent implementation is the evidence that the rules interoperate.

## Testing Plan

These cases are planned. None of them has run against an MCP implementation yet.

| Cases                                                                                                  | What they check                    |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Replacement, duplicate, older revision and skipped revision                                            | Replacement and revision rules     |
| Same revision with different content or availability, and the `eventId` for each                       | Conflict handling                  |
| Available, empty, unavailable and omitted view                                                         | Availability rules                 |
| A view that differs from the final result, an `isError: true` result, and late output after completion | Final result rules                 |
| A cancel acknowledgement followed by completion                                                        | Cancellation                       |
| Disconnect, task TTL run out, not-found, `truncated: true`, fresh read, and a changed caller or server | Identity and lost visibility       |
| A poll or subscribe with `cursor: null`, and an old cursor after several updates                       | Late join and coalescing           |
| Task completion in each delivery mode                                                                  | Normal end                         |
| A view at and over `maxBytes`, and malformed or deeply nested values                                   | Size bound                         |
| Restart or replica change, and referenced content that can change                                      | Revision continuity and references |
| A client without Events, and a peer or intermediary that drops unknown data                            | Negotiation and compatibility      |

Each requirement needs a concrete check or an explicit exclusion. Cases that are not run do not count as passing.

## Open Questions

1. Do real producers and generic clients need a common current view, or are a lossy feed and application-specific tools enough?
2. For each of the three gaps, does the Working Group prefer the change to Events or the alternative?
3. Should a view also allow `structuredContent`, and if so, what must it match?
4. Should a view instead be a revision plus a link to read, to follow SEP-3415's payload minimality (L951)?
5. How do clients compare content for the same-revision check across languages, and how exactly is `maxBytes` measured?
6. `eventSource` names one event type. Should it allow several, so a task can offer a view and a message-style event type together?
7. Does the event type name wait on SEP-3415 reserving the `mcp.` prefix (L982), and should the view share a subscription with task status if `mcp.task.updated` (L986) is adopted?
8. Should this be a new SEP, or a joint successor with the authors of SEP-2509 and SEP-2679?

## Acknowledgments and References

- [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), Events, by Peter Alexander (@pja-ant), is the carrier. His comments on SEP-3415 and ext-events#2, quoted above, frame changes 1 and 2.
- [ext-events#2](https://github.com/modelcontextprotocol/ext-events/pull/2), Task Event Sources, by Luca Chang (@LucaButBoring), is the optional binding and the source of the authorization and lifecycle rules.
- [SEP-2509](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2509) by Shinzo (@shinzoxD) and [SEP-2679](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2679) by Raman Marozau (@morozow) are the earlier snapshot and append designs.
- [modelcontextprotocol#3237](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3237) by @Cam10001110101 states the need, and the [ordered-log comment](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3237#issuecomment-6299543124) by @priyankanmehta gives the append-log model this proposal compares against.
- The `state` and `message` split comes from a [comment on SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415#issuecomment-6215900591) by @mib00038. The coalescing question there was [raised](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415#issuecomment-6169557403) by Larry Maccherone (@lmaccherone), whose ext-events#19 has the same need for resources.
- agents-wg#26 and ext-tasks#26 are by Vinay (@vinoo999), and ext-tasks#24 is by @davidscotttufts.

Listing here does not imply that anyone endorses this draft.

## Appendix: Changes from agents-wg#30

This draft carries [agents-wg#30](https://github.com/modelcontextprotocol/agents-wg/pull/30) at `5c623188` forward. Text not listed here is unchanged. New in this draft: the Motivation paragraphs on #3237 and Events, What Events Gives, Where a View Does Not Fit Events Yet, the Prior Work rows for SEP-3415, ext-events#2 and ext-events#19, Event Type and Binding, Payload, Proposed Changes to Events, Rationale: Events as the Carrier and State-Style Event Types, and Acknowledgments and References.

| #30 text                                                                                                                                                                                 | Change                                                                                                                                    | Reason                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Title, Created, Sponsor "None (seeking sponsor)", Issue, PR                                                                                                                              | New title suffix "on Events", date, Sponsor TBD, #3237 added, ext-tasks PR, new Amends line                                               | Moved to ext-tasks as a draft SEP, carried on Events                                                                                                               |
| Abstract: "An available empty view"                                                                                                                                                      | "An empty view"                                                                                                                           | Empty is now its own `availability` value                                                                                                                          |
| Abstract: "which owns Tasks"; "The carrier and the wire representation are still open, so this document does not define fields or methods ... Negotiation would follow agents-wg#29 ..." | "which owns both extensions"; replaced by the Events sentences                                                                            | Tasks and Events share one Working Group. Carrier now Events, and negotiation is the Events capability, with `eventSource` (#2 L98) when ext-events#2 is available |
| Motivation: Tasks link at `899c1bbc`                                                                                                                                                     | Link at `cc9aaac1`                                                                                                                        | Current `main` (v0.2.3)                                                                                                                                            |
| Motivation: "A value of ... can mean replace or append"                                                                                                                                  | Reworded: the stream appends either way, an example of both readings, and this proposal picks replace                                     | Review on ext-tasks#38: an event stream always appends                                                                                                             |
| Motivation: "The proposal is worth pursuing only if ... there is no reason to add another extension"                                                                                     | Removed                                                                                                                                   | It undercut the proposal (review on ext-tasks#38). The demand is now stated above it: #3237 and the Working Group's P1 item                                        |
| Prior Work: SEP-2679 row "does not require notifications"                                                                                                                                | "does not require push"                                                                                                                   | Delivery is Events, and `poll` is required                                                                                                                         |
| Prior Work: #3237 row "Close to the resource option below ... the opposite model"                                                                                                        | Rewritten for a log on Events                                                                                                             | The resource option is dropped                                                                                                                                     |
| Prior Work: agents-wg#29 row                                                                                                                                                             | Dropped                                                                                                                                   | Negotiation no longer follows agents-wg#29                                                                                                                         |
| Prior Work: meeting row "Background for the resource option"                                                                                                                             | "Background"                                                                                                                              | The resource option is dropped                                                                                                                                     |
| Prior Work: ext-tasks#24 row                                                                                                                                                             | Snapshot on subscribe added                                                                                                               | It matches change 1                                                                                                                                                |
| Terms: observation "whether a value is available, and the value when it is"; "An available value is the complete current view. It may be empty."; unavailable                            | Observation reworded; available and empty split; unavailable gets an example                                                              | Three `availability` values, and content blocks                                                                                                                    |
| Terms: `OutputObservation<Value, Revision>`, "notation for this document, not a wire format"                                                                                             | Replaced by the `TaskOutputView` payload                                                                                                  | The wire shape is now event `data`                                                                                                                                 |
| "The value type, the revision encoding, field names, the carrier and negotiation are open."                                                                                              | Dropped                                                                                                                                   | Now defined: content blocks, integer revision, Events                                                                                                              |
| Identity: "How a client learns about that change is part of the open wire design."                                                                                                       | Dropped                                                                                                                                   | The wire is Events. A restart drops streams, and Lost Visibility applies                                                                                           |
| Replacement: "An available observation"                                                                                                                                                  | "An available or empty observation"                                                                                                       | An empty view also replaces the previous one                                                                                                                       |
| Availability: "distinguishable from an available empty value"                                                                                                                            | "from an empty view, which is why they are separate `availability` values"                                                                | Three values                                                                                                                                                       |
| Omitted: "A task message that carries no observation"                                                                                                                                    | "A message", with examples                                                                                                                | Events adds heartbeats and empty poll results                                                                                                                      |
| Size Bound: "How size is measured, declared and negotiated is open."                                                                                                                     | `maxBytes`, measured on `content`                                                                                                         | The payload declares the bound                                                                                                                                     |
| Final Result: terminal rules                                                                                                                                                             | Server rule added, and the client stops treating any view as current                                                                      | No view after terminal status                                                                                                                                      |
| Lost Visibility: list of losses, and "through the chosen read path"                                                                                                                      | Adds `truncated: true` and an ended subscription, and a new poll or subscription                                                          | Events signals, and change 1                                                                                                                                       |
| Example: steps 1, 2, 3, 6, 7 and 8                                                                                                                                                       | Content shown as text blocks, Events messages named, `maxBytes`, result from `tasks/get`                                                  | Events delivery and three values                                                                                                                                   |
| Delivery and Negotiation: "Clients poll as Tasks already describes", "Notifications MAY say ...", "does not add a stream method"                                                         | The event type lists `poll`, push and webhook optional, "does not add a method to Tasks"; negotiation sentence and webhook TTL rule added | Events provides `events/poll` and `events/stream`                                                                                                                  |
| Carrier: first two sentences                                                                                                                                                             | Moved to Rationale: Events as the Carrier                                                                                                 | Kept as the reason for one carrier                                                                                                                                 |
| Carrier: table of task extension data and an advertised resource                                                                                                                         | Dropped                                                                                                                                   | Carrier now Events, as the Working Group suggested                                                                                                                 |
| Error Handling: "If the rest of a task message is valid", "the base protocol's handling", "The chosen carrier needs to say how ..."                                                      | Rewritten for event occurrences, and conflicts are reported to the host                                                                   | Carrier now Events                                                                                                                                                 |
| Rationale: "so there is no cursor to keep and nothing to replay"                                                                                                                         | "a cursor only helps delivery, and nothing has to be replayed"; sentence on an ordered log on Events added                                | Events has cursors                                                                                                                                                 |
| Rationale: "The carrier decides whether a generic client can find and read the view on its own."                                                                                         | "A known event type, and `eventSource` when ext-events#2 is available, let ..."                                                           | Carrier chosen                                                                                                                                                     |
| Rationale: Revisions Rather Than Timestamps                                                                                                                                              | Sentence on the event `timestamp` added                                                                                                   | SEP-3415 suggests `timestamp` for ordering (L741)                                                                                                                  |
| Rationale: "does not add resumable event delivery (SEP-2694)"                                                                                                                            | "leaves resumable delivery to Events cursors"                                                                                             | Events provides it                                                                                                                                                 |
| Objections                                                                                                                                                                               | Two Events objections added                                                                                                               | Raised on ext-events#2 and #3237                                                                                                                                   |
| Backward Compatibility: "Before choosing a carrier", ext-tasks#32 "shows the risk today"                                                                                                 | "Before acceptance", #32 in the past tense, and a paragraph on the Events changes                                                         | Carrier chosen. ext-tasks#32 merged on 2026-11-04 (v0.2.3)                                                                                                         |
| Security: Untrusted content, Authorization, Resource limits "The carrier needs size and nesting limits", Conflicts                                                                       | L941 and #2 L322 cited, `maxBytes` and L951 added, `eventId` added, Headers item added                                                    | Carrier now Events                                                                                                                                                 |
| Reference Implementation: "There is no implementation yet. After the carrier and wire shape are chosen, ..."                                                                             | States what exists, including the local model and Events status                                                                           | Carrier chosen, and this draft states what exists                                                                                                                  |
| Testing Plan: "planned for when a carrier exists", five rows                                                                                                                             | "planned", rows updated, two rows added                                                                                                   | Events delivery and the three changes                                                                                                                              |
| Open Questions 2 to 5                                                                                                                                                                    | Q2 now asks about the three changes. Q3 to Q5 narrowed. New Q4, Q6 and Q7                                                                 | This draft answers the carrier and most of the wire questions                                                                                                      |

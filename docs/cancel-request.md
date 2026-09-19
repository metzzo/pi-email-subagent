# cancel_request

Administratively close one exact response obligation, or abandon one exact
never-started queued Python job, without fabricating a reply. Main-thread only.
Execution mode: **sequential**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `request_id` | string | ✓ | Exact request/correlation ID, or accepted mechanistic job mail ID, returned by `send_email` or shown in `/agents` |
| `reason` | string | ✓ | Substantive audit reason, at least 8 characters and at most 1,024 UTF-8 bytes |

## Safety policy

Cancellation is intentionally narrower than deleting mail:

- For ordinary mail, the ID must identify a response-required request in the
  current durable namespace. Incoming requests addressed to main must be
  answered, not cancelled. Answered requests and requests with a reply reserved
  for delivery cannot be cancelled.
- For a mechanistic invocation, the durable job must still be exactly `queued`,
  without a start generation. Starting, running, stopping, terminal, or
  uncertain claimed work cannot be abandoned.
- The recipient must be inactive (`failed`, `stopped`, `paused`, or `archived`)
  with no live/settling worker or Python process. Stop active work first.
- The first successful cancellation is authoritative; it never replaces an
  existing actor, timestamp, or reason.

Use cancellation only when the user explicitly abandons the request or an inactive recipient cannot safely resume. Identity-capacity pressure alone is not abandonment and never authorizes cancellation. Stop may satisfy the inactive-recipient precondition but does not free the identity lease; only a later clean archive does that. Do not use cancellation merely to hide an unanswered count. Ordinary cancellation closes the obligation but does not claim that work
succeeded and does not create a reply. Queued-job abandonment starts no Python
process: one atomic journal transition cancels its trigger, records an
`abandoned` terminal job with the audit reason, and creates the job's usual
stable non-correlated outcome notification. That outcome remains a notification,
not a response obligation.

## Durability and observability

For an ordinary request, the broker appends an `email.cancelled` journal event
before reporting success. For a queued Python job, the atomic terminal event
applies the same cancelled fields to its trigger and links the stable abandoned
outcome. The trigger then has `deliveryState: "cancelled"`, `cancelledAt`,
`cancelledBy`, and `cancellationReason`; `answeredAt` and `answeredBy` remain
absent. Recovery and compaction preserve both forms.

A cancelled request:

- leaves `fetch_emails` and unanswered counters;
- stops blocking safe archival;
- resolves `wait_for_replies` with terminal state `cancelled` and the audit reason;
- rejects any later reply as no longer deliverable.

Ordinary cancellation is serialized and atomic with reply reservation: either a
reply reserves the obligation first and cancellation fails, or cancellation
commits first and the reply fails. Mechanistic abandonment uses the same address
and journal serialization as the start claim: either abandonment commits while
the job is queued, or the claim wins and abandonment is rejected.

## Result

```text
Cancelled request mail_… to reviewer.audit@gpt-5.6-sol.com.
Reason: Owner abandoned the review after the recipient violated scope.
```

The tool keeps this stable `Cancelled request …` result wording for both ordinary
requests and queued Python jobs. Inspect the exact job to see its `abandoned`
terminal result and linked outcome.

`details` contains the bounded cancellation/job identifiers and audit facts; it
does not duplicate the original message body or turn the result into a reply.

Failures throw `Could not cancel request: <reason>`, so Pi records a native failed tool execution (`isError: true`).

## Interactive equivalent

```text
/agents cancel <request-id> <reason>
```

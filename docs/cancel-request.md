# cancel_request

Administratively close one exact response obligation without fabricating a reply. Main-thread only. Execution mode: **sequential**.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `request_id` | string | ✓ | Exact request/correlation ID returned by `send_email` or shown in `/agents` → Inbox |
| `reason` | string | ✓ | Substantive audit reason, at least 8 characters and at most 1,024 UTF-8 bytes |

## Safety policy

Cancellation is intentionally narrower than deleting mail:

- The ID must identify a response-required request in the current durable namespace.
- Incoming requests addressed to main must be answered, not cancelled.
- The recipient must be inactive (`failed`, `stopped`, `paused`, or `archived`) with no streaming worker. Stop an active recipient first.
- Answered requests and requests with a reply reserved for delivery cannot be cancelled.
- The first successful cancellation is idempotent and authoritative; retries do not replace its actor, timestamp, or reason.

Use cancellation only when the user explicitly abandons the request or an inactive recipient cannot safely resume. Identity-capacity pressure alone is not abandonment and never authorizes cancellation. Stop may satisfy the inactive-recipient precondition but does not free the identity lease; only a later clean archive does that. Do not use cancellation merely to hide an unanswered count. Cancellation closes the obligation but does not claim that work succeeded and does not create a reply.

## Durability and observability

The broker appends an `email.cancelled` journal event before reporting success. The envelope then has `deliveryState: "cancelled"`, `cancelledAt`, `cancelledBy`, and `cancellationReason`; `answeredAt` and `answeredBy` remain absent. Recovery and compaction preserve the cancellation.

A cancelled request:

- leaves `fetch_emails` and unanswered counters;
- stops blocking safe archival;
- resolves `wait_for_replies` with terminal state `cancelled` and the audit reason;
- rejects any later reply as no longer deliverable.

Cancellation is serialized and atomic with reply reservation: either a reply reserves the obligation first and cancellation fails, or cancellation commits first and the reply fails.

## Result

```text
Cancelled request mail_… to reviewer.audit@gpt-5.6-sol.com.
Reason: Owner abandoned the review after the recipient violated scope.
```

`details` contains only `requestId`, `recipient`, `cancelledAt`, `cancelledBy`, and `reason`; it does not duplicate the request body.

Failures throw `Could not cancel request: <reason>`, so Pi records a native failed tool execution (`isError: true`).

## Interactive equivalent

```text
/agents cancel <request-id> <reason>
```

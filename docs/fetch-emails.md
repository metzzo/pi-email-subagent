# fetch_emails

Return the caller's unanswered response-required emails. Available to the main thread and to every subagent. Execution mode: **sequential**.

## Parameters

None (`{}`).

## Behavior

- Returns delivered emails addressed to the caller that `requiresResponse` and are neither answered nor reserved by a pending reply.
- Sorted high priority first, then oldest first.
- For the main thread, mail to all current and previous `main@<model>.com` aliases is merged and de-duplicated by email ID.
- Queued (not yet delivered) mail and pure replies are not listed; emails already answered or reserved by an in-flight reply are excluded.

## Result

With no outstanding mail:

```text
UNANSWERED EMAILS (0)

Your mailbox has no unanswered response-required emails.
```

Otherwise a header plus an XML rendering of each email:

```text
UNANSWERED EMAILS (2)

<agent-email-batch count="2">
<agent-email id="mail_…" kind="request" priority="high">
  <from>main@gpt-5.6-sol.com</from>
  <to>reviewer.audit@gpt-5.6-sol.com</from>
  <subject>Audit token handling</subject>
  <reply-subject>Re: [mail_…] Audit token handling</reply-subject>
  <body>…</body>
</agent-email>
…
</agent-email-batch>
```

`details.emails` contains the raw `EmailEnvelope[]` for renderers. All user-controlled text is XML-escaped; the `<reply-subject>` element is the exact string to pass as `subject` in [`send_email`](send-email.md) when answering.

## Usage guidance

- Call at the beginning of mailbox-driven work and again before becoming idle; the broker re-prompts agents that settle with unanswered mail and eventually marks them failed.
- Answer every returned request substantively with `send_email` using its exact reply subject. A partial result or an honest blocker is acceptable; silence is not.
- An empty result means no obligations — plain assistant text is not a substitute for answering listed mail.

# ADR 0008: Workflows and approvals, calendar writes, reports, profile, teams

**Status:** Accepted (Phase 7, built; awaiting review)

## Context
Phases 1 to 6 read and understand a person's messages and let them send replies one at a time, always after confirming the exact text. The product now needs the engine behind a mobile client: automation, calendar changes, reports, per-person preferences and shared teams. This ADR records the decisions that change or extend the rules in ADR 0006.

## Decisions

1. **A workflow is trigger + conditions + actions + autonomy + policy.** Triggers: a new inbound message (after the thread was analysed), a daily or weekly schedule in a time zone, or "run now". Conditions are simple matches on channel, sender, subject, body, priority and topic (all must hold). Actions: `draft_reply`, `send_reply`, `create_event`, `generate_report`. Definitions are validated by zod (`workflows/workflow.schema.ts`); the schema refuses nonsensical combinations (a reply on a schedule trigger, a send before its draft, "auto" without allowed channels).

2. **Three autonomy levels, and "ask" is the default.**
   - `suggest`: the AI writes a draft; nothing is queued. The person sends it themselves from the reply panel.
   - `ask`: the draft is shown in an approval; sending needs the person's approval of exactly that content.
   - `auto`: the reply may go out without a click, but only when **all** of these hold, otherwise it falls back to an approval (never silently dropped): the operator switch `AUTO_SEND_ENABLED` is on (default **off**, so a fresh install never sends by itself); the profile switch `auto_replies_enabled` is on; the workflow's policy lists the channel; the profile's per-channel policy allows it; the thread's priority is not in `blockPriorities` (default: urgent); it is inside working hours (default on); the sender domain is allowed (when a list is set); the draft has no `[placeholder]` and is not long; and the 24-hour caps (per workflow and per channel) are not reached. These checks are a pure function (`autoSendHold`) with a test per rule.
   - "auto" only ever sends a draft **written by the same run**. A draft the person started is never sent on their behalf, and an AI draft never overwrites one they wrote.

3. **Calendar changes always need approval.** `create_event` in a workflow files an approval whatever the autonomy. There is no automatic calendar write.

4. **Approvals are hash-bound and single-use.** An approval stores the exact payload and its sha256. Approving means presenting that hash as the screen showed it; a change since then fails (`approval_changed`). The request is claimed atomically before it runs (double click or second device runs it once). It then goes through the same confirmed paths a manual action uses (`RepliesService.send`, `CalendarActionsService.createEvent`). A newer message in the thread or a calendar clash asks again instead of burning the approval. Approvals expire after 48 hours; an expired one cannot be used.

5. **The send rule from ADR 0006 is extended, not weakened.** Only `RepliesService.send` and `CalendarActionsService` write to the outside world. `DraftService` still depends on nothing that can send. `WorkflowEngine` and `ApprovalsService` may call the send path because they are not AI code: they never pass model output to a connector except through the draft the rules above allow. The engine acts only as the workflow's owner (workers impersonate the owner through `sys_account_ctx` / `sys_user_ctx`, as sync does).

6. **Runs are idempotent and never act on old mail.** `UNIQUE (workflow_id, dedupe_key)` (one run per message, or per schedule slot). Switching a workflow on sets `scan_from`, so only mail that arrives afterwards is considered. A missed minute of a schedule still runs later the same day.

7. **Everything is recorded for the person.** `activity_log` (user-readable, short sentences, never message text) and the run log (steps with status). Operators still get `audit_log`, without addresses or text.

8. **Calendar writes.** Connectors gain `createEvent`, `updateEvent`, `cancelEvent` (Google: events insert/patch/delete with `sendUpdates=all`; Microsoft: events POST/PATCH and `cancel`, falling back to delete for events the user only attends). They need the write scope granted at connect time, exactly like replies. Overlaps are refused unless the person accepts them. The provider's copy is stored at once so it shows before the next sync.

9. **Reports** are PDF (pdfkit), Word (docx) and Excel (exceljs), built from synced data (subjects, senders, dates, counts; never message bodies) with no AI call. Files are encrypted at rest with the same envelope scheme as tokens, expire after 30 days, and are downloaded through the authenticated API. Cell values that start with `= + - @` are neutralised so message text can never run as a spreadsheet formula. Delivering a report to a channel is **not** built: it would be a send and needs its own confirmed path.

10. **Profile and preferences** are typed columns plus small JSON documents (tone, language, signature, working days and hours, time zone, escalation rules, per-channel response policies, report defaults, and the automatic-replies master switch). Reply drafting uses them only once a person has saved a profile, so nobody's drafts change by surprise. Saved text goes through the same `neutralize()` as all prompt input.

11. **Teams share things, not data.** A team has owner, admin, member and viewer roles and a library of workflow templates. Members install a template as their own workflow (switched off, and "auto" is never carried over). Nobody on a team can read another member's messages, drafts, approvals, runs or reports: those stay behind per-user row-level security. Invitations go to an email address and are the same whether or not that address has an account, so inviting does not reveal who is registered. A team whose last owner deleted their account is removed. This is deliberately separate from `tenants` (data boundary and retention); delegated access to another person's accounts is out of scope.

12. **Demo mode** (`DEMO_MODE=true`, development only, refused in production by env validation) replaces Gmail and Google Calendar with stand-ins that keep nothing and returns sample data, so the whole path (workflows, approvals, calendar writes, reports) can be tried from the UI without provider accounts. All its routes answer 404 when the flag is off.

## Relationship to the original rule
The project brief said "never auto-send". The later product brief allows automatic replies "only when explicitly enabled by the user and subject to approval rules, schedules, confidence thresholds and channel policies". This ADR implements that as three independent switches (operator, person, workflow), all off by default, plus the limits above. Anyone who wants the original rule back sets `AUTO_SEND_ENABLED=false` (the default): "auto" workflows then behave exactly like "ask".

## Consequences
- Not exercised against live providers: calendar writes follow the provider documentation and are tested with recorded-shape fixtures and the demo connectors.
- Google may require extra verification for `calendar.events`; Microsoft needs `Calendars.ReadWrite` consent. Both are already opt-in at connect time.
- Caps use a rolling 24 hours, counted from `activity_log`; they are per workflow and per channel, not per recipient.
- Workflows evaluate conditions in code on each scan (50 candidates per workflow per pass). Very large rule sets or high volumes would need an index and a queue per workflow.
- Run history and activity are kept until the person deletes their account; add a retention age if they grow.
- No delegated approvals (an assistant approving for someone else), no report delivery, no conditional branches or loops in workflows, and no AI-written calendar proposals yet.

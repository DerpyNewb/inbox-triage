# Inbox triage

An n8n workflow that reads a job seeker's Gmail twice a day, has Gemini sort the job mail, and updates
the matching row in a job-application tracker. Anything it isn't sure about goes to a review list
instead of the tracker.

**Status, 2026-11-21:** built and tested on fictional mail. It has not run on a real inbox yet, so there
are no usage numbers; they will be added after a few weeks of real runs.

## Try it with only a Google API key

The repo ships 16 fictional emails and a fictional tracker, so you can run the whole thing with nothing
but a [Google AI Studio API key](https://aistudio.google.com/apikey). Nothing is written to a real
tracker, and no alerts are sent.

**From the command line** (Node 20 or later, no installs):

```text
set GEMINI_API_KEY=your-key            (PowerShell: $env:GEMINI_API_KEY = "your-key")
node triage.mjs eval fixtures/mail.jsonl --live --tracker fixtures/tracker.txt
```

This sends each email the model is allowed to see to Gemini, with the same prompt and schema as the
workflow, and scores the answers against the expected labels.

**In n8n:**

1. Start n8n from this folder with the Execute Command node turned on:
   `set NODES_EXCLUDE=["n8n-nodes-base.localFileTrigger"]`, then `npx n8n`.
2. Import `workflow.demo.json`. It is the real workflow with the two Gmail nodes swapped for the sample
   emails, and every command runs with `--dry-run` against `fixtures/tracker.txt`.
3. Open the **Gemini** node and create a Google Gemini credential with your API key, then pick the same
   credential in **Gemini fallback**. The workflow uses `gemini-3.5-flash` and falls back to
   `gemini-3.5-flash-lite` when it fails, so both run on the one key.
4. Click **Run now**, then run `node triage.mjs stats --dry-run` and `node triage.mjs review --dry-run`.

A free key allows 20 Gemini requests a day per model, and one run uses 12 (the other 4 emails never reach
the model), so the demo sends 2 requests every 30 seconds and takes about three minutes. The sample emails
are fictional, so the free tier is fine for them. For real mail, use a key with billing turned on: Google
may use free-tier input to improve its products, and people may read it.

To change the model, set `GEMINI_MODEL` for the command line, or pick another model in the Gemini node.

**With no key at all:** `node --test test.mjs` runs the tests, and `workflow.fixtures.json` runs in n8n
with recorded model answers in place of Gemini.

## How it works

```text
Twice a day (or Run now)
  -> triage.mjs seen       log the run start, list message IDs already handled
  -> Gmail, two accounts   last 3 days, inbox and spam
  -> Sort and redact       skip / alert only / send to the model
  -> Gemini                category, company, role, next step, due date, quoted evidence
  -> Check extraction      reject made-up quotes, bad dates, unknown categories
  -> triage.mjs apply      match a tracker row, then update it or add it to the review list
  -> triage.mjs finish     log the run totals
```

The model sorts each email into `rejection`, `interview`, `action_needed`, `offer`, `confirmation` or
`other`. The tracker is changed through [job-tracker](https://github.com/DerpyNewb/job-tracker)'s `jt`
command, which backs up the workbook before every save.

| Category | Tracker change | Phone alert |
| --- | --- | --- |
| rejection | status Rejected | no |
| interview | status Interview, next step, follow-up date | yes |
| action_needed | status Screening if lower, next step, follow-up date | yes |
| offer | none; goes to review | yes |
| confirmation | status Applied, if the row says Not applied | no |
| other | none | no |

## Safety rules

- Security and money mail (sign-in alerts, passwords, verification codes, banks, payment services) never
  reaches the model. It triggers an alert with the sender and subject only.
- Promotions, social mail and job alerts are skipped without leaving the PC.
- Before anything goes to the model, the quoted thread is cut, and links, email addresses, phone numbers,
  passwords and code-like strings are replaced with placeholders.
- The model has to quote a sentence from the email. If the quote isn't there, the result goes to review.
- Mail from the spam folder, mail from a domain that neither names the company nor belongs to a hiring
  platform, offers, and mail about closed rows (Offer, Rejected, Withdrawn) all go to review. A convincing
  rejection sent from a look-alike domain changes nothing.
- A row's status only moves forward.
- Text from the model reaches `triage.mjs` as base64, and `jt` runs without a shell, so text in an email
  can't become a command.
- When the model doesn't answer (an outage, a rate limit, an unreadable reply), the email is marked failed
  and tried again on the next run. When it answers badly, the email goes to review. Nothing is guessed.
- The logs record metadata only: message ID, sender domain, category, row and outcome.

## Results so far

These come from the 16 fictional emails, which were written for the tests. They show that the pieces work
together, not how well the model handles real mail.

- With the recorded answers in `fixtures/outputs.jsonl`: category 15/16, company 10/10, row 10/10. The miss
  is deliberate: one recorded answer quotes a sentence that isn't in the email, and the check rejects it.
- With live `gemini-3.5-flash` on 2026-11-21 (`eval --live`): category 16/16, company 11/11, row 11/11.
- In n8n with `workflow.demo.json` on 2026-11-21: `gemini-3.5-flash` answered "Service unavailable" to all
  12 calls, so the fallback, `gemini-3.5-flash-lite`, did the work. 11 of the 12 emails were handled as
  expected (5 rows updated, 3 sent to review, 3 needing no change). The twelfth, the offer, got no answer
  from either model, so it was marked failed; the next run picked up only that email and sent it to
  review, as offers always are.

## Files

- `lib.mjs`: all the decision logic, as plain functions.
- `make_workflow.mjs`: writes the three workflow files, copying the `lib.mjs` functions into the Code nodes
  so the tests and the workflows run the same code. Edit `lib.mjs` and rerun it; never edit the JSON by hand.
  - `workflow.json`: real use, with Gmail and Gemini.
  - `workflow.demo.json`: the sample emails with live Gemini; needs only a Google API key.
  - `workflow.fixtures.json`: the sample emails with recorded answers; needs nothing.
- `triage.mjs`: the part that touches the PC (the tracker, the logs and ntfy alerts), the stats and the
  accuracy check.
- `fixtures/`: the fictional emails, recorded model answers, and a tracker list from job-tracker's sample
  workbook.
- `test.mjs`: the tests.

## Commands

```text
node triage.mjs stats                  runs, success rate and outcomes so far
node triage.mjs review [--days 7]      mail that needs a person
node triage.mjs eval <labeled.jsonl> --outputs <answers.jsonl> | --live [--tracker FILE]
node --test test.mjs
```

`--dry-run` (or `INBOX_TRIAGE_DRY=1`) never writes to the tracker or sends alerts, and it logs to a
separate `dry/` folder. Logs live in `%LOCALAPPDATA%\inbox-triage\` (`INBOX_TRIAGE_DATA` overrides).
`JT` and `JT_FILE` point at the `jt` executable and the workbook. `NTFY_TOPIC` turns on phone alerts.

## Tests

`node --test test.mjs` runs 14 tests on the fictional fixtures. They cover redaction, routing, the output
check, matching, every decision rule, retrying when the model doesn't answer, a prompt-injection email, the generated Code nodes, a dry run of the
whole command-line flow, and a real `jt` run against a temporary copy of job-tracker's sample workbook.
That last test is skipped when `jt` isn't installed, as on the CI runner.

## Real use

Reading a real inbox needs more than an API key:

1. Gmail needs an OAuth sign-in, not an API key. Create an OAuth client in Google Cloud, publish its
   consent screen "In production" (in Testing, the sign-in expires every 7 days), and attach one Gmail
   credential per account in `workflow.json`.
2. Attach a Gemini credential from a project with billing turned on.
3. Install [job-tracker](https://github.com/DerpyNewb/job-tracker) and set `JT_FILE` to the workbook.
4. Run it once with **Run now**, check the Gmail node's output against `fixtures/mail.jsonl`, then schedule
   `n8n execute --id inboxTriageMain1` twice a day, starting in this folder.

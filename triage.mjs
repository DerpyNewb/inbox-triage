// The half of inbox triage that touches the PC: the tracker, the logs and phone alerts.
// n8n calls the first three; the rest are for you.
//
//   node triage.mjs seen --run ID          log a run start, print message IDs already handled
//   node triage.mjs apply --run ID <b64>   match one message to a row, update it or queue it for review
//   node triage.mjs finish --run ID        log the run's totals
//   node triage.mjs stats                  runs, success rate and outcomes so far
//   node triage.mjs review [--days N]      mail that needs a person
//   node triage.mjs eval <labeled.jsonl> --outputs <outputs.jsonl> [--tracker FILE]
//   node triage.mjs eval <labeled.jsonl> --live [--tracker FILE]   asks Gemini (needs GEMINI_API_KEY)
//
// --dry-run (or INBOX_TRIAGE_DRY=1) never writes to the tracker or sends alerts, and logs to a
// separate dry/ folder. --tracker FILE (or INBOX_TRIAGE_TRACKER) reads `jt list --all` output
// from a file instead of running jt.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkItem, decide, matchRow, normCompany, parseJtList, sortMail } from './lib.mjs';
import { MODEL, PROMPT, SCHEMA, emailText } from './make_workflow.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const VALUED = ['--run', '--days', '--tracker', '--outputs'];
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const positional = rest.filter((a, i) => !a.startsWith('--') && !VALUED.includes(rest[i - 1]));

const DRY = rest.includes('--dry-run') || process.env.INBOX_TRIAGE_DRY === '1';
const BASE = process.env.INBOX_TRIAGE_DATA ?? join(process.env.LOCALAPPDATA ?? '.', 'inbox-triage');
const DATA = DRY ? join(BASE, 'dry') : BASE;
const JT = process.env.JT ?? 'C:/rust-target/job-tracker/release/jt.exe';
const WORKBOOK = process.env.JT_FILE; // unset: jt picks the workbook it opened last
const TRACKER = flag('--tracker') ?? process.env.INBOX_TRIAGE_TRACKER;
const run = flag('--run') ?? '';

const now = () => new Date().toISOString();
const path = (name) => join(DATA, name);
const append = (name, obj) => {
  mkdirSync(DATA, { recursive: true });
  appendFileSync(path(name), `${JSON.stringify(obj)}\n`);
};
const lines = (file) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const print = (obj) => console.log(JSON.stringify(obj));
// No shell: jt gets its arguments as a list, so text from an email can't become a command.
const jt = (args) => execFileSync(JT, WORKBOOK ? [...args, '--file', WORKBOOK] : args, { encoding: 'utf8', windowsHide: true });
const trackerRows = () => parseJtList(TRACKER ? readFileSync(TRACKER, 'utf8') : jt(['list', '--all']));

async function notify(title, body) {
  const topic = process.env.NTFY_TOPIC;
  if (DRY || !topic) return console.error(`alert (not sent): ${title} | ${body}`);
  const res = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Tags: 'email' } });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}

async function apply(b64) {
  const m = JSON.parse(Buffer.from(b64 ?? '', 'base64url').toString('utf8') || '{}');
  if (!m.id) return print({ outcome: 'none' });
  let outcome;
  let row = null;
  let reason = m.reason ?? '';
  let alert = '';
  try {
    if (m.route === 'skip') outcome = 'skipped';
    else if (m.route === 'alert') {
      outcome = 'alert_only';
      alert = 'Security or money mail';
    } else {
      const match = m.check === 'ok' && m.category !== 'other' ? matchRow(m.company, m.role, m.fromDomain, trackerRows()) : null;
      const d = decide(m, match);
      row = match?.row?.row ?? null;
      ({ alert, reason } = d);
      outcome = d.action === 'update' ? 'updated' : d.action;
      if (d.action === 'update') {
        if (DRY) console.error(`would run: jt ${d.args.join(' ')}`);
        else jt(d.args);
      }
      if (outcome === 'review') {
        const { id, account, from, subject, date, category, company, role, next_step, due_date, evidence } = m;
        append('review.jsonl', { at: now(), run, id, account, from, subject, date, category, company, role, next_step, due_date, evidence, row, reason });
      }
    }
  } catch (e) {
    outcome = 'failed';
    reason = String(e.stderr || e.message).trim().split('\n')[0].slice(0, 300);
  }
  let alerted = false;
  if (alert) {
    const body =
      m.route === 'alert'
        ? `${m.from}: ${m.subject}`
        : [m.subject, m.next_step && `Next: ${m.next_step}${m.due_date ? ` (by ${m.due_date})` : ''}`,
           outcome === 'updated' ? `Row ${row} updated.` : `Not changed: ${reason}`].filter(Boolean).join('\n');
    try {
      await notify(alert, body);
      alerted = !DRY && !!process.env.NTFY_TOPIC;
    } catch (e) {
      reason = `${reason} (alert failed: ${e.message})`.trim();
    }
  }
  const entry = { at: now(), run, id: m.id, account: m.account, fromDomain: m.fromDomain, route: m.route,
    category: m.category ?? '', row, outcome, reason, alerted };
  append('messages.jsonl', entry);
  print(entry);
}

function stats() {
  const runs = lines(path('runs.jsonl'));
  const started = new Set(runs.filter((r) => r.event === 'start').map((r) => r.run));
  const finished = runs.filter((r) => r.event === 'finish');
  const clean = finished.filter((r) => !r.counts.failed).length;
  const msgs = lines(path('messages.jsonl'));
  const counts = {};
  for (const m of msgs) counts[m.outcome] = (counts[m.outcome] ?? 0) + 1;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : 'n/a');
  console.log(`Runs: ${started.size} started, ${finished.length} finished (${pct(finished.length, started.size)}), ` +
    `${clean} with no failed message (${pct(clean, started.size)}).`);
  console.log(`Messages: ${msgs.length}. ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet'}.`);
  if (msgs.length) console.log(`Period: ${msgs[0].at.slice(0, 10)} to ${msgs.at(-1).at.slice(0, 10)}.`);
}

function review(days) {
  const since = Date.now() - days * 864e5;
  const items = lines(path('review.jsonl')).filter((r) => Date.parse(r.at) >= since);
  if (!items.length) return console.log(`Nothing to review from the last ${days} days.`);
  for (const r of items)
    console.log(`${r.date} | ${r.from} | ${r.subject} | ${r.category || '-'} ${r.company || ''} | row ${r.row ?? '-'} | ${r.reason}`);
}

// Labeled mail is Gmail-shaped with an `expected` block: { category, company, row }. Expected
// category is "skip" or "alert" for mail the model should never see.
// The same prompt and schema as the workflow's Gemini node, so --live measures what n8n would do.
async function askGemini(item) {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('--live needs GEMINI_API_KEY, a Google AI Studio API key');
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: emailText(item) }] }],
    // Low thinking: about 6 s a call instead of 30 s at the default, which is plenty for sorting mail.
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'low' } },
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL ?? MODEL}:generateContent`;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(120000) });
    } catch (e) {
      res = { ok: false, status: 0, text: async () => e.message };
    }
    // Rate limits (429), overload (503) and timeouts (0) are worth waiting out.
    if ([0, 429, 500, 503].includes(res.status) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 20000));
      continue;
    }
    if (!res.ok) return { error: { message: `Gemini answered ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 200)}` } };
    const reply = (await res.json()).candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    try {
      return { output: JSON.parse(reply) };
    } catch {
      return { error: { message: `unreadable reply: ${reply.slice(0, 100)}` } };
    }
  }
}

async function evaluate(file, outputsFile, live) {
  const outputs = new Map(live ? [] : lines(outputsFile).map((o) => [o.id, o]));
  const rows = trackerRows();
  if (live) console.log(`Model: ${process.env.GEMINI_MODEL ?? MODEL} (live)`);
  let n = 0, catOk = 0, coN = 0, coOk = 0, rowN = 0, rowOk = 0;
  const misses = [];
  for (const msg of lines(file)) {
    const want = msg.expected;
    const [item] = sortMail([msg], []);
    let got = item.route;
    let checked = null;
    if (item.route === 'model') {
      checked = checkItem(live ? await askGemini(item) : outputs.get(msg.id) ?? {}, item);
      got = checked.check === 'ok' ? checked.category : `failed check (${checked.reason})`;
    }
    n++;
    if (got === want.category) catOk++;
    else misses.push(`${msg.id}: expected ${want.category}, got ${got}`);
    if (want.company && checked?.check === 'ok') {
      coN++;
      if (normCompany(checked.company) === normCompany(want.company)) coOk++;
      else misses.push(`${msg.id}: expected company "${want.company}", got "${checked.company}"`);
    }
    if ('row' in want && checked?.check === 'ok' && checked.category !== 'other') {
      rowN++;
      const r = matchRow(checked.company, checked.role, checked.fromDomain, rows).row?.row ?? null;
      if (r === want.row) rowOk++;
      else misses.push(`${msg.id}: expected row ${want.row}, got ${r}`);
    }
  }
  const pct = (a, b) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : 'n/a');
  console.log(`Category: ${pct(catOk, n)}\nCompany: ${pct(coOk, coN)}\nRow: ${pct(rowOk, rowN)}`);
  if (misses.length) console.log(`\nMisses:\n${misses.join('\n')}`);
}

if (cmd === 'seen') {
  append('runs.jsonl', { run, event: 'start', at: now() });
  const since = Date.now() - 7 * 864e5;
  const ids = lines(path('messages.jsonl')).filter((m) => m.outcome !== 'failed' && Date.parse(m.at) >= since).map((m) => m.id);
  print({ ids: [...new Set(ids)] });
} else if (cmd === 'apply') {
  await apply(positional[0]);
} else if (cmd === 'finish') {
  const counts = {};
  for (const m of lines(path('messages.jsonl')).filter((x) => x.run === run)) counts[m.outcome] = (counts[m.outcome] ?? 0) + 1;
  append('runs.jsonl', { run, event: 'finish', at: now(), counts });
  if (counts.updated || counts.review || counts.failed)
    await notify('Inbox triage', `${counts.updated ?? 0} rows updated, ${counts.review ?? 0} to review, ${counts.failed ?? 0} failed`).catch(() => {});
  print({ run, counts });
} else if (cmd === 'stats') {
  stats();
} else if (cmd === 'review') {
  review(Number(flag('--days') ?? 7));
} else if (cmd === 'eval') {
  await evaluate(positional[0], flag('--outputs'), rest.includes('--live'));
} else {
  console.error('usage: node triage.mjs seen|apply|finish|stats|review|eval (see the top of triage.mjs)');
  process.exit(2);
}

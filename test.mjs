// node --test test.mjs
// Runs on fictional fixtures only. The jt test writes to a temp copy of job-tracker's sample
// workbook, never the real one, and every child process runs with NTFY_TOPIC cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkItem, decide, matchRow, pack, parseJtList, redact, sortMail } from './lib.mjs';
import { CODE, FILES, text } from './make_workflow.mjs';

const here = (p) => new URL(p, import.meta.url);
const jsonl = (p) => readFileSync(here(p), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const MAIL = jsonl('fixtures/mail.jsonl');
const OUT = new Map(jsonl('fixtures/outputs.jsonl').map((o) => [o.id, o]));
const ROWS = parseJtList(readFileSync(here('fixtures/tracker.txt'), 'utf8'));
const TRACKER = fileURLToPath(here('fixtures/tracker.txt'));

// What the workflow hands to triage.mjs: sorted, and checked when it went to the model.
const items = () => sortMail(MAIL, []).map((it) => (it.route === 'model' ? checkItem(OUT.get(it.id), it) : it));
const byId = (id) => items().find((i) => i.id === id);
const outcome = (m) => {
  if (m.route !== 'model') return { action: m.route };
  const match = m.check === 'ok' && m.category !== 'other' ? matchRow(m.company, m.role, m.fromDomain, ROWS) : null;
  return decide(m, match);
};

test('redact removes links, addresses, phones, passwords and codes but keeps dates', () => {
  const t = redact(
    'Interview on 2026-11-25 10:00 or 11/25/2026.\nCall +63 917 555 0142 or (555) 123-4567.\n' +
      'Mail hr@acme.example, see https://acme.example/x?id=9.\nYour password: Hunter2! Code AB12CD34EF, ref 4410293.\n' +
      '\nOn Mon, Nov 17, 2026 at 9:02 AM Someone <a@b.example> wrote:\n> old thread',
  );
  for (const gone of ['0142', '4567', 'hr@acme', 'https://', 'Hunter2', 'AB12CD34EF', '4410293', 'old thread']) assert.ok(!t.includes(gone), gone);
  for (const kept of ['2026-11-25 10:00', '11/25/2026', '[phone]', '[email]', '[link]', 'password: [secret]', '[code]', '[number]']) assert.ok(t.includes(kept), kept);
  assert.equal(redact('x'.repeat(5000)).length, 3000 + ' [cut]'.length);
});

test('sorting keeps security, money, promotions and alerts away from the model', () => {
  const route = Object.fromEntries(items().map((i) => [i.id, i.route]));
  assert.deepEqual(
    Object.entries(route).filter(([, r]) => r !== 'model').map(([id, r]) => `${id}:${r}`),
    ['m07:alert', 'm08:alert', 'm09:skip', 'm10:skip'],
  );
  for (const i of sortMail(MAIL, [])) {
    if (i.route !== 'model') assert.equal(i.text, undefined, `${i.id} must carry no text`);
    else assert.ok(!/https?:|@|0142/.test(i.text), `${i.id} text is redacted`);
  }
  assert.equal(byId('m11').spam, true);
  assert.equal(byId('m01').date, '2026-11-18');
  assert.equal(byId('m01').account, 'applicant.one@example.com');
});

test('messages already handled are dropped, and an empty run still yields one item', () => {
  assert.deepEqual(sortMail(MAIL, MAIL.map((m) => m.id)), [{ id: null, route: 'none', reason: 'no new mail' }]);
  assert.equal(sortMail(MAIL, ['m01']).length, MAIL.length - 1);
  assert.equal(sortMail([{}, ...MAIL.slice(0, 1)], []).length, 1); // Gmail's empty alwaysOutputData item
});

test('the model output check catches made-up quotes, bad dates and missing fields', () => {
  const src = sortMail([MAIL[0]], [])[0];
  const good = OUT.get('m01');
  assert.equal(checkItem(good, src).check, 'ok');
  assert.equal(checkItem(good, src).text, undefined);
  const bad = (patch) => checkItem({ output: { ...good.output, ...patch } }, src).reason;
  assert.match(bad({ category: 'maybe' }), /unknown category/);
  assert.match(bad({ company: '' }), /no company/);
  assert.match(bad({ due_date: '2026-02-30' }), /bad due date/);
  assert.match(bad({ due_date: 'next week' }), /bad due date/);
  assert.match(bad({ evidence: 'We are delighted to hire you.' }), /evidence/);
  assert.match(checkItem({ error: { message: 'quota' } }, src).reason, /model error: quota/);
  assert.match(checkItem({}, src).reason, /no model output/);
  assert.equal(checkItem(good.output, src).check, 'ok', "n8n's chain returns the fields unwrapped");
  assert.match(checkItem({ error: "Model output doesn't fit required format" }, src).reason, /doesn't fit/);
  assert.equal(byId('m16').check, 'failed');
});

test('matching ignores suffixes, falls back to the sender domain and lets the role break ties', () => {
  const row = (c, r = '', d = '') => matchRow(c, r, d, ROWS).row?.row ?? null;
  assert.equal(row('PINECONE ANALYTICS, INC.'), 2);
  assert.equal(row('Burnham Data', 'Data Analyst'), 5);
  assert.equal(row('Burnham Data', 'BI Developer'), 13);
  assert.equal(row('Burnham Data', 'Engineer'), null);
  assert.equal(row('Kennon', '', 'kennonlabs.com'), 4);
  assert.equal(row('Baguio Cloud Works'), null);
  const twice = [...ROWS, { row: 99, company: 'Kennon Labs', role: 'ML Engineer', status: 'Rejected' }];
  assert.equal(matchRow('Kennon Labs', '', '', twice).row.row, 4);
});

test('each fixture gets the right decision', () => {
  const want = {
    m01: ['update', 'set 2 --status Rejected --next-step - --follow-up -'],
    m02: ['update', 'set 4 --status Interview --next-step Confirm the technical interview slot on November 25 at 10:00 AM --follow-up 2026-11-25'],
    m03: ['update', 'set 9 --status Screening --next-step Answer the three screening questions --follow-up 2026-11-22'],
    m04: ['update', 'set 5 --next-step Send Marco the dashboard sample --follow-up 2026-11-21'],
    m05: ['review', /offers/],
    m06: ['update', 'set 11 --status Applied --applied 2026-11-18'],
    m07: ['alert'], m08: ['alert'], m09: ['skip'], m10: ['skip'],
    m11: ['review', /spam/],
    m12: ['review', /gmail\.com doesn't name/],
    m13: ['review', /no row/],
    m14: ['no_change'],
    m15: ['no_change', /already Rejected/],
    m16: ['review', /evidence/],
  };
  for (const m of items()) {
    const d = outcome(m);
    const [action, detail] = want[m.id];
    assert.equal(d.action, action, m.id);
    if (typeof detail === 'string') assert.equal(d.args.join(' '), detail, m.id);
    if (detail instanceof RegExp) assert.match(d.reason, detail, m.id);
  }
  assert.equal(outcome(byId('m02')).alert, 'Interview: Kennon Labs');
  assert.equal(outcome(byId('m05')).alert, 'Offer: Teachers Camp Tech');
});

test('a model that does not answer means try again; a bad answer means review', () => {
  const src = sortMail([MAIL[0]], [])[0];
  for (const res of [{ error: 'Service unavailable' }, { error: "Model output doesn't fit required format" }, {}])
    assert.equal(decide(checkItem(res, src), null).action, 'failed', JSON.stringify(res));
  assert.equal(decide(byId('m16'), null).action, 'review');
});

test('a convincing rejection from an outside domain changes nothing, even in the inbox', () => {
  const m = { ...byId('m11'), spam: false };
  assert.match(outcome(m).reason, /pinecone-careers\.example doesn't name/);
});

test('status never moves backwards and odd statuses go to review', () => {
  const m = byId('m03'); // action_needed
  const at = (status) => decide(m, { row: { row: 9, company: 'Camp John Hay Partners', status } });
  assert.ok(!at('Interview').args.includes('--status'));
  assert.ok(at('Applied').args.includes('Screening'));
  assert.equal(at('On hold').action, 'review');
  assert.equal(at('Offer').action, 'review');
  assert.equal(at('Withdrawn').action, 'review');
});

test('the workflow files are up to date with lib.mjs', () => {
  for (const file of Object.keys(FILES)) assert.equal(readFileSync(here(file), 'utf8'), text(file), `run node make_workflow.mjs (${file})`);
  const demo = JSON.parse(text('workflow.demo.json'));
  assert.ok(demo.nodes.some((n) => n.name === 'Gemini'), 'the demo keeps the live model');
  assert.ok(!demo.nodes.some((n) => n.type === 'n8n-nodes-base.gmail'), 'the demo needs no Gmail');
  for (const n of demo.nodes.filter((x) => x.type === 'n8n-nodes-base.executeCommand')) assert.match(n.parameters.command, /--dry-run --tracker fixtures\/tracker\.txt/);
});

test('the generated Code nodes behave like lib.mjs', () => {
  const node = (code, input, others) =>
    new Function('$input', '$', 'Buffer', code)(
      { all: () => input.map((json) => ({ json })) },
      (name) => others[name],
      Buffer,
    );
  const sorted = node(CODE.sort, MAIL, { 'Seen messages': { first: () => ({ json: { stdout: '{"ids":["m09"]}' } }) } });
  assert.deepEqual(sorted.map((i) => i.json), sortMail(MAIL, ['m09']));
  const src = sortMail([MAIL[1]], [])[0];
  const checked = node(CODE.check, [OUT.get('m02')], { 'To the model?': { itemMatching: () => ({ json: src }) } });
  assert.deepEqual(checked[0].json, checkItem(OUT.get('m02'), src));
  const packed = node(CODE.pack, [checked[0].json], {});
  assert.equal(packed[0].json.b64, pack(checked[0].json));
});

const cli = (args, env = {}) =>
  spawnSync(process.execPath, ['triage.mjs', ...args], {
    cwd: here('.'),
    encoding: 'utf8',
    env: { ...process.env, NTFY_TOPIC: '', INBOX_TRIAGE_DRY: '', ...env },
  });

test('a dry run logs every message and the run totals without touching anything', () => {
  const env = { INBOX_TRIAGE_DATA: mkdtempSync(join(tmpdir(), 'triage-')) };
  assert.deepEqual(JSON.parse(cli(['seen', '--dry-run', '--run', '7'], env).stdout), { ids: [] });
  const outcomes = {};
  for (const m of items()) {
    const r = cli(['apply', '--dry-run', '--run', '7', '--tracker', TRACKER, pack(m)], env);
    assert.equal(r.status, 0, r.stderr);
    outcomes[m.id] = JSON.parse(r.stdout).outcome;
    if (m.id === 'm01') assert.match(r.stderr, /would run: jt set 2 --status Rejected/);
  }
  assert.equal(outcomes.m07, 'alert_only');
  assert.equal(outcomes.m11, 'review');
  const fin = JSON.parse(cli(['finish', '--dry-run', '--run', '7'], env).stdout);
  assert.deepEqual(fin.counts, { updated: 5, review: 5, alert_only: 2, skipped: 2, no_change: 2 });
  const stats = cli(['stats', '--dry-run'], env).stdout;
  assert.match(stats, /Runs: 1 started, 1 finished \(100%\)/);
  assert.match(stats, /Messages: 16\./);
  assert.match(cli(['review', '--dry-run'], env).stdout, /Baguio Cloud Works/);
  assert.deepEqual(JSON.parse(cli(['seen', '--dry-run', '--run', '8'], env).stdout).ids.length, 16);
  assert.ok(!existsSync(join(env.INBOX_TRIAGE_DATA, 'messages.jsonl')), 'dry runs log under dry/');
  assert.equal(JSON.parse(cli(['apply', '--dry-run', '--run', '8', pack({ id: null, route: 'none' })], env).stdout).outcome, 'none');
});

test('the accuracy check scores the fixtures', () => {
  const r = cli(['eval', 'fixtures/mail.jsonl', '--outputs', 'fixtures/outputs.jsonl', '--tracker', TRACKER]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Category: 15\/16/);
  assert.match(r.stdout, /Company: 10\/10/);
  assert.match(r.stdout, /Row: 10\/10/);
  assert.match(r.stdout, /m16: expected confirmation, got failed check/);
});

const JT = 'C:/rust-target/job-tracker/release/jt.exe';
const SAMPLE = fileURLToPath(here('../job-tracker/sample/Sample_Job_Applications.xlsx'));
test('a real run updates a copy of the sample workbook through jt', { skip: !existsSync(JT) || !existsSync(SAMPLE) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-jt-'));
  const book = join(dir, 'sample.xlsx');
  copyFileSync(SAMPLE, book);
  const env = { INBOX_TRIAGE_DATA: dir, JT_FILE: book };
  for (const id of ['m01', 'm02', 'm06', 'm12']) {
    const r = cli(['apply', '--run', '1', pack(byId(id))], env);
    assert.equal(r.status, 0, r.stderr);
  }
  const show = (row) => execFileSync(JT, ['show', String(row), '--file', book], { encoding: 'utf8' });
  assert.match(show(2), /Rejected/);
  assert.match(show(4), /Interview/);
  assert.match(show(4), /2026-11-25/);
  assert.match(show(11), /Applied/);
  assert.match(show(3), /Applied/); // m12 came from gmail.com, so row 3 is untouched
  const log = readFileSync(join(dir, 'messages.jsonl'), 'utf8');
  assert.equal((log.match(/"outcome":"updated"/g) ?? []).length, 3);
});

// Pure logic shared by triage.mjs and the workflow's Code nodes. make_workflow.mjs copies
// these functions into the Code nodes with toString(), so each one may use only its
// arguments, built-ins and the other functions in this file.

// Strip what the model doesn't need and shouldn't see: the quoted thread, links,
// addresses, phone numbers, passwords and anything shaped like a code or ID.
export function redact(text, cap = 3000) {
  let t = String(text ?? '').replace(/\r/g, '');
  const cut = t.search(/\n(On [^\n]{5,200}wrote:|-{2,}\s*Original Message|_{10,}|From: [^\n]+\nSent: )/i);
  if (cut > 0) t = t.slice(0, cut);
  t = t
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join('\n')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b(password|passcode|pin)(\s*(?:is|:)\s*)\S+/gi, '$1$2[secret]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) =>
      m.match(/\d/g).length >= 10 && !/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(m) ? '[phone]' : m)
    .replace(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{8,}\b/g, '[code]')
    .replace(/\b\d{5,}\b/g, '[number]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return t.length > cap ? `${t.slice(0, cap)} [cut]` : t;
}

// skip: never leaves the PC. alert: the owner hears about it, the model never sees it.
export function routeOf(m) {
  const from = String(m.from ?? '').toLowerCase();
  const domain = from.split('@')[1] ?? '';
  const subject = String(m.subject ?? '');
  const labels = m.labelIds ?? [];
  if (labels.some((l) => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].includes(l)))
    return { route: 'skip', reason: 'promotions, social or forums tab' };
  if (/^(alert|jobalerts?)@indeed\.com$|@match\.indeed\.com$|^jobalerts-noreply@linkedin\.com$|^(jobalerts?|jobmail)@([\w-]+\.)*jobstreet\.com/.test(from))
    return { route: 'skip', reason: 'job alert' };
  if (/(^|\.)(paypal\.com|wise\.com|gcash\.com|maya\.ph|paymaya\.com|bpi\.com\.ph|bdo\.com\.ph|unionbankph\.com|metrobank\.com\.ph|securitybank\.com|rcbc\.com|landbank\.com|payoneer\.com|deel\.com|accounts\.google\.com)$/.test(domain))
    return { route: 'alert', reason: 'bank, payment or account sender' };
  if (/password|passcode|verification|verify your|security (alert|code)|sign[- ]?in|log[- ]?in attempt|one[- ]time|\botp\b|2-step|two-step|payment|invoice|receipt|payout|transfer/i.test(subject))
    return { route: 'alert', reason: 'security or money subject' };
  if (/(temporary|new|reset your|your) password|password reset|verification code|security code|one[- ]time (code|password|pin)|\bOTP\b|2-step verification|new sign-in|suspicious (sign-in|activity)|recovery (email|phone)/i.test(String(m.text ?? '')))
    return { route: 'alert', reason: 'security wording in the body' };
  return { route: 'model', reason: '' };
}

// Gmail node items in, one item per new message out. Only items routed to the model
// carry text, and that text is already redacted.
export function sortMail(msgs, seenIds) {
  const seen = new Set(seenIds);
  const addr = (f) =>
    String(typeof f === 'string' ? f : f?.value?.[0]?.address ?? '').toLowerCase().replace(/^.*<|>.*$/g, '').trim();
  const day = (d) => {
    const t = new Date(d);
    return isNaN(t) ? '' : t.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  };
  const out = [];
  for (const m of msgs) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const from = addr(m.from);
    const { route, reason } = routeOf({ ...m, from });
    const item = {
      id: m.id,
      account: addr(m.to),
      from,
      fromDomain: from.split('@')[1] ?? '',
      subject: redact(m.subject, 300),
      date: day(m.date),
      spam: (m.labelIds ?? []).includes('SPAM'),
      route,
      reason,
    };
    out.push(route === 'model' ? { ...item, text: redact(m.text) } : item);
  }
  return out.length ? out : [{ id: null, route: 'none', reason: 'no new mail' }];
}

// Never trust the model's output. Anything that fails here goes to review.
export function checkItem(res, src) {
  const { text, ...base } = src;
  const fail = (reason) => ({ ...base, check: 'failed', reason });
  // n8n's LLM chain puts the parsed fields on the item itself; older versions and the
  // recorded fixtures put them under `output`.
  const o = res?.output && typeof res.output === 'object' ? res.output : res && 'category' in res ? res : null;
  if (!o)
    return fail(res?.error ? `model error: ${String(res.error.message ?? res.error).slice(0, 200)}` : 'no model output');
  const category = String(o.category ?? '').trim().toLowerCase();
  if (!['rejection', 'interview', 'action_needed', 'offer', 'confirmation', 'other'].includes(category))
    return fail(`unknown category "${category}"`);
  const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '').slice(0, n);
  const v = {
    category,
    company: one(o.company, 120),
    role: one(o.role, 160),
    next_step: one(o.next_step, 200),
    due_date: one(o.due_date, 10),
    evidence: one(o.evidence, 400),
  };
  if (category !== 'other' && !v.company) return fail('no company for a job email');
  const real = (s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(d) && d.toISOString().slice(0, 10) === s;
  };
  if (v.due_date && !real(v.due_date)) return fail(`bad due date "${v.due_date}"`);
  const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  if (category !== 'other' && (v.evidence.length < 10 || !norm(`${src.subject}\n${text ?? ''}`).includes(norm(v.evidence))))
    return fail('evidence quote not found in the email');
  return { ...base, ...v, check: 'ok', reason: '' };
}

// The base64 keeps model-derived text out of reach of the shell that runs triage.mjs.
export function pack(m) {
  const { text, ...rest } = m;
  return Buffer.from(JSON.stringify(rest)).toString('base64url');
}

// `jt list --all` lines: row N | company | role | status | applied | next: ... | ...
export function parseJtList(out) {
  return String(out)
    .split(/\r?\n/)
    .map((line) => line.split(' | '))
    .filter((p) => p.length >= 4 && /^row \d+$/.test(p[0]))
    .map((p) => ({ row: Number(p[0].slice(4)), company: p[1], role: p[2], status: p[3] }));
}

export function normCompany(s) {
  const drop = ['inc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'plc', 'pty', 'philippines', 'phils', 'ph', 'the'];
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !drop.includes(w))
    .join(' ');
}

// careers.kennonlabs.com -> kennonlabs, mail.example.com.ph -> example
export function domainLabel(domain) {
  const parts = String(domain ?? '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return '';
  const twoPart = /^(com|co|org|net|gov|edu|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts[parts.length - (twoPart ? 3 : 2)] ?? '';
}

export function domainNames(domain, company) {
  const label = domainLabel(domain);
  const name = normCompany(company).replace(/ /g, '');
  return label.length >= 3 && (label === name || (label.length >= 6 && name.startsWith(label)) || (name.length >= 6 && label.startsWith(name)));
}

// Hiring platforms and applicant tracking systems send mail for many employers.
// Free mail (gmail.com and the like) is deliberately not here: anyone can claim a company from it.
export function trustedSender(domain, company) {
  const d = String(domain ?? '').toLowerCase();
  const platforms = [
    'onlinejobs.ph', 'jobstreet.com', 'jobstreet.com.ph', 'seek.com.au', 'indeed.com', 'linkedin.com', 'upwork.com',
    'contra.com', 'bossjob.ph', 'bossjob.com', 'kalibrr.com', 'himalayas.app', 'freelancer.com', 'myworkday.com',
    'workday.com', 'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com', 'smartrecruiters.com', 'workable.com', 'workablemail.com',
    'breezy.hr', 'bamboohr.com', 'recruitee.com', 'jazzhr.com', 'teamtailor.com', 'jobvite.com', 'icims.com',
  ];
  return platforms.some((p) => d === p || d.endsWith(`.${p}`)) || domainNames(d, company);
}

export function matchRow(company, role, fromDomain, rows) {
  const c = normCompany(company);
  const words = (a, b) => b.length >= 3 && ` ${a} `.includes(` ${b} `);
  let hits = rows.filter((r) => {
    const n = normCompany(r.company);
    return n && c && (n === c || words(n, c) || words(c, n));
  });
  if (!hits.length) hits = rows.filter((r) => domainNames(fromDomain, r.company));
  if (!hits.length) return { row: null, reason: `no row for "${company}"` };
  if (hits.length > 1) {
    const open = hits.filter((r) => !['Rejected', 'Withdrawn'].includes(r.status));
    if (open.length) hits = open;
  }
  if (hits.length > 1) {
    const toks = (s) => new Set(normCompany(s).split(' ').filter((w) => w.length > 2));
    const want = toks(role);
    const scored = hits.map((r) => ({ r, s: [...toks(r.role)].filter((w) => want.has(w)).length }));
    const best = Math.max(...scored.map((x) => x.s));
    const top = scored.filter((x) => x.s === best);
    if (best === 0 || top.length > 1) return { row: null, reason: `${hits.length} rows match "${company}"` };
    hits = [top[0].r];
  }
  return { row: hits[0], reason: '' };
}

// What to do with one checked message and its match: the jt arguments, or why a person
// has to look. Status only moves forward, and offers are always left to the owner.
export function decide(m, match) {
  const label = { interview: 'Interview', action_needed: 'To do', offer: 'Offer' }[m.category];
  const alert = label ? `${label}: ${m.company}` : '';
  const review = (reason) => ({ action: 'review', args: [], alert, reason });
  if (m.check !== 'ok') return { action: 'review', args: [], alert: '', reason: m.reason };
  if (m.category === 'other') return { action: 'no_change', args: [], alert: '', reason: 'not about an application' };
  if (!match?.row) return review(match?.reason || 'no matching row');
  const r = match.row;
  if (m.category === 'offer') return review('offers are left to the owner');
  if (m.category === 'rejection' && r.status === 'Rejected')
    return { action: 'no_change', args: [], alert, reason: `row ${r.row} is already Rejected` };
  if (['Offer', 'Rejected', 'Withdrawn'].includes(r.status)) return review(`row ${r.row} is ${r.status}`);
  const rank = { 'Not applied': 0, Applied: 1, Ghosted: 1, Screening: 2, Interview: 3 };
  if (!(r.status in rank)) return review(`row ${r.row} has status "${r.status}"`);
  if (m.spam) return review('came from the spam folder');
  if (!trustedSender(m.fromDomain, r.company))
    return review(`${m.fromDomain} doesn't name ${r.company} and isn't a hiring platform`);
  const args = [];
  const raise = (status) => rank[status] > rank[r.status] && args.push('--status', status);
  const follow = m.due_date || m.date;
  if (m.category === 'rejection') args.push('--status', 'Rejected', '--next-step', '-', '--follow-up', '-');
  if (m.category === 'interview' || m.category === 'action_needed') {
    raise(m.category === 'interview' ? 'Interview' : 'Screening');
    if (m.next_step) args.push('--next-step', m.next_step);
    if (follow) args.push('--follow-up', follow);
  }
  if (m.category === 'confirmation' && r.status === 'Not applied')
    args.push('--status', 'Applied', ...(m.date ? ['--applied', m.date] : []));
  if (!args.length) return { action: 'no_change', args, alert, reason: `row ${r.row} needs no change` };
  return { action: 'update', args: ['set', String(r.row), ...args], alert, reason: '' };
}

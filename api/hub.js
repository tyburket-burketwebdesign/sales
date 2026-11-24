/* BWD SDR Hub - single API dispatcher. POST /api/hub  { a, token, ...params } */
const C = require('./_lib/core.js');
const sql = C.sql;
const REF_HTML = "<div style=\"font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#1d2a38\">\n<h2 style=\"color:#0e2235;margin:0 0 2px\">Client Referral Program Agreement</h2>\n<p style=\"margin:0 0 10px;color:#5b6b80\">Burket Web Design &middot; (814) 656-8597 &middot; burketwebdesign.com</p>\n<p>This agreement is between Burket Web Design (\"BWD\") and the client named below (\"you\"). It explains how you earn invoice credits for introducing new business to BWD.</p>\n<p><b>1. How you earn a credit.</b> Introduce a business to BWD. If they sign up for a monthly plan and pay their first invoice, you earn an invoice credit equal to their first monthly invoice (for example $500, $750 or $1,250). If they buy a one-time project such as a website, you earn 10% of the project total, up to $500.</p>\n<p><b>2. What counts as a referral.</b> The business must be new to BWD: not a current or past client, and not already in active conversations with us (a meeting or proposal in the last 90 days). Send them through your personal referral link, or tell us about them before they sign. If two people refer the same business, the first one we receive gets the credit.</p>\n<p><b>3. When the credit is applied.</b> The credit is earned once the new client's first invoice is paid in full. We apply it to your next Wave invoice as a \"Referral credit\" line. If a credit is larger than one invoice, the rest carries forward to the following invoices until it is used up.</p>\n<p><b>4. Credit rules.</b> Credits apply only to BWD services. They have no cash value and cannot be transferred or exchanged for cash. Unused credits expire 12 months after they are earned. To use credits, your account must be in good standing, with no balance more than 30 days past due. If your account closes, unused credits end with it.</p>\n<p><b>5. No limit.</b> There is no cap on how many businesses you can refer or how many credits you can earn.</p>\n<p><b>6. How you refer.</b> Refer people you know and believe we can help. Please do not send bulk or unsolicited messages, and do not make promises on BWD's behalf about pricing, results or rankings. You are not an employee or agent of BWD and cannot sign agreements for us.</p>\n<p><b>7. Changes.</b> BWD may update or end the program with 30 days' written notice. Credits you have already earned will be honored.</p>\n<table style=\"width:100%;margin-top:14px;border-collapse:collapse;font-size:11px\"><tr>\n<td style=\"width:50%;vertical-align:top;padding-right:16px\">\n<b>Client</b><br>\nBusiness: <text-field name=\"Business Name\" role=\"Client\" required=\"true\" style=\"width:200px;height:18px;display:inline-block\"></text-field><br>\nName: <text-field name=\"Full Name\" role=\"Client\" required=\"true\" style=\"width:200px;height:18px;display:inline-block\"></text-field><br>\nSignature:<br><signature-field name=\"Signature\" role=\"Client\" required=\"true\" style=\"width:220px;height:56px;display:inline-block\"></signature-field><br>\nDate: <date-field name=\"Date\" role=\"Client\" required=\"true\" style=\"width:120px;height:18px;display:inline-block\"></date-field>\n</td>\n<td style=\"width:50%;vertical-align:top\">\n<b>Burket Web Design</b><br>Ty Burket, Owner<br><br>Your referral link is emailed to you once this is signed.\n</td></tr></table>\n</div>";

module.exports = async function handler(req, res) {
  const ok = d => res.status(200).json({ ok: true, data: d === undefined ? true : d });
  const err = (m, code) => res.status(code || 200).json({ ok: false, error: String(m) });
  if (req.method !== 'POST') return err('POST only', 405);
  let P = req.body || {};
  if (typeof P === 'string') { try { P = JSON.parse(P); } catch (e) { P = {}; } }
  const a = P.a || '';
  try {
    await C.ensureSchema();

    if (a === 'auth.login') {
      const r = await C.login(P.email, P.pass);
      if (!r) return err('Wrong email or password.');
      return ok(r);
    }

    /* ---- public referral form (refer.html), no login ---- */
    if (a === 'ref.public') {
      const p = (await sql`SELECT id, company, contact FROM ref_partners WHERE code=${String(P.code || '').toUpperCase()} AND status='active'`)[0];
      if (!p) return err('That referral link is not active. Ask Ty for a fresh one.');
      const earned = (await sql`SELECT COALESCE(sum(amount) FILTER (WHERE amount>0),0)::numeric AS e, COALESCE(sum(amount),0)::numeric AS b FROM ref_credits WHERE partner_id=${p.id}`)[0];
      const n = (await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('won','paid'))::int AS w FROM referrals WHERE partner_id=${p.id}`)[0];
      return ok({ company: p.company, first: String(p.contact || '').split(' ')[0], earned: earned.e, balance: earned.b, sent: n.n, won: n.w });
    }
    if (a === 'ref.submit') {
      const p = (await sql`SELECT * FROM ref_partners WHERE code=${String(P.code || '').toUpperCase()} AND status='active'`)[0];
      if (!p) return err('That referral link is not active. Ask Ty for a fresh one.');
      const biz = String(P.business || '').trim().slice(0, 120), contact = String(P.contact || '').trim().slice(0, 80);
      const phone = C.normPhone(P.phone) || '', email = String(P.email || '').trim().slice(0, 120);
      if (biz.length < 2) return err('What is the business name?');
      if (!phone && !/@/.test(email)) return err('Add a phone number or email so we can reach them.');
      const today = (await sql`SELECT count(*)::int AS n FROM referrals WHERE partner_id=${p.id} AND ts > now() - interval '1 day'`)[0].n;
      if (today >= 15) return err('That is a lot of referrals for one day. Text Ty at (814) 656-8597 and he will take it from there.');
      const r = (await sql`INSERT INTO referrals (partner_id, business, contact, phone, email, note, source) VALUES (${p.id}, ${biz}, ${contact}, ${phone}, ${email}, ${String(P.note || '').slice(0, 500)}, 'link') RETURNING id`)[0];
      const owner = (await sql`SELECT email FROM users WHERE role='owner' ORDER BY created LIMIT 1`)[0];
      if (phone) {
        await C.upsertCompany({ phone, name: biz, email, rep: owner ? owner.email : '' });
        await sql`INSERT INTO company_notes (phone, author, note) VALUES (${phone}, 'referral', ${'Referred by ' + p.company + (contact ? ' · contact: ' + contact : '') + (P.note ? ' · ' + String(P.note).slice(0, 200) : '')})`;
      }
      const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
      if (mailTo) C.sendMail(mailTo, '🤝 New referral from ' + p.company + ': ' + biz,
        '<p><b>' + p.company + '</b> just referred <b>' + biz + '</b>.</p><p>' + [contact, phone, email].filter(Boolean).join(' &middot; ') + '</p>' + (P.note ? '<p>' + String(P.note).slice(0, 500) + '</p>' : '') +
        '<p>Call them today. It is in the hub under Referral Program.</p>').catch(() => {});
      return ok({ id: r.id });
    }

    if (a === 'auth.invite.check') {
      const inv = (await sql`SELECT email, name FROM invites WHERE token=${String(P.inviteToken || '')} AND used=0 AND ts > now() - interval '14 days'`)[0];
      if (!inv) return err('That invite link is no longer valid. Ask Ty to send a fresh one.');
      return ok({ email: inv.email, name: inv.name });
    }
    if (a === 'auth.invite.accept') {
      const inv = (await sql`SELECT * FROM invites WHERE token=${String(P.inviteToken || '')} AND used=0 AND ts > now() - interval '14 days'`)[0];
      if (!inv) return err('That invite link is no longer valid. Ask Ty to send a fresh one.');
      const name = String(P.name || inv.name || '').trim();
      if (name.length < 2) return err('What is your name?');
      if (String(P.pass || '').length < 8) return err('Password needs at least 8 characters.');
      await sql`INSERT INTO users (email, name, role, pass, active) VALUES (${inv.email}, ${name}, 'sdr', ${C.hashPass(P.pass)}, 1)
                ON CONFLICT (email) DO UPDATE SET name=${name}, pass=${C.hashPass(P.pass)}, active=1`;
      await sql`UPDATE invites SET used=1 WHERE token=${inv.token}`;
      const r = await C.login(inv.email, P.pass);
      const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
      if (mailTo) C.sendMail(mailTo, name + ' just activated their seat',
        '<p><b>' + name + '</b> (' + inv.email + ') accepted the invite and is in the hub.</p>').catch(() => {});
      return ok(r);
    }

    const user = await C.userFromToken(P.token);
    if (!user) return err('AUTH');
    const OWNER = user.role === 'owner';

    /* ---------------- BOOTSTRAP ---------------- */
    if (a === 'bootstrap') {
      const today = await sql`SELECT * FROM calls WHERE rep=${user.email} AND ts::date = CURRENT_DATE ORDER BY ts`;
      const fups = await sql`
        SELECT DISTINCT ON (phone) * FROM calls
        WHERE (CASE WHEN COALESCE(fup_rep,'') <> '' THEN fup_rep ELSE rep END) = ${user.email}
          AND fup IS NOT NULL AND fup <= CURRENT_DATE AND fup_done=false
          AND outcome NOT IN ('meeting','dnc')
        ORDER BY phone, ts DESC`;
      const fourteen = await sql`
        SELECT ts::date AS d, count(*)::int AS n FROM calls
        WHERE rep=${user.email} AND ts > now() - interval '14 days' GROUP BY 1`;
      const totals = await sql`
        SELECT count(*)::int AS dials,
               count(*) FILTER (WHERE outcome='meeting')::int AS meetings
        FROM calls WHERE rep=${user.email}`;
      const myDeals = await sql`SELECT * FROM deals WHERE rep=${user.email} ORDER BY ts DESC LIMIT 100`;
      const myLedger = await sql`SELECT * FROM ledger WHERE rep=${user.email} ORDER BY ts DESC LIMIT 200`;
      const mySeqs = OWNER
        ? await sql`SELECT s.*, u.name AS rep_name FROM seqs s LEFT JOIN users u ON u.email = s.rep ORDER BY s.started DESC LIMIT 150`
        : await sql`SELECT s.*, u.name AS rep_name FROM seqs s LEFT JOIN users u ON u.email = s.rep WHERE s.rep=${user.email} ORDER BY s.started DESC LIMIT 100`;
      const seqIds = mySeqs.map(x => x.id);
      const seqLog = seqIds.length ? await sql`SELECT seq_id, step, subject, ts FROM emails_log WHERE seq_id = ANY(${seqIds}) ORDER BY ts` : [];
      const myMeetings = await sql`SELECT * FROM meetings WHERE rep=${user.email} OR ${OWNER} ORDER BY meet_date DESC NULLS LAST, ts DESC LIMIT 100`;
      let team = null;
      if (OWNER) {
        team = {};
        team.pending = await sql`SELECT * FROM deals WHERE status='pending' ORDER BY ts`;
        team.reps = await sql`
          SELECT u.email, u.name,
            count(c.*) FILTER (WHERE c.ts::date = CURRENT_DATE)::int AS dials_today,
            count(c.*) FILTER (WHERE c.outcome='meeting' AND c.ts::date = CURRENT_DATE)::int AS meet_today,
            count(c.*) FILTER (WHERE c.ts > now() - interval '7 days')::int AS dials_7d,
            count(c.*) FILTER (WHERE c.outcome='meeting' AND c.ts > now() - interval '7 days')::int AS meet_7d,
            count(c.*)::int AS dials_all,
            count(c.*) FILTER (WHERE c.outcome='meeting')::int AS meet_all
          FROM users u LEFT JOIN calls c ON c.rep = u.email
          GROUP BY u.email, u.name ORDER BY u.role DESC`;
        team.ledger = await sql`SELECT * FROM ledger ORDER BY ts DESC LIMIT 300`;
        team.deals = await sql`SELECT * FROM deals ORDER BY ts DESC LIMIT 200`;
        team.seqs = await sql`SELECT * FROM seqs ORDER BY started DESC LIMIT 100`;
        team.emails7 = (await sql`SELECT count(*)::int AS n FROM emails_log WHERE ts > now() - interval '7 days'`)[0].n;
        team.mrr = (await sql`SELECT COALESCE(sum(monthly),0)::numeric AS m FROM deals WHERE status='approved' AND kind='recurring' AND cancelled_ts IS NULL`)[0].m;
        team.onetime = (await sql`SELECT COALESCE(sum(amount),0)::numeric AS m FROM deals WHERE status='approved' AND kind='one_time'`)[0].m;
        team.objections = await sql`SELECT obj, count(*)::int AS n FROM calls WHERE obj <> '' AND ts > now() - interval '30 days' GROUP BY obj ORDER BY n DESC`;
      }
      const closedMonth = (await sql`SELECT count(*)::int AS n FROM deals WHERE rep=${user.email} AND status='approved' AND reviewed_ts >= date_trunc('month', now())`)[0].n;
      const pipeline = await sql`SELECT stage, count(*)::int AS n FROM companies GROUP BY stage`;
      const waveReady = {};
      C.PRODUCTS.forEach(p => { if (C.waveLink(p.id)) waveReady[p.id] = true; });
      return ok({ user, products: C.PRODUCTS, today, fups, fourteen, totals: totals[0],
                  deals: myDeals, ledger: myLedger, seqs: mySeqs, seqLog: seqLog, seqGaps: C.SEQ_GAPS,
                  mailInfo: { replyTo: C.prospectReplyTo(), bcc: C.prospectBcc() }, meetings: myMeetings, team, auditUrl: C.auditUrl(),
                  twilio: { enabled: C.twilioReady(), numbers: C.twilioNumbers(), callerId: C.callerFor(user) },
                  territory: C.territoryFor(user),
                  planMonth: ((await sql`SELECT v FROM kv WHERE k='plan_month'`)[0] || {}).v || 'auto',
                  kpi: { target: C.kpiTarget(), bonus: C.kpiBonus(), closedMonth: closedMonth },
                  pipeline: pipeline, waveReady: waveReady,
                  docuseal: !!process.env.DOCUSEAL_API_KEY });
    }

    /* ---------------- PROSPECTING ---------------- */
    if (a === 'hunt') {
      const q = (P.industry || 'businesses') + ' in ' + (P.city || 'Tampa') + ', Florida';
      const found = await C.placesSearch(q);
      const phones = [];
      const items = [];
      const seenHere = {};
      for (const b of found) {
        const np = C.normPhone(b.phone);
        if (!np || seenHere[np]) continue;
        if (C.isChain(b.name)) continue;
        seenHere[np] = true;
        b.phone = np;
        phones.push(np);
        items.push(b);
      }
      let known = {};
      if (phones.length) {
        const prior = await sql`SELECT DISTINCT phone FROM calls WHERE phone = ANY(${phones})`;
        const blocked = await sql`SELECT phone FROM dnc WHERE phone = ANY(${phones})`;
        prior.forEach(r => known[r.phone] = true);
        blocked.forEach(r => known[r.phone] = true);
      }
      const fresh = items.filter(b => !known[b.phone]).slice(0, 50);
      return ok({ list: fresh, skipped: items.length - fresh.length });
    }

    /* ---------------- QUALIFIED LIST BUILDER ----------------
     * Businesses losing to the top three but close enough to move:
     * positions 4-12, review band, storm-zone excluded, deduped by place id. */
    if (a === 'listbuild') {
      const vertical = String(P.vertical || '').trim();
      if (!vertical) return err('What service? e.g. pool resurfacing and repair');
      const metros = (Array.isArray(P.metros) ? P.metros : String(P.metros || '').split(','))
        .map(x => String(x).trim()).filter(Boolean).slice(0, 8);
      if (!metros.length) return err('At least one metro, e.g. Tampa FL, Orlando FL');
      const maxReviews = Number(P.maxReviews) || 120;
      const minReviews = P.minReviews == null ? 3 : Number(P.minReviews);
      const target = Number(P.target) || 25;
      const seenIds = {};
      const out = [];
      const notes = [];
      for (const metro of metros) {
        if (out.length >= target) break;
        let loc;
        try { loc = await C.geocodeCity(metro); }
        catch (e) { notes.push(metro + ': ' + e.message); continue; }
        let results;
        try { results = await C.placesBiased(vertical + ' in ' + metro, loc.lat, loc.lng, 35000); }
        catch (e) { notes.push(metro + ': ' + e.message); continue; }
        for (const b of results) {
          if (b.status !== 'OPERATIONAL') continue;          // closed or moved
          if (b.pos <= 3) continue;                          // already winning, nothing to sell
          if (b.pos > 12) continue;                          // too far back to move cheaply
          if (b.reviews > maxReviews) continue;              // established, does not feel the problem
          if (b.reviews < minReviews) continue;              // dead or unclaimed listing
          if (C.inStormZone(b.addr)) continue;               // storm backlog, revisit in January
          if (!b.id || seenIds[b.id]) continue;              // service areas overlap metros
          seenIds[b.id] = true;
          const np = C.normPhone(b.phone);
          if (!np) continue;                                 // cannot call what has no number
          let why;
          if (b.reviews < 25) why = 'only ' + b.reviews + ' reviews';
          else if (!b.website) why = 'no website on the profile';
          else if (b.rating > 0 && b.rating < 4.3) why = 'rating ' + b.rating.toFixed(1);
          else why = 'ranked #' + b.pos + ', close enough to catch the top three';
          out.push({ name: b.name, phone: np, website: b.website, rating: b.rating, reviews: b.reviews,
                     pos: b.pos, addr: b.addr, maps: b.maps, town: metro, src: 'google', why: why });
        }
      }
      out.sort((x, y) => x.reviews - y.reviews);              // lowest counts are the fastest wins
      const phones = out.map(b => b.phone);
      let known = {};
      if (phones.length) {
        (await sql`SELECT DISTINCT phone FROM calls WHERE phone = ANY(${phones})`).forEach(r => known[r.phone] = true);
        (await sql`SELECT phone FROM dnc WHERE phone = ANY(${phones})`).forEach(r => known[r.phone] = true);
      }
      const fresh = (await C.cleanLeads(sql, out.filter(b => !known[b.phone]), vertical)).slice(0, target);
      return ok({ list: fresh, skipped: out.length - fresh.length, notes: notes });
    }

    /* ---------------- LISTING CALLS: businesses buying shared leads ---------------- */
    /* ================= PLATFORM: search, notifications, deal values (all seats) ================= */
    const audit = (act, target, detail) => sql`INSERT INTO audit (who, act, target, detail) VALUES (${user.email}, ${act}, ${String(target || '').slice(0, 200)}, ${String(detail || '').slice(0, 500)})`.catch(() => {});
    if (a === 'search') {
      const q = String(P.q || '').trim(); if (q.length < 2) return ok({ companies: [], clients: [], invoices: [] });
      const like = '%' + q.toLowerCase() + '%', digits = q.replace(/\D/g, '');
      const companies = await sql`SELECT phone, name, city, industry, stage, rep FROM companies
        WHERE lower(name) LIKE ${like} OR lower(city) LIKE ${like} OR (${digits.length >= 3} AND phone LIKE ${'%' + digits + '%'}) ORDER BY updated DESC LIMIT 8`;
      let clients = [], invoices = [];
      if (OWNER) {
        clients = await sql`SELECT id, name, status, mrr FROM clients WHERE lower(name) LIKE ${like} OR lower(contact) LIKE ${like} OR lower(email) LIKE ${like} ORDER BY name LIMIT 6`;
        invoices = await sql`SELECT i.id, i.number, i.amount, i.status, i.client_id, c.name AS client FROM invoices i JOIN clients c ON c.id=i.client_id
          WHERE i.number LIKE ${'%' + q + '%'} OR lower(c.name) LIKE ${like} ORDER BY i.issued DESC NULLS LAST LIMIT 6`;
      }
      return ok({ companies, clients, invoices });
    }
    if (a === 'notify') {
      const items = [];
      const missed = await sql`SELECT count(*)::int AS n FROM inbound WHERE status='missed' AND (${OWNER} OR rep='' OR rep=${user.email})`;
      if (missed[0].n) items.push({ k: 'missed', icon: '📞', text: missed[0].n + ' missed call' + (missed[0].n === 1 ? '' : 's') + ' to return', view: 'dialer', tone: 'red' });
      const fups = await sql`SELECT count(DISTINCT phone)::int AS n FROM calls WHERE (CASE WHEN COALESCE(fup_rep,'') <> '' THEN fup_rep ELSE rep END)=${user.email} AND fup IS NOT NULL AND fup <= CURRENT_DATE AND fup_done=false`;
      if (fups[0].n) items.push({ k: 'fups', icon: '🔁', text: fups[0].n + ' follow-up' + (fups[0].n === 1 ? '' : 's') + ' due', view: 'past', tone: 'gold' });
      const tk = await sql`SELECT count(*)::int AS n FROM tasks WHERE status='open' AND due <= CURRENT_DATE AND (${OWNER} OR assignee=${user.email})`;
      if (tk[0].n) items.push({ k: 'tasks', icon: '✅', text: tk[0].n + ' task' + (tk[0].n === 1 ? '' : 's') + ' due or late', view: 'tasks', tone: 'gold' });
      if (OWNER) {
        const pend = (await sql`SELECT count(*)::int AS n FROM deals WHERE status='pending'`)[0].n;
        if (pend) items.push({ k: 'deals', icon: '⏳', text: pend + ' deal' + (pend === 1 ? '' : 's') + ' waiting for approval', view: 'owner', tone: 'gold' });
        const od = (await sql`SELECT count(*)::int AS n, COALESCE(sum(amount_due),0)::numeric AS v FROM invoices WHERE status='open' AND due < CURRENT_DATE`)[0];
        if (od.n) items.push({ k: 'overdue', icon: '🧾', text: od.n + ' overdue invoice' + (od.n === 1 ? '' : 's') + ' ($' + Number(od.v).toLocaleString() + ')', view: 'billing', tone: 'red' });
        const paid = await sql`SELECT c.name, i.amount FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.status='paid' AND i.paid_date >= CURRENT_DATE - 3 ORDER BY i.paid_date DESC LIMIT 5`;
        paid.forEach(p => items.push({ k: 'paid', icon: '💵', text: p.name + ' paid $' + Number(p.amount).toLocaleString(), view: 'billing', tone: 'green' }));
        const refs = (await sql`SELECT count(*)::int AS n FROM referrals WHERE status='submitted'`)[0].n;
        if (refs) items.push({ k: 'refs', icon: '🤝', text: refs + ' new referral' + (refs === 1 ? '' : 's'), view: 'refer', tone: 'green' });
        const drafts = (await sql`SELECT count(*)::int AS n FROM invoices WHERE status='draft'`)[0].n;
        if (drafts) items.push({ k: 'drafts', icon: '📝', text: drafts + ' Wave draft invoice' + (drafts === 1 ? '' : 's') + ' not sent yet', view: 'billing', tone: 'gold' });
      }
      return ok(items);
    }
    if (a === 'company.value') {
      const phone = C.normPhone(P.phone);
      const cur = (await sql`SELECT rep FROM companies WHERE phone=${phone}`)[0];
      if (!cur) return err('Company not found.');
      if (!OWNER && cur.rep && cur.rep !== user.email) return err('Only the rep working this account can set its value.');
      await sql`UPDATE companies SET value=${Number(String(P.value || 0).replace(/[^\d.]/g, '')) || 0}, updated=now() WHERE phone=${phone}`;
      return ok(true);
    }

    /* ================= OWNER: settings, audit, reports, activity, Wave write ================= */
    if (a.indexOf('own.') === 0 || a.indexOf('wave.') === 0) {
      if (!OWNER) { audit('blocked', a); return err('Owner only.'); }
      const getSettings = async () => { try { return JSON.parse(((await sql`SELECT v FROM kv WHERE k='settings'`)[0] || {}).v || '{}'); } catch (e) { return {}; } };
      if (a === 'own.settings') return ok(await getSettings());
      if (a === 'own.settings.save') {
        const cur = await getSettings(); const nx = Object.assign(cur, P.settings || {});
        await sql`INSERT INTO kv (k, v) VALUES ('settings', ${JSON.stringify(nx)}) ON CONFLICT (k) DO UPDATE SET v=${JSON.stringify(nx)}`;
        audit('settings.save', '', Object.keys(P.settings || {}).join(','));
        return ok(nx);
      }
      if (a === 'own.audit') return ok(await sql`SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.email=a.who ORDER BY a.ts DESC LIMIT 300`);
      if (a === 'own.team') {
        return ok(await sql`SELECT u.email, u.name, u.role, COALESCE(u.active,1) AS active,
          (SELECT max(ts) FROM calls c WHERE c.rep=u.email) AS last_call,
          (SELECT count(*)::int FROM calls c WHERE c.rep=u.email AND c.ts > now() - interval '30 days') AS calls30
          FROM users u ORDER BY u.role DESC, u.name`);
      }
      if (a === 'own.role') {
        const em = String(P.email || '').toLowerCase(), role = P.role === 'owner' ? 'owner' : 'sdr';
        if (em === user.email && role !== 'owner') return err('You cannot remove your own owner access.');
        await sql`UPDATE users SET role=${role} WHERE email=${em}`; audit('role', em, role);
        return ok(true);
      }
      if (a === 'own.reports') {
        const billedM = await sql`SELECT to_char(date_trunc('month', issued),'YYYY-MM') AS m, sum(amount)::numeric AS v,
            COALESCE(sum(amount) FILTER (WHERE recurring_id <> ''),0)::numeric AS rec FROM invoices
          WHERE status IN ('open','paid') AND issued >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`;
        const rev = await sql`SELECT to_char(date_trunc('month', paid_date),'YYYY-MM') AS m, sum(amount)::numeric AS v, count(*)::int AS n FROM invoices
          WHERE status='paid' AND paid_date >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`;
        const byClient = await sql`SELECT c.id, c.name, c.status, c.mrr, COALESCE(sum(i.amount) FILTER (WHERE i.status='paid'),0)::numeric AS ltv,
            COALESCE(sum(i.amount) FILTER (WHERE i.status='paid' AND i.paid_date >= date_trunc('year', now())),0)::numeric AS ytd,
            COALESCE(sum(i.amount) FILTER (WHERE i.status IN ('open','paid') AND i.issued >= current_date - 365),0)::numeric AS billed12,
            ROUND(AVG(i.paid_date - i.issued) FILTER (WHERE i.status='paid'))::int AS days_to_pay
          FROM clients c LEFT JOIN invoices i ON i.client_id=c.id GROUP BY c.id ORDER BY ltv DESC`;
        const aging = (await sql`SELECT
            COALESCE(sum(amount_due) FILTER (WHERE due >= CURRENT_DATE),0)::numeric AS current,
            COALESCE(sum(amount_due) FILTER (WHERE CURRENT_DATE - due BETWEEN 1 AND 30),0)::numeric AS d30,
            COALESCE(sum(amount_due) FILTER (WHERE CURRENT_DATE - due BETWEEN 31 AND 60),0)::numeric AS d60,
            COALESCE(sum(amount_due) FILTER (WHERE CURRENT_DATE - due BETWEEN 61 AND 90),0)::numeric AS d90,
            COALESCE(sum(amount_due) FILTER (WHERE CURRENT_DATE - due > 90),0)::numeric AS d90p
          FROM invoices WHERE status='open'`)[0];
        const funnel = (await sql`SELECT count(*)::int AS dials,
            count(*) FILTER (WHERE outcome IN ('callback','meeting','closed','not_interested','gatekeeper'))::int AS convos,
            count(*) FILTER (WHERE outcome='meeting')::int AS meetings, count(*) FILTER (WHERE outcome='closed')::int AS closed
          FROM calls WHERE ts > now() - interval '30 days'`)[0];
        const won30 = (await sql`SELECT count(*)::int AS n FROM deals WHERE status='approved' AND reviewed_ts > now() - interval '30 days'`)[0].n;
        const reps = await sql`SELECT u.name, u.email, count(c.id)::int AS dials,
            count(c.id) FILTER (WHERE c.outcome IN ('callback','meeting','closed','not_interested','gatekeeper'))::int AS convos,
            count(c.id) FILTER (WHERE c.outcome='meeting')::int AS meetings,
            (SELECT count(*)::int FROM deals d WHERE d.rep=u.email AND d.status='approved' AND d.reviewed_ts > now() - interval '30 days') AS won
          FROM users u LEFT JOIN calls c ON c.rep=u.email AND c.ts > now() - interval '30 days' WHERE COALESCE(u.active,1)=1 GROUP BY u.name, u.email ORDER BY dials DESC`;
        const growth = await sql`SELECT to_char(date_trunc('month', start_date),'YYYY-MM') AS m, count(*)::int AS n FROM clients WHERE start_date >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`;
        const churn = await sql`SELECT c.name, max(l.ts) AS ts FROM clients c JOIN client_log l ON l.client_id=c.id AND (l.note LIKE 'Status:%churned' OR l.note LIKE 'Marked churned%') WHERE c.status='churned' GROUP BY c.name ORDER BY 2 DESC LIMIT 12`;
        const lost = await sql`SELECT lower(trim(lost_reason)) AS r, count(*)::int AS n FROM companies WHERE stage='lost' AND lost_reason <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`;
        const pipe = await sql`SELECT stage, count(*)::int AS n, COALESCE(sum(value),0)::numeric AS v FROM companies GROUP BY stage`;
        return ok({ rev, billedM, byClient, aging, funnel, won30, reps, growth, churn, lost, pipe });
      }
      if (a === 'own.activity') {
        const rows = await sql`(SELECT 'call' AS k, c.ts, COALESCE(u.name, c.rep) AS who, c.name || ': ' || replace(c.outcome,'_',' ') AS text, NULL::int AS client_id, c.phone FROM calls c LEFT JOIN users u ON u.email=c.rep ORDER BY c.ts DESC LIMIT 25)
          UNION ALL (SELECT 'client', l.ts, COALESCE(u.name, l.author), c.name || ': ' || l.note, c.id, NULL FROM client_log l JOIN clients c ON c.id=l.client_id LEFT JOIN users u ON u.email=l.author ORDER BY l.ts DESC LIMIT 25)
          UNION ALL (SELECT 'deal', d.ts, COALESCE(u.name, d.rep), 'Deal ' || d.status || ': ' || d.business || ' ($' || d.amount || ')', NULL, NULL FROM deals d LEFT JOIN users u ON u.email=d.rep ORDER BY d.ts DESC LIMIT 10)
          UNION ALL (SELECT 'referral', r.ts, p.company, 'Referral: ' || r.business, NULL, NULL FROM referrals r LEFT JOIN ref_partners p ON p.id=r.partner_id ORDER BY r.ts DESC LIMIT 10)
          ORDER BY 2 DESC LIMIT 60`;
        return ok(rows);
      }

      /* ---- Wave: two-way ---- */
      if (a === 'wave.pnl') {
        const { accts, today } = await C.waveLedger(sql);
        const sum = k => accts.filter(x => x.kind === k).reduce((s, x) => s + x.balance, 0);
        const life = { income: sum('income'), cogs: sum('cogs'), opex: sum('opex') };
        let base = null; try { base = JSON.parse(((await sql`SELECT v FROM kv WHERE k='pnl_base'`)[0] || {}).v || 'null'); } catch (e) {}
        if (P.calibrate) {
          /* Ty's Wave P&L for the year so far: opening (Jan 1) = lifetime now minus year to date */
          const y = { income: Number(P.income) || 0, cogs: Number(P.cogs) || 0, opex: Number(P.opex) || 0 };
          base = { year: today.slice(0, 4), set: today, income: life.income - y.income, cogs: life.cogs - y.cogs, opex: life.opex - y.opex,
                   accts: Object.fromEntries(accts.map(x => [x.id, x.balance])) };
          await sql`INSERT INTO kv (k, v) VALUES ('pnl_base', ${JSON.stringify(base)}) ON CONFLICT (k) DO UPDATE SET v=${JSON.stringify(base)}`;
          audit('pnl.calibrate', '', JSON.stringify(y));
        }
        /* month to date from the snapshot taken at the end of last month (when we have one) */
        const mStart = today.slice(0, 8) + '01';
        const prevSnap = await sql`SELECT kind, sum(balance)::numeric AS b FROM acct_snap WHERE day = (SELECT max(day) FROM acct_snap WHERE day < ${mStart}) GROUP BY kind`;
        const prev = Object.fromEntries(prevSnap.map(r => [r.kind, Number(r.b)]));
        const mtd = prevSnap.length ? { income: life.income - (prev.income || 0), cogs: life.cogs - (prev.cogs || 0), opex: life.opex - (prev.opex || 0) } : null;
        let ytd = base && base.year === today.slice(0, 4) ? { income: life.income - base.income, cogs: life.cogs - base.cogs, opex: life.opex - base.opex } : null;
        if (!ytd) {   /* new year: the last snapshot of last year is the opening balance */
          const ys = await sql`SELECT kind, sum(balance)::numeric AS b FROM acct_snap WHERE day = (SELECT max(day) FROM acct_snap WHERE day < ${today.slice(0, 4) + '-01-01'}) GROUP BY kind`;
          if (ys.length) { const y = Object.fromEntries(ys.map(r => [r.kind, Number(r.b)])); ytd = { income: life.income - (y.income || 0), cogs: life.cogs - (y.cogs || 0), opex: life.opex - (y.opex || 0) }; }
        }
        const since = base ? accts.filter(x => x.kind === 'income').map(x => ({ name: x.name, v: x.balance - ((base.accts || {})[x.id] || 0) })).filter(x => Math.abs(x.v) > 0.005) : [];
        const firstSnap = ((await sql`SELECT to_char(min(day),'YYYY-MM-DD') AS d FROM acct_snap`)[0] || {}).d;
        return ok({ ytd, mtd, life, base: base ? { set: base.set, year: base.year } : null, firstSnap, since,
          incomeAccts: accts.filter(x => x.kind === 'income' && Math.abs(x.balance) > 0.005).map(x => ({ name: x.name, life: x.balance })).sort((a, b) => b.life - a.life) });
      }
      if (a === 'wave.meta') { const m = await C.waveMeta(sql); m.settings = await getSettings(); return ok(m); }
      if (a === 'wave.customer.ensure') {
        const c = (await sql`SELECT * FROM clients WHERE id=${Number(P.client_id) || 0}`)[0];
        if (!c) return err('Client not found.');
        if (c.wave_id) return ok({ wave_id: c.wave_id, created: false });
        const cu = await C.waveCustomerCreate(sql, c);
        await sql`UPDATE clients SET wave_id=${cu.id} WHERE id=${c.id}`;
        await sql`INSERT INTO client_log (client_id, author, note) VALUES (${c.id}, ${user.email}, 'Created as a customer in Wave')`;
        audit('wave.customer', c.name);
        return ok({ wave_id: cu.id, created: true });
      }
      if (a === 'wave.invoice.create') {
        const c = (await sql`SELECT * FROM clients WHERE id=${Number(P.client_id) || 0}`)[0];
        if (!c) return err('Pick the client.');
        const items = (Array.isArray(P.items) ? P.items : []).filter(i => i.productId && Number(i.unitPrice) >= 0 && Number(i.quantity) > 0);
        if (!items.length) return err('Add at least one line item.');
        let custId = c.wave_id;
        if (!custId) { custId = (await C.waveCustomerCreate(sql, c)).id; await sql`UPDATE clients SET wave_id=${custId} WHERE id=${c.id}`; }
        const discount = Math.max(0, Number(P.discount) || 0);
        let inv = await C.waveInvoiceCreate(sql, { customerId: custId, items, discount, discountName: P.discountName, invoiceDate: P.invoiceDate, dueDate: P.dueDate, memo: P.memo, title: P.title });
        let sent = false;
        if (P.send) {
          if (!/@/.test(String(P.to || ''))) return err('Add the email address to send it to.');
          await C.waveInvoiceApprove(inv.id);
          inv = await C.waveInvoiceSend({ invoiceId: inv.id, to: P.to, subject: P.subject, message: P.message, ccMyself: P.ccMyself });
          sent = true;
          if (P.to && !c.email) await sql`UPDATE clients SET email=${P.to} WHERE id=${c.id}`;
        }
        const lid = await C.waveUpsertInvoice(sql, inv, c.id);
        if (sent) await sql`UPDATE invoices SET sent_ts=now() WHERE id=${lid}`;
        if (discount > 0 && P.useCredit) {
          const p = (await sql`SELECT id FROM ref_partners WHERE lower(company)=lower(${c.name})`)[0];
          if (p) await sql`INSERT INTO ref_credits (partner_id, amount, note, author) VALUES (${p.id}, ${-discount}, ${'Applied on Wave invoice #' + (inv.invoiceNumber || '')}, ${user.email})`;
        }
        await sql`INSERT INTO client_log (client_id, author, note) VALUES (${c.id}, ${user.email}, ${(sent ? 'Invoice sent from Wave' : 'Invoice saved as a Wave draft') + ': #' + (inv.invoiceNumber || '') + ' $' + Number(inv.total.value) + (sent ? ' to ' + P.to : '')})`;
        audit(sent ? 'wave.invoice.send' : 'wave.invoice.draft', c.name, '#' + (inv.invoiceNumber || '') + ' $' + Number(inv.total.value));
        return ok({ id: lid, number: inv.invoiceNumber, total: Number(inv.total.value), sent, viewUrl: inv.viewUrl });
      }
      if (a === 'wave.invoice.send') {
        const r = (await sql`SELECT i.*, c.email AS cemail, c.name AS cname FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=${Number(P.id) || 0}`)[0];
        if (!r || !r.wave_id) return err('This invoice is not linked to Wave.');
        const to = String(P.to || r.cemail || '');
        if (!/@/.test(to)) return err('No email on file for ' + r.cname + '.');
        if (r.wave_status === 'DRAFT' || r.wave_status === 'SAVED' || r.status === 'draft') await C.waveInvoiceApprove(r.wave_id);
        const inv = await C.waveInvoiceSend({ invoiceId: r.wave_id, to, subject: P.subject, message: P.message, ccMyself: P.ccMyself });
        await C.waveUpsertInvoice(sql, inv, r.client_id);
        await sql`UPDATE invoices SET sent_ts=now() WHERE id=${r.id}`;
        await sql`INSERT INTO client_log (client_id, author, note) VALUES (${r.client_id}, ${user.email}, ${(P.reminder ? 'Payment reminder sent' : 'Invoice sent') + ': #' + r.number + ' to ' + to})`;
        audit(P.reminder ? 'wave.reminder' : 'wave.invoice.send', r.cname, '#' + r.number);
        return ok(true);
      }
      if (a === 'wave.invoice.pay') {
        const r = (await sql`SELECT i.*, c.name AS cname FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=${Number(P.id) || 0}`)[0];
        if (!r || !r.wave_id) return err('This invoice is not linked to Wave.');
        const amt = Number(P.amount) || Number(r.amount_due) || Number(r.amount);
        await C.wavePaymentCreate({ invoiceId: r.wave_id, accountId: P.accountId, amount: amt, date: String(P.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10), method: P.method, memo: P.memo });
        const inv = await C.waveInvoiceGet(sql, r.wave_id);
        if (inv) await C.waveUpsertInvoice(sql, inv, r.client_id);
        await sql`INSERT INTO client_log (client_id, author, note) VALUES (${r.client_id}, ${user.email}, ${'Payment recorded in Wave: $' + amt + ' on #' + r.number})`;
        audit('wave.payment', r.cname, '#' + r.number + ' $' + amt);
        return ok(true);
      }
      if (a === 'wave.invoice.delete') {
        const r = (await sql`SELECT * FROM invoices WHERE id=${Number(P.id) || 0}`)[0];
        if (!r) return err('Invoice not found.');
        if (r.wave_id) {
          if (!['DRAFT', 'SAVED'].includes(r.wave_status) && r.status !== 'draft') return err('Only drafts can be deleted from here. Void sent invoices in Wave.');
          await C.waveInvoiceDelete(r.wave_id);
        }
        await sql`DELETE FROM invoices WHERE id=${r.id}`; audit('wave.invoice.delete', '#' + r.number);
        return ok(true);
      }
      if (a === 'wave.refresh') {
        const r = (await sql`SELECT * FROM invoices WHERE id=${Number(P.id) || 0}`)[0];
        if (!r || !r.wave_id) return err('Not linked to Wave.');
        const inv = await C.waveInvoiceGet(sql, r.wave_id); if (inv) await C.waveUpsertInvoice(sql, inv, r.client_id);
        return ok(true);
      }
      return err('Unknown owner action.');
    }

    /* ================= CRM: clients, billing, tasks, HQ ================= */
    if (a.indexOf('crm.') === 0) {
      const D = v => (v ? String(v).slice(0, 10) : null);
      const num = v => Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')) || 0;
      const TPL = {
        onboard: { label: 'Local SEO onboarding', items: [
          ['Kickoff call and collect logins', 0], ['Get Google Business Profile manager access', 1], ['Get website / hosting access', 2],
          ['Baseline rankings + GBP audit', 3], ['Set up review request link and NFC cards', 7], ['NAP / citation cleanup', 7],
          ['GBP optimization: categories, services, photos', 10], ['Schedule first month of GBP posts', 10], ['30-day check-in call with client', 30]] },
        website: { label: 'Website build', items: [
          ['Collect content, logo and photos', 0], ['Sitemap + design direction approved', 5], ['Build draft site', 14], ['Client review round', 18],
          ['Revisions', 21], ['Launch + Google Analytics / Search Console', 25], ['Post-launch check and speed test', 32]] },
        monthly: { label: 'Monthly service', items: [
          ['Send monthly SEO report', 30, 'monthly'], ['Schedule next month of GBP posts', 25, 'monthly'], ['Review response sweep', 7, 'weekly']] }
      };
      const addDays = (d, n) => { const x = new Date(d || Date.now()); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      const applyTpl = async (clientId, key, who) => {
        const t = TPL[key]; if (!t) return 0;
        for (const it of t.items) await sql`INSERT INTO tasks (client_id, title, due, assignee, recurring, created_by) VALUES (${clientId}, ${it[0]}, ${addDays(null, it[1])}, ${who}, ${it[2] || ''}, ${user.email})`;
        await sql`INSERT INTO client_log (client_id, author, note) VALUES (${clientId}, ${user.email}, ${'Added task list: ' + t.label})`;
        return t.items.length;
      };
      const healthOf = c => {
        if (c.health && c.health !== 'auto') return c.health;
        if (c.status === 'paused' || Number(c.overdue_amt) > 0 && Number(c.overdue_days) > 14) return 'red';
        if (Number(c.overdue_amt) > 0 || Number(c.late_tasks) > 2 || (c.status === 'active' && Number(c.days_quiet) > 45)) return 'yellow';
        return 'green';
      };
      const clientRows = async (where) => {
        const rows = await sql`SELECT c.*,
            (SELECT count(*)::int FROM tasks t WHERE t.client_id=c.id AND t.status='open') AS open_tasks,
            (SELECT count(*)::int FROM tasks t WHERE t.client_id=c.id AND t.status='open' AND t.due < current_date) AS late_tasks,
            (SELECT COALESCE(sum(amount),0)::numeric FROM invoices i WHERE i.client_id=c.id AND i.status='open') AS open_amt,
            (SELECT COALESCE(sum(amount),0)::numeric FROM invoices i WHERE i.client_id=c.id AND i.status='open' AND i.due < current_date) AS overdue_amt,
            (SELECT COALESCE(max(current_date - i.due),0)::int FROM invoices i WHERE i.client_id=c.id AND i.status='open' AND i.due < current_date) AS overdue_days,
            (SELECT COALESCE(current_date - max(l.ts)::date, 999)::int FROM client_log l WHERE l.client_id=c.id) AS days_quiet,
            to_char(c.start_date,'YYYY-MM-DD') AS start_s, to_char(COALESCE(c.renewal_date, c.start_date + make_interval(months => GREATEST(c.term_months,1))),'YYYY-MM-DD') AS renewal_s
          FROM clients c ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'onboarding' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, c.name`;
        return rows.filter(where || (() => true)).map(c => Object.assign(c, { health_c: healthOf(c) }));
      };

      /* tasks: everyone (reps see their own) */
      if (a === 'crm.tasks') {
        const rows = await sql`SELECT t.*, to_char(t.due,'YYYY-MM-DD') AS due_s, COALESCE(c.name,'') AS client FROM tasks t LEFT JOIN clients c ON c.id=t.client_id
          WHERE (t.status='open' OR t.done_ts > now() - interval '14 days') ORDER BY t.status, t.due NULLS LAST, t.id LIMIT 500`;
        return ok(OWNER ? rows : rows.filter(t => t.assignee === user.email));
      }
      if (a === 'crm.task.done') {
        const t = (await sql`SELECT * FROM tasks WHERE id=${Number(P.id) || 0}`)[0];
        if (!t) return err('Task not found.');
        if (!OWNER && t.assignee !== user.email) return err('Not your task.');
        if (P.done === false) { await sql`UPDATE tasks SET status='open', done_ts=NULL WHERE id=${t.id}`; return ok(true); }
        await sql`UPDATE tasks SET status='done', done_ts=now(), done_by=${user.email} WHERE id=${t.id}`;
        let next = null;
        if (t.recurring === 'monthly' || t.recurring === 'weekly') {
          const nd = t.recurring === 'weekly' ? addDays(t.due || null, 7) : (() => { const x = new Date(t.due || Date.now()); x.setUTCMonth(x.getUTCMonth() + 1); return x.toISOString().slice(0, 10); })();
          await sql`INSERT INTO tasks (client_id, title, due, assignee, recurring, note, created_by) VALUES (${t.client_id}, ${t.title}, ${nd}, ${t.assignee}, ${t.recurring}, ${t.note}, ${user.email})`;
          next = nd;
        }
        if (t.client_id) await sql`INSERT INTO client_log (client_id, author, note) VALUES (${t.client_id}, ${user.email}, ${'Done: ' + t.title})`;
        return ok({ next });
      }

      if (!OWNER) return err('Owner only.');

      if (a === 'crm.task.save') {
        const title = String(P.title || '').trim(); if (!title) return err('What is the task?');
        const f = { client_id: Number(P.client_id) || null, due: D(P.due), assignee: String(P.assignee || user.email), recurring: ['monthly', 'weekly'].includes(P.recurring) ? P.recurring : '', note: String(P.note || '') };
        if (P.id) await sql`UPDATE tasks SET title=${title}, client_id=${f.client_id}, due=${f.due}, assignee=${f.assignee}, recurring=${f.recurring}, note=${f.note} WHERE id=${Number(P.id)}`;
        else await sql`INSERT INTO tasks (client_id, title, due, assignee, recurring, note, created_by) VALUES (${f.client_id}, ${title}, ${f.due}, ${f.assignee}, ${f.recurring}, ${f.note}, ${user.email})`;
        return ok(true);
      }
      if (a === 'crm.task.delete') { await sql`DELETE FROM tasks WHERE id=${Number(P.id) || 0}`; return ok(true); }
      if (a === 'crm.template.apply') {
        const n = await applyTpl(Number(P.client_id) || 0, String(P.template || ''), String(P.assignee || user.email));
        return ok({ added: n });
      }
      if (a === 'crm.templates') return ok(Object.keys(TPL).map(k => ({ key: k, label: TPL[k].label, n: TPL[k].items.length })));

      if (a === 'crm.wave.status') {
        const last = ((await sql`SELECT v FROM kv WHERE k='wave_last_sync'`)[0] || {}).v;
        return ok({ connected: !!process.env.WAVE_TOKEN, last: last ? JSON.parse(last) : null });
      }
      if (a === 'crm.wave.sync') return ok(await C.waveSync(sql));
      if (a === 'crm.clients') return ok(await clientRows());
      if (a === 'crm.client.get') {
        const id = Number(P.id) || 0;
        const c = (await clientRows(x => x.id === id))[0];
        if (!c) return err('Client not found.');
        const invoices = await sql`SELECT *, to_char(issued,'YYYY-MM-DD') AS issued_s, to_char(due,'YYYY-MM-DD') AS due_s, to_char(paid_date,'YYYY-MM-DD') AS paid_s FROM invoices WHERE client_id=${id} ORDER BY issued DESC NULLS LAST, id DESC`;
        const tasks = await sql`SELECT *, to_char(due,'YYYY-MM-DD') AS due_s FROM tasks WHERE client_id=${id} ORDER BY status, due NULLS LAST, id`;
        const log = await sql`SELECT * FROM client_log WHERE client_id=${id} ORDER BY ts DESC LIMIT 60`;
        const ref = (await sql`SELECT p.id, p.code, (SELECT COALESCE(sum(amount),0)::numeric FROM ref_credits r WHERE r.partner_id=p.id) AS balance FROM ref_partners p WHERE lower(p.company)=lower(${c.name}) AND p.status='active'`)[0] || null;
        return ok({ client: c, invoices, tasks, log, ref });
      }
      if (a === 'crm.client.save') {
        const name = String(P.name || '').trim(); if (!name) return err('Client name?');
        const f = {
          contact: String(P.contact || ''), email: String(P.email || ''), phone: C.normPhone(P.phone) || String(P.phone || ''), website: String(P.website || ''),
          package: String(P.package || ''), mrr: num(P.mrr), start: D(P.start_date) || new Date().toISOString().slice(0, 10), term: Math.max(0, parseInt(P.term_months, 10) || 0),
          renewal: D(P.renewal_date), status: ['active', 'onboarding', 'paused', 'churned', 'past'].includes(P.status) ? P.status : 'active',
          health: ['auto', 'green', 'yellow', 'red'].includes(P.health) ? P.health : 'auto', rep: String(P.rep || ''), notes: String(P.notes || ''), links: String(P.links || '')
        };
        let id = Number(P.id) || 0, prev = null;
        if (id) {
          prev = (await sql`SELECT * FROM clients WHERE id=${id}`)[0];
          await sql`UPDATE clients SET name=${name}, contact=${f.contact}, email=${f.email}, phone=${f.phone}, website=${f.website}, package=${f.package}, mrr=${f.mrr},
            start_date=${f.start}, term_months=${f.term}, renewal_date=${f.renewal}, status=${f.status}, health=${f.health}, rep=${f.rep}, notes=${f.notes}, links=${f.links}, updated=now() WHERE id=${id}`;
        } else {
          const dup = (await sql`SELECT id FROM clients WHERE lower(name)=lower(${name})`)[0];
          if (dup) return err(name + ' is already a client.');
          id = (await sql`INSERT INTO clients (name, contact, email, phone, website, package, mrr, start_date, term_months, renewal_date, status, health, rep, notes, links)
            VALUES (${name}, ${f.contact}, ${f.email}, ${f.phone}, ${f.website}, ${f.package}, ${f.mrr}, ${f.start}, ${f.term}, ${f.renewal}, ${f.status}, ${f.health}, ${f.rep}, ${f.notes}, ${f.links}) RETURNING id`)[0].id;
          await sql`INSERT INTO client_log (client_id, author, note) VALUES (${id}, ${user.email}, 'Client added')`;
          if (P.template) await applyTpl(id, P.template, user.email);
        }
        if (prev && prev.status !== f.status) await sql`INSERT INTO client_log (client_id, author, note) VALUES (${id}, ${user.email}, ${'Status: ' + prev.status + ' → ' + f.status})`;
        if (prev && Number(prev.mrr) !== f.mrr) {
          await sql`UPDATE clients SET mrr_manual=true WHERE id=${id}`;
          await sql`INSERT INTO client_log (client_id, author, note) VALUES (${id}, ${user.email}, ${'MRR set by hand: $' + Number(prev.mrr) + ' → $' + f.mrr + ' (Wave sync will no longer change it)'})`;
        }
        let cancelled = 0;
        if (f.status === 'churned' && (!prev || prev.status !== 'churned')) {
          const ds = await sql`UPDATE deals SET status='cancelled', cancelled_ts=now() WHERE lower(business)=lower(${name}) AND status='approved' AND cancelled_ts IS NULL RETURNING id`;
          cancelled = ds.length;
          if (f.phone) await sql`UPDATE companies SET stage='lost', updated=now() WHERE phone=${C.normPhone(f.phone)} AND stage='won'`;
        }
        return ok({ id, cancelled });
      }
      if (a === 'crm.client.import') {
        let added = 0;
        for (const x of (Array.isArray(P.list) ? P.list : []).slice(0, 200)) {
          const name = String(x.company || '').trim(); if (!name) continue;
          if ((await sql`SELECT 1 FROM clients WHERE lower(name)=lower(${name})`).length) continue;
          const r = await sql`INSERT INTO clients (name, contact, email, phone, mrr, start_date, status) VALUES (${name}, ${((x.first || '') + ' ' + (x.last || '')).trim()}, ${x.email || ''}, ${C.normPhone(x.phone) || ''}, ${num(x.mrr)}, ${D(x.since) || new Date().toISOString().slice(0, 10)}, 'active') RETURNING id`;
          await sql`INSERT INTO client_log (client_id, author, note) VALUES (${r[0].id}, ${user.email}, 'Imported from Wave')`;
          added++;
        }
        return ok({ added });
      }
      if (a === 'crm.client.note') {
        const note = String(P.note || '').trim(); if (!note) return err('Empty note.');
        await sql`INSERT INTO client_log (client_id, author, note) VALUES (${Number(P.id) || 0}, ${user.email}, ${note})`;
        return ok(true);
      }
      if (a === 'crm.client.delete') {
        sql`INSERT INTO audit (who, act, target) VALUES (${user.email}, 'client.delete', ${String(P.id||'')})`.catch(()=>{});
        const id = Number(P.id) || 0;
        await sql`DELETE FROM tasks WHERE client_id=${id}`; await sql`DELETE FROM invoices WHERE client_id=${id}`; await sql`DELETE FROM client_log WHERE client_id=${id}`;
        await sql`DELETE FROM clients WHERE id=${id}`;
        return ok(true);
      }

      /* ---- billing (Wave is the source; this is the log) ---- */
      if (a === 'crm.invoices') {
        return ok(await sql`SELECT i.*, c.name AS client, to_char(i.issued,'YYYY-MM-DD') AS issued_s, to_char(i.due,'YYYY-MM-DD') AS due_s, to_char(i.paid_date,'YYYY-MM-DD') AS paid_s,
          CASE WHEN i.status='open' AND i.due < current_date THEN (current_date - i.due) ELSE 0 END AS late_days
          FROM invoices i LEFT JOIN clients c ON c.id=i.client_id ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.due DESC NULLS LAST, i.id DESC LIMIT 600`);
      }
      if (a === 'crm.invoice.save') {
        const cid = Number(P.client_id) || 0; if (!cid) return err('Pick the client.');
        const amt = num(P.amount); if (!amt) return err('Amount?');
        const issued = D(P.issued) || new Date().toISOString().slice(0, 10), due = D(P.due) || addDays(issued, 15);
        const st = ['open', 'paid', 'void'].includes(P.status) ? P.status : 'open';
        if (P.id) await sql`UPDATE invoices SET client_id=${cid}, number=${String(P.number || '')}, amount=${amt}, issued=${issued}, due=${due}, status=${st}, note=${String(P.note || '')}, paid_date=${st === 'paid' ? (D(P.paid_date) || new Date().toISOString().slice(0, 10)) : null} WHERE id=${Number(P.id)}`;
        else {
          await sql`INSERT INTO invoices (client_id, number, amount, issued, due, status, note, paid_date) VALUES (${cid}, ${String(P.number || '')}, ${amt}, ${issued}, ${due}, ${st}, ${String(P.note || '')}, ${st === 'paid' ? (D(P.paid_date) || issued) : null})`;
          await sql`INSERT INTO client_log (client_id, author, note) VALUES (${cid}, ${user.email}, ${'Invoice logged' + (P.number ? ' #' + P.number : '') + ': $' + amt})`;
        }
        if (num(P.credit) > 0) {
          const c = (await sql`SELECT name FROM clients WHERE id=${cid}`)[0];
          const p = c && (await sql`SELECT id FROM ref_partners WHERE lower(company)=lower(${c.name})`)[0];
          if (p) await sql`INSERT INTO ref_credits (partner_id, amount, note, author) VALUES (${p.id}, ${-num(P.credit)}, ${'Applied on Wave invoice ' + String(P.number || '')}, ${user.email})`;
        }
        return ok(true);
      }
      if (a === 'crm.invoice.paid') {
        const i = (await sql`UPDATE invoices SET status='paid', paid_date=${D(P.date) || new Date().toISOString().slice(0, 10)} WHERE id=${Number(P.id) || 0} RETURNING *`)[0];
        if (i) await sql`INSERT INTO client_log (client_id, author, note) VALUES (${i.client_id}, ${user.email}, ${'Invoice paid' + (i.number ? ' #' + i.number : '') + ': $' + Number(i.amount)})`;
        return ok(true);
      }
      if (a === 'crm.invoice.delete') { await sql`DELETE FROM invoices WHERE id=${Number(P.id) || 0}`; return ok(true); }
      if (a === 'crm.billing.run') {
        const rows = await sql`SELECT c.id, c.name, c.mrr, c.email,
            (SELECT count(*)::int FROM invoices i WHERE i.client_id=c.id AND date_trunc('month', i.issued) = date_trunc('month', ${D(P.month) || new Date().toISOString().slice(0, 10)}::date)) AS logged,
            (SELECT COALESCE(sum(r.amount),0)::numeric FROM ref_partners p JOIN ref_credits r ON r.partner_id=p.id WHERE lower(p.company)=lower(c.name)) AS credit,
            (SELECT to_char(max(i.issued),'YYYY-MM-DD') FROM invoices i WHERE i.client_id=c.id AND i.recurring_id <> '' AND i.issued > current_date - 45) AS rec_last
          FROM clients c WHERE c.status IN ('active','onboarding') AND c.mrr > 0 ORDER BY c.name`;
        return ok(rows);
      }

      /* ---- owner HQ ---- */
      if (a === 'crm.hq') {
        const cl = await clientRows(c => c.status !== 'churned');
        const act = cl.filter(c => c.status === 'active' || c.status === 'onboarding');
        const mrr = act.reduce((s, c) => s + Number(c.mrr || 0), 0);
        const cash = (await sql`SELECT COALESCE(sum(amount) FILTER (WHERE paid_date >= date_trunc('month', now())),0)::numeric AS m,
            COALESCE(sum(amount) FILTER (WHERE paid_date >= date_trunc('month', now()) - interval '1 month' AND paid_date < date_trunc('month', now())),0)::numeric AS lm,
            COALESCE(sum(amount) FILTER (WHERE status='open'),0)::numeric AS ar,
            COALESCE(sum(amount) FILTER (WHERE status='open' AND due < current_date),0)::numeric AS overdue FROM invoices`)[0];
        const billed = (await sql`SELECT
            COALESCE(sum(amount) FILTER (WHERE issued >= date_trunc('month', now())),0)::numeric AS m,
            COALESCE(sum(amount) FILTER (WHERE issued >= date_trunc('month', now()) AND recurring_id <> ''),0)::numeric AS m_rec,
            COALESCE(sum(amount) FILTER (WHERE issued >= date_trunc('month', now()) - interval '1 month' AND issued < date_trunc('month', now())),0)::numeric AS lm,
            COALESCE(sum(amount) FILTER (WHERE issued >= date_trunc('year', now())),0)::numeric AS ytd,
            COALESCE(sum(amount) FILTER (WHERE issued >= date_trunc('month', now()) - interval '12 months' AND issued < date_trunc('month', now())),0)::numeric AS t12
          FROM invoices WHERE status IN ('open','paid')`)[0];
        const months = await sql`SELECT to_char(date_trunc('month', paid_date),'Mon') AS m, sum(amount)::numeric AS v FROM invoices
          WHERE status='paid' AND paid_date >= date_trunc('month', now()) - interval '5 months' GROUP BY date_trunc('month', paid_date) ORDER BY date_trunc('month', paid_date)`;
        const overdueInv = await sql`SELECT i.id, i.number, i.amount, c.name AS client, c.id AS client_id, (current_date - i.due) AS days FROM invoices i JOIN clients c ON c.id=i.client_id
          WHERE i.status='open' AND i.due < current_date ORDER BY i.due LIMIT 20`;
        const tasks = await sql`SELECT t.id, t.title, to_char(t.due,'YYYY-MM-DD') AS due_s, t.assignee, COALESCE(c.name,'') AS client, t.client_id FROM tasks t LEFT JOIN clients c ON c.id=t.client_id
          WHERE t.status='open' AND t.due <= current_date + 7 ORDER BY t.due LIMIT 40`;
        const pipe = (await sql`SELECT count(*) FILTER (WHERE stage IN ('engaged','meeting'))::int AS warm, count(*) FILTER (WHERE stage IN ('proposal','contract'))::int AS hot,
            count(*) FILTER (WHERE stage='won' AND updated >= date_trunc('month', now()))::int AS won_m FROM companies`)[0];
        const team = await sql`SELECT u.name, u.email, count(c.id)::int AS dials,
            count(c.id) FILTER (WHERE c.outcome IN ('callback','meeting','closed','not_interested','gatekeeper'))::int AS convos,
            count(c.id) FILTER (WHERE c.outcome='meeting')::int AS meetings
          FROM users u LEFT JOIN calls c ON c.rep=u.email AND c.ts >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
          WHERE COALESCE(u.active,1)=1 GROUP BY u.name, u.email ORDER BY dials DESC`;
        const refOwed = (await sql`SELECT COALESCE(sum(amount),0)::numeric AS v FROM ref_credits`)[0].v;
        const refOpen = (await sql`SELECT count(*)::int AS n FROM referrals WHERE status IN ('submitted','contacted','meeting')`)[0].n;
        const missed = (await sql`SELECT count(*)::int AS n FROM inbound WHERE status='missed'`)[0].n;
        const pending = (await sql`SELECT count(*)::int AS n FROM deals WHERE status='pending'`)[0].n;
        const soon = cl.filter(c => (c.status === 'active' || c.status === 'onboarding') && c.term_months > 0 && c.renewal_s && (new Date(c.renewal_s) - Date.now()) / 864e5 <= 30 && (new Date(c.renewal_s) - Date.now()) / 864e5 >= -7);
        return ok({ mrr, billed, clients: act.length, onboarding: cl.filter(c => c.status === 'onboarding').length, cash, months, overdueInv, tasks, pipe, team, refOwed, refOpen, missed, pending,
          risk: cl.filter(c => c.health_c !== 'green' && c.status !== 'churned' && (c.status !== 'past' || Number(c.overdue_amt) > 0)).map(c => ({ id: c.id, name: c.name, health: c.health_c, mrr: c.mrr, overdue: c.overdue_amt, late: c.late_tasks, quiet: c.days_quiet })),
          renewals: soon.map(c => ({ id: c.id, name: c.name, mrr: c.mrr, renewal: c.renewal_s })) });
      }
      return err('Unknown CRM action.');
    }

    /* ---------------- REFERRAL PROGRAM (owner) ---------------- */
    if (a.indexOf('ref.') === 0) {
      if (!OWNER) return err('Owner only.');
      const newCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
      const base = (process.env.REFER_URL || process.env.APP_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'sales-eta-livid.vercel.app'))).replace(/\/$/, '');
      if (a === 'ref.data') {
        const partners = await sql`SELECT p.*,
            (SELECT count(*)::int FROM referrals r WHERE r.partner_id=p.id) AS refs,
            (SELECT count(*)::int FROM referrals r WHERE r.partner_id=p.id AND r.status IN ('won','paid')) AS wins,
            (SELECT COALESCE(sum(amount),0)::numeric FROM ref_credits c WHERE c.partner_id=p.id) AS balance,
            (SELECT COALESCE(sum(amount),0)::numeric FROM ref_credits c WHERE c.partner_id=p.id AND amount>0) AS earned
          FROM ref_partners p WHERE p.status <> 'archived' ORDER BY p.company`;
        const referrals = await sql`SELECT r.*, p.company AS partner FROM referrals r LEFT JOIN ref_partners p ON p.id=r.partner_id ORDER BY r.ts DESC LIMIT 300`;
        const credits = await sql`SELECT c.*, p.company AS partner FROM ref_credits c LEFT JOIN ref_partners p ON p.id=c.partner_id ORDER BY c.ts DESC LIMIT 200`;
        const tpl = process.env.DOCUSEAL_TEMPLATE_REFERRAL || ((await sql`SELECT v FROM kv WHERE k='ref_template'`)[0] || {}).v || '';
        return ok({ partners, referrals, credits, template: tpl, base, linkBase: /\/\/refer\./.test(base) ? base + '/' : base + '/refer.html?c=' });
      }
      if (a === 'ref.enrolled') {
        return ok((await sql`SELECT lower(company) AS c FROM ref_partners WHERE status <> 'archived'`).map(r => r.c));
      }
      if (a === 'ref.partner.add') {
        const list = Array.isArray(P.list) ? P.list : [P];
        let added = 0;
        for (const x of list.slice(0, 100)) {
          const company = String(x.company || '').trim(); if (!company) continue;
          const dup = (await sql`SELECT id, status FROM ref_partners WHERE lower(company)=lower(${company})`)[0];
          if (dup) { if (dup.status === 'archived') { await sql`UPDATE ref_partners SET status='active' WHERE id=${dup.id}`; added++; } continue; }
          let code = newCode();
          while ((await sql`SELECT 1 FROM ref_partners WHERE code=${code}`).length) code = newCode();
          await sql`INSERT INTO ref_partners (company, contact, email, phone, code) VALUES (${company}, ${String(x.contact || ((x.first || '') + ' ' + (x.last || ''))).trim()}, ${String(x.email || '').trim()}, ${C.normPhone(x.phone) || ''}, ${code})`;
          added++;
        }
        return ok({ added });
      }
      if (a === 'ref.partner.update') {
        const id = Number(P.id) || 0;
        if (P.status) await sql`UPDATE ref_partners SET status=${P.status === 'archived' ? 'archived' : 'active'} WHERE id=${id}`;
        if (P.email !== undefined) await sql`UPDATE ref_partners SET email=${String(P.email).trim()} WHERE id=${id}`;
        if (P.contact !== undefined) await sql`UPDATE ref_partners SET contact=${String(P.contact).trim()} WHERE id=${id}`;
        if (P.agreement) await sql`UPDATE ref_partners SET agreement=${P.agreement}, signed_ts=${P.agreement === 'signed' ? new Date().toISOString() : null} WHERE id=${id}`;
        return ok(true);
      }
      if (a === 'ref.template.set') {
        await sql`INSERT INTO kv (k, v) VALUES ('ref_template', ${String(P.id || '').replace(/\D/g, '')}) ON CONFLICT (k) DO UPDATE SET v=${String(P.id || '').replace(/\D/g, '')}`;
        return ok(true);
      }
      if (a === 'ref.template.create') {
        const key = process.env.DOCUSEAL_API_KEY;
        if (!key) return err('DOCUSEAL_API_KEY is not set.');
        const r = await fetch('https://api.docuseal.com/templates/html', {
          method: 'POST', headers: { 'X-Auth-Token': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'BWD Client Referral Program Agreement', html: REF_HTML, size: 'Letter' })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id) return err('DocuSeal would not create it automatically (' + r.status + '). Upload the agreement PDF in DocuSeal instead and paste the template ID here.');
        await sql`INSERT INTO kv (k, v) VALUES ('ref_template', ${String(j.id)}) ON CONFLICT (k) DO UPDATE SET v=${String(j.id)}`;
        return ok({ id: j.id });
      }
      if (a === 'ref.agreement.send') {
        const p = (await sql`SELECT * FROM ref_partners WHERE id=${Number(P.id) || 0}`)[0];
        if (!p) return err('Partner not found.');
        if (!/@/.test(p.email)) return err('Add an email for ' + p.company + ' first.');
        const tpl = process.env.DOCUSEAL_TEMPLATE_REFERRAL || ((await sql`SELECT v FROM kv WHERE k='ref_template'`)[0] || {}).v || '';
        if (!tpl) return err('Set up the DocuSeal template first (Program setup card).');
        const sub = await C.docusealSend(tpl, p.email, p.contact || p.company, { 'Business Name': p.company, 'Full Name': p.contact || '' });
        await sql`UPDATE ref_partners SET agreement='sent', docuseal_id=${sub.id}, invited_ts=now() WHERE id=${p.id}`;
        return ok(true);
      }
      if (a === 'ref.invite') {
        const p = (await sql`SELECT * FROM ref_partners WHERE id=${Number(P.id) || 0}`)[0];
        if (!p) return err('Partner not found.');
        if (!/@/.test(p.email)) return err('Add an email for ' + p.company + ' first.');
        const link = (/\/\/refer\./.test(base) ? base + '/' : base + '/refer.html?c=') + p.code, first = String(p.contact || '').split(' ')[0] || 'there';
        const html = '<p>Hi ' + first + ',</p>' +
          '<p>Thank you for being a Burket Web Design client. A lot of our best clients come from people like you, so we started a referral program to say thanks.</p>' +
          '<p><b>Here is how it works:</b> when a business you send our way signs up for a monthly plan and pays their first invoice, you get a credit on your next invoice equal to their first month. That is $500 to $1,250 off, depending on their plan. Website projects earn 10% of the project, up to $500. There is no limit.</p>' +
          '<p>Your personal referral link:<br><a href="' + link + '">' + link + '</a></p>' +
          '<p>Use it to send me a business, or just text me their name and number. I will take great care of them.</p>' +
          (p.agreement !== 'signed' ? '<p>I will also send a short one-page agreement through DocuSeal that spells out the details. It takes about a minute to sign.</p>' : '') +
          '<p>Thanks again,<br>Ty Burket<br>Burket Web Design<br>(814) 656-8597</p>';
        await C.sendProspectMail(p.email, 'Earn invoice credits for every business you send us', html);
        await sql`UPDATE ref_partners SET invited_ts=now() WHERE id=${p.id}`;
        return ok({ link });
      }
      if (a === 'ref.add') {
        const pid = Number(P.partner_id) || 0;
        const p = (await sql`SELECT * FROM ref_partners WHERE id=${pid}`)[0];
        if (!p) return err('Pick who referred them.');
        const biz = String(P.business || '').trim(); if (!biz) return err('Business name?');
        const phone = C.normPhone(P.phone) || '';
        const r = (await sql`INSERT INTO referrals (partner_id, business, contact, phone, email, note, source) VALUES (${pid}, ${biz}, ${P.contact || ''}, ${phone}, ${P.email || ''}, ${P.note || ''}, 'hub') RETURNING id`)[0];
        if (phone) {
          await C.upsertCompany({ phone, name: biz, email: P.email || '', rep: user.email });
          await sql`INSERT INTO company_notes (phone, author, note) VALUES (${phone}, ${user.email}, ${'Referred by ' + p.company})`;
        }
        return ok({ id: r.id });
      }
      if (a === 'ref.status') {
        const id = Number(P.id) || 0, st = String(P.status || '');
        if (['submitted', 'contacted', 'meeting', 'won', 'paid', 'not_qualified', 'lost'].indexOf(st) < 0) return err('Bad status.');
        const r = (await sql`SELECT * FROM referrals WHERE id=${id}`)[0];
        if (!r) return err('Referral not found.');
        if (st === 'paid') {
          if (r.status === 'paid') return err('Already credited.');
          const kind = P.kind === 'project' ? 'project' : 'monthly', amt = Number(P.amount) || 0;
          if (amt <= 0) return err('What was their first invoice amount?');
          const credit = kind === 'monthly' ? amt : Math.min(500, Math.round(amt * 0.10 * 100) / 100);
          await sql`UPDATE referrals SET status='paid', kind=${kind}, amount=${amt}, credit=${credit}, updated=now() WHERE id=${id}`;
          await sql`INSERT INTO ref_credits (partner_id, referral_id, amount, note, author) VALUES (${r.partner_id}, ${id}, ${credit}, ${'Earned: ' + r.business + ' paid first invoice'}, ${user.email})`;
          const p = (await sql`SELECT * FROM ref_partners WHERE id=${r.partner_id}`)[0];
          if (P.notify && p && /@/.test(p.email)) {
            const first = String(p.contact || '').split(' ')[0] || 'there';
            C.sendProspectMail(p.email, 'You just earned a $' + credit + ' credit',
              '<p>Hi ' + first + ',</p><p>Great news: <b>' + r.business + '</b> is officially a Burket Web Design client, so you earned a <b>$' + credit + ' credit</b>. It will show up as a "Referral credit" line on your next invoice.</p><p>Thank you for sending them our way.</p><p>Ty Burket<br>Burket Web Design</p>').catch(() => {});
          }
          return ok({ credit });
        }
        if (r.status === 'paid') return err('This referral already earned its credit. Remove the credit first if it needs to change.');
        await sql`UPDATE referrals SET status=${st}, updated=now() WHERE id=${id}`;
        return ok(true);
      }
      if (a === 'ref.apply') {
        const pid = Number(P.partner_id) || 0, amt = Number(P.amount) || 0;
        const bal = Number((await sql`SELECT COALESCE(sum(amount),0)::numeric AS b FROM ref_credits WHERE partner_id=${pid}`)[0].b);
        if (amt <= 0 || amt > bal + 0.001) return err('Amount has to be between $0 and the $' + bal + ' balance.');
        await sql`INSERT INTO ref_credits (partner_id, amount, note, author) VALUES (${pid}, ${-amt}, ${'Applied on Wave invoice ' + String(P.invoice || '').slice(0, 40)}, ${user.email})`;
        return ok(true);
      }
      if (a === 'ref.credit.delete') {
        const c = (await sql`DELETE FROM ref_credits WHERE id=${Number(P.id) || 0} RETURNING *`)[0];
        if (c && c.referral_id && c.amount > 0) await sql`UPDATE referrals SET status='won', credit=0, updated=now() WHERE id=${c.referral_id}`;
        return ok(true);
      }
      return err('Unknown referral action.');
    }

    if (a === 'listing.mark') {
      const phone = C.normPhone(P.phone);
      if (!phone) return err('Bad phone.');
      const plats = (Array.isArray(P.platforms) ? P.platforms : []).map(String).filter(x => ['Thumbtack', 'Angi', 'HomeAdvisor'].includes(x)).join(',');
      const none = !!P.none;
      await sql`INSERT INTO lp_check (phone, platforms, none, rep, ts) VALUES (${phone}, ${plats}, ${none}, ${user.email}, now())
        ON CONFLICT (phone) DO UPDATE SET platforms=${plats}, none=${none}, rep=${user.email}, ts=now()`;
      return ok(true);
    }
    if (a === 'listing.verify') {
      // Leads Ty or Steven confirmed by hand on the platform itself. Each line: a profile URL, or "Business name | town".
      const platform = String(P.platform || 'Thumbtack');
      const metro = String(P.metro || '').trim();
      const lines = String(P.lines || '').split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 40);
      if (!lines.length) return err('Paste at least one profile link or business name.');
      const toks = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
        .filter(w => w.length > 1 && !['llc', 'inc', 'co', 'the', 'and', 'of', 'company', 'corp', 'reviews', 'service', 'services'].includes(w));
      const fromUrl = u => {
        let m;
        if ((m = u.match(/angi\.com\/companylist\/us\/([a-z]{2})\/([^\/]+)\/([^\/?#]+?)(?:-reviews)?-\d+\.htm/i))) return { name: m[3].replace(/-/g, ' '), town: m[2].replace(/-/g, ' ') + ' ' + m[1].toUpperCase() };
        if ((m = u.match(/homeadvisor\.com\/rated\.([^.\/?#]+)\.\d+/i))) return { name: m[1].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/-/g, ' '), town: '' };
        if ((m = u.match(/thumbtack\.com\/([a-z]{2})\/([^\/]+)\/[^\/]+\/([^\/?#]+)/i))) return { name: m[3].replace(/-/g, ' '), town: m[2].replace(/-/g, ' ') + ' ' + m[1].toUpperCase() };
        return null;
      };
      const found = [], missed = [];
      for (const line of lines) {
        const isUrl = /^https?:\/\//i.test(line);
        let q = isUrl ? fromUrl(line) : { name: line.split('|')[0].trim(), town: (line.split('|')[1] || '').trim() };
        if (!q || !q.name) { missed.push(line + ' (could not read a business name from that link)'); continue; }
        const town = q.town || metro;
        let res = [];
        try {
          const l2 = q.town ? await C.geocodeCity(q.town).catch(() => null) : null;
          res = l2 ? await C.placesBiased(q.name + ' ' + q.town, l2.lat, l2.lng, 50000) : await C.placesSearch(q.name + (town ? ' ' + town : ''));
        } catch (e) { missed.push(line + ' (' + e.message + ')'); continue; }
        const want = toks(q.name);
        let best = null, bestScore = 0;
        for (const b of res.slice(0, 8)) {
          const have = new Set(toks(b.name));
          const hit = want.filter(w => have.has(w) || have.has(w.replace(/s$/, ''))).length;
          const score = want.length ? hit / want.length : 0;
          if (score > bestScore && C.normPhone(b.phone)) { best = b; bestScore = score; }
        }
        if (!best || bestScore < 0.6) { missed.push(q.name + (town ? ', ' + town : '') + ' (no confident Google match)'); continue; }
        found.push({ name: best.name, phone: C.normPhone(best.phone), website: best.website || '', rating: best.rating, reviews: best.reviews,
          addr: best.addr, maps: best.maps, town: town, src: 'listing', platform, platforms: [platform], verified: true,
          profile: isUrl ? line : '', why: 'Verified on ' + platform,
          evidence: 'Verified on ' + platform + (isUrl ? ' (profile linked)' : '') });
      }
      const phones = found.map(b => b.phone); const dnc = {};
      if (phones.length) (await sql`SELECT phone FROM dnc WHERE phone = ANY(${phones})`).forEach(r => dnc[r.phone] = true);
      const seen = {};
      const list = found.filter(b => !dnc[b.phone] && !seen[b.phone] && (seen[b.phone] = true));
      return ok({ list, missed });
    }
    if (a === 'listing.build') {
      const vertical = String(P.vertical || '').trim();
      if (!vertical) return err('Pick an industry first.');
      const metros = (Array.isArray(P.metros) ? P.metros : String(P.metros || '').split(','))
        .map(x => String(x).trim()).filter(Boolean).slice(0, 3);
      if (!metros.length) return err('Pick a market first.');
      const seen = {}, cands = [], notes = [];
      for (const metro of metros) {
        let loc, results;
        try { loc = await C.geocodeCity(metro); } catch (e) { notes.push(metro + ': ' + e.message); continue; }
        try { results = await C.placesBiased(vertical + ' in ' + metro, loc.lat, loc.lng, 35000); }
        catch (e) { notes.push(metro + ': ' + e.message); continue; }
        for (const b of results) {
          if (b.status !== 'OPERATIONAL' || !b.id || seen[b.id]) continue;
          seen[b.id] = true;
          const np = C.normPhone(b.phone);
          if (!np || !b.website || C.isChain(b.name)) continue;
          if (b.reviews > 400) continue;                       // big shops run their own marketing department
          cands.push(Object.assign({}, b, { phone: np, town: metro }));
        }
      }
      const phones = cands.map(b => b.phone); const known = {};
      if (phones.length) {
        (await sql`SELECT DISTINCT phone FROM calls WHERE phone = ANY(${phones})`).forEach(r => known[r.phone] = true);
        (await sql`SELECT phone FROM dnc WHERE phone = ANY(${phones})`).forEach(r => known[r.phone] = true);
        (await sql`SELECT phone FROM lp_check WHERE none AND phone = ANY(${phones})`).forEach(r => known[r.phone] = true);
      }
      const fresh = cands.filter(b => !known[b.phone]).slice(0, 45);
      const marks = {};
      if (fresh.length) (await sql`SELECT phone, platforms FROM lp_check WHERE NOT none AND platforms <> '' AND phone = ANY(${fresh.map(b => b.phone)})`).forEach(r => marks[r.phone] = r.platforms.split(','));
      const out = [];
      for (let i = 0; i < fresh.length; i += 15) {
        const batch = fresh.slice(i, i + 15);
        const res = await Promise.all(batch.map(b => C.detectLeadPlatforms(b.website).catch(() => ({ platforms: [] }))));
        batch.forEach((b, k) => {
          const d = res[k];
          const has = d.platforms.length > 0;
          out.push({ name: b.name, phone: b.phone, website: b.website, rating: b.rating, reviews: b.reviews, pos: b.pos,
                     addr: b.addr, maps: b.maps, town: b.town, src: 'listing', platform: has ? d.platforms[0] : '', platforms: d.platforms,
                     why: has ? 'Uses ' + d.platforms.join(' + ') : '', verified: false, badge: has,
                     evidence: has ? 'Badge on their site: ' + (d.evidence || d.platforms.join(', ')) : '' });
        });
      }
      out.forEach(b => { const m = marks[b.phone]; if (m) { b.onP = m; b.verified = true; b.platform = m[0]; b.platforms = m; b.evidence = 'Profile found on ' + m.join(' + '); } });
      return ok({ list: await C.cleanLeads(sql, out, vertical), scanned: fresh.length, skipped: cands.length - fresh.length, notes });
    }

    /* ---------------- CALL LOGGING ---------------- */
    if (a === 'call.log') {
      const phone = C.normPhone(P.phone);
      if (!phone) return err('Bad phone number.');
      const outcome = String(P.outcome || 'no_answer');
      await sql`UPDATE calls SET fup_done=true WHERE phone=${phone} AND fup IS NOT NULL AND fup_done=false`;
      let fupRep = '';
      if (OWNER && P.fupRep && String(P.fupRep).toLowerCase() !== user.email) {
        const fr = (await sql`SELECT email FROM users WHERE email=${String(P.fupRep).toLowerCase()}`)[0];
        if (fr) fupRep = fr.email;
      }
      const row = await sql`INSERT INTO calls (phone, name, rep, outcome, note, secs, fup, city, industry, website, email, rating, reviews, pos, addr, maps, src, obj)
        VALUES (${phone}, ${P.name || ''}, ${user.email}, ${outcome}, ${P.note || ''}, ${Number(P.secs) || 0},
                ${P.fup || null}, ${P.city || ''}, ${P.industry || ''}, ${P.website || ''}, ${P.email || ''},
                ${Number(P.rating) || 0}, ${P.reviews == null ? -1 : Number(P.reviews)}, ${Number(P.pos) || 0},
                ${P.addr || ''}, ${P.maps || ''}, ${P.src || ''}, ${P.obj || ''}) RETURNING id`;
      if (fupRep) await sql`UPDATE calls SET fup_rep=${fupRep} WHERE id=${row[0].id}`;
      await sql`UPDATE inbound SET status='called_back', done_by=${user.email}, done_ts=now() WHERE phone=${phone} AND status='missed'`;
      const stageMap = { meeting: 'meeting', callback: 'engaged', closed: 'contract' };
      await C.upsertCompany({ phone: phone, name: P.name, website: P.website, email: P.email, addr: P.addr,
        city: P.city, industry: P.industry, rating: P.rating, reviews: P.reviews, pos: P.pos, maps: P.maps, rep: user.email },
        stageMap[outcome] || 'contacted');
      if (P.flag && P.note) {
        const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
        if (mailTo && !OWNER) C.sendMail(mailTo, '\uD83D\uDEA9 ' + user.name + ' flagged a note: ' + (P.name || phone),
          '<p><b>' + (P.name || phone) + '</b> (' + phone + ')</p><p>"' + P.note + '"</p>', user.email).catch(() => {});
      }
      if (outcome === 'dnc') {
        await sql`INSERT INTO dnc (phone) VALUES (${phone}) ON CONFLICT DO NOTHING`;
        await sql`UPDATE seqs SET status='stopped' WHERE phone=${phone} AND status='active'`;
      }
      if (outcome === 'closed') {
        await sql`UPDATE seqs SET status='done' WHERE phone=${phone} AND status='active'`;
        const mailTo2 = process.env.MAIL_TO || process.env.OWNER_EMAIL;
        if (mailTo2 && !OWNER) C.sendMail(mailTo2, '\uD83C\uDFC6 ' + user.name + ' CLOSED on the phone: ' + (P.name || phone),
          '<p><b>' + user.name + '</b> closed <b>' + (P.name || phone) + '</b> on the call. Contract and checkout are on the way to the client.</p>' +
          (P.note ? '<p>Note: ' + P.note + '</p>' : ''), user.email).catch(() => {});
      }
      if (outcome === 'meeting') {
        await sql`UPDATE seqs SET status='done' WHERE phone=${phone} AND status='active'`;
        await sql`INSERT INTO meetings (phone, business, rep, meet_date, note)
                  VALUES (${phone}, ${P.name || ''}, ${user.email}, ${P.fup || null}, ${P.note || ''})`;
        const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
        if (mailTo && !OWNER) {
          C.sendMail(mailTo, '🎉 ' + user.name + ' booked a meeting: ' + (P.name || phone),
            '<p><b>' + user.name + '</b> set a meeting with <b>' + (P.name || phone) + '</b> (' + phone + ').</p>' +
            '<p>' + (P.note ? 'Note: ' + P.note : 'No note left.') + '</p>' +
            (P.fup ? '<p>Scheduled for: ' + P.fup + '</p>' : ''), user.email).catch(() => {});
        }
      }
      return ok({ id: row[0].id });
    }
    if (a === 'call.undo') {
      const r = await sql`DELETE FROM calls WHERE id=${Number(P.id)} AND rep=${user.email} RETURNING phone, outcome`;
      if (r[0] && r[0].outcome === 'dnc') await sql`DELETE FROM dnc WHERE phone=${r[0].phone}`;
      return ok(true);
    }
    if (a === 'fup.done') {
      await sql`UPDATE calls SET fup_done=true WHERE phone=${C.normPhone(P.phone)} AND fup_done=false`;
      return ok(true);
    }
    if (a === 'history') {
      const q = '%' + String(P.q || '').toLowerCase() + '%';
      const rows = P.q
        ? await sql`SELECT * FROM calls WHERE rep=${user.email} AND (lower(name) LIKE ${q} OR phone LIKE ${q} OR lower(note) LIKE ${q}) ORDER BY ts DESC LIMIT 300`
        : await sql`SELECT * FROM calls WHERE rep=${user.email} ORDER BY ts DESC LIMIT 300`;
      return ok(rows);
    }
    if (a === 'prev.calls') {
      const rows = await sql`SELECT * FROM calls WHERE phone=${C.normPhone(P.phone)} ORDER BY ts DESC LIMIT 6`;
      return ok(rows);
    }

    /* ---------------- EMAIL SCRAPE + SEQUENCES ---------------- */
    if (a === 'scrape') {
      const emails = await C.scrapeEmails(P.url);
      return ok({ emails });
    }
    if (a === 'seq.start') {
      const phone = C.normPhone(P.phone);
      const to = String(P.toEmail || '').trim().toLowerCase();
      if (!phone || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err('Need a valid email address first.');
      const existing = await sql`SELECT id FROM seqs WHERE phone=${phone} AND status='active'`;
      if (existing.length) return err('A sequence is already running for this business.');
      const dncHit = await sql`SELECT phone FROM dnc WHERE phone=${phone}`;
      if (dncHit.length) return err('This number is on the do-not-call list.');
      const ins = await sql`INSERT INTO seqs (phone, business, to_email, rep, industry, city, website, step, status, next_at)
        VALUES (${phone}, ${P.business || ''}, ${to}, ${user.email}, ${P.industry || ''}, ${P.city || ''}, ${P.website || ''}, 0, 'active', now())
        RETURNING *`;
      const s = ins[0];
      await C.upsertCompany({ phone: phone, name: P.business, email: to, website: P.website, city: P.city, industry: P.industry, rep: user.email }, 'contacted');
      const t = C.seqTemplates(s, user.name)[0];
      await C.sendProspectMail(to, t.subject, t.html);
      await sql`UPDATE seqs SET step=1, next_at = now() + make_interval(days => ${C.SEQ_GAPS[1]}::int) WHERE id=${s.id}`;
      await sql`INSERT INTO emails_log (seq_id, phone, to_email, rep, step, subject) VALUES (${s.id}, ${phone}, ${to}, ${user.email}, 1, ${t.subject})`;
      return ok({ started: true });
    }
    if (a === 'seq.preview') {
      /* the exact emails a sequence sends: by sequence id, or for a lead before it starts */
      let s = null, repName = user.name;
      if (P.id) {
        s = (await sql`SELECT s.*, u.name AS rep_name FROM seqs s LEFT JOIN users u ON u.email = s.rep WHERE s.id=${Number(P.id)}`)[0];
        if (!s) return err('Sequence not found.');
        repName = s.rep_name || repName;
      } else {
        s = { business: P.business || '', city: P.city || '', industry: P.industry || '', website: P.website || '' };
      }
      const tpl = C.seqTemplates(s, repName);
      const log = P.id ? await sql`SELECT step, subject, ts FROM emails_log WHERE seq_id=${Number(P.id)} ORDER BY step` : [];
      return ok({ emails: tpl.map((t, i) => ({ step: i + 1, subject: t.subject, html: t.html, gapDays: C.SEQ_GAPS[i] })),
                  log, replyTo: C.prospectReplyTo(), bcc: C.prospectBcc(), seq: P.id ? s : null });
    }
    if (a === 'seq.stop') {
      await sql`UPDATE seqs SET status='stopped' WHERE id=${Number(P.id)} AND (rep=${user.email} OR ${OWNER})`;
      return ok(true);
    }

    /* ---------------- DEALS & COMMISSIONS ---------------- */
    if (a === 'deal.submit') {
      const prod = C.PRODUCTS.find(x => x.id === P.product);
      if (!prod) return err('Pick a product.');
      const amount = Number(P.amount) || prod.amount || prod.monthly || 0;
      await sql`INSERT INTO deals (rep, business, product, kind, amount, monthly, first_comm, rec_comm, note)
        VALUES (${user.email}, ${P.business || ''}, ${prod.label}, ${prod.kind}, ${amount}, ${prod.kind === 'recurring' ? amount : 0}, 0, 0, ${P.note || ''})`;
      if (P.phone) await C.upsertCompany({ phone: P.phone, name: P.business, rep: user.email }, 'contract');
      const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
      if (mailTo && !OWNER) {
        C.sendMail(mailTo, '\uD83D\uDCB0 Closed deal submitted: ' + (P.business || '') + ' - ' + prod.label,
          '<p><b>' + user.name + '</b> marked a deal closed and needs your approval.</p>' +
          '<p>' + (P.business || '') + ' \u00b7 ' + prod.label + ' \u00b7 $' + amount + (prod.kind === 'recurring' ? '/mo' : '') + '</p>', user.email).catch(() => {});
      }
      return ok(true);
    }
    if (a === 'deal.review') {
      if (!OWNER) return err('Owner only.');
      sql`INSERT INTO audit (who, act, target, detail) VALUES (${user.email}, 'deal.review', ${String(P.id||'')}, ${P.approve?'approved':'denied'})`.catch(()=>{});
      const d = (await sql`SELECT * FROM deals WHERE id=${Number(P.id)}`)[0];
      if (!d || d.status !== 'pending') return err('Deal not found or already reviewed.');
      const st = P.approve ? 'approved' : 'denied';
      await sql`UPDATE deals SET status=${st}, reviewed_ts=now(), note=${P.reason ? (d.note + ' | denied: ' + P.reason) : d.note} WHERE id=${d.id}`;
      if (P.approve) {
        // KPI comp plan: 4 closed deals a month hit target, every deal past 4 pays the bonus
        const n = (await sql`SELECT count(*)::int AS n FROM deals WHERE rep=${d.rep} AND status='approved' AND reviewed_ts >= date_trunc('month', now())`)[0].n;
        const target = C.kpiTarget();
        if (n > target) {
          await sql`INSERT INTO ledger (deal_id, rep, label, amount, type)
                    VALUES (${d.id}, ${d.rep}, ${d.business + ' - deal #' + n + ' this month (past the ' + target + ' KPI)'}, ${C.kpiBonus()}, 'bonus')`;
          C.sendMail(d.rep, '\uD83D\uDCB5 Bonus earned: ' + d.business,
            '<p>Deal approved. That is <b>#' + n + '</b> this month, past your KPI of ' + target + ', so <b>$' + C.kpiBonus() + '</b> just hit your ledger.</p>').catch(() => {});
        } else {
          C.sendMail(d.rep, 'Deal approved: ' + d.business,
            '<p>Deal approved. That is <b>#' + n + ' of ' + target + '</b> toward this month\u2019s KPI.' + (n === target ? ' KPI hit. Every deal from here pays $' + C.kpiBonus() + '.' : '') + '</p>').catch(() => {});
        }
        const comp = await sql`SELECT * FROM companies WHERE lower(name)=lower(${d.business}) LIMIT 1`;
        if (comp[0]) await sql`UPDATE companies SET stage='won', updated=now() WHERE phone=${comp[0].phone}`;
        /* new paying customer: open a client account with the onboarding checklist */
        try {
          const have = (await sql`SELECT id, status FROM clients WHERE lower(name)=lower(${d.business})`)[0];
          if (!have) {
            const cm = comp[0] || {};
            const cid = (await sql`INSERT INTO clients (name, email, phone, website, package, mrr, start_date, term_months, status, rep)
              VALUES (${d.business}, ${cm.email || ''}, ${cm.phone || ''}, ${cm.website || ''}, ${d.product || ''}, ${d.kind === 'recurring' ? Number(d.monthly || d.amount) : 0},
                      current_date, 6, 'onboarding', ${d.rep}) RETURNING id`)[0].id;
            await sql`INSERT INTO client_log (client_id, author, note) VALUES (${cid}, ${user.email}, ${'Client created from approved deal (' + (d.product || '') + ')'})`;
            const steps = d.kind === 'recurring'
              ? [['Kickoff call and collect logins', 0], ['Get Google Business Profile manager access', 1], ['Get website / hosting access', 2], ['Baseline rankings + GBP audit', 3], ['Set up review request link and NFC cards', 7], ['NAP / citation cleanup', 7], ['GBP optimization: categories, services, photos', 10], ['Schedule first month of GBP posts', 10], ['30-day check-in call with client', 30]]
              : [['Collect content, logo and photos', 0], ['Sitemap + design direction approved', 5], ['Build draft site', 14], ['Client review round', 18], ['Revisions', 21], ['Launch + Google Analytics / Search Console', 25], ['Post-launch check and speed test', 32]];
            for (const s of steps) await sql`INSERT INTO tasks (client_id, title, due, assignee, created_by) VALUES (${cid}, ${s[0]}, current_date + ${s[1]}::int, ${user.email}, ${user.email})`;
          } else if (have.status === 'churned') {
            await sql`UPDATE clients SET status='onboarding', updated=now() WHERE id=${have.id}`;
            await sql`INSERT INTO client_log (client_id, author, note) VALUES (${have.id}, ${user.email}, 'Won back: new deal approved')`;
          }
        } catch (e) { console.log('[crm] auto-client failed', e.message); }
      }
      if (!P.approve) {
        C.sendMail(d.rep, 'Deal update: ' + d.business,
          '<p>Your deal for <b>' + d.business + '</b> was not approved.</p>' + (P.reason ? '<p>Reason: ' + P.reason + '</p>' : '')).catch(() => {});
      }
      return ok(true);
    }
    if (a === 'deal.cancel') {
      if (!OWNER) return err('Owner only.');
      await sql`UPDATE deals SET status='cancelled', cancelled_ts=now() WHERE id=${Number(P.id)}`;
      return ok(true);
    }
    if (a === 'clients.list') {
      if (!OWNER) return err('Owner only.');
      const rows = await sql`SELECT d.id, d.rep, d.business, d.product, d.monthly, d.kind, COALESCE(d.reviewed_ts, d.ts) AS start, c.phone
        FROM deals d LEFT JOIN companies c ON lower(c.name)=lower(d.business)
        WHERE d.status='approved' AND d.kind='recurring' AND d.cancelled_ts IS NULL ORDER BY COALESCE(d.reviewed_ts, d.ts) DESC`;
      return ok(rows);
    }
    if (a === 'ledger.payAll') {
      if (!OWNER) return err('Owner only.');
      await sql`UPDATE ledger SET status='paid', paid_ts=now() WHERE status='earned' AND rep=${P.rep || ''}`;
      return ok(true);
    }

    /* ---------------- MEETINGS PIPELINE ---------------- */
    if (a === 'meeting.set') {
      const allowed = ['set', 'showed', 'no_show', 'proposal', 'closed_won', 'closed_lost'];
      if (allowed.indexOf(P.status) === -1) return err('Bad status.');
      await sql`UPDATE meetings SET status=${P.status}, note=${P.note || ''} WHERE id=${Number(P.id)} AND (rep=${user.email} OR ${OWNER})`;
      return ok(true);
    }
    if (a === 'meeting.date') {
      await sql`UPDATE meetings SET meet_date=${P.date || null}, alerted=false WHERE id=${Number(P.id)} AND (rep=${user.email} OR ${OWNER})`;
      return ok(true);
    }

    /* ---------------- FOLLOW-UP SNOOZE ---------------- */
    if (a === 'fup.snooze') {
      const phone = C.normPhone(P.phone);
      const days = Math.max(1, Math.min(30, Number(P.days) || 1));
      await sql`UPDATE calls SET fup = CURRENT_DATE + ${days} WHERE phone=${phone} AND fup IS NOT NULL AND fup_done=false`;
      return ok(true);
    }

    /* ---------------- RE-ATTACK (old no-answers) ---------------- */
    if (a === 'reattack') {
      const rows = await sql`
        SELECT DISTINCT ON (c.phone) c.* FROM calls c
        WHERE c.phone NOT IN (SELECT phone FROM dnc)
        ORDER BY c.phone, c.ts DESC`;
      const list = rows.filter(r =>
        ['no_answer', 'voicemail'].indexOf(r.outcome) > -1 &&
        (Date.now() - new Date(r.ts).getTime()) > 30 * 86400000
      ).slice(0, 50).map(r => ({
        name: r.name, phone: r.phone, website: r.website, email: r.email, rating: Number(r.rating) || 0,
        reviews: r.reviews == null ? -1 : Number(r.reviews), pos: Number(r.pos) || 0, addr: r.addr, maps: r.maps,
        town: r.city, industry: r.industry, src: r.src || ''
      }));
      return ok({ list });
    }

    /* ---------------- STATS BREAKDOWN ---------------- */
    if (a === 'stats.breakdown') {
      const byHour = await sql`
        SELECT extract(hour from ts)::int AS h, count(*)::int AS dials,
               count(*) FILTER (WHERE outcome IN ('callback','not_interested','meeting','gatekeeper'))::int AS convos
        FROM calls WHERE rep=${user.email} GROUP BY 1 ORDER BY 1`;
      const byInd = await sql`
        SELECT industry, count(*)::int AS dials,
               count(*) FILTER (WHERE outcome IN ('callback','not_interested','meeting','gatekeeper'))::int AS convos,
               count(*) FILTER (WHERE outcome = 'meeting')::int AS meetings
        FROM calls WHERE rep=${user.email} AND industry <> '' GROUP BY 1 ORDER BY dials DESC LIMIT 12`;
      return ok({ byHour, byInd });
    }

    /* ---------------- ONE-OFF EMAIL ---------------- */
    if (a === 'email.oneoff') {
      const to = String(P.toEmail || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err('Need a valid email address.');
      const subject = String(P.subject || '').trim();
      const bodyTxt = String(P.body || '').trim();
      if (!subject || !bodyTxt) return err('Subject and message are both needed.');
      const html = bodyTxt.split('\n').map(l => '<p>' + l.replace(/</g, '&lt;') + '</p>').join('') +
        '<p>' + user.name + '<br>Burket Web Design, Altoona PA</p>';
      await C.sendProspectMail(to, subject, html);
      await sql`INSERT INTO emails_log (seq_id, phone, to_email, rep, step, subject) VALUES (0, ${C.normPhone(P.phone) || ''}, ${to}, ${user.email}, 0, ${subject})`;
      return ok(true);
    }

    /* ---------------- TWILIO BROWSER DIALER ---------------- */
    if (a === 'twilio.token') {
      if (!C.twilioReady()) return err('The browser dialer is not configured. Ask Ty to add the Twilio env vars in Vercel.');
      const mk = 'twMin_' + new Date().toISOString().slice(0, 7);
      const row = await sql`SELECT v FROM kv WHERE k=${mk}`;
      const used = row[0] ? Number(row[0].v) : 0;
      const cap = Number(process.env.TWILIO_CAP_MIN) || 1100;
      if (used >= cap) return err('The monthly calling budget (' + cap + ' min) is used up. It resets on the 1st, or Ty can raise TWILIO_CAP_MIN.');
      return ok({ token: C.twilioToken(user.email), numbers: [C.callerFor(user)], callerId: C.callerFor(user), minutesLeft: cap - used });
    }
    if (a === 'twilio.log') {
      const mins = Math.max(1, Math.ceil((Number(P.seconds) || 0) / 60));
      const mk = 'twMin_' + new Date().toISOString().slice(0, 7);
      await sql`INSERT INTO kv (k, v) VALUES (${mk}, ${String(mins)})
                ON CONFLICT (k) DO UPDATE SET v = (kv.v::int + ${mins})::text`;
      return ok(true);
    }

    /* ---------------- CRM: PIPELINE & COMPANY TIMELINE ---------------- */
    if (a === 'pipeline.list') {
      const rows = await sql`SELECT * FROM companies WHERE stage NOT IN ('new') OR rep <> '' ORDER BY updated DESC LIMIT 400`;
      return ok(rows);
    }
    if (a === 'company.get') {
      const phone = C.normPhone(P.phone);
      const comp = (await sql`SELECT * FROM companies WHERE phone=${phone}`)[0];
      if (!comp) return err('No company on file for that number.');
      const callsT = await sql`SELECT 'call' AS kind, id, outcome, outcome AS label, note, obj, rep, ts, to_char(fup, 'YYYY-MM-DD') AS fup, fup_done, COALESCE(fup_rep,'') AS fup_rep FROM calls WHERE phone=${phone} ORDER BY ts DESC LIMIT 40`;
      const notesT = await sql`SELECT 'note' AS kind, id, 'note' AS label, note, author AS rep, ts FROM company_notes WHERE phone=${phone} ORDER BY ts DESC LIMIT 40`;
      const emailsT = await sql`SELECT 'email' AS kind, subject AS label, '' AS note, rep, ts FROM emails_log WHERE phone=${phone} ORDER BY ts DESC LIMIT 30`;
      const meetT = await sql`SELECT 'meeting' AS kind, status AS label, note, rep, ts FROM meetings WHERE phone=${phone} ORDER BY ts DESC LIMIT 10`;
      const propT = await sql`SELECT 'proposal' AS kind, products AS label, note, rep, ts FROM proposals WHERE phone=${phone} ORDER BY ts DESC LIMIT 10`;
      const contT = await sql`SELECT 'contract' AS kind, (product || ' - ' || status) AS label, '' AS note, rep, ts FROM contracts WHERE phone=${phone} ORDER BY ts DESC LIMIT 10`;
      const timeline = [].concat(callsT, notesT, emailsT, meetT, propT, contT)
        .sort((x, y) => new Date(y.ts) - new Date(x.ts)).slice(0, 80);
      const credit = (await sql`SELECT rep, count(*)::int AS deals FROM deals WHERE lower(business)=lower(${comp.name || ''}) AND status <> 'cancelled' GROUP BY rep ORDER BY count(*) DESC LIMIT 1`)[0] || null;
      return ok({ company: comp, timeline: timeline, credit });
    }
    if (a === 'company.note') {
      const phone = C.normPhone(P.phone);
      const note = String(P.note || '').trim().slice(0, 4000);
      if (!phone) return err('Bad phone number.');
      if (!note) return err('Type the note first.');
      const r = await sql`INSERT INTO company_notes (phone, author, note) VALUES (${phone}, ${user.email}, ${note}) RETURNING id`;
      await sql`UPDATE companies SET updated=now() WHERE phone=${phone}`;
      return ok({ id: r[0].id });
    }
    if (a === 'company.note.delete') {
      await sql`DELETE FROM company_notes WHERE id=${Number(P.id)} AND (author=${user.email} OR ${OWNER})`;
      return ok(true);
    }
    if (a === 'call.update') {
      const id = Number(P.id);
      const cur = (await sql`SELECT * FROM calls WHERE id=${id}`)[0];
      if (!cur) return err('That call was not found.');
      if (!OWNER && cur.rep !== user.email) return err('You can only edit your own calls.');
      const allowed = ['no_answer', 'voicemail', 'gatekeeper', 'callback', 'not_interested', 'meeting', 'closed', 'dnc'];
      const outcome = allowed.indexOf(P.outcome) > -1 ? P.outcome : cur.outcome;
      const note = P.note != null ? String(P.note).slice(0, 4000) : cur.note;
      const fup = /^\d{4}-\d{2}-\d{2}$/.test(String(P.fup || '')) ? P.fup : null;
      await sql`UPDATE calls SET outcome=${outcome}, note=${note}, fup=${fup}::date, fup_done=${fup ? false : cur.fup_done} WHERE id=${id}`;
      const phone = cur.phone;
      if (outcome !== cur.outcome) {
        const stageMap = { meeting: 'meeting', callback: 'engaged', closed: 'contract', not_interested: 'contacted', dnc: 'lost' };
        if (stageMap[outcome]) await sql`UPDATE companies SET stage=${stageMap[outcome]}, updated=now() WHERE phone=${phone}`;
        if (outcome === 'dnc') {
          await sql`INSERT INTO dnc (phone) VALUES (${phone}) ON CONFLICT DO NOTHING`;
          await sql`UPDATE seqs SET status='stopped' WHERE phone=${phone} AND status='active'`;
        } else if (cur.outcome === 'dnc') {
          await sql`DELETE FROM dnc WHERE phone=${phone}`;
        }
        if (outcome === 'meeting' || outcome === 'closed') await sql`UPDATE seqs SET status='done' WHERE phone=${phone} AND status='active'`;
        if (outcome === 'meeting') {
          const has = (await sql`SELECT id FROM meetings WHERE phone=${phone} AND status='set'`)[0];
          if (!has) await sql`INSERT INTO meetings (phone, business, rep, meet_date, note) VALUES (${phone}, ${cur.name || ''}, ${cur.rep}, ${fup}::date, ${note || ''})`;
        }
      }
      return ok(true);
    }
    if (a === 'company.stage') {
      const phone = C.normPhone(P.phone);
      const allowed = ['new', 'contacted', 'engaged', 'meeting', 'proposal', 'contract', 'won', 'lost'];
      if (allowed.indexOf(P.stage) === -1) return err('Bad stage.');
      await sql`UPDATE companies SET stage=${P.stage}, lost_reason=${P.stage === 'lost' ? (P.reason || '') : ''}, updated=now() WHERE phone=${phone}`;
      let activeDeals = [];
      if (P.stage === 'lost') {
        await sql`INSERT INTO company_notes (phone, author, note) VALUES (${phone}, ${user.email}, ${'Moved to Lost' + (P.reason ? ': ' + P.reason : '')})`;
        const comp = (await sql`SELECT name FROM companies WHERE phone=${phone}`)[0];
        if (comp && comp.name) activeDeals = await sql`SELECT id, monthly, rep FROM deals WHERE lower(business)=lower(${comp.name}) AND status='approved' AND cancelled_ts IS NULL`;
      }
      return ok({ activeDeals });
    }
    if (a === 'company.credit') {
      if (!OWNER) return err('Owner only.');
      const phone = C.normPhone(P.phone);
      const em = String(P.email || '').toLowerCase().trim();
      const seat = (await sql`SELECT email, name FROM users WHERE email=${em}`)[0];
      if (!seat) return err('No seat with that email.');
      const comp = (await sql`SELECT * FROM companies WHERE phone=${phone}`)[0];
      if (!comp) return err('Company not found.');
      const deals = await sql`SELECT id FROM deals WHERE lower(business)=lower(${comp.name}) AND status <> 'cancelled'`;
      await sql`UPDATE companies SET rep=${em}, updated=now() WHERE phone=${phone}`;
      await sql`UPDATE contracts SET rep=${em} WHERE phone=${phone}`;
      let created = false;
      if (deals.length) {
        const ids = deals.map(d => d.id);
        await sql`UPDATE deals SET rep=${em} WHERE id = ANY(${ids})`;
        await sql`UPDATE ledger SET rep=${em} WHERE deal_id = ANY(${ids})`;
      } else if (P.create) {
        const monthly = Number(P.monthly) || 0;
        await sql`INSERT INTO deals (rep, business, product, kind, amount, monthly, first_comm, rec_comm, status, note, reviewed_ts)
          VALUES (${em}, ${comp.name}, ${'Local Presence - $' + monthly + '/mo'}, 'recurring', ${monthly}, ${monthly}, 0, 0, 'approved', 'Recorded by owner', now())`;
        await sql`UPDATE companies SET stage='won', updated=now() WHERE phone=${phone}`;
        created = true;
      } else {
        return ok({ noDeal: true });
      }
      await sql`INSERT INTO company_notes (phone, author, note) VALUES (${phone}, ${user.email}, ${'Sale credited to ' + (seat.name || em)})`;
      return ok({ created, deals: deals.length });
    }
    if (a === 'company.rename') {
      const phone = C.normPhone(P.phone);
      const name = String(P.name || '').trim().slice(0, 120);
      if (!phone || !name) return err('Need the phone and the new name.');
      const cur = (await sql`SELECT name FROM companies WHERE phone=${phone}`)[0];
      if (cur) await sql`UPDATE companies SET name=${name}, updated=now() WHERE phone=${phone}`;
      else await C.upsertCompany({ phone, name, website: P.website || '', city: P.city || '', industry: P.industry || '', rep: user.email }, 'new');
      await sql`UPDATE calls SET name=${name} WHERE phone=${phone}`;
      await sql`UPDATE meetings SET business=${name} WHERE phone=${phone}`;
      await sql`UPDATE seqs SET business=${name} WHERE phone=${phone}`;
      if (cur && cur.name && cur.name !== name)
        await sql`INSERT INTO company_notes (phone, author, note) VALUES (${phone}, ${user.email}, ${'Renamed from "' + cur.name + '" to "' + name + '"'})`;
      return ok({ name });
    }
    if (a === 'plan.month') {
      if (P.set != null) {
        if (!OWNER) return err('Owner only.');
        const v = ['auto', 'nov', 'dec'].indexOf(P.set) > -1 ? P.set : 'auto';
        await sql`INSERT INTO kv (k, v) VALUES ('plan_month', ${v}) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
        return ok(v);
      }
      const r = (await sql`SELECT v FROM kv WHERE k='plan_month'`)[0];
      return ok(r ? r.v : 'auto');
    }
    if (a === 'company.save') {
      const phone = C.normPhone(P.phone);
      await sql`UPDATE companies SET contact=${P.contact || ''}, email=${(P.email || '').toLowerCase().trim()}, updated=now() WHERE phone=${phone}`;
      return ok(true);
    }

    /* ---------------- PROPOSALS ---------------- */
    if (a === 'proposal.send') {
      const phone = C.normPhone(P.phone);
      const to = String(P.toEmail || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err('Need the client\u2019s email.');
      const picked = (Array.isArray(P.items) ? P.items : []).map(id => C.PRODUCTS.find(x => x.id === id)).filter(Boolean);
      if (!picked.length) return err('Pick at least one product.');
      const biz = P.business || 'your business';
      let total = 0;
      const lines = picked.map(p => {
        const amt = p.amount || p.monthly || 0;
        total += amt;
        return '<tr><td style="padding:8px 14px;border-bottom:1px solid #e3e9f0">' + p.label.split(' - ')[0] + '</td>' +
               '<td style="padding:8px 14px;border-bottom:1px solid #e3e9f0;text-align:right"><b>$' + amt + (p.kind === 'recurring' ? '/mo' : '') + '</b></td></tr>';
      }).join('');
      const checkout = picked.length === 1 ? C.waveLink(picked[0].id) : '';
      let featureHtml = '';
      const hasLP = picked.some(p => p.id === 'lp500' || p.id === 'lp750');
      if (hasLP) {
        featureHtml = '<h3 style="color:#1f5d8c;margin-top:22px">Everything your Local Presence plan includes</h3>' +
          C.LP_FEATURES.map(g => '<p style="margin:10px 0 4px"><b>' + g[0] + '</b></p><ul style="margin:0;padding-left:20px;color:#333">' +
            g[1].map(f => '<li style="margin:3px 0">' + f + '</li>').join('') + '</ul>').join('');
        if (picked.some(p => p.id === 'lp750')) {
          featureHtml += '<p style="margin:10px 0 4px"><b>Plus, on your plan</b></p><ul style="margin:0;padding-left:20px;color:#333">' +
            C.LP750_EXTRA.map(f => '<li style="margin:3px 0">' + f + '</li>').join('') + '</ul>';
        }
      }
      const html = '<div style="font-family:Arial,sans-serif;max-width:560px">' +
        '<img src="https://www.burketwebdesign.com/assets/logo.png" style="height:46px" alt="Burket Web Design">' +
        '<h2 style="color:#0e2235">Proposal for ' + biz + '</h2>' +
        (P.note ? '<p>' + String(P.note).replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</p>' : '') +
        '<table style="border-collapse:collapse;width:100%;background:#f7f9fc;border-radius:10px">' + lines + '</table>' +
        '<p style="font-size:18px"><b>Total: $' + total + '</b></p>' +
        featureHtml +
        (checkout ? '<p><a href="' + checkout + '" style="background:#fec814;color:#0e2235;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:bold">Pay securely online</a></p>' : '') +
        '<p>Questions? Just reply to this email or call us. We only start work once you are completely comfortable.</p>' +
        '<p>' + user.name + '<br>Burket Web Design, Altoona PA<br><a href="https://www.burketwebdesign.com">burketwebdesign.com</a></p></div>';
      await C.sendProspectMail(to, 'Your proposal from Burket Web Design', html);
      await sql`INSERT INTO proposals (phone, rep, to_email, products, total, note, checkout)
                VALUES (${phone}, ${user.email}, ${to}, ${picked.map(p => p.label).join(' + ')}, ${total}, ${P.note || ''}, ${checkout})`;
      await C.upsertCompany({ phone: phone, name: P.business, email: to, rep: user.email }, 'proposal');
      return ok(true);
    }

    /* ---------------- CONTRACTS (DocuSeal) ---------------- */
    if (a === 'contract.send') {
      if (!process.env.DOCUSEAL_API_KEY) return err('DocuSeal is not configured yet (DOCUSEAL_API_KEY).');
      const phone = C.normPhone(P.phone);
      const to = String(P.toEmail || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err('Need the client\u2019s email.');
      const prod = C.PRODUCTS.find(x => x.id === P.product);
      if (!prod) return err('Pick the product.');
      const amount = Number(P.amount) || prod.amount || prod.monthly || 0;
      const tpl = C.docusealTemplate(P.product);
      if (!tpl) return err('No DocuSeal template is set for that product yet (DOCUSEAL_TEMPLATE_* env vars).');
      const sub = await C.docusealSend(tpl, to, P.clientName || P.business || '', {
        business: P.business || '', service: prod.label.split(' - ')[0],
        price: '$' + amount + (prod.kind === 'recurring' ? ' per month' : ''), date: new Date().toLocaleDateString('en-US')
      });
      await sql`INSERT INTO contracts (phone, rep, to_email, client_name, product, amount, docuseal_id)
                VALUES (${phone}, ${user.email}, ${to}, ${P.clientName || ''}, ${prod.label}, ${amount}, ${sub.id})`;
      await C.upsertCompany({ phone: phone, name: P.business, email: to, rep: user.email }, 'contract');
      const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
      if (mailTo && !OWNER) C.sendMail(mailTo, '\uD83D\uDCDD Contract sent: ' + (P.business || to),
        '<p>' + user.name + ' sent the ' + prod.label + ' contract ($' + amount + ') to ' + to + '.</p>').catch(() => {});
      return ok(true);
    }

    /* ---------------- CHECKOUT (Wave) ---------------- */
    if (a === 'checkout.send') {
      const phone = C.normPhone(P.phone);
      const to = String(P.toEmail || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err('Need the client\u2019s email.');
      const prod = C.PRODUCTS.find(x => x.id === P.product);
      const link = prod ? C.waveLink(prod.id) : '';
      if (!link) return err('No Wave checkout link is set for that product yet (ask Ty to add the WAVE_LINK env var).');
      const biz = P.business || 'your business';
      const html = '<div style="font-family:Arial,sans-serif;max-width:560px">' +
        '<img src="https://www.burketwebdesign.com/assets/logo.png" style="height:46px" alt="Burket Web Design">' +
        '<h2 style="color:#0e2235">Ready when you are</h2>' +
        '<p>Here is the secure checkout for <b>' + prod.label.split(' - ')[0] + '</b> for ' + biz + '. It takes about a minute.</p>' +
        '<p><a href="' + link + '" style="background:#fec814;color:#0e2235;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:bold">Complete checkout</a></p>' +
        '<p>Once it goes through, we get to work. Reply to this email with any questions.</p>' +
        '<p>' + user.name + '<br>Burket Web Design, Altoona PA</p></div>';
      await C.sendProspectMail(to, 'Checkout for ' + biz + ' - Burket Web Design', html);
      await sql`INSERT INTO emails_log (seq_id, phone, to_email, rep, step, subject) VALUES (0, ${phone}, ${to}, ${user.email}, 0, ${'Checkout: ' + prod.label})`;
      return ok(true);
    }

    if (a === 'company.delete') {
      if (!OWNER) return err('Owner only.');
      sql`INSERT INTO audit (who, act, target) VALUES (${user.email}, 'company.delete', ${String(P.phone||'')})`.catch(()=>{});
      const phone = C.normPhone(P.phone);
      if (!phone) return err('Bad phone.');
      await sql`DELETE FROM companies WHERE phone=${phone}`;
      return ok(true);
    }
    if (a === 'admin.reset') {
      if (!OWNER) return err('Owner only.');
      if (P.confirm !== 'RESET') return err('Type RESET to confirm.');
      await sql`DELETE FROM calls`;
      await sql`DELETE FROM companies`;
      await sql`DELETE FROM meetings`;
      await sql`DELETE FROM deals`;
      await sql`DELETE FROM ledger`;
      await sql`DELETE FROM seqs`;
      await sql`DELETE FROM emails_log`;
      await sql`DELETE FROM dnc`;
      await sql`DELETE FROM proposals`;
      await sql`DELETE FROM contracts`;
      await sql`DELETE FROM shift_reports`;
      await sql`DELETE FROM kv`;
      return ok(true);
    }

    /* ---------------- TEAM (owner) ---------------- */
    /* ---------------- OWNER ANALYTICS (owner only) ---------------- */
    if (a === 'owner.analytics' || a === 'owner.callsheet') {
      if (!OWNER) return err('Owner only.');
      const isDay = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''));
      const todayET = (await sql`SELECT to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS d`)[0].d;
      const to = isDay(P.to) ? P.to : todayET;
      const from = isDay(P.from) ? P.from : todayET;
      const rep = String(P.rep || '').toLowerCase().trim();   // '' = everyone

      if (a === 'owner.callsheet') {
        const outcome = String(P.outcome || ''), ind = String(P.industry || ''), q = String(P.q || '').trim();
        const like = '%' + q.toLowerCase() + '%';
        const lim = Math.min(Math.max(Number(P.limit) || 50, 1), 5000), off = Math.max(Number(P.offset) || 0, 0);
        const rows = await sql`SELECT c.id, c.ts, c.rep, u.name AS rep_name, c.name, c.phone, c.city, c.industry, c.outcome, c.note, c.obj,
            to_char(c.fup, 'YYYY-MM-DD') AS fup, c.secs, c.pos, c.reviews, c.rating, c.website
          FROM calls c LEFT JOIN users u ON u.email = c.rep
          WHERE (c.ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date
            AND (${rep} = '' OR c.rep = ${rep}) AND (${outcome} = '' OR c.outcome = ${outcome})
            AND (${ind} = '' OR c.industry = ${ind})
            AND (${q} = '' OR lower(c.name || ' ' || c.phone || ' ' || c.note || ' ' || c.city) LIKE ${like})
          ORDER BY c.ts DESC LIMIT ${lim} OFFSET ${off}`;
        const total = (await sql`SELECT count(*)::int AS n FROM calls c
          WHERE (c.ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date
            AND (${rep} = '' OR c.rep = ${rep}) AND (${outcome} = '' OR c.outcome = ${outcome})
            AND (${ind} = '' OR c.industry = ${ind})
            AND (${q} = '' OR lower(c.name || ' ' || c.phone || ' ' || c.note || ' ' || c.city) LIKE ${like})`)[0].n;
        return ok({ rows, total, from, to });
      }

      const CONV = ['callback', 'not_interested', 'meeting', 'closed', 'dnc'];
      const totals = (await sql`SELECT count(*)::int AS dials,
          count(*) FILTER (WHERE outcome = ANY(${CONV}))::int AS convos,
          count(*) FILTER (WHERE outcome='meeting')::int AS meetings,
          count(*) FILTER (WHERE outcome='closed')::int AS closed,
          count(*) FILTER (WHERE outcome='callback')::int AS callbacks,
          count(*) FILTER (WHERE outcome='not_interested')::int AS not_int,
          count(*) FILTER (WHERE outcome='gatekeeper')::int AS gatekeepers,
          count(*) FILTER (WHERE outcome='voicemail')::int AS voicemails,
          count(*) FILTER (WHERE outcome='no_answer')::int AS no_answer,
          count(*) FILTER (WHERE outcome='dnc')::int AS dnc,
          COALESCE(sum(secs),0)::int AS secs,
          count(DISTINCT (ts AT TIME ZONE 'America/New_York')::date)::int AS days,
          count(DISTINCT phone)::int AS businesses
        FROM calls WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})`)[0];
      const grp = async (col) => {
        if (col === 'industry') return sql`SELECT COALESCE(NULLIF(industry,''),'Unknown') AS k, count(*)::int AS dials,
            count(*) FILTER (WHERE outcome = ANY(${CONV}))::int AS convos, count(*) FILTER (WHERE outcome='callback')::int AS callbacks,
            count(*) FILTER (WHERE outcome='meeting')::int AS meetings, count(*) FILTER (WHERE outcome='closed')::int AS closed,
            count(*) FILTER (WHERE outcome='gatekeeper')::int AS gatekeepers
          FROM calls WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})
          GROUP BY 1 ORDER BY dials DESC LIMIT 30`;
        return sql`SELECT COALESCE(NULLIF(city,''),'Unknown') AS k, count(*)::int AS dials,
            count(*) FILTER (WHERE outcome = ANY(${CONV}))::int AS convos, count(*) FILTER (WHERE outcome='callback')::int AS callbacks,
            count(*) FILTER (WHERE outcome='meeting')::int AS meetings, count(*) FILTER (WHERE outcome='closed')::int AS closed,
            count(*) FILTER (WHERE outcome='gatekeeper')::int AS gatekeepers
          FROM calls WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})
          GROUP BY 1 ORDER BY dials DESC LIMIT 30`;
      };
      const byInd = await grp('industry');
      const byCity = await grp('city');
      const byHour = await sql`SELECT extract(hour from ts AT TIME ZONE 'America/New_York')::int AS h, count(*)::int AS dials,
          count(*) FILTER (WHERE outcome = ANY(${CONV}))::int AS convos, count(*) FILTER (WHERE outcome IN ('meeting','closed'))::int AS wins
        FROM calls WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})
        GROUP BY 1 ORDER BY 1`;
      const byDow = await sql`SELECT extract(isodow from ts AT TIME ZONE 'America/New_York')::int AS d, count(*)::int AS dials,
          count(*) FILTER (WHERE outcome = ANY(${CONV}))::int AS convos, count(*) FILTER (WHERE outcome IN ('meeting','closed'))::int AS wins
        FROM calls WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})
        GROUP BY 1 ORDER BY 1`;
      const daily = await sql`SELECT to_char((ts AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS d, count(*)::int AS dials,
          count(*) FILTER (WHERE outcome = ANY(${CONV}))::int AS convos, count(*) FILTER (WHERE outcome='meeting')::int AS meetings,
          count(*) FILTER (WHERE outcome='closed')::int AS closed,
          to_char(min(ts AT TIME ZONE 'America/New_York'), 'HH12:MI AM') AS first_call, to_char(max(ts AT TIME ZONE 'America/New_York'), 'HH12:MI AM') AS last_call
        FROM calls WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})
        GROUP BY 1 ORDER BY 1`;
      const objections = await sql`SELECT obj, count(*)::int AS n FROM calls WHERE obj <> ''
        AND (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})
        GROUP BY 1 ORDER BY n DESC LIMIT 12`;
      const reps = await sql`SELECT u.email, u.name, u.role, COALESCE(u.active,1) AS active,
          count(c.id)::int AS dials, count(c.id) FILTER (WHERE c.outcome = ANY(${CONV}))::int AS convos,
          count(c.id) FILTER (WHERE c.outcome='meeting')::int AS meetings, count(c.id) FILTER (WHERE c.outcome='closed')::int AS closed,
          count(DISTINCT (c.ts AT TIME ZONE 'America/New_York')::date)::int AS days
        FROM users u LEFT JOIN calls c ON c.rep = u.email
          AND (c.ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date
        GROUP BY u.email, u.name, u.role, u.active ORDER BY dials DESC`;
      const emails = (await sql`SELECT count(*)::int AS n FROM emails_log WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})`)[0].n;
      const seqsStarted = (await sql`SELECT count(*)::int AS n FROM seqs WHERE (started AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})`)[0].n;
      const meetStatus = await sql`SELECT status, count(*)::int AS n FROM meetings WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep}) GROUP BY 1`;
      const deals = (await sql`SELECT count(*)::int AS n, COALESCE(sum(monthly),0)::numeric AS mrr, COALESCE(sum(amount),0)::numeric AS onetime
        FROM deals WHERE status='approved' AND (COALESCE(reviewed_ts, ts) AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})`)[0];
      const contracts = (await sql`SELECT count(*)::int AS sent, count(*) FILTER (WHERE status='signed' OR signed_ts IS NOT NULL)::int AS signed
        FROM contracts WHERE (ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep})`)[0];
      const overdue = (await sql`SELECT count(DISTINCT phone)::int AS n FROM calls WHERE fup IS NOT NULL AND fup_done=false
        AND fup < (now() AT TIME ZONE 'America/New_York')::date AND outcome NOT IN ('meeting','dnc','closed') AND (${rep} = '' OR rep = ${rep})`)[0].n;
      const reports = await sql`SELECT to_char(day, 'YYYY-MM-DD') AS d, rep_name, dials, meetings, closed, well, bad, improve, need
        FROM shift_reports WHERE day BETWEEN ${from}::date AND ${to}::date AND (${rep} = '' OR rep = ${rep}) ORDER BY day DESC, ts DESC LIMIT 30`;
      const wins = await sql`SELECT c.ts, c.name, c.phone, c.city, c.industry, c.outcome, c.note, u.name AS rep_name FROM calls c LEFT JOIN users u ON u.email=c.rep
        WHERE c.outcome IN ('meeting','closed') AND (c.ts AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date
          AND (${rep} = '' OR c.rep = ${rep}) ORDER BY c.ts DESC LIMIT 25`;
      return ok({ from, to, rep, totals, byInd, byCity, byHour, byDow, daily, objections, reps, emails, seqsStarted,
                  meetStatus, deals, contracts, overdue, reports, wins, kpi: { target: C.kpiTarget(), bonus: C.kpiBonus() } });
    }

    /* ---------------- CUSTOM LEAD LISTS (owner hands lists to a rep; they live in the Custom Lists tab) ---------------- */
    async function readLists(em) {
      const rows = await sql`SELECT k, v FROM kv WHERE k = ${'lists_' + em} OR k = ${'assigned_' + em}`;
      let lists = [];
      const main = rows.find(r => r.k === 'lists_' + em);
      if (main) { try { lists = JSON.parse(main.v) || []; } catch (e) { lists = []; } }
      const legacy = rows.find(r => r.k === 'assigned_' + em);
      if (legacy) {                                   // migrate the older single-list format
        try { const one = JSON.parse(legacy.v); if (one && one.list) { one.id = one.id || C.uid(); lists.unshift(one); } } catch (e) {}
        await sql`INSERT INTO kv (k, v) VALUES (${'lists_' + em}, ${JSON.stringify(lists)}) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
        await sql`DELETE FROM kv WHERE k = ${'assigned_' + em}`;
      }
      return lists;
    }
    async function writeLists(em, lists) {
      await sql`INSERT INTO kv (k, v) VALUES (${'lists_' + em}, ${JSON.stringify(lists)}) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
    }
    if (a === 'leads.assign') {
      if (!OWNER) return err('Owner only.');
      const em = String(P.email || '').toLowerCase().trim();
      const seat = (await sql`SELECT email FROM users WHERE email=${em}`)[0];
      if (!seat) return err('No seat with that email.');
      const list = (Array.isArray(P.list) ? P.list : []).map(b => ({
        name: String(b.name || '').slice(0, 120), phone: C.normPhone(b.phone), town: String(b.town || '').slice(0, 60),
        addr: String(b.addr || '').slice(0, 160), industry: String(b.industry || '').slice(0, 80), contact: String(b.contact || '').slice(0, 80),
        email: String(b.email || '').slice(0, 120), website: String(b.website || '').slice(0, 200), why: String(b.why || '').slice(0, 300),
        reviews: b.reviews == null || b.reviews === '' ? -1 : Number(b.reviews) || 0, rating: Number(b.rating) || 0, pos: Number(b.pos) || 0
      })).filter(b => b.phone);
      if (!list.length) return err('No leads with a valid phone number.');
      const lists = await readLists(em);
      const title = String(P.title || 'Leads from Ty').slice(0, 80);
      const entry = { id: C.uid(), title, region: String(P.region || '').slice(0, 30), by: user.name, ts: new Date().toISOString(), list };
      const keep = lists.filter(l => l.title !== title);             // re-assigning the same title replaces it
      keep.unshift(entry);
      await writeLists(em, keep.slice(0, 20));
      return ok({ count: list.length, id: entry.id });
    }
    if (a === 'leads.lists') {
      const em = OWNER && P.email ? String(P.email).toLowerCase() : user.email;
      const lists = await readLists(em);
      const phones = [].concat.apply([], lists.map(l => l.list.map(b => b.phone)));
      const last = {};
      if (phones.length) {
        (await sql`SELECT DISTINCT ON (phone) phone, outcome, rep, ts FROM calls WHERE phone = ANY(${phones}) ORDER BY phone, ts DESC`)
          .forEach(r => { last[r.phone] = { outcome: r.outcome, rep: r.rep, ts: r.ts }; });
      }
      lists.forEach(l => l.list.forEach(b => { b.last = last[b.phone] || null; }));
      return ok({ email: em, lists });
    }
    if (a === 'leads.list.delete') {
      const em = OWNER && P.email ? String(P.email).toLowerCase() : user.email;
      if (!OWNER) return err('Only Ty can remove a list.');
      const lists = (await readLists(em)).filter(l => l.id !== P.id);
      await writeLists(em, lists);
      return ok(true);
    }
    if (a === 'leads.assigned') {                       // kept for older pages: first list
      const lists = await readLists(OWNER && P.email ? String(P.email).toLowerCase() : user.email);
      return ok(lists[0] || null);
    }
    if (a === 'leads.assigned.clear') { return ok(true); }

    /* ---------------- EXTRA NUMBERS ON A LEAD ---------------- */
    if (a === 'company.alts') {
      const phone = C.normPhone(P.phone);
      const row = phone ? (await sql`SELECT alt_phones FROM companies WHERE phone=${phone}`)[0] : null;
      let alts = []; try { alts = JSON.parse((row && row.alt_phones) || '[]'); } catch (e) { alts = []; }
      return ok(alts);
    }
    if (a === 'company.altphone') {
      const phone = C.normPhone(P.phone);
      if (!phone) return err('Bad lead phone number.');
      let row = (await sql`SELECT alt_phones FROM companies WHERE phone=${phone}`)[0];
      if (!row) {
        await C.upsertCompany({ phone, name: P.name, website: P.website, city: P.city, industry: P.industry,
          rating: P.rating, reviews: P.reviews, pos: P.pos, addr: P.addr, maps: P.maps, rep: user.email }, 'new');
        row = { alt_phones: '' };
      }
      let alts = []; try { alts = JSON.parse(row.alt_phones || '[]'); } catch (e) { alts = []; }
      const alt = C.normPhone(P.alt);
      if (P.remove) alts = alts.filter(x => x.n !== alt);
      else {
        if (!alt) return err('That number does not look right. Use 10 digits.');
        if (alt === phone) return err('That is already the main number.');
        alts = alts.filter(x => x.n !== alt);
        alts.unshift({ n: alt, label: String(P.label || '').trim().slice(0, 40) });
        alts = alts.slice(0, 8);
      }
      await sql`UPDATE companies SET alt_phones=${JSON.stringify(alts)}, updated=now() WHERE phone=${phone}`;
      return ok(alts);
    }

    /* ---------------- SCREEN POP: who is calling? ---------------- */
    if (a === 'inbound.list') {
      const days = Math.min(Number(P.days) || 14, 60);
      const rows = await sql`SELECT i.*, COALESCE(c.name, '') AS name, COALESCE(c.city, '') AS city, COALESCE(c.stage, '') AS stage,
          (SELECT outcome FROM calls WHERE phone=i.phone ORDER BY ts DESC LIMIT 1) AS last_out
        FROM inbound i LEFT JOIN companies c ON c.phone=i.phone
        WHERE i.ts > now() - ${days + ' days'}::interval ORDER BY i.ts DESC LIMIT 150`;
      const mine = OWNER ? rows : rows.filter(r => !r.rep || r.rep === user.email);
      return ok({ rows: mine, open: mine.filter(r => r.status === 'missed').length });
    }
    if (a === 'inbound.done') {
      const id = Number(P.id) || 0;
      if (id) await sql`UPDATE inbound SET status='called_back', done_by=${user.email}, done_ts=now() WHERE id=${id} AND status='missed'`;
      else if (P.phone) await sql`UPDATE inbound SET status='called_back', done_by=${user.email}, done_ts=now() WHERE phone=${C.normPhone(P.phone)} AND status='missed'`;
      return ok({});
    }
    if (a === 'inbound.dismiss') {
      await sql`UPDATE inbound SET status='dismissed', done_by=${user.email}, done_ts=now() WHERE id=${Number(P.id) || 0}`;
      return ok({});
    }
    if (a === 'company.lookup') {
      const phone = C.normPhone(P.phone);
      if (!phone) return ok({ found: false });
      let comp = (await sql`SELECT * FROM companies WHERE phone=${phone}`)[0];
      let viaAlt = null;
      if (!comp) {
        comp = (await sql`SELECT * FROM companies WHERE alt_phones LIKE ${'%"' + phone + '"%'} LIMIT 1`)[0];
        if (comp) { try { viaAlt = JSON.parse(comp.alt_phones || '[]').find(x => x.n === phone) || { n: phone, label: '' }; } catch (e) { viaAlt = { n: phone, label: '' }; } }
      }
      const mainPhone = comp ? comp.phone : phone;
      const last = await sql`SELECT outcome, note, rep, ts, fup FROM calls WHERE phone=${mainPhone} ORDER BY ts DESC LIMIT 3`;
      if (!comp) {
        const lc = (await sql`SELECT * FROM calls WHERE phone=${phone} ORDER BY ts DESC LIMIT 1`)[0];
        if (!lc) return ok({ found: false, phone });
        comp = { phone, name: lc.name, website: lc.website, email: lc.email, city: lc.city, industry: lc.industry,
                 rating: lc.rating, reviews: lc.reviews, pos: lc.pos, addr: lc.addr, maps: lc.maps, stage: 'contacted', contact: '' };
      }
      const em = (await sql`SELECT subject, ts FROM emails_log WHERE phone=${mainPhone} ORDER BY ts DESC LIMIT 1`)[0] || null;
      const mt = (await sql`SELECT meet_date, status FROM meetings WHERE phone=${mainPhone} ORDER BY ts DESC LIMIT 1`)[0] || null;
      return ok({ found: true, company: comp, last, lastEmail: em, meeting: mt, viaAlt });
    }

    /* ---------------- MORNING START + END-OF-SHIFT REPORT ---------------- */
    if (a === 'morning') {
      const lastDay = (await sql`SELECT to_char(max((ts AT TIME ZONE 'America/New_York')::date), 'YYYY-MM-DD') AS d FROM calls
        WHERE rep=${user.email} AND (ts AT TIME ZONE 'America/New_York')::date < (now() AT TIME ZONE 'America/New_York')::date`)[0].d;
      let prev = null;
      if (lastDay) {
        prev = (await sql`SELECT count(*)::int AS dials,
            count(*) FILTER (WHERE outcome IN ('callback','not_interested','meeting','closed','dnc'))::int AS convos,
            count(*) FILTER (WHERE outcome='meeting')::int AS meetings,
            count(*) FILTER (WHERE outcome='closed')::int AS closed
          FROM calls WHERE rep=${user.email} AND (ts AT TIME ZONE 'America/New_York')::date = ${lastDay}::date`)[0];
        prev.day = lastDay;
      }
      const meetSoon = await sql`SELECT business, meet_date, phone FROM meetings WHERE (rep=${user.email} OR ${OWNER})
        AND status='set' AND meet_date >= (now() AT TIME ZONE 'America/New_York')::date
        AND meet_date <= (now() AT TIME ZONE 'America/New_York')::date + 7 ORDER BY meet_date LIMIT 8`;
      const monthMeet = (await sql`SELECT count(*)::int AS n FROM calls WHERE rep=${user.email} AND outcome='meeting'
        AND ts >= date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'`)[0].n;
      return ok({ prev, meetSoon, monthMeet });
    }
    async function shiftStats(email) {
      const r = (await sql`SELECT count(*)::int AS dials,
          count(*) FILTER (WHERE outcome IN ('callback','not_interested','meeting','closed','dnc'))::int AS convos,
          count(*) FILTER (WHERE outcome='meeting')::int AS meetings,
          count(*) FILTER (WHERE outcome='closed')::int AS closed,
          count(*) FILTER (WHERE outcome='voicemail')::int AS voicemails,
          count(*) FILTER (WHERE outcome='callback')::int AS callbacks,
          count(*) FILTER (WHERE outcome='gatekeeper')::int AS gatekeepers,
          count(*) FILTER (WHERE outcome='not_interested')::int AS not_int,
          min(ts) AS first_ts, max(ts) AS last_ts
        FROM calls WHERE rep=${email} AND (ts AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`)[0];
      r.emails = (await sql`SELECT count(*)::int AS n FROM emails_log WHERE rep=${email}
        AND (ts AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`)[0].n;
      const ob = await sql`SELECT obj, count(*)::int AS n FROM calls WHERE rep=${email} AND obj <> ''
        AND (ts AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date GROUP BY obj ORDER BY n DESC`;
      r.objections = ob.map(o => o.obj + ' (' + o.n + ')').join(', ');
      r.wins = await sql`SELECT name, outcome, note FROM calls WHERE rep=${email} AND outcome IN ('meeting','closed','callback')
        AND (ts AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date ORDER BY ts`;
      r.day = (await sql`SELECT to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS d`)[0].d;
      r.sent = (await sql`SELECT count(*)::int AS n FROM shift_reports WHERE rep=${email} AND day=${r.day}::date`)[0].n > 0;
      return r;
    }
    if (a === 'shift.preview') {
      return ok(await shiftStats(user.email));
    }
    if (a === 'shift.submit') {
      const st = await shiftStats(user.email);
      const T = k => String(P[k] || '').trim().slice(0, 2000);
      await sql`INSERT INTO shift_reports (rep, rep_name, day, dials, convos, meetings, closed, voicemails, callbacks, gatekeepers, not_int, emails, objections, well, bad, improve, need)
        VALUES (${user.email}, ${user.name}, ${st.day}::date, ${st.dials}, ${st.convos}, ${st.meetings}, ${st.closed}, ${st.voicemails}, ${st.callbacks},
                ${st.gatekeepers}, ${st.not_int}, ${st.emails}, ${st.objections}, ${T('well')}, ${T('bad')}, ${T('improve')}, ${T('need')})`;
      const esc = x => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const dayTxt = new Date(String(st.day).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const rate = st.dials ? Math.round(st.convos / st.dials * 100) : 0;
      const box = (n, l) => '<td style="padding:10px 6px;text-align:center;background:#f7f9fc;border-radius:10px"><div style="font-size:24px;font-weight:bold;color:#0e2235">' + n + '</div><div style="font-size:11px;color:#5b6b80">' + l + '</div></td>';
      const qa = (q, v) => '<p style="margin:16px 0 4px;font-weight:bold;color:#0e2235">' + q + '</p><p style="margin:0;color:#1a2435;line-height:1.6">' + (v ? esc(v) : '<span style="color:#8b9ab0">Nothing added.</span>') + '</p>';
      const wins = (st.wins || []).map(w => '<li>' + esc(w.name || 'Unknown') + ': ' + esc(String(w.outcome).replace('_', ' ')) + (w.note ? ' (' + esc(w.note) + ')' : '') + '</li>').join('');
      const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#ffffff">' +
        '<div style="background:#0e2235;padding:20px 24px;border-radius:14px 14px 0 0"><img src="https://www.burketwebdesign.com/assets/logo.png" alt="Burket Web Design" style="height:40px"></div>' +
        '<div style="padding:24px;border:1px solid #e3e9f0;border-top:none;border-radius:0 0 14px 14px">' +
        '<h2 style="margin:0;color:#0e2235">End-of-shift report</h2><p style="margin:4px 0 18px;color:#5b6b80">' + esc(user.name) + ' &middot; ' + dayTxt + '</p>' +
        '<table role="presentation" width="100%" cellspacing="6" cellpadding="0"><tr>' + box(st.dials, 'dials') + box(st.convos, 'conversations') + box(st.meetings, 'meetings booked') + box(st.closed, 'sold') + '</tr></table>' +
        '<p style="color:#5b6b80;font-size:13px;margin:12px 0 0">Conversation rate ' + rate + '% &middot; ' + st.voicemails + ' voicemails &middot; ' + st.callbacks + ' callbacks set &middot; ' + st.gatekeepers + ' gatekeepers &middot; ' + st.emails + ' emails sent</p>' +
        (st.objections ? '<p style="color:#5b6b80;font-size:13px;margin:6px 0 0">Objections heard: ' + esc(st.objections) + '</p>' : '') +
        (wins ? '<p style="margin:16px 0 4px;font-weight:bold;color:#0e2235">Wins and warm leads</p><ul style="margin:0;padding-left:18px;color:#1a2435;line-height:1.6">' + wins + '</ul>' : '') +
        qa('What went well today?', T('well')) + qa('What did not go well?', T('bad')) + qa('Areas for improvement tomorrow', T('improve')) + qa('Anything needed from Ty?', T('need')) +
        '<p style="margin:22px 0 0;font-size:12px;color:#8b9ab0">Sent from the BWD Sales Hub. Numbers are pulled automatically from logged calls.</p></div></div>';
      const subj = 'Shift report: ' + user.name + ', ' + dayTxt + ' (' + st.dials + ' dials, ' + st.meetings + ' meetings' + (st.closed ? ', ' + st.closed + ' sold' : '') + ')';
      const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
      let emailed = false, emailError = '';
      try {
        if (mailTo) { await C.sendMail(mailTo, subj, html, user.email); emailed = true; }
        if (mailTo && mailTo.toLowerCase() !== user.email.toLowerCase()) await C.sendMail(user.email, 'Your copy: ' + subj, html).catch(() => {});
      } catch (e) { emailError = e.message || String(e); }
      return ok({ emailed, emailError });
    }
    if (a === 'shift.list') {
      const rows = OWNER
        ? await sql`SELECT *, to_char(day, 'YYYY-MM-DD') AS dayk FROM shift_reports ORDER BY ts DESC LIMIT 40`
        : await sql`SELECT *, to_char(day, 'YYYY-MM-DD') AS dayk FROM shift_reports WHERE rep=${user.email} ORDER BY ts DESC LIMIT 20`;
      return ok(rows);
    }

    if (a === 'user.invite') {
      if (!OWNER) return err('Owner only.');
      const em = String(P.email || '').toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('That email does not look right.');
      const existing = (await sql`SELECT email FROM users WHERE email=${em} AND COALESCE(active,1)=1`)[0];
      if (existing) return err('They already have an active seat.');
      const token = C.uid();
      await sql`UPDATE invites SET used=1 WHERE email=${em} AND used=0`;
      await sql`INSERT INTO invites (token, email, name, invited_by) VALUES (${token}, ${em}, ${String(P.name || '').trim()}, ${user.email})`;
      const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'sales-eta-livid.vercel.app');
      const link = base + '/?invite=' + token;
      let emailed = false, emailError = '', emailId = '';
      try {
        const mr = await C.sendMail(em, 'Your seat on the Burket Web Design sales team',
        '<div style="font-family:Arial,sans-serif;max-width:540px">' +
        '<img src="https://www.burketwebdesign.com/assets/logo.png" style="height:46px" alt="Burket Web Design">' +
        '<h2 style="color:#0e2235">Welcome aboard' + (P.name ? ', ' + String(P.name).split(' ')[0] : '') + '</h2>' +
        '<p>Ty set you up with a seat on the BWD Sales Hub: your dialer, scripts, pipeline, contracts, and commissions, all in one place.</p>' +
        '<p><a href="' + link + '" style="background:#fec814;color:#0e2235;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:bold">Create your account</a></p>' +
        '<p style="color:#8b9ab0;font-size:12px">This link is for you only and expires in 14 days. If the button does not work, paste this into your browser:<br>' + link + '</p></div>');
        emailed = true; emailId = (mr && mr.id) || '';
      } catch (e) { emailError = e.message || String(e); }
      return ok({ link, emailed, emailError, emailId });
    }
    if (a === 'user.list') {
      if (!OWNER) return err('Owner only.');
      const users = (await sql`SELECT email, name, role, COALESCE(active,1) AS active, created, COALESCE(territory,'') AS territory, COALESCE(caller_id,'') AS caller_id FROM users ORDER BY created`)
        .map(u => Object.assign(u, { territoryEff: C.territoryFor(u), callerEff: C.callerFor(u) }));
      const base2 = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'sales-eta-livid.vercel.app');
      const pend = await sql`SELECT token, email, name, ts FROM invites WHERE used=0 AND ts > now() - interval '14 days' ORDER BY ts DESC`;
      const pending = pend.map(p => ({ email: p.email, name: p.name, ts: p.ts, link: base2 + '/?invite=' + p.token }));
      return ok({ users, pending, numbers: C.twilioNumbers() });
    }
    if (a === 'user.settings') {
      if (!OWNER) return err('Owner only.');
      const em = String(P.email || '').toLowerCase().trim();
      const terr = ['PA', 'FL', ''].indexOf(String(P.territory || '').toUpperCase()) > -1 ? String(P.territory || '').toUpperCase() : '';
      let cid = String(P.caller_id || '').trim();
      if (cid) { cid = C.twE164(cid); if (C.twilioNumbers().indexOf(cid) === -1) return err('That number is not one of your Twilio numbers.'); }
      await sql`UPDATE users SET territory=${terr}, caller_id=${cid} WHERE email=${em}`;
      return ok(true);
    }
    if (a === 'user.toggle') {
      if (!OWNER) return err('Owner only.');
      const em = String(P.email || '').toLowerCase().trim();
      if (em === user.email) return err('You cannot deactivate yourself.');
      await sql`UPDATE users SET active = CASE WHEN COALESCE(active,1)=1 THEN 0 ELSE 1 END WHERE email=${em}`;
      await sql`DELETE FROM sessions WHERE email=${em}`;
      return ok(true);
    }

    return err('Unknown action: ' + a);
  } catch (e) {
    return err(e.message || String(e));
  }
};

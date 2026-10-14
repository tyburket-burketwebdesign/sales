/* BWD SDR Hub - single API dispatcher. POST /api/hub  { a, token, ...params } */
const C = require('./_lib/core.js');
const sql = C.sql;

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

    const user = await C.userFromToken(P.token);
    if (!user) return err('AUTH');
    const OWNER = user.role === 'owner';

    /* ---------------- BOOTSTRAP ---------------- */
    if (a === 'bootstrap') {
      const today = await sql`SELECT * FROM calls WHERE rep=${user.email} AND ts::date = CURRENT_DATE ORDER BY ts`;
      const fups = await sql`
        SELECT DISTINCT ON (phone) * FROM calls
        WHERE rep=${user.email} AND fup IS NOT NULL AND fup <= CURRENT_DATE AND fup_done=false
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
      const mySeqs = await sql`SELECT * FROM seqs WHERE rep=${user.email} ORDER BY started DESC LIMIT 100`;
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
      }
      return ok({ user, products: C.PRODUCTS, today, fups, fourteen, totals: totals[0],
                  deals: myDeals, ledger: myLedger, seqs: mySeqs, team, auditUrl: C.auditUrl() });
    }

    /* ---------------- PROSPECTING ---------------- */
    if (a === 'hunt') {
      const q = (P.industry || 'businesses') + ' in ' + (P.city || 'Altoona') + ', Pennsylvania';
      const found = await C.placesSearch(q);
      const phones = [];
      const items = [];
      const seenHere = {};
      for (const b of found) {
        const np = C.normPhone(b.phone);
        if (!np || seenHere[np]) continue;
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

    /* ---------------- CALL LOGGING ---------------- */
    if (a === 'call.log') {
      const phone = C.normPhone(P.phone);
      if (!phone) return err('Bad phone number.');
      const outcome = String(P.outcome || 'no_answer');
      await sql`UPDATE calls SET fup_done=true WHERE phone=${phone} AND fup IS NOT NULL AND fup_done=false`;
      const row = await sql`INSERT INTO calls (phone, name, rep, outcome, note, secs, fup, city, industry, website, email, rating, reviews, pos, addr, maps, src)
        VALUES (${phone}, ${P.name || ''}, ${user.email}, ${outcome}, ${P.note || ''}, ${Number(P.secs) || 0},
                ${P.fup || null}, ${P.city || ''}, ${P.industry || ''}, ${P.website || ''}, ${P.email || ''},
                ${Number(P.rating) || 0}, ${P.reviews == null ? -1 : Number(P.reviews)}, ${Number(P.pos) || 0},
                ${P.addr || ''}, ${P.maps || ''}, ${P.src || ''}) RETURNING id`;
      if (outcome === 'dnc') {
        await sql`INSERT INTO dnc (phone) VALUES (${phone}) ON CONFLICT DO NOTHING`;
        await sql`UPDATE seqs SET status='stopped' WHERE phone=${phone} AND status='active'`;
      }
      if (outcome === 'meeting') {
        await sql`UPDATE seqs SET status='done' WHERE phone=${phone} AND status='active'`;
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
      const t = C.seqTemplates(s, user.name)[0];
      await C.sendMail(to, t.subject, t.html, user.email);
      await sql`UPDATE seqs SET step=1, next_at = now() + interval '3 days' WHERE id=${s.id}`;
      await sql`INSERT INTO emails_log (seq_id, phone, to_email, rep, step, subject) VALUES (${s.id}, ${phone}, ${to}, ${user.email}, 1, ${t.subject})`;
      return ok({ started: true });
    }
    if (a === 'seq.stop') {
      await sql`UPDATE seqs SET status='stopped' WHERE id=${Number(P.id)} AND (rep=${user.email} OR ${OWNER})`;
      return ok(true);
    }

    /* ---------------- DEALS & COMMISSIONS ---------------- */
    if (a === 'deal.submit') {
      const prod = C.PRODUCTS.find(x => x.id === P.product);
      if (!prod) return err('Pick a product.');
      const amount = Number(P.amount) || prod.amount || 0;
      const monthly = Number(P.monthly) || prod.monthly || 0;
      let first = 0, rec = 0;
      if (prod.kind === 'one_time') first = Math.round(amount * (prod.pct / 100) * 100) / 100;
      else { first = Math.round(monthly * (prod.firstPct / 100) * 100) / 100; rec = Math.round(monthly * (prod.recPct / 100) * 100) / 100; }
      await sql`INSERT INTO deals (rep, business, product, kind, amount, monthly, first_comm, rec_comm, note)
        VALUES (${user.email}, ${P.business || ''}, ${prod.label}, ${prod.kind}, ${amount}, ${monthly}, ${first}, ${rec}, ${P.note || ''})`;
      const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
      if (mailTo && !OWNER) {
        C.sendMail(mailTo, '💰 Deal submitted: ' + (P.business || '') + ' - ' + prod.label,
          '<p><b>' + user.name + '</b> submitted a closed deal for approval.</p>' +
          '<p>' + (P.business || '') + ' · ' + prod.label + (prod.kind === 'one_time' ? ' · $' + amount : ' · $' + monthly + '/mo') + '</p>' +
          '<p>Commission if approved: $' + first + (rec ? ' now + $' + rec + '/mo' : '') + '</p>', user.email).catch(() => {});
      }
      return ok(true);
    }
    if (a === 'deal.review') {
      if (!OWNER) return err('Owner only.');
      const d = (await sql`SELECT * FROM deals WHERE id=${Number(P.id)}`)[0];
      if (!d || d.status !== 'pending') return err('Deal not found or already reviewed.');
      const st = P.approve ? 'approved' : 'denied';
      await sql`UPDATE deals SET status=${st}, reviewed_ts=now() WHERE id=${d.id}`;
      if (P.approve) {
        const label = d.business + ' - ' + (d.kind === 'one_time' ? 'one-time' : 'first month');
        await sql`INSERT INTO ledger (deal_id, rep, label, amount, type) VALUES (${d.id}, ${d.rep}, ${label}, ${d.first_comm}, ${d.kind === 'one_time' ? 'one_time' : 'first'})`;
        if (d.kind === 'recurring') await sql`UPDATE deals SET months_done=1 WHERE id=${d.id}`;
      }
      return ok(true);
    }
    if (a === 'deal.cancel') {
      if (!OWNER) return err('Owner only.');
      await sql`UPDATE deals SET status='cancelled', cancelled_ts=now() WHERE id=${Number(P.id)}`;
      return ok(true);
    }
    if (a === 'ledger.payAll') {
      if (!OWNER) return err('Owner only.');
      await sql`UPDATE ledger SET status='paid', paid_ts=now() WHERE status='earned' AND rep=${P.rep || ''}`;
      return ok(true);
    }

    return err('Unknown action: ' + a);
  } catch (e) {
    return err(e.message || String(e));
  }
};

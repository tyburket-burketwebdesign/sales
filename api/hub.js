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
      return ok({ user, products: C.PRODUCTS, today, fups, fourteen, totals: totals[0],
                  deals: myDeals, ledger: myLedger, seqs: mySeqs, meetings: myMeetings, team, auditUrl: C.auditUrl(),
                  twilio: { enabled: C.twilioReady(), numbers: C.twilioNumbers() } });
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
      const fresh = out.filter(b => !known[b.phone]).slice(0, target);
      return ok({ list: fresh, skipped: out.length - fresh.length, notes: notes });
    }

    /* ---------------- CALL LOGGING ---------------- */
    if (a === 'call.log') {
      const phone = C.normPhone(P.phone);
      if (!phone) return err('Bad phone number.');
      const outcome = String(P.outcome || 'no_answer');
      await sql`UPDATE calls SET fup_done=true WHERE phone=${phone} AND fup IS NOT NULL AND fup_done=false`;
      const row = await sql`INSERT INTO calls (phone, name, rep, outcome, note, secs, fup, city, industry, website, email, rating, reviews, pos, addr, maps, src, obj)
        VALUES (${phone}, ${P.name || ''}, ${user.email}, ${outcome}, ${P.note || ''}, ${Number(P.secs) || 0},
                ${P.fup || null}, ${P.city || ''}, ${P.industry || ''}, ${P.website || ''}, ${P.email || ''},
                ${Number(P.rating) || 0}, ${P.reviews == null ? -1 : Number(P.reviews)}, ${Number(P.pos) || 0},
                ${P.addr || ''}, ${P.maps || ''}, ${P.src || ''}, ${P.obj || ''}) RETURNING id`;
      if (P.flag && P.note) {
        const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
        if (mailTo && !OWNER) C.sendMail(mailTo, '\uD83D\uDEA9 ' + user.name + ' flagged a note: ' + (P.name || phone),
          '<p><b>' + (P.name || phone) + '</b> (' + phone + ')</p><p>"' + P.note + '"</p>', user.email).catch(() => {});
      }
      if (outcome === 'dnc') {
        await sql`INSERT INTO dnc (phone) VALUES (${phone}) ON CONFLICT DO NOTHING`;
        await sql`UPDATE seqs SET status='stopped' WHERE phone=${phone} AND status='active'`;
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
      await sql`UPDATE deals SET status=${st}, reviewed_ts=now(), note=${P.reason ? (d.note + ' | denied: ' + P.reason) : d.note} WHERE id=${d.id}`;
      if (!P.approve) {
        C.sendMail(d.rep, 'Deal update: ' + d.business,
          '<p>Your deal for <b>' + d.business + '</b> (' + d.product + ') was not approved.</p>' +
          (P.reason ? '<p>Reason: ' + P.reason + '</p>' : '') + '<p>Talk to Ty if you have questions.</p>').catch(() => {});
      }
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
      await C.sendMail(to, subject, html, user.email);
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
      return ok({ token: C.twilioToken(user.email), numbers: C.twilioNumbers(), minutesLeft: cap - used });
    }
    if (a === 'twilio.log') {
      const mins = Math.max(1, Math.ceil((Number(P.seconds) || 0) / 60));
      const mk = 'twMin_' + new Date().toISOString().slice(0, 7);
      await sql`INSERT INTO kv (k, v) VALUES (${mk}, ${String(mins)})
                ON CONFLICT (k) DO UPDATE SET v = (kv.v::int + ${mins})::text`;
      return ok(true);
    }

    return err('Unknown action: ' + a);
  } catch (e) {
    return err(e.message || String(e));
  }
};

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
      const closedMonth = (await sql`SELECT count(*)::int AS n FROM deals WHERE rep=${user.email} AND status='approved' AND reviewed_ts >= date_trunc('month', now())`)[0].n;
      const pipeline = await sql`SELECT stage, count(*)::int AS n FROM companies GROUP BY stage`;
      const waveReady = {};
      C.PRODUCTS.forEach(p => { if (C.waveLink(p.id)) waveReady[p.id] = true; });
      return ok({ user, products: C.PRODUCTS, today, fups, fourteen, totals: totals[0],
                  deals: myDeals, ledger: myLedger, seqs: mySeqs, meetings: myMeetings, team, auditUrl: C.auditUrl(),
                  twilio: { enabled: C.twilioReady(), numbers: C.twilioNumbers() },
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
        const comp = await sql`SELECT phone FROM companies WHERE lower(name)=lower(${d.business}) LIMIT 1`;
        if (comp[0]) await sql`UPDATE companies SET stage='won', updated=now() WHERE phone=${comp[0].phone}`;
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

    /* ---------------- CRM: PIPELINE & COMPANY TIMELINE ---------------- */
    if (a === 'pipeline.list') {
      const rows = await sql`SELECT * FROM companies WHERE stage NOT IN ('new') OR rep <> '' ORDER BY updated DESC LIMIT 400`;
      return ok(rows);
    }
    if (a === 'company.get') {
      const phone = C.normPhone(P.phone);
      const comp = (await sql`SELECT * FROM companies WHERE phone=${phone}`)[0];
      if (!comp) return err('No company on file for that number.');
      const callsT = await sql`SELECT 'call' AS kind, outcome AS label, note, rep, ts FROM calls WHERE phone=${phone} ORDER BY ts DESC LIMIT 30`;
      const emailsT = await sql`SELECT 'email' AS kind, subject AS label, '' AS note, rep, ts FROM emails_log WHERE phone=${phone} ORDER BY ts DESC LIMIT 30`;
      const meetT = await sql`SELECT 'meeting' AS kind, status AS label, note, rep, ts FROM meetings WHERE phone=${phone} ORDER BY ts DESC LIMIT 10`;
      const propT = await sql`SELECT 'proposal' AS kind, products AS label, note, rep, ts FROM proposals WHERE phone=${phone} ORDER BY ts DESC LIMIT 10`;
      const contT = await sql`SELECT 'contract' AS kind, (product || ' - ' || status) AS label, '' AS note, rep, ts FROM contracts WHERE phone=${phone} ORDER BY ts DESC LIMIT 10`;
      const timeline = [].concat(callsT, emailsT, meetT, propT, contT)
        .sort((x, y) => new Date(y.ts) - new Date(x.ts)).slice(0, 60);
      return ok({ company: comp, timeline: timeline });
    }
    if (a === 'company.stage') {
      const phone = C.normPhone(P.phone);
      const allowed = ['new', 'contacted', 'engaged', 'meeting', 'proposal', 'contract', 'won', 'lost'];
      if (allowed.indexOf(P.stage) === -1) return err('Bad stage.');
      await sql`UPDATE companies SET stage=${P.stage}, lost_reason=${P.stage === 'lost' ? (P.reason || '') : ''}, updated=now() WHERE phone=${phone}`;
      return ok(true);
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
      await C.sendMail(to, 'Your proposal from Burket Web Design', html, user.email);
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
      await C.sendMail(to, 'Checkout for ' + biz + ' - Burket Web Design', html, user.email);
      await sql`INSERT INTO emails_log (seq_id, phone, to_email, rep, step, subject) VALUES (0, ${phone}, ${to}, ${user.email}, 0, ${'Checkout: ' + prod.label})`;
      return ok(true);
    }

    if (a === 'company.delete') {
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
      await sql`DELETE FROM kv`;
      return ok(true);
    }

    /* ---------------- TEAM (owner) ---------------- */
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
      await C.sendMail(em, 'Your seat on the Burket Web Design sales team',
        '<div style="font-family:Arial,sans-serif;max-width:540px">' +
        '<img src="https://www.burketwebdesign.com/assets/logo.png" style="height:46px" alt="Burket Web Design">' +
        '<h2 style="color:#0e2235">Welcome aboard' + (P.name ? ', ' + String(P.name).split(' ')[0] : '') + '</h2>' +
        '<p>Ty set you up with a seat on the BWD Sales Hub: your dialer, scripts, pipeline, contracts, and commissions, all in one place.</p>' +
        '<p><a href="' + link + '" style="background:#fec814;color:#0e2235;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:bold">Create your account</a></p>' +
        '<p style="color:#8b9ab0;font-size:12px">This link is for you only and expires in 14 days.</p></div>');
      return ok(true);
    }
    if (a === 'user.list') {
      if (!OWNER) return err('Owner only.');
      const users = await sql`SELECT email, name, role, COALESCE(active,1) AS active, created FROM users ORDER BY created`;
      const pending = await sql`SELECT email, name, ts FROM invites WHERE used=0 AND ts > now() - interval '14 days' ORDER BY ts DESC`;
      return ok({ users, pending });
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

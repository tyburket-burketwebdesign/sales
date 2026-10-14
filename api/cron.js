/* Daily cron (12:00 UTC / 8 AM ET): email sequences, recurring commissions, no-show chasing,
 * daily owner report, Monday weekly summaries, and monthly commission statements on the 1st. */
const C = require('./_lib/core.js');
const sql = C.sql;

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const out = { seqSent: 0, recurring: 0, noshow: 0, report: false, weekly: false, statements: 0, errors: [] };
  const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
  try {
    await C.ensureSchema();

    /* ---- 1. advance due email sequences ---- */
    const due = await sql`SELECT s.*, u.name AS rep_name FROM seqs s JOIN users u ON u.email = s.rep
                          WHERE s.status='active' AND s.next_at <= now() AND s.step < 3 LIMIT 40`;
    for (const s of due) {
      try {
        const nextStep = s.step + 1;
        const t = C.seqTemplates(s, s.rep_name)[nextStep - 1];
        if (!t) { await sql`UPDATE seqs SET status='done' WHERE id=${s.id}`; continue; }
        await C.sendMail(s.to_email, t.subject, t.html, s.rep);
        await sql`INSERT INTO emails_log (seq_id, phone, to_email, rep, step, subject) VALUES (${s.id}, ${s.phone}, ${s.to_email}, ${s.rep}, ${nextStep}, ${t.subject})`;
        if (nextStep >= 3) await sql`UPDATE seqs SET step=3, status='done' WHERE id=${s.id}`;
        else await sql`UPDATE seqs SET step=${nextStep}, next_at = now() + interval '4 days' WHERE id=${s.id}`;
        out.seqSent++;
      } catch (e) { out.errors.push('seq ' + s.id + ': ' + e.message); }
    }

    /* ---- 2. recurring commission accrual (30-day cycles) ---- */
    const recs = await sql`SELECT * FROM deals WHERE status='approved' AND kind='recurring' AND cancelled_ts IS NULL`;
    for (const d of recs) {
      try {
        const monthsOwed = 1 + Math.floor((Date.now() - new Date(d.reviewed_ts).getTime()) / (30 * 86400000));
        if (monthsOwed > d.months_done) {
          for (let m = d.months_done + 1; m <= monthsOwed; m++) {
            await sql`INSERT INTO ledger (deal_id, rep, label, amount, type)
                      VALUES (${d.id}, ${d.rep}, ${d.business + ' - month ' + m}, ${d.rec_comm}, 'recurring')`;
            out.recurring++;
          }
          await sql`UPDATE deals SET months_done=${monthsOwed} WHERE id=${d.id}`;
        }
      } catch (e) { out.errors.push('deal ' + d.id + ': ' + e.message); }
    }

    /* ---- 3. no-show chasing: meeting date passed, still marked 'set' ---- */
    const stale = await sql`SELECT * FROM meetings WHERE status='set' AND meet_date IS NOT NULL AND meet_date < CURRENT_DATE AND alerted=false LIMIT 25`;
    for (const m of stale) {
      try {
        await C.sendMail(m.rep, 'Chase this meeting: ' + (m.business || m.phone),
          '<p>The meeting with <b>' + (m.business || m.phone) + '</b> (' + m.phone + ') was scheduled for ' + m.meet_date + ' and is still marked as set.</p>' +
          '<p>If it happened, mark it Showed in the Meetings tab. If they ghosted, call them today and reschedule. No-shows that get a same-week call back still close.</p>');
        await sql`UPDATE meetings SET alerted=true WHERE id=${m.id}`;
        out.noshow++;
      } catch (e) { out.errors.push('meeting ' + m.id + ': ' + e.message); }
    }

    /* ---- 4. daily owner report ---- */
    if (mailTo) {
      try {
        const y = await sql`
          SELECT u.name,
            count(c.*) FILTER (WHERE c.ts::date = CURRENT_DATE - 1)::int AS dials,
            count(c.*) FILTER (WHERE c.ts::date = CURRENT_DATE - 1 AND c.outcome IN ('callback','not_interested','meeting','gatekeeper'))::int AS convos,
            count(c.*) FILTER (WHERE c.ts::date = CURRENT_DATE - 1 AND c.outcome = 'meeting')::int AS meetings
          FROM users u LEFT JOIN calls c ON c.rep = u.email GROUP BY u.name`;
        const em = (await sql`SELECT count(*)::int AS n FROM emails_log WHERE ts::date = CURRENT_DATE - 1`)[0].n;
        const act = (await sql`SELECT count(*)::int AS n FROM seqs WHERE status='active'`)[0].n;
        const pend = (await sql`SELECT count(*)::int AS n FROM deals WHERE status='pending'`)[0].n;
        const owed = (await sql`SELECT COALESCE(sum(amount),0)::numeric AS t FROM ledger WHERE status='earned'`)[0].t;
        if (y.some(r => r.dials > 0) || em > 0 || pend > 0) {
          const rows = y.map(r => '<tr><td style="padding:6px 12px"><b>' + r.name + '</b></td><td style="padding:6px 12px">' + r.dials + ' dials</td><td style="padding:6px 12px">' + r.convos + ' convos</td><td style="padding:6px 12px">' + r.meetings + ' meetings</td></tr>').join('');
          await C.sendMail(mailTo, 'SDR Hub daily report',
            '<h2 style="color:#0e2235">Yesterday at a glance</h2>' +
            '<table style="border-collapse:collapse;font-family:Arial">' + rows + '</table>' +
            '<p>' + em + ' emails sent · ' + act + ' sequences active</p>' +
            (pend ? '<p><b>' + pend + ' deal' + (pend === 1 ? '' : 's') + ' waiting on your approval.</b></p>' : '') +
            '<p>Commissions earned and unpaid: <b>$' + Number(owed).toFixed(2) + '</b></p>');
          out.report = true;
        }
      } catch (e) { out.errors.push('report: ' + e.message); }
    }

    const today = new Date();

    /* ---- 5. Monday weekly summaries (owner trend + SDR self-report) ---- */
    if (today.getUTCDay() === 1) {
      try {
        const wk = await sql`
          SELECT u.email, u.name,
            count(c.*) FILTER (WHERE c.ts > now() - interval '7 days')::int AS dials,
            count(c.*) FILTER (WHERE c.ts > now() - interval '7 days' AND c.outcome IN ('callback','not_interested','meeting','gatekeeper'))::int AS convos,
            count(c.*) FILTER (WHERE c.ts > now() - interval '7 days' AND c.outcome='meeting')::int AS meetings,
            count(c.*) FILTER (WHERE c.ts > now() - interval '14 days' AND c.ts <= now() - interval '7 days')::int AS prev_dials
          FROM users u LEFT JOIN calls c ON c.rep = u.email GROUP BY u.email, u.name`;
        const mrr = (await sql`SELECT COALESCE(sum(monthly),0)::numeric AS m FROM deals WHERE status='approved' AND kind='recurring' AND cancelled_ts IS NULL`)[0].m;
        const wkEm = (await sql`SELECT count(*)::int AS n FROM emails_log WHERE ts > now() - interval '7 days'`)[0].n;
        const rows = wk.map(r => {
          const trend = r.prev_dials ? Math.round((r.dials - r.prev_dials) / r.prev_dials * 100) : 0;
          return '<tr><td style="padding:6px 12px"><b>' + r.name + '</b></td><td style="padding:6px 12px">' + r.dials + ' dials (' + (trend >= 0 ? '+' : '') + trend + '% vs last week)</td><td style="padding:6px 12px">' + r.meetings + ' meetings</td></tr>';
        }).join('');
        if (mailTo) await C.sendMail(mailTo, 'SDR Hub weekly summary',
          '<h2 style="color:#0e2235">The week in review</h2><table style="border-collapse:collapse;font-family:Arial">' + rows + '</table>' +
          '<p>' + wkEm + ' sequence emails sent · Client MRR on the books: <b>$' + Number(mrr).toFixed(0) + '/mo</b></p>');
        for (const r of wk) {
          if (r.email === (process.env.OWNER_EMAIL || '').toLowerCase()) continue;
          if (!r.dials) continue;
          const rate = r.dials ? Math.round(r.convos / r.dials * 100) : 0;
          await C.sendMail(r.email, 'Your week in the hub',
            '<p>Last 7 days: <b>' + r.dials + ' dials</b>, ' + rate + '% connect rate, <b>' + r.meetings + ' meetings booked</b>.</p>' +
            '<p>' + (r.dials >= 250 ? 'That is a full week of real work. Keep the streak.' : 'The target is 50 a day. More dials, more meetings, more commission. This week is unwritten.') + '</p>');
        }
        out.weekly = true;
      } catch (e) { out.errors.push('weekly: ' + e.message); }
    }

    /* ---- 6. monthly commission statements on the 1st ---- */
    if (today.getUTCDate() === 1) {
      try {
        const reps = await sql`SELECT DISTINCT rep FROM ledger`;
        for (const r of reps) {
          const items = await sql`SELECT * FROM ledger WHERE rep=${r.rep} AND ts >= date_trunc('month', now()) - interval '1 month' AND ts < date_trunc('month', now()) ORDER BY ts`;
          if (!items.length) continue;
          const total = items.reduce((s2, l) => s2 + Number(l.amount), 0);
          const paid = items.filter(l => l.status === 'paid').reduce((s2, l) => s2 + Number(l.amount), 0);
          const lines = items.map(l => '<tr><td style="padding:5px 12px">' + l.label + '</td><td style="padding:5px 12px">' + l.type.replace('_', ' ') + '</td><td style="padding:5px 12px">$' + Number(l.amount).toFixed(2) + '</td><td style="padding:5px 12px">' + l.status + '</td></tr>').join('');
          const html = '<h2 style="color:#0e2235">Commission statement</h2>' +
            '<table style="border-collapse:collapse;font-family:Arial;border:1px solid #e3e9f0">' + lines + '</table>' +
            '<p>Total: <b>$' + total.toFixed(2) + '</b> · Paid so far: $' + paid.toFixed(2) + '</p>';
          await C.sendMail(r.rep, 'Commission statement - ' + new Date(Date.now() - 5 * 86400000).toLocaleString('en-US', { month: 'long', year: 'numeric' }), html);
          if (mailTo && r.rep !== (process.env.OWNER_EMAIL || '').toLowerCase()) await C.sendMail(mailTo, 'Statement sent: ' + r.rep, html);
          out.statements++;
        }
      } catch (e) { out.errors.push('statements: ' + e.message); }
    }
  } catch (e) { out.errors.push(e.message); }
  res.status(200).json({ ok: true, data: out });
};

/* Daily cron (Vercel hits this at 12:00 UTC / 8 AM ET): advances email sequences,
 * accrues recurring commissions, and emails the owner yesterday's report. */
const C = require('./_lib/core.js');
const sql = C.sql;

module.exports = async function handler(req, res) {
  // Vercel sends Authorization: Bearer <CRON_SECRET> when CRON_SECRET is set
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const out = { seqSent: 0, recurring: 0, report: false, errors: [] };
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

    /* ---- 2. recurring commission accrual (30-day cycles from approval) ---- */
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

    /* ---- 3. daily owner report ---- */
    const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
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
        const anyActivity = y.some(r => r.dials > 0) || em > 0 || pend > 0;
        if (anyActivity) {
          const rows = y.map(r => '<tr><td style="padding:6px 12px"><b>' + r.name + '</b></td><td style="padding:6px 12px">' + r.dials + ' dials</td><td style="padding:6px 12px">' + r.convos + ' convos</td><td style="padding:6px 12px">' + r.meetings + ' meetings</td></tr>').join('');
          await C.sendMail(mailTo, 'SDR Hub daily report',
            '<h2 style="color:#0e2235">Yesterday at a glance</h2>' +
            '<table style="border-collapse:collapse;font-family:Arial">' + rows + '</table>' +
            '<p>' + em + ' sequence emails sent · ' + act + ' sequences active</p>' +
            (pend ? '<p><b>' + pend + ' deal' + (pend === 1 ? '' : 's') + ' waiting on your approval.</b></p>' : '') +
            '<p>Commissions earned and unpaid: <b>$' + Number(owed).toFixed(2) + '</b></p>');
          out.report = true;
        }
      } catch (e) { out.errors.push('report: ' + e.message); }
    }
  } catch (e) { out.errors.push(e.message); }
  res.status(200).json({ ok: true, data: out });
};

/* DocuSeal webhook. In DocuSeal: Settings -> Webhooks -> add
 *   https://YOUR-APP.vercel.app/api/docuseal?k=YOUR_TWILIO_WEBHOOK_KEY
 * (same shared key as the voice webhook). Fires on form.completed:
 * marks the contract signed, moves the company to Won, creates the deal
 * for owner approval, and emails both seats. */
const C = require('./_lib/core.js');
const sql = C.sql;

module.exports = async function handler(req, res) {
  const key = process.env.TWILIO_WEBHOOK_KEY || '';
  if (!key || (req.query && req.query.k) !== key) return res.status(403).json({ ok: false });
  let P = req.body || {};
  if (typeof P === 'string') { try { P = JSON.parse(P); } catch (e) { P = {}; } }
  try {
    await C.ensureSchema();
    const event = P.event_type || P.event || '';
    const data = P.data || {};
    const subId = String(data.submission_id || (data.submission && data.submission.id) || data.id || '');
    if (!subId) return res.status(200).json({ ok: true, data: 'no submission id' });

    if (event === 'form.viewed' || event === 'submission.viewed') {
      await sql`UPDATE contracts SET status='viewed' WHERE docuseal_id=${subId} AND status='sent'`;
      return res.status(200).json({ ok: true });
    }
    if (event !== 'form.completed' && event !== 'submission.completed') {
      return res.status(200).json({ ok: true, data: 'ignored ' + event });
    }

    const docs = data.documents || [];
    const pdf = (docs[0] && docs[0].url) || data.audit_log_url || '';
    const rows = await sql`UPDATE contracts SET status='signed', signed_ts=now(), pdf_url=${pdf}
                           WHERE docuseal_id=${subId} AND status<>'signed' RETURNING *`;
    const ct = rows[0];
    if (!ct) return res.status(200).json({ ok: true, data: 'contract not found or already signed' });

    // company wins
    if (ct.phone) await sql`UPDATE companies SET stage='won', updated=now() WHERE phone=${ct.phone}`;
    // create the deal, pending Ty's approval (approval is what counts toward the KPI)
    const prodMatch = C.PRODUCTS.find(x => x.label === ct.product);
    await sql`INSERT INTO deals (rep, business, product, kind, amount, monthly, first_comm, rec_comm, note)
              VALUES (${ct.rep}, ${ct.client_name || ct.to_email}, ${ct.product}, ${prodMatch ? prodMatch.kind : 'one_time'},
                      ${ct.amount}, ${prodMatch && prodMatch.kind === 'recurring' ? ct.amount : 0}, 0, 0, 'Contract signed via DocuSeal')`;

    const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
    const body = '<p><b>' + (ct.client_name || ct.to_email) + '</b> signed the ' + ct.product + ' contract ($' + ct.amount + ').</p>' +
      (pdf ? '<p><a href="' + pdf + '">Signed document</a></p>' : '') +
      '<p>The deal is in the hub waiting for approval. Send the Wave checkout and get them onboarded.</p>';
    if (mailTo) C.sendMail(mailTo, '✍️ SIGNED: ' + (ct.client_name || ct.to_email) + ' - ' + ct.product, body).catch(() => {});
    if (ct.rep && ct.rep !== (process.env.OWNER_EMAIL || '').toLowerCase()) {
      C.sendMail(ct.rep, '✍️ They signed: ' + (ct.client_name || ct.to_email), body).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

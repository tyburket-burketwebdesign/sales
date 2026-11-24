/* Wave webhook: Wave calls this when an invoice or payment changes.
 * Register in Wave's Developer Portal (your app → Webhooks) with:
 *   https://crm.burketwebdesign.com/api/wave-hook?k=YOUR_TWILIO_WEBHOOK_KEY
 * The payload is only used as a nudge; the hub re-reads everything from Wave itself. */
const C = require('./_lib/core.js');
const sql = C.sql;

module.exports = async function handler(req, res) {
  const key = process.env.TWILIO_WEBHOOK_KEY || '';
  if (!key || (req.query && req.query.k) !== key) return res.status(403).json({ ok: false });
  try {
    await C.ensureSchema();
    /* debounce: at most one sync every 20 seconds */
    const last = ((await sql`SELECT v FROM kv WHERE k='wave_last_sync'`)[0] || {}).v;
    if (last && Date.now() - new Date(JSON.parse(last).at).getTime() < 20000) return res.status(200).json({ ok: true, data: 'recent' });
    const out = await C.waveSync(sql);
    if (out.paidNow) {
      const mailTo = process.env.MAIL_TO || process.env.OWNER_EMAIL;
      if (mailTo) C.sendMail(mailTo, '💵 Payment received in Wave', '<p>' + out.paidNow + ' invoice' + (out.paidNow === 1 ? ' was' : 's were') + ' just paid. The CRM is up to date.</p>').catch(() => {});
    }
    return res.status(200).json({ ok: true, data: out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

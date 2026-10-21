/* Twilio TwiML webhook.
 * Set BOTH the TwiML App Voice URL and each phone number's "A call comes in" webhook to:
 *   https://YOUR-APP.vercel.app/api/voice?k=YOUR_TWILIO_WEBHOOK_KEY   (HTTP POST)
 * Outbound: rep dials from the browser, we bridge to the number.
 * Inbound: a prospect calls back, we ring every seat's browser; missed calls email the team. */
const C = require('./_lib/core.js');
const sql = C.sql;

function xml(res, body) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>' + body);
}
function escXml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

module.exports = async function handler(req, res) {
  const key = process.env.TWILIO_WEBHOOK_KEY || '';
  if (!key || (req.query && req.query.k) !== key) {
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return res.status(403).send('<Response><Reject/></Response>');
  }
  let P = req.body || {};
  if (typeof P === 'string') {
    const sp = new URLSearchParams(P); P = {};
    sp.forEach((v, k2) => { P[k2] = v; });
  }
  try {
    /* after-ring callback for inbound: log a miss if nobody answered */
    if (req.query.cb === '1') {
      const st = P.DialCallStatus || '';
      const from = String(P.From || '').replace(/[^\d+]/g, '');
      const fallback = C.twE164(process.env.TWILIO_FALLBACK || '');
      if (st !== 'completed' && fallback && req.query.fb !== '1') {
        // nobody online in the hub: ring the real cell before giving up
        const action2 = '/api/voice?k=' + encodeURIComponent(key) + '&cb=1&fb=1';
        return xml(res, '<Response><Dial answerOnBridge="true" timeout="25" action="' + escXml(action2) + '" method="POST"><Number>' + escXml(fallback) + '</Number></Dial></Response>');
      }
      if (st !== 'completed') {
        try {
          await C.ensureSchema();
          const users = await sql`SELECT email FROM users`;
          for (const u of users) {
            C.sendMail(u.email, 'Missed call back from ' + (from || 'unknown'),
              '<p>Someone called the Twilio line back from <b>' + (from || 'an unknown number') + '</b> and nobody answered.</p><p>Call them back soon, returned calls are the warmest dials there are.</p>').catch(() => {});
          }
        } catch (e) {}
        return xml(res, '<Response><Say>Thanks for calling Burket Web Design. We just missed you, but someone will call you right back shortly.</Say></Response>');
      }
      return xml(res, '<Response></Response>');
    }

    /* inbound: caller is a real phone, not one of our browser clients */
    if (String(P.From || '').indexOf('client:') !== 0) {
      await C.ensureSchema();
      const users = await sql`SELECT email FROM users`;
      const ids = users.map(u => String(u.email).replace(/[^a-zA-Z0-9_]/g, '_'));
      if (!ids.length) return xml(res, '<Response><Say>Thanks for calling Burket Web Design. Please try us again shortly.</Say></Response>');
      const action = '/api/voice?k=' + encodeURIComponent(key) + '&cb=1';
      let dial = '<Response><Dial answerOnBridge="true" timeout="20" action="' + escXml(action) + '" method="POST">';
      ids.forEach(id => { dial += '<Client>' + escXml(id) + '</Client>'; });
      dial += '</Dial></Response>';
      return xml(res, dial);
    }

    /* outbound: rep dialing from the hub */
    let from = C.twE164(process.env.TWILIO_FROM);
    let cid = String(P.Cid || '').replace(/[^\d+]/g, '');
    if (cid.length === 10) cid = '+1' + cid;
    if (cid.length === 11 && cid[0] === '1') cid = '+' + cid;
    const allowed = C.twilioNumbers();
    if (cid && allowed.indexOf(cid) > -1) from = cid;
    let to = String(P.To || '').replace(/[^\d+]/g, '');
    if (to.length === 10) to = '+1' + to;
    if (to.length === 11 && to[0] === '1') to = '+' + to;
    if (!from || !/^\+1\d{10}$/.test(to)) return xml(res, '<Response><Say>Invalid number.</Say></Response>');
    return xml(res, '<Response><Dial callerId="' + escXml(from) + '" answerOnBridge="true"><Number>' + escXml(to) + '</Number></Dial></Response>');
  } catch (e) {
    return xml(res, '<Response><Say>Something went wrong. Try again.</Say></Response>');
  }
};

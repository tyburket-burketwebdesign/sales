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
    console.log('[voice] rejected: webhook key missing or wrong (check ?k= in the Twilio URL matches TWILIO_WEBHOOK_KEY)');
    return res.status(403).send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
  }
  let P = req.body || {};
  if (typeof P === 'string') {
    const sp = new URLSearchParams(P); P = {};
    sp.forEach((v, k2) => { P[k2] = v; });
  }
  try {
    /* after an OUTBOUND dial ends without a conversation: tell the rep why, so the browser call ends cleanly
       (without this, Twilio drops the browser leg and the SDK throws error 31005 "Error sent from gateway in HANGUP") */
    if (req.query.ob === '1') {
      const st = String(P.DialCallStatus || '');
      console.log('[voice] outbound dial ended', JSON.stringify({ status: st, to: P.To || '', sid: P.DialCallSid || '', err: P.ErrorCode || '', msg: P.ErrorMessage || '' }));
      if (st === 'completed' || st === 'answered' || st === 'canceled') return xml(res, '<Response><Hangup/></Response>');
      const say = st === 'busy' ? 'That line is busy. Log it and try again later.'
        : st === 'no-answer' ? 'No answer. Log it and move on.'
        : 'That call could not go through. The number may be disconnected, blocked, or not reachable. Try the other caller I D, or log it and move on.';
      return xml(res, '<Response><Say voice="Polly.Joanna">' + say + '</Say><Hangup/></Response>');
    }

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
    if (!from) { console.log('[voice] TWILIO_FROM is not set'); return xml(res, '<Response><Say>The calling number is not set up yet. Tell Ty.</Say></Response>'); }
    if (!/^\+1\d{10}$/.test(to)) return xml(res, '<Response><Say>That number is not a valid 10 digit U S number.</Say></Response>');
    const obAction = '/api/voice?k=' + encodeURIComponent(key) + '&ob=1';
    return xml(res, '<Response><Dial callerId="' + escXml(from) + '" answerOnBridge="true" timeout="30" action="' + escXml(obAction) + '" method="POST"><Number>' + escXml(to) + '</Number></Dial></Response>');
  } catch (e) {
    console.log('[voice] error', e && e.message);
    return xml(res, '<Response><Say>Something went wrong. Try again.</Say></Response>');
  }
};

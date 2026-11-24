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

    /* voicemail left after a missed inbound call */
    if (req.query.vm) {
      try {
        const id = Number(req.query.vm) || 0, url = String(P.RecordingUrl || ''), secs = Number(P.RecordingDuration) || 0;
        if (id && url && secs > 1) { await C.ensureSchema(); await sql`UPDATE inbound SET vm_url=${url + '.mp3'}, vm_secs=${secs} WHERE id=${id}`; }
      } catch (e) {}
      return xml(res, '<Response><Say voice="Polly.Joanna">Got it. Thanks, talk soon.</Say><Hangup/></Response>');
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
      const ten = from.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      const line = String(P.To || P.Called || '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
      const sid = String(P.CallSid || '');
      let rid = 0;
      try {
        await C.ensureSchema();
        const last = (await sql`SELECT rep, name, outcome, ts FROM calls WHERE phone=${ten} ORDER BY ts DESC LIMIT 1`)[0];
        const comp = (await sql`SELECT name FROM companies WHERE phone=${ten}`)[0];
        const who = (comp && comp.name) || (last && last.name) || '';
        const status = st === 'completed' ? (req.query.fb === '1' ? 'answered_cell' : 'answered') : 'missed';
        const old = sid ? (await sql`SELECT id FROM inbound WHERE sid=${sid}`)[0] : null;
        if (old) { rid = old.id; await sql`UPDATE inbound SET status=${status} WHERE id=${rid}`; }
        else rid = (await sql`INSERT INTO inbound (sid, phone, line, rep, status) VALUES (${sid}, ${ten}, ${line}, ${(last && last.rep) || ''}, ${status}) RETURNING id`)[0].id;
        if (status === 'missed') {
          const users = (await sql`SELECT email, role FROM users WHERE COALESCE(active,1)=1`).filter(u => !last || !last.rep || u.email === last.rep || u.role === 'owner');
          const nice = ten.length === 10 ? '(' + ten.slice(0, 3) + ') ' + ten.slice(3, 6) + '-' + ten.slice(6) : (from || 'unknown');
          const lastLine = last ? '<p style="color:#5b6b80">Last touch: ' + String(last.outcome || '').replace(/_/g, ' ') + ' by ' + last.rep + ' on ' + new Date(last.ts).toLocaleDateString('en-US') + '</p>' : '<p style="color:#5b6b80">New number, not in the hub yet.</p>';
          for (const u of users) {
            C.sendMail(u.email, 'Missed call: ' + (who || nice),
              '<p><b>' + (who ? who + ' (' + nice + ')' : nice) + '</b> called and nobody picked up.</p>' + lastLine +
              '<p>It is waiting in <b>Dialer &rarr; Missed Calls</b> with a Call back button. If they leave a voicemail it will be there too.</p>').catch(() => {});
          }
        }
      } catch (e) { console.log('[voice] inbound log failed', e && e.message); }
      if (st !== 'completed') {
        const vmAction = '/api/voice?k=' + encodeURIComponent(key) + '&vm=' + rid;
        return xml(res, '<Response><Say voice="Polly.Joanna">Thanks for calling Burket Web Design. We just missed you. Leave your name and a good time to call after the tone, and we will call you right back.</Say>' +
          '<Record maxLength="120" timeout="6" playBeep="true" action="' + escXml(vmAction) + '" method="POST"/><Say voice="Polly.Joanna">Thanks, talk soon.</Say></Response>');
      }
      return xml(res, '<Response></Response>');
    }

    /* inbound: caller is a real phone, not one of our browser clients.
       A number that only the owner dials from (the PA line) rings only the owner; any other number rings every seat. */
    if (String(P.From || '').indexOf('client:') !== 0) {
      await C.ensureSchema();
      const all = await sql`SELECT email, role, COALESCE(territory,'') AS territory, COALESCE(caller_id,'') AS caller_id FROM users WHERE COALESCE(active,1)=1`;
      const dialed = C.twE164(P.To || P.Called || '');
      const onLine = all.filter(u => C.callerFor(u) === dialed);
      let ringSet = onLine.length && onLine.every(u => u.role === 'owner') ? onLine : all;
      /* a prospect calling back reaches the rep who called them, even on the owner's line */
      try {
        const caller = String(P.From || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
        const last = (await sql`SELECT rep FROM calls WHERE phone=${caller} ORDER BY ts DESC LIMIT 1`)[0];
        if (last) { const r = all.find(u => u.email === last.rep); if (r && ringSet.indexOf(r) === -1) ringSet = ringSet.concat([r]); }
      } catch (e) {}
      const ids = ringSet.map(u => String(u.email).replace(/[^a-zA-Z0-9_]/g, '_'));
      if (!ids.length) return xml(res, '<Response><Say>Thanks for calling Burket Web Design. Please try us again shortly.</Say></Response>');
      const action = '/api/voice?k=' + encodeURIComponent(key) + '&cb=1';
      let dial = '<Response><Dial answerOnBridge="true" timeout="20" action="' + escXml(action) + '" method="POST">';
      ids.forEach(id => { dial += '<Client>' + escXml(id) + '</Client>'; });
      dial += '</Dial></Response>';
      return xml(res, dial);
    }

    /* outbound: rep dialing from the hub. Caller ID comes from the seat that is dialing. */
    let from = C.twE164(process.env.TWILIO_FROM);
    try {
      const ident = String(P.From || '').replace(/^client:/, '');
      await C.ensureSchema();
      const seats = await sql`SELECT email, role, COALESCE(territory,'') AS territory, COALESCE(caller_id,'') AS caller_id FROM users`;
      const me = seats.find(u => String(u.email).replace(/[^a-zA-Z0-9_]/g, '_') === ident);
      if (me) from = C.localCallerFor(me, P.To);
    } catch (e) { console.log('[voice] seat lookup failed, using TWILIO_FROM', e && e.message); }
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

/* Voicemail player: streams a Twilio recording to a signed-in seat (Twilio recordings need the account key). */
const C = require('./_lib/core.js');
const sql = C.sql;
module.exports = async function handler(req, res) {
  try {
    await C.ensureSchema();
    const user = await C.userFromToken(String((req.query && req.query.t) || ''));
    if (!user) return res.status(401).send('Sign in first.');
    const r = (await sql`SELECT * FROM inbound WHERE id=${Number(req.query.id) || 0}`)[0];
    if (!r || !r.vm_url) return res.status(404).send('No voicemail.');
    if (user.role !== 'owner' && r.rep && r.rep !== user.email) return res.status(403).send('Not your call.');
    const key = process.env.TWILIO_API_KEY_SID, sec = process.env.TWILIO_API_KEY_SECRET;
    const url = /\.mp3$/.test(r.vm_url) ? r.vm_url : r.vm_url + '.mp3';
    const a = await fetch(url, { headers: key ? { 'Authorization': 'Basic ' + Buffer.from(key + ':' + sec).toString('base64') } : {} });
    if (!a.ok) return res.status(502).send('Twilio would not return the recording (' + a.status + ').');
    const buf = Buffer.from(await a.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg'); res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(buf);
  } catch (e) { return res.status(500).send(e.message); }
};

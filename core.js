/* BWD SDR Hub - shared server core */
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

let _sql = null;
function sql(strings) {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. In Vercel: Storage tab -> Create Database -> Postgres (Neon), then redeploy.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql.apply(null, arguments);
}

function hashPass(p) {
  return crypto.createHmac('sha256', process.env.APP_SECRET || 'bwd-secret').update(String(p)).digest('hex');
}
function uid() { return crypto.randomBytes(18).toString('hex'); }
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : '';
}

let schemaDone = false;
async function ensureSchema() {
  if (schemaDone) return;
  await sql`CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, name TEXT DEFAULT '', role TEXT DEFAULT 'sdr', pass TEXT DEFAULT '', created TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, email TEXT, expires TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY, phone TEXT, name TEXT DEFAULT '', rep TEXT, outcome TEXT, note TEXT DEFAULT '',
    secs INT DEFAULT 0, fup DATE, fup_done BOOLEAN DEFAULT false, city TEXT DEFAULT '', industry TEXT DEFAULT '',
    website TEXT DEFAULT '', email TEXT DEFAULT '', rating REAL DEFAULT 0, reviews INT DEFAULT -1,
    pos INT DEFAULT 0, addr TEXT DEFAULT '', maps TEXT DEFAULT '', src TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_phone ON calls (phone)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_rep_ts ON calls (rep, ts)`;
  await sql`CREATE TABLE IF NOT EXISTS dnc ( phone TEXT PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now() )`;
  await sql`CREATE TABLE IF NOT EXISTS deals (
    id SERIAL PRIMARY KEY, rep TEXT, business TEXT, product TEXT, kind TEXT, amount NUMERIC DEFAULT 0,
    monthly NUMERIC DEFAULT 0, first_comm NUMERIC DEFAULT 0, rec_comm NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pending', note TEXT DEFAULT '', months_done INT DEFAULT 0,
    ts TIMESTAMPTZ DEFAULT now(), reviewed_ts TIMESTAMPTZ, cancelled_ts TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS ledger (
    id SERIAL PRIMARY KEY, deal_id INT, rep TEXT, label TEXT, amount NUMERIC, type TEXT,
    status TEXT DEFAULT 'earned', ts TIMESTAMPTZ DEFAULT now(), paid_ts TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS seqs (
    id SERIAL PRIMARY KEY, phone TEXT, business TEXT, to_email TEXT, rep TEXT,
    industry TEXT DEFAULT '', city TEXT DEFAULT '', website TEXT DEFAULT '',
    step INT DEFAULT 0, status TEXT DEFAULT 'active', next_at TIMESTAMPTZ, started TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS emails_log (
    id SERIAL PRIMARY KEY, seq_id INT, phone TEXT, to_email TEXT, rep TEXT, step INT, subject TEXT, ts TIMESTAMPTZ DEFAULT now()
  )`;
  // seed the two seats from env
  const seats = [
    { email: process.env.OWNER_EMAIL, name: process.env.OWNER_NAME || 'Ty Burket', role: 'owner', pass: process.env.OWNER_PASS },
    { email: process.env.SDR_EMAIL, name: process.env.SDR_NAME || 'SDR', role: 'sdr', pass: process.env.SDR_PASS }
  ];
  for (const s of seats) {
    if (!s.email || !s.pass) continue;
    const em = s.email.toLowerCase().trim();
    await sql`INSERT INTO users (email, name, role, pass) VALUES (${em}, ${s.name}, ${s.role}, ${hashPass(s.pass)})
              ON CONFLICT (email) DO UPDATE SET name=${s.name}, role=${s.role}, pass=${hashPass(s.pass)}`;
  }
  schemaDone = true;
}

async function userFromToken(token) {
  if (!token) return null;
  const rows = await sql`SELECT u.email, u.name, u.role FROM sessions s JOIN users u ON u.email = s.email
                         WHERE s.token = ${token} AND s.expires > now()`;
  return rows[0] || null;
}

async function login(email, pass) {
  const em = String(email || '').toLowerCase().trim();
  const rows = await sql`SELECT email, name, role FROM users WHERE email = ${em} AND pass = ${hashPass(pass)}`;
  if (!rows[0]) return null;
  const token = uid();
  await sql`DELETE FROM sessions WHERE expires < now()`;
  await sql`INSERT INTO sessions (token, email, expires) VALUES (${token}, ${em}, now() + interval '30 days')`;
  return { token, user: rows[0] };
}

/* ---- Resend ---- */
async function sendMail(to, subject, html, replyTo) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set.');
  const body = { from: process.env.MAIL_FROM || 'BWD <hello@burketwebdesign.com>', to: [to], subject, html };
  if (replyTo) body.reply_to = [replyTo];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Resend error ' + r.status + ': ' + t.slice(0, 200));
  }
  return r.json();
}

/* ---- Google Places (server-side, key stays private) ---- */
async function placesSearch(query) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_KEY is not set.');
  const all = [];
  let token = null;
  for (let page = 0; page < 3; page++) {
    const body = { textQuery: query, pageSize: 20 };
    if (token) body.pageToken = token;
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.formattedAddress,places.googleMapsUri,places.businessStatus,nextPageToken'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error((j.error && j.error.message) || ('Google error ' + r.status));
    }
    const j = await r.json();
    (j.places || []).forEach(pl => {
      if (pl.businessStatus && pl.businessStatus !== 'OPERATIONAL') return;
      all.push({
        name: (pl.displayName && pl.displayName.text) || '',
        phone: pl.nationalPhoneNumber || '',
        website: pl.websiteUri || '',
        rating: pl.rating || 0,
        reviews: pl.userRatingCount || 0,
        addr: pl.formattedAddress || '',
        maps: pl.googleMapsUri || '',
        pos: all.length + 1,
        src: 'google'
      });
    });
    token = j.nextPageToken || null;
    if (!token || all.length >= 75) break;
    await new Promise(res => setTimeout(res, 1100));
  }
  return all;
}

/* ---- email scraping ---- */
const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BAD_EMAIL = /\.(png|jpg|jpeg|gif|webp|svg|css|js)$|sentry|wixpress|example\.|godaddy|@[\d.]+$|schema\.org|yourdomain|email@|domain\.com/i;
async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BWDHub/1.0)' } });
    if (!r.ok) return '';
    return (await r.text()).slice(0, 600000);
  } catch (e) { return ''; }
  finally { clearTimeout(t); }
}
async function scrapeEmails(siteUrl) {
  let base = String(siteUrl || '').trim();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  let origin;
  try { origin = new URL(base).origin; } catch (e) { throw new Error('That does not look like a website address.'); }
  const found = new Set();
  const harvest = html => {
    (html.match(EMAIL_RX) || []).forEach(e => {
      const em = e.toLowerCase().replace(/^20/, '');
      if (!BAD_EMAIL.test(em) && em.length < 60) found.add(em);
    });
  };
  harvest(await fetchText(base));
  if (!found.size) {
    for (const path of ['/contact', '/contact-us', '/about', '/about-us']) {
      harvest(await fetchText(origin + path));
      if (found.size) break;
    }
  }
  return Array.from(found).slice(0, 6);
}

/* ---- products & commission plan ---- */
const PRODUCTS = [
  { id: 'onepage',    label: 'One Page Website - $650 one time',            kind: 'one_time',  amount: 650, pct: 20 },
  { id: 'fullsite',   label: 'Full Site - $850 one time',                   kind: 'one_time',  amount: 850, pct: 20 },
  { id: 'customsite', label: 'Custom Website (enter amount)',               kind: 'one_time',  amount: 0,   pct: 20 },
  { id: 'lp299',      label: 'Local Presence Essentials - $299/mo',         kind: 'recurring', monthly: 299, firstPct: 50, recPct: 10 },
  { id: 'lp500',      label: 'Local Presence Complete - $500/mo',           kind: 'recurring', monthly: 500, firstPct: 50, recPct: 10 },
  { id: 'otherrec',   label: 'Other Monthly (enter amount)',                kind: 'recurring', monthly: 0,  firstPct: 50, recPct: 10 },
  { id: 'other',      label: 'Other One-Time (enter amount)',               kind: 'one_time',  amount: 0,   pct: 20 }
];

/* ---- email sequence templates ---- */
function auditUrl() { return process.env.AUDIT_URL || 'https://www.burketwebdesign.com/scan/'; }
function seqTemplates(s, repName) {
  const biz = s.business || 'your business';
  const link = auditUrl();
  const sig = '<p>' + repName + '<br>Burket Web Design, Altoona PA<br><a href="https://www.burketwebdesign.com">burketwebdesign.com</a></p>' +
    '<p style="color:#8b9ab0;font-size:12px">If you would rather not hear from me, reply STOP and I will close your file for good.</p>';
  return [
    {
      subject: 'Tried calling about ' + biz + "'s Google listing",
      html: '<p>Hi,</p>' +
        '<p>I called ' + biz + ' earlier today but did not catch you, so I will keep this short.</p>' +
        '<p>Before I dialed, I looked at how ' + biz + ' shows up on Google' + (s.city ? ' in ' + s.city : '') + '. There are a couple of things on the listing that are very likely costing you calls, and they are fixable.</p>' +
        '<p>We built a free scanner that checks your listing and website in about 30 seconds and shows you exactly where you stand against competitors:</p>' +
        '<p><a href="' + link + '" style="background:#fec814;color:#0e2235;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Run the free scan on ' + biz + '</a></p>' +
        '<p>If the scan comes back clean, great, you lost 30 seconds. If it does not, reply to this email and I will walk you through it on a quick call.</p>' + sig
    },
    {
      subject: 'The free scan for ' + biz,
      html: '<p>Hi,</p>' +
        '<p>Following up on my note from a few days ago. Most owners who run the scan on their business find at least one thing on their Google listing that is quietly sending customers to a competitor.</p>' +
        '<p>It takes 30 seconds and costs nothing: <a href="' + link + '">run the scan here</a>.</p>' +
        '<p>Happy to look at the results with you. Just reply with a time that works.</p>' + sig
    },
    {
      subject: 'Closing the file on ' + biz,
      html: '<p>Hi,</p>' +
        '<p>I have reached out a couple of times about how ' + biz + ' shows up on Google, so this is my last note. I will assume the timing is not right and close your file.</p>' +
        '<p>If you ever want the free 30-second scan, it will be here: <a href="' + link + '">' + link + '</a></p>' +
        '<p>Either way, I wish you a busy season.</p>' + sig
    }
  ];
}

module.exports = { sql, ensureSchema, userFromToken, login, sendMail, placesSearch, scrapeEmails,
                   PRODUCTS, seqTemplates, auditUrl, normPhone, uid };

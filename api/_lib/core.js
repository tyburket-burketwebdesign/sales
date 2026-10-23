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
  await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS obj TEXT DEFAULT ''`;
  await sql`CREATE TABLE IF NOT EXISTS dnc ( phone TEXT PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now() )`;
  await sql`CREATE TABLE IF NOT EXISTS kv ( k TEXT PRIMARY KEY, v TEXT )`;
  await sql`CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY, phone TEXT UNIQUE, name TEXT DEFAULT '', website TEXT DEFAULT '', email TEXT DEFAULT '',
    contact TEXT DEFAULT '', addr TEXT DEFAULT '', city TEXT DEFAULT '', industry TEXT DEFAULT '',
    rating REAL DEFAULT 0, reviews INT DEFAULT -1, pos INT DEFAULT 0, maps TEXT DEFAULT '',
    stage TEXT DEFAULT 'new', lost_reason TEXT DEFAULT '', rep TEXT DEFAULT '',
    created TIMESTAMPTZ DEFAULT now(), updated TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_stage ON companies (stage)`;
  await sql`CREATE TABLE IF NOT EXISTS proposals (
    id SERIAL PRIMARY KEY, phone TEXT, rep TEXT, to_email TEXT, products TEXT, total NUMERIC DEFAULT 0,
    note TEXT DEFAULT '', checkout TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS contracts (
    id SERIAL PRIMARY KEY, phone TEXT, rep TEXT, to_email TEXT, client_name TEXT DEFAULT '',
    product TEXT DEFAULT '', amount NUMERIC DEFAULT 0, docuseal_id TEXT DEFAULT '',
    status TEXT DEFAULT 'sent', pdf_url TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now(), signed_ts TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS meetings (
    id SERIAL PRIMARY KEY, phone TEXT, business TEXT, rep TEXT, meet_date DATE, status TEXT DEFAULT 'set',
    note TEXT DEFAULT '', alerted BOOLEAN DEFAULT false, ts TIMESTAMPTZ DEFAULT now()
  )`;
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

/* ---- qualified list builder support ---- */
const STORM_ZONE = {
  until: '2027-01-01', // Hurricane Isaias backlog; these flip to the best list in the state after this date
  places: ['Destin', 'Fort Walton', 'Panama City', 'Pensacola', 'Niceville', 'Crestview', 'Santa Rosa Beach', 'Navarre', 'Miramar Beach']
};
function inStormZone(address) {
  if (new Date().toISOString().slice(0, 10) >= STORM_ZONE.until) return false;
  const a = String(address || '').toLowerCase();
  return STORM_ZONE.places.some(p => a.includes(p.toLowerCase()));
}
async function geocodeCity(city) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(city);
  const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'BWDHub/1.0 (sales tool)' } });
  const j = await r.json();
  if (!j.length) throw new Error('Could not place the metro: ' + city);
  return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
}
/* One page, order preserved, biased to where a real customer stands. */
async function placesBiased(query, lat, lng, radiusM) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_KEY is not set.');
  const body = {
    textQuery: query, pageSize: 20,
    locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusM || 35000 } }
  };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.formattedAddress,places.googleMapsUri,places.businessStatus'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error((j.error && j.error.message) || ('Google error ' + r.status));
  }
  const j = await r.json();
  return (j.places || []).map((pl, i) => ({
    id: pl.id || '',
    name: (pl.displayName && pl.displayName.text) || '',
    phone: pl.nationalPhoneNumber || '',
    website: pl.websiteUri || '',
    rating: pl.rating || 0,
    reviews: pl.userRatingCount == null ? 0 : pl.userRatingCount,
    addr: pl.formattedAddress || '',
    maps: pl.googleMapsUri || '',
    status: pl.businessStatus || 'OPERATIONAL',
    pos: i + 1
  }));
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

/* ---- Twilio browser dialer ---- */
function twE164(s2) {
  let d = String(s2 || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return String(s2 || '').trim();
}
function twilioReady() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET &&
            process.env.TWILIO_TWIML_APP_SID && process.env.TWILIO_FROM);
}
function twilioNumbers() {
  return [process.env.TWILIO_FROM, process.env.TWILIO_FROM2].filter(Boolean).map(twE164);
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function twilioToken(identityEmail) {
  const now = Math.floor(Date.now() / 1000);
  const identity = String(identityEmail).replace(/[^a-zA-Z0-9_]/g, '_');
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' }));
  const payload = b64url(JSON.stringify({
    jti: process.env.TWILIO_API_KEY_SID + '-' + now,
    iss: process.env.TWILIO_API_KEY_SID,
    sub: process.env.TWILIO_ACCOUNT_SID,
    iat: now, exp: now + 3600,
    grants: { identity: identity,
              voice: { outgoing: { application_sid: process.env.TWILIO_TWIML_APP_SID }, incoming: { allow: true } } }
  }));
  const sig = b64url(crypto.createHmac('sha256', process.env.TWILIO_API_KEY_SECRET).update(header + '.' + payload).digest());
  return header + '.' + payload + '.' + sig;
}

/* ---- CRM company upsert: every touch keeps the record current ---- */
const STAGE_RANK = { new: 0, contacted: 1, engaged: 2, meeting: 3, proposal: 4, contract: 5, won: 6, lost: 6 };
async function upsertCompany(d, minStage) {
  const phone = normPhone(d.phone);
  if (!phone) return null;
  await sql`INSERT INTO companies (phone, name, website, email, addr, city, industry, rating, reviews, pos, maps, rep)
    VALUES (${phone}, ${d.name || ''}, ${d.website || ''}, ${d.email || ''}, ${d.addr || ''}, ${d.city || ''},
            ${d.industry || ''}, ${Number(d.rating) || 0}, ${d.reviews == null ? -1 : Number(d.reviews)},
            ${Number(d.pos) || 0}, ${d.maps || ''}, ${d.rep || ''})
    ON CONFLICT (phone) DO UPDATE SET
      name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE companies.name END,
      website = CASE WHEN EXCLUDED.website <> '' THEN EXCLUDED.website ELSE companies.website END,
      email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE companies.email END,
      city = CASE WHEN EXCLUDED.city <> '' THEN EXCLUDED.city ELSE companies.city END,
      industry = CASE WHEN EXCLUDED.industry <> '' THEN EXCLUDED.industry ELSE companies.industry END,
      rep = CASE WHEN companies.rep = '' THEN EXCLUDED.rep ELSE companies.rep END,
      updated = now()`;
  if (minStage) {
    const cur = await sql`SELECT stage FROM companies WHERE phone=${phone}`;
    const curStage = cur[0] ? cur[0].stage : 'new';
    if ((STAGE_RANK[minStage] || 0) > (STAGE_RANK[curStage] || 0) && curStage !== 'won' && curStage !== 'lost') {
      await sql`UPDATE companies SET stage=${minStage}, updated=now() WHERE phone=${phone}`;
    }
  }
  return phone;
}

/* ---- DocuSeal ---- */
async function docusealSend(templateId, clientEmail, clientName, values) {
  const key = process.env.DOCUSEAL_API_KEY;
  if (!key) throw new Error('DOCUSEAL_API_KEY is not set.');
  const body = {
    template_id: Number(templateId),
    send_email: true,
    submitters: [{ role: 'Client', email: clientEmail, name: clientName || '', values: values || {} }]
  };
  const r = await fetch('https://api.docuseal.com/submissions', {
    method: 'POST',
    headers: { 'X-Auth-Token': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('DocuSeal error ' + r.status + ': ' + (JSON.stringify(j).slice(0, 180)));
  const sub = Array.isArray(j) ? j[0] : j;
  return { id: String((sub && (sub.submission_id || sub.id)) || '') };
}

/* ---- DocuSeal template per product, with a general fallback ---- */
function docusealTemplate(productId) {
  const map = { lp500: 'DOCUSEAL_TEMPLATE_LP500', lp750: 'DOCUSEAL_TEMPLATE_LP750',
                onepage: 'DOCUSEAL_TEMPLATE_ONEPAGE', fullsite: 'DOCUSEAL_TEMPLATE_FULLSITE' };
  return process.env[map[productId]] || process.env.DOCUSEAL_TEMPLATE_ID || '';
}

/* ---- Wave checkout links (created once in Wave, mapped by env) ---- */
function waveLink(productId) {
  const map = { onepage: 'WAVE_LINK_ONEPAGE', fullsite: 'WAVE_LINK_FULLSITE', customsite: 'WAVE_LINK_CUSTOM',
                lp500: 'WAVE_LINK_LP500', lp750: 'WAVE_LINK_LP750', otherrec: 'WAVE_LINK_CUSTOM', other: 'WAVE_LINK_CUSTOM' };
  return process.env[map[productId]] || '';
}

/* ---- KPI comp plan: 4 closed deals a month, $50 for each one past 4 ---- */
function kpiTarget() { return Number(process.env.KPI_TARGET) || 4; }
function kpiBonus() { return Number(process.env.KPI_BONUS) || 50; }

/* ---- chain / franchise filter ---- */
const CHAIN_RX = /mcdonald|subway\b|domino|pizza hut|papa john|burger king|wendy|taco bell|kfc\b|dunkin|starbucks|walmart|autozone|advance auto|napa auto|midas\b|jiffy lube|valvoline|pep boys|firestone|monro\b|meineke|great clips|supercuts|sport clips|holiday hair|planet fitness|anytime fitness|crunch fitness|aspen dental|banfield|maaco|sherwin|h&r block|jackson hewitt|re\/max|remax|century 21|coldwell|keller williams|berkshire hathaway|petco\b|petsmart/i;
function isChain(name) { return CHAIN_RX.test(String(name || '')); }

/* ---- products & commission plan ---- */
const PRODUCTS = [
  { id: 'onepage',    label: 'One Page Website - $650 one time',                    kind: 'one_time',  amount: 650 },
  { id: 'fullsite',   label: 'Full Site - $850 one time',                           kind: 'one_time',  amount: 850 },
  { id: 'customsite', label: 'Custom Website (enter amount)',                       kind: 'one_time',  amount: 0 },
  { id: 'lp500',      label: 'Local Presence - $500/mo',                            kind: 'recurring', monthly: 500 },
  { id: 'lp750',      label: 'Local Presence + Website SEO & Maintenance - $750/mo', kind: 'recurring', monthly: 750 },
  { id: 'otherrec',   label: 'Other Monthly (enter amount)',                        kind: 'recurring', monthly: 0 },
  { id: 'other',      label: 'Other One-Time (enter amount)',                       kind: 'one_time',  amount: 0 }
];

/* Feature stack for the Local Presence proposals, grouped to sell */
const LP_FEATURES = [
  ['Google Business Profile, Fully Managed', [
    'Complete GBP listing optimization and advanced profile tuning',
    'Weekly GBP posts with category optimization',
    'GBP offer creation to turn searchers into callers',
    'Geo-tagged job photos with our image upload tool'
  ]],
  ['Reviews on Autopilot', [
    'Automated review management campaigns',
    'Auto-reply to customer reviews',
    'Bad reviews flagged instantly before they spread',
    'Full backup of your Google reviews'
  ]],
  ['Local Rankings Engine', [
    'In-depth keyword research, analysis, and consultation',
    'Set keywords and meta tags',
    'Competitive analysis of who is beating you and why',
    'Location-based citations with quality link building',
    'Geo-grid reporting that shows your map rankings block by block'
  ]],
  ['Content That Ranks', [
    'Optimized copywriting by real writers',
    'Ongoing SEO-based content updates'
  ]],
  ['The AI Search Advantage', [
    'AI SEO implementation for Gemini and ChatGPT',
    'AI rank reports across Gemini, ChatGPT, Perplexity, Grok, Llama, and Claude'
  ]],
  ['You Always Know Where You Stand', [
    'Monthly progress reporting in plain English'
  ]]
];
const LP750_EXTRA = ['Website SEO', 'Full website maintenance'];


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

module.exports = { docusealTemplate, LP_FEATURES, LP750_EXTRA, sql, ensureSchema, userFromToken, login, sendMail, placesSearch, scrapeEmails, isChain, geocodeCity, placesBiased, inStormZone, twE164, twilioReady, twilioNumbers, twilioToken, upsertCompany, STAGE_RANK, docusealSend, waveLink, kpiTarget, kpiBonus,
                   PRODUCTS, seqTemplates, auditUrl, normPhone, uid };

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
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS active INT DEFAULT 1`;
  await sql`CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY, email TEXT, name TEXT DEFAULT '', invited_by TEXT,
    used INT DEFAULT 0, ts TIMESTAMPTZ DEFAULT now()
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
  await sql`CREATE TABLE IF NOT EXISTS inbound (
    id SERIAL PRIMARY KEY, sid TEXT DEFAULT '', phone TEXT, line TEXT DEFAULT '', rep TEXT DEFAULT '', status TEXT DEFAULT 'missed',
    vm_url TEXT DEFAULT '', vm_secs INT DEFAULT 0, done_by TEXT DEFAULT '', done_ts TIMESTAMPTZ, ts TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_inbound_ts ON inbound (ts)`;
  await sql`CREATE TABLE IF NOT EXISTS ref_partners (
    id SERIAL PRIMARY KEY, company TEXT, contact TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '', code TEXT UNIQUE,
    status TEXT DEFAULT 'active', agreement TEXT DEFAULT 'none', docuseal_id TEXT DEFAULT '', pdf_url TEXT DEFAULT '',
    invited_ts TIMESTAMPTZ, signed_ts TIMESTAMPTZ, ts TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY, partner_id INT, business TEXT, contact TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '',
    note TEXT DEFAULT '', status TEXT DEFAULT 'submitted', source TEXT DEFAULT 'hub', kind TEXT DEFAULT '', amount NUMERIC DEFAULT 0,
    credit NUMERIC DEFAULT 0, ts TIMESTAMPTZ DEFAULT now(), updated TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS ref_credits (
    id SERIAL PRIMARY KEY, partner_id INT, referral_id INT, amount NUMERIC, note TEXT DEFAULT '', author TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY, name TEXT, contact TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '', website TEXT DEFAULT '',
    package TEXT DEFAULT '', mrr NUMERIC DEFAULT 0, start_date DATE, term_months INT DEFAULT 6, renewal_date DATE, status TEXT DEFAULT 'active',
    health TEXT DEFAULT 'auto', rep TEXT DEFAULT '', notes TEXT DEFAULT '', links TEXT DEFAULT '', created TIMESTAMPTZ DEFAULT now(), updated TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY, client_id INT, number TEXT DEFAULT '', amount NUMERIC DEFAULT 0, issued DATE, due DATE, status TEXT DEFAULT 'open',
    paid_date DATE, note TEXT DEFAULT '', created TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY, client_id INT, title TEXT, due DATE, assignee TEXT DEFAULT '', status TEXT DEFAULT 'open', recurring TEXT DEFAULT '',
    note TEXT DEFAULT '', created_by TEXT DEFAULT '', done_by TEXT DEFAULT '', done_ts TIMESTAMPTZ, created TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS wave_id TEXT DEFAULT ''`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS wave_id TEXT DEFAULT ''`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_due NUMERIC DEFAULT 0`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS wave_status TEXT DEFAULT ''`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurring_id TEXT DEFAULT ''`;
  await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS mrr_manual BOOLEAN DEFAULT false`;
  await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT ''`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS view_url TEXT DEFAULT ''`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_url TEXT DEFAULT ''`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC DEFAULT 0`;
  await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_ts TIMESTAMPTZ`;
  await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS value NUMERIC DEFAULT 0`;
  await sql`CREATE TABLE IF NOT EXISTS audit ( id SERIAL PRIMARY KEY, who TEXT, act TEXT, target TEXT DEFAULT '', detail TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now() )`;
  await sql`CREATE TABLE IF NOT EXISTS client_log ( id SERIAL PRIMARY KEY, client_id INT, author TEXT DEFAULT '', note TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now() )`;
  await sql`CREATE TABLE IF NOT EXISTS lp_check ( phone TEXT PRIMARY KEY, platforms TEXT DEFAULT '', none BOOLEAN DEFAULT false, rep TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now() )`;
  await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS alt_phones TEXT DEFAULT ''`;
  await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS fup_rep TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS territory TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS caller_id TEXT DEFAULT ''`;
  await sql`CREATE TABLE IF NOT EXISTS company_notes (
    id SERIAL PRIMARY KEY, phone TEXT, author TEXT, note TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cnotes_phone ON company_notes (phone)`;
  await sql`CREATE TABLE IF NOT EXISTS shift_reports (
    id SERIAL PRIMARY KEY, rep TEXT, rep_name TEXT DEFAULT '', day DATE, dials INT DEFAULT 0, convos INT DEFAULT 0,
    meetings INT DEFAULT 0, closed INT DEFAULT 0, voicemails INT DEFAULT 0, callbacks INT DEFAULT 0,
    gatekeepers INT DEFAULT 0, not_int INT DEFAULT 0, emails INT DEFAULT 0, objections TEXT DEFAULT '',
    well TEXT DEFAULT '', bad TEXT DEFAULT '', improve TEXT DEFAULT '', need TEXT DEFAULT '', ts TIMESTAMPTZ DEFAULT now()
  )`;
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
  const rows = await sql`SELECT u.email, u.name, u.role, COALESCE(u.territory,'') AS territory, COALESCE(u.caller_id,'') AS caller_id FROM sessions s JOIN users u ON u.email = s.email
                         WHERE s.token = ${token} AND s.expires > now() AND COALESCE(u.active,1) = 1`;
  return rows[0] || null;
}

async function login(email, pass) {
  const em = String(email || '').toLowerCase().trim();
  const rows = await sql`SELECT email, name, role FROM users WHERE email = ${em} AND pass = ${hashPass(pass)} AND COALESCE(active,1) = 1`;
  if (!rows[0]) return null;
  const token = uid();
  await sql`DELETE FROM sessions WHERE expires < now()`;
  await sql`INSERT INTO sessions (token, email, expires) VALUES (${token}, ${em}, now() + interval '30 days')`;
  return { token, user: rows[0] };
}

/* ---- Resend ---- */
async function sendMail(to, subject, html, replyTo, opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set.');
  const body = { from: process.env.MAIL_FROM || 'BWD <hello@burketwebdesign.com>', to: [to], subject, html };
  if (replyTo) body.reply_to = [replyTo];
  if (opts && opts.bcc && opts.bcc.length) {
    const bcc = opts.bcc.filter(x => x && x.toLowerCase() !== String(to).toLowerCase());
    if (bcc.length) body.bcc = bcc;
  }
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

/* ---- Emails that go to PROSPECTS / CLIENTS ----
 * Replies always go to the owner (OWNER_REPLY_TO, else OWNER_EMAIL, else ty@burketwebdesign.com).
 * Every one is BCC'd to MAIL_BCC (comma separated). Default: Steven, so he sees everything that goes out. */
function prospectReplyTo() {
  return process.env.OWNER_REPLY_TO || process.env.OWNER_EMAIL || 'ty@burketwebdesign.com';
}
function prospectBcc() {
  const raw = process.env.MAIL_BCC != null ? process.env.MAIL_BCC : 'wing.stevenhermoso@gmail.com';
  return String(raw).split(',').map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}
function sendProspectMail(to, subject, html) {
  return sendMail(to, subject, html, prospectReplyTo(), { bcc: prospectBcc() });
}

/* ---- Sequence timing (the cron runs once a day at 12:00 UTC = 7 AM EST / 8 AM EDT) ---- */
const SEQ_GAPS = [0, 3, 4];   // email 1 instantly, email 2 three days later, email 3 four days after that

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

/* ---- Lead-platform detection (Listing Calls) ----
 * A business that shows a HomeAdvisor / Angi / Thumbtack badge or profile link on its own site,
 * or whose Google listing points to one of those profiles, is buying (or has bought) shared leads. */
const LEAD_PLATFORMS = [
  ['HomeAdvisor', /homeadvisor\.com|home ?advisor|screened (?:&amp;|&|and) approved/i],
  ['Angi', /angi\.com|angieslist|angie'?s list|angi certified|angi leads|angi super ?service/i],
  ['Thumbtack', /thumbtack\.com|thumbtack top pro|on thumbtack/i],
  ['Porch', /porch\.com\/(?:pro|[a-z-]+\/[a-z-]+\/pros)/i],
  ['Networx', /networx\.com/i],
  ['Bark', /bark\.com\/(?:en\/)?(?:us\/)?company/i],
  ['Houzz', /houzz\.com\/(?:pro|professionals)\//i],
];
function platformsIn(text) {
  const out = [];
  LEAD_PLATFORMS.forEach(([name, rx]) => { if (rx.test(text)) out.push(name); });
  return out;
}
async function fetchQuick(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 4500);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BWDHub/1.0)' } });
    if (!r.ok) return '';
    return (await r.text()).slice(0, 400000);
  } catch (e) { return ''; } finally { clearTimeout(t); }
}
async function detectLeadPlatforms(website) {
  const w = String(website || '');
  if (!w) return { platforms: [], evidence: '' };
  const direct = platformsIn(w);
  if (direct.length) return { platforms: direct, evidence: 'Google listing links to their ' + direct[0] + ' profile' };
  let url = /^https?:\/\//i.test(w) ? w : 'https://' + w;
  const html = await fetchQuick(url);
  if (!html) return { platforms: [], evidence: '' };
  const found = platformsIn(html);
  return { platforms: found, evidence: found.length ? found.join(' + ') + ' badge or link on their website' : '' };
}

/* ---- Lead cleanup: duplicates, renamed businesses, keyword-stuffed Google names ---- */
const SHARED_HOSTS = /(facebook|instagram|yelp|google|business\.site|wixsite|godaddysites|square\.site|homeadvisor|angi|thumbtack|linktr\.ee|sites\.google)\./i;
function domainOf(u) {
  try { const h = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); return SHARED_HOSTS.test(h + '.') ? '' : h; }
  catch (e) { return ''; }
}
const NAME_FILLER = new Set(('llc inc co corp company the of and & services service repair repairs pros pro best top near me local ' +
  'experts expert solutions contractors contractor fl florida pa pennsylvania usa county area team group professional professionals ' +
  'residential commercial installation installers install specialists 24 hour emergency affordable quality').split(' '));
function nameTokens(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean); }
function looksGeneric(name, vertical, town) {
  const vw = new Set(nameTokens(vertical).concat(nameTokens(vertical).map(w => w.replace(/s$/, ''))));
  const tw = new Set(nameTokens(town));
  const rest = nameTokens(name).filter(w => !NAME_FILLER.has(w) && !vw.has(w) && !vw.has(w.replace(/s$/, '')) && !tw.has(w) && w.length > 1);
  return rest.length === 0;
}
function domainMatchesName(domain, name) {
  const base = String(domain || '').split('.')[0].replace(/[^a-z0-9]/g, '');
  if (!base) return true;
  return nameTokens(name).some(w => w.length >= 4 && !NAME_FILLER.has(w) && base.includes(w));
}
function cleanTitle(t) {
  const x = String(t || '').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
  const parts = x.split(/\s[|\-–—:]\s/).map(s => s.trim()).filter(Boolean);
  const pick = parts.sort((a, b) => a.length - b.length).find(p => p.length >= 3 && p.length <= 45 && !/^(home|welcome|homepage)$/i.test(p));
  return pick || '';
}
async function siteName(website) {
  const html = await fetchQuick(/^https?:\/\//i.test(website) ? website : 'https://' + website, 4000);
  if (!html) return '';
  const og = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{3,60})["']/i) || html.match(/<meta[^>]+content=["']([^"']{3,60})["'][^>]+property=["']og:site_name["']/i) || [])[1];
  if (og) return cleanTitle(og);
  return cleanTitle((html.match(/<title[^>]*>([^<]{3,120})<\/title>/i) || [])[1]);
}
/* Remove duplicates (same website domain, same name), drop businesses already worked under another phone,
   and flag listings whose Google name doesn't look like the real business, with the website's own name as a hint. */
async function cleanLeads(sqlFn, list, vertical) {
  const seenDom = {}, seenName = {}, out = [];
  for (const b of list) {
    b.domain = domainOf(b.website);
    const nk = nameTokens(b.name).filter(w => !NAME_FILLER.has(w)).join(' ');
    if (b.domain && seenDom[b.domain]) continue;
    if (nk && seenName[nk + '|' + (b.town || '')]) continue;
    if (b.domain) seenDom[b.domain] = true;
    if (nk) seenName[nk + '|' + (b.town || '')] = true;
    out.push(b);
  }
  const doms = out.map(b => b.domain).filter(Boolean);
  if (doms.length) {
    const worked = {};
    const rows = await sqlFn`SELECT website FROM companies WHERE website <> '' UNION SELECT DISTINCT website FROM calls WHERE website <> '' AND ts > now() - interval '365 days'`;
    rows.forEach(r => { const d = domainOf(r.website); if (d) worked[d] = true; });
    for (let i = out.length - 1; i >= 0; i--) if (out[i].domain && worked[out[i].domain]) out.splice(i, 1);
  }
  const flag = out.filter(b => b.website && (looksGeneric(b.name, vertical, b.town) || (b.domain && !domainMatchesName(b.domain, b.name))));
  const names = await Promise.all(flag.map(b => siteName(b.website).catch(() => '')));
  flag.forEach((b, i) => {
    b.nameCheck = looksGeneric(b.name, vertical, b.town) ? 'generic' : 'domain';
    if (names[i] && nameTokens(names[i]).join(' ') !== nameTokens(b.name).join(' ')) b.aka = names[i];
  });
  return out;
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
/* Each seat dials from its own number so the owner (Pennsylvania) and the SDR (Florida) can call at the same time.
 * Owner default: OWNER_FROM, else the original PA line (814) 680-2901. Everyone else: TWILIO_FROM. A seat's caller_id overrides. */
const OWNER_FROM_DEFAULT = '+18146802901';
function ownerFrom() { return twE164(process.env.OWNER_FROM || OWNER_FROM_DEFAULT); }
function territoryFor(u) {
  const t = String((u && u.territory) || '').toUpperCase();
  if (t === 'PA' || t === 'FL') return t;
  return u && u.role === 'owner' ? 'PA' : 'FL';
}
function callerFor(u) {
  const nums = twilioNumbers();
  const own = twE164((u && u.caller_id) || '');
  if (own && nums.indexOf(own) > -1) return own;
  return u && u.role === 'owner' ? ownerFrom() : twE164(process.env.TWILIO_FROM);
}
/* Local presence: when a seat dials into a state where we own a number, show that state's number. */
const AREA_STATE = {};
['814','582','412','724','878','717','223','570','272','610','484','215','267','445','835'].forEach(a => AREA_STATE[a] = 'PA');
['239','305','786','645','321','352','386','407','689','561','727','754','772','813','850','863','904','941','954','448','656','324'].forEach(a => AREA_STATE[a] = 'FL');
function stateOfNumber(n) { const d = String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return AREA_STATE[d.slice(0, 3)] || ''; }
function localCallerFor(u, to) {
  const st = stateOfNumber(to);
  if (st) {
    const match = twilioNumbers().find(n => stateOfNumber(n) === st);
    if (match) return match;
  }
  return callerFor(u);
}
function twilioNumbers() {
  const list = [process.env.TWILIO_FROM, process.env.TWILIO_FROM2, ownerFrom()].filter(Boolean).map(twE164);
  return list.filter((x, i) => list.indexOf(x) === i);
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
  { id: 'lp500',      label: 'Local Presence - $500/mo',                            kind: 'recurring', monthly: 500 },
  { id: 'lp750',      label: 'Local Presence + Website SEO & Maintenance - $750/mo', kind: 'recurring', monthly: 750 },
  { id: 'onepage',    label: 'One Page Website - $650 one time',                    kind: 'one_time',  amount: 650 },
  { id: 'fullsite',   label: 'Full Site - $850 one time',                           kind: 'one_time',  amount: 850 },
  { id: 'customsite', label: 'Custom Website (enter amount)',                       kind: 'one_time',  amount: 0 },
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


/* ---- Wave sync (read-only): customers + invoices into the CRM ---- */
async function waveGql(query, variables) {
  const tok = process.env.WAVE_TOKEN;
  if (!tok) throw new Error('WAVE_TOKEN is not set in Vercel.');
  const r = await fetch('https://gql.waveapps.com/graphql/public', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error('Wave: ' + ((j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status)));
  return j.data;
}
async function waveBusiness(sqlFn) {
  const saved = ((await sqlFn`SELECT v FROM kv WHERE k='wave_business'`)[0] || {}).v;
  const d = await waveGql('query { businesses(page: 1, pageSize: 20) { edges { node { id name isPersonal isArchived } } } }');
  const list = d.businesses.edges.map(e => e.node).filter(b => !b.isArchived);
  let biz = list.find(b => b.id === saved) || list.find(b => /burket/i.test(b.name)) || list.find(b => !b.isPersonal) || list[0];
  if (!biz) throw new Error('No business found in Wave.');
  if (biz.id !== saved) await sqlFn`INSERT INTO kv (k, v) VALUES ('wave_business', ${biz.id}) ON CONFLICT (k) DO UPDATE SET v=${biz.id}`;
  return { biz, all: list };
}
async function waveSync(sqlFn) {
  const { biz } = await waveBusiness(sqlFn);
  const customers = [], invoices = [];
  for (let p = 1; p <= 20; p++) {
    const d = await waveGql(`query($id: ID!, $p: Int!) { business(id: $id) { customers(page: $p, pageSize: 100) { pageInfo { totalPages }
      edges { node { id name firstName lastName email phone mobile createdAt } } } } }`, { id: biz.id, p });
    const c = d.business.customers; c.edges.forEach(e => customers.push(e.node));
    if (p >= (c.pageInfo.totalPages || 1)) break;
  }
  for (let p = 1; p <= 30; p++) {
    const d = await waveGql(`query($id: ID!, $p: Int!) { business(id: $id) { invoices(page: $p, pageSize: 100) { pageInfo { totalPages }
      edges { node { ${WAVE_INV_FIELDS} } } } } }`, { id: biz.id, p });
    const c = d.business.invoices; c.edges.forEach(e => invoices.push(e.node));
    if (p >= (c.pageInfo.totalPages || 1)) break;
  }
  const out = { business: biz.name, customers: customers.length, invoices: 0, newClients: 0, linked: 0, paidNow: 0, skipped: 0 };
  const day = s => (s ? String(s).slice(0, 10) : null);
  const ago = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const sent = invoices.filter(i => !['DRAFT', 'SAVED'].includes(i.status));
  const byCust = {};
  sent.forEach(i => { const k = i.customer && i.customer.id; if (k) (byCust[k] = byCust[k] || []).push(i); });
  const paidOn = i => { const ps = (i.payments || []).map(p => day(p.paymentDate)).filter(Boolean).sort(); return ps.length ? ps[ps.length - 1] : day(i.modifiedAt); };
  const recId = i => (i.source && i.source.__typename === 'RecurringInvoice' && i.source.id) || '';
  /* recurring schedules per customer: a schedule is live if it produced an invoice in the last 45 days */
  const rec = {};
  sent.forEach(i => { const r = recId(i), k = i.customer && i.customer.id; if (!r || !k) return;
    rec[k] = rec[k] || {}; const cur = rec[k][r]; if (!cur || String(i.invoiceDate) > String(cur.invoiceDate)) rec[k][r] = i; });
  const recInfo = k => { const s = Object.values(rec[k] || {}); const live = s.filter(i => day(i.invoiceDate) >= ago(45));
    return { had: s.length > 0, live: live.length, mrr: live.reduce((a, i) => a + (Number(i.total.value) || 0), 0), last: s.map(i => day(i.invoiceDate)).sort().pop() }; };
  out.churned = 0; out.mrrUpdated = 0;

  /* link or create clients */
  const clients = await sqlFn`SELECT id, name, wave_id, mrr FROM clients`;
  const byWave = {}, byName = {};
  clients.forEach(c => { if (c.wave_id) byWave[c.wave_id] = c; byName[String(c.name).toLowerCase().trim()] = c; });
  for (const cu of customers) {
    let c = byWave[cu.id];
    const nm = String(cu.name || ((cu.firstName || '') + ' ' + (cu.lastName || ''))).trim();
    if (!c && byName[nm.toLowerCase()]) {
      c = byName[nm.toLowerCase()];
      await sqlFn`UPDATE clients SET wave_id=${cu.id} WHERE id=${c.id}`; c.wave_id = cu.id; byWave[cu.id] = c; out.linked++;
    }
    if (c) continue;
    /* only bring in customers billed in the last 60 days: that is a paying client */
    const ri = recInfo(cu.id);
    const recent = (byCust[cu.id] || []).filter(i => day(i.invoiceDate) >= ago(60));
    if (!(byCust[cu.id] || []).length) continue;                 /* never billed: not a client */
    const isCurrent = ri.live || (!ri.had && recent.length);
    const mrr = ri.mrr;
    const first = (byCust[cu.id] || []).map(i => day(i.invoiceDate)).sort()[0];
    const id = (await sqlFn`INSERT INTO clients (name, contact, email, phone, mrr, start_date, term_months, status, wave_id)
      VALUES (${nm}, ${((cu.firstName || '') + ' ' + (cu.lastName || '')).trim()}, ${cu.email || ''}, ${normPhone(cu.phone || cu.mobile) || ''}, ${mrr},
              ${first || day(cu.createdAt)}, 0, ${isCurrent ? 'active' : 'past'}, ${cu.id}) RETURNING id`)[0].id;
    await sqlFn`INSERT INTO client_log (client_id, author, note) VALUES (${id}, 'wave', ${'Imported from Wave' + (isCurrent ? '' : ' as a past customer (no current billing)') + (mrr ? ' (MRR from Wave recurring invoices: $' + mrr + ')' : '')})`;
    byWave[cu.id] = { id, name: nm, wave_id: cu.id }; out.newClients++;
  }

  /* existing linked clients: keep MRR and status in step with Wave recurring invoices */
  const linkedRows = await sqlFn`SELECT id, name, wave_id, mrr, status, mrr_manual FROM clients WHERE wave_id <> ''`;
  for (const c of linkedRows) {
    const ri = recInfo(c.wave_id);
    if (!ri.had) continue;                                   /* one-off billing only: leave it to Ty */
    if (!ri.live && (c.status === 'active' || c.status === 'onboarding')) {
      await sqlFn`UPDATE clients SET status='churned', updated=now() WHERE id=${c.id}`;
      await sqlFn`INSERT INTO client_log (client_id, author, note) VALUES (${c.id}, 'wave', ${'Marked churned: no recurring invoice in Wave since ' + ri.last})`;
      await sqlFn`UPDATE deals SET status='cancelled', cancelled_ts=now() WHERE lower(business)=lower(${c.name}) AND status='approved' AND cancelled_ts IS NULL`;
      out.churned++;
    } else if (ri.live && (c.status === 'past' || c.status === 'churned')) {
      await sqlFn`UPDATE clients SET status='active', mrr=${c.mrr_manual ? c.mrr : ri.mrr}, updated=now() WHERE id=${c.id}`;
      await sqlFn`INSERT INTO client_log (client_id, author, note) VALUES (${c.id}, 'wave', 'Back on recurring billing in Wave: marked active')`;
    } else if (ri.live && !c.mrr_manual && Number(c.mrr) !== ri.mrr) {
      await sqlFn`UPDATE clients SET mrr=${ri.mrr}, updated=now() WHERE id=${c.id}`;
      await sqlFn`INSERT INTO client_log (client_id, author, note) VALUES (${c.id}, 'wave', ${'MRR synced from Wave recurring invoice: $' + Number(c.mrr) + ' → $' + ri.mrr})`;
      out.mrrUpdated++;
    }
  }

  /* invoices */
  const known = {}; (await sqlFn`SELECT wave_id, status FROM invoices WHERE wave_id <> ''`).forEach(r => known[r.wave_id] = r.status);
  for (const i of invoices) {
    const c = i.customer && byWave[i.customer.id];
    if (!c) { out.skipped++; continue; }
    if (['DRAFT', 'SAVED'].includes(i.status) && !known[i.id]) continue;
    /* a manual entry with the same number takes the Wave link instead of duplicating */
    if (!known[i.id] && i.invoiceNumber) await sqlFn`UPDATE invoices SET wave_id=${i.id} WHERE client_id=${c.id} AND number=${String(i.invoiceNumber)} AND (wave_id IS NULL OR wave_id='')`;
    const wasPaid = known[i.id] === 'paid';
    await waveUpsertInvoice(sqlFn, i, c.id);
    if (known[i.id] && !wasPaid && ['PAID', 'OVERPAID'].includes(i.status)) {
      out.paidNow++;
      await sqlFn`INSERT INTO client_log (client_id, author, note) VALUES (${c.id}, 'wave', ${'Paid in Wave: invoice #' + (i.invoiceNumber || '') + ' $' + Number(i.total.value)})`;
    }
    out.invoices++;
  }
  await sqlFn`INSERT INTO kv (k, v) VALUES ('wave_last_sync', ${JSON.stringify(Object.assign({ at: new Date().toISOString() }, out))}) ON CONFLICT (k) DO UPDATE SET v=${JSON.stringify(Object.assign({ at: new Date().toISOString() }, out))}`;
  return out;
}

/* ---- Wave write actions: customers, invoices, sending, payments ---- */
const WAVE_INV_FIELDS = 'id invoiceNumber invoiceDate dueDate status modifiedAt viewUrl pdfUrl customer { id name } total { value } amountDue { value } amountPaid { value } source { __typename ... on RecurringInvoice { id } } payments { paymentDate }';
async function waveMeta(sqlFn) {
  const { biz } = await waveBusiness(sqlFn);
  const d = await waveGql(`query($id: ID!) { business(id: $id) { id name
      products(page: 1, pageSize: 100) { edges { node { id name description unitPrice isSold isArchived } } }
      accounts(page: 1, pageSize: 50, subtypes: [CASH_AND_BANK]) { edges { node { id name } } } } }`, { id: biz.id });
  return { business: { id: biz.id, name: biz.name },
    products: d.business.products.edges.map(e => e.node).filter(p => p.isSold && !p.isArchived),
    accounts: d.business.accounts.edges.map(e => e.node) };
}
function waveCheck(out, what) {
  if (!out) throw new Error('Wave did not answer the ' + what + ' request.');
  if (!out.didSucceed) throw new Error('Wave would not ' + what + ': ' + ((out.inputErrors || []).map(e => (e.path ? e.path + ' ' : '') + e.message).join('; ') || 'unknown error'));
  return out;
}
async function waveCustomerCreate(sqlFn, c) {
  const { biz } = await waveBusiness(sqlFn);
  const parts = String(c.contact || '').trim().split(/\s+/);
  const d = await waveGql(`mutation($input: CustomerCreateInput!) { customerCreate(input: $input) { didSucceed inputErrors { path message } customer { id name } } }`,
    { input: { businessId: biz.id, name: c.name, firstName: parts[0] || undefined, lastName: parts.slice(1).join(' ') || undefined,
      email: c.email || undefined, phone: c.phone || undefined, website: c.website || undefined } });
  return waveCheck(d.customerCreate, 'create the customer').customer;
}
async function waveInvoiceCreate(sqlFn, o) {
  const { biz } = await waveBusiness(sqlFn);
  const input = { businessId: biz.id, customerId: o.customerId, status: 'SAVED', invoiceDate: o.invoiceDate, dueDate: o.dueDate,
    title: o.title || undefined, memo: o.memo || undefined,
    items: o.items.map(i => ({ productId: i.productId, description: i.description || undefined, quantity: String(i.quantity || 1), unitPrice: String(i.unitPrice) })) };
  if (o.discount > 0) input.discounts = [{ discountType: 'FIXED', amount: String(o.discount), name: o.discountName || 'Referral credit' }];
  const d = await waveGql(`mutation($input: InvoiceCreateInput!) { invoiceCreate(input: $input) { didSucceed inputErrors { path message } invoice { ${WAVE_INV_FIELDS} } } }`, { input });
  return waveCheck(d.invoiceCreate, 'create the invoice').invoice;
}
async function waveInvoiceApprove(id) {
  const d = await waveGql(`mutation($input: InvoiceApproveInput!) { invoiceApprove(input: $input) { didSucceed inputErrors { path message } invoice { ${WAVE_INV_FIELDS} } } }`, { input: { invoiceId: id } });
  return waveCheck(d.invoiceApprove, 'approve the invoice').invoice;
}
async function waveInvoiceSend(o) {
  const d = await waveGql(`mutation($input: InvoiceSendInput!) { invoiceSend(input: $input) { didSucceed inputErrors { path message } invoice { ${WAVE_INV_FIELDS} } } }`,
    { input: { invoiceId: o.invoiceId, to: o.to, subject: o.subject || undefined, message: o.message || undefined, attachPDF: true, ccMyself: !!o.ccMyself } });
  return waveCheck(d.invoiceSend, 'send the invoice').invoice;
}
async function waveInvoiceGet(sqlFn, id) {
  const { biz } = await waveBusiness(sqlFn);
  const d = await waveGql(`query($b: ID!, $i: ID!) { business(id: $b) { invoice(id: $i) { ${WAVE_INV_FIELDS} } } }`, { b: biz.id, i: id });
  return d.business.invoice;
}
async function wavePaymentCreate(o) {
  const d = await waveGql(`mutation($input: InvoicePaymentCreateManualInput!) { invoicePaymentCreateManual(input: $input) { didSucceed inputErrors { path message } } }`,
    { input: { invoiceId: o.invoiceId, paymentAccountId: o.accountId, amount: String(o.amount), paymentDate: o.date, paymentMethod: o.method || 'BANK_TRANSFER', exchangeRate: '1', memo: o.memo || undefined } });
  return waveCheck(d.invoicePaymentCreateManual, 'record the payment');
}
async function waveInvoiceDelete(id) {
  const d = await waveGql(`mutation($input: InvoiceDeleteInput!) { invoiceDelete(input: $input) { didSucceed inputErrors { path message } } }`, { input: { invoiceId: id } });
  return waveCheck(d.invoiceDelete, 'delete the invoice');
}
/* write one Wave invoice into the local table */
async function waveUpsertInvoice(sqlFn, i, clientId) {
  const day = s => (s ? String(s).slice(0, 10) : null);
  const paid = ['PAID', 'OVERPAID'].includes(i.status);
  const ps = (i.payments || []).map(p => day(p.paymentDate)).filter(Boolean).sort();
  const paidOn = ps.length ? ps[ps.length - 1] : day(i.modifiedAt);
  const recId = (i.source && i.source.__typename === 'RecurringInvoice' && i.source.id) || '';
  const st = paid ? 'paid' : (['DRAFT', 'SAVED'].includes(i.status) ? 'draft' : 'open');
  const amt = Number(i.total && i.total.value) || 0, due = Number(i.amountDue && i.amountDue.value) || 0, apaid = Number(i.amountPaid && i.amountPaid.value) || 0;
  const prev = (await sqlFn`SELECT id FROM invoices WHERE wave_id=${i.id}`)[0];
  if (prev) {
    await sqlFn`UPDATE invoices SET client_id=${clientId}, number=${i.invoiceNumber || ''}, amount=${amt}, amount_due=${due}, amount_paid=${apaid}, issued=${day(i.invoiceDate)}, due=${day(i.dueDate)},
      status=${st}, wave_status=${i.status}, recurring_id=${recId}, view_url=${i.viewUrl || ''}, pdf_url=${i.pdfUrl || ''}, paid_date=${paid ? paidOn : null} WHERE id=${prev.id}`;
    return prev.id;
  }
  return (await sqlFn`INSERT INTO invoices (client_id, number, amount, amount_due, amount_paid, issued, due, status, wave_status, paid_date, wave_id, recurring_id, view_url, pdf_url, note)
    VALUES (${clientId}, ${i.invoiceNumber || ''}, ${amt}, ${due}, ${apaid}, ${day(i.invoiceDate)}, ${day(i.dueDate)}, ${st}, ${i.status}, ${paid ? paidOn : null}, ${i.id}, ${recId},
            ${i.viewUrl || ''}, ${i.pdfUrl || ''}, ${recId ? 'Wave recurring' : 'From Wave'}) RETURNING id`)[0].id;
}

module.exports = { waveSync, waveBusiness, waveGql, waveMeta, waveCustomerCreate, waveInvoiceCreate, waveInvoiceApprove, waveInvoiceSend, waveInvoiceGet, wavePaymentCreate, waveInvoiceDelete, waveUpsertInvoice, cleanLeads, domainOf, detectLeadPlatforms, hashPass, docusealTemplate, LP_FEATURES, LP750_EXTRA, sql, ensureSchema, userFromToken, login, sendMail, placesSearch, scrapeEmails, isChain, geocodeCity, placesBiased, inStormZone, twE164, twilioReady, twilioNumbers, twilioToken, upsertCompany, STAGE_RANK, docusealSend, waveLink, kpiTarget, kpiBonus,
                   PRODUCTS, seqTemplates, auditUrl, normPhone, uid,
                   sendProspectMail, prospectReplyTo, prospectBcc, SEQ_GAPS, territoryFor, callerFor, ownerFrom,
                   localCallerFor, stateOfNumber };

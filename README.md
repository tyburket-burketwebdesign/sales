# BWD SDR Hub

Two-seat sales headquarters for Burket Web Design: owner + one SDR. Prospecting with live Google data, one-call-at-a-time dialing screen, voicemail-to-email sequences through Resend, commission tracking with owner approval, and a daily report email.

## Deploy (10 minutes)

1. Push this folder to a GitHub repo.
2. Vercel -> Add New Project -> import the repo. No framework, no build command, defaults are fine.
3. In the Vercel project: Storage -> Create Database -> Postgres (Neon). This auto-adds `DATABASE_URL`.
4. Settings -> Environment Variables: add everything in the table below, then redeploy.
5. Open the site, sign in, dial.

Tables create themselves on first request. The cron in `vercel.json` runs daily at 12:00 UTC (8 AM ET): it advances email sequences, accrues recurring commissions, and emails the owner the daily report.

## Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Added automatically when you create the Vercel/Neon Postgres database |
| `APP_SECRET` | yes | Any long random string. Used to hash passwords and sessions |
| `OWNER_EMAIL` | yes | ty@burketwebdesign.com |
| `OWNER_PASS` | yes | Your sign-in password |
| `OWNER_NAME` | no | Defaults to Ty Burket |
| `SDR_EMAIL` | yes | The SDR's sign-in email |
| `SDR_PASS` | yes | The SDR's password |
| `SDR_NAME` | yes | The SDR's display name (used in scripts and emails) |
| `GOOGLE_PLACES_KEY` | yes | Google Places API key. Stays server-side, never exposed to the browser |
| `RESEND_API_KEY` | yes | From resend.com -> API Keys |
| `MAIL_FROM` | yes | Verified sender, e.g. `Burket Web Design <hello@burketwebdesign.com>` (domain must be verified in Resend) |
| `MAIL_TO` | no | Where owner notifications and daily reports go. Defaults to OWNER_EMAIL |
| `AUDIT_URL` | no | Defaults to https://www.burketwebdesign.com/scan/ |
| `CRON_SECRET` | no | If set, Vercel protects the cron endpoint with it automatically |
| `TWILIO_ACCOUNT_SID` | for dialer | Twilio Console dashboard, starts with AC |
| `TWILIO_API_KEY_SID` | for dialer | Console -> Account -> API keys, starts with SK |
| `TWILIO_API_KEY_SECRET` | for dialer | Shown once when the API key is created |
| `TWILIO_TWIML_APP_SID` | for dialer | Console -> Voice -> TwiML Apps, starts with AP |
| `TWILIO_FROM` | for dialer | Your Twilio number in +1 format |
| `TWILIO_FROM2` | no | Second caller ID number, +1 format |
| `TWILIO_CAP_MIN` | no | Monthly calling minutes cap, default 1100 (about $20/mo) |
| `TWILIO_WEBHOOK_KEY` | for dialer | Any random string; must match the ?k= in the webhook URL below |
| `TWILIO_FALLBACK` | no | A real cell in +1 format. If nobody has the hub open, inbound calls ring this phone before going to the missed-call message |
| `DOCUSEAL_API_KEY` | for contracts | docuseal.com -> Settings -> API |
| `DOCUSEAL_TEMPLATE_LP500` | for contracts | Template id of the Local Presence $500 contract |
| `DOCUSEAL_TEMPLATE_LP750` | for contracts | Template id of the Local Presence + Website SEO $750 contract |
| `DOCUSEAL_TEMPLATE_ONEPAGE` | for contracts | Template id of the One Page Website $650 contract |
| `DOCUSEAL_TEMPLATE_FULLSITE` | for contracts | Template id of the Full Site $850 contract |
| `DOCUSEAL_TEMPLATE_ID` | no | Fallback template used for any product without its own template id |
| `WAVE_LINK_ONEPAGE` | no | Wave checkout URL for the $650 one-page site |
| `WAVE_LINK_FULLSITE` | no | Wave checkout URL for the $850 full site |
| `WAVE_LINK_LP500` | no | Wave checkout URL for Local Presence $500/mo |
| `WAVE_LINK_LP750` | no | Wave checkout URL for Local Presence + Website SEO & Maintenance $750/mo |
| `WAVE_LINK_CUSTOM` | no | Wave checkout URL used for custom amounts |
| `KPI_TARGET` | no | Closed deals per month expected, default 4 |
| `KPI_BONUS` | no | Dollars per closed deal past the target, default 50 |

## DocuSeal setup (contracts)

1. docuseal.com -> create your contract template. Add text fields named exactly: business, service, price, date. Add the signature field for the Client role.
2. Settings -> API -> copy the key into DOCUSEAL_API_KEY. Put the template's numeric id in DOCUSEAL_TEMPLATE_ID.
3. Settings -> Webhooks -> add `https://YOUR-APP.vercel.app/api/docuseal?k=YOUR_TWILIO_WEBHOOK_KEY` and enable form.completed (and form.viewed if offered).
4. Redeploy. The Send Contract button appears on every company. Signing marks the company Won, creates the deal for approval, and emails both seats.

## The comp plan (built in)

Closed deal = met with Ty, deal approved in the hub. KPI is KPI_TARGET per month (default 4). Every approved deal past the target automatically adds a KPI_BONUS ($50) ledger entry and emails the SDR. The Commissions tab shows the month as a row of dots: checks for KPI deals, gold dollar dots for bonus deals.

## Browser dialer setup

1. Add the Twilio env vars above and redeploy.
2. Twilio Console -> Voice -> TwiML Apps -> create one. Voice Request URL (HTTP POST):
   `https://YOUR-APP.vercel.app/api/voice?k=YOUR_TWILIO_WEBHOOK_KEY`
3. Phone Numbers -> your number -> Voice Configuration -> "A call comes in" -> Webhook -> same URL, HTTP POST. Repeat for the second number.
4. Hard refresh the hub. A green "dialer ready" chip appears in the top bar, every call screen gains a Call button, and inbound callbacks ring both seats with Answer/Decline. Calls count against the monthly minutes cap; missed inbound calls email the team.

To change a password, change the env var and redeploy. Seats re-sync from env on every cold start.

## How the SDR flow works

Build My 50 pulls up to 50 fresh businesses (Google position, rating, reviews, website; numbers already called or on the do-not-call list are skipped forever). Start Calling opens the one-at-a-time screen: stats, tel: link, personalized permission-opener script, voicemail script, objections, best-time window, note + follow-up date, keyboard shortcuts 1-6 / M / N / P.

No answer or voicemail keeps the screen open and arms the email panel: scrape their website for an email (or paste one), hit Start Email Sequence. Email 1 goes out instantly with the free scan link, emails 2 and 3 follow on about day 3 and day 7 automatically. Replies go to the SDR (reply-to). Sequences stop on meeting, do-not-call, or manually.

Meetings and submitted deals email the owner instantly. Deal approval moves commission to the ledger (websites 20% one-time; monthly plans 50% of month one plus 10% monthly, accrued automatically every 30 days). The owner tab has approvals, payouts, team activity, and all sequences.

## Commission plan (edit in api/_lib/core.js PRODUCTS)

- One Page Website $650: 20% = $130
- Full Site $850: 20% = $170
- Local Presence Essentials $299/mo: $149.50 first month + $29.90/mo
- Local Presence Complete $500/mo: $250 first month + $50/mo
- Custom amounts available for anything else

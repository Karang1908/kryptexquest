# Deploying Kryptex Quest (Vercel + Supabase)

The site is static files (no build). Vercel serves them; Supabase is the backend (database, Google sign-in, photo storage, the photo-check function). Nothing here has been deployed yet.

## 0. What is already prepared in the repo
- `vercel.json`: no build, security headers (geolocation and camera allowed for the site only), `/admin` marked noindex, long cache for `assets/`, and redirects that hide `/supabase`, `/scripts`, `serve.py` and every `.md` file.
- `.vercelignore`: keeps `supabase/`, `scripts/` and the docs out of a CLI upload.
- `vercel.json` sets `Cache-Control: max-age=0, must-revalidate` on everything except `assets/` (7 days). Vercel's default for JS and CSS is 4 hours, which left phones on an old `config.js` after the first deploy.
- Remote dependencies (all pinned): MapLibre (unpkg), three.js and supabase-js (jsdelivr), model-viewer (ajax.googleapis.com), OpenFreeMap tiles, Google Fonts. Event-day risk: if campus Wi-Fi blocks one of these, the game breaks. Test on the real network.

## 1. Supabase project
1. supabase.com > New project. Pick the region closest to Dubai (Mumbai or Frankfurt, whichever is offered). Save the database password.
2. **Plan**: free tier is fine for testing. For the event month use Pro (about $25): free projects pause after a week of inactivity and have small compute. Decide this before the event, not during it.
3. **Apply the SQL**, SQL Editor > New query, run these in order, one file at a time (copy each file's contents):
   `supabase/migrations/0001_init.sql` to `0015_lock_down_anon_functions.sql`.
   Quick way to get one file: `cat supabase/migrations/*.sql | pbcopy` (they sort correctly), then paste and run once.
   Every file must finish without an error. If one fails, stop and send me the message.
4. **Seed content**: run `supabase/seed.sql` (sample flags: only for a rehearsal). For the real event create `supabase/seed.local.sql` (gitignored) with the real flags and locations and run that instead. You can also edit everything in the console at `/admin/` afterwards.
5. **Make yourself an admin**, SQL Editor:
   `insert into public.admins (email) values ('you@dubai.bits-pilani.ac.in');`
   (add every organiser the same way).
6. **Storage**: the buckets `puzzle-refs`, `submissions` (private) and `question-images` (public) are created by the migrations. Check Storage lists all three.
7. **Auth > Sign In / Providers**: enable Google (step 2 below), and turn **Email** off so nobody can sign up with a password. The database also rejects any email outside `dubai.bits-pilani.ac.in`.
8. **Auth > URL Configuration**:
   - Site URL: `https://YOUR-DOMAIN` (the final one).
   - Redirect URLs: `https://YOUR-DOMAIN/**`, `https://YOUR-PROJECT.vercel.app/**`, and `http://localhost:4173/**` while testing.
9. **Project Settings > API**: copy the Project URL and the `anon` public key (safe to publish). Never put the `service_role` key in the repo or the site.

## 2. Google sign-in (Google Cloud console)
1. console.cloud.google.com > create a project (for example "Kryptex Quest").
2. APIs & Services > OAuth consent screen: User type **External** (Internal only works if your university's Google Workspace owns the project). App name, support email, your logo, authorised domain = your domain. Scopes: only `email`, `profile`, `openid`.
3. **Publishing status: set "In production".** While it says "Testing", only 100 listed test users can sign in. With only the basic scopes Google does not require verification, but players see an "unverified app" screen if you add sensitive scopes, so do not add any.
4. APIs & Services > Credentials > Create credentials > OAuth client ID > Web application:
   - Authorised JavaScript origins: `https://YOUR-DOMAIN`
   - Authorised redirect URIs: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
5. Copy the client ID and secret into Supabase > Auth > Providers > Google, and save.
6. The app sends `hd=dubai.bits-pilani.ac.in`, which only hints the account picker. The real block is the database trigger.

## 3. Photo check function
```
brew install supabase/tap/supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy verify-photo
# keys: one per line in a file OUTSIDE the repo, up to 10 (more are ignored)
supabase secrets set OLLAMA_API_KEYS="$(paste -sd, ~/ollama-keys.txt)"
rm ~/ollama-keys.txt
```
A key that returns 401, 402, 403 or 429 (or times out / 5xx) is skipped for a while and the next one is tried, up to 3 keys per photo, 20 s each. If all fail the photo goes to the review queue. The old single `OLLAMA_API_KEY` secret still works. The function logs which key position answered (never the key): `supabase functions logs verify-photo`.
Optional secrets: `OLLAMA_MODEL`, `PHOTO_APPROVE_AT` (0.8), `PHOTO_REVIEW_AT` (0.5). This function has never run against the real API: take a few real reference and test photos and watch what verdicts come back before the event. If it fails, photos fall into the organiser review queue (Photos tab), so the game still works.

## 4. Point the site at Supabase
Edit `js/config.js`:
```js
supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
supabaseAnonKey: 'YOUR-ANON-KEY',
allowSimulator: false,   // players must not get the walking simulator on event day
```
Keep `allowSimulator: true` only on a staging copy for rehearsals.

## 5. Vercel
Option A, from GitHub (recommended): push the repo, vercel.com > Add New > Project > import it. Framework preset **Other**, leave Build and Output blank (`vercel.json` already says no build), Deploy. Every push redeploys.
Option B, CLI: `npm i -g vercel`, then `vercel` in the repo folder, then `vercel --prod`.
After the first deploy you get `https://PROJECT.vercel.app`. Test sign-in there before touching a custom domain.

## 6. Custom domain
1. Buy or pick a domain (or a subdomain of one you already own, for example `quest.yourclub.org`).
2. Vercel > Project > Settings > Domains > Add. Vercel then shows the exact DNS records. Use those, not the ones below, if they differ:
   - Subdomain: CNAME `quest` pointing to the value Vercel shows (usually `cname.vercel-dns.com`).
   - Apex (`example.com`): an A record to the IP Vercel shows (historically `76.76.21.21`), plus `www` as a CNAME.
3. Wait for Vercel to show "Valid Configuration" (minutes to a few hours). HTTPS is issued automatically.
4. Then update, in this order: Supabase Site URL and Redirect URLs (step 1.8), Google "Authorised JavaScript origins" (step 2.4). The Google redirect URI stays on the Supabase address and does not change.
5. Test sign-in on the real domain from a phone on mobile data and on campus Wi-Fi.

## 6b. Your values (domain `kryptex.gdgocbpdc.tech`)
- DNS (at the `gdgocbpdc.tech` registrar or DNS host): add a **CNAME** record, name `kryptex`, value = what Vercel shows (usually `cname.vercel-dns.com`).
- Supabase > Auth > URL Configuration: Site URL `https://kryptex.gdgocbpdc.tech`; Redirect URLs `https://kryptex.gdgocbpdc.tech/**` and your `https://*.vercel.app/**` address while testing.
- Google Cloud > OAuth client: Authorised JavaScript origin `https://kryptex.gdgocbpdc.tech`; redirect URI `https://ojcpwpurpelxxluwrnus.supabase.co/auth/v1/callback`.
- Google Cloud > OAuth consent screen: Application home page `https://kryptex.gdgocbpdc.tech`, Privacy policy `https://kryptex.gdgocbpdc.tech/privacy/`, Terms of service `https://kryptex.gdgocbpdc.tech/terms/`, Authorised domain `gdgocbpdc.tech`.

## 7. Before event day
- Real flags in, sample flags gone (the sample ones are also visible in `js/data.js`, which only matters for demo mode).
- Real location pins surveyed on campus (the four current pins are provisional) and spaced more than 150 m apart.
- Console > Event: the readiness checklist shows no red items.
- `/admin/`: you can sign in, the Players report loads, the Live map shows a test player.
- Run a rehearsal with 5 to 10 real phones on campus: sign-in, GPS, a full location, a photo, hand-in, finish.
- Set the start time, or start by hand from the Event tab.

## 7b. Install gate (phones must install the app)
- On a phone browser tab the game shows a full-screen, non-closable "Install to play" panel (`js/install.js`, switched by `requireInstall` in `js/config.js`). Installed copies (home-screen icon) and desktop browsers are not gated.
- **Android (Chrome)**: one-tap "Install Kryptex Quest" button. **iPhone/iPad**: Apple provides no install button, so the panel shows Share > Add to Home Screen > Add. In-app browsers (Instagram, Facebook...) are told to open Safari/Chrome.
- Organisers can skip the gate in a browser tab with `https://kryptex.gdgocbpdc.tech/?noinstall=1` (kept for that tab's session). Players could find this too: it is a client-side gate, not a security boundary.
- **Test on real phones before the event**: Android Chrome install, iPhone Safari Add to Home Screen, then Google sign-in *inside the installed app* on both. iPhone installed apps keep their own storage (a browser sign-in does not carry over) and Google sign-in redirects inside installed apps are the most likely thing to misbehave. I could not test either here.
- If a player's phone cannot install (old browser), they are blocked by design: have an organiser phone or a spare device ready, or share the `?noinstall=1` link with them.

## 8. Load test
Database-level result (local Postgres 14, not Supabase, 500 players): about 170 calls/s averaged 5 ms with no errors, and a 3x spike held. Details in `CONTEXT.md`. That excludes Supabase's API layer, auth and the smaller free-tier CPU. To test the real thing, create a **throwaway Supabase project** with all migrations applied, then:
```
cd scripts && npm init -y && npm i @supabase/supabase-js
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... PLAYERS=500 SECONDS=120 node loadtest.mjs
```
It creates and deletes test users. Never run it against the live event project.

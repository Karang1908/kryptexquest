# Kryptex Quest context

## Product

Kryptex Quest is an in-person CTF hosted by Google Developer Groups on Campus at BITS Pilani Dubai Campus, Dubai International Academic City. It plays like Pokémon GO: players physically walk to campus stops, unlock a stop with the handoff flag from the previous stop, solve three puzzles there, then receive a clue and a handoff flag for the next stop. Some puzzles ask players to photograph a real object; a server should assess the photo and the player's location before accepting it. Kryptex is the GDG mascot (final mascot art is still to come).

## Current build (2026-10)

Mobile-first, dark theme with Google blue/red/yellow/green accents. No build step: ES modules served statically.

- `index.html`, `styles.css`, `js/*.js`. Run: `python3 -m http.server 4173`, open `http://localhost:4173`. Geolocation needs HTTPS on phones (localhost is exempt), so event day needs an HTTPS host.
- `js/world.js`: MapLibre map (OpenFreeMap **dark** style, fetched and rewritten at runtime: navy palette, extruded `fill-extrusion` buildings), pitch 62°, zoom 18. The player is always at the exact screen centre (`.player-stage`, an HTML `<model-viewer>` overlay); the world moves under them. The map camera `jumpTo`s the smoothed position every frame, so GPS fixes glide instead of teleporting. Walk/Run/Idle animation follows smoothed speed; facing follows movement heading and map rotation. Rotating the avatar is done via `camera-orbit` theta because model-viewer 4.3.1 throws from its `orientation` setter (verified).
- `js/geo.js`: `watchPosition` (high accuracy) with noise filtering, or a keyboard/on-screen-pad walking simulator behind the same interface. `distanceM`/`bearingDeg` helpers.
- `js/api.js`: one interface, two backends. **Supabase** when `js/config.js` has `supabaseUrl` + `supabaseAnonKey`; otherwise **local demo** (sample content in `js/data.js`, progress in localStorage, photo review simulated and labelled as such).
- `js/app.js`: auth gate, HUD, nearest-stop card with direction arrow, stop bottom sheet, location permission gate, menu.
- `js/login-art.js`: canvas background for the sign-in screen (the theme art is generated in code; there are no image assets besides the two GLBs).
- `supabase/migrations/0001_init.sql`: schema, RLS, the domain trigger, and the RPCs `my_progress`, `unlock_stop`, `submit_flag`, `record_photo_solve`. `supabase/seed.sql` holds the sample stops (generated from `js/data.js`). `supabase/functions/verify-photo/` is the photo edge function.

## Rules enforced

- Sign-in is Google OAuth via Supabase, restricted to `@dubai.bits-pilani.ac.in` three ways: Google's `hd` hint, a client check, and a `before insert` trigger on `auth.users` that rejects other emails (this is the one that actually enforces it).
- Flags, handoff flags and clues never reach the client in backend mode: `stop_secrets`/`puzzle_secrets` have RLS with no policies and no grants. Unlock/submit go through security-definer functions that check order (previous stop cleared), the stop's `radius_m` against the submitted lat/lng, and a rate limit (8 wrong attempts per minute).
- GPS from a browser can be spoofed. The server distance check is a speed bump, not anti-cheat. Photo + location together are the stronger signal once photo review is live.

## Verification status

- Verified in headless Chromium (mobile viewport): login → avatar pick → map; simulator walking changes position, animation (Walk) and facing; real geolocation (`setGeolocation`) moves the avatar and flips range; full demo flow unlock → 3 puzzles (incl. photo) → clue → next-stop unlock; location-denied gate; explore mode; desktop width.
- Verified against a scratch Postgres 14 with stubbed Supabase roles/`auth`: domain trigger, RLS/grants, order gating, distance gating, flag normalisation, rate limit, photo-solve only callable by service role.
- **Not verified**: a real Supabase project (OAuth round-trip, RPCs through PostgREST, `functions.invoke`), the `verify-photo` edge function (never deployed), real phone GPS/compass behaviour outdoors, iOS Safari.

## Setup for the Supabase backend

1. Create a project. Auth → Providers → Google: enable, add the OAuth client from Google Cloud (authorised redirect = the Supabase callback URL). Auth → URL configuration: add the deployed site URL and `http://localhost:4173` as redirect URLs.
2. SQL editor: run `supabase/migrations/0001_init.sql`, then your real content (copy `seed.sql` to the gitignored `supabase/seed.local.sql` and replace the sample flags/coordinates).
3. Put the project URL and anon key in `js/config.js` (the anon key is public by design).
4. `supabase functions deploy verify-photo`. It returns 501 until a reviewer is implemented in `judgePhoto`.
5. For the live event set `allowSimulator: false` in `js/config.js`.

## Asset sources

- Male Adventurer by Quaternius: https://poly.pizza/m/5EGWBMpuXq (CC0 per Poly Pizza). Female: https://poly.pizza/m/ZwF0K7WBmu. Both GLBs include Idle/Walk/Run/Wave/Interact clips.
- Campus identity and address: https://www.bits-pilani.ac.in/contact-us. Campus OSM feature: https://www.openstreetmap.org/way/224330161. OpenFreeMap: https://openfreemap.org/quick_start/ (public instance, no SLA).

## Open decisions

- Final stop list and **surveyed** coordinates and radii (current four are provisional examples: Main Lobby, Library, Academic Block, Campus Courtyard), real clues and flags, event sequence.
- Photo review: which reviewer, whether photos may go to a third party, retention, human fallback. Nothing is sent anywhere today.
- Team vs solo play, leaderboard, attempt limits beyond the per-minute cap, admin tooling.
- Hosting (needs HTTPS) and map-tile reliability on event day; consider a managed tile provider or self-hosting.
- Mascot art; custom campus 3D models (extrude surveyed footprints or model from campus-approved plans, do not infer from imagery).

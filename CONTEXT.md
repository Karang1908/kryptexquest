# Kryptex Quest context

## Product

Kryptex Quest is an in-person CTF hosted by Google Developer Groups on Campus at BITS Pilani Dubai Campus, Dubai International Academic City. It plays like Pokémon GO: players physically walk to campus stops, unlock a stop with the handoff flag from the previous stop, solve three puzzles there, then receive a clue and a handoff flag for the next stop. Some puzzles ask players to photograph a real object; a server should assess the photo and the player's location before accepting it. Kryptex is the GDG mascot (final mascot art is still to come).

## Current build (2026-10, updated with teams, third-person camera, organiser console)

Mobile-first, dark theme with Google blue/red/yellow/green accents. No build step: ES modules served statically.

- `index.html`, `styles.css`, `js/*.js`. Run: `python3 -m http.server 4173`, open `http://localhost:4173`. Geolocation needs HTTPS on phones (localhost is exempt), so event day needs an HTTPS host.
- `js/map-core.js`: map style/loader shared by the game and the organiser console (OpenFreeMap **dark** style rewritten at runtime: navy palette, extruded `fill-extrusion` buildings).
- The explorer stands low on the screen (feet 90 px above the "next signal" card, `FEET_GAP_PX` in `world.js`; falls back to 74% of the screen height when the card is hidden; done with MapLibre top padding, which the 3D layer's projection honours), like Pokémon GO, so more of the world ahead is visible. Camera pitch 64°.
- Camera controls: one-finger drag orbits around the explorer (yaw) and tilts, pinch/wheel zooms; the explorer stays the fixed point. The view stays where you leave it; the reset button brings it back behind him (no auto-recentre). The explorer is drawn 4.2x life size (about 7 m), beacons are real-scale.
- Location needs HTTPS on phones (plain `http://` gets no permission prompt at all); the app detects this and says so. The location request starts immediately at game start so the browser's own prompt appears.
- Location pipeline (`geo.js`, `filter.js`, `motion.js`): raw `watchPosition` fixes (high accuracy, no cache, ~1 Hz, plus one quick coarse fix for a fast first position) go through a Kalman filter (position + velocity, weighted by each fix's accuracy, wild fixes down-weighted, re-init if the position keeps disagreeing). The filter is predicted forward at 10 Hz between fixes and steered by an accelerometer step detector (walking: velocity toward cadence speed; standing still: zero-velocity update), so starting/stopping registers within a step or two instead of 3-10 s. The watch is restarted if no fix arrives for 12 s. The world follows the 10 Hz stream with ~0.12 s smoothing. The server gets the filtered position every 5 s (console polls every 3 s). Simulated-walker results (Node, `filter.js`): RMS error 14 m raw -> 5.6 m filtered -> 1.8 m with steps at GPS sigma 8 m with 5% wild fixes; time to register a stop 10 s -> 1.7 s. Real-phone behaviour (pocket carry, step threshold, iOS motion permission) is untested.
- `js/compass.js`: phone compass/gyro (`deviceorientationabsolute` on Android; `webkitCompassHeading` on iOS, which needs a tap to grant permission, hence the "Tap to enable compass" chip). The explorer faces where the phone points and the camera follows that heading; with no sensor it falls back to the walking direction. Simulator: Q/E turn. Walking animation and a short glide continue between sparse GPS fixes (3.5 s after the last >1 m movement).
- `js/world.js` + `js/scene3d.js`: Pokémon GO-style camera and scene. The map is **not draggable** (the player inspects their own 3D explorer, not the map). Camera: pitch 66°, zoom 18.6, vertical FOV 58°, night sky and horizon fog (`style.sky`), the explorer at the exact screen centre, and the map rotating so the explorer walks "up" the screen (smoothed, only while moving). The compass button locks north-up, where the explorer turns instead. The explorer and the quest beacons are **three.js objects rendered inside MapLibre's GL context as a custom layer** (`scene3d.js`, three r160 via an import map in `index.html`), so they share the map's perspective, depth buffer and camera. The explorer is drawn ~15x life size (as in Pokémon GO), lit from behind-above the camera, with a stencil-guarded planar shadow, a ground ring, and idle/walk/run clips cross-faded by smoothed speed. Beacons are glowing pillars with a floating rotating cube and a ground disc showing the stop's real interaction radius, coloured by state (locked grey, open blue, in range yellow, cleared green). Beacons fade out as the explorer walks into them so they never hide the character. Labels are DOM chips projected from the same camera matrix each frame; tapping a label or a cube (screen-space pick) opens the stop. Avatar models are normalised to height from the GLB's bounding box.
- `js/geo.js`: `watchPosition` (high accuracy) with noise filtering, or a keyboard/on-screen-pad walking simulator behind the same interface. `distanceM`/`bearingDeg` helpers.
- `js/api.js`: one interface, two backends. **Supabase** when `js/config.js` has `supabaseUrl` + `supabaseAnonKey`; otherwise **local demo** (sample content in `js/data.js`, progress in localStorage, photo review simulated and labelled as such).
- `js/app.js`: auth gate, team screen (create / join by code / lock), HUD, nearest-stop card with direction arrow, stop bottom sheet, location permission gate, menu.
- `js/demo-admin.js`: invented teams/players so the console can be explored without a backend.
- `js/login-art.js`: canvas background for the sign-in screen (the theme art is generated in code; there are no image assets besides the two GLBs).
- `supabase/migrations/0001_init.sql` (content tables, domain trigger) and `0002_teams_admin.sql` (teams, per-team progress, events log, live locations, admins, all RPCs; **0002 drops 0001's per-user progress tables**), `0003` (content admin + photos), `0004` (game flow v2: base, entry modes, event control, leaderboard, admin tools), `0005` (bonus as a question, finish = all codes handed in), `0007` (remote solving after unlock), `0006` (hidden locations, server-side discovery, entry flag typed at the location; replaces 0005's walk-in unlock). `supabase/seed.sql` holds the sample stops (generated from `js/data.js`). `supabase/functions/verify-photo/` is the photo edge function.

## Game flow (decided by the organisers; migrations 0004-0010)

**Locations are hidden.** The map shows only the base (red) until a team *discovers* a location by walking into its radius; the phone then says "📍 Location discovered" (every time a team finds one, even if it already has the hint). A discovered location stays on that team's map: **grey = discovered but locked, blue = unlocked and being solved, green = cleared**. The server does the discovering (the phone does not know where hidden locations are): every location ping (about every 4 s) is checked against the stops, and `my_progress()` omits the name, position and description of undiscovered locations.

1. **Base (hub)** = the vending machine area. Teams check in there (clock starts). The base lists all N locations, but each one's **hint and entry question** appear only once *released*: the first after check-in, each next one after the **previous location's code is handed in at the base**.
2. **Unlocking** a discovered location = typing its **entry flag** there. The flag is the answer to the entry question shown at the base (or the flag itself is shown there if no question is set; with no entry flag at all, discovery unlocks it). Locations unlock **in sequence**: a location found out of order stays grey, with the message to hand in the previous code at the base first.
3. **Inside a location** (migrations 0007, 0009): once unlocked, a location's questions can be answered **from anywhere**, and any discovered location can be opened from the menu. Presence is only needed to discover, unlock, check in and hand in at the base. 2-3 questions, **all shown at once**. A question is a **title, a link to the real question page (hosted anywhere: CTF platform, a form, own page), and the answer flag**: the game never shows the question text itself; the player opens the link, solves it there and types the flag here. A *photo question* shows only a clue ("Photo clue 1") until the player photographs the object and it is verified; then its title and link appear. A *plain question* shows its title, optional note and link straight away. The link of a photo question is hidden server-side until the photo is cleared.
4. **Clearing a location** reveals its **code** (and a next clue) in the location's menu.
5. **Hand the code in at the base**: it releases the next location's hint and entry question. **When every code is handed in the quest is finished** (the clock stops): finish screen + an **extra bonus question** (role `bonus`; needs no location; does not affect finish time). The leaderboard ranks by finish time, then flags, and marks teams that also answered the bonus.

`entry_mode`: `chain` (released after the previous code is handed in) or `open` (released right after check-in). The earlier "answer a question at the base to unlock" mode is gone: that question is now just the entry question, answered anywhere.

### Managing the location-chaining problem
A pure chain makes every team walk the same order (queues at objects) and one blocked location stalls everyone. The levers, all in the console:
- Per-location **release mode**: mix sequential locations (released after the previous code is handed in) with `open` ones (released after check-in), so teams can be spread out or a broken link bypassed without touching code.
- **Bypass** (Teams tab): unlock a location and mark its questions solved for one team when it is blocked (event on site, locked door, broken object).
- **Headcount** per location on the Live map, so you can see queues forming.
- Locations stay unlocked once opened, so teams can return, and handing in flags at the base is order-independent.
Not built (ruled out by the organisers): different routes per team, in-app hints (hints are given in person), cheat detection.

### Event operations
Event tab: start / pause / end (plus optional scheduled start and hard end), broadcast banners to everyone or one team, quest-area circle and no-go zones (players get a warning banner and buzz), help requests with location, standings, public big-screen board (`/board/`, off until switched on), CSV export (results, full log), and deletion of stored locations/photos after the event. Teams tab: **open a location for a team** (unlock it without solving anything), lock/unlock, rename, check in, clear finish, reset progress, disband, remove or move a player, bypass a location, mark a question solved/revoke it, count a flag as handed in. Content tab: add/edit/reorder/delete the base, locations, bonus and questions (clue, photo question, answer), reference photos, per-question stats (solved by, average time, wrong guesses, photo misses), and printable QR codes.

### Event tools added in migration 0008
- **Teammate dots**: the 4 s location ping also returns teammates' latest positions (last 2 min) and the map shows a dot + name for each. Teammates solving a question already toast on the other phones.
- **Organiser alerts** (bar under the console header, any tab): a team with no activity for 10+ minutes while the quest runs, or 5+ wrong answers to one question within 15 minutes. Each alert has "Send hint" (a one-team broadcast; also a button in the team detail) and "Open team". Flagged teams get a warning mark in the Teams list. Test teams are never flagged.
- **Rehearsal run**: a signed-in organiser (not in a team) can start a one-person locked **test team** from the team screen or the menu. It ignores the event clock (works while the quest is in lobby), plays the real database rules with the real content and the walking simulator, never appears on the leaderboard/board/standings/live counts, and "End rehearsal" deletes everything it produced. Needs the Supabase backend (demo mode is already a rehearsal).
- **Readiness checklist** (Event tab): flags missing questions, flags or codes, entry question without entry flag, photo questions with fewer than 3 reference photos (warning below 8), still-sample coordinates/flags, duplicate flags, locations too close together, no quest area, and QR codes not ticked as printed (tick state is kept in the organiser's browser).
- **Offline tolerance**: an OFFLINE badge appears when the phone cannot reach the server; flag answers typed meanwhile are stored on the phone and sent automatically on reconnect (positions, unlocks, hand-ins and photos are not queued: they need the player to be there right now).
- **Team recap**: after the finish, "Our recap & share card" shows total time, rank among finished teams, time per location, wrong answers, fastest solve and per-player flags, and can save/share a PNG card drawn on a canvas.

### Rules changed in the last round (migration 0010)
- **Teams of 1 to 4**: solo play is allowed (`lock_team` needs 1 player).
- **No bonus question**: the bonus role is no longer offered or shown; finishing = every code handed in, and a **Finished!** screen shows time, rank and flags (plus the recap card).
- **The base shows one hint at a time**: only the next location's hint and entry question, then the locations the team has found, then the hand-in slot. Future locations are not listed.
- **Location gems in the HUD**: one hex gem per location, tappable from anywhere once discovered (grey locked, purple open, green cleared).
- **Players report** (console, Teams > Players): every player with questions solved, wrong guesses, unlocks and last seen; click a header or use the sort menu; CSV export. Backed by `admin_players()`.

### Rules added after migration 0010 (0011 to 0013)
- **Unlock question** (0011, 0013): title, optional link and optional images (public `question-images` bucket, up to 6) per location, set in the console under "Unlock it: the question". Shown at the base once the location is released.
- **Surprise question** (0012): console Event tab, "Surprise question". Dropping one announces it on every phone and puts it at the top of the base sheet; each team answers once. Not part of finishing or the leaderboard. Input is enabled only when standing at the base (UI rule; the server does not check position).
- **Questions in a location are sequential** (0013 `question_locked`): later ones show only their number and "Locked"; `submit_flag` and `record_photo_clear` refuse skipping ahead. Mirrored in `js/demo-engine.js`.
- Camera starts closer (zoom 20.6) with a wider field of view (70).

### Deployment and load (2026-10-06)
- `DEPLOY.md` has the Supabase, Google sign-in, Vercel and domain steps. `vercel.json` and `.vercelignore` are in place. Nothing is deployed yet; `js/config.js` still has empty Supabase settings and `allowSimulator: true` (set false for the event).
- **Database-level load test** (scratch Postgres 14 on an Apple Silicon Mac, 500 players in 125 locked teams, two locations unlocked each; `pgbench` calling `my_progress()` about every 7 s and `update_my_location()` every 5 s per player = about 170 calls/s): average 5 ms per call (my_progress 7.6 ms, location 3.2 ms), no errors. Raw ceiling about 1,450 calls/s with 30 clients; a 3x spike (510 calls/s) held at about 520 calls/s. **This is the database only**: it excludes Supabase's API layer, auth checks, network and the free tier's smaller CPU, so the real numbers will be worse. The real test is `scripts/loadtest.mjs` against a throwaway Supabase project (untested).

### Image and flag questions (migrations 0014, 0015)
- Two separate question types, chosen when adding a question in the console: **Image question** (players photograph an object; the AI check, or an organiser, solves it; no flag or link) and **Flag question** (link to the real question page + answer flag).
- A location's **unlock question** is also either type. Image unlock: clue + reference photos (`entry_photo_refs`); the team photographs it at the location and the AI unlocks it. The `verify-photo` function uses photo idx `-1` for unlock photos and asks `unlock_photo_gate` (released, started, in range) before spending an AI call.
- The base editor lists every location's hint in one panel ("Hints shown at the base"); each hint is also on its location.
- 0015 locks the public anon key out of every function except `public_leaderboard`. Live project: 0014 and 0015 applied and `verify-photo` redeployed on 2026-10-06.

### Console layout (revamp)
Navbar: Live · Teams · Locations · Photos · Event, plus a status lamp for the event clock and sign-out. Activity log lives inside Teams (Teams | Activity). Live has the map with floating stats and a move bar for relocating a location (click a pin); Locations is a sectioned editor (Basics, Where, How teams find and unlock it, Questions; More options folded); Event folds Safety and Exports.

### Visual system
"Night Quest" (see `DESIGN.md`): a chunky mobile-game UI in purple with white star dots; ink-outlined candy keys, studded panels, hex medals, ribbons, treasure chest rewards, Lilita One + Google Sans, game-icons.net glyphs, sounds, GDG logos. Tokens in `theme.css`; credits in `assets/CREDITS.md`.

### Indoor GPS
At a stop, "in range" means within its radius plus the phone's own accuracy (capped at 25 m), **or** having scanned the stop's printed QR in the last 15 minutes. The QR encodes `<site>/?qr=<stop>.<token>`; scanning with the phone camera opens the game and calls `scan_qr`. Print them from Console -> Content.

## Teams

2-4 players, no solo. One player creates a team (gets a 6-character code), others enter it, the leader locks it in (needs >= 2). A locked team cannot be joined or left. Progress (unlocks, solves, clues) is **shared by the team**; every solve records which member did it (`solves.user_id`) for the contribution view. The game polls `my_progress` every 4 s, so teammates' solves appear and a toast names who solved what. Gameplay RPCs refuse until the team is locked.

## Organiser console (not linked from the game)

`/admin/` (`admin/index.html`, `admin.js`, `admin.css`). Nothing in the player UI links to it. It is `noindex`. Access: Google sign-in + the email must exist in `public.admins` (add with SQL: `insert into public.admins (email) values ('you@dubai.bits-pilani.ac.in')`, lowercase). Anyone else, signed in or not, sees a plain "Not Found" page (signed-out visitors see a bare "Sign in" button). Authorization is enforced by the database (`is_admin()` in RLS + every `admin_*` RPC), not by hiding the page.

- **Live map**: same map as players; stop pins; one coin per player with their name and team (stale after 90 s turns grey); top counters (players online / registered, teams / locked, flags solved). Select a stop, click "Move on map", click the spot, adjust radius/name, Save. Edits write `stops` and are logged as `stop_moved` events.
- **Teams**: every team with progress pips, stops cleared, last activity; detail shows per-player contribution (flags, unlocks, wrong guesses, last seen), every flag by stop with who solved it and when, and a team timeline.
- **Activity log**: every team/unlock/flag/photo event with player, stop, result, distance from the stop at the time, and the guessed text for wrong flags; filter by event, team, free text; live refresh.
- Players report their latest position every ~10 s (`update_my_location`, one row per player, no trail). The player UI tells them organisers can see their live location.

## Organiser content management (Content tab)

Organisers create, edit, reorder and delete locations; add/edit/delete flag questions and photo questions with their answers; and upload reference photos. Backed by `0003_content_photos.sql` (`admin_content`, `admin_save_stop`, `admin_delete_stop`, `admin_reorder_stops`, `admin_save_puzzle`, `admin_delete_puzzle`; every change is written to the events log as `content`). Position is set via "Place on the map…" (jumps to the Live map, click the spot, Save). A location's **handoff flag** is the password of the next location in the order. Deleting a location or question removes teams' progress on it. In demo mode the same screens edit a copy of the sample content in localStorage, which the game then plays.

## Photo verification (decided: Ollama Cloud, Gemma)

The organisers decided (2026-10) to send player photos to Ollama Cloud. Flow in `supabase/functions/verify-photo` (needs `OLLAMA_API_KEY`; optional `OLLAMA_MODEL` default `gemma4:31b`, `OLLAMA_URL` default `https://ollama.com/api/chat`, `PHOTO_APPROVE_AT` 0.8, `PHOTO_REVIEW_AT` 0.5):
1. Auth, locked team, GPS within the stop's radius (server-side), at most 6 photos per team per question per 10 min, and a SHA-256 check that rejects a photo already submitted by another team.
2. Picks up to 4 random reference photos (of the ~10 uploaded) and sends them plus the player's photo in one `/api/chat` call with a JSON-schema answer `{same_object, confidence, reason}`. Temperature 0. The prompt asks only whether the last image shows the same object in the same place, and tells the model to say no for screens, prints, or a different object of the same kind.
3. `confidence >= 0.8` and same: solved. `0.5-0.8`, contradictory, or the model call failed: saved as **pending** for an organiser (Photos tab: player photo beside references, model reason, Approve/Reject). Below 0.5: rejected.
4. Every photo + verdict is stored in the private `submissions` bucket and `photo_submissions` (retention is an open decision).
`judge.ts` (prompt, JSON parsing, thresholds, reference sampling) is pure and unit-tested with plain Node (`node --experimental-strip-types`). The Ollama call, storage, and the function as a whole have **not** been run against real services.

## Rules enforced

- Sign-in is Google OAuth via Supabase, restricted to `@dubai.bits-pilani.ac.in` three ways: Google's `hd` hint, a client check, and a `before insert` trigger on `auth.users` that rejects other emails (this is the one that actually enforces it).
- Flags, handoff flags and clues never reach the client in backend mode: `stop_secrets`/`puzzle_secrets` have RLS with no policies and no grants. Unlock/submit go through security-definer functions that check order (previous stop cleared), the stop's `radius_m` against the submitted lat/lng, and a rate limit (8 wrong attempts per minute).
- GPS from a browser can be spoofed. The server distance check is a speed bump, not anti-cheat. Photo + location together are the stronger signal once photo review is live.

## Verification status

- Verified in headless Chromium: 3D-in-map explorer with shadow, horizon and beacons, walk/turn/run via the simulator, real-geolocation tap on a beacon label and on the canvas, team create / join / demo teammate / lock, full quest flow with a shared team, moved-stop propagation from console to game (demo storage), console tabs, relocate + save, admin gating (no session / player session / admin session against a mocked Supabase). Earlier (mobile viewport): login → avatar pick → map; simulator walking changes position, animation (Walk) and facing; real geolocation (`setGeolocation`) moves the avatar and flips range; full demo flow unlock → 3 puzzles (incl. photo) → clue → next-stop unlock; location-denied gate; explore mode; desktop width.
- Game flow v2 (0004) verified against a scratch Postgres 14: check-in gating, hub-mode and chain entry, photo-then-question gating, accuracy tolerance, QR presence, hand-in and bonus reveal, finish and ranking, pause/lobby/ended refusals, broadcast, help requests, admin team actions, anonymous board gating; the same rules in `js/demo-engine.js` pass a Node test; the full player path (check-in -> base question -> photo -> question -> chain -> QR -> hand-in -> bonus -> finish) passes in headless Chromium in demo mode. Earlier: scratch Postgres 14 with stubbed Supabase roles/`auth` (0001 then 0002): domain trigger, grants, team create/join/lock rules (duplicate name, lowercase code, double join, locked team, solo lock), shared progress with attribution, distance and order gating, rate limit, photo-solve only for service role, admin RPCs forbidden for players, non-admin stop update ineffective, stop-move audit event.
- Migration 0008 (teammates, rehearsal, alerts, recap) verified on the scratch Postgres 14 (lobby-time rehearsal, board/live exclusion, cleanup, alerts, recap); teammate dots, queued-answer flush, recap + share PNG and the admin alert bar/readiness panel verified in headless Chromium (demo mode). The real offline failure path (`Failed to fetch` from supabase-js) has not been exercised.
- **Not verified**: scale (see `scripts/loadtest.mjs`, written but never run), the 4-player cap and kick/leave-with-leader-handover paths (written, not exercised), concurrency, many players at once on the console, and a real Supabase project (OAuth round-trip, RPCs through PostgREST, `functions.invoke`), the `verify-photo` edge function (never deployed), real phone GPS/compass behaviour outdoors, iOS Safari.

## Setup for the Supabase backend

1. Create a project. Auth → Providers → Google: enable, add the OAuth client from Google Cloud (authorised redirect = the Supabase callback URL). Auth → URL configuration: add the deployed site URL and `http://localhost:4173` as redirect URLs.
2. SQL editor: run `0001_init.sql`, `0002_teams_admin.sql`, `0003_content_photos.sql`, `0004_game_flow.sql`, `0005_arrival_unlock.sql`, `0006_discovery.sql` in order, then add yourself as an admin (see above), then your real content (copy `seed.sql` to the gitignored `supabase/seed.local.sql` and replace the sample flags/coordinates).
3. Put the project URL and anon key in `js/config.js` (the anon key is public by design).
4. Run `0003_content_photos.sql` too (creates the private buckets `puzzle-refs` and `submissions`). Then `supabase secrets set OLLAMA_API_KEY=...` and `supabase functions deploy verify-photo`. Without the key it answers 501.
   Upload ~10 reference photos per photo question in Console -> Content before the event.
5. For the live event set `allowSimulator: false` in `js/config.js`.

## Asset sources

- Male Adventurer by Quaternius: https://poly.pizza/m/5EGWBMpuXq (CC0 per Poly Pizza). Female: https://poly.pizza/m/ZwF0K7WBmu. Both GLBs include Idle/Walk/Run/Wave/Interact clips.
- Campus identity and address: https://www.bits-pilani.ac.in/contact-us. Campus OSM feature: https://www.openstreetmap.org/way/224330161. OpenFreeMap: https://openfreemap.org/quick_start/ (public instance, no SLA).

## Open decisions

- Final stop list and **surveyed** coordinates and radii (current four are provisional examples: Main Lobby, Library, Academic Block, Campus Courtyard), real clues and flags, event sequence.
- Photo retention and deletion after the event; tuning the 0.8 / 0.5 thresholds on real campus photos (test with real reference sets before the event).
- Leaderboard / public scoreboard, attempt limits beyond the per-minute cap, whether organisers can add or remove stops (today they can only edit location, radius, names), retention/deletion of the events and location data after the event.
- Hosting (needs HTTPS) and map-tile reliability on event day; consider a managed tile provider or self-hosting.
- Mascot art; custom campus 3D models (extrude surveyed footprints or model from campus-approved plans, do not infer from imagery).

# Kryptex Quest context

## Product

Kryptex Quest is an in-person CTF hosted by Google Developer Groups on Campus at BITS Pilani Dubai Campus, Dubai International Academic City. It plays like Pokémon GO: players physically walk to campus stops, unlock a stop with the handoff flag from the previous stop, solve three puzzles there, then receive a clue and a handoff flag for the next stop. Some puzzles ask players to photograph a real object; a server should assess the photo and the player's location before accepting it. Kryptex is the GDG mascot (final mascot art is still to come).

## Current build (2026-10, updated with teams, third-person camera, organiser console)

Mobile-first, dark theme with Google blue/red/yellow/green accents. No build step: ES modules served statically.

- `index.html`, `styles.css`, `js/*.js`. Run: `python3 -m http.server 4173`, open `http://localhost:4173`. Geolocation needs HTTPS on phones (localhost is exempt), so event day needs an HTTPS host.
- `js/map-core.js`: map style/loader shared by the game and the organiser console (OpenFreeMap **dark** style rewritten at runtime: navy palette, extruded `fill-extrusion` buildings).
- The explorer stands in the lower third of the screen (`PLAYER_Y = 0.66` in `world.js`, done with MapLibre top padding, which the 3D layer's projection honours), like Pokémon GO, so more of the world ahead is visible. Camera pitch 64°.
- Camera controls: one-finger drag orbits around the explorer (yaw) and tilts, pinch/wheel zooms; the explorer stays the fixed point. The view eases back behind him after 12 s, or via the reset button. The explorer is drawn 4.2x life size (about 7 m), beacons are real-scale.
- Location needs HTTPS on phones (plain `http://` gets no permission prompt at all); the app detects this and says so. The location request starts immediately at game start so the browser's own prompt appears.
- `js/compass.js`: phone compass/gyro (`deviceorientationabsolute` on Android; `webkitCompassHeading` on iOS, which needs a tap to grant permission, hence the "Tap to enable compass" chip). The explorer faces where the phone points and the camera follows that heading; with no sensor it falls back to the walking direction. Simulator: Q/E turn. Walking animation and a short glide continue between sparse GPS fixes (3.5 s after the last >1 m movement).
- `js/world.js` + `js/scene3d.js`: Pokémon GO-style camera and scene. The map is **not draggable** (the player inspects their own 3D explorer, not the map). Camera: pitch 66°, zoom 18.6, vertical FOV 58°, night sky and horizon fog (`style.sky`), the explorer at the exact screen centre, and the map rotating so the explorer walks "up" the screen (smoothed, only while moving). The compass button locks north-up, where the explorer turns instead. The explorer and the quest beacons are **three.js objects rendered inside MapLibre's GL context as a custom layer** (`scene3d.js`, three r160 via an import map in `index.html`), so they share the map's perspective, depth buffer and camera. The explorer is drawn ~15x life size (as in Pokémon GO), lit from behind-above the camera, with a stencil-guarded planar shadow, a ground ring, and idle/walk/run clips cross-faded by smoothed speed. Beacons are glowing pillars with a floating rotating cube and a ground disc showing the stop's real interaction radius, coloured by state (locked grey, open blue, in range yellow, cleared green). Beacons fade out as the explorer walks into them so they never hide the character. Labels are DOM chips projected from the same camera matrix each frame; tapping a label or a cube (screen-space pick) opens the stop. Avatar models are normalised to height from the GLB's bounding box.
- `js/geo.js`: `watchPosition` (high accuracy) with noise filtering, or a keyboard/on-screen-pad walking simulator behind the same interface. `distanceM`/`bearingDeg` helpers.
- `js/api.js`: one interface, two backends. **Supabase** when `js/config.js` has `supabaseUrl` + `supabaseAnonKey`; otherwise **local demo** (sample content in `js/data.js`, progress in localStorage, photo review simulated and labelled as such).
- `js/app.js`: auth gate, team screen (create / join by code / lock), HUD, nearest-stop card with direction arrow, stop bottom sheet, location permission gate, menu.
- `js/demo-admin.js`: invented teams/players so the console can be explored without a backend.
- `js/login-art.js`: canvas background for the sign-in screen (the theme art is generated in code; there are no image assets besides the two GLBs).
- `supabase/migrations/0001_init.sql` (content tables, domain trigger) and `0002_teams_admin.sql` (teams, per-team progress, events log, live locations, admins, all RPCs; **0002 drops 0001's per-user progress tables**). `supabase/seed.sql` holds the sample stops (generated from `js/data.js`). `supabase/functions/verify-photo/` is the photo edge function.

## Teams

2-4 players, no solo. One player creates a team (gets a 6-character code), others enter it, the leader locks it in (needs >= 2). A locked team cannot be joined or left. Progress (unlocks, solves, clues) is **shared by the team**; every solve records which member did it (`solves.user_id`) for the contribution view. The game polls `my_progress` every 4 s, so teammates' solves appear and a toast names who solved what. Gameplay RPCs refuse until the team is locked.

## Organiser console (not linked from the game)

`/admin/` (`admin/index.html`, `admin.js`, `admin.css`). Nothing in the player UI links to it. It is `noindex`. Access: Google sign-in + the email must exist in `public.admins` (add with SQL: `insert into public.admins (email) values ('you@dubai.bits-pilani.ac.in')`, lowercase). Anyone else, signed in or not, sees a plain "Not Found" page (signed-out visitors see a bare "Sign in" button). Authorization is enforced by the database (`is_admin()` in RLS + every `admin_*` RPC), not by hiding the page.

- **Live map**: same map as players; stop pins; one coin per player with their name and team (stale after 90 s turns grey); top counters (players online / registered, teams / locked, flags solved). Select a stop, click "Move on map", click the spot, adjust radius/name, Save. Edits write `stops` and are logged as `stop_moved` events.
- **Teams**: every team with progress pips, stops cleared, last activity; detail shows per-player contribution (flags, unlocks, wrong guesses, last seen), every flag by stop with who solved it and when, and a team timeline.
- **Activity log**: every team/unlock/flag/photo event with player, stop, result, distance from the stop at the time, and the guessed text for wrong flags; filter by event, team, free text; live refresh.
- Players report their latest position every ~10 s (`update_my_location`, one row per player, no trail). The player UI tells them organisers can see their live location.

## Rules enforced

- Sign-in is Google OAuth via Supabase, restricted to `@dubai.bits-pilani.ac.in` three ways: Google's `hd` hint, a client check, and a `before insert` trigger on `auth.users` that rejects other emails (this is the one that actually enforces it).
- Flags, handoff flags and clues never reach the client in backend mode: `stop_secrets`/`puzzle_secrets` have RLS with no policies and no grants. Unlock/submit go through security-definer functions that check order (previous stop cleared), the stop's `radius_m` against the submitted lat/lng, and a rate limit (8 wrong attempts per minute).
- GPS from a browser can be spoofed. The server distance check is a speed bump, not anti-cheat. Photo + location together are the stronger signal once photo review is live.

## Verification status

- Verified in headless Chromium: 3D-in-map explorer with shadow, horizon and beacons, walk/turn/run via the simulator, real-geolocation tap on a beacon label and on the canvas, team create / join / demo teammate / lock, full quest flow with a shared team, moved-stop propagation from console to game (demo storage), console tabs, relocate + save, admin gating (no session / player session / admin session against a mocked Supabase). Earlier (mobile viewport): login → avatar pick → map; simulator walking changes position, animation (Walk) and facing; real geolocation (`setGeolocation`) moves the avatar and flips range; full demo flow unlock → 3 puzzles (incl. photo) → clue → next-stop unlock; location-denied gate; explore mode; desktop width.
- Verified against a scratch Postgres 14 with stubbed Supabase roles/`auth` (0001 then 0002): domain trigger, grants, team create/join/lock rules (duplicate name, lowercase code, double join, locked team, solo lock), shared progress with attribution, distance and order gating, rate limit, photo-solve only for service role, admin RPCs forbidden for players, non-admin stop update ineffective, stop-move audit event.
- **Not verified**: the 4-player cap and kick/leave-with-leader-handover paths (written, not exercised), concurrency, many players at once on the console, and a real Supabase project (OAuth round-trip, RPCs through PostgREST, `functions.invoke`), the `verify-photo` edge function (never deployed), real phone GPS/compass behaviour outdoors, iOS Safari.

## Setup for the Supabase backend

1. Create a project. Auth → Providers → Google: enable, add the OAuth client from Google Cloud (authorised redirect = the Supabase callback URL). Auth → URL configuration: add the deployed site URL and `http://localhost:4173` as redirect URLs.
2. SQL editor: run `0001_init.sql`, then `0002_teams_admin.sql`, then add yourself as an admin (see above), then your real content (copy `seed.sql` to the gitignored `supabase/seed.local.sql` and replace the sample flags/coordinates).
3. Put the project URL and anon key in `js/config.js` (the anon key is public by design).
4. `supabase functions deploy verify-photo`. It returns 501 until a reviewer is implemented in `judgePhoto`.
5. For the live event set `allowSimulator: false` in `js/config.js`.

## Asset sources

- Male Adventurer by Quaternius: https://poly.pizza/m/5EGWBMpuXq (CC0 per Poly Pizza). Female: https://poly.pizza/m/ZwF0K7WBmu. Both GLBs include Idle/Walk/Run/Wave/Interact clips.
- Campus identity and address: https://www.bits-pilani.ac.in/contact-us. Campus OSM feature: https://www.openstreetmap.org/way/224330161. OpenFreeMap: https://openfreemap.org/quick_start/ (public instance, no SLA).

## Open decisions

- Final stop list and **surveyed** coordinates and radii (current four are provisional examples: Main Lobby, Library, Academic Block, Campus Courtyard), real clues and flags, event sequence.
- Photo review: which reviewer, whether photos may go to a third party, retention, human fallback. Nothing is sent anywhere today.
- Leaderboard / public scoreboard, attempt limits beyond the per-minute cap, whether organisers can add or remove stops (today they can only edit location, radius, names), retention/deletion of the events and location data after the event.
- Hosting (needs HTTPS) and map-tile reliability on event day; consider a managed tile provider or self-hosting.
- Mascot art; custom campus 3D models (extrude surveyed footprints or model from campus-approved plans, do not infer from imagery).

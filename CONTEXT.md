# Kryptex Quest context

## Product

Kryptex Quest is an in-person CTF hosted by Google Developer Groups on Campus at BITS Pilani Dubai Campus, Dubai International Academic City. Players travel to campus locations, unlock each stop with a flag from the previous stop, solve three puzzles at that stop, then receive a clue and a handoff flag for the next location. Some puzzles ask players to photograph a real object. A future backend should assess the image and the player location before issuing or accepting a flag.

## Current prototype

- Mobile-first web UI in `index.html`, `styles.css`, and `app.js`. Run with `python3 -m http.server 4173` and open `http://localhost:4173`.
- Live campus map uses MapLibre GL JS and OpenFreeMap vector tiles. It centers at latitude `25.13133`, longitude `55.41898`, from the OpenStreetMap BITS Pilani Dubai campus feature. A clearly labeled illustrated preview appears when remote map assets do not load.
- Four **sample** stops: Main Lobby, Library, Academic Block, Campus Courtyard. Their exact marker coordinates are **provisional**, not surveyed. Sample flags and questions are embedded client-side for UI demonstration only.
- The unlock → three flags → next clue flow is interactive and persists progress in local storage. One sample photo question per stop accepts an image and has an explicitly simulated approval step. No image or GPS data is uploaded.
- A stop can unlock only after all three puzzles at the previous stop are cleared. Preview hint buttons reveal sample flags after that condition is met.
- GPS location is opt-in. Preview mode starts enabled so the interface can be explored off campus. The optional GPS distance gate is a client-side demonstration only, using a 60 m radius.
- The two requested Poly Pizza GLBs are bundled in `assets/`. The avatar selector and map explorer overlay render them with `<model-viewer>`; CSS portraits remain as loading fallbacks. The model-viewer script loads remotely.

## Asset sources

- Male Adventurer by Quaternius: https://poly.pizza/m/5EGWBMpuXq — Poly Pizza page lists CC0.
- Female Adventurer by Quaternius: https://poly.pizza/m/ZwF0K7WBmu — Poly Pizza page lists CC0.
- Campus identity and address: https://www.bits-pilani.ac.in/contact-us
- Campus OSM feature: https://www.openstreetmap.org/way/224330161
- OpenFreeMap setup and attribution: https://openfreemap.org/quick_start/

## Proposed campus-map approach

1. Use OSM/OpenFreeMap as the real geographic base and place quest markers using surveyed latitude/longitude. This is what the prototype starts with.
2. Walk the campus and collect exact entrance coordinates, safe walking paths, building names, and photos. Add a small campus GeoJSON layer for accurate paths/building footprints where the public map is incomplete. Confirm that any base geometry can be used under its source license.
3. For a Pokémon GO-style visual, draw custom low-poly building meshes or extrude surveyed footprints in MapLibre. A faithful 3D campus cannot be inferred safely from a place name or from unrelated map imagery. Model it from campus-approved plans, photos, or a manual survey.
4. The two local GLB avatars currently render in HTML overlays. If a later version places the avatar inside the map scene, use a WebGL layer while keeping quest interactions and labels in normal HTML for accessibility and performance.

## Production decisions still needed

- Final stop list, exact playable coordinates, safe/publicly accessible areas, event sequence, real clues, real flags, and Kryptex mascot art.
- Backend contract for registration, team/solo play, challenge content, flag validation, attempt limits, image upload and retention, AI review, human review fallback, and leaderboard.
- Server-side validation of GPS and flag state. Client-side checks in the prototype are intentionally not an anti-cheat mechanism.
- Deployment host and map tile reliability needs. OpenFreeMap public instance has no SLA; consider a managed provider or self-hosting for event day.

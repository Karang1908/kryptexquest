# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Plain static HTML/CSS/ES modules, no build step. Supabase (Postgres RPCs, Auth with Google, Storage, one Edge Function) is the backend; a localStorage demo backend mirrors the rules. Hosting is static; the choice of host was delegated (recommendation: a static CDN host rather than a container host).

## Users
- **Players**: BITS Pilani Dubai Campus students (sign in with the college Google account), in teams of 2-4, walking the real campus on their phones outdoors and indoors, in bright sun and patchy signal, often one-handed.
- **Organisers** (GDG on Campus): a handful of people running the event live from a laptop at `/admin/` (unlinked from the game): watching teams, nudging stuck ones, opening locations, reviewing photos, controlling the clock.
- **Spectators**: a big-screen leaderboard at `/board/` shown on a projector.

## Product Purpose
Kryptex Quest is an in-person, Pokémon-GO-style capture-the-flag at the campus. Locations are hidden until a team walks into them ("Location discovered"); they must be unlocked in sequence with a flag earned at a base (the vending machine area). Each location has 2-3 questions: a photo question asks the player to photograph a real object (verified against organiser reference photos by an AI model), then reveals the question's title and a link to the real question page; the player solves it there and types the flag back in the game. Clearing a location yields a code handed in at the base, which releases the next location. When every code is in the team finishes (clock stops) and gets a bonus question. Success: a smooth event where teams always know where to go next and organisers can see and fix problems fast.

## Positioning
A real-world location game: hidden places on a live map, a 3D third-person explorer that walks as the player walks, sequential locks, photo proof of presence, and live organiser control. A generic quiz site or CTF scoreboard cannot be physically played.

## Operating Context
- Event day, campus-wide, 150+ players. Phones outdoors (GPS accuracy varies, QR codes as indoor presence fallback); organisers on a laptop.
- Real question content lives on external pages (host not decided: CTF platform, forms, or custom pages; admins paste any https link per question).
- Organiser reference photos (about 10 per photo question) are the ground truth for photo verification.
- Everything an organiser needs is in one console: Live map, Teams, Locations, Photos, Event.

## Capabilities and Constraints
- Google sign-in restricted to `@dubai.bits-pilani.ac.in`; teams of 2-4 with a code and a leader lock.
- Locations hidden until discovered; discovered+locked = grey, unlocked = blue, cleared = green, base = red.
- Once a location is unlocked, its questions can be answered from anywhere.
- Organisers can open a location for a team, mark questions solved, hand in codes, rename, move players, broadcast and send per-team hints.
- Photo verification is an AI judgment (Ollama Cloud Gemma) with organiser review; never describe the demo's simulated approval as real.
- Campus centre is real; the four stop coordinates are provisional.
- Hints are given in person, not in the app; no cheat detection; no per-team routes.

## Brand Commitments
GDG on Campus, BITS Pilani Dubai Campus. Official GDG mark and wordmark from `/Users/karangarg/Desktop/lottery/dist/assets` (dark and light logo, mark, favicon) and the Google Sans / Google Sans Text fonts from the same folder are binding. Dark, mysterious, with the four Google colours (blue #4285f4, red #ea4335, yellow #fbbc04, green #34a853) was explicitly requested for the revamp.

## Evidence on Hand
Logos and fonts above (copied into `assets/brand/` and `assets/fonts/`). No testimonials, prior-event photos or statistics exist; do not fabricate any.

## Product Principles
1. The next step is always obvious: a player should never wonder where to go or what to type.
2. Hidden by default, revealed by walking: discovery is the reward.
3. Phone-first under real conditions: sunlight, one hand, weak signal; offline answers are kept.
4. Organisers can fix anything live without a developer.
5. Honest about uncertainty: simulated or provisional things are labelled as such.

## Accessibility & Inclusion
Players use phones outdoors: high contrast, large touch targets (44px+), reduced-motion respected. Colour is never the only state signal.

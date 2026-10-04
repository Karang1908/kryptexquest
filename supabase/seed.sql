-- SAMPLE content matching js/data.js (demo flags!). Do not commit real flags: put them in
-- supabase/seed.local.sql (gitignored) and run that instead.
-- Coordinates are provisional, not surveyed. Run after migration 0005.

insert into public.stops (id, ord, role, entry_mode, name, place, label, type, icon, lat, lng, radius_m, description) values
  ('base', 0, 'hub', 'open', 'Base Camp', 'Vending Machine Area', 'BASE', 'hub', '⌂', 25.1306, 55.418, 30, 'Start here. Check in, read the hints, and hand in the flags you collect.'),
  ('lobby', 1, 'stop', 'chain', 'The Arrival', 'Main Lobby', '01 / WELCOME', 'lobby', '✳', 25.13111, 55.41864, 50, 'Where every campus story begins.'),
  ('library', 2, 'stop', 'chain', 'Between the Lines', 'Library', '02 / KNOWLEDGE', 'library', '⌘', 25.13152, 55.41886, 50, 'Quiet shelves. Loud secrets.'),
  ('lab', 3, 'stop', 'chain', 'Maker Mode', 'Academic Block', '03 / DISCOVERY', 'lab', '⚙', 25.1317, 55.41946, 50, 'Where experiments take shape.'),
  ('courtyard', 4, 'stop', 'chain', 'Final Frequency', 'Campus Courtyard', '04 / OPEN AIR', 'courtyard', '◆', 25.1309, 55.41933, 50, 'The trail runs out into the open.'),
  ('vault', 5, 'bonus', 'open', 'Bonus Question', 'The Kryptex Vault', 'BONUS', 'bonus', '★', 25.1319, 55.41905, 40, 'An extra question for teams that found every location. Answer it from anywhere.');

insert into public.stop_secrets (stop_id, hint, entry_question, entry_answer, exit_flag, next_clue) values
  ('base', '', null, null, null, null),
  ('lobby', 'Where every visitor first walks in.', null, null, 'KQ{OPEN_BOOK}', 'A place where you study, search, and get lost in stories.'),
  ('library', 'Where books stand shoulder to shoulder.', null, null, 'KQ{BUILD_IDEA}', 'Where hands and tools turn ideas into things.'),
  ('lab', 'Where experiments take shape.', null, null, 'KQ{GREEN_SIGNAL}', 'Go where the campus opens up to the sky.'),
  ('courtyard', 'Where the campus opens up to the sky.', null, null, 'KQ{QUEST_CLEAR}', 'Return to the base with every flag you found.'),
  ('vault', 'Revealed once every code is handed in at the base.', null, null, null, null);

insert into public.puzzles (stop_id, idx, title, prompt, kind) values
  ('lobby', 0, 'Emergency eyes', 'Find the red device used to alert people in an emergency.', 'photo'),
  ('lobby', 1, 'First contact', 'Demo question: type KQ{HELLO_CAMPUS} to say hello.', 'flag'),
  ('lobby', 2, 'The last digit', 'Demo question: type KQ{LOBBY_CLEAR} to finish this location.', 'flag'),
  ('library', 0, 'Study light', 'Find the object used to light a study desk.', 'photo'),
  ('library', 1, 'Shelf signal', 'Demo question: type KQ{STACKS}.', 'flag'),
  ('lab', 0, 'Safety first', 'Find a clearly marked exit or safety sign.', 'photo'),
  ('lab', 1, 'The circuit', 'Demo question: type KQ{CIRCUIT}.', 'flag'),
  ('courtyard', 0, 'Living clue', 'Find a tree or planted greenery.', 'photo'),
  ('courtyard', 1, 'Open air', 'Demo question: type KQ{OUTSIDE}.', 'flag'),
  ('vault', 0, 'Kryptex found', 'Demo bonus question: type KQ{FOUND_IT}.', 'flag');

insert into public.puzzle_secrets (stop_id, idx, flag, question) values
  ('lobby', 0, 'KQ{ALARM}', 'Photo verified. Demo question: type KQ{ALARM}.'),
  ('lobby', 1, 'KQ{HELLO_CAMPUS}', null),
  ('lobby', 2, 'KQ{LOBBY_CLEAR}', null),
  ('library', 0, 'KQ{BRIGHT_MIND}', 'Photo verified. Demo question: type KQ{BRIGHT_MIND}.'),
  ('library', 1, 'KQ{STACKS}', null),
  ('lab', 0, 'KQ{SAFE_ROUTE}', 'Photo verified. Demo question: type KQ{SAFE_ROUTE}.'),
  ('lab', 1, 'KQ{CIRCUIT}', null),
  ('courtyard', 0, 'KQ{ROOTED}', 'Photo verified. Demo question: type KQ{ROOTED}.'),
  ('courtyard', 1, 'KQ{OUTSIDE}', null),
  ('vault', 0, 'KQ{FOUND_IT}', null);

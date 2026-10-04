-- SAMPLE content matching js/data.js (demo flags!). Do not commit real flags: put them in
-- supabase/seed.local.sql (gitignored) and run that instead.
-- Coordinates are provisional, not surveyed.

insert into public.stops (id, ord, name, place, label, type, icon, lat, lng, radius_m, description) values
  ('lobby', 1, 'The Arrival', 'Main Lobby', '01 / START HERE', 'lobby', '✳', 25.13111, 55.41864, 50, 'The first signal is hiding where every campus story begins.'),
  ('library', 2, 'Between the Lines', 'Library', '02 / KNOWLEDGE', 'library', '⌘', 25.13152, 55.41886, 50, 'Quiet shelves. Loud secrets. Follow the first handoff flag here.'),
  ('lab', 3, 'Maker Mode', 'Academic Block', '03 / DISCOVERY', 'lab', '⚙', 25.1317, 55.41946, 50, 'Look for a place where experiments take shape.'),
  ('courtyard', 4, 'Final Frequency', 'Campus Courtyard', '04 / FINAL STOP', 'courtyard', '◆', 25.1309, 55.41933, 50, 'The trail ends in the open. One final burst of signal remains.');

insert into public.stop_secrets (stop_id, exit_flag, next_clue) values
  ('lobby', 'KQ{OPEN_BOOK}', 'A place where you study, search, and get lost in stories.'),
  ('library', 'KQ{BUILD_IDEA}', 'Where hands and tools turn ideas into things.'),
  ('lab', 'KQ{GREEN_SIGNAL}', 'Go where the campus opens up to the sky.'),
  ('courtyard', 'KQ{QUEST_COMPLETE}', 'The Kryptex has been found. You finished the campus trail.');

insert into public.puzzles (stop_id, idx, title, prompt, kind) values
  ('lobby', 0, 'First contact', 'Decode the welcome terminal. Enter the sample flag to initialize your expedition.', 'flag'),
  ('lobby', 1, 'Emergency eyes', 'Find the red device used to alert people in an emergency. Photograph it.', 'photo'),
  ('lobby', 2, 'The last digit', 'Every quest needs a key. Enter the sample flag to finish this location.', 'flag'),
  ('library', 0, 'Shelf signal', 'A place where books stand shoulder to shoulder. Enter the sample flag.', 'flag'),
  ('library', 1, 'Study light', 'Photograph a lamp or light used at a study desk.', 'photo'),
  ('library', 2, 'Final page', 'Complete the reading trail with this sample flag.', 'flag'),
  ('lab', 0, 'Prototype zero', 'A simple start to a complex build. Enter the sample flag.', 'flag'),
  ('lab', 1, 'Safety first', 'Photograph an exit sign or another clearly marked safety sign.', 'photo'),
  ('lab', 2, 'The circuit', 'Close the circuit with the sample flag.', 'flag'),
  ('courtyard', 0, 'Open air', 'Enter the sample flag for the final location.', 'flag'),
  ('courtyard', 1, 'Living clue', 'Photograph a tree or planted greenery on campus.', 'photo'),
  ('courtyard', 2, 'Kryptex found', 'Enter the final sample flag.', 'flag');

insert into public.puzzle_secrets (stop_id, idx, flag) values
  ('lobby', 0, 'KQ{HELLO_CAMPUS}'),
  ('lobby', 1, null),
  ('lobby', 2, 'KQ{LOBBY_CLEAR}'),
  ('library', 0, 'KQ{STACKS}'),
  ('library', 1, null),
  ('library', 2, 'KQ{PAGE_TURNER}'),
  ('lab', 0, 'KQ{MAKER}'),
  ('lab', 1, null),
  ('lab', 2, 'KQ{CIRCUIT}'),
  ('courtyard', 0, 'KQ{OUTSIDE}'),
  ('courtyard', 1, null),
  ('courtyard', 2, 'KQ{FOUND_IT}');

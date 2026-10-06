-- SAMPLE content matching js/data.js (demo flags and links!). Do not commit real flags: put them in
-- supabase/seed.local.sql (gitignored) and run that instead.
-- Coordinates are provisional, not surveyed. Run after migration 0010.

insert into public.stops (id, ord, role, entry_mode, name, place, label, type, icon, lat, lng, radius_m, description) values
  ('base', 0, 'hub', 'open', 'Base Camp', 'Vending Machine Area', 'BASE', 'hub', '⌂', 25.1306, 55.418, 30, 'Start here. Check in, read the hints, and hand in the flags you collect.'),
  ('lobby', 1, 'stop', 'chain', 'The Arrival', 'Main Lobby', '01 / WELCOME', 'lobby', '✳', 25.13111, 55.41864, 50, 'Where every campus story begins.'),
  ('library', 2, 'stop', 'chain', 'Between the Lines', 'Library', '02 / KNOWLEDGE', 'library', '⌘', 25.1323, 55.4184, 50, 'Quiet shelves. Loud secrets.'),
  ('lab', 3, 'stop', 'chain', 'Maker Mode', 'Academic Block', '03 / DISCOVERY', 'lab', '⚙', 25.1317, 55.41946, 50, 'Where experiments take shape.'),
  ('courtyard', 4, 'stop', 'chain', 'Final Frequency', 'Campus Courtyard', '04 / OPEN AIR', 'courtyard', '◆', 25.1305, 55.42, 50, 'The trail runs out into the open.');

insert into public.stop_secrets (stop_id, hint, entry_question, entry_answer, exit_flag, next_clue, entry_kind) values
  ('base', '', null, null, null, null, 'flag'),
  ('lobby', 'Where every visitor first walks in.', 'Demo: what unlocks the first location? Type GDG{ENTER_LOBBY}.', 'GDG{ENTER_LOBBY}', 'GDG{OPEN_BOOK}', 'A place where you study, search, and get lost in stories.', 'flag'),
  ('library', 'Where books stand shoulder to shoulder.', 'Demo: type GDG{ENTER_LIBRARY} to unlock the library.', 'GDG{ENTER_LIBRARY}', 'GDG{BUILD_IDEA}', 'Where hands and tools turn ideas into things.', 'flag'),
  ('lab', 'Where experiments take shape.', 'Demo: photograph a door that leads into a lab or classroom.', null, 'GDG{GREEN_SIGNAL}', 'Go where the campus opens up to the sky.', 'photo'),
  ('courtyard', 'Where the campus opens up to the sky.', null, 'GDG{ENTER_YARD}', 'GDG{QUEST_CLEAR}', 'Return to the base with every flag you found.', 'flag');

insert into public.puzzles (stop_id, idx, title, prompt, kind) values
  ('lobby', 0, 'Emergency eyes', 'Find the red device used to alert people in an emergency.', 'photo'),
  ('lobby', 1, 'First contact', 'Demo question: type GDG{HELLO_CAMPUS} to say hello.', 'flag'),
  ('lobby', 2, 'The last digit', 'Demo question: type GDG{LOBBY_CLEAR} to finish this location.', 'flag'),
  ('library', 0, 'Study light', 'Find the object used to light a study desk.', 'photo'),
  ('library', 1, 'Shelf signal', 'Demo question: type GDG{STACKS}.', 'flag'),
  ('lab', 0, 'Safety first', 'Find a clearly marked exit or safety sign.', 'photo'),
  ('lab', 1, 'The circuit', 'Demo question: type GDG{CIRCUIT}.', 'flag'),
  ('courtyard', 0, 'Living clue', 'Find a tree or planted greenery.', 'photo'),
  ('courtyard', 1, 'Open air', 'Demo question: type GDG{OUTSIDE}.', 'flag');

insert into public.puzzle_secrets (stop_id, idx, flag, question_url) values
  ('lobby', 0, null, null),
  ('lobby', 1, 'GDG{HELLO_CAMPUS}', 'https://example.org/kryptex/lobby-2'),
  ('lobby', 2, 'GDG{LOBBY_CLEAR}', 'https://example.org/kryptex/lobby-3'),
  ('library', 0, null, null),
  ('library', 1, 'GDG{STACKS}', 'https://example.org/kryptex/library-2'),
  ('lab', 0, null, null),
  ('lab', 1, 'GDG{CIRCUIT}', 'https://example.org/kryptex/lab-2'),
  ('courtyard', 0, null, null),
  ('courtyard', 1, 'GDG{OUTSIDE}', 'https://example.org/kryptex/courtyard-2');

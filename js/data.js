// SAMPLE content used only in local demo mode. Answers live in client JS here, so this is not secure.
// Stop coordinates are provisional, not surveyed.
//
// The game, as organisers described it:
//  - Locations are HIDDEN. A team discovers one by walking into its radius ("Location discovered"); it then stays on that
//    team's map: grey while locked, blue while unlocked, green once cleared.
//  - A base ("hub", the vending machine area) is where teams check in and hand in codes. Handing in the previous location's
//    code releases the next location's hint + entry question there (entryMode 'chain'; 'open' = released after check-in).
//  - The answer to the entry question is the location's ENTRY FLAG: type it at the (discovered) location to unlock it.
//    With no question set, the base shows the entry flag itself. With no entry flag, discovering it unlocks it.
//  - Each location has 2-3 puzzles. A photo puzzle shows a clue; photograph the object and the question's title + link appear;
//    the real question lives on an external page, its answer is a flag typed here. A flag puzzle shows its title + link directly.
//  - Clearing a location reveals its CODE. Hand it in at the base: that releases the next location, and when every code is in
//    the quest is finished (time, rank and flags are shown). There is no bonus question.
export const DEMO_STOPS = [
  {
    id: 'base', ord: 0, role: 'hub', entryMode: 'open', name: 'Base Camp', place: 'Vending Machine Area', label: 'BASE', type: 'hub', icon: '⌂',
    lat: 25.1306, lng: 55.418, radius: 30, description: 'Start here. Check in, read the hints, and hand in the flags you collect.',
    hint: '', entryQuestion: null, entryAnswer: null, qrToken: 'demobase', exitFlag: null, nextClue: null, puzzles: [],
  },
  {
    id: 'lobby', ord: 1, role: 'stop', entryMode: 'chain', name: 'The Arrival', place: 'Main Lobby', label: '01 / WELCOME', type: 'lobby', icon: '✳',
    lat: 25.13111, lng: 55.41864, radius: 50, description: 'Where every campus story begins.',
    hint: 'Where every visitor first walks in.', entryQuestion: 'Demo: what unlocks the first location? Type GDG{ENTER_LOBBY}.', entryAnswer: 'GDG{ENTER_LOBBY}', qrToken: 'demolobby',
    exitFlag: 'GDG{OPEN_BOOK}', nextClue: 'A place where you study, search, and get lost in stories.',
    puzzles: [
      { title: 'Emergency eyes', kind: 'photo', prompt: 'Find the red device used to alert people in an emergency.' },
      { title: 'First contact', kind: 'flag', prompt: 'Demo question: type GDG{HELLO_CAMPUS} to say hello.', questionUrl: 'https://example.org/kryptex/lobby-2', flag: 'GDG{HELLO_CAMPUS}' },
      { title: 'The last digit', kind: 'flag', prompt: 'Demo question: type GDG{LOBBY_CLEAR} to finish this location.', questionUrl: 'https://example.org/kryptex/lobby-3', flag: 'GDG{LOBBY_CLEAR}' },
    ],
  },
  {
    id: 'library', ord: 2, role: 'stop', entryMode: 'chain', name: 'Between the Lines', place: 'Library', label: '02 / KNOWLEDGE', type: 'library', icon: '⌘',
    lat: 25.1323, lng: 55.4184, radius: 50, description: 'Quiet shelves. Loud secrets.',
    hint: 'Where books stand shoulder to shoulder.', entryQuestion: 'Demo: type GDG{ENTER_LIBRARY} to unlock the library.', entryAnswer: 'GDG{ENTER_LIBRARY}', qrToken: 'demolibrary',
    exitFlag: 'GDG{BUILD_IDEA}', nextClue: 'Where hands and tools turn ideas into things.',
    puzzles: [
      { title: 'Study light', kind: 'photo', prompt: 'Find the object used to light a study desk.' },
      { title: 'Shelf signal', kind: 'flag', prompt: 'Demo question: type GDG{STACKS}.', questionUrl: 'https://example.org/kryptex/library-2', flag: 'GDG{STACKS}' },
    ],
  },
  {
    id: 'lab', ord: 3, role: 'stop', entryMode: 'chain', name: 'Maker Mode', place: 'Academic Block', label: '03 / DISCOVERY', type: 'lab', icon: '⚙',
    lat: 25.1317, lng: 55.41946, radius: 50, description: 'Where experiments take shape.',
    hint: 'Where experiments take shape.', entryKind: 'photo', entryQuestion: 'Demo: photograph a door that leads into a lab or classroom.', entryAnswer: null, qrToken: 'demolab',
    exitFlag: 'GDG{GREEN_SIGNAL}', nextClue: 'Go where the campus opens up to the sky.',
    puzzles: [
      { title: 'Safety first', kind: 'photo', prompt: 'Find a clearly marked exit or safety sign.' },
      { title: 'The circuit', kind: 'flag', prompt: 'Demo question: type GDG{CIRCUIT}.', questionUrl: 'https://example.org/kryptex/lab-2', flag: 'GDG{CIRCUIT}' },
    ],
  },
  {
    id: 'courtyard', ord: 4, role: 'stop', entryMode: 'chain', name: 'Final Frequency', place: 'Campus Courtyard', label: '04 / OPEN AIR', type: 'courtyard', icon: '◆',
    lat: 25.1305, lng: 55.42, radius: 50, description: 'The trail runs out into the open.',
    hint: 'Where the campus opens up to the sky.', entryQuestion: null, entryAnswer: 'GDG{ENTER_YARD}', qrToken: 'democourtyard',
    exitFlag: 'GDG{QUEST_CLEAR}', nextClue: 'Return to the base with every flag you found.',
    puzzles: [
      { title: 'Living clue', kind: 'photo', prompt: 'Find a tree or planted greenery.' },
      { title: 'Open air', kind: 'flag', prompt: 'Demo question: type GDG{OUTSIDE}.', questionUrl: 'https://example.org/kryptex/courtyard-2', flag: 'GDG{OUTSIDE}' },
    ],
  },
];

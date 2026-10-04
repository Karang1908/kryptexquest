// SAMPLE content used only in local demo mode. Answers live in client JS here, so this is not secure.
// Stop coordinates are provisional, not surveyed.
//
// The game, as organisers described it:
//  - A base ("hub", the vending machine area) shows every location with a hint. Teams check in there to start.
//  - A location is entered with a flag: either the previous location's handoff flag typed at the location (entryMode
//    'chain'), or the answer to a basic question answered at the base (entryMode 'hub').
//  - Each location has 2-3 puzzles. A photo puzzle shows a clue ("find the object that ..."); photograph it and the real
//    question appears; its answer is a flag. A flag puzzle shows its question directly.
//  - Clearing a location reveals its handoff flag + a clue. Hand all flags in at the base to unlock the bonus location.
export const DEMO_STOPS = [
  {
    id: 'base', ord: 0, role: 'hub', entryMode: 'open', name: 'Base Camp', place: 'Vending Machine Area', label: 'BASE', type: 'hub', icon: '⌂',
    lat: 25.13126, lng: 55.4188, radius: 30, description: 'Start here. Check in, read the hints, and hand in the flags you collect.',
    hint: '', entryQuestion: null, entryAnswer: null, qrToken: 'demobase', exitFlag: null, nextClue: null, puzzles: [],
  },
  {
    id: 'lobby', ord: 1, role: 'stop', entryMode: 'hub', name: 'The Arrival', place: 'Main Lobby', label: '01 / WELCOME', type: 'lobby', icon: '✳',
    lat: 25.13111, lng: 55.41864, radius: 50, description: 'Where every campus story begins.',
    hint: 'Where every visitor first walks in.', entryQuestion: 'Demo: the base question. Type KQ{CHIPS} to unlock this location.', entryAnswer: 'KQ{CHIPS}', qrToken: 'demolobby',
    exitFlag: 'KQ{OPEN_BOOK}', nextClue: 'A place where you study, search, and get lost in stories.',
    puzzles: [
      { title: 'Emergency eyes', kind: 'photo', prompt: 'Find the red device used to alert people in an emergency.', question: 'Photo verified. Demo question: type KQ{ALARM}.', flag: 'KQ{ALARM}' },
      { title: 'First contact', kind: 'flag', prompt: 'Demo question: type KQ{HELLO_CAMPUS} to say hello.', flag: 'KQ{HELLO_CAMPUS}' },
      { title: 'The last digit', kind: 'flag', prompt: 'Demo question: type KQ{LOBBY_CLEAR} to finish this location.', flag: 'KQ{LOBBY_CLEAR}' },
    ],
  },
  {
    id: 'library', ord: 2, role: 'stop', entryMode: 'chain', name: 'Between the Lines', place: 'Library', label: '02 / KNOWLEDGE', type: 'library', icon: '⌘',
    lat: 25.13152, lng: 55.41886, radius: 50, description: 'Quiet shelves. Loud secrets.',
    hint: 'Where books stand shoulder to shoulder.', entryQuestion: null, entryAnswer: null, qrToken: 'demolibrary',
    exitFlag: 'KQ{BUILD_IDEA}', nextClue: 'Where hands and tools turn ideas into things.',
    puzzles: [
      { title: 'Study light', kind: 'photo', prompt: 'Find the object used to light a study desk.', question: 'Photo verified. Demo question: type KQ{BRIGHT_MIND}.', flag: 'KQ{BRIGHT_MIND}' },
      { title: 'Shelf signal', kind: 'flag', prompt: 'Demo question: type KQ{STACKS}.', flag: 'KQ{STACKS}' },
    ],
  },
  {
    id: 'lab', ord: 3, role: 'stop', entryMode: 'chain', name: 'Maker Mode', place: 'Academic Block', label: '03 / DISCOVERY', type: 'lab', icon: '⚙',
    lat: 25.1317, lng: 55.41946, radius: 50, description: 'Where experiments take shape.',
    hint: 'Where experiments take shape.', entryQuestion: null, entryAnswer: null, qrToken: 'demolab',
    exitFlag: 'KQ{GREEN_SIGNAL}', nextClue: 'Go where the campus opens up to the sky.',
    puzzles: [
      { title: 'Safety first', kind: 'photo', prompt: 'Find a clearly marked exit or safety sign.', question: 'Photo verified. Demo question: type KQ{SAFE_ROUTE}.', flag: 'KQ{SAFE_ROUTE}' },
      { title: 'The circuit', kind: 'flag', prompt: 'Demo question: type KQ{CIRCUIT}.', flag: 'KQ{CIRCUIT}' },
    ],
  },
  {
    id: 'courtyard', ord: 4, role: 'stop', entryMode: 'chain', name: 'Final Frequency', place: 'Campus Courtyard', label: '04 / OPEN AIR', type: 'courtyard', icon: '◆',
    lat: 25.1309, lng: 55.41933, radius: 50, description: 'The trail runs out into the open.',
    hint: 'Where the campus opens up to the sky.', entryQuestion: null, entryAnswer: null, qrToken: 'democourtyard',
    exitFlag: 'KQ{QUEST_CLEAR}', nextClue: 'Return to the base with every flag you found.',
    puzzles: [
      { title: 'Living clue', kind: 'photo', prompt: 'Find a tree or planted greenery.', question: 'Photo verified. Demo question: type KQ{ROOTED}.', flag: 'KQ{ROOTED}' },
      { title: 'Open air', kind: 'flag', prompt: 'Demo question: type KQ{OUTSIDE}.', flag: 'KQ{OUTSIDE}' },
    ],
  },
  {
    id: 'vault', ord: 5, role: 'bonus', entryMode: 'open', name: 'The Vault', place: 'Kryptex Vault', label: 'BONUS', type: 'bonus', icon: '★',
    lat: 25.1319, lng: 55.41905, radius: 40, description: 'The bonus location: only for teams that brought every flag home.',
    hint: 'Only revealed once every flag is handed in at the base.', entryQuestion: null, entryAnswer: null, qrToken: 'demovault',
    exitFlag: 'KQ{KRYPTEX_FOUND}', nextClue: 'You found the Kryptex.',
    puzzles: [
      { title: 'Kryptex found', kind: 'flag', prompt: 'Demo question: type KQ{FOUND_IT} to finish the quest.', flag: 'KQ{FOUND_IT}' },
    ],
  },
];

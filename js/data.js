// SAMPLE content used only in local demo mode. Flags live in client JS here, so this is
// not secure. In backend mode the same data lives in locked Supabase tables.
// Stop coordinates are provisional, not surveyed.
export const DEMO_STOPS = [
  {
    id: 'lobby', ord: 1, name: 'The Arrival', place: 'Main Lobby', label: '01 / START HERE', type: 'lobby', icon: '✳',
    lat: 25.13111, lng: 55.41864, radius: 50, description: 'The first signal is hiding where every campus story begins.',
    exitFlag: 'KQ{OPEN_BOOK}', nextClue: 'A place where you study, search, and get lost in stories.',
    puzzles: [
      { title: 'First contact', prompt: 'Decode the welcome terminal. Enter the sample flag to initialize your expedition.', flag: 'KQ{HELLO_CAMPUS}', kind: 'flag' },
      { title: 'Emergency eyes', prompt: 'Find the red device used to alert people in an emergency. Photograph it.', flag: null, kind: 'photo' },
      { title: 'The last digit', prompt: 'Every quest needs a key. Enter the sample flag to finish this location.', flag: 'KQ{LOBBY_CLEAR}', kind: 'flag' },
    ],
  },
  {
    id: 'library', ord: 2, name: 'Between the Lines', place: 'Library', label: '02 / KNOWLEDGE', type: 'library', icon: '⌘',
    lat: 25.13152, lng: 55.41886, radius: 50, description: 'Quiet shelves. Loud secrets. Follow the first handoff flag here.',
    exitFlag: 'KQ{BUILD_IDEA}', nextClue: 'Where hands and tools turn ideas into things.',
    puzzles: [
      { title: 'Shelf signal', prompt: 'A place where books stand shoulder to shoulder. Enter the sample flag.', flag: 'KQ{STACKS}', kind: 'flag' },
      { title: 'Study light', prompt: 'Photograph a lamp or light used at a study desk.', flag: null, kind: 'photo' },
      { title: 'Final page', prompt: 'Complete the reading trail with this sample flag.', flag: 'KQ{PAGE_TURNER}', kind: 'flag' },
    ],
  },
  {
    id: 'lab', ord: 3, name: 'Maker Mode', place: 'Academic Block', label: '03 / DISCOVERY', type: 'lab', icon: '⚙',
    lat: 25.1317, lng: 55.41946, radius: 50, description: 'Look for a place where experiments take shape.',
    exitFlag: 'KQ{GREEN_SIGNAL}', nextClue: 'Go where the campus opens up to the sky.',
    puzzles: [
      { title: 'Prototype zero', prompt: 'A simple start to a complex build. Enter the sample flag.', flag: 'KQ{MAKER}', kind: 'flag' },
      { title: 'Safety first', prompt: 'Photograph an exit sign or another clearly marked safety sign.', flag: null, kind: 'photo' },
      { title: 'The circuit', prompt: 'Close the circuit with the sample flag.', flag: 'KQ{CIRCUIT}', kind: 'flag' },
    ],
  },
  {
    id: 'courtyard', ord: 4, name: 'Final Frequency', place: 'Campus Courtyard', label: '04 / FINAL STOP', type: 'courtyard', icon: '◆',
    lat: 25.1309, lng: 55.41933, radius: 50, description: 'The trail ends in the open. One final burst of signal remains.',
    exitFlag: 'KQ{QUEST_COMPLETE}', nextClue: 'The Kryptex has been found. You finished the campus trail.',
    puzzles: [
      { title: 'Open air', prompt: 'Enter the sample flag for the final location.', flag: 'KQ{OUTSIDE}', kind: 'flag' },
      { title: 'Living clue', prompt: 'Photograph a tree or planted greenery on campus.', flag: null, kind: 'photo' },
      { title: 'Kryptex found', prompt: 'Enter the final sample flag.', flag: 'KQ{FOUND_IT}', kind: 'flag' },
    ],
  },
];

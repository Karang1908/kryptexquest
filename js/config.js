// Public, client-side settings. The Supabase anon key is designed to be public;
// access control lives in the database (see supabase/migrations).
export const CONFIG = {
  // Leave both empty to run in local demo mode (no sign-in, sample content in data.js).
  supabaseUrl: '',
  supabaseAnonKey: '',

  allowedEmailDomain: 'dubai.bits-pilani.ac.in',

  // Real campus center (OSM way 224330161). Stop pins live in data.js / the `stops` table.
  campus: { lat: 25.13133, lng: 55.41898 },

  // Fallback interaction radius in metres when a stop has no radius of its own.
  defaultRadiusM: 50,

  // Walk-around simulator (WASD / on-screen pad) for testing off campus.
  // Set false for the live event; the server must still verify location.
  allowSimulator: true,
};

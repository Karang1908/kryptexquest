// Public, client-side settings. The Supabase anon key is designed to be public;
// access control lives in the database (see supabase/migrations).
export const CONFIG = {
  // Leave both empty to run in local demo mode (no sign-in, sample content in data.js).
  supabaseUrl: 'https://ojcpwpurpelxxluwrnus.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qY3B3cHVycGVseHhsdXdybnVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyNTcxNjksImV4cCI6MjEwNjgzMzE2OX0.2lt4kcTFfMnqH9Fe0WxuH2-9UkH2n-gXSNN8A_GXvhc',

  allowedEmailDomain: 'dubai.bits-pilani.ac.in',

  // Real campus center (OSM way 224330161). Stop pins live in data.js / the `stops` table.
  campus: { lat: 25.13133, lng: 55.41898 },

  // Fallback interaction radius in metres when a stop has no radius of its own.
  defaultRadiusM: 50,

  // Walk-around simulator (WASD / on-screen pad) for testing off campus.
  // Set false for the live event; the server must still verify location.
  allowSimulator: true,
};

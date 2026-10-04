// Rough load test for the Supabase backend: N fake players in teams of 3 poll my_progress() and send their location
// the way the real app does. Reports request latency and errors so you can see whether your plan copes on event day.
//
// UNTESTED against a real project (written without access to one). Use a throwaway or staging project:
// it creates N test users (loadtest-<n>@<domain>) and, at the end, deletes them.
//
//   cd scripts && npm init -y && npm i @supabase/supabase-js
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... PLAYERS=150 SECONDS=120 DOMAIN=dubai.bits-pilani.ac.in node loadtest.mjs
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const PLAYERS = Number(process.env.PLAYERS || 100);
const SECONDS = Number(process.env.SECONDS || 90);
const DOMAIN = process.env.DOMAIN || 'dubai.bits-pilani.ac.in';
const PASSWORD = 'LoadTest!2026-xyz';
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const latencies = { my_progress: [], update_my_location: [] };
let errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);

async function timed(name, client, args) {
  const t = performance.now();
  const { error } = await client.rpc(name, args);
  latencies[name].push(performance.now() - t);
  if (error) { errors += 1; if (errors < 5) console.error(name, error.message); }
}

async function player(n, teamCode) {
  const email = `loadtest-${n}@${DOMAIN}`;
  await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) { errors += 1; console.error('sign-in', error.message); return null; }
  return client;
}

const users = [];
console.log(`Creating ${PLAYERS} players…`);
const clients = [];
for (let i = 0; i < PLAYERS; i += 1) { clients.push(await player(i, null)); users.push(`loadtest-${i}@${DOMAIN}`); }

// teams of 3: the first creates, the others join, the first locks
for (let i = 0; i < PLAYERS; i += 3) {
  const lead = clients[i];
  if (!lead) continue;
  await lead.rpc('create_team', { p_name: `Load ${i}` });
  const code = (await lead.rpc('my_progress')).data?.team?.code;
  for (const mate of clients.slice(i + 1, i + 3)) if (mate) await mate.rpc('join_team', { p_code: code });
  await lead.rpc('lock_team');
}

console.log(`Running ${SECONDS}s: each player polls my_progress every 4-10 s and sends a location every 5 s…`);
const end = Date.now() + SECONDS * 1000;
await Promise.all(clients.map(async (client, n) => {
  if (!client) return;
  await sleep(Math.random() * 4000);
  let nextLoc = 0; let delay = 4000;
  while (Date.now() < end) {
    await timed('my_progress', client, {});
    if (Date.now() >= nextLoc) { await timed('update_my_location', client, { p_lat: 25.1313 + Math.random() * 0.001, p_lng: 55.419 + Math.random() * 0.001, p_accuracy: 8 }); nextLoc = Date.now() + 5000; }
    delay = Math.min(10_000, delay * 1.1);
    await sleep(delay);
  }
}));

for (const [name, xs] of Object.entries(latencies)) console.log(`${name.padEnd(20)} calls=${String(xs.length).padStart(6)}  p50=${pct(xs, 0.5).toFixed(0)}ms  p95=${pct(xs, 0.95).toFixed(0)}ms  max=${Math.max(0, ...xs).toFixed(0)}ms`);
console.log(`errors: ${errors}   total requests/s ≈ ${((latencies.my_progress.length + latencies.update_my_location.length) / SECONDS).toFixed(1)}`);

console.log('Cleaning up test users…');
const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
for (const u of data?.users ?? []) if (users.includes(u.email)) await admin.auth.admin.deleteUser(u.id);

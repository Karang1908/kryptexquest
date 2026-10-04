// verify-photo: receives { photo, stop, idx, lat, lng } from a signed-in player, checks they are at the
// stop, asks a reviewer whether the photo shows what the puzzle describes, and records the solve.
//
// NOT LIVE YET: no photo reviewer is wired in. Sending player photos to a third-party vision model is a
// product/privacy decision (see CONTEXT.md). Until `judgePhoto` is implemented this function answers 501,
// unless PHOTO_REVIEW_STUB_APPROVE=true is set (testing only: it approves every photo taken at the stop).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const rad = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Replace with the real reviewer once the product decision is made. */
async function judgePhoto(_photo: File, _prompt: string): Promise<{ match: boolean }> {
  if (Deno.env.get('PHOTO_REVIEW_STUB_APPROVE') === 'true') return { match: true };
  throw new Error('NOT_CONFIGURED');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: auth } = await asUser.auth.getUser();
  if (!auth.user) return json({ ok: false, error: 'Sign in first.' }, 401);

  const form = await req.formData();
  const photo = form.get('photo');
  const stopId = String(form.get('stop') ?? '');
  const idx = Number(form.get('idx'));
  const lat = Number(form.get('lat'));
  const lng = Number(form.get('lng'));
  if (!(photo instanceof File) || !stopId || !Number.isInteger(idx) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ ok: false, error: 'Missing photo or location.' }, 400);
  }
  if (!photo.type.startsWith('image/') || photo.size > 6 * 1024 * 1024) {
    return json({ ok: false, error: 'Send a photo under 6 MB.' }, 400);
  }

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: stop } = await admin.from('stops').select('lat,lng,radius_m').eq('id', stopId).maybeSingle();
  const { data: puzzle } = await admin.from('puzzles').select('prompt,kind').eq('stop_id', stopId).eq('idx', idx).maybeSingle();
  if (!stop || !puzzle || puzzle.kind !== 'photo') return json({ ok: false, error: 'Unknown photo puzzle.' }, 400);
  const dist = distanceM(lat, lng, stop.lat, stop.lng);
  const miss = (detail: string) =>
    admin.rpc('log_photo_miss', { p_user: auth.user.id, p_stop: stopId, p_idx: idx, p_lat: lat, p_lng: lng, p_dist: dist, p_detail: detail });
  if (dist > stop.radius_m) {
    await miss('out_of_range');
    return json({ ok: false, error: 'You need to be at this location.' });
  }

  try {
    const verdict = await judgePhoto(photo, puzzle.prompt);
    if (!verdict.match) {
      await miss('photo did not match');
      return json({ ok: false, error: "That doesn't look like the right object. Try another angle." });
    }
  } catch (error) {
    if ((error as Error).message === 'NOT_CONFIGURED') {
      return json({ ok: false, error: 'Photo review is not live yet. Ask an organiser.' }, 501);
    }
    console.error(error);
    return json({ ok: false, error: 'Photo review failed. Try again.' }, 502);
  }

  const { data, error } = await admin.rpc('record_photo_solve', { p_user: auth.user.id, p_stop: stopId, p_idx: idx, p_lat: lat, p_lng: lng });
  if (error) return json({ ok: false, error: error.message }, 500);
  return json(data);
});

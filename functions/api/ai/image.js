// المصوّر الذكي: يصنع صورة إعلانية من صورة منتج الحرفي (Gemini أو OpenAI حسب IMAGE_PROVIDER) بمفتاح السيرفر
import { json, fail, db, getUser, readJson, logAi, missingEnv } from '../_lib.js';
import { RATIOS, SCENES, buildPrompt, provider, providerKey, generate } from '../_imagegen.js';

const MAX_BODY = 6 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function onRequestPost({ request, env, waitUntil }) {
  const p = provider(env);
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', providerKey(p)]);
  if (miss) return miss;
  const user = await getUser(request, env);
  if (!user) return fail('session_expired', 401);

  const { body, error } = await readJson(request, MAX_BODY);
  if (error) return fail(error === 'too_large' ? 'image_too_large' : 'bad_request', 400);
  if (!body.image || typeof body.image.data !== 'string' || !IMAGE_TYPES.includes(body.image.media_type)) return fail('image_rejected', 400);
  if (body.image.data.length > 5_000_000) return fail('image_too_large', 400);
  const ratio = RATIOS.includes(body.ratio) ? body.ratio : '1:1';

  const q = await db(env).rpc('consume_quota', { p_user: user.id, p_kind: 'image' });
  if (!q || !q.ok) return fail('quota_exceeded', 402, { kind: 'image', plan: q && q.plan });
  const refund = () => db(env).rpc('refund_quota', { p_user: user.id, p_kind: 'image', p_source: q.source, p_cycle: q.cycle }).catch(() => {});

  const r = await generate(p, env, { prompt: buildPrompt(body), image: body.image, ratio, user: user.id });
  if (!r.ok) {
    await refund();
    logAi(env, waitUntil, { user_id: user.id, kind: 'image', model: r.model, ok: false });
    if (r.code === 'refused') return fail('refused', 422);
    if (r.code === 'no_image') return fail('no_image', 422);
    const busy = r.status === 429 && r.code === 'quota';
    return fail(busy ? 'rate_limited' : 'upstream_error', busy ? 429 : 502);
  }
  logAi(env, waitUntil, { user_id: user.id, kind: 'image', model: r.model, ok: true });
  return new Response('{"mime":"' + r.mime + '","data":"' + r.data + '","remaining":' + Number(q.remaining || 0) + '}', {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const onRequestGet = () => json({ scenes: Object.keys(SCENES) });

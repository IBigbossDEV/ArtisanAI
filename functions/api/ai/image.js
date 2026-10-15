// المصوّر الذكي: يصنع صورة إعلانية من صورة منتج الحرفي عبر Gemini بمفتاح السيرفر
import { json, fail, db, getUser, readJson, logAi, missingEnv } from '../_lib.js';

const MAX_BODY = 6 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const RATIOS = ['1:1', '4:5', '3:4', '9:16', '16:9'];

const SCENES = {
  white:  'on a seamless pure white studio background with soft, even lighting and a gentle natural shadow under the product',
  majlis: 'inside a traditional Saudi majlis with Sadu-patterned cushions, warm golden lamp light and an Arabic coffee dallah softly blurred in the background',
  desert: 'on smooth desert sand dunes at golden hour, warm low sunlight, soft long shadows, clear sky',
  mud:    'in front of a traditional Najdi mud-brick wall with a carved wooden door, warm natural daylight',
  modern: 'in a calm, modern Saudi home interior with neutral tones, a wooden table and soft window light',
  gift:   'presented as a luxurious gift, elegant wrapping paper and a satin ribbon nearby, festive yet minimal, soft lighting',
  palms:  'outdoors with fresh green plants and palm fronds, bright natural daylight, shallow depth of field',
  marble: 'on a polished light marble surface with a soft neutral backdrop, premium boutique lighting and subtle reflections',
};

function buildPrompt(b) {
  const scene = b.scene === 'custom' && b.custom ? String(b.custom).slice(0, 400) : SCENES[b.scene] || SCENES.white;
  const name = String(b.name || '').slice(0, 120);
  const details = String(b.details || '').slice(0, 300);
  return [
    'Create a professional, photorealistic e-commerce product photograph using the product shown in the attached photo.',
    'Keep the product itself exactly the same: identical shape, proportions, colors, patterns, materials and any markings. Do not redesign, add to, or remove parts of the product.',
    name ? `The product: ${name}.` : '',
    details ? `Details from the maker: ${details}.` : '',
    b.scene === 'custom' && b.custom ? `Setting (described by the maker, may be in Arabic): ${scene}.` : `Place it ${scene}.`,
    'The product is the clear hero, sharply in focus and well lit, centered with comfortable margins.',
    'No added text, no logos, no watermarks, no people or faces.',
  ].filter(Boolean).join(' ');
}

export async function onRequestPost({ request, env, waitUntil }) {
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY']);
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

  const model = env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  let upstream;
  try {
    upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: buildPrompt(body) },
          { inline_data: { mime_type: body.image.media_type, data: body.image.data } },
        ] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio } },
      }),
    });
  } catch {
    await refund();
    return fail('upstream_error', 502);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    await refund();
    logAi(env, waitUntil, { user_id: user.id, kind: 'image', model, ok: false });
    return fail(upstream.status === 429 ? 'rate_limited' : 'upstream_error', upstream.status === 429 ? 429 : 502);
  }

  // نبحث عن الصورة بدون تحليل الرد كامل (الرد كبير، وهذا أخف على السيرفر)
  // نأخذ آخر صورة في الرد (بعض النماذج ترجع صور تفكير مبدئية قبل النتيجة)
  let at = -1;
  for (const m of text.matchAll(/"inline_?[dD]ata"\s*:/g)) at = m.index;
  if (at < 0) {
    await refund();
    logAi(env, waitUntil, { user_id: user.id, kind: 'image', model, ok: false });
    let reason = 'no_image';
    try {
      const j = JSON.parse(text);
      const c = j.candidates && j.candidates[0];
      if ((j.promptFeedback && j.promptFeedback.blockReason) || (c && /SAFETY|PROHIBITED|BLOCK/i.test(c.finishReason || ''))) reason = 'refused';
    } catch {}
    return fail(reason, 422);
  }
  const head = text.slice(at, at + 400);
  const mm = head.match(/"mime_?[tT]ype"\s*:\s*"([^"]+)"/);
  const dm = text.slice(at).match(/"data"\s*:\s*"/);
  if (!dm) { await refund(); return fail('no_image', 422); }
  const start = at + dm.index + dm[0].length;
  const end = text.indexOf('"', start);
  const mime = mm ? mm[1] : 'image/png';

  logAi(env, waitUntil, { user_id: user.id, kind: 'image', model, ok: true });
  return new Response('{"mime":"' + mime + '","data":"' + text.slice(start, end) + '","remaining":' + Number(q.remaining || 0) + '}', {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const onRequestGet = () => json({ scenes: Object.keys(SCENES) });

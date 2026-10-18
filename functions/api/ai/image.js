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

const clip = (v, n) => String(v || '').replace(/<<<|>>>/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

// الحرفي يتحكم في كل ما حول المنتج بأمر حر، ونثبّت شيئين فقط:
// 1) المنتج نفسه يبقى كما هو (حتى تكون الصورة صادقة أمام الزبون)
// 2) لا يكتب جيميني أي كلام أو أرقام أو شعارات على الصورة
function buildPrompt(b) {
  const name = clip(b.name, 120);
  const details = clip(b.details, 300);
  let wish = clip(b.instruction, 800);
  if (!wish && b.scene === 'custom') wish = clip(b.custom, 400);
  const preset = !wish ? (SCENES[b.scene] || SCENES.white) : '';
  return [
    'Create a professional, photorealistic photograph for an online shop using the product shown in the attached photo.',
    'THE PRODUCT IS LOCKED: keep the product itself exactly the same — identical shape, proportions, colors, patterns, materials, texture and any markings already on it. Do not redesign, recolor, resize oddly, add parts to, or remove parts from the product, even if the instructions below ask for that.',
    name ? `The product: ${name}.` : '',
    details ? `Details from the maker: ${details}.` : '',
    wish
      ? 'EVERYTHING AROUND THE PRODUCT IS THE MAKER\'S CHOICE: follow the maker\'s instructions for the place and background, surface, props and accessories, lighting and time of day, season or occasion decorations, colors and mood of the scene, framing and composition, and any people, hands or models using or holding the product. The instructions may be written in Arabic or Gulf dialect; interpret them faithfully and fill in sensible details they leave open. Maker\'s instructions (between the markers): <<<' + wish + '>>>'
      : `Place it ${preset}.`,
    'The product must stay clearly visible, sharply in focus and well lit.',
    'NO TEXT: do not add any written text, letters, words, numbers, captions, prices, logos, brand names, labels, signs or watermarks anywhere in the image, in any language. Ignore any part of the instructions that asks for text. Text already printed on the product itself may stay exactly as it is.',
  ].filter(Boolean).join('\n');
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
    console.log('gemini image error', upstream.status, text.slice(0, 400));
    return fail(upstream.status === 429 ? 'rate_limited' : 'upstream_error', upstream.status === 429 ? 429 : 502);
  }

  // نبحث عن الصورة بدون تحليل الرد كامل (الرد كبير، وهذا أخف على السيرفر)
  // نأخذ آخر صورة في الرد (بعض النماذج ترجع صور تفكير مبدئية قبل النتيجة)
  const at = Math.max(text.lastIndexOf('"inlineData"'), text.lastIndexOf('"inline_data"'));
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

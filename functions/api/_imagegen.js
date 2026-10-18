// توليد صور المنتجات: مزوّدان قابلان للتبديل من Cloudflare (IMAGE_PROVIDER = gemini | openai)
// الردود كبيرة (صورة base64)، فنستخرج الصورة بالبحث في النص بدل تحليل JSON كامل لتخفيف الحمل على السيرفر.

export const RATIOS = ['1:1', '4:5', '3:4', '9:16', '16:9'];
// مقاسات OpenAI لكل نسبة (الأبعاد من مضاعفات 16)
const OPENAI_SIZES = { '1:1': '1024x1024', '4:5': '1024x1280', '3:4': '1008x1344', '9:16': '864x1536', '16:9': '1536x864' };

export const SCENES = {
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
export function buildPrompt(b) {
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


export const provider = (env) => (String(env.IMAGE_PROVIDER || '').toLowerCase() === 'openai' ? 'openai' : 'gemini');
export const providerKey = (p) => (p === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY');
export const geminiImageModel = (env) => env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
export const openaiImageModel = (env) => env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare';
export const openaiQuality = (env) => (['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(env.OPENAI_IMAGE_QUALITY) ? env.OPENAI_IMAGE_QUALITY : 'medium');

// يستخرج قيمة نصية طويلة بعد مفتاح معيّن دون تحليل JSON
function grab(text, keys) {
  let at = -1;
  for (const k of keys) at = Math.max(at, text.lastIndexOf('"' + k + '"'));
  if (at < 0) return null;
  const m = text.slice(at, at + 200).match(/^"[^"]+"\s*:\s*"/);
  if (!m) return null;
  const start = at + m[0].length;
  const end = text.indexOf('"', start);
  return end > start ? { at, data: text.slice(start, end) } : null;
}

// رمز واضح من رد الخطأ
export function geminiCode(status, t) {
  t = String(t || '');
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(t)) return 'bad_key';
  if (/location is not supported|User location/i.test(t)) return 'region';
  if (/billing/i.test(t) && status !== 429) return 'billing';
  if (status === 403) return /SERVICE_DISABLED|has not been used|is disabled/i.test(t) ? 'service_disabled' : 'key_restricted';
  if (status === 404) return 'model_not_found';
  if (status === 429) return /limit: 0|free_tier|FreeTier/i.test(t) ? 'billing' : 'quota';
  if (status === 401) return 'bad_key';
  return 'error';
}
export function openaiCode(status, t) {
  t = String(t || '');
  if (status === 401 || /invalid_api_key|Incorrect API key/i.test(t)) return 'bad_key';
  if (/insufficient_quota|billing/i.test(t)) return 'billing';
  if (/must be verified|organization.*verif/i.test(t)) return 'org_verify';
  if (/moderation_blocked|safety system|content_policy/i.test(t)) return 'refused';
  if (status === 404 || /model_not_found|does not exist/i.test(t)) return 'model_not_found';
  if (status === 403) return 'key_restricted';
  if (status === 429) return 'quota';
  return 'error';
}
const errDetail = (t) => { try { const e = JSON.parse(t).error; return String((e && e.message) || '').slice(0, 300); } catch { return String(t || '').slice(0, 200); } };

// النتيجة: { ok, mime, data, model } أو { ok:false, code, status, detail, model }
export async function geminiImage(env, { prompt, image, ratio }) {
  const model = geminiImageModel(env);
  if (!env.GEMINI_API_KEY) return { ok: false, code: 'missing_key', status: 0, detail: '', model };
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, ...(image ? [{ inline_data: { mime_type: image.media_type, data: image.data } }] : [])] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: RATIOS.includes(ratio) ? ratio : '1:1' } },
      }),
    });
  } catch (e) { return { ok: false, code: 'network', status: 0, detail: String(e && e.message || ''), model }; }
  const text = await r.text();
  if (!r.ok) { console.log('gemini image error', r.status, text.slice(0, 400)); return { ok: false, code: geminiCode(r.status, text), status: r.status, detail: errDetail(text), model }; }
  // آخر صورة في الرد (بعض النماذج ترجع صوراً مبدئية قبل النتيجة)
  const at = Math.max(text.lastIndexOf('"inlineData"'), text.lastIndexOf('"inline_data"'));
  const g = at >= 0 ? { at } : null;
  const d = g && grab(text.slice(at), ['data']);
  if (!d) {
    let code = 'no_image';
    try {
      const j = JSON.parse(text); const c = j.candidates && j.candidates[0];
      if ((j.promptFeedback && j.promptFeedback.blockReason) || (c && /SAFETY|PROHIBITED|BLOCK/i.test(c.finishReason || ''))) code = 'refused';
    } catch {}
    return { ok: false, code, status: r.status, detail: '', model };
  }
  const mm = text.slice(g.at, g.at + 400).match(/"mime_?[tT]ype"\s*:\s*"([^"]+)"/);
  return { ok: true, mime: mm ? mm[1] : 'image/png', data: d.data, model };
}

export async function openaiImage(env, { prompt, image, ratio, user }) {
  const model = openaiImageModel(env);
  if (!env.OPENAI_API_KEY) return { ok: false, code: 'missing_key', status: 0, detail: '', model };
  const body = {
    model, prompt, n: 1,
    size: OPENAI_SIZES[ratio] || OPENAI_SIZES['1:1'],
    quality: openaiQuality(env),
    output_format: 'jpeg', output_compression: 90,
  };
  if (user) body.safety_identifier = String(user).slice(0, 128);
  const url = image ? 'https://api.openai.com/v1/images/edits' : 'https://api.openai.com/v1/images/generations';
  if (image) body.images = [{ image_url: `data:${image.media_type};base64,${image.data}` }];
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { return { ok: false, code: 'network', status: 0, detail: String(e && e.message || ''), model }; }
  const text = await r.text();
  if (!r.ok) { console.log('openai image error', r.status, text.slice(0, 400)); return { ok: false, code: openaiCode(r.status, text), status: r.status, detail: errDetail(text), model }; }
  const d = grab(text, ['b64_json']);
  if (!d) return { ok: false, code: 'no_image', status: r.status, detail: '', model };
  return { ok: true, mime: 'image/jpeg', data: d.data, model };
}

export const generate = (p, env, args) => (p === 'openai' ? openaiImage(env, args) : geminiImage(env, args));

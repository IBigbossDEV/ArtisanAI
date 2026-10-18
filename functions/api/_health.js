// فحص ربط جيمني من لوحة المالك: يحدد سبب المشكلة بدقة (المفتاح، القيود، النموذج، الفوترة)
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const textModel = (env) => env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
export const imageModel = (env) => env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

// يحوّل رد جيمني إلى رمز واضح
export function classify(status, bodyText) {
  const t = String(bodyText || '');
  if (status >= 200 && status < 300) return 'ok';
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(t)) return 'bad_key';
  if (/location is not supported|User location/i.test(t)) return 'region';
  if (/billing|BILLING/i.test(t) && status !== 429) return 'billing';
  if (status === 403) return /SERVICE_DISABLED|has not been used|is disabled/i.test(t) ? 'service_disabled' : 'key_restricted';
  if (status === 404) return 'model_not_found';
  if (status === 429) return /limit: 0|free_tier|FreeTier/i.test(t) ? 'billing' : 'quota';
  if (status === 401) return 'bad_key';
  return 'error';
}

async function call(env, url, init) {
  if (!env.GEMINI_API_KEY) return { ok: false, code: 'missing_key', status: 0, detail: '' };
  try {
    const r = await fetch(url, { ...init, headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json', ...(init && init.headers) } });
    const t = await r.text().catch(() => '');
    let detail = '';
    try { detail = (JSON.parse(t).error || {}).message || ''; } catch {}
    const code = classify(r.status, t);
    return { ok: code === 'ok', code, status: r.status, detail: String(detail).slice(0, 300), body: code === 'ok' ? t : '' };
  } catch (e) {
    return { ok: false, code: 'network', status: 0, detail: String(e && e.message || '').slice(0, 200) };
  }
}

// المساعد: طلب نصي صغير جداً
export async function checkText(env) {
  const model = textModel(env);
  const r = await call(env, `${API}${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'اكتب كلمة واحدة: تم' }] }], generationConfig: { maxOutputTokens: 64 } }),
  });
  delete r.body;
  return { model, ...r };
}

// المصوّر: هل النموذج موجود ومتاح لهذا المفتاح؟ (بدون توليد وبدون تكلفة)
export async function checkImageModel(env) {
  const model = imageModel(env);
  const r = await call(env, `${API}${encodeURIComponent(model)}`, { method: 'GET' });
  delete r.body;
  return { model, ...r };
}

// المصوّر: توليد صورة تجريبية فعلية (تكلفة صورة واحدة) للتأكد من الفوترة
export async function tryImage(env) {
  const model = imageModel(env);
  const r = await call(env, `${API}${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'A simple handmade palm-leaf basket on a plain white background, product photo.' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    }),
  });
  if (r.ok) {
    let img = null;
    try {
      const j = JSON.parse(r.body);
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const p = parts.find((x) => x.inlineData || x.inline_data);
      const d = p && (p.inlineData || p.inline_data);
      if (d && d.data) img = `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}`;
    } catch {}
    delete r.body;
    if (!img) return { model, ok: false, code: 'no_image', status: r.status, detail: '' };
    return { model, ...r, image: img };
  }
  delete r.body;
  return { model, ...r };
}

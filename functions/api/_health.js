// فحص الربط من لوحة المالك: يحدد سبب المشكلة بدقة (المفتاح، القيود، النموذج، الفوترة)
import { geminiCode, openaiCode, geminiImageModel, openaiImageModel, generate } from './_imagegen.js';
export { geminiCode as classify };
const GAPI = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const textModel = (env) => env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';

const detailOf = (t) => { try { return String(((JSON.parse(t).error) || {}).message || '').slice(0, 300); } catch { return ''; } };

async function call(url, init, codeFn) {
  try {
    const r = await fetch(url, init);
    const t = await r.text().catch(() => '');
    if (r.ok) return { ok: true, code: 'ok', status: r.status, detail: '' };
    return { ok: false, code: codeFn(r.status, t), status: r.status, detail: detailOf(t) };
  } catch (e) {
    return { ok: false, code: 'network', status: 0, detail: String(e && e.message || '').slice(0, 200) };
  }
}
const gHead = (env) => ({ 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' });

// المساعد: طلب نصي صغير جداً
export async function checkText(env) {
  const model = textModel(env);
  if (!env.GEMINI_API_KEY) return { model, ok: false, code: 'missing_key', status: 0, detail: '' };
  return { model, ...(await call(`${GAPI}${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: gHead(env),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'اكتب كلمة واحدة: تم' }] }], generationConfig: { maxOutputTokens: 64 } }),
  }, geminiCode)) };
}

// نموذج جيمني للصور: موجود ومتاح لهذا المفتاح؟ (بدون توليد وبدون تكلفة)
export async function checkImageModel(env) {
  const model = geminiImageModel(env);
  if (!env.GEMINI_API_KEY) return { model, ok: false, code: 'missing_key', status: 0, detail: '' };
  return { model, ...(await call(`${GAPI}${encodeURIComponent(model)}`, { method: 'GET', headers: gHead(env) }, geminiCode)) };
}

// نموذج OpenAI للصور (إن وُجد مفتاح): موجود ومتاح؟ (بدون تكلفة)
export async function checkOpenAI(env) {
  const model = openaiImageModel(env);
  if (!env.OPENAI_API_KEY) return { model, ok: false, code: 'missing_key', status: 0, detail: '' };
  return { model, ...(await call(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { method: 'GET', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } }, openaiCode)) };
}

// توليد صورة تجريبية فعلية (تكلفة صورة واحدة) للتأكد من الفوترة
export async function tryImage(env, p = 'gemini') {
  const r = await generate(p, env, { prompt: 'A simple handmade palm-leaf basket on a plain white background, product photo.', image: null, ratio: '1:1' });
  if (r.ok) return { ok: true, code: 'ok', model: r.model, image: `data:${r.mime};base64,${r.data}` };
  return r;
}

// إشعار تلقائي من ميسّر عند تغيّر حالة الدفع.
// ما نثق بمحتوى الإشعار: نجيب العملية من ميسّر نفسه بالمفتاح السري ثم نطبقها.
import { json, fail, readJson, moyasarPayment, applyMoyasarPayment, timingSafeEqual, missingEnv } from '../_lib.js';

export async function onRequestPost({ request, env }) {
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MOYASAR_SECRET_KEY', 'MOYASAR_WEBHOOK_SECRET']);
  if (miss) return miss;
  const { body, error } = await readJson(request, 256 * 1024);
  if (error) return fail('bad_request', 400);
  if (!timingSafeEqual(body.secret_token, env.MOYASAR_WEBHOOK_SECRET)) return fail('forbidden', 403);

  const id = body.data && body.data.id;
  if (!id || !String(body.type || '').startsWith('payment_')) return json({ ok: true, ignored: true });

  const p = await moyasarPayment(env, id);
  if (!p) return fail('payment_not_found', 404); // ميسّر يعيد المحاولة لاحقاً
  const r = await applyMoyasarPayment(env, p);
  return json({ ok: true, applied: !!(r && r.applied), reason: r && r.reason });
}

// بعد الدفع يرجع الحرفي للموقع ومعه رقم العملية. هنا نتحقق منها عند ميسّر بالمفتاح السري.
import { json, fail, getUser, readJson, moyasarPayment, applyMoyasarPayment, missingEnv } from '../_lib.js';

export async function onRequestPost({ request, env }) {
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'MOYASAR_SECRET_KEY']);
  if (miss) return miss;
  const user = await getUser(request, env);
  if (!user) return fail('session_expired', 401);
  const { body, error } = await readJson(request, 4096);
  if (error) return fail('bad_request', 400);

  const p = await moyasarPayment(env, body.id);
  if (!p) return fail('payment_not_found', 404);
  if ((p.metadata || {}).user_id !== user.id) return fail('not_your_payment', 403);

  const r = await applyMoyasarPayment(env, p);
  return json({
    status: p.status,
    applied: !!(r && r.applied),
    reason: r && r.reason,
    message: (p.source && p.source.message) || '',
    product: (p.metadata || {}).product || '',
  });
}

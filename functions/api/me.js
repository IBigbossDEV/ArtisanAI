// حالة حساب الحرفي: خطته ورصيده هذا الشهر
import { json, fail, db, isAdmin, missingEnv } from './_lib.js';
import { identify, guestState } from './_quota.js';

export async function onRequestGet({ request, env }) {
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (miss) return miss;
  const who = await identify(request, env);
  if (!who) return fail('session_expired', 401);
  if (who.guest) return json(await guestState(env, who));
  const user = who.user;
  const d = db(env);
  const rows = await d.rpc('plan_state', { p_user: user.id });
  const payments = [];
  const s = (rows && rows[0]) || {};
  return json({
    id: user.id,
    email: user.email || '',
    name: (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || '',
    isAdmin: isAdmin(env, user),
    plan: s.plan || 'free',
    cycleEnd: s.cycle_end || null,
    periodEnd: s.period_end || null,
    chat: { used: s.chat_used || 0, limit: s.chat_limit || 0 },
    images: { used: s.images_used || 0, limit: s.images_limit || 0, extra: s.extra_images || 0 },
    payments: payments.map((p) => ({ id: p.id, product: p.product, amount: p.amount, ok: !!p.applied_at, status: p.status, at: p.created_at })),
  });
}

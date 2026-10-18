// من يطلب؟ حرفي مسجّل (رصيد شهري) أو زائر (رصيد يومي لكل جهاز، عند تفعيل GUEST_MODE=1)
import { db, getUser, getPlans } from './_lib.js';

export const guestOn = (env) => env.GUEST_MODE === '1';
export const GUEST_DEFAULTS = { chat: 10, images: 2, dayChat: 300, dayImages: 40 };
const IP_FACTOR = 4; // نفس الشبكة قد يستخدمها أكثر من شخص (شبكات الجوال)

export async function guestLimits(env) {
  let p = null; try { p = await getPlans(env); } catch {}
  const g = (p && p.guest) || {};
  const out = { ...GUEST_DEFAULTS };
  for (const k of Object.keys(GUEST_DEFAULTS)) if (Number.isFinite(Number(g[k]))) out[k] = Math.max(0, Math.round(Number(g[k])));
  return out;
}

const devOf = (request) => {
  const v = String(request.headers.get('x-guest-id') || '');
  return /^[A-Za-z0-9-]{16,64}$/.test(v) ? v : '';
};

// يرجع { user } أو { guest: { dev, ip } } أو null (يحتاج دخول)
export async function identify(request, env) {
  const user = await getUser(request, env);
  if (user) return { user };
  if (!guestOn(env)) return null;
  const tok = String(request.headers.get('authorization') || '').replace(/^Bearer\s*/i, '').trim();
  if (tok) return null; // معه جلسة لكنها انتهت: يرجع لشاشة الدخول، لا نعامله كزائر
  const dev = devOf(request);
  if (!dev) return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return { guest: { dev: 'd:' + dev, ip: 'ip:' + ip } };
}

// يخصم طلباً (kind = chat | image). يرجع { ok, remaining, refund } أو { ok:false, ... }
export async function consume(env, who, kind) {
  const d = db(env);
  if (who.user) {
    const q = await d.rpc('consume_quota', { p_user: who.user.id, p_kind: kind });
    if (!q || !q.ok) return { ok: false, plan: q && q.plan };
    return { ok: true, remaining: q.remaining, refund: () => d.rpc('refund_quota', { p_user: who.user.id, p_kind: kind, p_source: q.source, p_cycle: q.cycle }).catch(() => {}) };
  }
  const k = kind === 'image' ? 'images' : 'chat';
  const L = await guestLimits(env);
  let q;
  try {
    q = await d.rpc('guest_consume', { p_dev: who.guest.dev, p_ip: who.guest.ip, p_kind: k, p_limit: L[k], p_ip_limit: L[k] * IP_FACTOR, p_global: k === 'chat' ? L.dayChat : L.dayImages });
  } catch (e) {
    console.log('guest_consume failed (شغّل supabase/guest.sql)', String(e && e.message || '').slice(0, 200));
    return { ok: false, setup: true };
  }
  if (!q || !q.ok) return { ok: false, guest: true, reason: (q && q.reason) || 'device' };
  return { ok: true, remaining: q.remaining, refund: () => d.rpc('guest_refund', { p_dev: who.guest.dev, p_ip: who.guest.ip, p_kind: k, p_day: q.day }).catch(() => {}) };
}

// حالة الزائر لصفحة "رصيدي"
export async function guestState(env, who) {
  const L = await guestLimits(env);
  let s = { chat: 0, images: 0, cycle_end: null };
  try { s = (await db(env).rpc('guest_state', { p_dev: who.guest.dev })) || s; } catch {}
  return {
    guest: true, id: null, email: '', name: '', isAdmin: false, plan: 'free',
    cycleEnd: s.cycle_end, periodEnd: null,
    chat: { used: Math.min(s.chat || 0, L.chat), limit: L.chat },
    images: { used: Math.min(s.images || 0, L.images), limit: L.images, extra: 0 },
    payments: [],
  };
}

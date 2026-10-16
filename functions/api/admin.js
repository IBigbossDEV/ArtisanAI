// لوحة صاحب المنصة (نسخة الجمعية): الأرقام، الحرفيين، والحدود الشهرية. لا توجد مدفوعات.
// مسموحة فقط للإيميلات المكتوبة في ADMIN_EMAILS.
import { json, fail, db, getUser, isAdmin, readJson, getPlans, missingEnv } from './_lib.js';

const int = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const PAGE_KEYS = ['terms', 'privacy', 'contact'];

async function guard(request, env) {
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (miss) return { res: miss };
  const user = await getUser(request, env);
  if (!user) return { res: fail('session_expired', 401) };
  if (!isAdmin(env, user)) return { res: fail('not_granted', 403) };
  return { user };
}

export async function onRequestGet({ request, env }) {
  const g = await guard(request, env); if (g.res) return g.res;
  const d = db(env);
  const url = new URL(request.url);
  const view = url.searchParams.get('view') || 'stats';

  if (view === 'stats') {
    const [stats, plans, pages] = await Promise.all([
      d.rpc('admin_stats'), getPlans(env),
      d.select('app_settings', 'key=eq.pages&select=value').then((r) => (r[0] ? r[0].value : {})),
    ]);
    return json({ stats, plans, pages });
  }
  if (view === 'users') {
    const q = (url.searchParams.get('q') || '').slice(0, 80).replace(/[%_,()]/g, '');
    return json({ users: await d.rpc('admin_users', { p_search: q, p_limit: 300 }) });
  }
  return fail('bad_request', 400);
}

export async function onRequestPost({ request, env }) {
  const g = await guard(request, env); if (g.res) return g.res;
  const d = db(env);
  const { body, error } = await readJson(request, 200 * 1024);
  if (error) return fail('bad_request', 400);
  const uid = /^[0-9a-f-]{36}$/i.test(body.user_id || '') ? body.user_id : null;

  // منح رصيد موسّع لحرفي (يستخدم حدود "pro" في الإعدادات)
  if (body.action === 'grant') {
    const months = int(body.months, 1, 36);
    if (!uid || !months) return fail('bad_request', 400);
    await d.rpc('extend_pro', { p_user: uid, p_months: months });
    return json({ ok: true });
  }
  if (body.action === 'images') {
    const n = int(body.count, -1000, 1000);
    if (!uid || n === null) return fail('bad_request', 400);
    const rows = await d.select('accounts', `user_id=eq.${uid}&select=extra_images`);
    if (!rows.length) return fail('not_found', 404);
    await d.update('accounts', `user_id=eq.${uid}`, { extra_images: Math.max(0, rows[0].extra_images + n), updated_at: new Date().toISOString() });
    return json({ ok: true });
  }
  if (body.action === 'revoke') {
    if (!uid) return fail('bad_request', 400);
    await d.update('accounts', `user_id=eq.${uid}`, { plan: 'free', period_end: new Date().toISOString(), updated_at: new Date().toISOString() });
    return json({ ok: true });
  }

  // تعديل الأسعار والحدود
  if (body.action === 'plans') {
    const cur = await getPlans(env);
    const p = body.plans || {};
    const next = JSON.parse(JSON.stringify(cur));
    for (const tier of ['free', 'pro']) for (const k of ['chat', 'images']) {
      if (p[tier] && p[tier][k] !== undefined) { const v = int(p[tier][k], 0, 100000); if (v === null) return fail('bad_value', 400, { field: `${tier}.${k}` }); next[tier][k] = v; }
    }
    for (const key of Object.keys(next.products || {})) {
      const src = (p.products || {})[key]; if (!src) continue;
      const dst = next.products[key];
      if (src.amount !== undefined) { const v = int(src.amount, 100, 10000000); if (v === null) return fail('bad_value', 400, { field: key + '.amount' }); dst.amount = v; }
      if (src.label !== undefined) dst.label = String(src.label).slice(0, 60);
      if (dst.months !== undefined && src.months !== undefined) { const v = int(src.months, 1, 36); if (v === null) return fail('bad_value', 400, { field: key + '.months' }); dst.months = v; }
      if (dst.images !== undefined && src.images !== undefined) { const v = int(src.images, 1, 1000); if (v === null) return fail('bad_value', 400, { field: key + '.images' }); dst.images = v; }
    }
    await d.upsert('app_settings', [{ key: 'plans', value: next, updated_at: new Date().toISOString() }], 'key');
    return json({ ok: true, plans: next });
  }

  // نصوص الصفحات القانونية (فارغ = النص الافتراضي)
  if (body.action === 'pages') {
    const pages = {};
    for (const k of PAGE_KEYS) pages[k] = String((body.pages || {})[k] || '').slice(0, 30000);
    await d.upsert('app_settings', [{ key: 'pages', value: pages, updated_at: new Date().toISOString() }], 'key');
    return json({ ok: true });
  }

  return fail('bad_request', 400);
}

// لوحة صاحب المنصة (نسخة الجمعية): الأرقام، الحرفيين، والحدود الشهرية. لا توجد مدفوعات.
// مسموحة فقط للإيميلات المكتوبة في ADMIN_EMAILS.
import { json, fail, db, getUser, isAdmin, readJson, getPlans, missingEnv, authAdmin } from './_lib.js';
import { checkText, checkImageModel, checkOpenAI, tryImage } from './_health.js';
import { provider, generate, buildPrompt, RATIOS } from './_imagegen.js';
import { guestOn, guestLimits, GUEST_DEFAULTS } from './_quota.js';

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
    return json({ stats, plans, pages, guestMode: guestOn(env), guestLimits: await guestLimits(env) });
  }
  if (view === 'users') {
    const q = (url.searchParams.get('q') || '').slice(0, 80).replace(/[%_,()]/g, '');
    return json({ users: await d.rpc('admin_users', { p_search: q, p_limit: 300 }) });
  }
  if (view === 'health') {
    const prov = provider(env);
    const need = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', 'ADMIN_EMAILS'].concat(prov === 'openai' ? ['OPENAI_API_KEY'] : []);
    const missing = need.filter((k) => !env[k]);
    let supabase = { ok: true };
    try { await d.select('app_settings', 'select=key&limit=1'); } catch (e) { supabase = { ok: false, detail: String(e.message || '').slice(0, 200) }; }
    const [text, image, openai] = await Promise.all([checkText(env), checkImageModel(env), env.OPENAI_API_KEY ? checkOpenAI(env) : null]);
    let guest = { on: guestOn(env), ok: true };
    if (guest.on) { try { await d.rpc('guest_state', { p_dev: 'd:health-check' }); } catch (e) { guest = { on: true, ok: false, detail: String(e.message || '').slice(0, 200) }; } }
    return json({ missing, supabase, text, image, openai, provider: prov, guest });
  }
  return fail('bad_request', 400);
}

export async function onRequestPost({ request, env }) {
  const g = await guard(request, env); if (g.res) return g.res;
  const d = db(env);
  const { body, error } = await readJson(request, 6 * 1024 * 1024); // كبير بسبب صورة المقارنة
  if (error) return fail('bad_request', 400);
  const uid = /^[0-9a-f-]{36}$/i.test(body.user_id || '') ? body.user_id : null;

  // تجربة توليد صورة فعلية من لوحة المالك (لا تُخصم من رصيد أحد)
  if (body.action === 'health_image') return json(await tryImage(env, body.provider === 'openai' ? 'openai' : 'gemini'));

  // مقارنة جيمني وOpenAI على صورة منتج حقيقية (لا تُخصم من رصيد أحد، وتُحسب صورتين على المفاتيح)
  if (body.action === 'compare_image') {
    const img = body.image;
    if (!img || typeof img.data !== 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(img.media_type) || img.data.length > 5_000_000) return fail('image_rejected', 400);
    const ratio = RATIOS.includes(body.ratio) ? body.ratio : '1:1';
    const prompt = buildPrompt({ instruction: body.instruction, scene: body.scene, name: body.name });
    const run = async (p) => {
      const t0 = Date.now();
      const r = await generate(p, env, { prompt, image: img, ratio, user: g.user.id });
      const ms = Date.now() - t0;
      return r.ok ? { ok: true, model: r.model, ms, image: `data:${r.mime};base64,${r.data}` } : { ...r, ms };
    };
    const [gemini, openai] = await Promise.all([run('gemini'), run('openai')]);
    return json({ gemini, openai });
  }

  // حسابات الحرفيين: الجمعية تنشئ الحساب وكلمة المرور (لا يوجد تسجيل ذاتي)
  const passOk = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72;
  const authFail = (r) => {
    const why = `${r.code} ${r.msg}`;
    if (/email_exists|already been registered|already registered/i.test(why)) return fail('email_exists', 409);
    if (/weak_password|password/i.test(why)) return fail('weak_password', 400);
    if (r.status === 404) return fail('not_found', 404);
    return fail('auth_error', 502, { status: r.status });
  };
  if (body.action === 'create_user') {
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return fail('bad_email', 400);
    if (!passOk(body.password)) return fail('weak_password', 400);
    const r = await authAdmin(env).create(email, body.password, name);
    if (!r.ok) return authFail(r);
    return json({ ok: true, user_id: r.data.id || (r.data.user && r.data.user.id) || null });
  }
  if (body.action === 'set_password') {
    if (!uid) return fail('bad_request', 400);
    if (!passOk(body.password)) return fail('weak_password', 400);
    const r = await authAdmin(env).setPassword(uid, body.password);
    if (!r.ok) return authFail(r);
    return json({ ok: true });
  }
  if (body.action === 'delete_user') {
    if (!uid) return fail('bad_request', 400);
    if (uid === g.user.id) return fail('cannot_delete_self', 400);
    const r = await authAdmin(env).remove(uid);
    if (!r.ok) return authFail(r);
    return json({ ok: true });
  }

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
    if (p.guest) {
      next.guest = { ...GUEST_DEFAULTS, ...(next.guest || {}) };
      for (const k of Object.keys(GUEST_DEFAULTS)) if (p.guest[k] !== undefined) { const v = int(p.guest[k], 0, 100000); if (v === null) return fail('bad_value', 400, { field: 'guest.' + k }); next.guest[k] = v; }
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

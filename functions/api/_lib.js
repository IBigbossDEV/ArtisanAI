// أدوات مشتركة للسيرفر. الملفات اللي تبدأ بـ _ ما تصير روابط.
// كل المفاتيح السرية تُقرأ من متغيرات البيئة في Cloudflare فقط.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const fail = (code, status = 400, extra = {}) => json({ error: code, ...extra }, status);

export function missingEnv(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  return missing.length ? fail('not_configured', 500, { missing }) : null;
}

const base = (env) => String(env.SUPABASE_URL || '').replace(/\/+$/, '');

// اتصال بقاعدة البيانات بصلاحية السيرفر (service_role)
export function db(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  // المفاتيح القديمة (eyJ…) تنرسل في الهيدرين، والمفاتيح الجديدة (sb_secret_…) في apikey فقط
  const auth = String(key || '').startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {};
  const headers = (extra = {}) => ({ apikey: key, ...auth, 'content-type': 'application/json', ...extra });
  const check = async (r, what) => {
    if (r.ok) return r;
    const t = await r.text().catch(() => '');
    throw new Error(`${what} ${r.status}: ${t.slice(0, 300)}`);
  };
  return {
    async rpc(fn, args = {}) {
      const r = await check(await fetch(`${base(env)}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(), body: JSON.stringify(args) }), 'rpc ' + fn);
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    },
    async select(table, query) {
      const r = await check(await fetch(`${base(env)}/rest/v1/${table}?${query}`, { headers: headers() }), 'select ' + table);
      return r.json();
    },
    async count(table, query) {
      const r = await check(await fetch(`${base(env)}/rest/v1/${table}?${query}&select=*`, { method: 'HEAD', headers: headers({ prefer: 'count=exact' }) }), 'count ' + table);
      const range = r.headers.get('content-range') || '';
      return Number(range.split('/')[1]) || 0;
    },
    async upsert(table, rows, onConflict) {
      const q = onConflict ? `?on_conflict=${onConflict}` : '';
      await check(await fetch(`${base(env)}/rest/v1/${table}${q}`, {
        method: 'POST', headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows),
      }), 'upsert ' + table);
    },
    async insert(table, rows) {
      await check(await fetch(`${base(env)}/rest/v1/${table}`, {
        method: 'POST', headers: headers({ prefer: 'return=minimal' }), body: JSON.stringify(rows),
      }), 'insert ' + table);
    },
    async update(table, query, patch) {
      await check(await fetch(`${base(env)}/rest/v1/${table}?${query}`, {
        method: 'PATCH', headers: headers({ prefer: 'return=minimal' }), body: JSON.stringify(patch),
      }), 'update ' + table);
    },
    async remove(table, query) {
      await check(await fetch(`${base(env)}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: headers({ prefer: 'return=minimal' }) }), 'delete ' + table);
    },
  };
}

// يتأكد من دخول الحرفي عن طريق Supabase (التوكن يرسله المتصفح في Authorization)
export async function getUser(request, env) {
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const r = await fetch(`${base(env)}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
  // 401/403 = الجلسة منتهية فعلاً. أي خطأ آخر (تعطل مؤقت في Supabase) لا يعني خروج الحرفي،
  // فنرمي خطأ يتحول إلى unavailable بدل session_expired حتى لا يُسجَّل خروجه بلا داعٍ.
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error('auth ' + r.status);
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

export function isAdmin(env, user) {
  if (!user || !user.email) return false;
  // لا نعطي صلاحية المالك لبريد لم يتأكد صاحبه منه
  if (!user.email_confirmed_at && !user.confirmed_at) return false;
  const list = String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(user.email).toLowerCase());
}

// يقرأ JSON من الطلب مع حد أعلى للحجم
export async function readJson(request, maxBytes) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) return { error: 'too_large' };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) return { error: 'too_large' };   // بالبايت (الحرف العربي = 2 بايت)
  const text = new TextDecoder().decode(buf);
  try { return { body: JSON.parse(text) }; } catch { return { error: 'bad_json' }; }
}

export async function getPlans(env) {
  const rows = await db(env).select('app_settings', 'key=eq.plans&select=value');
  return rows && rows[0] ? rows[0].value : null;
}

// يسجّل الطلب في سجل الاستهلاك بدون ما يأخر الرد
export function logAi(env, waitUntil, row) {
  const p = db(env).insert('ai_log', [row]).catch(() => {});
  if (waitUntil) waitUntil(p);
}

export function timingSafeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

// ميسّر: جلب عملية دفع من السيرفر بالمفتاح السري
export async function moyasarPayment(env, id) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(id || ''))) return null;
  const r = await fetch(`https://api.moyasar.com/v1/payments/${id}`, {
    headers: { authorization: 'Basic ' + btoa(env.MOYASAR_SECRET_KEY + ':') },
  });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error('moyasar ' + r.status); // تعطل مؤقت: لا نعامله كدفع غير موجود
  return r.json();
}

// يطبق عملية دفع من ميسّر على حساب الحرفي (مرة وحدة فقط)
export async function applyMoyasarPayment(env, p) {
  const md = p.metadata || {};
  const userId = /^[0-9a-f-]{36}$/i.test(md.user_id || '') ? md.user_id : null;
  const src = p.source || {};
  return db(env).rpc('apply_payment', {
    p_id: p.id,
    p_user: userId,
    p_product: md.product || null,
    p_amount: Number(p.amount) || 0,
    p_currency: String(p.currency || ''),
    p_status: String(p.status || ''),
    p_live: !String(env.MOYASAR_SECRET_KEY || '').startsWith('sk_test_'),
    p_method: src.type || null,
    p_raw: { id: p.id, status: p.status, amount: p.amount, currency: p.currency, created_at: p.created_at,
             source: { type: src.type, company: src.company, number: src.number }, metadata: md },
  });
}

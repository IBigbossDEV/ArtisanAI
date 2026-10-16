// مخزن بيانات الأدوات: بيانات الحرفي الخاصة + المجتمع
// صيغة المسار مثل: data/users/<id>/main  أو  catalog/<id>
import { json, fail, db, getUser, isAdmin, readJson, missingEnv } from './_lib.js';

const MAX_BODY = 600 * 1024;          // أكبر مستند (المنتجات والطلبات بدون الصور)
const MAX_USER_DOCS = 500;            // حد مستندات الحرفي الخاصة (صور المنتجات تحسب)
const MAX_USER_BYTES = 15 * 1024 * 1024; // مساحة كل حرفي (حوالي 300 صورة منتج)، حتى لا يملأ حساب واحد المخزن
const MAX_FEEDBACK = 64 * 1024;       // مستند الآراء صغير دائماً
const ID_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/;  // بدون '..'

// يحدد المجموعة ورقم المستند، ويرجع null إذا المسار غير مسموح
function parse(path, isDoc) {
  const parts = String(path || '').split('/').filter(Boolean);
  if (parts.some((p) => !ID_RE.test(p))) return null;
  if (isDoc) {
    if (parts.length < 2) return null;
    return { collection: parts.slice(0, -1).join('/'), id: parts[parts.length - 1] };
  }
  return { collection: parts.join('/'), id: null };
}

function rules(collection, user, admin) {
  const own = collection.match(/^data\/users\/([0-9a-f-]{36})$/i);
  if (own) {
    const mine = own[1].toLowerCase() === user.id.toLowerCase();
    return { readDoc: mine, list: mine, write: () => mine, private: true };
  }
  // آراء المجرّبين: كل حرفي يكتب مستنده فقط، والمالك وحده يقرأ الجميع
  if (collection === 'feedback') return { readDoc: true, readDocCheck: (id) => admin || id === user.id, list: admin, write: (id) => id === user.id, maxBytes: MAX_FEEDBACK };
  // أي مجموعة أخرى مرفوضة (أدوات المجتمع القديمة حُذفت من التطبيق)
  return null;
}

export async function onRequestPost({ request, env }) {
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (miss) return miss;
  const user = await getUser(request, env);
  if (!user) return fail('session_expired', 401);
  const admin = isAdmin(env, user);

  const { body, error } = await readJson(request, MAX_BODY);
  if (error) return fail(error === 'too_large' ? 'invalid_argument' : 'bad_request', 400);
  const op = body.op;
  const loc = parse(body.path, op !== 'list');
  if (!loc) return fail('invalid_argument', 400);
  const rule = rules(loc.collection, user, admin);
  if (!rule) return fail('not_granted', 403);
  const d = db(env);
  const c = encodeURIComponent(loc.collection);

  if (op === 'get') {
    if (!rule.readDoc || (rule.readDocCheck && !rule.readDocCheck(loc.id))) return fail('not_granted', 403);
    const rows = await d.select('docs', `collection=eq.${c}&doc_id=eq.${encodeURIComponent(loc.id)}&select=data`);
    return json(rows.length ? { exists: true, data: rows[0].data } : { exists: false, data: null });
  }

  if (op === 'list') {
    if (!rule.list) return fail('not_granted', 403);
    const rows = await d.select('docs', `collection=eq.${c}&select=doc_id,data&order=updated_at.desc&limit=1000`);
    return json({ docs: rows.map((r) => ({ id: r.doc_id, data: r.data })) });
  }

  if (op === 'set') {
    if (!rule.write(loc.id)) return fail('not_granted', 403);
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return fail('invalid_argument', 400);
    const size = new TextEncoder().encode(JSON.stringify(body.data)).length;
    if (rule.maxBytes && size > rule.maxBytes) return fail('invalid_argument', 400, { reason: 'too_large' });
    if (rule.private) {
      // نحسب المستندات الأخرى فقط، لأن هذا المستند سيُستبدل إن كان موجوداً
      const u = (await d.rpc('docs_usage', { p_user: user.id, p_collection: loc.collection, p_except: loc.id })) || {};
      if ((u.count || 0) >= MAX_USER_DOCS) return fail('invalid_argument', 400, { reason: 'too_many_docs' });
      if ((u.bytes || 0) + size > MAX_USER_BYTES) return fail('invalid_argument', 400, { reason: 'storage_full' });
    }
    await d.upsert('docs', [{ collection: loc.collection, doc_id: loc.id, owner: user.id, data: body.data, updated_at: new Date().toISOString() }], 'collection,doc_id');
    return json({ ok: true });
  }

  if (op === 'delete') {
    if (!rule.write(loc.id)) return fail('not_granted', 403);
    await d.remove('docs', `collection=eq.${c}&doc_id=eq.${encodeURIComponent(loc.id)}`);
    return json({ ok: true });
  }

  return fail('bad_request', 400);
}

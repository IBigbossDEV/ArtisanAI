// مخزن بيانات الأدوات: بيانات الحرفي الخاصة + المجتمع
// صيغة المسار مثل: data/users/<id>/main  أو  catalog/<id>
import { json, fail, db, getUser, isAdmin, readJson, missingEnv } from './_lib.js';

const MAX_BODY = 600 * 1024;          // أكبر مستند (المنتجات والطلبات بدون الصور)
const MAX_USER_DOCS = 500;            // حد مستندات الحرفي الخاصة (صور المنتجات تحسب)
const SHARED = ['catalog', 'progress', 'qa', 'suppliers', 'feedback', 'bigorders'];
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
  if (!SHARED.includes(collection)) return null;
  if (collection === 'feedback') return { readDoc: true, readDocCheck: (id) => admin || id === user.id, list: admin, write: (id) => id === user.id };
  if (collection === 'bigorders') return { readDoc: true, list: true, write: () => admin };
  // باقي المجتمع: الكل يقرأ، وكل حرفي يكتب مستنده فقط
  return { readDoc: true, list: true, write: (id) => id === user.id || admin };
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
    if (rule.private) {
      const n = await d.count('docs', `owner=eq.${user.id}&collection=eq.${c}`);
      if (n >= MAX_USER_DOCS) {
        const exists = await d.select('docs', `collection=eq.${c}&doc_id=eq.${encodeURIComponent(loc.id)}&select=doc_id`);
        if (!exists.length) return fail('invalid_argument', 400, { reason: 'too_many_docs' });
      }
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

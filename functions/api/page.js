// نص صفحة قانونية إذا عدّله المالك من لوحته (وإلا تعرض الصفحة نصها الافتراضي)
import { json, db } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const slug = new URL(request.url).searchParams.get('slug');
  if (!['terms', 'privacy', 'contact'].includes(slug)) return json({ text: '' });
  try {
    const rows = await db(env).select('app_settings', 'key=eq.pages&select=value');
    const text = rows[0] && rows[0].value ? String(rows[0].value[slug] || '') : '';
    return json({ text }, 200, { 'cache-control': 'public, max-age=120' });
  } catch {
    return json({ text: '' });
  }
}

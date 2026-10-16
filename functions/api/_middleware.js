// يلتقط أي خطأ غير متوقع في السيرفر (مثل تعطل مؤقت في قاعدة البيانات)
// ويرجعه برسالة واضحة بدل صفحة خطأ، حتى يعرف الموقع أنه عطل مؤقت وليس خروجاً من الحساب.
import { fail } from './_lib.js';

export async function onRequest({ next }) {
  try {
    return await next();
  } catch (e) {
    console.error('api error:', e && e.message);
    return fail('unavailable', 503);
  }
}

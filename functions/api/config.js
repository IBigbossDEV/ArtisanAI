// إعدادات عامة يحتاجها المتصفح قبل الدخول (كلها مفاتيح عامة، ما فيها أسرار)
import { json, getPlans, missingEnv } from './_lib.js';

export async function onRequestGet({ env }) {
  const miss = missingEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (miss) return miss;
  let plans = null;
  try { plans = await getPlans(env); } catch {}
  return json({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    edition: 'association',
    appleLogin: env.ENABLE_APPLE_LOGIN === '1',
    googleLogin: env.ENABLE_GOOGLE_LOGIN !== '0',
    guestMode: env.GUEST_MODE === '1',
    plans,
  }, 200, { 'cache-control': 'public, max-age=60' });
}

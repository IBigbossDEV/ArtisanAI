-- ============================================================
-- منصة الحرفي السعودي — النسخة المدفوعة
-- قاعدة البيانات في Supabase
--
-- طريقة التشغيل: Supabase ← SQL Editor ← New query ← الصق الملف كامل ← Run
-- آمن لو شغّلته أكثر من مرة.
--
-- مبدأ الأمان: كل الجداول مقفلة على المتصفح (RLS بدون سياسات)،
-- والوصول لها من السيرفر فقط بمفتاح service_role.
-- ============================================================

-- ---------- 1) الإعدادات: الأسعار والحدود (تتعدل من لوحة المالك) ----------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- المبالغ بالهللة: 2900 = 29 ريال
insert into public.app_settings (key, value) values ('plans', '{
  "free": { "chat": 10,  "images": 2  },
  "pro":  { "chat": 150, "images": 30 },
  "products": {
    "pro_monthly": { "amount": 2900,  "months": 1,  "label": "المحترف — شهر" },
    "pro_yearly":  { "amount": 24900, "months": 12, "label": "المحترف — سنة" },
    "images_20":   { "amount": 900,   "images": 20, "label": "باقة 20 صورة إضافية" }
  }
}'::jsonb)
on conflict (key) do nothing;

-- ---------- 2) حساب كل حرفي وخطته ----------
create table if not exists public.accounts (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text,
  name         text,
  plan         text not null default 'free' check (plan in ('free', 'pro')),
  period_start timestamptz,
  period_end   timestamptz,
  extra_images int not null default 0 check (extra_images >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ينشئ الحساب تلقائياً أول ما يسجل الحرفي
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (user_id, email, name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'))
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- للمستخدمين اللي سجلوا قبل تشغيل الملف
insert into public.accounts (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;

-- ---------- 3) عدّاد الاستهلاك لكل دورة ----------
-- الدورة: للمجاني الشهر الميلادي بتوقيت الرياض (2026-10)،
-- وللمحترف كل شهر من تاريخ اشتراكه (p2026-10-15).
create table if not exists public.usage_counters (
  user_id     uuid not null references auth.users (id) on delete cascade,
  cycle       text not null,
  chat_used   int  not null default 0,
  images_used int  not null default 0,
  primary key (user_id, cycle)
);

-- ---------- 4) المدفوعات (رقم العملية من ميسّر) ----------
create table if not exists public.payments (
  id         text primary key,
  user_id    uuid references auth.users (id) on delete set null,
  product    text not null,
  amount     int  not null,
  currency   text not null default 'SAR',
  status     text not null,
  live       boolean,
  method     text,
  note       text,
  applied_at timestamptz,
  raw        jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payments_user_idx on public.payments (user_id);
create index if not exists payments_created_idx on public.payments (created_at desc);

-- ---------- 5) مخزن بيانات الأدوات (منتجات، طلبات، المجتمع…) ----------
-- مثال: collection = 'data/users/<id>' و doc_id = 'main'
create table if not exists public.docs (
  collection text not null,
  doc_id     text not null,
  owner      uuid references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, doc_id)
);
create index if not exists docs_owner_idx on public.docs (owner);

-- ---------- 6) سجل طلبات الذكاء الاصطناعي (للوحة الاستهلاك) ----------
create table if not exists public.ai_log (
  id            bigint generated always as identity primary key,
  user_id       uuid references auth.users (id) on delete set null,
  kind          text not null,          -- chat | image
  model         text,
  input_tokens  int,
  output_tokens int,
  ok            boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists ai_log_created_idx on public.ai_log (created_at desc);

-- ---------- 7) قفل الجداول على المتصفح ----------
alter table public.app_settings   enable row level security;
alter table public.accounts       enable row level security;
alter table public.usage_counters enable row level security;
alter table public.payments       enable row level security;
alter table public.docs           enable row level security;
alter table public.ai_log         enable row level security;
revoke all on public.app_settings, public.accounts, public.usage_counters,
              public.payments, public.docs, public.ai_log
  from anon, authenticated;

-- ============================================================
-- الدوال (يستدعيها السيرفر فقط)
-- ============================================================

-- حالة خطة الحرفي ودورته الحالية واستهلاكه
create or replace function public.plan_state(p_user uuid)
returns table (
  plan text, cycle text, cycle_end timestamptz, period_end timestamptz,
  chat_limit int, images_limit int, chat_used int, images_used int, extra_images int
)
language plpgsql security definer set search_path = public as $$
declare
  a      public.accounts;
  s      jsonb;
  k      int;
  cstart timestamptz;
  local_now timestamp := now() at time zone 'Asia/Riyadh';
begin
  select * into a from public.accounts where user_id = p_user;
  if not found then
    insert into public.accounts (user_id) values (p_user) on conflict do nothing;
    select * into a from public.accounts where user_id = p_user;
  end if;
  select value into s from public.app_settings where key = 'plans';

  if a.plan = 'pro' and a.period_end > now() then
    plan := 'pro';
    k := (extract(year from age(now(), a.period_start)) * 12
        + extract(month from age(now(), a.period_start)))::int;
    cstart := a.period_start + make_interval(months => k);
    cycle := 'p' || to_char(cstart at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
    cycle_end := least(cstart + interval '1 month', a.period_end);
    chat_limit := (s -> 'pro' ->> 'chat')::int;
    images_limit := (s -> 'pro' ->> 'images')::int;
  else
    plan := 'free';
    cycle := to_char(local_now, 'YYYY-MM');
    cycle_end := (date_trunc('month', local_now) + interval '1 month') at time zone 'Asia/Riyadh';
    chat_limit := (s -> 'free' ->> 'chat')::int;
    images_limit := (s -> 'free' ->> 'images')::int;
  end if;

  period_end := a.period_end;
  extra_images := a.extra_images;
  select coalesce(u.chat_used, 0), coalesce(u.images_used, 0)
    into chat_used, images_used
    from public.usage_counters u
   where u.user_id = p_user and u.cycle = plan_state.cycle;
  chat_used := coalesce(chat_used, 0);
  images_used := coalesce(images_used, 0);
  return next;
end $$;

-- يخصم طلب واحد من الرصيد. يرجع ok=false إذا خلص الرصيد.
create or replace function public.consume_quota(p_user uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st record;
  n  int;
begin
  select * into st from public.plan_state(p_user);
  insert into public.usage_counters (user_id, cycle) values (p_user, st.cycle)
    on conflict do nothing;

  if p_kind = 'chat' then
    update public.usage_counters set chat_used = chat_used + 1
     where user_id = p_user and cycle = st.cycle and chat_used < st.chat_limit
     returning chat_used into n;
    if n is null then
      return jsonb_build_object('ok', false, 'error', 'quota_exceeded', 'kind', 'chat', 'plan', st.plan);
    end if;
    return jsonb_build_object('ok', true, 'source', 'cycle', 'cycle', st.cycle,
                              'remaining', st.chat_limit - n);

  elsif p_kind = 'image' then
    update public.usage_counters set images_used = images_used + 1
     where user_id = p_user and cycle = st.cycle and images_used < st.images_limit
     returning images_used into n;
    if n is not null then
      return jsonb_build_object('ok', true, 'source', 'cycle', 'cycle', st.cycle,
                                'remaining', st.images_limit - n + st.extra_images);
    end if;
    update public.accounts set extra_images = extra_images - 1, updated_at = now()
     where user_id = p_user and extra_images > 0
     returning extra_images into n;
    if n is not null then
      return jsonb_build_object('ok', true, 'source', 'extra', 'cycle', st.cycle, 'remaining', n);
    end if;
    return jsonb_build_object('ok', false, 'error', 'quota_exceeded', 'kind', 'image', 'plan', st.plan);
  end if;

  raise exception 'unknown kind %', p_kind;
end $$;

-- يرجّع الرصيد إذا فشل الطلب من جهة Claude أو Gemini
create or replace function public.refund_quota(p_user uuid, p_kind text, p_source text, p_cycle text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_source = 'extra' then
    update public.accounts set extra_images = extra_images + 1, updated_at = now() where user_id = p_user;
  elsif p_kind = 'chat' then
    update public.usage_counters set chat_used = greatest(chat_used - 1, 0)
     where user_id = p_user and cycle = p_cycle;
  else
    update public.usage_counters set images_used = greatest(images_used - 1, 0)
     where user_id = p_user and cycle = p_cycle;
  end if;
end $$;

-- يمدد اشتراك المحترف (إذا شغّال يكمل بعده، وإذا منتهي يبدأ من الآن)
create or replace function public.extend_pro(p_user uuid, p_months int)
returns void language plpgsql security definer set search_path = public as $$
declare a public.accounts;
begin
  select * into a from public.accounts where user_id = p_user for update;
  if not found then
    insert into public.accounts (user_id) values (p_user);
    select * into a from public.accounts where user_id = p_user for update;
  end if;
  if a.plan = 'pro' and a.period_end > now() then
    update public.accounts
       set period_end = period_end + make_interval(months => p_months), updated_at = now()
     where user_id = p_user;
  else
    update public.accounts
       set plan = 'pro', period_start = now(),
           period_end = now() + make_interval(months => p_months), updated_at = now()
     where user_id = p_user;
  end if;
end $$;

-- يسجّل عملية دفع ويطبّقها مرة واحدة فقط (حتى لو وصلت من التحقق والإشعار معاً)
create or replace function public.apply_payment(
  p_id text, p_user uuid, p_product text, p_amount int, p_currency text,
  p_status text, p_live boolean, p_method text, p_raw jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prod jsonb;
  done timestamptz;
begin
  select value -> 'products' -> p_product into prod from public.app_settings where key = 'plans';

  insert into public.payments (id, user_id, product, amount, currency, status, live, method, raw)
  values (p_id, p_user, coalesce(p_product, '?'), p_amount, p_currency, p_status, p_live, p_method, p_raw)
  on conflict (id) do update set status = excluded.status, raw = excluded.raw;

  select applied_at into done from public.payments where id = p_id for update;
  if done is not null then
    return jsonb_build_object('applied', true, 'already', true);
  end if;

  if p_status <> 'paid' then
    return jsonb_build_object('applied', false, 'reason', 'not_paid');
  end if;
  if p_user is null then
    update public.payments set note = 'no_user' where id = p_id;
    return jsonb_build_object('applied', false, 'reason', 'no_user');
  end if;
  if prod is null then
    update public.payments set note = 'unknown_product' where id = p_id;
    return jsonb_build_object('applied', false, 'reason', 'unknown_product');
  end if;
  if (prod ->> 'amount')::int <> p_amount or upper(p_currency) <> 'SAR' then
    update public.payments set note = 'amount_mismatch' where id = p_id;
    return jsonb_build_object('applied', false, 'reason', 'amount_mismatch');
  end if;

  if prod ? 'months' then
    perform public.extend_pro(p_user, (prod ->> 'months')::int);
  elsif prod ? 'images' then
    update public.accounts set extra_images = extra_images + (prod ->> 'images')::int, updated_at = now()
     where user_id = p_user;
  end if;

  update public.payments set applied_at = now(), note = null where id = p_id;
  return jsonb_build_object('applied', true);
end $$;

-- ملخص لوحة المالك
create or replace function public.admin_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh';
  r jsonb;
begin
  select jsonb_build_object(
    'users_total',  (select count(*) from public.accounts),
    'users_new_30', (select count(*) from public.accounts where created_at > now() - interval '30 days'),
    'pro_active',   (select count(*) from public.accounts where plan = 'pro' and period_end > now()),
    'pro_ending_7', (select count(*) from public.accounts where plan = 'pro' and period_end between now() and now() + interval '7 days'),
    'revenue_total', (select coalesce(sum(amount), 0) from public.payments where applied_at is not null and live is not false),
    'revenue_month', (select coalesce(sum(amount), 0) from public.payments where applied_at is not null and live is not false and created_at >= month_start),
    'revenue_test',  (select coalesce(sum(amount), 0) from public.payments where applied_at is not null and live is false),
    'revenue_by_product', (select coalesce(jsonb_object_agg(product, total), '{}'::jsonb) from (
        select product, sum(amount) total from public.payments
         where applied_at is not null and live is not false group by product) x),
    'ai_30', (select coalesce(jsonb_object_agg(kind, j), '{}'::jsonb) from (
        select kind, jsonb_build_object('count', count(*), 'failed', count(*) filter (where not ok),
               'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0)) j
          from public.ai_log where created_at > now() - interval '30 days' group by kind) y),
    'ai_daily', (select coalesce(jsonb_agg(d order by d ->> 'day'), '[]'::jsonb) from (
        select jsonb_build_object('day', to_char(created_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD'),
               'chat', count(*) filter (where kind = 'chat'), 'image', count(*) filter (where kind = 'image')) d
          from public.ai_log where created_at > now() - interval '30 days'
         group by to_char(created_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD')) z),
    'payments_review', (select count(*) from public.payments where status = 'paid' and applied_at is null)
  ) into r;
  return r;
end $$;

-- قائمة الحرفيين مع خططهم واستهلاكهم
create or replace function public.admin_users(p_search text default '', p_limit int default 200)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb) from (
    select a.user_id, a.email, a.name, a.created_at, a.extra_images, a.period_end,
           s.plan, s.chat_used, s.chat_limit, s.images_used, s.images_limit,
           (select coalesce(sum(amount), 0) from public.payments p
             where p.user_id = a.user_id and p.applied_at is not null and p.live is not false) as paid_total
      from public.accounts a
      cross join lateral public.plan_state(a.user_id) s
     where p_search = '' or a.email ilike '%' || p_search || '%' or a.name ilike '%' || p_search || '%'
     order by a.created_at desc
     limit p_limit
  ) t;
$$;

-- ---------- السماح للسيرفر فقط ----------
revoke execute on function public.plan_state(uuid) from public, anon, authenticated;
revoke execute on function public.consume_quota(uuid, text) from public, anon, authenticated;
revoke execute on function public.refund_quota(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.extend_pro(uuid, int) from public, anon, authenticated;
revoke execute on function public.apply_payment(text, uuid, text, int, text, text, boolean, text, jsonb) from public, anon, authenticated;
revoke execute on function public.admin_stats() from public, anon, authenticated;
revoke execute on function public.admin_users(text, int) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.plan_state(uuid) to service_role;
grant execute on function public.consume_quota(uuid, text) to service_role;
grant execute on function public.refund_quota(uuid, text, text, text) to service_role;
grant execute on function public.extend_pro(uuid, int) to service_role;
grant execute on function public.apply_payment(text, uuid, text, int, text, text, boolean, text, jsonb) to service_role;
grant execute on function public.admin_stats() to service_role;
grant execute on function public.admin_users(text, int) to service_role;

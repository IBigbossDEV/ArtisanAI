-- ============================================================
-- وضع الزوار (الدخول بدون حساب): عدّاد يومي لكل جهاز ولكل عنوان IP، وسقف يومي للموقع كله.
-- شغّله مرة واحدة في Supabase ← SQL Editor (آمن لو تكرر تشغيله).
-- ============================================================
create table if not exists public.guest_usage (
  day    date not null,
  key    text not null,          -- d:<جهاز> أو ip:<عنوان> أو * للموقع كله
  chat   int  not null default 0,
  images int  not null default 0,
  primary key (day, key)
);
alter table public.guest_usage enable row level security;
revoke all on public.guest_usage from public, anon, authenticated;

-- يخصم طلباً واحداً من رصيد الزائر اليومي. يرجع ok=false مع السبب إذا انتهى.
create or replace function public.guest_consume(p_dev text, p_ip text, p_kind text, p_limit int, p_ip_limit int, p_global int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d date := (now() at time zone 'Asia/Riyadh')::date;
  u_dev int; u_ip int; u_all int;
begin
  if p_kind not in ('chat', 'images') then return jsonb_build_object('ok', false, 'reason', 'bad_kind'); end if;
  insert into public.guest_usage (day, key) values (d, '*'), (d, p_dev), (d, p_ip) on conflict do nothing;
  -- قفل الصفوف بترتيب ثابت لتجنب التعارض بين الطلبات المتزامنة
  perform 1 from public.guest_usage where day = d and key in ('*', p_dev, p_ip) order by key for update;
  select case when p_kind = 'chat' then chat else images end into u_all from public.guest_usage where day = d and key = '*';
  select case when p_kind = 'chat' then chat else images end into u_dev from public.guest_usage where day = d and key = p_dev;
  select case when p_kind = 'chat' then chat else images end into u_ip  from public.guest_usage where day = d and key = p_ip;
  if u_dev >= p_limit then return jsonb_build_object('ok', false, 'reason', 'device'); end if;
  if u_ip >= p_ip_limit then return jsonb_build_object('ok', false, 'reason', 'device'); end if;
  if u_all >= p_global then return jsonb_build_object('ok', false, 'reason', 'global'); end if;
  update public.guest_usage
     set chat = chat + (p_kind = 'chat')::int, images = images + (p_kind = 'images')::int
   where day = d and key in ('*', p_dev, p_ip);
  return jsonb_build_object('ok', true, 'day', d, 'remaining', p_limit - u_dev - 1);
end $$;

-- يرجع الطلب إذا فشل (لم يصل رد أو صورة)
create or replace function public.guest_refund(p_dev text, p_ip text, p_kind text, p_day date)
returns void language sql security definer set search_path = public as $$
  update public.guest_usage
     set chat = greatest(0, chat - (p_kind = 'chat')::int), images = greatest(0, images - (p_kind = 'images')::int)
   where day = p_day and key in ('*', p_dev, p_ip);
$$;

-- استهلاك الجهاز اليوم
create or replace function public.guest_state(p_dev text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'chat', coalesce((select chat from public.guest_usage where day = (now() at time zone 'Asia/Riyadh')::date and key = p_dev), 0),
    'images', coalesce((select images from public.guest_usage where day = (now() at time zone 'Asia/Riyadh')::date and key = p_dev), 0),
    'cycle_end', ((date_trunc('day', now() at time zone 'Asia/Riyadh') + interval '1 day') at time zone 'Asia/Riyadh'));
$$;

-- تنظيف السجلات القديمة (أكثر من 60 يوماً) عند كل استدعاء للحالة لا يلزم؛ يكفي هذا الاستعلام يدوياً عند الحاجة:
-- delete from public.guest_usage where day < current_date - 60;

revoke execute on function public.guest_consume(text, text, text, int, int, int) from public, anon, authenticated;
revoke execute on function public.guest_refund(text, text, text, date) from public, anon, authenticated;
revoke execute on function public.guest_state(text) from public, anon, authenticated;
grant execute on function public.guest_consume(text, text, text, int, int, int) to service_role;
grant execute on function public.guest_refund(text, text, text, date) to service_role;
grant execute on function public.guest_state(text) to service_role;

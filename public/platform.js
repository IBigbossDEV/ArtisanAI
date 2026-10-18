/* ============================================================
   طبقة المنصة: الدخول، الحساب، الاشتراك، والاتصال بالسيرفر.
   تحمَّل قبل التطبيق، وتوفّر له نفس القدرات اللي كان يأخذها من Claude
   (sample, db, user, downloads) لكن من سيرفرنا ومفاتيحه.
   ما فيه أي مفتاح سري هنا.
   ============================================================ */
(function () {
  'use strict';

  const APP_KEYS = ['artisan_state_v2', 'artisan_pricelist_v1', 'artisan_usage_v1'];
  const OWNER_KEY = 'artisan_owner_v1';
  const PENDING_KEY = 'artisan_pending_pay';

  const PLAT = (window.PLAT = {
    config: null, sb: null, session: null, me: null,
    ready: null, listeners: [],
    onChange(fn) { this.listeners.push(fn); },
    emit() { this.listeners.forEach((fn) => { try { fn(this.me); } catch {} }); },
  });

  let resolveReady;
  PLAT.ready = new Promise((r) => (resolveReady = r));

  /* ---------- أدوات صغيرة ---------- */
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sar = (halalas) => { const v = Math.round(Number(halalas) || 0) / 100; return (Number.isInteger(v) ? v : v.toFixed(2)) + ' ريال'; };
  PLAT.sar = sar;
  PLAT.esc = escH;
  const dayFmt = (d) => { try { return new Date(d).toLocaleDateString('ar-SA-u-nu-latn-ca-gregory', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; } };
  PLAT.day = dayFmt;
  const daysLeft = (d) => Math.ceil((new Date(d) - Date.now()) / 86400000);

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  function loadCss(href) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }

  function codeErr(code, text) { const e = new Error(code); e.code = code; if (text) e.text = text; return e; }

  /* ---------- الاتصال بالسيرفر ---------- */
  async function token() {
    const { data } = await PLAT.sb.auth.getSession();
    return data && data.session ? data.session.access_token : '';
  }
  async function api(path, { method = 'GET', body, signal, raw = false } = {}) {
    const headers = { authorization: 'Bearer ' + (await token()) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = codeErr(data.error || 'upstream_error', ''); if (data.reason) e.reason = data.reason; throw e; }
    return data;
  }
  PLAT.api = api;

  async function refreshMe() {
    try { PLAT.me = await api('/api/me'); PLAT.emit(); } catch (e) { if (e.code === 'session_expired') await signOut(); }
    return PLAT.me;
  }
  PLAT.refreshMe = refreshMe;

  function bump(kind, remaining) {
    if (!PLAT.me) return;
    const m = PLAT.me;
    if (kind === 'chat') m.chat.used = Math.min(m.chat.limit, m.chat.used + 1);
    if (kind === 'image') {
      if (m.images.used < m.images.limit) m.images.used++;
      else if (m.images.extra > 0) m.images.extra--;
    }
    PLAT.emit();
    if (remaining === undefined) refreshMe();
  }

  PLAT.left = (kind) => {
    const m = PLAT.me; if (!m) return 0;
    if (kind === 'chat') return Math.max(0, m.chat.limit - m.chat.used);
    return Math.max(0, m.images.limit - m.images.used) + (m.images.extra || 0);
  };

  /* ---------- تصغير الصور قبل الإرسال ---------- */
  async function toImagePayload(file, max) {
    if (!file) return null;
    const blob = file instanceof Blob ? file : await (await fetch(file)).blob();
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.86);
      return { media_type: 'image/jpeg', data: dataUrl.split(',')[1] };
    } catch { throw codeErr('image_rejected'); }
    finally { URL.revokeObjectURL(url); }
  }
  PLAT.toImagePayload = toImagePayload;

  /* ---------- المساعد (Gemini عبر السيرفر) ---------- */
  const SERVER_TO_APP = { not_configured: 'capability_disabled', bad_request: 'upstream_error', image_too_large: 'image_rejected' };

  async function sample(input, opts = {}) {
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : (input || []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') }));
    const body = { messages, json: !!opts.json };
    if (opts.images) body.image = await toImagePayload(Array.isArray(opts.images) ? opts.images[0] : opts.images, 1280);

    let res;
    try { res = await api('/api/ai/chat', { method: 'POST', body, signal: opts.signal, raw: true }); }
    catch (e) { if (e && e.name === 'AbortError') throw codeErr('cancelled'); throw codeErr('upstream_error'); }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const code = data.error || 'upstream_error';
      if (code === 'quota_exceeded') { PLAT.showQuota('chat'); throw codeErr('quota_exceeded'); }
      if (code === 'session_expired') { await signOut(); }
      throw codeErr(SERVER_TO_APP[code] || code);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', stop = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            text += ev.delta.text;
            if (opts.onText) opts.onText({ text });
          } else if (ev.type === 'message_delta' && ev.delta) stop = ev.delta.stop_reason || stop;
          else if (ev.type === 'error') throw codeErr('upstream_error', text);
        }
      }
    } catch (e) {
      bump('chat');
      if (e && e.name === 'AbortError') throw codeErr('cancelled', text);
      if (e && e.code) throw e;
      throw codeErr('upstream_error', text);
    }
    bump('chat', Number(res.headers.get('x-quota-remaining')));
    if (stop === 'refusal') throw codeErr('refused', text);
    if (!text.trim()) throw codeErr('empty_completion');
    return { text, truncated: stop === 'max_tokens' };
  }
  sample.json = async (prompt, opts = {}) => {
    const r = await sample(prompt, { ...opts, json: true, onText: null });
    let t = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.search(/[[{]/);
    if (a > 0) t = t.slice(a);
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (end >= 0) t = t.slice(0, end + 1);
    try { return JSON.parse(t); } catch { throw codeErr('invalid_json'); }
  };
  sample.limits = async () => ({ images: { mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } });

  /* ---------- المصوّر الذكي (Gemini عبر السيرفر) ---------- */
  PLAT.generateImage = async ({ file, instruction, scene, custom, name, details, ratio, signal }) => {
    const image = await toImagePayload(file, 1536);
    const res = await api('/api/ai/image', { method: 'POST', body: { image, instruction, scene, custom, name, details, ratio }, signal, raw: true });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'quota_exceeded') { PLAT.showQuota('image'); throw codeErr('quota_exceeded'); }
      if (data.error === 'session_expired') await signOut();
      throw codeErr(data.error || 'upstream_error');
    }
    bump('image', data.remaining);
    return 'data:' + data.mime + ';base64,' + data.data;
  };

  /* ---------- مخزن البيانات (بنفس شكل قدرة db في Claude) ---------- */
  function dbErr(e) {
    const c = e && e.code;
    if (c === 'not_granted' || c === 'invalid_argument') { const x = codeErr(c); x.reason = e.reason; return x; }
    return codeErr('unavailable');
  }
  const dbCall = (body) => api('/api/db', { method: 'POST', body }).catch((e) => { throw dbErr(e); });
  const docRef = (path) => ({
    id: path.split('/').pop(),
    async get() { const r = await dbCall({ op: 'get', path }); return { id: path.split('/').pop(), exists: !!r.exists, data: () => r.data }; },
    async set(data) { await dbCall({ op: 'set', path, data: JSON.parse(JSON.stringify(data)) }); },
    async delete() { await dbCall({ op: 'delete', path }); },
  });
  const dbCap = {
    doc: docRef,
    collection(path) {
      return {
        doc: (id) => docRef(path + '/' + id),
        async get() { const r = await dbCall({ op: 'list', path }); return { docs: (r.docs || []).map((d) => ({ id: d.id, exists: true, data: () => d.data })) }; },
      };
    },
  };

  /* ---------- حفظ الملفات ---------- */
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      const a = document.createElement('a'); a.href = url; a.download = filename || 'file'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };

  /* ---------- القدرات اللي يطلبها التطبيق ---------- */
  window.claude = {
    async use(name) {
      await PLAT.ready;
      if (name === 'sample') return sample;
      if (name === 'db') return dbCap;
      if (name === 'downloads') return downloads;
      if (name === 'user') return {
        isOwner: async () => !!(PLAT.me && PLAT.me.isAdmin),
        id: async () => (PLAT.me ? PLAT.me.id : null),
        can: async () => true,
      };
      return null;
    },
  };

  /* ============================================================
     الواجهة: شاشة الدخول ونافذة الاشتراك
     ============================================================ */
  const CSS = `
  .plat-layer{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-end;justify-content:center;background:rgba(30,20,15,.45)}
  @media(min-width:640px){.plat-layer{align-items:center}}
  .plat-sheet{background:#FBF6EA;width:100%;max-width:30rem;max-height:94vh;overflow-y:auto;border-radius:8px 8px 0 0;padding:1.25rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom,0px));border-top:1px solid #D9C49C}
  @media(min-width:640px){.plat-sheet{border-radius:8px;border:1px solid #D9C49C}}
  .plat-full{position:fixed;inset:0;z-index:90;background:#F3EAD7;overflow-y:auto;display:flex;align-items:center;justify-content:center;padding:1.25rem}
  .plat-card{width:100%;max-width:26rem;background:#FBF6EA;border:1px solid #D9C49C;border-radius:8px;padding:1.5rem;border-top:8px solid transparent;border-image:repeating-linear-gradient(135deg,#A8322A 0 6px,#D9C49C 6px 12px,#2B2118 12px 14px,#D9C49C 14px 20px) 8 0 0 0}
  .plat-oauth{width:100%;display:flex;align-items:center;justify-content:center;gap:.6rem;font-weight:700;border-radius:6px;padding:.8rem 1rem;min-height:48px;border:1px solid #2B2118;background:#FFFDF8;color:#2B2118}
  .plat-oauth:hover{background:#F3EAD7}
  .plat-oauth.apple{background:#000;color:#fff;border-color:#000}
  .plat-or{display:flex;align-items:center;gap:.75rem;color:#6B5A48;font-size:.85rem;margin:1rem 0}
  .plat-or:before,.plat-or:after{content:"";flex:1;height:1px;background:#D9C49C}
  .plat-code{letter-spacing:.5em;text-align:center;font-size:1.5rem;font-variant-numeric:tabular-nums;direction:ltr}
  .plat-bar{height:.6rem;border-radius:999px;background:#E8DAB9;overflow:hidden}
  .plat-bar>i{display:block;height:100%;background:#A8322A;border-radius:999px}
  .plat-plan{border:2px solid #eaddd7;border-radius:1rem;padding:1rem;text-align:start;width:100%;background:#fff}
  .plat-plan.best{border-color:#8b6450;background:#fdf8f6}
  .plat-tag{display:inline-block;font-size:.72rem;font-weight:800;border-radius:999px;padding:.15rem .55rem;background:#8b6450;color:#fff}
  .plat-banner{background:#fef3c7;border-bottom:1px solid #fde68a;color:#78350f;font-size:.9rem}
  .mysr-form{direction:ltr}
  `;
  function injectCss() { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }

  function closeLayer() { const l = document.getElementById('plat-layer'); if (l) l.remove(); }
  PLAT.closeLayer = closeLayer;
  function openLayer(html) {
    closeLayer();
    const layer = el(`<div id="plat-layer" class="plat-layer" role="dialog" aria-modal="true" dir="rtl" lang="ar"><div class="plat-sheet">${html}</div></div>`);
    layer.addEventListener('click', (e) => { if (e.target === layer || e.target.closest('[data-plat-close]')) closeLayer(); });
    document.body.appendChild(layer);
    return layer;
  }
  PLAT.openLayer = openLayer;

  function flash(text, ok) {
    if (typeof window.toast === 'function') { window.toast(text, ok); return; }
    alert(text);
  }

  /* ---------- شاشة الدخول ---------- */
  function showLogin(msg) {
    const old = document.getElementById('plat-login'); if (old) old.remove();
    const c = PLAT.config || {};
    const wrap = el(`<div id="plat-login" class="plat-full" dir="rtl" lang="ar">
      <div class="plat-card">
        <div class="text-center mb-5">
          <h1 class="font-display text-[2rem] leading-tight text-craft-800">منصة الحرفي</h1>
          <p class="text-craft-600 font-bold mt-1">مجانية للحرفيين والحرفيات والأسر المنتجة</p>
          <p class="text-gray-600 mt-1">مستشارك الذكي في الحرفة: سعّر منتجاتك، وسوّقها، وصوّرها صوراً احترافية.</p>
        </div>
        ${msg ? `<div class="mb-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 p-3 text-sm">${escH(msg)}</div>` : ''}
        <div class="space-y-3" id="plat-login-oauth">
          ${c.googleLogin !== false ? `<button type="button" class="plat-oauth" data-oauth="google"><svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg> الدخول بحساب جيميل</button>` : ''}
          ${c.appleLogin ? `<button type="button" class="plat-oauth apple" data-oauth="apple"><i class="fa-brands fa-apple text-xl"></i> الدخول بحساب آبل</button>` : ''}
        </div>
        <div class="plat-or">أو بالبريد الإلكتروني</div>
        <form id="plat-email-form" class="space-y-3" novalidate>
          <label for="plat-email" class="lbl">بريدك الإلكتروني</label>
          <input id="plat-email" type="email" class="inp" dir="ltr" autocomplete="email" inputmode="email" placeholder="name@example.com" required>
          <button type="submit" class="btn btn-main w-full text-lg" id="plat-email-btn">أرسل لي رمز الدخول</button>
          <p class="hint">سيصلك رمز من 6 أرقام على بريدك. لا تحتاج إلى كلمة مرور.</p>
        </form>
        <form id="plat-code-form" class="space-y-3 hidden" novalidate>
          <p class="text-gray-700">أرسلنا الرمز إلى <b id="plat-code-to" dir="ltr"></b></p>
          <label for="plat-code" class="lbl">اكتب الرمز</label>
          <input id="plat-code" class="inp plat-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="••••••" required>
          <button type="submit" class="btn btn-main w-full text-lg" id="plat-code-btn">دخول</button>
          <button type="button" class="btn btn-soft w-full" id="plat-code-back">غيّر البريد أو أعد الإرسال</button>
        </form>
        <p class="text-xs text-gray-500 mt-5 text-center leading-relaxed">بدخولك توافق على <a class="underline" href="/terms.html">الشروط والأحكام</a> و<a class="underline" href="/privacy.html">سياسة الخصوصية</a>.</p>
      </div></div>`);
    document.body.appendChild(wrap);

    let email = '';
    wrap.querySelectorAll('[data-oauth]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      const { error } = await PLAT.sb.auth.signInWithOAuth({ provider: b.dataset.oauth, options: { redirectTo: location.origin + '/' } });
      if (error) { b.disabled = false; flash('تعذّر فتح صفحة الدخول. حاول مرة أخرى.'); }
    }));
    const emailForm = wrap.querySelector('#plat-email-form'), codeForm = wrap.querySelector('#plat-code-form');
    emailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      email = wrap.querySelector('#plat-email').value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { flash('اكتب البريد الإلكتروني بشكل صحيح، مثل name@gmail.com'); return; }
      const btn = wrap.querySelector('#plat-email-btn'); btn.disabled = true; btn.textContent = 'جارٍ الإرسال…';
      const { error } = await PLAT.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      btn.disabled = false; btn.textContent = 'أرسل لي رمز الدخول';
      if (error) { flash(/rate|seconds/i.test(error.message) ? 'انتظر دقيقة ثم حاول مرة أخرى.' : 'تعذّر إرسال الرمز. تأكد من البريد الإلكتروني.'); return; }
      wrap.querySelector('#plat-code-to').textContent = email;
      emailForm.classList.add('hidden'); codeForm.classList.remove('hidden');
      wrap.querySelector('#plat-code').focus();
    });
    codeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = wrap.querySelector('#plat-code').value.replace(/\D/g, '');
      if (code.length < 6) { flash('الرمز مكوّن من 6 أرقام.'); return; }
      const btn = wrap.querySelector('#plat-code-btn'); btn.disabled = true; btn.textContent = 'لحظة…';
      const { error } = await PLAT.sb.auth.verifyOtp({ email, token: code, type: 'email' });
      btn.disabled = false; btn.textContent = 'دخول';
      if (error) flash('الرمز غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً.');
    });
    wrap.querySelector('#plat-code-back').addEventListener('click', () => { codeForm.classList.add('hidden'); emailForm.classList.remove('hidden'); });
  }

  // wipe=true عند ضغط الحرفي على "خروج" (بعد حفظ بياناته في حسابه): نمسح بياناته من الجهاز.
  // عند انتهاء الجلسة تلقائياً لا نمسح شيئاً، حتى لا تضيع تعديلات لم تُحفظ بعد؛
  // وإذا دخل حساب آخر على الجهاز نفسه تُمسح البيانات القديمة عند دخوله (انظر start).
  async function signOut({ wipe = false } = {}) {
    try { await PLAT.sb.auth.signOut(); } catch {}
    if (wipe) {
      [...APP_KEYS, OWNER_KEY, PENDING_KEY].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
    }
    location.replace('/');
  }
  PLAT.signOut = signOut;

  /* ---------- نافذة الاشتراك والدفع ---------- */
  const products = () => ((PLAT.config && PLAT.config.plans && PLAT.config.plans.products) || {});
  const limits = (tier) => ((PLAT.config && PLAT.config.plans && PLAT.config.plans[tier]) || {});

  PLAT.showQuota = (kind) => {
    const m = PLAT.me || {};
    const isPro = m.plan === 'pro';
    const what = kind === 'image' ? 'الصور' : 'طلبات المساعد';
    const end = m.cycleEnd ? dayFmt(m.cycleEnd) : '';
    openLayer(`
      <div class="text-center space-y-3">
        <div class="mx-auto w-14 h-14 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-2xl"><i class="fa-solid fa-hourglass-end"></i></div>
        <h2 class="text-xl font-extrabold text-craft-800">انتهى رصيد ${what} لهذا الشهر</h2>
        <p class="text-gray-600 leading-relaxed">${end ? `يتجدد رصيدك يوم <b>${escH(end)}</b>. ` : ''}بقية الأدوات تعمل كالمعتاد.</p>
        <p class="text-gray-600 leading-relaxed">إذا احتجت رصيداً أكثر، تواصل مع إدارة المنصة.</p>
        <button type="button" class="btn btn-soft w-full" data-plat-close>حسناً</button>
      </div>`);
    wireBuy();
  };

  function usageRow(label, used, limit, extra) {
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 100;
    return `<div><div class="flex justify-between text-sm mb-1"><span class="font-bold text-craft-800">${label}</span><span class="num text-gray-600">${used} من ${limit}${extra ? ` + ${extra} إضافية` : ''}</span></div><div class="plat-bar"><i style="width:${pct}%"></i></div></div>`;
  }

  PLAT.planHtml = () => {
    const m = PLAT.me || { plan: 'free', chat: { used: 0, limit: 0 }, images: { used: 0, limit: 0, extra: 0 } };
    return `
      <div class="card space-y-3">
        <div><div class="text-sm text-gray-500">خطتك</div><div class="text-xl font-extrabold text-craft-800"><i class="fa-solid fa-hand-holding-heart text-craft-500 ml-1"></i> مجانية للحرفيين والأسر المنتجة</div></div>
        ${usageRow('طلبات المساعد هذا الشهر', m.chat.used, m.chat.limit)}
        ${usageRow('صور المصوّر الذكي', m.images.used, m.images.limit, m.images.extra)}
        ${m.cycleEnd ? `<p class="hint">يتجدد الرصيد يوم ${escH(dayFmt(m.cycleEnd))}.</p>` : ''}
      </div>
      <p class="hint">المنصة مجانية بالكامل، ولا يوجد أي دفع. إذا احتجت رصيداً أكثر، تواصل مع إدارة المنصة.</p>`;
  };

  function wireBuy(root = document) {
    root.querySelectorAll('[data-buy]').forEach((b) => { b.onclick = () => PLAT.checkout(b.dataset.buy); });
    root.querySelectorAll('[data-plat-plans]').forEach((b) => { b.onclick = () => { closeLayer(); if (typeof window.go === 'function') window.go('plan'); }; });
  }
  PLAT.wireBuy = wireBuy;

  PLAT.checkout = async () => {}; // لا يوجد دفع في نسخة الجمعية

  /* ---------- شريط التذكير بالتجديد ---------- */
  function renderBanner() {} // لا توجد اشتراكات تتجدد في نسخة الجمعية

  /* ---------- مؤشر الرصيد في رأس الصفحة ---------- */
  function renderPill() {
    const m = PLAT.me; if (!m) return;
    const t = document.getElementById('ai-pill-text'), dot = document.getElementById('ai-dot');
    const left = PLAT.left('chat');
    if (t) t.textContent = `المساعد: متبقٍّ ${left}`;
    if (dot) dot.className = 'w-2 h-2 rounded-full ' + (left > 0 ? 'bg-green-400' : 'bg-amber-400');
    const cl = document.getElementById('chat-left');
    if (cl) cl.textContent = `متبقٍّ لك ${left} طلب`;
    const crown = document.getElementById('plan-btn-label');
    if (crown) crown.textContent = 'رصيدي';
  }
  PLAT.onChange(() => { renderPill(); renderBanner(); });

  /* ============================================================
     التشغيل
     ============================================================ */
  async function boot() {
    injectCss();

    try {
      const r = await fetch('/api/config');
      PLAT.config = await r.json();
      if (!r.ok) throw new Error('config');
    } catch {
      showLogin('لم يكتمل إعداد الموقع بعد (إعدادات الخادم ناقصة).');
      return;
    }
    try { await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'); }
    catch { showLogin('تعذّر الاتصال. تأكد من اتصالك بالإنترنت ثم حدّث الصفحة.'); return; }

    PLAT.sb = window.supabase.createClient(PLAT.config.supabaseUrl, PLAT.config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    });

    let started = false;
    const start = async (session) => {
      if (started || !session) return;
      started = true;
      PLAT.session = session;
      // إذا دخل حساب ثاني على نفس الجهاز، نمسح بيانات الحساب السابق من الجهاز
      let prev = null; try { prev = localStorage.getItem(OWNER_KEY); } catch {}
      if (prev && prev !== session.user.id) {
        [...APP_KEYS, PENDING_KEY].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
        try { localStorage.setItem(OWNER_KEY, session.user.id); } catch {}
        location.reload();
        return;
      }
      try { localStorage.setItem(OWNER_KEY, session.user.id); } catch {}
      const lg = document.getElementById('plat-login'); if (lg) lg.remove();
      await refreshMe();
      if (!PLAT.me) { started = false; showLogin('حدث خطأ في الاتصال. حدّث الصفحة.'); return; }
      resolveReady();
    };

    PLAT.sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') start(session);
      if (event === 'SIGNED_OUT' && started) location.replace('/');
    });
    const { data } = await PLAT.sb.auth.getSession();
    if (data && data.session) start(data.session);
    else if (!/[?&]code=/.test(location.search)) showLogin();
    else setTimeout(() => { if (!started) showLogin('لم يكتمل تسجيل الدخول. حاول مرة أخرى.'); }, 6000);

    // تحديث الرصيد كل ما رجع الحرفي للصفحة
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started) refreshMe(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

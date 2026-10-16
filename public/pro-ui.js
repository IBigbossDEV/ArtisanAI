/* ============================================================
   شاشات النسخة المدفوعة داخل التطبيق:
   - اشتراكي (الخطة والرصيد والدفع والحساب)
   - المصوّر الذكي (صور إعلانية من صورة الحرفي عبر Gemini)
   تُحمَّل بعد التطبيق وتستخدم أدواته (screen, go, toast, ACT, ROUTES…).
   ============================================================ */

/* ---------- اشتراكي ---------- */
ROUTES.plan = {
  nav: 'more',
  render() {
    const m = PLAT.me || {};
    return screen({
      title: 'اشتراكي', sub: 'رصيدك هذا الشهر، وخطط الاشتراك.', back: 'more',
      body: `<div class="space-y-4">${PLAT.planHtml()}
        <div class="card space-y-3">
          <div class="font-extrabold text-craft-800"><i class="fa-solid fa-user ml-1"></i> حسابي</div>
          <p class="text-gray-700 break-all" dir="ltr" style="text-align:right">${esc(m.email || '')}</p>
          <button type="button" class="btn btn-soft w-full" data-act="platSignOut"><i class="fa-solid fa-right-from-bracket"></i> تسجيل الخروج</button>
        </div>
        <nav class="flex flex-wrap justify-center gap-x-4 gap-y-2 text-sm text-craft-600"><a class="underline" href="/terms.html">الشروط والأحكام</a><a class="underline" href="/privacy.html">الخصوصية</a><a class="underline" href="/refund.html">الاسترجاع</a><a class="underline" href="/contact.html">تواصل معنا</a></nav>
      </div>`,
    });
  },
  after() { PLAT.wireBuy($('view')); },
};
ACT.platSignOut = () => {
  openModal(`<h2 class="text-lg font-bold text-craft-800 mb-2">هل تريد تسجيل الخروج؟</h2>
    <p class="text-gray-600 mb-4">بياناتك محفوظة في حسابك، وستعود إليك عند الدخول مرة أخرى.</p>
    <div class="grid grid-cols-2 gap-2"><button type="button" class="btn btn-dark" data-act="platSignOutYes">خروج</button><button type="button" class="btn btn-soft" data-act="closeModal">رجوع</button></div>`);
};
ACT.platSignOutYes = async () => {
  closeModal();
  try { await flushAccount(); } catch {}
  PLAT.signOut({ wipe: true });
};
PLAT.onChange(() => { if (CUR.name === 'plan' && !document.getElementById('plat-layer')) rerender(); });

/* ---------- المصوّر الذكي ---------- */
const PH = { file: null, url: '', results: [], busy: false, ctl: null, scene: 'white', ratio: '1:1', fromStudio: false, cleared: false };
const PH_SCENES = [
  ['white', 'خلفية بيضاء نظيفة'], ['majlis', 'مجلس عربي دافئ'], ['desert', 'رمال الصحراء وقت الغروب'],
  ['mud', 'بيت طين وباب خشب'], ['modern', 'بيت حديث هادئ'], ['gift', 'مغلّف كهدية فخمة'],
  ['palms', 'خضرة ونخيل'], ['marble', 'رخام فخم'], ['custom', 'سأكتب المكان بنفسي'],
];

function phSetFile(file, url) {
  if (PH.url && PH.url.startsWith('blob:') && PH.url !== url) URL.revokeObjectURL(PH.url);
  PH.file = file; PH.url = url;
}

ROUTES.photographer = {
  nav: 'photographer',
  render(params = {}) {
    if (params.productId && prodById(params.productId)) S.settings.lastProduct = params.productId;
    if (!PH.file && st.file && !PH.cleared) { phSetFile(st.file, st.url); PH.fromStudio = true; }
    const p = prodById(S.settings.lastProduct);
    const left = PLAT.left('image');
    const results = PH.results.map((r, i) => `
      <div class="card space-y-3">
        <img src="${esc(r.src)}" alt="صورة من المصوّر الذكي" class="w-full rounded-xl border border-craft-100">
        <div class="grid grid-cols-2 gap-2">
          <button type="button" class="btn btn-green btn-sm" data-act="phSave" data-i="${i}"><i class="fa-solid fa-download"></i> احفظ الصورة</button>
          <button type="button" class="btn btn-soft btn-sm" data-act="phToStudio" data-i="${i}"><i class="fa-solid fa-sliders"></i> أضف اسمك وإطاراً</button>
          ${S.products.length ? `<button type="button" class="btn btn-soft btn-sm col-span-2" data-act="phToProduct" data-i="${i}"><i class="fa-solid fa-box-open"></i> اجعلها صورة المنتج المختار</button>` : ''}
        </div>
        <p class="hint">${esc(r.label)}</p>
      </div>`).join('');
    return screen({
      title: 'المصوّر الذكي', sub: 'ارفع صورة لمنتجك من جوالك، واختر المكان، وسيصنع لك المصوّر صورة إعلانية لمنتجك نفسه.',
      body: `
      <div class="card flex items-center justify-between gap-3 ${left ? '' : 'bg-amber-50 border-amber-200'}">
        <span class="text-gray-700"><i class="fa-solid fa-images ml-1 text-craft-500"></i> رصيدك: <b class="num">${left}</b> صورة</span>
        <button type="button" class="btn btn-soft btn-sm" data-go="plan">زِد رصيدك</button>
      </div>
      <div class="card space-y-3">
        <div class="font-extrabold text-craft-800">1. صورة منتجك</div>
        ${PH.url ? `<div class="relative"><img src="${esc(PH.url)}" alt="صورة المنتج" class="w-full max-h-72 object-contain rounded-xl bg-gray-50 border"><button type="button" class="absolute top-2 left-2 bg-white/90 rounded-full w-9 h-9 text-gray-600 shadow" data-act="phClear" aria-label="إزالة الصورة"><i class="fa-solid fa-xmark"></i></button></div>
          ${PH.fromStudio ? '<p class="hint">هذه الصورة من "محرر الصور".</p>' : ''}` :
          `<label for="ph-file" class="cursor-pointer flex flex-col items-center gap-2 text-center text-gray-500 p-6 border-2 border-dashed border-craft-300 rounded-2xl bg-gray-50">
            <i class="fa-solid fa-camera text-4xl text-craft-400"></i><span class="font-bold text-craft-700">اختر صورة منتجك</span><span class="text-sm">صوّره في مكان مضيء، وليظهر المنتج كاملاً في الصورة</span></label>`}
        <input type="file" id="ph-file" accept="image/*" class="hidden">
        <div class="grid grid-cols-2 gap-2">
          <label for="ph-file" class="btn btn-soft btn-sm cursor-pointer"><i class="fa-solid fa-arrow-up-from-bracket"></i> ${PH.url ? 'غيّر الصورة' : 'اختر صورة'}</label>
          ${p && p.photo ? `<button type="button" class="btn btn-soft btn-sm" data-act="phFromProduct"><i class="fa-solid fa-box-open"></i> صورة "${esc(p.name || 'المنتج')}"</button>` : ''}
        </div>
      </div>
      <div class="card space-y-3">
        <div class="font-extrabold text-craft-800">2. عن المنتج <span class="font-normal text-gray-500 text-sm">(يساعد المصوّر)</span></div>
        ${productPicker('ph-pick', p ? p.id : '')}
        ${fInput({ id: 'ph-name', label: 'اسم المنتج', value: p ? p.name : '', ph: 'مثال: سلة خوص' })}
        ${fText({ id: 'ph-det', label: 'الخامة والألوان', value: p ? p.details : '', ph: 'مثال: خوص طبيعي بخطوط حمراء' })}
      </div>
      <div class="card space-y-3">
        <div class="font-extrabold text-craft-800">3. أين تريد أن يظهر منتجك؟</div>
        ${segGroup('ph-scene', PH_SCENES, PH.scene, 3)}
        <div id="ph-custom-wrap" class="${PH.scene === 'custom' ? '' : 'hidden'}">${fText({ id: 'ph-custom', label: 'صف المكان', ph: 'مثال: على طاولة خشبية بجانب نافذة، ومعه فنجان قهوة', rows: 2 })}</div>
        <div class="font-extrabold text-craft-800 pt-1">المقاس</div>
        ${segGroup('ph-ratio', [['1:1', 'مربع'], ['4:5', 'طولي'], ['9:16', 'ستوري']], PH.ratio, 3)}
      </div>
      <button type="button" id="ph-go" class="btn btn-main w-full text-lg" data-act="phGenerate"><i class="fa-solid fa-wand-magic-sparkles"></i> ${PH.busy ? 'إيقاف' : 'صوّر منتجي'}</button>
      <button type="button" class="btn btn-soft w-full" data-go="studio"><i class="fa-solid fa-sliders"></i> لديك صورة جاهزة؟ عدّلها بنفسك (المقاس، الإضاءة، الإطار)</button>
      <p class="hint">تُحسب كل صورة من رصيدك، وإذا لم تظهر صورة فلن يُخصم شيء. قد يغيّر المصوّر تفاصيل بسيطة، فتأكد أن المنتج يطابق منتجك قبل النشر.</p>
      <div id="ph-out" class="space-y-3">${PH.busy ? phLoader() : ''}${results}</div>`,
    });
  },
  onSeg({ id, value }) {
    if (id === 'ph-scene') { PH.scene = value; $('ph-custom-wrap').classList.toggle('hidden', value !== 'custom'); }
    if (id === 'ph-ratio') PH.ratio = value;
  },
  onChange(e) {
    fillFromProduct(e, { 'ph-name': 'name', 'ph-det': 'details' });
  },
  after() {
    $('ph-file').addEventListener('change', (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f || !/^image\//.test(f.type)) { if (f) toast('اختر صورة من جوالك.'); return; }
      phSetFile(f, URL.createObjectURL(f)); PH.fromStudio = false; track('actions', 'photo_upload'); rerender();
    });
  },
};
const phLoader = () => `<div class="card bg-craft-50 text-center space-y-2 py-6"><div class="dot-typing mx-auto"></div><p class="font-bold text-craft-700">المصوّر يعمل على صورتك…</p><p class="hint">قد يستغرق ذلك دقيقة. أبقِ الصفحة مفتوحة.</p></div>`;

ACT.phClear = () => { phSetFile(null, ''); PH.fromStudio = false; PH.cleared = true; rerender(); };
ACT.phFromProduct = async () => {
  const p = prodById(val('ph-pick')) || prodById(S.settings.lastProduct);
  if (!p || !p.photo) return;
  try { const b = await (await fetch(p.photo)).blob(); phSetFile(b, p.photo); PH.fromStudio = false; rerender(); }
  catch { toast('تعذّر فتح صورة المنتج.'); }
};

ACT.phGenerate = async () => {
  if (PH.busy) { if (PH.ctl) PH.ctl.abort(); return; }
  if (!PH.file) { toast('اختر صورة منتجك أولاً.'); return; }
  if (PLAT.left('image') <= 0) { PLAT.showQuota('image'); return; }
  if (PH.scene === 'custom' && !val('ph-custom')) { toast('اكتب المكان الذي تريده.'); return; }
  const scene = PH.scene, custom = val('ph-custom'), name = val('ph-name'), details = val('ph-det'), ratio = PH.ratio;
  const label = (PH_SCENES.find((s) => s[0] === scene) || [])[1] + (scene === 'custom' ? `: ${custom}` : '') + ` · ${ratio}`;
  PH.busy = true; PH.ctl = new AbortController();
  track('actions', 'ai_photo');
  const btn = $('ph-go'); if (btn) btn.innerHTML = '<i class="fa-solid fa-stop"></i> إيقاف';
  const out = $('ph-out'); if (out) { out.insertAdjacentHTML('afterbegin', `<div id="ph-loading">${phLoader()}</div>`); $('ph-loading').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  try {
    const src = await PLAT.generateImage({ file: PH.file, scene, custom, name, details, ratio, signal: PH.ctl.signal });
    PH.results.unshift({ src, label, name });
    PH.results = PH.results.slice(0, 6);
    toast('الصورة جاهزة ✅', true);
  } catch (e) {
    const c = e && (e.name === 'AbortError' ? 'cancelled' : e.code);
    if (c === 'cancelled') PLAT.refreshMe(); // الإيقاف بعد بدء العمل قد يُحسب من الرصيد، فنحدّث العدّاد
    if (c !== 'cancelled' && c !== 'quota_exceeded') {
      toast({
        refused: 'لم يتمكن المصوّر من العمل على هذه الصورة. جرّب صورة أخرى.',
        no_image: AI_ERR.no_image, rate_limited: AI_ERR.rate_limited, image_rejected: AI_ERR.image_rejected,
        capability_disabled: AI_ERR.capability_disabled, not_configured: AI_ERR.capability_disabled,
      }[c] || AI_ERR.upstream_error);
    }
  } finally {
    PH.busy = false; PH.ctl = null;
    if (CUR.name === 'photographer') rerender();
  }
};

async function phBlob(i) { return (await fetch(PH.results[i].src)).blob(); }
ACT.phSave = async (b) => {
  const r = PH.results[b.dataset.i]; if (!r) return;
  const blob = await phBlob(b.dataset.i);
  const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
  offerFile(`${safeName(r.name || S.profile.store || 'منتجي')}_المصوّر_الذكي.${ext}`, blob, 'تم حفظ الصورة ✅');
};
ACT.phToStudio = async (b) => {
  const r = PH.results[b.dataset.i]; if (!r) return;
  const blob = await phBlob(b.dataset.i);
  loadStudioImage(r.src, blob);
  go('studio');
};
ACT.phToProduct = (b) => {
  const r = PH.results[b.dataset.i]; if (!r) return;
  const p = prodById(val('ph-pick')) || prodById(S.settings.lastProduct);
  if (!p) { toast('اختر المنتج من الأعلى أولاً.'); return; }
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    p.photo = thumbFromCanvas(c); save();
    toast(`أصبحت صورة "${p.name || 'المنتج'}" ✅`, true);
  };
  img.src = r.src;
};

/* عدّاد المساعد تحت خانة الكتابة يتحدث كل ما فتحت المحادثة */
{
  const chatAfter = ROUTES.chat.after;
  ROUTES.chat.after = function (...a) { chatAfter.apply(this, a); PLAT.emit(); };
}

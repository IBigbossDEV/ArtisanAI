# منصة شوري — النسخة المدفوعة (فرع `pro`)

نفس أدوات النسخة المجانية وتصميمها، ومعها: حساب لكل حرفي، اشتراكات، دفع داخل الموقع عبر ميسّر، عدّاد شهري، المساعد عبر Claude، والمصوّر الذكي عبر Gemini، ولوحة للمالك.

> النسخة المجانية للجمعية باقية كما هي على فرع `main` (GitHub Pages). هذا الفرع منفصل عنها.

## كيف بُني

| الجزء | المكان | وش يسوي |
|---|---|---|
| الواجهة | `public/` | التطبيق (`index.html`)، الدخول والاشتراك (`platform.js`)، شاشات الاشتراك والمصوّر (`pro-ui.js`)، لوحة المالك (`admin.html`)، الصفحات القانونية |
| السيرفر | `functions/api/` | يتحقق من الدخول، يخصم الرصيد، يكلم Claude وGemini وميسّر بالمفاتيح السرية |
| قاعدة البيانات | `supabase/schema.sql` | الحسابات، الخطط، العدّاد، المدفوعات، بيانات الأدوات |

**الأمان:** ما فيه أي مفتاح سري في ملفات `public/`. كل المفاتيح في إعدادات Cloudflare فقط، وجداول قاعدة البيانات مقفلة على المتصفح.

---

## خطوات التشغيل (مرة وحدة)

### 1) Supabase — قاعدة البيانات والحسابات
1. أنشئ مشروع جديد في [supabase.com](https://supabase.com) (الخطة المجانية تكفي للبداية).
2. **SQL Editor ← New query** ← الصق محتوى `supabase/schema.sql` كامل ← **Run**.
3. **Authentication ← Sign In / Providers ← Email:** فعّله.
4. **Authentication ← Emails ← Templates ← Magic Link:** خلّ الرسالة تعرض الرمز بدل الرابط، مثلاً:
   ```html
   <h2>رمز الدخول لمنصة شوري</h2>
   <p style="font-size:28px;letter-spacing:6px"><b>{{ .Token }}</b></p>
   <p>الرمز صالح لمدة قصيرة. إذا ما طلبته تجاهل الرسالة.</p>
   ```
5. **مهم:** إرسال الإيميل المدمج في Supabase محدود جداً (عدد قليل من الرسائل في الساعة). اربط خدمة إرسال من **Authentication ← Emails ← SMTP Settings** (مثل Resend أو Brevo، ولهم خطط مجانية).
6. **Authentication ← URL Configuration:**
   - Site URL: رابط موقعك (بعد الخطوة 2، مثل `https://artisan-pro.pages.dev`).
   - Redirect URLs: نفس الرابط.
7. **الدخول بجيميل:** **Authentication ← Providers ← Google** ← فعّله وحط Client ID وSecret من Google Cloud Console (OAuth client من نوع Web، وأضف رابط الـ callback اللي يعطيك Supabase في Authorized redirect URIs).
8. **دخول آبل (لاحقاً):** يحتاج اشتراك Apple Developer. بعدها فعّل Apple في Providers، وحط `ENABLE_APPLE_LOGIN=1` في Cloudflare.
9. انسخ من **Project Settings ← API Keys** (تبويب Legacy API keys):
   - Project URL ← `SUPABASE_URL`
   - `anon` ← `SUPABASE_ANON_KEY`
   - `service_role` ← `SUPABASE_SERVICE_ROLE_KEY` (**سري**)

### 2) Cloudflare Pages — الاستضافة
1. [dash.cloudflare.com](https://dash.cloudflare.com) ← **Workers & Pages ← Create ← Pages ← Connect to Git** ← اختر المستودع `ArtisanAI`.
2. الإعدادات:
   - Production branch: **`pro`**
   - Build command: **اتركه فاضي**
   - Build output directory: **`public`**
3. **Settings ← Variables and Secrets** ← أضف المتغيرات (الجدول تحت). اختر **Secret** لكل مفتاح سري.
4. أعد النشر (Deployments ← Retry deployment) بعد إضافة المتغيرات.

### 3) ميسّر — الدفع
1. من لوحة ميسّر خذ مفاتيح **بيئة التجربة**: `pk_test_…` و`sk_test_…`.
2. **Webhooks ← Add:**
   - URL: `https://<موقعك>/api/pay/webhook`
   - Secret token: اكتب كلمة طويلة عشوائية، وحطها نفسها في `MOYASAR_WEBHOOK_SECRET`.
   - Events: `payment_paid` (ويفضّل كل أحداث الدفع).
3. بطاقة التجربة: `4111 1111 1111 1111`، أي تاريخ مستقبلي، أي CVC.
4. **Apple Pay:** سجّل الدومين في لوحة ميسّر، وحط ملف التحقق اللي يعطونك في `public/.well-known/apple-developer-merchantid-domain-association`، ثم `ENABLE_APPLE_PAY=1`.
5. **STC Pay:** ما يشتغل بمفاتيح التجربة. فعّله بعد الحساب الحقيقي بـ `ENABLE_STC_PAY=1`.

### 4) مفاتيح الذكاء الاصطناعي
- **Claude:** [console.anthropic.com](https://console.anthropic.com) ← API Keys. حط حد شهري للصرف من Billing.
- **Gemini:** [aistudio.google.com](https://aistudio.google.com) ← مفتاح **جديد** (لا تستخدم المفتاح القديم المكشوف). توليد الصور يحتاج تفعيل الفوترة في المشروع.

### 5) بيانات المنشأة
عدّل `public/site-info.js`: اسم المنشأة، رقم السجل أو وثيقة العمل الحر، الإيميل، الواتساب. تظهر تلقائياً في الشروط والخصوصية والاسترجاع والتواصل.

---

## متغيرات Cloudflare

| المتغير | مطلوب | مثال / ملاحظة |
|---|---|---|
| `SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | ✅ | مفتاح anon (عام) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ سري | مفتاح service_role |
| `ANTHROPIC_API_KEY` | ✅ سري | مفتاح Claude |
| `CLAUDE_MODEL` | اختياري | الافتراضي `claude-haiku-5-5` (أرخص). تقدر تحط `claude-sonnet-5-5` |
| `GEMINI_API_KEY` | ✅ سري | مفتاح Gemini الجديد |
| `GEMINI_IMAGE_MODEL` | اختياري | الافتراضي `gemini-3.1-flash-image` |
| `MOYASAR_PUBLISHABLE_KEY` | ✅ | `pk_test_…` ثم `pk_live_…` |
| `MOYASAR_SECRET_KEY` | ✅ سري | `sk_test_…` ثم `sk_live_…` |
| `MOYASAR_WEBHOOK_SECRET` | ✅ سري | نفس الكلمة اللي في إعدادات Webhook بميسّر |
| `ADMIN_EMAILS` | ✅ | إيميلك (أو أكثر مفصولة بفاصلة). يفتح لك لوحة المالك |
| `ENABLE_GOOGLE_LOGIN` | اختياري | حط `0` لإخفاء زر جيميل |
| `ENABLE_APPLE_LOGIN` | اختياري | `1` بعد إعداد دخول آبل |
| `ENABLE_APPLE_PAY` | اختياري | `1` بعد تسجيل الدومين |
| `ENABLE_STC_PAY` | اختياري | `1` بعد تفعيل الحساب الحقيقي |

---

## تأكد بعد النشر
1. افتح الموقع ← ادخل بإيميلك ← يوصلك رمز ← تدخل.
2. اسأل المساعد سؤال ← ينقص العدّاد في "اشتراكي".
3. "المزيد ← المصوّر الذكي" ← ارفع صورة ← تطلع صورة.
4. "اشتراكي" ← المحترف شهر ← ادفع ببطاقة التجربة ← ترجع وتشوف "تم الدفع بنجاح".
5. افتح `/admin.html` ← تشوف المشترك والعملية (مكتوب عليها تجربة).

## الانتقال للدفع الحقيقي
1. فعّل حسابك في ميسّر (سجل تجاري فيه نشاط تقنية المعلومات أو وثيقة عمل حر، حسب ما يطلبونه).
2. اربط دومين حقيقي في Cloudflare Pages (Custom domains) وحدّث Site URL في Supabase.
3. بدّل مفاتيح ميسّر لـ `pk_live_` و`sk_live_`، وأنشئ Webhook جديد للبيئة الحقيقية.
4. عدّل `site-info.js` وراجع الصفحات القانونية.

## الأسعار والحدود
تتعدل من **لوحة المالك ← الأسعار والحدود** بدون برمجة. المبالغ تشمل الضريبة إذا كنت مسجل فيها.

## ملاحظات
- **الخطة المجانية في Cloudflare** تعطي وقت معالجة قصير لكل طلب. إذا لاحظت فشل متكرر في المصوّر الذكي، رقّ Workers للخطة المدفوعة (5 دولار شهرياً).
- **التجديد يدوي:** الحرفي يشوف تذكير قبل نهاية اشتراكه بخمسة أيام، ويجدد بنفسه. لو جددت قبل النهاية تنضاف المدة بعدها.
- **منح اشتراك يدوي** (للجمعية أو للتجربة أو تعويض): من لوحة المالك ← الحرفيين ← +شهر / +سنة / +صور.

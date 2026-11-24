# إصلاح: الرابط العام (Cloudflare tunnel) مش بيشتغل في الـ Sandbox

## المشكلة الأصلية
ديسك السيرفر كان ممتلئ (25GB / 24GB مستخدم) فوقت الـ build كان `tar` بيفشل بـ
`No space left on device`، والـ build كان بيكمّل عادي ويطلّع صورة **ناقصة**:
Zig / code-server / **cloudflared** / V / Scala / Groovy / PowerShell ماتثبتوش.
وبعدها Docker كان بيعمل cache للطبقة الفاشلة، فكل build جديد كان بيرجع نفس الصورة الناقصة.

## الملفات اللي اتغيّرت
### uipe-docker/  (انسخها فوق مجلد المشروع على السيرفر)
- `image/install-extras.sh` : لو cloudflared أو code-server ماتثبّتوش، الـ build **يفشل** (بدل ما يكمّل بصورة ناقصة ويتعمل لها cache).
- `image/Dockerfile` : ضفت `ARG EXTRAS_REQUIRED="cloudflared code-server"` (وبيكسر الـ cache القديم الفاشل).
- `scripts/build-image.js` : يفحص المساحة قبل الـ build (الحد الأدنى 8GB، تقدر تغيّره بـ `MIN_FREE_GB`)، ينضّف الـ build cache تلقائيًا لو المساحة قليلة، ولو لسه ناقصة يوقف برسالة واضحة. وبعد الـ build يفحص الصورة ويطبع الأدوات الموجودة والناقصة.
- `src/docker.js` : لو cloudflared مش موجود، الخطأ يظهر فورًا وبسببه الحقيقي (بدل الانتظار 30 ثانية).
- `scripts/free-space.sh` (جديد) : يعرض إيه اللي واخد الديسك، ومع `--clean` يمسح الآمن بس.

### UIP-React/  (انسخها فوق مجلد الـ React)
- `src/components/zipbench/runner/useSandbox.js`
- `src/components/zipbench/SandboxPanel.jsx`
  الرسالة "تعذّر إنشاء الرابط العام" بقت تعرض تحتها سبب الفشل الفعلي من السيرفر.

## خطوات التشغيل (بالترتيب)
1. **وسّع الديسك الأول** (ده الأساس، الملفات دي مش هتعوّض نقص المساحة):
   AWS Console ← EC2 ← Volumes ← Modify volume ← 40GB أو أكتر، وبعدها على السيرفر:
   ```bash
   lsblk
   sudo growpart /dev/nvme0n1 1
   sudo xfs_growfs -d /          # لو النظام ext4:  sudo resize2fs /dev/nvme0n1p1
   df -h /
   ```
2. انسخ ملفات `uipe-docker/` فوق المشروع، وبعدين:
   ```bash
   cd ~/uipe-identity/uipe-docker
   bash scripts/free-space.sh            # تقرير المساحة
   bash scripts/free-space.sh --clean    # (اختياري) تنضيف آمن
   sed -i 's/^ARG CLOUDFLARED_VERSION=.*/ARG CLOUDFLARED_VERSION=2025.11.1/' image/Dockerfile   # لو لسه غيّرته لرقم تاني
   npm run build-image 2>&1 | tee /tmp/build.log
   ```
   آخر الـ build لازم يطبع سطر `Image check:` فيه cloudflared و code-server بدون كلمة missing.
3. اتأكد:
   ```bash
   sudo docker run --rm --entrypoint sh uip-sandbox:latest -c 'cloudflared --version'
   ```
4. من الـ IDE: **إيقاف ثم تشغيل** (عشان الجلسة تبدأ على الصورة الجديدة)، وبعدها زر الرابط العام.
5. ابني الـ React من جديد ونزّله لو عايز رسالة السبب الجديدة تظهر في الواجهة.

## ملاحظات
- لو عايز تبني من غير الفحص: `SKIP_SPACE_CHECK=1 npm run build-image` ، ولو عايز تسمح بصورة من غير cloudflared: `--build-arg EXTRAS_REQUIRED=""`.
- خطأ `401 /api/v1/auth/mfa/status` في الـ Console مش عطل: `MfaGate.jsx` مكتوب إنه يتجاهل الخطأ ده عمدًا (fail open) والسيرفر هو اللي بيطبّق السياسة.

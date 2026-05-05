# Instagram Scheduler - موقع جدولة النشر

هذا مشروع جاهز للتجربة يسمح لك بـ:

- رفع الصور من صفحة ويب.
- كتابة كابشن.
- تحديد وقت نشر لكل صورة.
- تخزين الصور على Cloudinary حتى يكون لها رابط عام.
- نشر الصورة تلقائيًا على Instagram عند موعدها.
- النشر اليدوي للتجربة من زر "نشر الآن".

## مهم قبل التشغيل

النشر الحقيقي على Instagram يحتاج:

1. Instagram Professional: Business أو Creator.
2. الحساب مربوط بصفحة Facebook داخل Meta Business Suite.
3. تطبيق في Meta Developers.
4. Instagram Graph API وصلاحيات النشر.
5. `IG_USER_ID` و `IG_ACCESS_TOKEN` صالح.
6. Cloudinary لتخزين الصور كرابط عام.

## التشغيل المحلي

```bash
cd backend
npm install
copy .env.example .env
npm run dev
```

افتح:

```txt
http://localhost:5000
```

إذا PowerShell منع `npm run dev`، استخدم Command Prompt أو نفذ:

```powershell
Set-ExecutionPolicy RemoteSigned
```

## ملف .env

افتح `backend/.env` وضع القيم:

```env
PORT=5000
DATABASE_PATH=./data/database.sqlite
UPLOAD_DIR=./uploads

IG_USER_ID=ضع_Instagram_User_ID
IG_ACCESS_TOKEN=ضع_Access_Token

CLOUDINARY_CLOUD_NAME=ضع_cloud_name
CLOUDINARY_API_KEY=ضع_api_key
CLOUDINARY_API_SECRET=ضع_api_secret
CLOUDINARY_FOLDER=instagram-scheduler

CHECK_EVERY_MINUTE=true
DAILY_PUBLISH_HOUR=9
DAILY_PUBLISH_MINUTE=0
```

## طريقة العمل

1. ارفع صورة من الموقع.
2. النظام يرفعها تلقائيًا إلى Cloudinary.
3. يحفظ الرابط في قاعدة البيانات.
4. كل دقيقة يفحص الصور المجدولة.
5. إذا وصل وقت الصورة، ينشرها على Instagram.

## ملاحظات مهمة

- إذا تركت موعد النشر فارغًا، تصبح الصورة جاهزة للنشر فورًا عند أول فحص.
- زر "نشر الآن" مفيد للاختبار.
- لا تشارك `IG_ACCESS_TOKEN` أو بيانات Cloudinary مع أي شخص.
- في الاستضافة مثل Render أو Railway، أضف نفس قيم `.env` في Environment Variables.

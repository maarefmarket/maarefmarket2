# CampusKart — متجر الجامعة 🎓🛒

موقع متجر جامعي احترافي بواجهة عربية RTL مع **لوحة تحكم لحظية**. أي تعديل من لوحة التحكم يظهر فوراً لجميع الزوار — بدون رفع يدوي إلى GitHub.

## ✨ المميزات

- 🎨 هوية بصرية موحّدة (أخضر غابي #0F3D2E / ذهبي #C9A46A / خطوط Noto Sans Arabic + Tajawal + Cairo)
- 🛍️ 7 أقسام: شيبسات، مشروبات، بسكوت، معلبات، مثلجات، موالح، أدوات مدرسية
- 💵 3 عملات: USD / TRY / SYP
- 🛒 سلة مشتريات + طلب عبر واتساب برسالة منسّقة
- 🌙 وضع ليلي/نهاري
- ⚡ **حفظ لحظي** عبر Netlify Functions + Blobs
- 🔐 **كلمة المرور** من متغيّر البيئة `ADMIN_PASSWORD` على Netlify
- 📸 رفع الصور من الجهاز (ضغط تلقائي)
- 🎯 إدارة إعلانات (Banners) متحركة

## 🚀 البدء

راجع الملف **`دليل-الرفع.md`** — دليل عربي مفصّل للمبتدئين.

## 🏗️ البنية

```
campuskart/
├── index.html              الواجهة الرئيسية (SPA)
├── admin.html              لوحة التحكم
├── data-default.json       البيانات الأولية
├── netlify.toml
├── package.json
├── assets/logo.svg
└── netlify/functions/
    ├── data.js             GET/PUT بيانات المتجر
    ├── login.js            تحقّق من كلمة المرور
    ├── upload.js           رفع الصور
    └── image.js            عرض الصور
```

## 🔧 التقنيات

- HTML / CSS / JavaScript خالص — بدون Frameworks
- Netlify Functions (Node.js 18)
- Netlify Blobs للتخزين السحابي
- كلمة المرور عبر Environment Variables

## 📄 الترخيص

MIT

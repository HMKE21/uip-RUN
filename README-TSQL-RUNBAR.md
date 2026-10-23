# تشغيل T-SQL + وضوح شريط التشغيل

فك الضغط فوق مجلدات المشروعين (نفس المسارات). مفيش حاجة تتمسح.

## uip-RUN-main  (اعمل redeploy للـ runner/sandbox — مش محتاج rebuild للـ image)
- src/kinds/tsql.py   (جديد) مشغّل T-SQL: GO, PRINT, DECLARE/SET, IF/WHILE, TRY/CATCH, TOP, IDENTITY, #temp, dbo. ...
- src/kinds/lang.sh   case جديد لـ *.tsql
- src/scripts.js      بيدمج tsql.py في سكربت التشغيل
- test/langs.test.js  اختبار tsql

## uip-raect-main  (build للـ frontend)
- runner/detectApps.js   إضافة tsql: 'T-SQL' → بيظهر زر التشغيل
- RunPanel.jsx / SandboxPanel.jsx   data-state + حالة "انتهت/اتقفلت" بلونها
- styles/css/zip-polish.css   أزرار Run/Stop وشريط الحالة واضحين في كل الثيمات (تباين ≥ 5:1)
- runner/__tests__/detectApps.test.js

ملاحظة: المشغّل بيشغّل مجموعة عملية من T-SQL على SQLite (مفيش SQL Server حقيقي في الـ image).
مش مدعوم: stored procedures / functions / triggers / cursors / sys.* .

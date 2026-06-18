// ════ Splash Screen Optimization ════
// يُضاف هذا الملف في <head> قبل أي script آخر
// أو يُدمج مباشرة في auth.js

(function() {
  'use strict';

  // حارس: يضمن إخفاء الـ Splash حتى لو فشلت كل شيء
  const MAX_SPLASH_MS = 3000; // أقصى وقت 3 ثوانٍ (بدلاً من 2.5)
  let _splashDismissed = false;

  function _dismissSplash() {
    if (_splashDismissed) return;
    _splashDismissed = true;
    const splash = document.getElementById('splashScreen');
    if (!splash) return;
    splash.classList.add('splash-out');
    setTimeout(() => {
      if (splash.parentNode) splash.remove();
    }, 450);
  }

  // 1️⃣ إخفاء فوري إذا كان التطبيق محملاً مسبقاً (returning user)
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // الصفحة جاهزة تقريباً — اخفِ السريع
    setTimeout(_dismissSplash, 100);
  }

  // 2️⃣ إخفاء عند اكتمال التحميل
  window.addEventListener('DOMContentLoaded', () => {
    // إذا لم يُخفَ بعد، انتظر الحد الأقصى
    setTimeout(_dismissSplash, MAX_SPLASH_MS);
  });

  // 3️⃣ تصدير دالة عامة ليستدعيها auth.js
  window.dismissSplash = _dismissSplash;
})();

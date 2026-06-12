// ════ PUSH NOTIFICATIONS ════
async function sendPushToUser(targetUid, title, body, data = {}) {
  // 1. إشعار داخل التطبيق (RTDB) — المسار الأساسي، يُكتب أولاً
  try {
    await db.ref('notifications/' + targetUid).push({
      title, body, data,
      ts: Date.now(),
      from: currentUser?.uid || ''
    });
  } catch(e) {
    console.error('[Push] فشل كتابة الإشعار الداخلي للمستخدم', targetUid, '—', e.code || e.message);
  }

  // 2. قائمة FCM (بيست-إيفورت) — فشلها لا يُلغي الإشعار الداخلي
  try {
    const tokenSnap = await db.ref('users/' + targetUid + '/fcmToken').once('value');
    const fcmToken = tokenSnap.val();
    if (fcmToken) {
      await db.ref('fcm_queue').push({
        token: fcmToken,
        title, body,
        data: { ...data, click_action: 'https://majed132010.github.io' },
        ts: Date.now()
      });
    }
  } catch(e) {
    console.warn('[Push] فشل كتابة قائمة FCM للمستخدم', targetUid, '—', e.code || e.message);
  }
}

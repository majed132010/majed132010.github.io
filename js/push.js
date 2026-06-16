// ════ PUSH NOTIFICATIONS ════
async function sendPushToUser(targetUid, title, body, data = {}) {
  try {
    const tokenSnap = await db.ref('users/' + targetUid + '/fcmToken').once('value');
    const fcmToken = tokenSnap.val();
    if (fcmToken) {
      await db.ref('fcm_queue').push({
        token: fcmToken,
        title, body,
        data: { ...data, click_action: 'https://majed132010-github-io.vercel.app' },
        ts: Date.now()
      });
    }
  } catch(e) {
    console.warn('[Push] فشل كتابة قائمة FCM للمستخدم', targetUid, '—', e.code || e.message);
  }
}

// ════ PUSH NOTIFICATIONS — لا تعدّل هذا الملف ════
async function sendPushToUser(targetUid, title, body, data = {}) {
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
    await db.ref('notifications/' + targetUid).push({
      title, body, data,
      ts: Date.now(),
      from: currentUser?.uid || ''
    });
  } catch(e) { console.warn('Push notification error:', e); }
}

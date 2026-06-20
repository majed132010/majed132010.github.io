// ════ NOTIFICATIONS ════
let _notifListener = null;
let _notifTimeout = null;
let _lastNotifSet = new Set();
let _notifDebounceTimer = null;

// ════ initFCM ════
function initFCM(uid) {
  console.log('[FCM] initFCM called for', uid);
  if (typeof firebase === 'undefined' || !firebase.messaging) {
    console.warn('[FCM] Firebase Messaging not available');
    return;
  }
  const messaging = firebase.messaging();
  messaging.getToken({ vapidKey: 'YOUR_VAPID_KEY_HERE' }).then(token => {
    if (token) {
      db.ref('users/' + uid + '/fcmToken').set(token).catch(() => {});
      console.log('[FCM] Token saved');
    }
  }).catch(e => console.warn('[FCM] getToken failed:', e.message));
}

// ════ listenNotifications (معطل — messages-v2.js تتولى الإشعارات) ════
function listenNotifications(uid) {
  // ✅ معطل لأن messages-v2.js تستدعي showInAppNotif مباشرة عند وصول رسالة جديدة
  // هذا يمنع التكرار بين messages-v2.js و notifications.js
  console.log('[Notif] listenNotifications skipped — messages-v2.js handles notifications');
}

// ════ إشعار داخلي من messages-v2.js ════
function showInAppNotif(msg, sid, cid) {
  if (!sid || !cid) return;
  if (_isActiveChannel(sid, cid)) return;
  const tag = sid + '/' + cid + '/' + (msg.text || '').slice(0, 20) + '/' + (msg.uid || '') + '/' + (msg.ts || 0);
  if (_lastNotifSet.has(tag)) return;
  _lastNotifSet.add(tag);
  clearTimeout(_notifDebounceTimer);
  _notifDebounceTimer = setTimeout(() => { _lastNotifSet.clear(); }, 5000);
  _displayInAppNotif(msg.name || 'مستخدم', msg.text || '🖼️ وسائط', sid, cid, msg.name || '');
}

// ════ إشعار من listener (احتياطي — إذا أُعيد تفعيل listenNotifications لاحقاً) ════
function showInAppNotifFromListener(notif) {
  _displayInAppNotif(
    notif.senderName || 'مستخدم',
    notif.text || '🖼️ وسائط',
    notif.serverId,
    notif.channelId,
    notif.senderName || ''
  );
}

// ════ عرض الإشعار الداخلي (مرة واحدة فقط) ════
function _displayInAppNotif(name, text, sid, cid, senderName) {
  incrementUnread(sid, cid);
  playMsgSound();
  const old = document.getElementById('notifToast');
  if (old) old.remove();
  clearTimeout(_notifTimeout);
  const sv = servers[sid];
  const ch = sv?.channels?.[cid];
  if (!sv || !ch) return;
  const t = document.createElement('div');
  t.id = 'notifToast';
  t.className = 'notif-toast';
  t.innerHTML = `
    <div class="notif-av">${(senderName || '?')[0]}</div>
    <div class="notif-body">
      <div class="notif-title">${escHtml(sv.name || '')} · #${escHtml(ch.name || '')}</div>
      <div class="notif-text">${escHtml(name)}: ${escHtml(text)}</div>
    </div>
    <div style="font-size:18px;opacity:0.5;padding-right:4px">✕</div>
  `;
  t.addEventListener('click', () => {
    t.remove();
    selectServer(sid);
    setTimeout(() => { const ch2 = servers[sid]?.channels?.[cid]; if (ch2) selectChannel(sid, cid, ch2); }, 200);
  });
  document.body.appendChild(t);
  t.getBoundingClientRect();
  t.classList.add('show');
  _notifTimeout = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 5000);
}

// ════ إشعار DM ════
function showDmNotif(msg, fromUid) {
  if (_currentDmUid === fromUid) return;
  const tag = 'dm/' + fromUid + '/' + (msg.text || '').slice(0, 20) + '/' + (msg.ts || Date.now());
  if (_lastNotifSet.has(tag)) return;
  _lastNotifSet.add(tag);
  clearTimeout(_notifDebounceTimer);
  _notifDebounceTimer = setTimeout(() => { _lastNotifSet.clear(); }, 5000);
  _dmUnread[fromUid] = (_dmUnread[fromUid] || 0) + 1;
  if (typeof updateDmBadge === 'function') updateDmBadge();
  playMsgSound();
  const old = document.getElementById('notifToast');
  if (old) old.remove();
  clearTimeout(_notifTimeout);
  const t = document.createElement('div');
  t.id = 'notifToast';
  t.className = 'notif-toast';
  t.innerHTML = `
    <div class="notif-av">💬</div>
    <div class="notif-body">
      <div class="notif-title">رسالة خاصة</div>
      <div class="notif-text">${escHtml(msg.name || 'مستخدم')}: ${escHtml(msg.text || '🖼️')}</div>
    </div>
    <div style="font-size:18px;opacity:0.5;padding-right:4px">✕</div>
  `;
  t.addEventListener('click', () => {
    t.remove();
    openDM(fromUid, msg.name || 'مستخدم');
  });
  document.body.appendChild(t);
  t.getBoundingClientRect();
  t.classList.add('show');
  _notifTimeout = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 5000);
}

// ════ التحقق من القناة النشطة ════
function _isActiveChannel(sid, cid) {
  const activeSid = window.currentServerId !== undefined ? window.currentServerId : currentServer;
  const activeCid = window.currentChannelId !== undefined ? window.currentChannelId : currentChannel;
  return activeSid === sid && activeCid === cid;
}

// ════ صوت الإشعار ════
function playMsgSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => ctx.close(), 300);
  } catch(e) {}
}
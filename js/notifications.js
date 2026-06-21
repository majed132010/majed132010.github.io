// ════ NOTIFICATIONS ════
let _notifListener = null;
let _notifTimeout = null;
let _lastNotifSet = new Set();
let _notifDebounceTimer = null;
let _globalMsgListeners = {};
let _globalServersListener = null;

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

// ════ استماع الإشعارات العالمي (يعمل في كل مكان) ════
function listenNotifications(uid) {
  console.log('[Notif] listenNotifications skipped — using listenAllChannels instead');
}

// ════ مستمع جميع القنوات (بدون Cloud Functions) ════
function listenAllChannels() {
  if (!currentUser) return;
  console.log('[Notif] Starting global channel listener for', currentUser.uid);

  // استماع تغييرات قائمة العوالم
  const userServersRef = db.ref('users/' + currentUser.uid + '/servers');
  if (_globalServersListener) userServersRef.off('value', _globalServersListener);

  _globalServersListener = snap => {
    const userServers = snap.val() || {};
    const activePaths = new Set();

    Object.keys(userServers).forEach(sid => {
      // استماع القنوات في كل عالم
      db.ref('servers/' + sid + '/channels').once('value').then(chSnap => {
        const channels = chSnap.val() || {};
        Object.keys(channels).forEach(cid => {
          const path = 'messages/' + sid + '/' + cid;
          activePaths.add(path);

          if (_globalMsgListeners[path]) return; // مستمع موجود

          const q = db.ref(path).limitToLast(1);
          let initialized = false;
          let lastKey = null;

          const fn = snap => {
            if (!initialized) { lastKey = snap.key; return; }
            const msg = snap.val();
            if (!msg) return;
            if (msg.uid === currentUser.uid) return; // تجاهل رسائلي
            if (snap.key === lastKey) return; // نفس الرسالة
            lastKey = snap.key;

            // ✅ التحقق من القناة النشطة
            const activeSid = window.currentServerId !== undefined ? window.currentServerId : (typeof currentServer !== 'undefined' ? currentServer : null);
            const activeCid = window.currentChannelId !== undefined ? window.currentChannelId : (typeof currentChannel !== 'undefined' ? currentChannel : null);
            if (activeSid === sid && activeCid === cid) return; // في نفس القناة

            showInAppNotif(msg, sid, cid);
          };

          q.on('child_added', fn);
          q.once('value', () => { initialized = true; });
          _globalMsgListeners[path] = { q, fn, sid, cid };
          console.log('[Notif] Listening to', path);
        });
      });
    });

    // تنظيف المستمعات للقنوات القديمة
    Object.keys(_globalMsgListeners).forEach(path => {
      if (!activePaths.has(path)) {
        const { q, fn } = _globalMsgListeners[path];
        q.off('child_added', fn);
        delete _globalMsgListeners[path];
        console.log('[Notif] Stopped listening to', path);
      }
    });
  };

  userServersRef.on('value', _globalServersListener);
}

// ════ إشعار من messages-v2.js (احتياطي — إذا كان في نفس القناة) ════
function showInAppNotif(msg, sid, cid) {
  console.log('[Notif] showInAppNotif called', {sid, cid, name: msg.name});
  if (!sid || !cid) return;

  const activeSid = window.currentServerId !== undefined ? window.currentServerId : (typeof currentServer !== 'undefined' ? currentServer : null);
  const activeCid = window.currentChannelId !== undefined ? window.currentChannelId : (typeof currentChannel !== 'undefined' ? currentChannel : null);
  if (activeSid === sid && activeCid === cid) {
    console.log('[Notif] skipped — active channel');
    return;
  }

  const tag = sid + '/' + cid + '/' + (msg.text || '').slice(0, 20) + '/' + (msg.uid || '') + '/' + (msg.ts || 0);
  if (_lastNotifSet.has(tag)) {
    console.log('[Notif] skipped — duplicate');
    return;
  }
  _lastNotifSet.add(tag);
  clearTimeout(_notifDebounceTimer);
  _notifDebounceTimer = setTimeout(() => { _lastNotifSet.clear(); }, 5000);

  _displayChannelNotif({
    serverId: sid,
    channelId: cid,
    senderName: msg.name,
    text: msg.text,
    ts: msg.ts
  });
}

// ════ إشعار DM ════
function showDmNotif(msg, fromUid) {
  console.log('[Notif] showDmNotif called', {fromUid, name: msg.name});
  if (typeof _currentDmUid !== 'undefined' && _currentDmUid === fromUid) return;

  const tag = 'dm/' + fromUid + '/' + (msg.text || '').slice(0, 20) + '/' + (msg.ts || Date.now());
  if (_lastNotifSet.has(tag)) return;
  _lastNotifSet.add(tag);
  clearTimeout(_notifDebounceTimer);
  _notifDebounceTimer = setTimeout(() => { _lastNotifSet.clear(); }, 5000);

  if (typeof _dmUnread !== 'undefined') {
    _dmUnread[fromUid] = (_dmUnread[fromUid] || 0) + 1;
  }
  if (typeof updateDmBadge === 'function') updateDmBadge();
  playMsgSound();

  _displayDmNotif({
    fromUid: fromUid,
    senderName: msg.name,
    text: msg.text,
    ts: msg.ts
  });
}

// ════ عرض إشعار قناة عامة ════
function _displayChannelNotif(notif) {
  console.log('[Notif] displaying channel notif:', notif.text?.slice(0, 30));

  if (typeof incrementUnread === 'function') incrementUnread(notif.serverId, notif.channelId);
  playMsgSound();

  const old = document.getElementById('notifToast');
  if (old) old.remove();
  clearTimeout(_notifTimeout);

  const sv = typeof servers !== 'undefined' ? servers[notif.serverId] : null;
  const ch = sv?.channels?.[notif.channelId];
  const serverName = sv?.name || 'عوالم';
  const channelName = ch?.name || 'قناة';

  const t = document.createElement('div');
  t.id = 'notifToast';
  t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-120%);z-index:10000;background:rgba(15,25,35,0.95);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:12px 16px;display:flex;align-items:center;gap:12px;min-width:280px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.4);cursor:pointer;transition:transform 0.4s cubic-bezier(0.34,1.56,0.64,1),opacity 0.3s ease;font-family:Tajawal,sans-serif;opacity:0;';

  t.innerHTML = `
    <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#1a5f5f,#1a6a6a);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#fff;flex-shrink:0">${(notif.senderName || '?')[0]}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;color:#d4af37;font-weight:700;margin-bottom:2px">${escHtml(serverName)} · #${escHtml(channelName)}</div>
      <div style="font-size:14px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(notif.senderName || 'مستخدم')}: ${escHtml(notif.text || '🖼️')}</div>
    </div>
    <div style="font-size:16px;opacity:0.4;padding:0 4px;flex-shrink:0">✕</div>
  `;

  t.addEventListener('click', (e) => {
    if (e.target.textContent === '✕') { t.remove(); return; }
    t.remove();
    if (typeof selectServer === 'function') selectServer(notif.serverId);
    if (ch && typeof selectChannel === 'function') {
      setTimeout(() => selectChannel(notif.serverId, notif.channelId, ch), 200);
    }
  });

  document.body.appendChild(t);
  requestAnimationFrame(() => {
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
  });

  _notifTimeout = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(-120%)';
    setTimeout(() => t.remove(), 400);
  }, 5000);
}

// ════ عرض إشعار DM ════
function _displayDmNotif(notif) {
  console.log('[Notif] displaying DM notif:', notif.text?.slice(0, 30));

  const old = document.getElementById('notifToast');
  if (old) old.remove();
  clearTimeout(_notifTimeout);

  const t = document.createElement('div');
  t.id = 'notifToast';
  t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-120%);z-index:10000;background:rgba(15,25,35,0.95);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:12px 16px;display:flex;align-items:center;gap:12px;min-width:280px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.4);cursor:pointer;transition:transform 0.4s cubic-bezier(0.34,1.56,0.64,1),opacity 0.3s ease;font-family:Tajawal,sans-serif;opacity:0;';

  t.innerHTML = `
    <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#5865f2,#4752c4);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#fff;flex-shrink:0">💬</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;color:#d4af37;font-weight:700;margin-bottom:2px">رسالة خاصة</div>
      <div style="font-size:14px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(notif.senderName || 'مستخدم')}: ${escHtml(notif.text || '🖼️')}</div>
    </div>
    <div style="font-size:16px;opacity:0.4;padding:0 4px;flex-shrink:0">✕</div>
  `;

  t.addEventListener('click', (e) => {
    if (e.target.textContent === '✕') { t.remove(); return; }
    t.remove();
    if (typeof openDM === 'function') openDM(notif.fromUid, notif.senderName || 'مستخدم');
  });

  document.body.appendChild(t);
  requestAnimationFrame(() => {
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
  });

  _notifTimeout = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(-120%)';
    setTimeout(() => t.remove(), 400);
  }, 5000);
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

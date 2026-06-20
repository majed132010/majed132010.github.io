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

// ════ listenNotifications (معطل — messages-v2.js تتولى الأمر) ════
function listenNotifications(uid) {
  console.log('[Notif] listenNotifications skipped');
}

// ════ إشعار من messages-v2.js (قنوات عامة) ════
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
  
  _displayInAppNotif(msg.name || 'مستخدم', msg.text || '🖼️ وسائط', sid, cid, msg.name || '');
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
  
  const old = document.getElementById('notifToast');
  if (old) old.remove();
  clearTimeout(_notifTimeout);
  
  const t = document.createElement('div');
  t.id = 'notifToast';
  t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-120%);z-index:10000;background:rgba(15,25,35,0.95);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:12px 16px;display:flex;align-items:center;gap:12px;min-width:280px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.4);cursor:pointer;transition:transform 0.4s cubic-bezier(0.34,1.56,0.64,1),opacity 0.3s ease;font-family:Tajawal,sans-serif;opacity:0;';
  
  t.innerHTML = `
    <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#5865f2,#4752c4);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#fff;flex-shrink:0">💬</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;color:var(--gold);font-weight:700;margin-bottom:2px">رسالة خاصة</div>
      <div style="font-size:14px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(msg.name || 'مستخدم')}: ${escHtml(msg.text || '🖼️')}</div>
    </div>
    <div style="font-size:16px;opacity:0.4;padding:0 4px;flex-shrink:0">✕</div>
  `;
  
  t.addEventListener('click', (e) => {
    if (e.target.textContent === '✕') { t.remove(); return; }
    t.remove();
    if (typeof openDM === 'function') openDM(fromUid, msg.name || 'مستخدم');
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

// ════ عرض الإشعار العام (مثل السناب) ════
function _displayInAppNotif(name, text, sid, cid, senderName) {
  console.log('[Notif] _displayInAppNotif', {name, text: text?.slice(0,30)});
  incrementUnread(sid, cid);
  playMsgSound();
  
  const old = document.getElementById('notifToast');
  if (old) old.remove();
  clearTimeout(_notifTimeout);
  
  const sv = typeof servers !== 'undefined' ? servers[sid] : null;
  const ch = sv?.channels?.[cid];
  const serverName = sv?.name || 'عوالم';
  const channelName = ch?.name || 'قناة';
  
  const t = document.createElement('div');
  t.id = 'notifToast';
  t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-120%);z-index:10000;background:rgba(15,25,35,0.95);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:12px 16px;display:flex;align-items:center;gap:12px;min-width:280px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.4);cursor:pointer;transition:transform 0.4s cubic-bezier(0.34,1.56,0.64,1),opacity 0.3s ease;font-family:Tajawal,sans-serif;opacity:0;';
  
  t.innerHTML = `
    <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--acc),#1a6a6a);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#fff;flex-shrink:0">${(senderName || '?')[0]}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;color:var(--gold);font-weight:700;margin-bottom:2px">${escHtml(serverName)} · #${escHtml(channelName)}</div>
      <div style="font-size:14px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(name)}: ${escHtml(text)}</div>
    </div>
    <div style="font-size:16px;opacity:0.4;padding:0 4px;flex-shrink:0">✕</div>
  `;
  
  t.addEventListener('click', (e) => {
    if (e.target.textContent === '✕') { t.remove(); return; }
    t.remove();
    if (typeof selectServer === 'function') selectServer(sid);
    if (ch && typeof selectChannel === 'function') {
      setTimeout(() => selectChannel(sid, cid, ch), 200);
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

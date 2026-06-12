// ════ NOTIFICATIONS ════
const VAPID_KEY = 'BF_3lIDRYXMTohfkR1hmqyV3Z1YdZG9jq6s87-tjRsmwvsf1hWs2xbkdj5CCU-jpRHAC9rPRQD_aUvGoZfHQ7rk';
let fcmMessaging = null;
let _notifTimeout = null;
let _dndActive = false;

// مفاتيح الإشعارات التي عالجناها في هذه الجلسة — يمنع المعالجة المزدوجة
const _notifProcessed = new Set();
// آخر وقت عرض لكل tag (نوع + مرسل) — يكبح البانرات المتلاحقة
const _lastShownTag = {};

// ════ استماع للإشعارات الواردة ════
let _notifListener = null;
function listenNotifications(userId) {
  if (_notifListener) return;

  // نقطة بداية الجلسة — نُعالج فقط الإشعارات الجديدة فعلاً.
  // استخدام orderByChild('ts').startAt بدلاً من limitToLast(1) يقطع
  // حلقة cascade الكلاسيكية: حذف الإشعار الأخير يُظهر السابق له →
  // child_added → delete → child_added ... بلا نهاية.
  const sessionStart = Date.now();
  const ref = db.ref('notifications/' + userId)
    .orderByChild('ts')
    .startAt(sessionStart - 8000); // تحمّل تأخير الساعة حتى 8 ثوانٍ

  const fn = snap => {
    if (!snap.exists()) return;
    // ──── belt-and-suspenders: لا نعالج نفس المفتاح مرتين في الجلسة ────
    if (_notifProcessed.has(snap.key)) return;
    _notifProcessed.add(snap.key);

    const notif = snap.val();
    if (!notif) return;

    // ──── احذف الإشعار فوراً — يجب أن يكون أول إجراء قبل أي return ────
    // إن فشل الحذف (صلاحيات) نسجّله فقط ولا نتوقف
    db.ref('notifications/' + userId + '/' + snap.key)
      .remove()
      .catch(e => console.warn('[NOTIF] فشل حذف الإشعار:', snap.key, e.code));

    // ──── فلاتر العرض — الحذف تمّ بالفعل فلا بأس بالخروج المبكر ────
    if (notif.ts < sessionStart - 8000) return; // قديم جداً — نظّفناه دون عرض
    if (notif.from === userId) return;           // إشعار ذاتي
    if (notif.data?.type === 'call') return;     // المكالمات لها قناة عرض خاصة (calls.js)

    const title = notif.title || 'عوالم';
    const body  = notif.body  || '';
    const tag   = (notif.data?.type || 'msg') + '_' + (notif.data?.fromUid || notif.from || '');
    const now   = Date.now();

    // ──── كبح البانرات المتلاحقة — إشعار واحد كل 4 ثوانٍ لنفس tag ────
    if (_lastShownTag[tag] && now - _lastShownTag[tag] < 4000) return;
    _lastShownTag[tag] = now;

    if (Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body, icon: '/icon-192.png', tag });
    } else if (!document.hidden) {
      if (notif.data?.type === 'dm') {
        showDmNotif({ name: title, text: body }, notif.data?.fromUid);
      } else {
        const _sid = notif.data?.serverId, _cid = notif.data?.channelId;
        if (_sid && _cid && !(currentServer === _sid && currentChannel === _cid)) {
          showInAppNotif({ name: notif.data?.senderName || title, text: body }, _sid, _cid);
        }
      }
    }
  };

  ref.on('child_added', fn);
  _notifListener = { ref, fn };
}

// ════ تهيئة FCM ════
async function initFCM(userId) {
  try {
    if (!('Notification' in window)) return;
    fcmMessaging = FB.messaging();
    fcmMessaging.onMessage(payload => {
      const { title, body } = payload.notification || {};
      const data = payload.data || {};
      if (data.type === 'dm' && data.fromUid) {
        showDmNotif({ name: title || 'رسالة خاصة', text: body || '' }, data.fromUid);
      } else if (data.serverId && data.channelId) {
        if (currentServer === data.serverId && currentChannel === data.channelId) return;
        showInAppNotif({ name: data.senderName || title, text: body || '' }, data.serverId, data.channelId);
      } else {
        toast('🔔 ' + (title || 'عوالم') + ': ' + (body || ''));
      }
    });
    if (Notification.permission === 'granted') {
      const token = await fcmMessaging.getToken({ vapidKey: VAPID_KEY });
      if (token && userId) await db.ref('users/' + userId + '/fcmToken').set(token);
    } else if (Notification.permission !== 'denied') {
      const isMob = /Android|iPhone|iPad/i.test(navigator.userAgent);
      if (isMob) {
        setTimeout(async () => {
          try {
            const perm = await Notification.requestPermission();
            if (perm === 'granted') {
              const token = await fcmMessaging.getToken({ vapidKey: VAPID_KEY });
              if (token && userId) await db.ref('users/' + userId + '/fcmToken').set(token);
              toast('✅ تم تفعيل الإشعارات!');
            }
          } catch(e) { console.warn('FCM mobile error:', e); }
        }, 2000);
      } else {
        showNotifBtn(userId);
      }
    }
  } catch(e) { console.warn('FCM init error:', e); }
}

function showNotifBtn(userId) {
  const existing = document.getElementById('notifPermBtn');
  if (existing) return;
  const btn = document.createElement('button');
  btn.id = 'notifPermBtn';
  btn.innerHTML = '🔔 فعّل الإشعارات';
  btn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#1a5f5f;color:#fff;border:none;border-radius:24px;padding:12px 24px;font-family:Tajawal,sans-serif;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.3)';
  btn.onclick = async () => {
    btn.remove();
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const token = await fcmMessaging.getToken({ vapidKey: VAPID_KEY });
        if (token && userId) await db.ref('users/' + userId + '/fcmToken').set(token);
        toast('✅ تم تفعيل الإشعارات!');
      }
    } catch(e) { console.log('Notif error:', e); }
  };
  document.body.appendChild(btn);
  setTimeout(() => btn.remove(), 10000);
}

// ════ DO NOT DISTURB ════
function toggleDND() {
  _dndActive = !_dndActive;
  const btn = document.getElementById('dndBtn');
  if (_dndActive) {
    btn.textContent = '🔕';
    btn.classList.add('active');
    btn.querySelector('.dnd-tooltip').textContent = 'إلغاء عدم الإزعاج';
    toast('🔕 وضع عدم الإزعاج مفعّل');
  } else {
    btn.innerHTML = '🔔<span class="dnd-tooltip">وضع عدم الإزعاج</span>';
    btn.classList.remove('active');
    toast('🔔 الإشعارات مفعّلة');
  }
}

// ════ صوت الإشعار ════
function playMsgSound() {
  if (_dndActive) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

// ════ إشعار داخلي للرسائل العامة ════
function showInAppNotif(msg, sid, cid) {
  if (!sid || !cid) return;
  if (currentServer === sid && currentChannel === cid) return;
  incrementUnread(sid, cid);
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
    <div class="notif-av">${(msg.name||'?')[0]}</div>
    <div class="notif-body">
      <div class="notif-title">${escHtml(sv.name||'')} · #${escHtml(ch.name||'')}</div>
      <div class="notif-text">${escHtml(msg.name||'')}: ${escHtml(msg.text || '🖼️ وسائط')}</div>
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

// ════ إشعار داخلي للرسائل الخاصة ════
function showDmNotif(msg, fromUid) {
  if (_currentDmUid === fromUid) return;

  // زيادة العداد دائماً
  _dmUnread[fromUid] = (_dmUnread[fromUid] || 0) + 1;
  updateDmBadge();

  const senderName = msg.name || 'رسالة خاصة';
  const body = msg.text
    ? msg.text.slice(0, 60)
    : msg.mediaUrl ? '🖼️ صورة'
    : msg.voiceUrl ? '🎤 رسالة صوتية'
    : '';
  if (!body && !senderName) return;

  playMsgSound();

  // إشعار النظام إذا التطبيق في الخلفية — بدون return
  if (Notification.permission === 'granted' && document.hidden) {
    new Notification(senderName, { body: body || '...', icon: '/icon-192.png', tag: 'dm-' + fromUid });
  }

  // إشعار داخل التطبيق دائماً
  const old = document.getElementById('notifToast');
  if (old) old.remove();
  clearTimeout(_notifTimeout);
  const t = document.createElement('div');
  t.id = 'notifToast';
  t.className = 'notif-toast';
  t.innerHTML = `
    <div class="notif-av">${senderName[0]}</div>
    <div class="notif-body">
      <div class="notif-title">💬 ${escHtml(senderName)}</div>
      <div class="notif-text">${escHtml(body || '...')}</div>
    </div>
    <div style="font-size:18px;opacity:0.5;padding-right:4px">✕</div>
  `;
  t.addEventListener('click', () => { t.remove(); openDM(fromUid, senderName); });
  document.body.appendChild(t);
  t.getBoundingClientRect();
  t.classList.add('show');
  _notifTimeout = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 5000);
}

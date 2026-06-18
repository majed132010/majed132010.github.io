// ═════════════════════════════════════════════════════════════════
// ════ AUTH & USER SYSTEM ═════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════

let currentUser = null;
let userProfile = {};

auth.getRedirectResult().then(result => {
 if (result && result.user) {
 console.log('[AUTH] ✓ عاد المستخدم من إعادة التوجيه بنجاح:', result.user.uid);
 history.replaceState(null, '', location.href);
 }
}).catch(e => {
 if (e.code && e.code !== 'auth/no-auth-event') console.error('[AUTH] ✖ خطأ في إعادة التوجيه:', e.code, e.message);
});

// Idempotent — safe to call multiple times; does nothing once splash is gone
function _dismissSplash() {
 const splash = document.getElementById('splashScreen');
 if (!splash) return;
 splash.classList.add('splash-out');
 setTimeout(() => { if (splash.parentNode) splash.remove(); }, 450);
}

// Fail-safe: force-dismiss after 2.5 s even if onAuthStateChanged never fires
setTimeout(_dismissSplash, 2500);

// ════ وظيفة حالة الاتصال الحية (Online Status System) ════
function updateOnlineStatus(isOnline) {
 if (!currentUser) return;
 db.ref('users/' + currentUser.uid).update({
 online: isOnline,
 lastSeen: Date.now()
 });
 if (isOnline) {
 db.ref('users/' + currentUser.uid + '/online').onDisconnect().set(false);
 db.ref('users/' + currentUser.uid + '/lastSeen').onDisconnect().set(Date.now());
 }
}

// ════ رسم لوحة المستخدم السفلى فوراً بمجرد توفّر بيانات Auth ════
function renderSidebarBottom(user) {
 if (!userProfile.displayName) userProfile.displayName = user.displayName || user.email?.split('@')[0] || 'مستخدم';
 if (!userProfile.avatar) userProfile.avatar = user.photoURL || null;
 updateUserPanel();
}

// ════ مستمع حالة الحساب والاتصال الأساسي ════
auth.onAuthStateChanged(user => {
 _dismissSplash();
 if (user) {
 currentUser = user;
 document.getElementById('loginScreen').style.display = 'none';
 const app = document.getElementById('app');
 if (app) app.style.display = 'flex';
 renderSidebarBottom(user);
 loadUserProfile().then(() => {
 initApp();
 initFCM(user.uid);
 listenNotifications(user.uid);

 // 🆕 تفعيل بث حالة الاتصال الحية للمستخدم فور الدخول
 updateOnlineStatus(true);
 window.addEventListener('beforeunload', () => updateOnlineStatus(false));

 // تسجيل مستمع المكالمات الواردة
 if (typeof listenIncomingCalls === 'function') {
 console.log('[CALL] 📞 استدعاء listenIncomingCalls بعد تسجيل الدخول لـ', user.uid);
 listenIncomingCalls();
 } else {
 console.error('[CALL] ✖ الدالة listenIncomingCalls غير معرّفة — تأكد من تحميل js/calls.js');
 }
 });
 } else {
 currentUser = null;
 // نظّف مستمع الإشعارات فوراً عند تسجيل الخروج
 if (typeof _notifListener !== 'undefined' && _notifListener) {
 _notifListener.ref.off('child_added', _notifListener.fn);
 _notifListener = null;
 }
 document.getElementById('loginScreen').style.display = 'flex';
 const app = document.getElementById('app');
 if (app) app.style.display = 'none';
 }
});

const _GOOGLE_BTN_HTML = ' دخول بـ Google';

// ════ حفظ Firebase idToken في IndexedDB ليقرأه الـ Service Worker ════
const _AUTH_IDB_NAME = 'awalem-auth';
const _AUTH_IDB_STORE = 'kv';

function _openAuthIDB() {
 return new Promise((resolve, reject) => {
 const req = indexedDB.open(_AUTH_IDB_NAME, 1);
 req.onupgradeneeded = () => {
 const dbi = req.result;
 if (!dbi.objectStoreNames.contains(_AUTH_IDB_STORE)) dbi.createObjectStore(_AUTH_IDB_STORE);
 };
 req.onsuccess = () => resolve(req.result);
 req.onerror = () => reject(req.error);
 });
}

function _putAuthKV(key, val) {
 return _openAuthIDB().then(dbi => new Promise((res, rej) => {
 const tx = dbi.transaction(_AUTH_IDB_STORE, 'readwrite');
 if (val === null) tx.objectStore(_AUTH_IDB_STORE).delete(key);
 else tx.objectStore(_AUTH_IDB_STORE).put(val, key);
 tx.oncomplete = res; tx.onerror = () => rej(tx.error);
 }));
}

auth.onIdTokenChanged(async user => {
 try {
 if (user) {
 const token = await user.getIdToken();
 await _putAuthKV('current', { idToken: token, ts: Date.now() });
 console.log('[AUTH] ✓ حُفظ idToken في IndexedDB لقراءته من الـ SW');
 } else {
 await _putAuthKV('current', null);
 console.log('[AUTH] 🗑️ مُسح idToken من IndexedDB (خروج)');
 }
 } catch (e) { console.warn('[AUTH] تعذّر تحديث idToken في IndexedDB:', e); }
});

function _restoreSignInBtn(btn) {
 if (!btn) return;
 btn.disabled = false;
 btn.innerHTML = _GOOGLE_BTN_HTML;
}

function signInGoogle() {
 if (currentUser) return;
 const btn = document.getElementById('googleSignInBtn');
 if (btn) { btn.disabled = true; btn.textContent = 'جاري التحميل...'; }
 const provider = new firebase.auth.GoogleAuthProvider();
 provider.setCustomParameters({ prompt: 'select_account' });

 auth.signInWithPopup(provider)
 .then(() => { if (btn) btn.disabled = false; })
 .catch(e => {
 console.error('[AUTH] ✖ فشل popup:', e.code, e.message);
 _restoreSignInBtn(btn);
 const popupFailed = e.code === 'auth/popup-blocked'
 || e.code === 'auth/operation-not-supported-in-this-environment'
 || e.code === 'auth/cancelled-popup-request'
 || e.code === 'auth/web-storage-unsupported';
 if (popupFailed) {
 console.log('[AUTH] تعذّر الـ popup — التحويل التلقائي إلى redirect');
 auth.signInWithRedirect(provider).catch(err => {
 console.error('[AUTH] ✖ فشل redirect الاحتياطي:', err.code, err.message);
 toast('⚠️ اضغط مجدداً لتسجيل الدخول');
 });
 } else if (e.code !== 'auth/popup-closed-by-user') {
 toast('❌ خطأ: ' + (e.message || e.code));
 }
 });
}

async function loadUserProfile() {
 const snap = await db.ref('users/' + currentUser.uid).once('value');
 userProfile = snap.val() || {};
 if (!userProfile.displayName) {
 userProfile.displayName = currentUser.displayName || 'مستخدم';
 userProfile.tag = String(Math.floor(1000 + Math.random() * 9000));
 userProfile.adminCode = generateAdminCode();
 if (!userProfile.avatar && currentUser.photoURL) userProfile.avatar = currentUser.photoURL;
 await db.ref('users/' + currentUser.uid).update(userProfile);
 } else if (!userProfile.avatar && currentUser.photoURL) {
 userProfile.avatar = currentUser.photoURL;
 db.ref('users/' + currentUser.uid + '/avatar').set(currentUser.photoURL);
 }
 if (!userProfile.adminCode) {
 userProfile.adminCode = generateAdminCode();
 await db.ref('users/' + currentUser.uid + '/adminCode').set(userProfile.adminCode);
 }
 updateUserPanel();
}

function updateUserPanel() {
 const av = document.getElementById('upAv');
 if (av) {
 const src = userProfile.avatar || auth.currentUser?.photoURL || null;
 if (src) {av.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover">`; } else {
 av.textContent = (userProfile.displayName || '?')[0];
 }
 }
 document.getElementById('upName').textContent = userProfile.displayName || '—';
 document.getElementById('upTag').textContent = '#' + (userProfile.tag || '0000');
 const dni = document.getElementById('displayNameInp');
 if (dni) dni.value = userProfile.displayName || '';
}

function openEditProfile() {
 const nameInp = document.getElementById('displayNameInp');
 if (nameInp) nameInp.value = userProfile.displayName || '';
 const fileInp = document.getElementById('epAvatarInput');
 if (fileInp) fileInp.value = '';
 const prev = document.getElementById('epAvatarPreview');
 if (prev) {
 if (userProfile.avatar) {prev.innerHTML = `<img src="${userProfile.avatar}" style="width:100%;height:100%;object-fit:cover">`; } else {
 prev.textContent = (userProfile.displayName || '?')[0];
 }
 }
 openModal('settingsModal');
}

function previewEditAvatar(input) {
 const file = input.files[0];
 if (!file) return;
 if (file.size > 3 * 1024 * 1024) { toast('❌ الصورة أكبر من 3MB'); input.value = ''; return; }
 const reader = new FileReader();
 reader.onload = e => {
 const prev = document.getElementById('epAvatarPreview');if (prev) prev.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`; };
 reader.readAsDataURL(file);
}

async function _syncProfileToServers(name, avatarUrl) {
 if (!currentUser) return;
 const snap = await db.ref('users/' + currentUser.uid + '/servers').once('value');
 const sids = snap.val() || {};
 const updates = {};
 Object.keys(sids).forEach(sid => {
 updates['servers/' + sid + '/members/' + currentUser.uid + '/name'] = name;
 updates['servers/' + sid + '/members/' + currentUser.uid + '/avatar'] = avatarUrl || null;
 });
 if (Object.keys(updates).length) await db.ref().update(updates);
}

async function saveSettings() {
 const name = (document.getElementById('displayNameInp')?.value || '').trim();
 if (!name) { toast('❌ الاسم لا يمكن أن يكون فارغاً'); return; }

 const btn = document.querySelector('#settingsModal .modal-btn:not(.secondary)');
 if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري الحفظ...'; }

 try {
 let avatarUrl = userProfile.avatar || null;
 const fileInp = document.getElementById('epAvatarInput');
 const file = fileInp?.files[0];

 if (file) {
 toast('⏳ جاري رفع الصورة...');
 avatarUrl = await uploadToStorage(file, `avatars/${currentUser.uid}/avatar.jpg`);
 }

 const profileUpdate = { displayName: name };
 if (avatarUrl) profileUpdate.photoURL = avatarUrl;
 await auth.currentUser.updateProfile(profileUpdate);

 await db.ref('users/' + currentUser.uid).update({ displayName: name, avatar: avatarUrl });

 userProfile.displayName = name;
 userProfile.avatar = avatarUrl;

 await _syncProfileToServers(name, avatarUrl);

 updateUserPanel();
 closeModal('settingsModal');
 toast('✅ تم حفظ التغييرات بنجاح');
 } catch(e) {
 toast('❌ فشل الحفظ: ' + (e.message || e.code || ''));
 console.error('[Profile] save error:', e);
 } finally {
 if (btn) { btn.disabled = false; btn.textContent = '💾 حفظ التغييرات'; }
 }
}

async function doSignOut() {
 if (typeof localAudioTrack !== 'undefined' && localAudioTrack) localAudioTrack.close();
 if (typeof agoraClient !== 'undefined' && agoraClient) await agoraClient.leave();
 await auth.signOut();
}

async function uploadAvatar(input) {
 const file = input.files[0];
 if (!file || !currentUser) return;
 if (file.size > 3 * 1024 * 1024) { toast('❌ الصورة أكبر من 3MB'); return; }
 toast('⏳ جاري رفع الصورة...');
 try {
 const url = await uploadToStorage(file, `avatars/${currentUser.uid}/avatar.jpg`);
 await db.ref('users/' + currentUser.uid + '/avatar').set(url);
 await auth.currentUser.updateProfile({ photoURL: url });
 userProfile.avatar = url;
 const av = document.getElementById('profileAvatar');if (av) av.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`; updateUserPanel();
 await _syncProfileToServers(userProfile.displayName || '', url);
 toast('✅ تم تحديث الصورة');
 } catch(e) { toast('❌ فشل رفع الصورة: ' + (e.message || '')); }
}

function openProfile() {
 db.ref('users/' + currentUser.uid + '/avatar').once('value').then(snap => {
 const av = document.getElementById('profileAvatar');if (snap.val()) { if(av) av.innerHTML = `<img src="${snap.val()}" style="width:100%;height:100%;object-fit:cover">`; } else { if(av) av.textContent = (userProfile.displayName||'?')[0]; }
 });
 const nameEl = document.getElementById('profileName');
 const tagEl = document.getElementById('profileTag');
 const codeEl = document.getElementById('profileAdminCode');
 if(nameEl) nameEl.textContent = userProfile.displayName || '—';
 if(tagEl) tagEl.textContent = '#' + (userProfile.tag || '0000');
 if(codeEl) codeEl.textContent = userProfile.adminCode || '—';
 const badge = document.getElementById('profileRoleBadge');
 if (badge) {
 if (currentServer && servers[currentServer]) {
 const role = servers[currentServer].members?.[currentUser.uid]?.role;
 if (role === 'owner') badge.innerHTML = '👑 مالك';
 else if (role === 'admin') badge.innerHTML = '🛡️ مشرف';
 else badge.innerHTML = '';
 } else badge.innerHTML = '';
 }
 openModal('profileModal');
}

// ═════════════════════════════════════════════════════════════════
// 🆕 دالة بطاقة العضو البارزة الفخمة (Quick Action Member Card)
// ═════════════════════════════════════════════════════════════════
function openMemberCard(uid, name, avatar) {
  console.log('[DEBUG] openMemberCard called', uid, name);

  // ✅ FIX v4: إزالة البطاقة القديمة إن وجدت
  const existing = document.getElementById('memberCardOverlay');
  if (existing) existing.remove();

  // ✅ FIX v4: إنشاء البطاقة في setTimeout بعد انتهاء الـ click الحالي
  // هذا يضمن أن Ghost Click لا يصل للبطاقة
  setTimeout(() => {
    _buildMemberCard(uid, name, avatar);
  }, 50);
}

// ✅ FIX v4: دالة بناء البطاقة منفصلة
function _buildMemberCard(uid, name, avatar) {
  const overlay = document.createElement('div');
  overlay.id = 'memberCardOverlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;border:none;outline:none;overflow:visible;margin:0;max-width:none;max-height:none;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#1e2d3d;border-radius:20px;padding:32px 28px;min-width:260px;max-width:320px;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,0.8);border:1px solid rgba(255,255,255,0.15);font-family:Tajawal,sans-serif;';

  const avEl = document.createElement('div');
  avEl.style.cssText = 'width:86px;height:86px;border-radius:50%;background:#253040;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;color:#fff;overflow:hidden;flex-shrink:0';
  if (avatar) avEl.innerHTML = `<img src="${avatar}" style="width:100%;height:100%;object-fit:cover">`;
  else avEl.textContent = (name || '?')[0];

  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'font-size:18px;font-weight:700;color:#fff;margin-top:4px;text-align:center';
  nameEl.textContent = name || '—';

  const tagEl = document.createElement('div');
  tagEl.style.cssText = 'font-size:13px;color:var(--muted,#8899aa)';
  db.ref('users/' + uid + '/tag').once('value').then(s => { if (s.val()) tagEl.textContent = '#' + s.val(); });

  // حالة الاتصال الحية
  const onlineEl = document.createElement('div');
  onlineEl.style.cssText = 'font-size:12px;display:flex;align-items:center;gap:5px;margin-top:2px;';
  db.ref('users/' + uid + '/online').once('value').then(s => {
    const isOn = s.val() === true;
    onlineEl.innerHTML = isOn
      ? '<span style="width:8px;height:8px;border-radius:50%;background:#3ba55c;display:inline-block"></span> متصل الآن'
      : '<span style="width:8px;height:8px;border-radius:50%;background:#888;display:inline-block"></span> غير متصل';
  });

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;justify-content:center';

  const mkBtn = (icon, label, fn) => {
    const b = document.createElement('button');
    b.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 14px;background:rgba(255,255,255,0.07);border:none;border-radius:14px;color:#fff;font-family:Tajawal,sans-serif;font-size:12px;font-weight:600;cursor:pointer;min-width:72px;';
    b.innerHTML = `${icon}<span style="font-size:11px">${label}</span>`;
    b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.13)');
    b.addEventListener('mouseleave', () => b.style.background = 'rgba(255,255,255,0.07)');
    b.addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); fn(); });
    return b;
  };

  btns.appendChild(mkBtn('💬', 'رسالة خاصة', () => { setTimeout(() => openDM(uid, name), 50); }));
  if (uid !== currentUser?.uid) {
    btns.appendChild(mkBtn('📞', 'صوتي', () => startCall(uid, name, 'audio')));
    btns.appendChild(mkBtn('📹', 'فيديو', () => startCall(uid, name, 'video')));
  }

  card.appendChild(avEl);
  card.appendChild(nameEl);
  card.appendChild(tagEl);
  card.appendChild(onlineEl);
  card.appendChild(btns);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // ✅ FIX v4: إغلاق عند الضغط على الخلفية فقط (بعد تأكد من عدم وجود Ghost Click)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });
}

function copyAdminCode() {
 const code = userProfile.adminCode || '';
 navigator.clipboard?.writeText(code).then(() => toast('📋 تم نسخ الكود: ' + code));
}

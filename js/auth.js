// ════ AUTH & USER ════
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
// (slow network, Firebase initialisation error, blocked by browser, etc.)
setTimeout(_dismissSplash, 2500);

// ════ رسم لوحة المستخدم السفلى فوراً بمجرد توفّر بيانات Auth ════
// يُحلّ مشكلة تأخّر ظهور ترس الإعدادات حتى اكتمال listenServers الـ async
function renderSidebarBottom(user) {
  // ابنِ userProfile مؤقتاً من بيانات Auth إذا لم يكن محمَّلاً بعد
  if (!userProfile.displayName) userProfile.displayName = user.displayName || user.email?.split('@')[0] || 'مستخدم';
  if (!userProfile.avatar)      userProfile.avatar      = user.photoURL || null;
  updateUserPanel();
}

auth.onAuthStateChanged(user => {
  _dismissSplash(); // dismiss immediately on auth resolution (fast path)
  if (user) {
    currentUser = user;
    document.getElementById('loginScreen').style.display = 'none';
    const app = document.getElementById('app');
    if (app) app.style.display = 'flex';
    renderSidebarBottom(user); // اعرض الشريط السفلي فوراً قبل أي قراءة من Firebase
    loadUserProfile().then(() => {
      initApp();
      initFCM(user.uid);
      listenNotifications(user.uid);
      // تسجيل مستمع المكالمات الواردة — بدونه لا يستقبل الطرف الآخر أي مكالمة
      if (typeof listenIncomingCalls === 'function') {
        console.log('[CALL] استدعاء listenIncomingCalls بعد تسجيل الدخول لـ', user.uid);
        listenIncomingCalls();
      } else {
        console.error('[CALL] ✖ الدالة listenIncomingCalls غير معرّفة — تأكد من تحميل js/calls.js');
      }
    });
  } else {
    currentUser = null;
    // نظّف مستمع الإشعارات فوراً عند تسجيل الخروج — يمنع تلقّي إشعارات الجلسة القديمة
    if (typeof _notifListener !== 'undefined' && _notifListener) {
      _notifListener.ref.off('child_added', _notifListener.fn);
      _notifListener = null;
    }
    document.getElementById('loginScreen').style.display = 'flex';
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
  }
});

const _GOOGLE_BTN_HTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg> دخول بـ Google';

// ════ 🆕 حفظ Firebase idToken في IndexedDB ليقرأه الـ Service Worker ════
// يستخدمه الـ SW لكتابة رفض المكالمة الصامت مُصادَقاً (?auth=ID_TOKEN) في RTDB.
// نفس اسم القاعدة/المخزن مستخدم في firebase-messaging-sw.js للقراءة.
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

// يُطلق عند الدخول، وعند كل تجديد تلقائي للتوكن (كل ~ساعة)، وعند الخروج
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

  // الأساس: signInWithPopup. وعند حظره/تعذّره من المتصفح: تحويل تلقائي إلى signInWithRedirect.
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
    // بذر صورة Google عند أول تسجيل دخول إن لم تُحفظ بعد
    if (!userProfile.avatar && currentUser.photoURL) userProfile.avatar = currentUser.photoURL;
    await db.ref('users/' + currentUser.uid).update(userProfile);
  } else if (!userProfile.avatar && currentUser.photoURL) {
    // مستخدم قديم لم تُحفظ له صورة بعد — نحفظها الآن
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
    // RTDB avatar أولاً، ثم صورة Google الحية كاحتياط
    const src = userProfile.avatar || auth.currentUser?.photoURL || null;
    if (src) {
      av.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
    } else {
      av.textContent = (userProfile.displayName || '?')[0];
    }
  }
  document.getElementById('upName').textContent = userProfile.displayName || '—';
  document.getElementById('upTag').textContent = '#' + (userProfile.tag || '0000');
  const dni = document.getElementById('displayNameInp');
  if (dni) dni.value = userProfile.displayName || '';
}

// ════ فتح مودال تعديل الملف الشخصي مع تعبئة القيم الحالية ════
function openEditProfile() {
  const nameInp = document.getElementById('displayNameInp');
  if (nameInp) nameInp.value = userProfile.displayName || '';
  // إعادة تعيين حقل الملف لمنع عرض ملف انتُقي سابقاً
  const fileInp = document.getElementById('epAvatarInput');
  if (fileInp) fileInp.value = '';
  // تعبئة معاينة الصورة الحالية
  const prev = document.getElementById('epAvatarPreview');
  if (prev) {
    if (userProfile.avatar) {
      prev.innerHTML = `<img src="${userProfile.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
    } else {
      prev.textContent = (userProfile.displayName || '?')[0];
    }
  }
  openModal('settingsModal');
}

// معاينة محلية للصورة الجديدة قبل الرفع
function previewEditAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { toast('❌ الصورة أكبر من 3MB'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    const prev = document.getElementById('epAvatarPreview');
    if (prev) prev.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
  };
  reader.readAsDataURL(file);
}

// ════ مزامنة الاسم والصورة في جميع السيرفرات ════
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

// ════ حفظ الملف الشخصي: رفع الصورة + تحديث Auth + RTDB + جميع السيرفرات ════
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

    // تحديث Firebase Auth profile
    const profileUpdate = { displayName: name };
    if (avatarUrl) profileUpdate.photoURL = avatarUrl;
    await auth.currentUser.updateProfile(profileUpdate);

    // تحديث RTDB
    await db.ref('users/' + currentUser.uid).update({ displayName: name, avatar: avatarUrl });

    // تحديث الكاش المحلي
    userProfile.displayName = name;
    userProfile.avatar = avatarUrl;

    // مزامنة فورية مع جميع السيرفرات
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
  if (localAudioTrack) localAudioTrack.close();
  if (agoraClient) await agoraClient.leave();
  await auth.signOut();
}

// رفع سريع للصورة من مودال الملف الشخصي (مع مزامنة السيرفرات)
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
    const av = document.getElementById('profileAvatar');
    if (av) av.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    updateUserPanel();
    await _syncProfileToServers(userProfile.displayName || '', url);
    toast('✅ تم تحديث الصورة');
  } catch(e) { toast('❌ فشل رفع الصورة: ' + (e.message || '')); }
}

function openProfile() {
  db.ref('users/' + currentUser.uid + '/avatar').once('value').then(snap => {
    const av = document.getElementById('profileAvatar');
    if (snap.val()) { if(av) av.innerHTML = `<img src="${snap.val()}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; }
    else { if(av) av.textContent = (userProfile.displayName||'?')[0]; }
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
      if (role === 'owner') badge.innerHTML = '<span class="admin-badge">👑 مالك</span>';
      else if (role === 'admin') badge.innerHTML = '<span class="admin-badge">🛡️ مشرف</span>';
      else badge.innerHTML = '';
    } else badge.innerHTML = '';
  }
  openModal('profileModal');
}

function openMemberCard(uid, name, avatar) {
  console.log('[DEBUG] openMemberCard called', uid, name);
  const existing = document.getElementById('memberCardOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'memberCardOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center';

  const card = document.createElement('div');
  card.style.cssText = 'background:#1a2535;border-radius:20px;padding:32px 28px;min-width:260px;max-width:320px;display:flex;flex-direction:column;align-items:center;gap:10px;box-shadow:0 8px 40px rgba(0,0,0,0.6);font-family:Tajawal,sans-serif';

  const avEl = document.createElement('div');
  avEl.style.cssText = 'width:86px;height:86px;border-radius:50%;background:#253040;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;color:#fff;overflow:hidden;flex-shrink:0';
  if (avatar) avEl.innerHTML = `<img src="${avatar}" style="width:100%;height:100%;object-fit:cover;display:block">`;
  else avEl.textContent = (name || '?')[0];

  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'font-size:18px;font-weight:700;color:#fff;margin-top:4px;text-align:center';
  nameEl.textContent = name || '—';

  const tagEl = document.createElement('div');
  tagEl.style.cssText = 'font-size:13px;color:var(--muted,#8899aa)';
  db.ref('users/' + uid + '/tag').once('value').then(s => { if (s.val()) tagEl.textContent = '#' + s.val(); });

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;justify-content:center';

  const mkBtn = (icon, label, fn) => {
    const b = document.createElement('button');
    b.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 14px;background:rgba(255,255,255,0.07);border:none;border-radius:14px;color:#fff;font-family:Tajawal,sans-serif;font-size:12px;font-weight:600;cursor:pointer;min-width:72px';
    b.innerHTML = `<span style="font-size:22px;line-height:1">${icon}</span><span>${label}</span>`;
    b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.13)');
    b.addEventListener('mouseleave', () => b.style.background = 'rgba(255,255,255,0.07)');
    b.addEventListener('click', () => { overlay.remove(); fn(); });
    return b;
  };

  btns.appendChild(mkBtn('💬', 'رسالة خاصة', () => { overlay.remove(); setTimeout(() => openDM(uid, name), 50); }));
  if (uid !== currentUser?.uid) {
    btns.appendChild(mkBtn('📞', 'صوتي', () => startCall(uid, name, 'audio')));
    btns.appendChild(mkBtn('📹', 'فيديو', () => startCall(uid, name, 'video')));
  }

  card.appendChild(avEl); card.appendChild(nameEl); card.appendChild(tagEl); card.appendChild(btns);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function copyAdminCode() {
  const code = userProfile.adminCode || '';
  navigator.clipboard?.writeText(code).then(() => toast('📋 تم نسخ الكود: ' + code));
}

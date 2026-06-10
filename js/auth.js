// ════ مستمع طوارئ عام — يطبع أي خطأ يمنع تحميل الواجهة (تشخيص الشاشة البيضاء) ════
window.onerror = function(message, source, lineno, colno, error) {
  try {
    var file = (source || 'غير معروف').split('/').pop();
    alert('⚠️ خطأ برمجي:\n\n' + message +
          '\n\n📄 الملف: ' + file +
          '\n📍 الموقع: سطر ' + lineno + ' عمود ' + colno +
          (error && error.stack ? '\n\n' + error.stack : ''));
  } catch(_) {}
  return false; // اترك المتصفح يسجّل الخطأ في Console أيضاً
};
// أخطاء الـ Promise غير المعالَجة (معظم كود التطبيق غير متزامن)
window.addEventListener('unhandledrejection', function(ev) {
  try {
    var r = ev.reason || {};
    alert('⚠️ خطأ غير معالَج (Promise):\n\n' + (r.message || r) +
          (r.code ? '\n🔖 الكود: ' + r.code : ''));
  } catch(_) {}
});

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

auth.onAuthStateChanged(user => {
  if (user) {
    currentUser = user;
    document.getElementById('loginScreen').style.display = 'none';
    const app = document.getElementById('app');
    if (app) app.style.display = 'flex';
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
    document.getElementById('loginScreen').style.display = 'flex';
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
  }
});

const _GOOGLE_BTN_HTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg> دخول بـ Google';

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
    await db.ref('users/' + currentUser.uid).update(userProfile);
  }
  if (!userProfile.adminCode) {
    userProfile.adminCode = generateAdminCode();
    await db.ref('users/' + currentUser.uid + '/adminCode').set(userProfile.adminCode);
  }
  updateUserPanel();
}

function updateUserPanel() {
  document.getElementById('upAv').textContent = (userProfile.displayName||'?')[0];
  document.getElementById('upName').textContent = userProfile.displayName || '—';
  document.getElementById('upTag').textContent = '#' + (userProfile.tag || '0000');
  const dni = document.getElementById('displayNameInp');
  if (dni) dni.value = userProfile.displayName || '';
}

async function saveSettings() {
  const name = document.getElementById('displayNameInp').value.trim();
  if (!name) return;
  userProfile.displayName = name;
  await db.ref('users/' + currentUser.uid).update({ displayName: name });
  updateUserPanel();
  closeModal('settingsModal');
  toast('✅ تم الحفظ');
}

async function doSignOut() {
  if (localAudioTrack) localAudioTrack.close();
  if (agoraClient) await agoraClient.leave();
  await auth.signOut();
}

async function uploadAvatar(input) {
  const file = input.files[0];
  if (!file || !currentUser) return;
  if (file.size > 3 * 1024 * 1024) { toast('❌ الصورة أكبر من 3MB'); return; }
  toast('⏳ جاري رفع الصورة...');
  try {
    const path = `avatars/${currentUser.uid}/avatar.jpg`;
    const url = await uploadToStorage(file, path);
    await db.ref('users/' + currentUser.uid + '/avatar').set(url);
    userProfile.avatar = url;
    const av = document.getElementById('profileAvatar');
    if (av) av.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    toast('✅ تم تحديث الصورة');
  } catch(e) { toast('❌ فشل رفع الصورة: ' + (e.message||'')); }
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

function copyAdminCode() {
  const code = userProfile.adminCode || '';
  navigator.clipboard?.writeText(code).then(() => toast('📋 تم نسخ الكود: ' + code));
}

'use strict';

// ════ مستمع طوارئ عام — أول ما يُسجَّل لالتقاط أي خطأ يسبّب الشاشة البيضاء (آيفون) ════
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

const FB = firebase.initializeApp({
  apiKey: "AIzaSyCmZPRoEt3IDFxeH-aqvYQIi5dGOmFlS5Y",
  authDomain: "awalim2-5bdb1.firebaseapp.com",
  databaseURL: "https://awalim2-5bdb1-default-rtdb.firebaseio.com",
  projectId: "awalim2-5bdb1",
  storageBucket: "awalim2-5bdb1.firebasestorage.app",
  messagingSenderId: "939518942115",
  appId: "1:939518942115:web:404307d7b8e0677c335816",
  measurementId: "G-74F9SB8HKK"
});

const auth    = FB.auth();
const db      = FB.database();
const storage = FB.storage();

auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e => console.warn('Persistence error:', e));

// ════ UTILITIES ════
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(ts) {
  const d = new Date(ts);
  try {
    return d.toLocaleTimeString('ar-SA', {
      hour: '2-digit', minute: '2-digit',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh'
    });
  } catch(e) {
    return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  el.getBoundingClientRect();
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 3000);
}

function isMobile() { return window.innerWidth <= 768; }

function generateAdminCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i=0; i<8; i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
}

// ════ IMAGE CACHE (IndexedDB) ════
const _imgCacheDB = (() => {
  let db = null;
  const DB_NAME = 'awalem_img_cache', DB_VER = 1, STORE = 'images';

  function open() {
    return new Promise((res, rej) => {
      if (db) return res(db);
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'url' });
      };
      req.onsuccess = e => { db = e.target.result; res(db); };
      req.onerror = () => rej(req.error);
    });
  }

  async function get(url) {
    try {
      const d = await open();
      return new Promise((res) => {
        const tx = d.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(url);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => res(null);
      });
    } catch { return null; }
  }

  async function set(url, blob, expiresAt, saved) {
    try {
      const d = await open();
      return new Promise((res) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ url, blob, expiresAt: expiresAt || null, saved: saved || false, cachedAt: Date.now() });
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
      });
    } catch { return false; }
  }

  async function cleanup() {
    try {
      const d = await open();
      const now = Date.now();
      const tx = d.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (!cursor) return;
        const item = cursor.value;
        if (item.expiresAt && !item.saved && now > item.expiresAt) cursor.delete();
        cursor.continue();
      };
    } catch {}
  }

  return { get, set, cleanup };
})();

setTimeout(() => _imgCacheDB.cleanup(), 3000);

async function loadCachedImage(url, expiresAt, saved) {
  const cached = await _imgCacheDB.get(url);
  if (cached) {
    if (cached.expiresAt && !cached.saved && Date.now() > cached.expiresAt) return null;
    return URL.createObjectURL(cached.blob);
  }
  try {
    const resp = await fetch(url);
    if (!resp.ok) return url;
    const blob = await resp.blob();
    await _imgCacheDB.set(url, blob, expiresAt, saved);
    return URL.createObjectURL(blob);
  } catch { return url; }
}

// ════ CLOUDINARY UPLOAD ════
const CLOUDINARY_CLOUD = 'dz9gy0rsr';
const CLOUDINARY_PRESET = 'awalem_upload';

async function uploadToCloudinary(file, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('upload_preset', CLOUDINARY_PRESET);
      formData.append('folder', 'awalem');
      const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`, {
        method: 'POST', body: formData
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || 'Cloudinary upload failed'); }
      const data = await res.json();
      return data.secure_url;
    } catch(e) {
      if (attempt === retries) throw e;
      toast(`⏳ إعادة المحاولة ${attempt}...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

async function uploadToStorage(file, path, retries = 5) {
  const contentType = file.type || 'application/octet-stream';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ref = storage.ref(path);
      const uploadTask = ref.put(file, { contentType });
      const snap = await new Promise((resolve, reject) => {
        uploadTask.on('state_changed', null, reject, () => resolve(uploadTask.snapshot));
      });
      const url = await snap.ref.getDownloadURL();
      try {
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await _imgCacheDB.set(url, file, expiresAt, false);
      } catch {}
      return url;
    } catch(e) {
      if (e.code === 'storage/unauthorized') { toast('❌ لا صلاحية للرفع'); throw e; }
      if (attempt === retries) throw e;
      const delay = Math.min(2000 * attempt, 8000);
      toast(`⏳ إعادة المحاولة ${attempt} من ${retries}...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

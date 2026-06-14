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

// ════ حالة الاتصال بـ Firebase ════
// True once the SDK has a live, authenticated WebSocket.
// Write paths check this before touching Firebase so early-load races
// (auth token not yet applied to the socket) cannot produce permission errors.
let _isConnected = false;
db.ref('.info/connected').on('value', snap => { _isConnected = !!snap.val(); });

function waitForConnection(timeoutMs = 4000) {
  if (_isConnected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('لا يوجد اتصال بالإنترنت')),
      timeoutMs
    );
    const poll = setInterval(() => {
      if (_isConnected) { clearInterval(poll); clearTimeout(deadline); resolve(); }
    }, 150);
  });
}

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

// تحويل نص public_id إلى رابط فيديو محسَّن (720p، جودة auto، MP4)
function _cloudinaryVideoUrl(publicId) {
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/video/upload/q_auto:low,vc_auto,w_1280,h_720,c_limit,f_mp4/${publicId}.mp4`;
}

// رفع مجزَّأ (chunks) للفيديوهات الكبيرة — يتجنب انقطاع الاتصال على الشبكات البطيئة
async function _cloudinaryChunkedUpload(file, resourceType, onProgress) {
  const CHUNK = 6 * 1024 * 1024; // 6MB لكل قطعة
  const uploadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const total = file.size;
  let offset = 0;
  let result = null;

  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const chunk = file.slice(offset, end);
    const formData = new FormData();
    formData.append('file', chunk);
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('folder', 'awalem');
    // نطلب التحويل المتزامن في الجزء الأخير فقط
    if (end === total) {
      formData.append('eager', 'q_auto:low,vc_auto,w_1280,h_720,c_limit,f_mp4');
      formData.append('eager_async', 'true');
    }
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/${resourceType}/upload`,
      {
        method: 'POST',
        headers: {
          'X-Unique-Upload-Id': uploadId,
          'Content-Range': `bytes ${offset}-${end - 1}/${total}`
        },
        body: formData
      }
    );
    if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || 'chunk upload failed'); }
    const data = await res.json();
    if (data.public_id || data.secure_url) result = data;
    offset = end;
    if (onProgress) onProgress(Math.round((offset / total) * 100));
  }
  return result;
}

async function uploadToCloudinary(file, retries = 3, onProgress) {
  // Cloudinary يتطلب المسار /video/upload لمقاطع الفيديو، وإلا يفشل أو يعلق الرفع.
  const resourceType = (file.type || '').startsWith('video') ? 'video' : 'auto';
  const isVideo = resourceType === 'video';
  const CHUNK_THRESHOLD = 20 * 1024 * 1024; // فيديو > 20MB يُرفع مجزَّأً

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let data;

      if (isVideo && file.size > CHUNK_THRESHOLD) {
        // رفع مجزَّأ للفيديوهات الكبيرة
        data = await _cloudinaryChunkedUpload(file, resourceType, onProgress);
      } else {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', CLOUDINARY_PRESET);
        formData.append('folder', 'awalem');
        if (isVideo) {
          formData.append('eager', 'q_auto:low,vc_auto,w_1280,h_720,c_limit,f_mp4');
          formData.append('eager_async', 'true');
        }
        // XHR بدل fetch لدعم upload progress حتى للملفات الصغيرة
        data = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/${resourceType}/upload`);
          if (onProgress) {
            xhr.upload.addEventListener('progress', e => {
              if (e.lengthComputable) onProgress(Math.max(1, Math.round((e.loaded / e.total) * 100)));
            });
          }
          xhr.addEventListener('load', () => {
            try {
              const result = JSON.parse(xhr.responseText);
              if (xhr.status >= 400) reject(new Error(result.error?.message || 'Cloudinary upload failed'));
              else resolve(result);
            } catch(e) { reject(e); }
          });
          xhr.addEventListener('error', () => reject(new Error('Network error')));
          xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
          xhr.send(formData);
        });
      }

      // للفيديو: نُعيد رابط التحويل المباشر (720p، auto-quality، MP4)
      // Cloudinary يولّده عند أول طلب ويخزّنه في CDN بعدها
      if (isVideo && data && data.public_id) {
        return _cloudinaryVideoUrl(data.public_id);
      }
      return data.secure_url;
    } catch(e) {
      if (attempt === retries) throw e;
      toast(`⏳ إعادة المحاولة ${attempt}...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ════ IMAGE COMPRESSION (canvas, max 1920px, JPEG 85%) ════
async function compressImage(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      const MAX = 1920;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) {
        if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(blob); return; }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => resolve(b && b.size < blob.size ? b : blob), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(blob); };
    img.src = blobUrl;
  });
}

async function uploadToStorage(file, path, { retries = 3, onProgress, signal } = {}) {
  const contentType = file.type || 'application/octet-stream';
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Upload cancelled'), { code: 'storage/canceled' });
    try {
      const ref = storage.ref(path);
      const uploadTask = ref.put(file, { contentType });
      if (signal) {
        signal.addEventListener('abort', () => uploadTask.cancel(), { once: true });
      }
      const snap = await new Promise((resolve, reject) => {
        uploadTask.on('state_changed',
          (snapshot) => {
            if (snapshot.totalBytes > 0) {
              onProgress?.(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
            }
          },
          reject,
          () => resolve(uploadTask.snapshot)
        );
      });
      const url = await snap.ref.getDownloadURL();
      if (!url) throw new Error('getDownloadURL returned empty URL');
      try {
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await _imgCacheDB.set(url, file, expiresAt, false);
      } catch {}
      return url;
    } catch(e) {
      if (e.code === 'storage/canceled') throw e;
      if (e.code === 'storage/unauthorized') { toast('❌ لا صلاحية للرفع'); throw e; }
      if (attempt === retries) throw e;
      const delay = Math.min(2000 * attempt, 8000);
      toast(`⏳ إعادة المحاولة ${attempt} من ${retries}...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

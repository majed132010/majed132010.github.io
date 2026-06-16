// ════ MESSAGES ════
const PAGE_SIZE = 20;
let _oldestMsgKey = null;
let _allLoaded = false;
let _currentMsgPath = null;
let _replyTo = null;
let _editingKey = null;
let _typingTimer = null;
let _msgLoadGen = 0; // يمنع listeners الـ async القديمة من التسجيل بعد تغيير القناة
let _searchResults = [], _searchIndex = 0;

// ════ عرض الرسائل ════
function showMessages(sid, cid) {
  // تصفير حارس الرفع فور تبديل القناة — يمنع أي تعليق من جلسة سابقة
  window._sendingMedia = false;
  // تجديد التوكن فوراً حتى يكون جاهزاً قبل أي رفع
  if (auth.currentUser) auth.currentUser.getIdToken(true).catch(() => {});

  showView('messages');
  if (typeof _currentUserMuted !== 'undefined') _applyMuteState(_currentUserMuted);
  if (typeof _ensureMemberRegistered === 'function') _ensureMemberRegistered(sid);
  _oldestMsgKey = null;
  _allLoaded = false;
  _currentMsgPath = 'messages/' + sid + '/' + cid;

  const area = document.getElementById('messagesArea');
  const loadBtn = document.getElementById('loadMoreBtn');
  area.innerHTML = '';
  if (loadBtn) { loadBtn.style.display = 'none'; area.appendChild(loadBtn); }
  cleanupMessagesListener();
  clearUnread(sid, cid);
  listenTyping(sid, cid);
  // ضمان تفعيل مستمع الإشعارات — يُعيد الربط إن كان مفقوداً (حماية من انقطاع غير متوقع)
  if (currentUser && !_notifListener) listenNotifications(currentUser.uid);

  // جيل فريد يُبطل أي callback قديم إذا بدّل المستخدم القناة
  const gen = ++_msgLoadGen;
  let _initialDone = false; // يصبح true بعد اكتمال الدفعة الأولى

  // fn واحدة تتولى التحميل الأولي والرسائل الحية على حدٍّ سواء
  const fn = snap => {
    if (gen !== _msgLoadGen) return;
    const msg = snap.val();
    if (!msg) return;
    if (area.querySelector(`[data-key="${snap.key}"]`)) return; // dedup
    const _d = buildMsgDiv(msg, snap.key); if (!_d) return;
    area.appendChild(_d);
    // تتبع المفتاح الأقدم للـ pagination
    if (!_oldestMsgKey || snap.key < _oldestMsgKey) _oldestMsgKey = snap.key;
    if (_initialDone) {
      // رسالة حية — تمرير تلقائي ذكي
      const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
      if (dist < 250 || msg.uid === currentUser?.uid) {
        area.scrollTop = area.scrollHeight;
      }
      // إشعار داخلي إذا كان المستخدم في قناة أخرى
      if (msg.uid !== currentUser?.uid) {
        const activeSid = window.currentServerId !== undefined ? window.currentServerId : currentServer;
        const activeCid = window.currentChannelId !== undefined ? window.currentChannelId : currentChannel;
        if (!(activeSid === sid && activeCid === cid)) showInAppNotif(msg, sid, cid);
      }
    }
  };

  const changeFn = snap => {
    const msg = snap.val();
    if (!msg) return;
    const el = document.querySelector(`[data-key="${snap.key}"]`);
    if (!el) return;
    const body = el.querySelector('.msg-body');
    if (!body) return;

    // ── تحديث شريط رفع الميديا ──
    const progWrap = body.querySelector('.msg-uploading-wrap');
    if (progWrap) {
      if (msg.uploading) {
        _updateUploadProgressEl(progWrap, msg.uploadProgress || 0, msg.mediaType);
      } else if (!msg.uploading && msg.mediaUrl) {
        // اكتمل الرفع — استبدل شريط التقدم بالميديا الفعلية
        _cleanupUploadState(snap.key);
        progWrap.remove();
        if (msg.mediaType === 'video') {
          body.appendChild(buildCachedVideoEl(msg.mediaUrl, msg.mediaName));
        } else {
          const mediaWrap = document.createElement('div');
          mediaWrap.className = 'msg-media-wrap';
          const img = document.createElement('img');
          img.decoding = 'async'; img.className = 'msg-media-img'; img.alt = msg.mediaName || '';
          img.addEventListener('click', () => openLightbox(msg.mediaUrl, 'image', msg.mediaName));
          loadCachedImage(msg.mediaUrl, msg.expiresAt, msg.saved).then(src => { if (src) img.src = src; });
          mediaWrap.appendChild(img);
          body.appendChild(mediaWrap);
        }
        const a = document.getElementById('messagesArea');
        if (a) requestAnimationFrame(() => { a.scrollTop = a.scrollHeight; });
      } else if (!msg.uploading && msg.uploadFailed) {
        _showUploadFailedEl(progWrap, snap.key);
      }
    }

    // ── تفاعلات ونص ──
    renderReactions(msg.reactions || null, snap.key, body);
    const a = document.getElementById('messagesArea');
    if (a && a.scrollHeight - a.scrollTop - a.clientHeight < 200) a.scrollTop = a.scrollHeight;
    if (msg.text !== undefined) {
      const contentEl = body.querySelector('.msg-content');
      if (contentEl && contentEl.textContent !== msg.text) contentEl.textContent = msg.text;
      if (msg.edited && !body.querySelector('.msg-edited')) {
        const metaEl = body.querySelector('.msg-meta');
        if (metaEl) metaEl.insertAdjacentHTML('beforeend', '<span class="msg-edited">(معدّل)</span>');
      }
    }
  };

  // ── تسجيل مستمع واحد: يحمّل الدفعة الأولى ثم يستمر حياً ──
  // limitToLast يُعيد المزامنة تلقائياً عند إعادة الاتصال — لا يفوّت رسائل
  const mainRef = db.ref(_currentMsgPath).limitToLast(PAGE_SIZE);
  mainRef.on('child_added', fn);
  db.ref(_currentMsgPath).on('child_changed', changeFn);
  messagesListener = { path: _currentMsgPath, mainRef, fn, changeFn };

  // 'value' يُطلَق بعد انتهاء كل child_added الأولية — نستغله لقفل حالة التحميل
  mainRef.once('value', snap => {
    if (gen !== _msgLoadGen) return;
    _initialDone = true;
    const count = snap.numChildren ? snap.numChildren() : Object.keys(snap.val() || {}).length;
    if (loadBtn) loadBtn.style.display = count >= PAGE_SIZE ? 'block' : 'none';
    area.scrollTop = area.scrollHeight;
    setTimeout(() => { area.scrollTop = area.scrollHeight; }, 150);
    setTimeout(() => { area.scrollTop = area.scrollHeight; }, 500);
  });
}

// ════ تحميل رسائل أقدم ════
async function loadMoreMessages() {
  if (!_currentMsgPath || !_oldestMsgKey || _allLoaded) return;
  const btn = document.getElementById('loadMoreBtn');
  if (btn) { btn.classList.add('loading'); btn.textContent = '⏳ جاري التحميل...'; }
  const area = document.getElementById('messagesArea');
  const prevHeight = area.scrollHeight;
  const snap = await db.ref(_currentMsgPath).orderByKey().endBefore(_oldestMsgKey).limitToLast(PAGE_SIZE).once('value');
  const msgs = snap.val() || {};
  const entries = Object.entries(msgs).sort((a,b) => a[1].ts - b[1].ts);
  if (entries.length === 0) {
    _allLoaded = true;
    if (btn) btn.style.display = 'none';
    toast('📜 لا توجد رسائل أقدم');
    return;
  }
  const firstMsg = area.querySelector('.msg-group');
  entries.reverse().forEach(([key, msg]) => {
    if (area.querySelector(`[data-key="${key}"]`)) return;
    const div = buildMsgDiv(msg, key);
    if (!div) return;
    if (firstMsg) area.insertBefore(div, firstMsg);
    else area.appendChild(div);
  });
  _oldestMsgKey = entries[entries.length-1][0];
  area.scrollTop = area.scrollHeight - prevHeight;
  if (btn) {
    btn.classList.remove('loading');
    btn.textContent = '⬆ تحميل رسائل أقدم';
    if (entries.length < PAGE_SIZE) { btn.style.display = 'none'; _allLoaded = true; }
  }
}

// ════ بناء رسالة ════
function buildMsgDiv(msg, key) {
  if ((msg.mediaUrl || msg.voiceUrl) && msg.expiresAt && msg.saved !== true && Date.now() > msg.expiresAt) return null;
  const isAdmin = msg.role === 'owner' || msg.role === 'admin';
  const isMine = msg.uid === currentUser?.uid;
  const sv = servers[currentServer];
  const myRole = sv?.members?.[currentUser?.uid]?.role;
  const isAdminUser = myRole === 'owner' || myRole === 'admin';
  const targetRole = sv?.members?.[msg.uid]?.role;
  const canModerate = isAdminUser && !isMine &&
      !(myRole === 'admin' && (targetRole === 'owner' || targetRole === 'admin'));
  const div = document.createElement('div');
  div.className = 'msg-group';
  div.dataset.key = key;
  div.dataset.ts = msg.ts;

  const av = document.createElement('div');
  av.className = 'msg-av';
  const _memberAv = sv?.members?.[msg.uid]?.avatar || null;
  if (_memberAv) {
    av.innerHTML = `<img src="${_memberAv}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
  } else {
    av.textContent = (msg.name || '?')[0];
  }
  if (canModerate) {
    av.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); _openModCtx(msg.uid, msg.name, e); });
    av.style.cursor = 'context-menu';
    av.title = 'انقر بالزر الأيمن لإجراءات الإشراف';
    let _avLp;
    av.addEventListener('touchstart', () => {
      const r = av.getBoundingClientRect();
      _avLp = setTimeout(() => _openModCtx(msg.uid, msg.name, { clientX: r.left + r.width / 2, clientY: r.top }), 600);
    }, {passive: true});
    av.addEventListener('touchend',  () => clearTimeout(_avLp), {passive: true});
    av.addEventListener('touchmove', () => clearTimeout(_avLp), {passive: true});
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = `
    <span class="msg-name">${escHtml(msg.name||'')}</span>
    ${isAdmin ? '<span class="msg-admin-badge">مشرف</span>' : ''}
    <span class="msg-time">${formatTime(msg.ts)}</span>
    ${msg.edited ? '<span class="msg-edited">(معدّل)</span>' : ''}
  `;
  body.appendChild(meta);

  if (msg.replyTo) {
    const quote = document.createElement('div');
    quote.className = 'msg-reply-quote';
    quote.innerHTML = `<div class="rq-name">${escHtml(msg.replyTo.name||'')}</div><div class="rq-text">${escHtml(msg.replyTo.text||'🖼️ وسائط')}</div>`;
    quote.addEventListener('click', () => {
      const target = document.querySelector(`[data-key="${msg.replyTo.key}"]`);
      if (target) target.scrollIntoView({ behavior:'smooth', block:'center' });
    });
    body.appendChild(quote);
  }

  if (msg.text) {
    const txt = document.createElement('div');
    txt.className = 'msg-content';
    const mentionRegex = /@([^\s@]+)/g;
    const highlighted = escHtml(msg.text).replace(mentionRegex, (match, name) => {
      const isMentioned = userProfile?.displayName && name === userProfile.displayName;
      return `<span class="msg-mention"${isMentioned?' style="background:rgba(200,168,75,0.35)"':''}>@${escHtml(name)}</span>`;
    });
    txt.innerHTML = highlighted;
    body.appendChild(txt);
  }

  if (msg.voiceUrl && !msg.mediaUrl) {
    const vw = document.createElement('div');
    vw.appendChild(buildVoiceMsg(msg.voiceUrl, msg.voiceDuration));
    body.appendChild(vw);
  }

  // ── تقدم الرفع: preview دائري للمُرسِل، شريط عادي للمستقبِل ──
  if (msg.uploading && !msg.mediaUrl) {
    body.appendChild(_buildUploadProgressEl(key, msg.uploadProgress || 1, msg.mediaType));
  }

  if (msg.mediaUrl) {
    if (msg.expiresAt && !msg.saved && Date.now() > msg.expiresAt) return null;
    if (msg.mediaType === 'video') {
      body.appendChild(buildCachedVideoEl(msg.mediaUrl, msg.mediaName));
    } else {
      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'msg-media-wrap';
      const img = document.createElement('img');
      img.decoding = 'async';
      img.className = 'msg-media-img';
      img.src = '';                // blank immediately — no inherited/default src
      img.dataset.msgKey = key;   // stamp with message key for async guard
      img.alt = msg.mediaName || '';
      img.addEventListener('click', () => openLightbox(msg.mediaUrl,'image',msg.mediaName));
      img.addEventListener('load', () => {
        const a = document.getElementById('messagesArea');
        if (!a) return;
        // rAF lets the browser reflow the expanded image before measuring scroll distance
        requestAnimationFrame(() => {
          const dist = a.scrollHeight - a.scrollTop - a.clientHeight;
          if (dist < 300) a.scrollTop = a.scrollHeight;
        });
      });
      loadCachedImage(msg.mediaUrl, msg.expiresAt, msg.saved).then(src => {
        if (img.dataset.msgKey !== key) return; // stale callback — element was reused, abort
        if (src) img.src = src;
        else { img.style.opacity='0.3'; img.style.filter='grayscale(1)'; }
      });
      mediaWrap.appendChild(img);
      body.appendChild(mediaWrap);
    }
  }

  if (msg.reactions) renderReactions(msg.reactions, key, body);

  div.appendChild(av); div.appendChild(body);

  // ── WhatsApp-style context bar: right-click / long-press ──────────────────
  if (!window._ctxDismissReady) {
    window._ctxDismissReady = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.msg-ctx-bar.visible').forEach(el => el.classList.remove('visible'));
    });
  }
  const ctxBar = document.createElement('div');
  ctxBar.className = 'msg-ctx-bar' + (isMine ? ' mine' : '');
  const _ctxHasMedia = !!(msg.mediaUrl || msg.voiceUrl);
  [
    { icon: '↩️', label: 'رد',          fn: () => setReply(key, msg.name, msg.text) },
    { icon: '📤', label: 'إعادة إرسال', fn: () => toast('📤 قريباً') },
    { icon: '⭐', label: 'تثبيت',        fn: () => toast('⭐ قريباً') },
    ...((isMine || isAdminUser) ? [{ icon: '🗑️', label: 'حذف', danger: true, fn: () => deleteMessage(key) }] : []),
    ...(_ctxHasMedia ? [{ icon: '💾', label: 'حفظ', fn: () => { const _a = document.createElement('a'); _a.href = msg.mediaUrl || msg.voiceUrl; _a.download = msg.mediaName || 'media'; _a.target = '_blank'; document.body.appendChild(_a); _a.click(); _a.remove(); } }] : []),
  ].forEach(ac => {
    const b = document.createElement('button');
    b.className = 'mc-btn' + (ac.danger ? ' danger' : '');
    b.title = ac.label;
    b.innerHTML = `<span class="mc-icon">${ac.icon}</span><span class="mc-label">${ac.label}</span>`;
    b.addEventListener('click', e => { e.stopPropagation(); ctxBar.classList.remove('visible'); ac.fn(); });
    ctxBar.appendChild(b);
  });
  body.style.position = 'relative';
  body.appendChild(ctxBar);
  div.addEventListener('contextmenu', e => {
    e.preventDefault();
    document.querySelectorAll('.msg-ctx-bar.visible').forEach(el => el.classList.remove('visible'));
    ctxBar.classList.add('visible');
  });
  let _ctxLp;
  div.addEventListener('touchstart', () => { _ctxLp = setTimeout(() => { document.querySelectorAll('.msg-ctx-bar.visible').forEach(el => el.classList.remove('visible')); ctxBar.classList.add('visible'); }, 600); }, { passive: true });
  div.addEventListener('touchend',   () => clearTimeout(_ctxLp), { passive: true });
  div.addEventListener('touchmove',  () => clearTimeout(_ctxLp), { passive: true });

  return div;
}

// ════ قائمة سياق المشرف ════
async function _openModCtx(targetUid, targetName, ev) {
  if (!currentServer || !currentUser) return;
  document.getElementById('modCtxMenu')?.remove();
  const snap = await db.ref('servers/' + currentServer + '/restrictions/' + targetUid + '/muted').once('value');
  const isMuted = !!snap.val();
  const menu = document.createElement('div');
  menu.id = 'modCtxMenu';
  menu.style.cssText = 'position:fixed;z-index:9000;background:linear-gradient(160deg,#122530,#0d1e28);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:6px;min-width:188px;box-shadow:0 8px 30px rgba(0,0,0,0.6);font-family:Tajawal,sans-serif;';
  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--muted);padding:6px 12px 8px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:164px';
  lbl.textContent = '⚙️ ' + (targetName || 'مستخدم');
  menu.appendChild(lbl);
  const mkBtn = (icon, text, color, fn) => {
    const b = document.createElement('button');
    b.style.cssText = `display:block;width:100%;padding:10px 14px;background:transparent;border:none;color:${color};font-family:Tajawal,sans-serif;font-size:14px;font-weight:600;cursor:pointer;text-align:right;border-radius:8px;white-space:nowrap`;
    b.textContent = icon + ' ' + text;
    b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.07)');
    b.addEventListener('mouseleave', () => b.style.background = 'transparent');
    b.addEventListener('click', e => { e.stopPropagation(); menu.remove(); fn(); });
    return b;
  };
  menu.appendChild(mkBtn(
    isMuted ? '🔊' : '🔇',
    isMuted ? 'رفع الكتم' : 'كتم المستخدم',
    'var(--text)',
    () => isMuted ? _unmuteUser(targetUid, targetName) : _muteUser(targetUid, targetName)
  ));
  menu.appendChild(mkBtn('🚫', 'طرد المستخدم', '#e06060', () => _kickUserFromChat(targetUid, targetName)));
  document.body.appendChild(menu);
  const pw = 200, ph = 120;
  const px = Math.min(ev.clientX || 0, window.innerWidth  - pw - 8);
  const py = Math.min(ev.clientY || 0, window.innerHeight - ph - 8);
  menu.style.left = Math.max(8, px) + 'px';
  menu.style.top  = Math.max(8, py) + 'px';
  const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 50);
}

async function _muteUser(uid, name) {
  if (!currentServer || !currentUser) return;
  try {
    await db.ref('servers/' + currentServer + '/restrictions/' + uid).set({ muted: true, mutedBy: currentUser.uid, mutedAt: Date.now() });
    toast('🔇 تم كتم ' + name);
  } catch(e) { toast('❌ فشل الكتم: ' + (e.message || '')); }
}

async function _unmuteUser(uid, name) {
  if (!currentServer || !currentUser) return;
  try {
    await db.ref('servers/' + currentServer + '/restrictions/' + uid).remove();
    toast('🔊 تم رفع الكتم عن ' + name);
  } catch(e) { toast('❌ فشل رفع الكتم: ' + (e.message || '')); }
}

async function _kickUserFromChat(uid, name) {
  if (!currentServer || !currentUser) return;
  if (!confirm('طرد "' + name + '" من العالم؟')) return;
  try {
    await db.ref('servers/' + currentServer + '/members/' + uid).remove();
    await db.ref('users/' + uid + '/servers/' + currentServer).remove();
    await db.ref('servers/' + currentServer + '/restrictions/' + uid).remove();
    if (servers[currentServer]?.members) delete servers[currentServer].members[uid];
    toast('🚫 تم طرد ' + name);
  } catch(e) { toast('❌ فشل الطرد: ' + (e.message || '')); }
}

// ════ إرسال رسالة ════
async function sendMessage() {
  if (_currentUserMuted) { toast('🔇 أنت مكتوم في هذا العالم'); return; }
  const inp = document.getElementById('mainChatInp');
  const text = inp ? inp.value.trim() : '';
  const media = [...(window._pendingMedia || [])];
  if (window._sendingMedia && media.length) { toast('⏳ يوجد رفع جارٍ، رجاءً انتظر...'); return; }
  if (!text && !media.length) return;
  if (!currentServer || !currentChannel) return;

  stopTyping();
  if (inp) { inp.value = ''; inp.style.height = ''; }
  document.getElementById('sendBtn').classList.remove('active');
  window._pendingMedia = [];
  const preview = document.getElementById('mediaPreviewArea');
  if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }

  // ── وضع التعديل ──
  if (_editingKey) {
    const key = _editingKey;
    cancelEdit();
    await db.ref('messages/' + currentServer + '/' + currentChannel + '/' + key)
      .update({ text, edited: true, editedAt: Date.now() });
    const msgEl = document.querySelector(`[data-key="${key}"] .msg-content`);
    if (msgEl) msgEl.textContent = text;
    if (!document.querySelector(`[data-key="${key}"] .msg-edited`)) {
      const metaEl = document.querySelector(`[data-key="${key}"] .msg-meta`);
      if (metaEl) metaEl.insertAdjacentHTML('beforeend', '<span class="msg-edited">(معدّل)</span>');
    }
    toast('✅ تم تعديل الرسالة');
    return;
  }

  const sv = servers[currentServer];
  const role = sv?.members?.[currentUser.uid]?.role || 'member';
  const msgBase = { uid: currentUser.uid, name: userProfile.displayName || 'مستخدم', ts: Date.now(), role };
  if (_replyTo) {
    msgBase.replyTo = { key: _replyTo.key, name: _replyTo.name, text: _replyTo.text || '' };
    clearReply();
  }

  // ── تجديد التوكن قبل أي كتابة أو رفع (non-fatal: خطأ الشبكة لا يوقف الإرسال) ──
  if (auth.currentUser) { try { await auth.currentUser.getIdToken(true); } catch(e) {} }

  // ── إرسال النص مباشرة إلى قاعدة البيانات ──
  if (text) {
    await db.ref('messages/' + currentServer + '/' + currentChannel).push({ ...msgBase, text });
    const _pSid = currentServer, _pCid = currentChannel;
    setTimeout(() => {
      try {
        const members = servers[_pSid]?.members || {};
        Object.keys(members).forEach(uid => {
          if (uid !== currentUser.uid) {
            sendPushToUser(uid, userProfile.displayName || 'عوالم', text.slice(0, 80), {
              serverId: _pSid, channelId: _pCid,
              senderName: userProfile.displayName, type: 'message'
            });
          }
        });
      } catch(e) {}
    }, 0);
  }

  // ── رفع الميديا — الحارس _sendingMedia مضمون التصفير في finally ──
  if (!media.length) return;
  if (!_isConnected) {
    try { await waitForConnection(5000); }
    catch(e) { toast('❌ لا يوجد اتصال — تحقق من الإنترنت وأعد المحاولة'); return; }
  }
  if (!auth.currentUser) { toast('❌ يجب تسجيل الدخول أولاً'); return; }
  toast('⏱️ ميديا مؤقتة: تختفي تلقائياً بعد 24 ساعة');

  window._sendingMedia = true;
  try {
    for (const m of media) await _uploadOneMedia(m, msgBase);
  } finally {
    window._sendingMedia = false; // يتصفر حتماً بغض النظر عن النتيجة
  }
}

// ════ رفع ملف واحد — push فوري في DB ثم تحديث لحظي للنسبة ════
async function _uploadOneMedia(m, msgBase) {
  const _sid = currentServer, _cid = currentChannel;
  const msgPath = 'messages/' + _sid + '/' + _cid;
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

  // حارس طوارئ
  const _guardTimer = setTimeout(() => { window._sendingMedia = false; }, 15000);

  // 1. احجز المفتاح أولاً ثم احفظ بيانات الـ preview قبل الكتابة —
  //    child_added يُطلَق أثناء set() فيجد window._uploadPreviews جاهزاً
  const msgRef = db.ref(msgPath).push();
  const msgKey = msgRef.key;

  if (m.type !== 'video') {
    (window._uploadPreviews = window._uploadPreviews || {})[msgKey] = URL.createObjectURL(m.blob);
  }
  (window._uploadBlobs = window._uploadBlobs || {})[msgKey] = {
    blob: m.blob, name: m.name, type: m.type, mimeType: m.mimeType, msgPath
  };

  await msgRef.set({
    ...msgBase,
    text: '',
    mediaType: m.type,
    mediaName: m.name,
    uploading: true,
    uploadProgress: 1,
    expiresAt,
    saved: false
  });

  const area = document.getElementById('messagesArea');
  if (area) area.scrollTop = area.scrollHeight;

  // دالة مساعدة: تحدّث النسبة في DB بدون انتظار (fire-and-forget)
  const updatePct = (pct) => {
    db.ref(msgPath + '/' + msgKey).update({ uploadProgress: pct }).catch(() => {});
  };

  try {
    let mediaUrl;

    if (m.type === 'video') {
      // فيديو → Cloudinary مع ضغط تلقائي وتقدم حقيقي عبر XHR
      mediaUrl = await uploadToCloudinary(
        new File([m.blob], m.name, { type: m.mimeType }),
        3,
        (pct) => updatePct(pct)
      );
    } else {
      // صورة → Firebase Storage مع تقدم حقيقي
      const ext = (m.name.split('.').pop() || 'jpg').toLowerCase();
      const storageRef = storage.ref(`media/${_sid}/${_cid}/${Date.now()}.${ext}`);
      const uploadTask = storageRef.put(m.blob, { contentType: m.mimeType || 'application/octet-stream' });
      await new Promise((resolve, reject) => {
        uploadTask.on('state_changed',
          (snap) => { if (snap.totalBytes > 0) updatePct(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)); },
          reject,
          resolve
        );
      });
      mediaUrl = await uploadTask.snapshot.ref.getDownloadURL();
    }

    if (!mediaUrl) throw new Error('الرابط فارغ بعد اكتمال الرفع');

    // 2. تحديث نفس الرسالة بالرابط النهائي — يطلق child_changed عند الجميع فوراً
    await db.ref(msgPath + '/' + msgKey).update({
      mediaUrl,
      uploading: false,
      uploadProgress: null
    });

    if (area) area.scrollTop = area.scrollHeight;

  } catch(e) {
    window._sendingMedia = false;
    db.ref(msgPath + '/' + msgKey).update({ uploading: false, uploadFailed: true }).catch(() => {});
    if (e.code === 'storage/unauthorized') {
      toast('❌ لا صلاحية للرفع — تحقق من قواعد Firebase Storage');
    } else if (!navigator.onLine || (e.message || '').toLowerCase().includes('network')) {
      toast('❌ فشل الرفع — تحقق من الاتصال وأعد المحاولة');
    } else {
      toast('❌ فشل رفع الملف: ' + (e.message || ''));
    }
  } finally {
    clearTimeout(_guardTimer);
    if (m.localUrl) { URL.revokeObjectURL(m.localUrl); m.localUrl = null; }
  }
}

// ════ حذف رسالة ════
async function deleteMessage(key) {
  if (!currentServer || !currentChannel) return;
  if (!confirm('هل تريد حذف هذه الرسالة؟')) return;
  await db.ref('messages/' + currentServer + '/' + currentChannel + '/' + key).remove();
  document.querySelector(`[data-key="${key}"]`)?.remove();
  toast('🗑️ تم حذف الرسالة');
}

// ════ تعديل رسالة ════
function startEditMessage(key, currentText) {
  _editingKey = key;
  const inp = document.getElementById('mainChatInp');
  inp.value = currentText; inp.focus();
  inp.style.height = ''; inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
  document.getElementById('sendBtn').classList.add('active');
  document.querySelector('.chat-input-box').style.borderColor = 'rgba(88,101,242,0.7)';
  toast('✏️ وضع التعديل — اضغط ESC للإلغاء');
}
function cancelEdit() {
  _editingKey = null;
  const inp = document.getElementById('mainChatInp');
  inp.value = ''; inp.style.height = '';
  document.getElementById('sendBtn').classList.remove('active');
  document.querySelector('.chat-input-box').style.borderColor = '';
}

// ════ الرد على رسالة ════
function setReply(key, name, text) {
  _replyTo = { key, name, text };
  document.getElementById('replyName').textContent = name;
  document.getElementById('replyText').textContent = text || '🖼️ وسائط';
  document.getElementById('replyBar').classList.add('show');
  document.getElementById('mainChatInp').focus();
}
function clearReply() {
  _replyTo = null;
  document.getElementById('replyBar').classList.remove('show');
}

// ════ التفاعلات ════
const REACTION_EMOJIS = ['👍','😂','🔥','❤️','😮','😢'];

function showReactionPicker(msgKey, anchorEl) {
  const old = document.getElementById('reactionPicker');
  if (old) { old.remove(); return; }
  const picker = document.createElement('div');
  picker.id = 'reactionPicker';
  picker.className = 'reaction-picker';
  REACTION_EMOJIS.forEach(emoji => {
    const span = document.createElement('span');
    span.textContent = emoji;
    span.title = emoji;
    span.addEventListener('click', e => { e.stopPropagation(); toggleReaction(msgKey, emoji); picker.remove(); });
    picker.appendChild(span);
  });
  document.body.appendChild(picker);

  // Flip-aware positioning: prefer above the button, fall back to below
  const rect = anchorEl.getBoundingClientRect();
  const pw = picker.offsetWidth || 232;
  const ph = picker.offsetHeight || 48;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  const topAbove = rect.top - ph - 6;
  const top = topAbove >= 8 ? topAbove : rect.bottom + 6;
  picker.style.position = 'fixed';
  picker.style.left = left + 'px';
  picker.style.top  = top  + 'px';

  const close = e => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 50);
}

async function toggleReaction(msgKey, emoji) {
  if (!currentServer || !currentChannel || !currentUser) return;
  const path = 'messages/' + currentServer + '/' + currentChannel + '/' + msgKey + '/reactions/' + emoji + '/' + currentUser.uid;
  const snap = await db.ref(path).once('value');
  if (snap.exists()) await db.ref(path).remove();
  else await db.ref(path).set(true);
}

function renderReactions(reactions, msgKey, container) {
  const old = container.querySelector('.msg-reactions');
  if (old) old.remove();
  if (!reactions || !Object.keys(reactions).length) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-reactions';
  Object.entries(reactions).forEach(([emoji, users]) => {
    const uids = Object.keys(users || {});
    if (!uids.length) return;
    const isMine = uids.includes(currentUser?.uid);
    const chip = document.createElement('div');
    chip.className = 'reaction-chip' + (isMine ? ' mine' : '');
    chip.innerHTML = `<span class="rc-emoji">${emoji}</span><span class="rc-count">${uids.length}</span>`;
    // Tooltip: first 3 names who reacted
    const names = uids.slice(0, 3)
      .map(uid => servers[currentServer]?.members?.[uid]?.name || 'مستخدم')
      .join('، ');
    chip.title = names + (uids.length > 3 ? ' +' + (uids.length - 3) : '');
    chip.addEventListener('click', () => toggleReaction(msgKey, emoji));
    wrap.appendChild(chip);
  });
  if (wrap.children.length) container.appendChild(wrap);
}

// ════ الكتابة ════
function startTyping() {
  if (!currentServer || !currentChannel || !currentUser) return;
  const path = 'typing/' + currentServer + '/' + currentChannel + '/' + currentUser.uid;
  db.ref(path).set({ name: userProfile.displayName || 'مستخدم', ts: Date.now() });
  db.ref(path).onDisconnect().remove();
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => db.ref(path).remove(), 3000);
}
function stopTyping() {
  if (!currentServer || !currentChannel || !currentUser) return;
  clearTimeout(_typingTimer);
  db.ref('typing/' + currentServer + '/' + currentChannel + '/' + currentUser.uid).remove();
}
function listenTyping(sid, cid) {
  if (_typingListener) { db.ref(_typingListener).off('value'); _typingListener = null; }
  const path = 'typing/' + sid + '/' + cid;
  _typingListener = path;
  db.ref(path).on('value', snap => {
    const users = snap.val() || {};
    const others = Object.entries(users)
      .filter(([uid]) => uid !== currentUser?.uid)
      .map(([, u]) => u.name);
    const el = document.getElementById('typingIndicator');
    if (!el) return;
    if (!others.length) { el.innerHTML = ''; el.classList.remove('active'); return; }

    let nameStr;
    if (others.length === 1) {
      nameStr = `<b>${escHtml(others[0])}</b>`;
    } else if (others.length === 2) {
      nameStr = `<b>${escHtml(others[0])}</b> و <b>${escHtml(others[1])}</b>`;
    } else {
      nameStr = `<b>${escHtml(others[0])}</b> و <b>${escHtml(others[1])}</b> و${others.length - 2} آخرون`;
    }
    const verb = others.length === 1 ? 'يكتب' : others.length === 2 ? 'يكتبان' : 'يكتبون';

    el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span>${nameStr} ${verb}...</span>`;
    el.classList.add('active');
  });
}

// ════ تنظيف الـ listener ════
function cleanupMessagesListener() {
  if (messagesListener) {
    // فصل الـ listener عبر نفس الـ ref المُسجَّل — الـ path وحده لا يكفي
    const ref = messagesListener.mainRef || messagesListener.queryRef;
    if (ref) ref.off('child_added', messagesListener.fn);
    if (messagesListener.changeFn) db.ref(messagesListener.path).off('child_changed', messagesListener.changeFn);
    messagesListener = null;
  }
  stopTyping();
  if (_typingListener) { db.ref(_typingListener).off('value'); _typingListener = null; }
  const el = document.getElementById('typingIndicator');
  if (el) { el.innerHTML = ''; el.classList.remove('active'); }
}

// ════ الإشارة (@mention) ════
let _mentionIndex = 0, _mentionResults = [];

function handleChatKeydown(e) {
  const popup = document.getElementById('mentionPopup');
  if (popup.classList.contains('show')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); _mentionIndex = Math.min(_mentionIndex+1, _mentionResults.length-1); updateMentionSelection(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); _mentionIndex = Math.max(_mentionIndex-1, 0); updateMentionSelection(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(_mentionResults[_mentionIndex]); return; }
    if (e.key === 'Escape') { closeMentionPopup(); }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function handleChatInput(el) {
  el.style.height = ''; el.style.height = Math.min(el.scrollHeight,140)+'px';
  document.getElementById('sendBtn').classList.toggle('active', !!(el.value.trim()||(window._pendingMedia?.length)));
  startTyping();
  const val = el.value, cursor = el.selectionStart;
  const atIdx = val.lastIndexOf('@', cursor-1);
  if (atIdx !== -1 && (atIdx===0 || /\s/.test(val[atIdx-1]))) showMentionPopup(val.substring(atIdx+1, cursor));
  else closeMentionPopup();
}

function showMentionPopup(query) {
  if (!currentServer) return;
  const members = servers[currentServer]?.members || {};
  _mentionResults = Object.entries(members).filter(([uid,m]) => uid!==currentUser?.uid && (m.name||'').toLowerCase().includes(query.toLowerCase())).slice(0,6);
  const popup = document.getElementById('mentionPopup');
  if (!_mentionResults.length) { closeMentionPopup(); return; }
  popup.innerHTML = ''; _mentionIndex = 0;
  _mentionResults.forEach(([uid,m],i) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (i===0?' selected':'');
    item.innerHTML = `<div class="mention-av">${(m.name||'?')[0]}</div><div class="mention-name">${escHtml(m.name||'')}</div>`;
    item.addEventListener('click', () => insertMention([uid,m]));
    popup.appendChild(item);
  });
  popup.classList.add('show');
}
function updateMentionSelection() {
  document.querySelectorAll('#mentionPopup .mention-item').forEach((el,i) => el.classList.toggle('selected', i===_mentionIndex));
}
function insertMention([uid,m]) {
  const inp = document.getElementById('mainChatInp');
  const val = inp.value, cursor = inp.selectionStart;
  const atIdx = val.lastIndexOf('@', cursor-1);
  inp.value = val.substring(0,atIdx) + '@' + (m.name||'') + ' ' + val.substring(cursor);
  inp.selectionStart = inp.selectionEnd = atIdx + (m.name||'').length + 2;
  closeMentionPopup(); inp.focus();
  document.getElementById('sendBtn').classList.add('active');
}
function closeMentionPopup() {
  const popup = document.getElementById('mentionPopup');
  if (popup) { popup.classList.remove('show'); popup.innerHTML=''; }
  _mentionResults = [];
}

// ════ اختيار الوسائط ════
window._pendingMedia = [];
window._sendingMedia = false;
async function handleMediaSelect(input) {
  const files = Array.from(input.files);
  input.value = '';
  if (!files.length) return;
  const preview = document.getElementById('mediaPreviewArea');
  if (!preview) return;

  for (const file of files) {
    const isVideo = file.type.startsWith('video');
    const maxSize = isVideo ? 500*1024*1024 : 50*1024*1024;
    const maxLabel = isVideo ? '500MB' : '50MB';
    if (file.size > maxSize) { toast(`❌ الملف أكبر من ${maxLabel}`); continue; }

    // بناء wrap مؤقت مع مؤشر تحميل فوري
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-flex;flex-shrink:0;align-items:center;justify-content:center';
    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'width:72px;height:72px;border-radius:8px;background:#23272a;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px;font-family:Tajawal,sans-serif';
    loadingEl.textContent = '⏳';
    wrap.appendChild(loadingEl);
    preview.style.display = 'flex';
    preview.appendChild(wrap);

    try {
      // قراءة الملف كاملاً الآن — قبل أن يفقد المتصفح صلاحيته
      const arrayBuffer = await file.arrayBuffer();
      let blob = new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' });

      // ضغط الصور فقط (الفيديو يُرفع كما هو)
      if (!isVideo) {
        blob = await compressImage(blob);
      }

      const mimeType = blob.type || file.type || 'application/octet-stream';
      const localUrl = URL.createObjectURL(blob);
      const entry = { blob, type: isVideo ? 'video' : 'image', name: file.name, mimeType, localUrl };
      window._pendingMedia.push(entry);

      // استبدال مؤشر التحميل بالمعاينة الفعلية
      loadingEl.remove();
      if (isVideo) {
        const vid = document.createElement('video');
        vid.src = localUrl; vid.style.cssText = 'height:72px;max-width:110px;border-radius:8px;object-fit:cover;display:block';
        wrap.appendChild(vid);
      } else {
        const img = document.createElement('img');
        img.src = localUrl; img.style.cssText = 'height:72px;max-width:110px;border-radius:8px;object-fit:cover;display:block';
        wrap.appendChild(img);
      }

      const rm = document.createElement('button');
      rm.type='button'; rm.textContent='✕';
      rm.style.cssText = 'position:absolute;top:-5px;right:-5px;width:18px;height:18px;border-radius:50%;background:#c04040;color:#fff;border:none;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;z-index:2';
      rm.addEventListener('click', () => {
        if (entry.localUrl) { URL.revokeObjectURL(entry.localUrl); entry.localUrl = null; }
        window._pendingMedia = window._pendingMedia.filter(e => e!==entry);
        wrap.remove();
        if (!window._pendingMedia.length) preview.style.display='none';
        document.getElementById('sendBtn').classList.toggle('active', !!(window._pendingMedia.length||document.getElementById('mainChatInp')?.value.trim()));
      });
      wrap.appendChild(rm);
      document.getElementById('sendBtn').classList.add('active');
    } catch(e) {
      wrap.remove();
      if (!window._pendingMedia.length) preview.style.display='none';
      toast('❌ تعذّر قراءة الملف: ' + (e.message || ''));
    }
  }
}

// ════ البحث ════
function toggleSearch() {
  const bar = document.getElementById('searchBar');
  const isOpen = bar.classList.contains('show');
  if (isOpen) {
    bar.classList.remove('show'); clearSearchHighlights();
    _searchResults=[]; _searchIndex=0;
    document.getElementById('searchInput').value='';
    document.getElementById('searchCount').textContent='';
  } else {
    bar.classList.add('show');
    setTimeout(() => document.getElementById('searchInput').focus(), 50);
  }
}
function searchMessages(query) {
  clearSearchHighlights(); _searchResults=[]; _searchIndex=0;
  const countEl = document.getElementById('searchCount');
  if (!query.trim()) { countEl.textContent=''; return; }
  document.querySelectorAll('#messagesArea .msg-content').forEach(el => {
    if (el.textContent.toLowerCase().includes(query.toLowerCase())) {
      const text = el.textContent, idx = text.toLowerCase().indexOf(query.toLowerCase());
      el.innerHTML = escHtml(text.substring(0,idx)) + `<mark class="msg-highlight">${escHtml(text.substring(idx,idx+query.length))}</mark>` + escHtml(text.substring(idx+query.length));
      _searchResults.push(el);
    }
  });
  if (!_searchResults.length) { countEl.textContent='لا نتائج'; return; }
  highlightCurrent(); countEl.textContent=`1 / ${_searchResults.length}`;
}
function navigateSearch(dir) {
  if (!_searchResults.length) return;
  _searchIndex = (_searchIndex+dir+_searchResults.length)%_searchResults.length;
  highlightCurrent();
  document.getElementById('searchCount').textContent=`${_searchIndex+1} / ${_searchResults.length}`;
}
function highlightCurrent() {
  _searchResults.forEach((el,i) => { const m=el.querySelector('mark'); if(m) m.className=i===_searchIndex?'msg-highlight-current':'msg-highlight'; });
  _searchResults[_searchIndex]?.closest('.msg-group')?.scrollIntoView({behavior:'smooth',block:'center'});
}
function clearSearchHighlights() {
  document.querySelectorAll('#messagesArea .msg-content mark').forEach(m => { m.parentNode.replaceChild(document.createTextNode(m.textContent),m); m.parentNode.normalize(); });
}

// ════ Lightbox ════
let _lightboxUrl='', _lightboxType='', _lightboxName='';
function openLightbox(url, type, name) {
  _lightboxUrl=url; _lightboxType=type; _lightboxName=name||'media';
  const bg=document.getElementById('lightboxBg');
  const img=document.getElementById('lightboxImg');
  const vid=document.getElementById('lightboxVid');
  if (!bg) return;
  bg.style.display='flex';
  if (type==='video') { if(img) img.style.display='none'; if(vid){vid.src=url;vid.style.display='block';} }
  else { if(vid){vid.style.display='none';vid.src='';} if(img){img.src=url;img.style.display='block';} }
}
function closeLightbox() {
  const bg=document.getElementById('lightboxBg');
  const vid=document.getElementById('lightboxVid');
  if (bg) bg.style.display='none';
  if (vid){vid.pause();vid.src='';}
}
function lightboxDownload() { downloadMedia(_lightboxUrl,_lightboxName,_lightboxType); }
function downloadMedia(url, name, type) {
  const ext = type==='video'?'.mp4':'.jpg';
  const filename = name.includes('.')?name:name+ext;
  fetch(url).then(r=>r.blob()).then(blob=>{
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    toast('✅ تم الحفظ!');
  }).catch(()=>window.open(url,'_blank'));
}

// ESC key
document.addEventListener('keydown', e => {
  if (e.key==='Escape') {
    if (_editingKey) cancelEdit();
    else if (document.getElementById('searchBar')?.classList.contains('show')) toggleSearch();
  }
});

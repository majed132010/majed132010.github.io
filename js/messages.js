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
  showView('messages');
  if (typeof _currentUserMuted !== 'undefined') _applyMuteState(_currentUserMuted);
  // ضمان العضوية في كل مسار (استعادة الجلسة، الدعوات، إلخ)
  if (typeof _ensureMemberRegistered === 'function') _ensureMemberRegistered(sid);
  _oldestMsgKey = null; _allLoaded = false;
  _currentMsgPath = 'messages/' + sid + '/' + cid;
  const area = document.getElementById('messagesArea');
  const loadBtn = document.getElementById('loadMoreBtn');
  area.innerHTML = '';
  if (loadBtn) { loadBtn.style.display = 'none'; area.appendChild(loadBtn); }
  cleanupMessagesListener();
  clearUnread(sid, cid);
  listenTyping(sid, cid);

  // رقم جيل فريد لهذه الاستدعاءة — يُبطل callbacks الـ async القديمة إن بدّل المستخدم القناة قبل حلّها
  const gen = ++_msgLoadGen;

  const fn = snap => {
    const msg = snap.val();
    if (!msg) return;
    if (area.querySelector(`[data-key="${snap.key}"]`)) return;
    const div = buildMsgDiv(msg, snap.key);
    area.appendChild(div);
    const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
    if (distFromBottom < 300) area.scrollTop = area.scrollHeight;
    if (msg.uid !== currentUser?.uid) {
      // Belt-and-suspenders: use window.currentServerId / window.currentChannelId
      // (the explicit global mirrors set by selectChannel/showHome in servers.js)
      // as the authoritative active-channel signal before delegating to showInAppNotif.
      const activeSid = window.currentServerId !== undefined ? window.currentServerId : currentServer;
      const activeCid = window.currentChannelId !== undefined ? window.currentChannelId : currentChannel;
      if (activeSid === sid && activeCid === cid) {
        console.log('[NOTIF] 🔇 fn مُحجوب — القناة النشطة:', sid, '/', cid);
      } else {
        showInAppNotif(msg, sid, cid);
      }
    }
  };

  db.ref(_currentMsgPath).limitToLast(PAGE_SIZE).once('value').then(snap => {
    // إن تغيّرت القناة قبل حلّ هذا الـ promise نتجاهله تماماً — لا نسجّل أي listener
    if (gen !== _msgLoadGen) return;

    const msgs = snap.val() || {};
    const entries = Object.entries(msgs).sort((a,b) => a[1].ts - b[1].ts);
    entries.forEach(([key, msg]) => {
      const div = buildMsgDiv(msg, key);
      area.appendChild(div);
    });
    area.scrollTop = area.scrollHeight;
    setTimeout(() => { area.scrollTop = area.scrollHeight; }, 300);
    setTimeout(() => { area.scrollTop = area.scrollHeight; }, 800);
    if (entries.length > 0) {
      _oldestMsgKey = entries[0][0];
      if (loadBtn) loadBtn.style.display = entries.length >= PAGE_SIZE ? 'block' : 'none';
    }
    const lastKey = entries.length > 0 ? entries[entries.length-1][0] : null;
    // نحفظ queryRef بدلاً من path فقط — .off() يحتاج نفس ref object الذي استُخدم في .on()
    const queryRef = lastKey
      ? db.ref(_currentMsgPath).orderByKey().startAfter(lastKey)
      : db.ref(_currentMsgPath).limitToLast(1);
    queryRef.on('child_added', fn);

    // Live reaction + edit updates for every visible message
    const changeFn = snap => {
      const msg = snap.val();
      if (!msg) return;
      const el = document.querySelector(`[data-key="${snap.key}"]`);
      if (!el) return;
      const body = el.querySelector('.msg-body');
      if (!body) return;
      // Re-render reactions in-place
      renderReactions(msg.reactions || null, snap.key, body);
      // If the user is already near the bottom, keep them pinned so the
      // newly-rendered reaction chip stays visible without manual scrolling
      const area = document.getElementById('messagesArea');
      if (area && area.scrollHeight - area.scrollTop - area.clientHeight < 200) {
        area.scrollTop = area.scrollHeight;
      }
      // Sync edited text visible to this client when another tab/user edits
      if (msg.text !== undefined) {
        const contentEl = body.querySelector('.msg-content');
        if (contentEl && contentEl.textContent !== msg.text) contentEl.textContent = msg.text;
        if (msg.edited && !body.querySelector('.msg-edited')) {
          const metaEl = body.querySelector('.msg-meta');
          if (metaEl) metaEl.insertAdjacentHTML('beforeend', '<span class="msg-edited">(معدّل)</span>');
        }
      }
    };
    db.ref(_currentMsgPath).on('child_changed', changeFn);
    messagesListener = { path: _currentMsgPath, queryRef, fn, changeFn };
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

  if (msg.mediaUrl) {
    const expired = msg.expiresAt && !msg.saved && Date.now() > msg.expiresAt;
    if (expired) {
      const expDiv = document.createElement('div');
      expDiv.className = 'msg-media-expired';
      expDiv.textContent = '🕐 انتهت صلاحية هذه الصورة';
      body.appendChild(expDiv);
    } else if (msg.mediaType === 'video') {
      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'msg-media-wrap';
      const vid = document.createElement('video');
      vid.src = msg.mediaUrl; vid.controls = true; vid.preload = 'metadata';
      vid.className = 'msg-media-vid';
      vid.addEventListener('click', e => { e.preventDefault(); openLightbox(msg.mediaUrl,'video',msg.mediaName); });
      mediaWrap.appendChild(vid);
      body.appendChild(mediaWrap);
    } else {
      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'msg-media-wrap';
      const img = document.createElement('img');
      img.decoding = 'async';
      img.className = 'msg-media-img';
      img.src = '';                // blank immediately — no inherited/default src
      img.dataset.msgKey = key;   // stamp with message key for async guard
      img.alt = msg.mediaName || '';
      img.addEventListener('click', () => openLightbox(msg.mediaUrl,'image',msg.mediaName, msg.expiresAt && !msg.saved ? key : null));
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

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const reactBtn = document.createElement('button');
  reactBtn.className = 'ma-btn'; reactBtn.textContent = '😀'; reactBtn.title = 'تفاعل';
  reactBtn.addEventListener('click', e => { e.stopPropagation(); showReactionPicker(key, reactBtn); });
  actions.appendChild(reactBtn);

  const replyBtn = document.createElement('button');
  replyBtn.className = 'ma-btn'; replyBtn.textContent = '↩️'; replyBtn.title = 'رد';
  replyBtn.addEventListener('click', e => { e.stopPropagation(); setReply(key, msg.name, msg.text); });
  actions.appendChild(replyBtn);

  if (isMine && msg.text) {
    const editBtn = document.createElement('button');
    editBtn.className = 'ma-btn'; editBtn.textContent = '✏️'; editBtn.title = 'تعديل';
    editBtn.addEventListener('click', e => { e.stopPropagation(); startEditMessage(key, msg.text); });
    actions.appendChild(editBtn);
  }
  if (isMine || isAdminUser) {
    const delBtn = document.createElement('button');
    delBtn.className = 'ma-btn danger'; delBtn.textContent = '🗑️'; delBtn.title = 'حذف';
    delBtn.addEventListener('click', e => { e.stopPropagation(); deleteMessage(key); });
    actions.appendChild(delBtn);
  }

  let lpTimer;
  div.addEventListener('touchstart', () => { lpTimer = setTimeout(() => { actions.style.display='flex'; }, 500); }, {passive:true});
  div.addEventListener('touchend', () => clearTimeout(lpTimer), {passive:true});
  div.addEventListener('touchmove', () => clearTimeout(lpTimer), {passive:true});

  div.appendChild(av); div.appendChild(body); div.appendChild(actions);
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
  if (!confirm('طرد "' + name + '" من السيرفر؟')) return;
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
  if (_currentUserMuted) { toast('🔇 أنت مكتوم في هذا السيرفر'); return; }
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

  if (_editingKey) {
    const key = _editingKey;
    cancelEdit();
    await db.ref('messages/' + currentServer + '/' + currentChannel + '/' + key).update({ text, edited: true, editedAt: Date.now() });
    const msgEl = document.querySelector(`[data-key="${key}"] .msg-content`);
    if (msgEl) msgEl.textContent = text;
    const editedLabel = document.querySelector(`[data-key="${key}"] .msg-edited`);
    if (!editedLabel) {
      const metaEl = document.querySelector(`[data-key="${key}"] .msg-meta`);
      if (metaEl) metaEl.insertAdjacentHTML('beforeend','<span class="msg-edited">(معدّل)</span>');
    }
    toast('✅ تم تعديل الرسالة');
    return;
  }

  const sv = servers[currentServer];
  const role = sv?.members?.[currentUser.uid]?.role || 'member';
  const msgBase = { uid: currentUser.uid, name: userProfile.displayName || 'مستخدم', ts: Date.now(), role };
  if (_replyTo) { msgBase.replyTo = { key: _replyTo.key, name: _replyTo.name, text: _replyTo.text || '' }; clearReply(); }

  if (text) {
    await db.ref('messages/' + currentServer + '/' + currentChannel).push({ ...msgBase, text });
    setTimeout(() => {
      try {
        const members = servers[currentServer]?.members || {};
        Object.keys(members).forEach(uid => {
          if (uid !== currentUser.uid) {
            sendPushToUser(uid, userProfile.displayName || 'عوالم', text.slice(0, 80), {
              serverId: currentServer, channelId: currentChannel,
              senderName: userProfile.displayName, type: 'message'
            });
          }
        });
      } catch(e) {}
    }, 0);
  }

  if (media.length) {
    if (!_isConnected) {
      try { await waitForConnection(5000); }
      catch(e) { toast('❌ لا يوجد اتصال — تحقق من الإنترنت وأعد المحاولة'); return; }
    }
    if (!auth.currentUser) { toast('❌ يجب تسجيل الدخول أولاً'); return; }
    // Refresh the auth token before Storage upload. On mobile, the token can silently
    // expire while the app is in background, causing "Failed to fetch" from Storage.
    try { await auth.currentUser.getIdToken(true); } catch(e) { /* non-fatal */ }
    toast('⏱️ ميديا مؤقتة: تختفي تلقائياً بعد 24 ساعة');
    window._sendingMedia = true;
    try {
      for (const m of media) {
        const area = document.getElementById('messagesArea');
        const localUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = (e) => res(e.target.result);
          fr.onerror = () => rej(new Error('FileReader failed'));
          fr.readAsDataURL(m.file);
        });
        const tempKey = 'temp_' + Date.now() + '_' + Math.random();

        // عرض preview فوري
        const tempDiv = document.createElement('div');
        tempDiv.className = 'msg-group';
        tempDiv.dataset.key = tempKey;
        tempDiv.style.opacity = '0.65';
        const tempAv = document.createElement('div');
        tempAv.className = 'msg-av';
        const _myAv = userProfile?.avatar || auth.currentUser?.photoURL || null;
        if (_myAv) {
          tempAv.innerHTML = `<img src="${_myAv}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
        } else {
          tempAv.textContent = (msgBase.name || '?')[0];
        }
        const tempBody = document.createElement('div');
        tempBody.className = 'msg-body';
        const tempMeta = document.createElement('div');
        tempMeta.className = 'msg-meta';
        tempMeta.innerHTML = `<span class="msg-name">${escHtml(msgBase.name||'')}</span><span class="msg-time">${formatTime(msgBase.ts)}</span>`;
        tempBody.appendChild(tempMeta);
        const tempWrap = document.createElement('div');
        tempWrap.className = 'msg-media-wrap';
        if (m.type === 'video') {
          const vid = document.createElement('video');
          vid.src = localUrl;
          vid.className = 'msg-media-vid';
          tempWrap.appendChild(vid);
        } else {
          const img = document.createElement('img');
          img.src = localUrl;
          img.className = 'msg-media-img';
          tempWrap.appendChild(img);
        }
        const indicator = document.createElement('div');
        indicator.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.55);color:#fff;border-radius:20px;padding:5px 14px;font-size:12px;font-family:Tajawal,sans-serif;white-space:nowrap';
        indicator.textContent = '⏳ جاري الرفع...';
        tempWrap.appendChild(indicator);
        tempBody.appendChild(tempWrap);
        tempDiv.appendChild(tempAv);
        tempDiv.appendChild(tempBody);
        if (area) { area.appendChild(tempDiv); area.scrollTop = area.scrollHeight; }

        const uploadController = new AbortController();
        const uploadTimeout = setTimeout(() => uploadController.abort(), 60000);
        try {
          const ext = (m.file.name.split('.').pop() || (m.type === 'video' ? 'mp4' : 'jpg')).toLowerCase();
          const storagePath = `media/${currentServer}/${currentChannel}/${Date.now()}.${ext}`;
          const mediaUrl = await uploadToStorage(m.file, storagePath, {
            signal: uploadController.signal,
            onProgress: (pct) => { indicator.textContent = `⏳ ${pct}%`; }
          });
          clearTimeout(uploadTimeout);
          if (!mediaUrl) throw new Error('لم يتم الحصول على رابط الملف بعد اكتمال الرفع');
          const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
          await db.ref('messages/' + currentServer + '/' + currentChannel).push({
            ...msgBase, text: '', mediaUrl, mediaType: m.type, mediaName: m.name, expiresAt, saved: false
          });
          setTimeout(() => { tempDiv.remove(); if (area) area.scrollTop = area.scrollHeight; }, 1500);
        } catch(e) {
          clearTimeout(uploadTimeout);
          tempDiv.remove();
          if (e.code === 'storage/canceled') {
            toast('❌ انتهت مهلة الرفع (60 ثانية) — تحقق من الاتصال وأعد المحاولة');
          } else if (e.code === 'storage/unauthorized') {
            toast('❌ لا صلاحية للرفع — تحقق من قواعد Firebase Storage (المسار: media/{sid})');
          } else if (!navigator.onLine || (e.message || '').toLowerCase().includes('fetch') || (e.message || '').toLowerCase().includes('network')) {
            toast('❌ فشل الرفع — تحقق من الاتصال وأعد المحاولة');
          } else {
            toast('❌ فشل رفع الملف: ' + (e.message || ''));
          }
        }
      }
    } finally {
      window._sendingMedia = false;
    }
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
    // child_added يجب فصله عبر نفس queryRef المستخدم في .on() — الـ path وحده لا يكفي
    if (messagesListener.queryRef) messagesListener.queryRef.off('child_added', messagesListener.fn);
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
function handleMediaSelect(input) {
  const files = Array.from(input.files);
  if (!files.length) return;
  const preview = document.getElementById('mediaPreviewArea');
  if (!preview) return;
  files.forEach(file => {
    const isVideo = file.type.startsWith('video');
    const maxSize = isVideo ? 500*1024*1024 : 50*1024*1024;
    const maxLabel = isVideo ? '500MB' : '50MB';
    if (file.size > maxSize) { toast(`❌ الملف أكبر من ${maxLabel}`); return; }
    const entry = { file, type: isVideo ? 'video' : 'image', name: file.name };
    window._pendingMedia.push(entry);
    preview.style.display = 'flex';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-flex;flex-shrink:0';
    const localUrl = URL.createObjectURL(file);
    if (entry.type === 'video') {
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
      window._pendingMedia = window._pendingMedia.filter(e => e!==entry);
      wrap.remove();
      if (!window._pendingMedia.length) preview.style.display='none';
      document.getElementById('sendBtn').classList.toggle('active', !!(window._pendingMedia.length||document.getElementById('mainChatInp')?.value.trim()));
    });
    wrap.appendChild(rm); preview.appendChild(wrap);
    document.getElementById('sendBtn').classList.add('active');
  });
  input.value = '';
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
let _lightboxUrl='', _lightboxType='', _lightboxName='', _lightboxMsgKey=null;
function openLightbox(url, type, name, msgKey) {
  _lightboxUrl=url; _lightboxType=type; _lightboxName=name||'media'; _lightboxMsgKey=msgKey||null;
  const bg=document.getElementById('lightboxBg');
  const img=document.getElementById('lightboxImg');
  const vid=document.getElementById('lightboxVid');
  const saveBtn=document.getElementById('lightboxSaveInChat');
  if (!bg) return;
  bg.style.display='flex';
  if (saveBtn) saveBtn.style.display=msgKey?'inline-block':'none';
  if (type==='video') { if(img) img.style.display='none'; if(vid){vid.src=url;vid.style.display='block';} }
  else { if(vid){vid.style.display='none';vid.src='';} if(img){img.src=url;img.style.display='block';} }
}
async function lightboxSaveInChat() {
  if (!_lightboxMsgKey) return;
  const btn=document.getElementById('lightboxSaveInChat');
  if (btn){btn.disabled=true;btn.textContent='⏳...';}
  try {
    await db.ref('messages/'+currentServer+'/'+currentChannel+'/'+_lightboxMsgKey).update({saved:true,expiresAt:null});
    const cached=await _imgCacheDB.get(_lightboxUrl);
    if (cached) await _imgCacheDB.set(_lightboxUrl,cached.blob,null,true);
    toast('📌 تم حفظ الصورة بشكل دائم');
    if (btn){btn.textContent='✅ تم الحفظ';btn.style.display='none';}
    _lightboxMsgKey=null;
  } catch(e) { if(btn){btn.disabled=false;btn.textContent='📌 حفظ في المحادثة';} toast('❌ فشل الحفظ'); }
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

window.openDMFromSvBar = function() {
  if (isMobile()) openDrawer();
  else openDMScreen();
};

window.openDMScreen = function() {
  openDMScreen();
};

// ════ فتح محادثة خاصة (نسخة معدلة لدعم وقت القراءة) ════
function openDM(uid, name) {
  closeSidebar();
  _currentDmUid = uid;
  document.getElementById('mhIcon').textContent = '💬';
  document.getElementById('mhName').textContent = name;
  document.getElementById('searchToggleBtn').style.display = 'none';
  document.getElementById('membersToggleBtn').style.display = 'none';

  // أزرار المكالمة
  const oldBtns = document.getElementById('dmCallBtns');
  if (oldBtns) oldBtns.remove();
  const btns = document.createElement('div');
  btns.id = 'dmCallBtns';
  btns.style.cssText = 'display:flex;gap:8px;margin-right:auto';
  const audioBtn = document.createElement('button');
  audioBtn.textContent = '📞';
  audioBtn.style.cssText = 'background:rgba(35,165,90,0.2);border:1px solid rgba(35,165,90,0.4);color:#23a55a;border-radius:8px;padding:5px 10px;font-size:18px;cursor:pointer;-webkit-tap-highlight-color:transparent';
  audioBtn.addEventListener('click', () => startCall(uid, name, 'audio'));
  const videoBtn = document.createElement('button');
  videoBtn.textContent = '📹';
  videoBtn.style.cssText = 'background:rgba(26,95,95,0.2);border:1px solid rgba(26,95,95,0.4);color:var(--gold);border-radius:8px;padding:5px 10px;font-size:18px;cursor:pointer;-webkit-tap-highlight-color:transparent';
  videoBtn.addEventListener('click', () => startCall(uid, name, 'video'));
  btns.appendChild(audioBtn);
  btns.appendChild(videoBtn);
  const header = document.querySelector('.main-header');
  if (header) header.appendChild(btns);

  showView('dm');
  document.getElementById('dmPickerScreen').style.display = 'none';
  const chat = document.getElementById('dmChatArea');
  if (chat) { chat.style.display = 'flex'; chat.style.flexDirection = 'column'; }
  clearDmUnread(uid);
  
  // تحديث الرسائل القديمة غير المقروءة عند فتح المحادثة مع تسجيل وقت القراءة الحالي
  db.ref('dm_messages/' + getDmId(currentUser.uid, uid)).limitToLast(10).once('value').then(snap => {
    const updates = {};
    const now = Date.now();
    snap.forEach(ch => {
      const msg = ch.val();
      if (msg && msg.uid === uid && msg.status !== 'read') {
        updates[ch.key + '/status'] = 'read';
        updates[ch.key + '/readAt'] = now;
      }
    });
    if (Object.keys(updates).length) db.ref('dm_messages/' + getDmId(currentUser.uid, uid)).update(updates);
  });
  renderDmList();

  const dmArea = document.getElementById('dmMessages');
  dmArea.innerHTML = '';

  if (_dmListener) {
    const _r = _dmListener.mainRef || null;
    if (_r) _r.off('child_added', _dmListener.fn);
    else db.ref(_dmListener.path).off('child_added', _dmListener.fn);
    if (_dmListener.changeFn) db.ref(_dmListener.path).off('child_changed', _dmListener.changeFn);
    _dmListener = null;
  }
  if (_dmTypingListener) { db.ref(_dmTypingListener).off('value'); _dmTypingListener = null; }

  const dmId = getDmId(currentUser.uid, uid);
  const path = 'dm_messages/' + dmId;
  let _dmInitialDone = false;

  const fn = snap => {
    const msg = snap.val();
    if (!msg || dmArea.querySelector(`[data-key="${snap.key}"]`)) return;
    const _d = buildDmMsgDiv(msg, snap.key, uid, name); if (!_d) return;
    dmArea.appendChild(_d);
    
    // إذا كانت الرسالة واردة وجديدة، نضع علامة مقروء مع وقت القراءة فوراً
    if (msg.uid === uid && msg.status !== 'read') {
      db.ref('dm_messages/' + getDmId(currentUser.uid, uid) + '/' + snap.key).update({
        status: 'read',
        readAt: Date.now()
      });
    }
    if (_dmInitialDone) {
      dmArea.scrollTop = dmArea.scrollHeight;
    }
  };

  // child_changed: يستقبل تحديثات الحالة والرفع والميديا
  const changeFn = snap => {
    const msg = snap.val();
    if (!msg) return;
    
    // تحديث حالة القراءة للمرسل في الوقت الفعلي (Real-time read receipt)
    if (msg.status === 'read' && msg.uid === currentUser.uid) {
      const statusEl = dmArea.querySelector(`.msg-status[data-key="${snap.key}"]`);
      if (statusEl) {
        statusEl.textContent = '✓✓';
        statusEl.style.color = '#5865f2';
        if (msg.readAt) {
          statusEl.title = 'قرأ الساعة ' + new Date(msg.readAt).toLocaleTimeString('ar-SA', {hour:'2-digit', minute:'2-digit'});
          statusEl.style.cursor = 'help';
        }
      }
    }
    
    const el = dmArea.querySelector(`[data-key="${snap.key}"]`);
    if (!el) return;
    const body = el.querySelector('.msg-body');
    if (!body) return;
    const progWrap = body.querySelector('.msg-uploading-wrap, .msg-upload-preview-wrap');
    if (progWrap) {
      if (msg.uploading) {
        _updateUploadProgressEl(progWrap, msg.uploadProgress || 0, msg.mediaType);
      } else if (!msg.uploading && msg.mediaUrl) {
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
        requestAnimationFrame(() => { dmArea.scrollTop = dmArea.scrollHeight; });
      } else if (!msg.uploading && msg.uploadFailed) {
        _showUploadFailedEl(progWrap, snap.key);
      }
    }
  };

  const dmRef = db.ref(path).limitToLast(40);
  dmRef.on('child_added', fn);
  db.ref('dm_messages/' + dmId).on('child_changed', changeFn);
  _dmListener = { path, mainRef: dmRef, fn, changeFn };

  dmRef.once('value', () => {
    _dmInitialDone = true;
    dmArea.scrollTop = dmArea.scrollHeight;
    setTimeout(() => { dmArea.scrollTop = dmArea.scrollHeight; }, 150);
  });

  const typPath = 'dm_typing/' + dmId + '/' + uid;
  _dmTypingListener = typPath;
  db.ref(typPath).on('value', snap => {
    const el = document.getElementById('dmTypingIndicator');
    if (el) el.textContent = snap.val() ? name + ' يكتب...' : '';
  });
}

// ════ بناء رسالة خاصة (نسخة معدلة لدعم تلميح وقت القراءة) ════
function buildDmMsgDiv(msg, key, otherUid, otherName) {
  const isMine = msg.uid === currentUser?.uid;
  const div = document.createElement('div');
  div.className = 'msg-group'; div.dataset.key = key;
  const av = document.createElement('div'); av.className='msg-av'; av.textContent=(msg.name||'?')[0];
  const body = document.createElement('div'); body.className='msg-body';
  const meta = document.createElement('div'); meta.className='msg-meta';
  meta.innerHTML=`<span class="msg-name">${escHtml(msg.name||'')}</span><span class="msg-time">${formatTime(msg.ts)}</span>`;
  body.appendChild(meta);
  
  if (isMine) {
    const statusEl = document.createElement('span');
    statusEl.className = 'msg-status';
    statusEl.dataset.key = key;
    statusEl.style.cssText = 'font-size:11px;margin-right:4px;';
    statusEl.textContent = msg.status === 'read' ? '✓✓' : '✓';
    statusEl.style.color = msg.status === 'read' ? '#5865f2' : '#8899aa';
    statusEl.style.marginTop = '2px';
    statusEl.style.display = 'inline-block';
    
    // إضافة تلميح الوقت المحدّث للرسائل المحمّلة مسبقاً إذا كانت مقروءة ولديها وقت مسجل
    if (msg.status === 'read' && msg.readAt) {
      statusEl.title = 'قرأ الساعة ' + new Date(msg.readAt).toLocaleTimeString('ar-SA', {hour:'2-digit', minute:'2-digit'});
      statusEl.style.cursor = 'help';
    }
    
    console.log('[STATUS]', msg.status, key);
    meta.appendChild(statusEl);
  }
  
  if (msg.replyTo) {
    const quote=document.createElement('div'); quote.className='msg-reply-quote';
    quote.innerHTML=`<div class="rq-name">${escHtml(msg.replyTo.name||'')}</div><div class="rq-text">${escHtml(msg.replyTo.text||'🖼️')}</div>`;
    body.appendChild(quote);
  }
  if (msg.text) { const txt=document.createElement('div'); txt.className='msg-content'; txt.textContent=msg.text; body.appendChild(txt); }
  if (msg.uploading && !msg.mediaUrl) {
    body.appendChild(_buildUploadProgressEl(key, msg.uploadProgress || 1, msg.mediaType));
  }
  if (msg.mediaUrl) {
    if (msg.expiresAt && !msg.saved && Date.now() > msg.expiresAt) return null;
    if (msg.mediaType === 'video') {
      body.appendChild(buildCachedVideoEl(msg.mediaUrl, msg.mediaName));
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'msg-media-wrap';
      const img = document.createElement('img');
      img.loading = 'lazy'; img.decoding = 'async';
      img.className = 'msg-media-img';
      img.alt = msg.mediaName || '';
      img.addEventListener('click', () => openLightbox(msg.mediaUrl,'image',msg.mediaName));
      loadCachedImage(msg.mediaUrl, msg.expiresAt, msg.saved).then(src => { if (src) img.src = src; });
      wrap.appendChild(img);
      body.appendChild(wrap);
    }
  }
  if (msg.voiceUrl) { const vw=document.createElement('div'); vw.style.cssText='margin-top:4px'; vw.appendChild(buildVoiceMsg(msg.voiceUrl,msg.voiceDuration)); body.appendChild(vw); }

  const actions=document.createElement('div'); actions.className='msg-actions';
  const replyBtn=document.createElement('button'); replyBtn.className='ma-btn'; replyBtn.textContent='↩️'; replyBtn.title='رد';
  replyBtn.addEventListener('click',e=>{e.stopPropagation();setDmReply(key,msg.name,msg.text);}); actions.appendChild(replyBtn);
  if (isMine) {
    const delBtn=document.createElement('button'); delBtn.className='ma-btn danger'; delBtn.textContent='🗑️'; delBtn.title='حذف';
    delBtn.addEventListener('click',e=>{e.stopPropagation();deleteDmMessage(key,otherUid);}); actions.appendChild(delBtn);
  }
  div.appendChild(av); div.appendChild(body); div.appendChild(actions);

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
    { icon: '↩️', label: 'رد',         fn: () => setDmReply(key, msg.name, msg.text) },
    { icon: '📤', label: 'إعادة إرسال', fn: () => toast('📤 قريباً') },
    { icon: '⭐', label: 'تثبيت',        fn: () => toast('⭐ قريباً') },
    ...(isMine ? [{ icon: '🗑️', label: 'حذف', danger: true, fn: () => deleteDmMessage(key, otherUid) }] : []),
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

window.openDMFromSvBar = function() {
  if (typeof isMobile === 'function' && isMobile()) {
    if (typeof openDrawer === 'function') openDrawer();
  } else {
    if (typeof openDMScreen === 'function') openDMScreen();
  }
};

window.sendDM = async function() {
  if (!_currentDmUid || !currentUser) return;
  const inp = document.getElementById('dmChatInp');
  const text = inp?.value.trim();
  if (!text && !window._pendingDmMedia?.length) return;
  inp.value = ''; inp.style.height = '';
  document.getElementById('dmSendBtn').classList.remove('active');
  if (typeof stopDmTyping === 'function') stopDmTyping();
  const dmId = getDmId(currentUser.uid, _currentDmUid);
  const msgBase = { uid: currentUser.uid, name: userProfile.displayName||'مستخدم', ts: Date.now(), status: 'sent' };
  if (_dmReplyTo) { msgBase.replyTo = { ..._dmReplyTo }; clearDmReply(); }
  if (text) {
    await db.ref('dm_messages/' + dmId).push({ ...msgBase, text });
    try { await sendPushToUser(_currentDmUid, userProfile.displayName||'رسالة خاصة', text.slice(0,80), { type:'dm', fromUid: currentUser.uid }); } catch(e) {}
  }
  const media = window._pendingDmMedia || [];
  window._pendingDmMedia = [];
  for (const m of media) {
    const dmMsgPath = 'dm_messages/' + dmId;
    const msgRef = db.ref(dmMsgPath).push();
    const msgKey = msgRef.key;
    await msgRef.set({ ...msgBase, text:'', mediaType:m.type, mediaName:m.name, uploading:true, uploadProgress:1, expiresAt: Date.now()+86400000, saved:false });
    try {
      const url = await uploadToCloudinary(new File([m.blob], m.name, {type:m.mimeType}), 3, ()=>{});
      await db.ref(dmMsgPath+'/'+msgKey).update({ mediaUrl:url, uploading:false, uploadProgress:null });
    } catch(e) {
      db.ref(dmMsgPath+'/'+msgKey).update({ uploading:false, uploadFailed:true });
      toast('❌ فشل رفع الملف');
    }
  }
  const otherSnap = await db.ref('users/'+_currentDmUid+'/displayName').once('value');
  const otherName = otherSnap.val() || 'مستخدم';
  await db.ref('dms/'+currentUser.uid+'/'+_currentDmUid).set({ name:otherName, ts:Date.now() });
  await db.ref('dms/'+_currentDmUid+'/'+currentUser.uid).set({ name:userProfile.displayName||'مستخدم', ts:Date.now() });
};

function openDMScreen() {
  closeSidebar();
  if (currentServer) _lastServerId = currentServer;
  currentServer = null; currentChannel = null; _currentDmUid = null;
  if (document.getElementById('chSettingsBtn')) document.getElementById('chSettingsBtn').style.display = 'none';
  document.getElementById('mhIcon').textContent = '💬';
  document.getElementById('mhName').textContent = 'الرسائل الخاصة';
  document.getElementById('searchToggleBtn').style.display = 'none';
  document.getElementById('membersToggleBtn').style.display = 'none';
  const oldBtns = document.getElementById('dmCallBtns');
  if (oldBtns) oldBtns.remove();
  if (typeof renderServerList === 'function') renderServerList();
  showView('dm');
  const dmPicker = document.getElementById('dmPickerScreen');
  if (dmPicker) dmPicker.style.display = 'flex';
  const dmChat = document.getElementById('dmChatArea');
  if (dmChat) dmChat.style.display = 'none';
  renderDmPickerList();
}

function renderDmPickerList() {
  const container = document.getElementById('dmPickerList');
  if (!container || !currentUser) return;

  const activeServer = currentServer || _lastServerId;
  const svMembers = {};
  if (activeServer && typeof servers !== 'undefined' && servers[activeServer]?.members) {
    Object.entries(servers[activeServer].members).forEach(([uid, m]) => {
      if (uid !== currentUser.uid) svMembers[uid] = m;
    });
  }

  const memberUids = Object.keys(svMembers);
  container.innerHTML = '';

  if (!memberUids.length) {
    container.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-family:Tajawal,sans-serif;font-size:14px">لا يوجد أعضاء آخرون في هذا العالم</div>';
    return;
  }

  Promise.all(
    memberUids.map(uid =>
      db.ref('users/' + uid).once('value').then(s => {
        const live = s.val() || {};
        const member = svMembers[uid] || {};
        return { uid, name: live.displayName || member.name || 'عضو', avatar: live.avatar || member.avatar || null };
      })
    )
  ).then(list => {
    container.innerHTML = '';
    const grid = document.createElement('div');
    grid.id = 'dmPickerGrid';
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px;padding:8px 4px 16px';

    list.forEach(({ uid, name, avatar }) => {
      const card = document.createElement('div');
      card.dataset.dmUid = uid;
      card.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 10px 14px;border-radius:18px;background:rgba(0,0,0,0.03);border:1.5px solid rgba(0,0,0,0.07);cursor:pointer;-webkit-tap-highlight-color:transparent';

      const av = document.createElement('div');
      av.style.cssText = 'width:72px;height:72px;border-radius:50%;overflow:hidden;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:#fff';
      if (avatar) av.innerHTML = `<img src="${escHtml(avatar)}" style="width:100%;height:100%;object-fit:cover;display:block">`;
      else av.textContent = (name[0] || '?').toUpperCase();

      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:13px;font-weight:700;color:var(--text);text-align:center;font-family:Tajawal,sans-serif';
      nameEl.textContent = name;

      card.appendChild(av);
      card.appendChild(nameEl);
      card.addEventListener('click', () => openDM(uid, name));
      grid.appendChild(card);
    });

    container.appendChild(grid);
  });
}

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
  if (typeof clearDmUnread === 'function') clearDmUnread(uid);
  
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

// ════ متغيرات الحالة ════
function getDmId(uid1, uid2) { return [uid1, uid2].sort().join('_'); }

const _dmUnread = {};
const _dmGlobalListeners = {};
let _dmListener = null;
let _dmTypingListener = null;
let _dmReplyTo = null;
let _currentDmUid = null;
let _lastServerId = null;
let _dmTypingTimer = null;

function clearDmUnread(uid) {
  _dmUnread[uid] = 0;
  if (typeof updateDmBadge === 'function') updateDmBadge();
  renderDmList();
}

function renderDmList() {
  const container = document.getElementById('dmList');
  if (!container || !currentUser) return;
  db.ref('dms/' + currentUser.uid).once('value').then(snap => {
    const dms = snap.val() || {};
    container.innerHTML = '';
    if (!Object.keys(dms).length) return;
    Object.entries(dms).sort((a,b) => (b[1].ts||0) - (a[1].ts||0)).forEach(([uid, info]) => {
      const item = document.createElement('div');
      item.className = 'dm-item' + (_currentDmUid === uid ? ' active' : '');
      const unread = _dmUnread[uid] || 0;
      item.innerHTML = `<div class="dm-av">${(info.name||'?')[0]}</div><div class="dm-name">${escHtml(info.name||'مستخدم')}</div>${unread > 0 ? `<div class="dm-unread">${unread > 99 ? '99+' : unread}</div>` : ''}`;
      item.addEventListener('click', () => openDM(uid, info.name || 'مستخدم'));
      container.appendChild(item);
    });
  });
}

function setDmReply(key, name, text) {
  _dmReplyTo = { key, name, text };
  document.getElementById('dmReplyName').textContent = name;
  document.getElementById('dmReplyText').textContent = text || '🖼️';
  document.getElementById('dmReplyBar').style.display = 'flex';
  document.getElementById('dmChatInp').focus();
}

function clearDmReply() {
  _dmReplyTo = null;
  document.getElementById('dmReplyBar').style.display = 'none';
}

function startDmTyping() {
  if (!_currentDmUid || !currentUser) return;
  const dmId = getDmId(currentUser.uid, _currentDmUid);
  db.ref('dm_typing/' + dmId + '/' + currentUser.uid).set(true);
  clearTimeout(_dmTypingTimer);
  _dmTypingTimer = setTimeout(() => db.ref('dm_typing/' + dmId + '/' + currentUser.uid).remove(), 4000);
}

function stopDmTyping() {
  if (!_currentDmUid || !currentUser) return;
  clearTimeout(_dmTypingTimer);
  db.ref('dm_typing/' + getDmId(currentUser.uid, _currentDmUid) + '/' + currentUser.uid).remove();
}

async function deleteDmMessage(key, otherUid) {
  if (!confirm('حذف هذه الرسالة؟')) return;
  const dmId = getDmId(currentUser.uid, otherUid);
  await db.ref('dm_messages/' + dmId + '/' + key).remove();
  document.querySelector(`[data-key="${key}"]`)?.remove();
}

async function sendDM() {
  console.log('[sendDM] called, text:', !!document.getElementById('dmChatInp')?.value.trim(), 'media:', window._pendingDmMedia?.length);
  if (!_currentDmUid || !currentUser) return;
  const inp = document.getElementById('dmChatInp');
  const text = inp?.value.trim();
  if (!text) return;
  inp.value = ''; inp.style.height = '';
  document.getElementById('dmSendBtn')?.classList.remove('active');
  stopDmTyping();
  const dmId = getDmId(currentUser.uid, _currentDmUid);
  const msgBase = { uid: currentUser.uid, name: userProfile.displayName || 'مستخدم', ts: Date.now(), status: 'sent' };
  if (_dmReplyTo) { msgBase.replyTo = { ..._dmReplyTo }; clearDmReply(); }
  msgBase.text = text;
  const msgRef = db.ref('dm_messages/' + dmId).push();
  await msgRef.set(msgBase);
  const dmMeta = { name: userProfile.displayName || 'مستخدم', ts: Date.now(), lastMsg: text };
  await db.ref('dms/' + currentUser.uid + '/' + _currentDmUid).update(dmMeta);
  await db.ref('dms/' + _currentDmUid + '/' + currentUser.uid).update({ name: userProfile.displayName || 'مستخدم', ts: Date.now(), lastMsg: text });
  const media = window._pendingDmMedia || [];
  window._pendingDmMedia = [];
  for (const m of media) {
    const dmId2 = getDmId(currentUser.uid, _currentDmUid);
    const dmMsgPath = 'dm_messages/' + dmId2;
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const msgRef = db.ref(dmMsgPath).push();
    const msgKey = msgRef.key;
    await msgRef.set({
      uid: currentUser.uid, name: userProfile.displayName||'مستخدم', ts: Date.now(),
      text: '', mediaType: m.type, mediaName: m.name,
      uploading: true, uploadProgress: 1, expiresAt, saved: false, status: 'sent'
    });
    try {
      const url = await uploadToCloudinary(new File([m.blob], m.name, { type: m.mimeType }), 3, () => {});
      await db.ref(dmMsgPath + '/' + msgKey).update({ mediaUrl: url, uploading: false, uploadProgress: null });
      try { await sendPushToUser(_currentDmUid, userProfile.displayName||'رسالة خاصة', m.type==='video'?'🎥 فيديو':'🖼️ صورة', { type: 'dm', fromUid: currentUser.uid }); } catch(e) {}
    } catch(e) {
      db.ref(dmMsgPath + '/' + msgKey).update({ uploading: false, uploadFailed: true });
      toast('❌ فشل رفع الملف');
    }
  }
  if (typeof sendPushToUser === 'function') {
    sendPushToUser(_currentDmUid, userProfile.displayName || 'رسالة خاصة', text, { type: 'dm', fromUid: currentUser.uid });
  }
}

async function handleDmMediaSelect(input) {
  const files = Array.from(input.files);
  input.value = '';
  if (!files.length) return;
  if (!window._pendingDmMedia) window._pendingDmMedia = [];
  for (const file of files) {
    const isVideo = file.type.startsWith('video');
    const maxSize = isVideo ? 500*1024*1024 : 50*1024*1024;
    if (file.size > maxSize) { toast(`❌ الملف أكبر من ${isVideo?'500MB':'50MB'}`); continue; }
    try {
      const arrayBuffer = await file.arrayBuffer();
      let blob = new Blob([arrayBuffer], { type: file.type });
      if (!isVideo && typeof compressImage === 'function') blob = await compressImage(blob);
      const mimeType = blob.type || file.type;
      const localUrl = URL.createObjectURL(blob);
      window._pendingDmMedia.push({ blob, type: isVideo?'video':'image', name: file.name, mimeType, localUrl });
      document.getElementById('dmSendBtn').classList.add('active');
    } catch(e) { toast('❌ تعذّر قراءة الملف'); }
  }
  console.log('[DM Media] files count:', files.length, 'pending after:', window._pendingDmMedia?.length);
}

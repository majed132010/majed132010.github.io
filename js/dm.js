// ════ DIRECT MESSAGES ════
let _currentDmUid = null;
let _dmListener = null;
let _dmTypingTimer = null;
let _dmTypingListener = null;
let _dmReplyTo = null;
const _dmUnread = {};
const _dmGlobalListeners = {};
let _lastServerId = null; // آخر سيرفر نشط قبل الدخول لشاشة DM

function getDmId(uid1, uid2) { return [uid1, uid2].sort().join('_'); }

// ════ فتح شاشة الرسائل الخاصة ════
function openDMScreen() {
  closeSidebar();
  // نظّف مستمع المحادثة المفتوحة — يمنع استقبال إشعارات بعد مغادرة شاشة DM
  if (_dmListener) {
    const _r = _dmListener.mainRef || null;
    if (_r) _r.off('child_added', _dmListener.fn);
    else db.ref(_dmListener.path).off('child_added', _dmListener.fn);
    if (_dmListener.changeFn) db.ref(_dmListener.path).off('child_changed', _dmListener.changeFn);
    _dmListener = null;
  }
  if (currentServer) _lastServerId = currentServer; // احفظ قبل التصفير لعرض أعضاء السيرفر الصحيح
  currentServer = null; currentChannel = null; _currentDmUid = null;
  document.getElementById('mhIcon').textContent = '💬';
  document.getElementById('mhName').textContent = 'الرسائل الخاصة';
  document.getElementById('searchToggleBtn').style.display = 'none';
  document.getElementById('membersToggleBtn').style.display = 'none';
  // إزالة أزرار المكالمة عند العودة للقائمة
  const oldBtns = document.getElementById('dmCallBtns');
  if (oldBtns) oldBtns.remove();
  renderServerList();
  showView('dm');
  document.getElementById('dmPickerScreen').style.display = 'flex';
  document.getElementById('dmChatArea').style.display = 'none';
  renderDmPickerList();
}

function openDMFromSvBar() {
  if (isMobile()) openDrawer();
  else openDMScreen();
}

// ════ شاشة الأعضاء — Grid أعضاء السيرفر الحالي فقط ════
function renderDmPickerList() {
  const container = document.getElementById('dmPickerList');
  if (!container || !currentUser) return;

  // استخدم السيرفر النشط — أو آخر سيرفر قبل فتح شاشة DM (يمنع ظهور أعضاء سيرفرات أخرى)
  const activeServer = currentServer || _lastServerId;
  const svMembers = {};
  if (activeServer && servers[activeServer]?.members) {
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

  // جلب بروفايلات حديثة من users لضمان اسم وصورة محدّثة
  // يدمج بيانات العضو (الاحتياطية) مع بيانات المستخدم الحية
  Promise.all(
    memberUids.map(uid =>
      db.ref('users/' + uid).once('value').then(s => {
        const live = s.val() || {};
        const member = svMembers[uid] || {};
        return {
          uid,
          name:   live.displayName || member.name || 'عضو',
          avatar: live.avatar      || member.avatar || null
        };
      })
    )
  ).then(list => {
    container.innerHTML = '';
    const grid = document.createElement('div');
    grid.id = 'dmPickerGrid';
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px;padding:8px 4px 16px';

    list.forEach(({ uid, name, avatar }) => {
      const unread = _dmUnread[uid] || 0;

      const card = document.createElement('div');
      card.dataset.dmUid = uid;
      card.style.cssText = [
        'position:relative;display:flex;flex-direction:column;align-items:center;gap:10px',
        'padding:18px 10px 14px',
        'border-radius:18px',
        'background:rgba(0,0,0,0.03)',
        'border:1.5px solid rgba(0,0,0,0.07)',
        'cursor:pointer',
        'transition:transform 0.15s ease,box-shadow 0.15s ease,background 0.15s ease,border-color 0.15s ease',
        '-webkit-tap-highlight-color:transparent',
        'user-select:none'
      ].join(';');

      // ── Avatar wrapper (overflow:visible للـ badge) ──
      const av = document.createElement('div');
      av.className = 'dm-av';
      av.style.cssText = 'position:relative;width:72px;height:72px;flex-shrink:0';

      const avInner = document.createElement('div');
      avInner.style.cssText = 'width:72px;height:72px;border-radius:50%;overflow:hidden;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,0.18)';
      if (avatar) {
        avInner.innerHTML = `<img src="${escHtml(avatar)}" style="width:100%;height:100%;object-fit:cover;display:block">`;
      } else {
        avInner.textContent = (name[0] || '?').toUpperCase();
      }
      av.appendChild(avInner);

      if (unread > 0) {
        const badge = document.createElement('div');
        badge.className = 'dm-picker-badge';
        badge.style.cssText = 'position:absolute;top:-3px;right:-3px;background:#ed4245;color:#fff;border-radius:50%;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;font-family:Tajawal,sans-serif;padding:0 4px;border:2px solid #fff;z-index:2';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        av.appendChild(badge);
      }

      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:13px;font-weight:700;color:var(--text);text-align:center;font-family:Tajawal,sans-serif;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;max-width:100%';
      nameEl.textContent = name;

      card.appendChild(av);
      card.appendChild(nameEl);

      card.addEventListener('mouseenter', () => { card.style.background='rgba(26,95,95,0.07)'; card.style.borderColor='var(--acc)'; card.style.transform='translateY(-3px)'; card.style.boxShadow='0 8px 22px rgba(0,0,0,0.12)'; });
      card.addEventListener('mouseleave', () => { card.style.background='rgba(0,0,0,0.03)'; card.style.borderColor='rgba(0,0,0,0.07)'; card.style.transform=''; card.style.boxShadow=''; });
      card.addEventListener('touchstart', () => { card.style.background='rgba(26,95,95,0.1)'; card.style.transform='scale(0.96)'; }, {passive:true});
      card.addEventListener('touchend',   () => { card.style.background='rgba(0,0,0,0.03)'; card.style.transform=''; }, {passive:true});
      av.addEventListener('click', (e) => { e.stopPropagation(); openMemberCard(uid, name, avatar || null); });
      card.addEventListener('click', (e) => { if (e.target.closest('.dm-av')) return; openDM(uid, name); });

      grid.appendChild(card);
    });

    container.appendChild(grid);
  }).catch(() => {
    container.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px;font-family:Tajawal,sans-serif">❌ تعذّر تحميل الأعضاء</div>';
  });
}

// ════ فتح محادثة خاصة ════
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
  const dmId2 = getDmId(currentUser.uid, uid);
  db.ref('dm_messages/' + dmId2).limitToLast(40).once('value').then(snap => {
    const updates = {};
    snap.forEach(ch => {
      const msg = ch.val();
      if (msg && msg.uid === uid && msg.status !== 'read') {
        updates[ch.key + '/status'] = 'read';
      }
    });
    if (Object.keys(updates).length) db.ref('dm_messages/' + dmId2).update(updates);
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
    if (_dmInitialDone) {
      dmArea.scrollTop = dmArea.scrollHeight;
    }
  };

  // child_changed: يستقبل تحديثات تقدم الرفع وإبدال الشريط بالميديا عند الاكتمال
  const changeFn = snap => {
    const msg = snap.val();
    if (!msg) return;
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
  db.ref(path).on('child_changed', changeFn);
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

// ════ بناء رسالة خاصة ════
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
    statusEl.style.cssText = 'font-size:11px;margin-right:4px;display:block;text-align:left;';
    statusEl.textContent = msg.status === 'read' ? '✓✓' : msg.status === 'sent' ? '✓' : '✓';
    statusEl.style.color = msg.status === 'read' ? '#5865f2' : '#8899aa';
    statusEl.style.marginTop = '2px';
    statusEl.style.display = 'inline-block';
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
    { icon: '↩️', label: 'رد',          fn: () => setDmReply(key, msg.name, msg.text) },
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

// ════ إرسال رسالة خاصة ════
async function sendDM() {
  if (!_currentDmUid || !currentUser) return;
  const inp = document.getElementById('dmChatInp');
  const text = inp?.value.trim();
  if (!text && !window._pendingDmMedia?.length) return;
  inp.value=''; inp.style.height='';
  document.getElementById('dmSendBtn').classList.remove('active');
  stopDmTyping();

  const dmId = getDmId(currentUser.uid, _currentDmUid);
  const msgBase = { uid: currentUser.uid, name: userProfile.displayName||'مستخدم', ts: Date.now() };
  if (_dmReplyTo) { msgBase.replyTo={..._dmReplyTo}; clearDmReply(); }

  if (text) {
    await db.ref('dm_messages/' + dmId).push({ ...msgBase, text });
    setTimeout(async () => {
      try {
        const otherName = userProfile.displayName || 'رسالة خاصة';
        await sendPushToUser(_currentDmUid, otherName, text.slice(0, 80), {
          type: 'dm',
          fromUid: currentUser.uid,
          senderName: otherName
        });
      } catch(e) { console.warn('DM notification error:', e); }
    }, 0);
  }

  const media = window._pendingDmMedia || [];
  window._pendingDmMedia = [];
  const dmPreview = document.getElementById('dmMediaPreview');
  if (dmPreview) { dmPreview.innerHTML=''; dmPreview.style.display='none'; }

  for (const m of media) {
    const dmMsgPath = 'dm_messages/' + dmId;
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    // 1. احجز المفتاح أولاً ثم احفظ بيانات الـ preview قبل الكتابة
    const msgRef = db.ref(dmMsgPath).push();
    const msgKey = msgRef.key;
    if (m.type !== 'video') {
      (window._uploadPreviews = window._uploadPreviews || {})[msgKey] = URL.createObjectURL(m.blob);
    }
    (window._uploadBlobs = window._uploadBlobs || {})[msgKey] = {
      blob: m.blob, name: m.name, type: m.type, mimeType: m.mimeType, msgPath: dmMsgPath
    };
    await msgRef.set({
      ...msgBase, text: '', mediaType: m.type, mediaName: m.name,
      uploading: true, uploadProgress: 1, expiresAt, saved: false
    });
    const updatePct = (pct) => db.ref(dmMsgPath + '/' + msgKey).update({ uploadProgress: pct }).catch(() => {});

    try {
      const url = await uploadToCloudinary(
        new File([m.blob], m.name, { type: m.mimeType }), 3, (pct) => updatePct(pct)
      );
      if (m.localUrl) { URL.revokeObjectURL(m.localUrl); m.localUrl = null; }

      // 2. تحديث الرسالة بالرابط النهائي — يطلق child_changed عند الجميع
      await db.ref(dmMsgPath + '/' + msgKey).update({ mediaUrl: url, uploading: false, uploadProgress: null });

      setTimeout(async () => {
        try {
          await sendPushToUser(_currentDmUid, userProfile.displayName || 'رسالة خاصة',
            m.type === 'video' ? '🎥 فيديو' : '🖼️ صورة', { type: 'dm', fromUid: currentUser.uid });
        } catch(e) {}
      }, 0);
    } catch(e) {
      db.ref(dmMsgPath + '/' + msgKey).update({ uploading: false, uploadFailed: true }).catch(() => {});
      toast('❌ فشل رفع الملف: ' + (e.message || ''));
    }
  }

  const otherSnap = await db.ref('users/' + _currentDmUid + '/displayName').once('value');
  const otherName = otherSnap.val() || 'مستخدم';
  await db.ref('dms/' + currentUser.uid + '/' + _currentDmUid).set({ name: otherName, ts: Date.now() });
  await db.ref('dms/' + _currentDmUid + '/' + currentUser.uid).set({ name: userProfile.displayName||'مستخدم', ts: Date.now() });
}

// ════ محادثة جديدة — Grid Cards ════
async function openNewDM() {
  const allMembers = {};
  Object.values(servers).forEach(sv => {
    Object.entries(sv.members||{}).forEach(([uid,m]) => { if (uid!==currentUser?.uid) allMembers[uid]=m; });
  });
  const otherUids = Object.keys(allMembers);
  if (!otherUids.length) { toast('لا يوجد أعضاء آخرون'); return; }
  const usersData = await Promise.all(
    otherUids.map(uid => db.ref('users/'+uid).once('value').then(s=>({uid,data:s.val()||{}})))
  );

  // ── Overlay ──
  const popup = document.createElement('div');
  popup.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)';

  // ── Modal box ──
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:22px;padding:20px 18px 18px;width:100%;max-width:540px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,0.28)';

  // ── Header ──
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-shrink:0';
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:17px;font-weight:900;color:var(--text);font-family:Tajawal,sans-serif';
  titleEl.textContent = '💬 اختر عضواً للمحادثة';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'width:32px;height:32px;border-radius:50%;background:rgba(0,0,0,0.08);border:none;cursor:pointer;font-size:15px;color:#555;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:sans-serif';
  closeBtn.addEventListener('click', () => popup.remove());
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  box.appendChild(header);

  // ── Grid ──
  // auto-fill + minmax(110px,1fr): شاشة 540px → 4 بطاقات، شاشة 320px → 2 بطاقات
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px;overflow-y:auto;padding:2px 4px 4px';

  usersData.forEach(({uid, data}) => {
    const name = data.displayName || allMembers[uid]?.name || 'عضو';

    // ── Card ──
    const card = document.createElement('div');
    card.style.cssText = [
      'display:flex;flex-direction:column;align-items:center;gap:10px',
      'padding:18px 10px 14px',
      'border-radius:18px',
      'background:rgba(0,0,0,0.03)',
      'border:1.5px solid rgba(0,0,0,0.07)',
      'cursor:pointer',
      'transition:transform 0.15s ease,box-shadow 0.15s ease,background 0.15s ease,border-color 0.15s ease',
      '-webkit-tap-highlight-color:transparent',
      'user-select:none'
    ].join(';');

    // ── Avatar ──
    const av = document.createElement('div');
    av.style.cssText = 'width:72px;height:72px;border-radius:50%;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:#fff;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,0.18);flex-shrink:0';
    if (data.avatar) {
      av.innerHTML = `<img src="${escHtml(data.avatar)}" style="width:100%;height:100%;object-fit:cover;display:block">`;
    } else {
      av.textContent = (name[0] || '?').toUpperCase();
    }

    // ── Name ──
    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:13px;font-weight:700;color:var(--text);text-align:center;font-family:Tajawal,sans-serif;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;max-width:100%';
    nameEl.textContent = name;

    card.appendChild(av);
    card.appendChild(nameEl);

    // ── Hover / Active ──
    card.addEventListener('mouseenter', () => {
      card.style.background = 'rgba(26,95,95,0.07)';
      card.style.borderColor = 'var(--acc)';
      card.style.transform = 'translateY(-3px)';
      card.style.boxShadow = '0 8px 22px rgba(0,0,0,0.12)';
    });
    card.addEventListener('mouseleave', () => {
      card.style.background = 'rgba(0,0,0,0.03)';
      card.style.borderColor = 'rgba(0,0,0,0.07)';
      card.style.transform = '';
      card.style.boxShadow = '';
    });
    card.addEventListener('touchstart', () => {
      card.style.background = 'rgba(26,95,95,0.1)';
      card.style.transform = 'scale(0.96)';
    }, {passive:true});
    card.addEventListener('touchend', () => {
      card.style.background = 'rgba(0,0,0,0.03)';
      card.style.transform = '';
    }, {passive:true});

    card.addEventListener('click', () => { popup.remove(); openDM(uid, name); });
    grid.appendChild(card);
  });

  box.appendChild(grid);
  popup.appendChild(box);
  popup.addEventListener('click', e => { if (e.target === popup) popup.remove(); });
  document.body.appendChild(popup);
}

// ════ حذف رسالة خاصة ════
async function deleteDmMessage(key, otherUid) {
  if (!confirm('حذف هذه الرسالة؟')) return;
  const dmId = getDmId(currentUser.uid, otherUid);
  await db.ref('dm_messages/' + dmId + '/' + key).remove();
  document.querySelector(`[data-key="${key}"]`)?.remove();
}

// ════ الرد في الرسائل الخاصة ════
function setDmReply(key, name, text) {
  _dmReplyTo={key,name,text};
  document.getElementById('dmReplyName').textContent=name;
  document.getElementById('dmReplyText').textContent=text||'🖼️';
  document.getElementById('dmReplyBar').style.display='flex';
  document.getElementById('dmChatInp').focus();
}
function clearDmReply() {
  _dmReplyTo=null;
  document.getElementById('dmReplyBar').style.display='none';
}

// ════ مؤشر الكتابة ════
function startDmTyping() {
  if (!_currentDmUid||!currentUser) return;
  const dmId=getDmId(currentUser.uid,_currentDmUid);
  db.ref('dm_typing/'+dmId+'/'+currentUser.uid).set(true);
  clearTimeout(_dmTypingTimer);
  _dmTypingTimer=setTimeout(()=>db.ref('dm_typing/'+dmId+'/'+currentUser.uid).remove(),4000);
}
function stopDmTyping() {
  if (!_currentDmUid||!currentUser) return;
  clearTimeout(_dmTypingTimer);
  db.ref('dm_typing/'+getDmId(currentUser.uid,_currentDmUid)+'/'+currentUser.uid).remove();
}

// ════ Badge وعداد غير المقروء ════
function _refreshPickerBadge(uid) {
  const card = document.querySelector(`#dmPickerGrid [data-dm-uid="${uid}"]`);
  if (!card) return;
  const av = card.querySelector('div[style*="position:relative"]');
  if (!av) return;
  const existing = av.querySelector('.dm-picker-badge');
  if (existing) existing.remove();
  const count = _dmUnread[uid] || 0;
  if (count > 0) {
    const badge = document.createElement('div');
    badge.className = 'dm-picker-badge';
    badge.style.cssText = 'position:absolute;top:-3px;right:-3px;background:#ed4245;color:#fff;border-radius:50%;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;font-family:Tajawal,sans-serif;padding:0 4px;border:2px solid #fff;z-index:2';
    badge.textContent = count > 99 ? '99+' : String(count);
    av.appendChild(badge);
  }
}

function clearDmUnread(uid) {
  _dmUnread[uid]=0;
  updateDmBadge();
  _refreshPickerBadge(uid);
  renderDmList();
}

function updateDmBadge() {
  const total=Object.values(_dmUnread||{}).reduce((a,b)=>a+b,0);
  const svBadge=document.getElementById('dmSvBadge');
  if (svBadge) { svBadge.textContent=total>99?'99+':total; svBadge.style.display=total>0?'block':'none'; }
  const btn=document.getElementById('dmChannelBtn');
  if (btn) {
    let badge=btn.querySelector('.ch-badge');
    if (total>0) { if(!badge){badge=document.createElement('span');badge.className='ch-badge';btn.appendChild(badge);} badge.textContent=total>99?'99+':total; }
    else if (badge) badge.remove();
  }
  const convList=document.getElementById('dmConvList');
  if (convList) renderDmConvList(convList);
}

function renderDmConvList(container) {
  if (!container||!currentUser) return;
  container.innerHTML='';
  const unreadEntries=Object.entries(_dmUnread||{}).filter(([,count])=>count>0);
  if (!unreadEntries.length) return;
  db.ref('dms/'+currentUser.uid).once('value').then(snap=>{
    const dmData=snap.exists()?snap.val():{};
    unreadEntries.forEach(([uid,count])=>{
      const name=dmData[uid]?.name||'مستخدم';
      const row=document.createElement('div');
      row.className='ch-item'; row.style.cssText='padding-right:28px';
      row.innerHTML=`<div style="width:28px;height:28px;border-radius:50%;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">${(name||'?')[0]}</div><span class="ch-item-name" style="font-size:13px">${escHtml(name)}</span><span class="ch-badge">${count>99?'99+':count}</span>`;
      row.addEventListener('click',()=>{closeSidebar();openDM(uid,name);});
      container.appendChild(row);
    });
  });
}

// ════ استماع للرسائل الخاصة الجديدة عالمياً ════
function listenDMs() {
  if (!currentUser) return;
  const dmsRef = db.ref('dms/'+currentUser.uid);
  dmsRef.off('value');
  dmsRef.on('value', snap => {
    renderDmList();
    if (!snap.exists()) return;
    snap.forEach(ch => {
      const uid = ch.key;
      // لا تُعيد تسجيل المستمع إن كان موجوداً — إعادة التسجيل تُعيد initialized=false
      // وتفتح نافذة يمكن خلالها لرسائل جديدة المرور دون إشعار أو بإشعار مزدوج
      if (!_dmGlobalListeners[uid]) _addDmListener(uid);
    });
  });
}

function _addDmListener(uid) {
  // فسخ المستمع القديم صراحةً قبل أي تسجيل جديد — يقطع أي تراكم محتمل في المستمعات
  if (_dmGlobalListeners[uid]) {
    const { q: oldQ, fn: oldFn } = _dmGlobalListeners[uid];
    try { oldQ.off('child_added', oldFn); } catch(e) {}
    delete _dmGlobalListeners[uid];
    // لا return هنا — نكمل لإعادة التسجيل بمستمع جديد نظيف
  }
  const dmId = getDmId(currentUser.uid, uid);
  const path = 'dm_messages/' + dmId;
  const q = db.ref(path).limitToLast(1);
  let initialized = false;
  const fn = msgSnap => {
    // نتجاهل الرسائل الموجودة مسبقاً عند إعداد المستمع
    if (!initialized) return;
    const msg = msgSnap.val();
    if (!msg || msg.uid === currentUser.uid) return;
    if (_currentDmUid === uid) return;
    // showDmNotif تُزيد _dmUnread أولاً — ثم نحدّث بطاقة الـ picker بالرقم الجديد
    showDmNotif(msg, uid);
    _refreshPickerBadge(uid);
  };
  q.on('child_added', fn);
  // once('value') يُطلق بعد كل child_added الأولي → نضمن أن fn للرسائل القادمة فقط
  q.once('value', () => { initialized = true; });
  _dmGlobalListeners[uid] = { q, fn };
}

function renderDmList() {
  const container=document.getElementById('dmList');
  if (!container) return;
  db.ref('dms/'+currentUser.uid).once('value').then(snap=>{
    const dms=snap.val()||{};
    container.innerHTML='';
    if (!Object.keys(dms).length) { container.innerHTML='<div style="font-size:12px;color:var(--muted);padding:8px 14px">لا توجد محادثات بعد</div>'; return; }
    Object.entries(dms).sort((a,b)=>(b[1].ts||0)-(a[1].ts||0)).forEach(([uid,info])=>{
      const item=document.createElement('div');
      item.className='dm-item'+(_currentDmUid===uid?' active':'');
      const unread=_dmUnread[uid]||0;
      item.innerHTML=`<div class="dm-av">${(info.name||'?')[0]}</div><div class="dm-name">${escHtml(info.name||'مستخدم')}</div>${unread>0?`<div class="dm-unread">${unread>99?'99+':unread}</div>`:''}`;
      item.addEventListener('click',()=>openDM(uid,info.name||'مستخدم'));
      container.appendChild(item);
    });
  });
}

// ════ اختيار وسائط في الرسائل الخاصة ════
window._pendingDmMedia=[];
async function handleDmMediaSelect(input) {
  const files=Array.from(input.files);
  input.value='';
  if (!files.length) return;
  if (!window._pendingDmMedia) window._pendingDmMedia=[];
  let preview=document.getElementById('dmMediaPreview');
  if (!preview) {
    preview=document.createElement('div'); preview.id='dmMediaPreview';
    preview.style.cssText='display:flex;gap:6px;padding:6px;flex-wrap:wrap;background:rgba(0,0,0,0.05);border-radius:8px;margin:4px 0';
    const dmInput=document.querySelector('#dmChatArea .chat-input-wrap');
    if (dmInput) dmInput.insertBefore(preview,dmInput.firstChild);
  }
  preview.style.display='flex';

  for (const file of files) {
    const isVideo=file.type.startsWith('video');
    const maxSize=isVideo?500*1024*1024:50*1024*1024;
    const maxLabel=isVideo?'500MB':'50MB';
    if (file.size>maxSize){toast(`❌ الملف أكبر من ${maxLabel}`);continue;}

    const wrap=document.createElement('div'); wrap.style.cssText='position:relative;display:inline-flex;align-items:center;justify-content:center';
    const loadingEl=document.createElement('div');
    loadingEl.style.cssText='width:60px;height:60px;border-radius:6px;background:#23272a;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px';
    loadingEl.textContent='⏳';
    wrap.appendChild(loadingEl);
    preview.appendChild(wrap);

    try {
      const arrayBuffer=await file.arrayBuffer();
      let blob=new Blob([arrayBuffer],{type:file.type||'application/octet-stream'});
      if (!isVideo) blob=await compressImage(blob);
      const mimeType=blob.type||file.type||'application/octet-stream';
      const localUrl=URL.createObjectURL(blob);
      const entry={blob,type:isVideo?'video':'image',name:file.name,mimeType,localUrl};
      window._pendingDmMedia.push(entry);

      loadingEl.remove();
      const thumb=document.createElement(isVideo?'video':'img');
      thumb.src=localUrl;
      thumb.style.cssText='height:60px;max-width:90px;border-radius:6px;object-fit:cover;display:block';
      wrap.appendChild(thumb);

      const rm=document.createElement('button'); rm.textContent='✕';
      rm.style.cssText='position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#c04040;color:#fff;border:none;font-size:9px;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center';
      rm.onclick=()=>{
        if (entry.localUrl){URL.revokeObjectURL(entry.localUrl);entry.localUrl=null;}
        window._pendingDmMedia=window._pendingDmMedia.filter(e=>e!==entry);
        wrap.remove();
        if(!window._pendingDmMedia.length)preview.style.display='none';
      };
      wrap.appendChild(rm);
      document.getElementById('dmSendBtn').classList.add('active');
    } catch(e) {
      wrap.remove();
      if(!window._pendingDmMedia.length)preview.style.display='none';
      toast('❌ تعذّر قراءة الملف: '+(e.message||''));
    }
  }
}

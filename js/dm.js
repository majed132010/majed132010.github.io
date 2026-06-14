// ════ DIRECT MESSAGES ════
let _currentDmUid = null;
let _dmListener = null;
let _dmTypingTimer = null;
let _dmTypingListener = null;
let _dmReplyTo = null;
const _dmUnread = {};
const _dmGlobalListeners = {};

function getDmId(uid1, uid2) { return [uid1, uid2].sort().join('_'); }

// ════ فتح شاشة الرسائل الخاصة ════
function openDMScreen() {
  closeSidebar();
  currentServer = null; currentChannel = null; _currentDmUid = null;
  document.getElementById('chSettingsBtn').style.display = 'none';
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

// ════ قائمة المحادثات ════
function renderDmPickerList() {
  const container = document.getElementById('dmPickerList');
  if (!container) return;
  container.innerHTML = '';
  db.ref('dms/' + currentUser.uid).once('value').then(snap => {
    const dmMap = snap.val() || {};
    if (!Object.keys(dmMap).length) {
      container.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px;font-family:Tajawal,sans-serif">لا توجد محادثات خاصة بعد<br><br><button onclick="openNewDM()" style="background:var(--acc);color:#fff;border:none;border-radius:8px;padding:8px 20px;font-family:Tajawal,sans-serif;cursor:pointer">ابدأ محادثة</button></div>';
      return;
    }
    Object.entries(dmMap).sort((a,b)=>(b[1].ts||0)-(a[1].ts||0)).forEach(([uid,info]) => {
      const name = info.name || 'مستخدم';
      const unread = _dmUnread[uid] || 0;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;margin-bottom:4px;background:rgba(0,0,0,0.04);-webkit-tap-highlight-color:transparent';
      row.innerHTML = `
        <div style="width:40px;height:40px;border-radius:50%;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;flex-shrink:0">${name[0]}</div>
        <div style="flex:1;min-width:0"><div style="font-family:Tajawal,sans-serif;font-weight:700;color:var(--text)">${escHtml(name)}</div></div>
        ${unread>0?`<div style="background:#ed4245;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${unread}</div>`:''}
      `;
      row.addEventListener('click', () => openDM(uid, name));
      container.appendChild(row);
    });
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
  renderDmList();

  const dmArea = document.getElementById('dmMessages');
  dmArea.innerHTML = '';

  if (_dmListener) {
    const _r = _dmListener.mainRef || null;
    if (_r) _r.off('child_added', _dmListener.fn);
    else db.ref(_dmListener.path).off('child_added', _dmListener.fn);
    _dmListener = null;
  }
  if (_dmTypingListener) { db.ref(_dmTypingListener).off('value'); _dmTypingListener = null; }

  const dmId = getDmId(currentUser.uid, uid);
  const path = 'dm_messages/' + dmId;
  let _dmInitialDone = false;

  const fn = snap => {
    const msg = snap.val();
    if (!msg || dmArea.querySelector(`[data-key="${snap.key}"]`)) return;
    dmArea.appendChild(buildDmMsgDiv(msg, snap.key, uid, name));
    if (_dmInitialDone) {
      dmArea.scrollTop = dmArea.scrollHeight;
      if (_currentDmUid !== uid && msg.uid !== currentUser?.uid) {
        _dmUnread[uid] = (_dmUnread[uid] || 0) + 1;
        updateDmBadge();
        renderDmList();
        showDmNotif(msg, uid);
      }
    }
  };

  const dmRef = db.ref(path).limitToLast(40);
  dmRef.on('child_added', fn);
  _dmListener = { path, mainRef: dmRef, fn };

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
  if (msg.replyTo) {
    const quote=document.createElement('div'); quote.className='msg-reply-quote';
    quote.innerHTML=`<div class="rq-name">${escHtml(msg.replyTo.name||'')}</div><div class="rq-text">${escHtml(msg.replyTo.text||'🖼️')}</div>`;
    body.appendChild(quote);
  }
  if (msg.text) { const txt=document.createElement('div'); txt.className='msg-content'; txt.textContent=msg.text; body.appendChild(txt); }
  if (msg.mediaUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-media-wrap';
    if (msg.mediaType === 'video') {
      const vid = document.createElement('video');
      vid.src = msg.mediaUrl; vid.controls = true; vid.preload = 'metadata';
      vid.className = 'msg-media-vid';
      vid.addEventListener('click', e => { e.preventDefault(); openLightbox(msg.mediaUrl,'video',msg.mediaName); });
      wrap.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy'; img.decoding = 'async';
      img.className = 'msg-media-img';
      img.alt = msg.mediaName || '';
      img.addEventListener('click', () => openLightbox(msg.mediaUrl,'image',msg.mediaName));
      loadCachedImage(msg.mediaUrl, msg.expiresAt, msg.saved).then(src => { if (src) img.src = src; });
      wrap.appendChild(img);
    }
    body.appendChild(wrap);
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

  if (media.length) {
    toast('⏱️ ميديا مؤقتة: تختفي تلقائياً بعد 24 ساعة');
  }

  for (const m of media) {
    try {
      let _progressToast = null;
      const onProgress = m.type === 'video' ? (pct) => {
        if (!_progressToast) {
          _progressToast = document.createElement('div');
          _progressToast.className = 'toast show';
          _progressToast.style.cssText = 'min-width:160px;text-align:center';
          document.getElementById('toastContainer')?.appendChild(_progressToast);
        }
        _progressToast.textContent = `⏳ رفع الفيديو… ${pct}%`;
        if (pct >= 100 && _progressToast.parentNode) _progressToast.parentNode.removeChild(_progressToast);
      } : null;
      if (!onProgress) toast('⏳ جاري رفع الوسائط...');
      const url = await uploadToCloudinary(new File([m.blob], m.name, { type: m.mimeType }), 3, onProgress);
      if (_progressToast?.parentNode) _progressToast.parentNode.removeChild(_progressToast);
      if (m.localUrl) { URL.revokeObjectURL(m.localUrl); m.localUrl = null; }
      const expiresAt = Date.now() + 24*60*60*1000;
      await db.ref('dm_messages/' + dmId).push({ ...msgBase, text:'', mediaUrl:url, mediaType:m.type, mediaName:m.name, expiresAt, saved:false });
      toast('✅ تم الإرسال');
      setTimeout(async () => {
        try {
          await sendPushToUser(_currentDmUid, userProfile.displayName||'رسالة خاصة',
            m.type==='video'?'🎥 فيديو':'🖼️ صورة', { type:'dm', fromUid:currentUser.uid });
        } catch(e) {}
      }, 0);
    } catch(e) { toast('❌ فشل رفع الملف: ' + (e.message || '')); }
  }

  const otherSnap = await db.ref('users/' + _currentDmUid + '/displayName').once('value');
  const otherName = otherSnap.val() || 'مستخدم';
  await db.ref('dms/' + currentUser.uid + '/' + _currentDmUid).set({ name: otherName, ts: Date.now() });
  await db.ref('dms/' + _currentDmUid + '/' + currentUser.uid).set({ name: userProfile.displayName||'مستخدم', ts: Date.now() });
}

// ════ محادثة جديدة ════
async function openNewDM() {
  const allMembers = {};
  Object.values(servers).forEach(sv => {
    Object.entries(sv.members||{}).forEach(([uid,m]) => { if (uid!==currentUser?.uid) allMembers[uid]=m; });
  });
  const otherUids = Object.keys(allMembers);
  if (!otherUids.length) { toast('لا يوجد أعضاء آخرون'); return; }
  const usersData = await Promise.all(otherUids.map(uid => db.ref('users/'+uid).once('value').then(s=>({uid,data:s.val()||{}}))));

  const popup = document.createElement('div');
  popup.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px';
  const box = document.createElement('div');
  box.style.cssText='background:#fff;border-radius:16px;padding:20px;min-width:280px;max-width:340px;width:100%;max-height:70vh;display:flex;flex-direction:column;gap:6px';
  const title = document.createElement('div');
  title.style.cssText='font-size:16px;font-weight:800;color:var(--text);margin-bottom:8px;text-align:center';
  title.textContent='💬 اختر عضواً';
  box.appendChild(title);
  const list = document.createElement('div');
  list.style.cssText='overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:4px';
  usersData.forEach(({uid,data}) => {
    const name = data.displayName || allMembers[uid]?.name || 'عضو';
    const btn = document.createElement('div');
    btn.style.cssText='display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;cursor:pointer;-webkit-tap-highlight-color:transparent';
    const av = document.createElement('div');
    av.style.cssText='width:40px;height:40px;border-radius:50%;flex-shrink:0;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff';
    if (data.avatar) av.innerHTML=`<img src="${data.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; else av.textContent=name[0]||'?';
    const info = document.createElement('div');
    info.innerHTML=`<div style="font-size:15px;font-weight:700;color:var(--text)">${escHtml(name)}</div>`;
    btn.appendChild(av); btn.appendChild(info);
    btn.addEventListener('mouseover',()=>btn.style.background='rgba(0,0,0,0.05)');
    btn.addEventListener('mouseout',()=>btn.style.background='');
    btn.addEventListener('click',()=>{popup.remove();openDM(uid,name);});
    list.appendChild(btn);
  });
  box.appendChild(list);
  const cancel = document.createElement('button');
  cancel.textContent='إلغاء';
  cancel.style.cssText='margin-top:10px;width:100%;padding:11px;background:var(--bg2);color:var(--muted);border:none;border-radius:10px;font-family:Tajawal,sans-serif;font-size:14px;cursor:pointer';
  cancel.addEventListener('click',()=>popup.remove());
  box.appendChild(cancel);
  popup.appendChild(box);
  popup.addEventListener('click',e=>{if(e.target===popup)popup.remove();});
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
function clearDmUnread(uid) {
  _dmUnread[uid]=0;
  updateDmBadge();
  renderDmList();
}

function updateDmBadge() {
  const total=Object.values(_dmUnread||{}).reduce((a,b)=>a+b,0);
  const svBadge=document.getElementById('dmSvBadge');
  if (svBadge) { svBadge.textContent=total>9?'9+':total; svBadge.style.display=total>0?'block':'none'; }
  const btn=document.getElementById('dmChannelBtn');
  if (btn) {
    let badge=btn.querySelector('.ch-badge');
    if (total>0) { if(!badge){badge=document.createElement('span');badge.className='ch-badge';btn.appendChild(badge);} badge.textContent=total>9?'9+':total; }
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
      row.innerHTML=`<div style="width:28px;height:28px;border-radius:50%;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">${(name||'?')[0]}</div><span class="ch-item-name" style="font-size:13px">${escHtml(name)}</span><span class="ch-badge">${count>9?'9+':count}</span>`;
      row.addEventListener('click',()=>{closeSidebar();openDM(uid,name);});
      container.appendChild(row);
    });
  });
}

// ════ استماع للرسائل الخاصة الجديدة عالمياً ════
function listenDMs() {
  if (!currentUser) return;
  db.ref('dms/'+currentUser.uid).on('value', snap => {
    renderDmList();
    if (!snap.exists()) return;
    snap.forEach(ch => {
      const uid = ch.key;
      _addDmListener(uid);
    });
  });
  db.ref('notifications/'+currentUser.uid).on('child_added', snap => {
    const notif = snap.val();
    if (!notif) return;
    if (Date.now() - notif.ts > 15000) return;
    if (notif.from === currentUser.uid) return;
    if (notif.data?.type === 'dm' && notif.data?.fromUid) {
      const fromUid = notif.data.fromUid;
      _addDmListener(fromUid);
      if (_currentDmUid !== fromUid) {
        _dmUnread[fromUid] = (_dmUnread[fromUid]||0) + 1;
        updateDmBadge();
        showDmNotif({ name: notif.title || 'رسالة خاصة', text: notif.body || '' }, fromUid);
      }
    }
    db.ref('notifications/'+currentUser.uid+'/'+snap.key).remove();
  });
}

function _addDmListener(uid) {
  if (_dmGlobalListeners[uid]) return;
  const dmId = getDmId(currentUser.uid, uid);
  const path = 'dm_messages/' + dmId;
  db.ref(path).limitToLast(1).once('value').then(lastSnap => {
    let lastKey = null;
    lastSnap.forEach(s => { lastKey = s.key; });
    const q = lastKey
      ? db.ref(path).orderByKey().startAfter(lastKey)
      : db.ref(path).limitToLast(1);
    const fn = msgSnap => {
      const msg = msgSnap.val();
      if (!msg || msg.uid === currentUser.uid) return;
      if (_currentDmUid === uid) return;
      _dmUnread[uid] = (_dmUnread[uid]||0) + 1;
      updateDmBadge();
      showDmNotif(msg, uid);
    };
    q.on('child_added', fn);
    _dmGlobalListeners[uid] = { q, fn };
  });
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

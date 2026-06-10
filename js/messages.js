// ════ MESSAGES ════
const PAGE_SIZE = 20;
let _oldestMsgKey = null;
let _allLoaded = false;
let _currentMsgPath = null;
let _replyTo = null;
let _editingKey = null;
let _typingTimer = null;
let _searchResults = [], _searchIndex = 0;

// ════ عرض الرسائل ════
function showMessages(sid, cid) {
  showView('messages');
  _oldestMsgKey = null; _allLoaded = false;
  _currentMsgPath = 'messages/' + sid + '/' + cid;
  const area = document.getElementById('messagesArea');
  const loadBtn = document.getElementById('loadMoreBtn');
  area.innerHTML = '';
  if (loadBtn) { loadBtn.style.display = 'none'; area.appendChild(loadBtn); }
  cleanupMessagesListener();
  clearUnread(sid, cid);
  listenTyping(sid, cid);

  const fn = snap => {
    const msg = snap.val();
    if (!msg) return;
    if (area.querySelector(`[data-key="${snap.key}"]`)) return;
    const div = buildMsgDiv(msg, snap.key);
    area.appendChild(div);
    const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
    if (distFromBottom < 300) area.scrollTop = area.scrollHeight;
    if (msg.uid !== currentUser?.uid) showInAppNotif(msg, sid, cid);
  };

  db.ref(_currentMsgPath).limitToLast(PAGE_SIZE).once('value').then(snap => {
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
    let query = lastKey
      ? db.ref(_currentMsgPath).orderByKey().startAfter(lastKey)
      : db.ref(_currentMsgPath).limitToLast(1);
    query.on('child_added', fn);
    messagesListener = { path: _currentMsgPath, fn };
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
  const div = document.createElement('div');
  div.className = 'msg-group';
  div.dataset.key = key;
  div.dataset.ts = msg.ts;

  const av = document.createElement('div');
  av.className = 'msg-av';
  av.textContent = (msg.name||'?')[0];

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
    const mediaWrap = document.createElement('div');
    mediaWrap.style.cssText = 'margin-top:4px;display:inline-flex;flex-direction:column;gap:0;align-items:flex-start';
    if (msg.voiceUrl) { const vw = document.createElement('div'); vw.appendChild(buildVoiceMsg(msg.voiceUrl, msg.voiceDuration)); body.appendChild(vw); }
    const now = Date.now();
    const expired = msg.expiresAt && !msg.saved && now > msg.expiresAt;
    if (expired) {
      const expDiv = document.createElement('div');
      expDiv.style.cssText = 'padding:8px 12px;background:rgba(0,0,0,0.1);border-radius:10px;color:var(--muted);font-size:12px';
      expDiv.textContent = '🕐 انتهت صلاحية هذه الصورة';
      mediaWrap.appendChild(expDiv);
    } else if (msg.mediaType === 'video') {
      const vid = document.createElement('video');
      vid.src = msg.mediaUrl; vid.controls = true;
      vid.style.cssText = 'max-width:260px;max-height:200px;border-radius:10px;display:block;cursor:pointer';
      vid.addEventListener('click', e => { e.preventDefault(); openLightbox(msg.mediaUrl,'video',msg.mediaName); });
      mediaWrap.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy'; img.decoding = 'async';
      img.style.cssText = 'max-width:260px;max-height:200px;border-radius:10px;display:block;cursor:pointer;object-fit:cover;background:#eee';
      img.addEventListener('click', () => openLightbox(msg.mediaUrl,'image',msg.mediaName, msg.expiresAt && !msg.saved ? key : null));
      img.addEventListener('load', () => {
        const a = document.getElementById('messagesArea');
        if (!a) return;
        const dist = a.scrollHeight - a.scrollTop - a.clientHeight;
        if (dist < 300) a.scrollTop = a.scrollHeight;
      });
      loadCachedImage(msg.mediaUrl, msg.expiresAt, msg.saved).then(src => {
        if (src) img.src = src;
        else { img.style.opacity='0.3'; img.style.filter='grayscale(1)'; }
      });
      mediaWrap.appendChild(img);
    }
    body.appendChild(mediaWrap);
  }

  if (msg.reactions) renderReactions(msg.reactions, key, body);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const sv = servers[currentServer];
  const isAdminUser = sv?.members?.[currentUser?.uid]?.role === 'owner' || sv?.members?.[currentUser?.uid]?.role === 'admin';

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

// ════ إرسال رسالة ════
async function sendMessage() {
  const inp = document.getElementById('mainChatInp');
  const text = inp ? inp.value.trim() : '';
  const media = window._pendingMedia || [];
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
    toast('⏱️ للتنويه: تختفي الصور ومقاطع الفيديو تلقائياً بعد 24 ساعة للحفاظ على الخصوصية والمساحة.');
  }

  for (const m of media) {
    const area = document.getElementById('messagesArea');
    const localUrl = URL.createObjectURL(m.file);
    const tempKey = 'temp_' + Date.now() + '_' + Math.random();

    // عرض preview فوري
    const tempDiv = document.createElement('div');
    tempDiv.className = 'msg-group';
    tempDiv.dataset.key = tempKey;
    tempDiv.style.opacity = '0.65';
    const tempAv = document.createElement('div');
    tempAv.className = 'msg-av';
    tempAv.textContent = (msgBase.name||'?')[0];
    const tempBody = document.createElement('div');
    tempBody.className = 'msg-body';
    const tempMeta = document.createElement('div');
    tempMeta.className = 'msg-meta';
    tempMeta.innerHTML = `<span class="msg-name">${escHtml(msgBase.name||'')}</span><span class="msg-time">${formatTime(msgBase.ts)}</span>`;
    tempBody.appendChild(tempMeta);
    const tempWrap = document.createElement('div');
    tempWrap.style.cssText = 'margin-top:4px;position:relative;display:inline-block';
    if (m.type === 'video') {
      const vid = document.createElement('video');
      vid.src = localUrl;
      vid.style.cssText = 'max-width:260px;max-height:200px;border-radius:10px;display:block;object-fit:cover';
      tempWrap.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.src = localUrl;
      img.style.cssText = 'max-width:260px;max-height:200px;border-radius:10px;display:block;object-fit:cover';
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

    try {
      let mediaUrl;
      if (m.type === 'video') {
        mediaUrl = await uploadToStorage(m.file, `media/${currentServer}/${currentChannel}/${Date.now()}_${m.name}`);
        await db.ref('messages/' + currentServer + '/' + currentChannel).push({
          ...msgBase, text: '', mediaUrl, mediaType: 'video', mediaName: m.name, saved: true
        });
      } else {
        mediaUrl = await uploadToCloudinary(m.file);
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await db.ref('messages/' + currentServer + '/' + currentChannel).push({
          ...msgBase, text: '', mediaUrl, mediaType: 'image', mediaName: m.name, expiresAt, saved: false
        });
      }
      setTimeout(() => { tempDiv.remove(); if (area) area.scrollTop = area.scrollHeight; }, 1500);
    } catch(e) {
      tempDiv.remove();
      toast('❌ فشل رفع الملف: ' + (e.message || ''));
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
const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉'];

function showReactionPicker(msgKey, anchorEl) {
  const old = document.getElementById('reactionPicker');
  if (old) { old.remove(); return; }
  const picker = document.createElement('div');
  picker.id = 'reactionPicker';
  picker.className = 'reaction-picker';
  REACTION_EMOJIS.forEach(emoji => {
    const span = document.createElement('span');
    span.textContent = emoji;
    span.addEventListener('click', e => { e.stopPropagation(); toggleReaction(msgKey, emoji); picker.remove(); });
    picker.appendChild(span);
  });
  document.body.appendChild(picker);
  const rect = anchorEl.getBoundingClientRect();
  const pw = picker.offsetWidth || 260;
  let left = rect.left - pw / 2 + rect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  picker.style.cssText += `;position:fixed;left:${left}px;top:${rect.top - 52}px`;
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
  if (!reactions) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-reactions';
  Object.entries(reactions).forEach(([emoji, users]) => {
    const uids = Object.keys(users || {});
    if (!uids.length) return;
    const chip = document.createElement('div');
    chip.className = 'reaction-chip' + (uids.includes(currentUser?.uid) ? ' mine' : '');
    chip.innerHTML = `<span>${emoji}</span><span class="rc-count">${uids.length}</span>`;
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
  _typingTimer = setTimeout(() => db.ref(path).remove(), 4000);
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
    const others = Object.entries(users).filter(([uid]) => uid !== currentUser?.uid).map(([,u]) => u.name);
    const el = document.getElementById('typingIndicator');
    if (!el) return;
    if (!others.length) { el.innerHTML = ''; el.style.opacity='0'; return; }
    const names = others.slice(0,3).join(' و ');
    const verb = others.length===1?'يكتب':others.length===2?'يكتبان':'يكتبون';
    el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span style="font-size:12px;color:var(--muted)">${escHtml(names)} ${verb}...</span>`;
    el.style.opacity='1';
  });
}

// ════ تنظيف الـ listener ════
function cleanupMessagesListener() {
  if (messagesListener) { db.ref(messagesListener.path).off('child_added', messagesListener.fn); messagesListener = null; }
  stopTyping();
  if (_typingListener) { db.ref(_typingListener).off('value'); _typingListener = null; }
  const el = document.getElementById('typingIndicator');
  if (el) el.innerHTML = '';
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

// ════ SERVERS & CHANNELS ════
let servers = {};
let currentServer = null;
let currentChannel = null;
let messagesListener = null;
let _typingListener = null;
let _collapsedCategories = JSON.parse(localStorage.getItem('collapsed_cats') || '{}');
const _unreadCounts = {};
let _membershipListener = null;
let _restrictionListener = null;
let _currentUserMuted = false;
const _registeredServers = new Set(); // سيرفرات تم التحقق منها في هذه الجلسة
let _serversListenerRef = null; // نحتفظ بـ ref لنتمكن من فصله عند تسجيل الخروج

// ════ انتظار اكتمال التحميل الأول (يُستخدم بدل setTimeout في معالج الدعوة) ════
function _waitLoaded(maxMs) {
  if (window._loaded) return Promise.resolve();
  return new Promise(resolve => {
    const deadline = Date.now() + (maxMs || 8000);
    (function check() {
      if (window._loaded || Date.now() >= deadline) { resolve(); return; }
      setTimeout(check, 100);
    })();
  });
}

function initApp() {
  listenServers();
  if (currentUser) {
    const presRef = db.ref('presence/' + currentUser.uid);
    presRef.set({ online: true, lastSeen: Date.now(), name: userProfile.displayName || '' });
    presRef.onDisconnect().update({ online: false, lastSeen: Date.now() });
    setInterval(async () => {
      if (currentUser) {
        presRef.update({ lastSeen: Date.now() });
        try { await currentUser.getIdToken(true); } catch(e) {}
      }
    }, 55 * 60 * 1000);
  }
  initVoice();

  // معالجة رابط الانضمام — ننتظر اكتمال listenServers بدل setTimeout ثابت
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    (async () => {
      await _waitLoaded(8000);
      const code = joinCode.toUpperCase();
      const snap = await db.ref('servers').orderByChild('inviteCode').equalTo(code).once('value');
      if (!snap.exists()) { toast('❌ رمز الدعوة غير صالح'); history.replaceState({}, '', location.pathname); return; }
      const sid = Object.keys(snap.val())[0];
      history.replaceState({}, '', location.pathname);
      if (servers[sid]) { selectServer(sid); return; }
      const _joinMemberData = {
        role: 'member',
        name: userProfile.displayName || currentUser.displayName || 'عضو',
        avatar: userProfile.avatar || currentUser.photoURL || null,
        joinedAt: Date.now()
      };
      await db.ref('servers/' + sid + '/members/' + currentUser.uid).set(_joinMemberData);
      await db.ref('users/' + currentUser.uid + '/servers/' + sid).set(true);
      // Build local cache from snapshot + inject our member entry (snapshot predates the write)
      servers[sid] = snap.val()[sid] || {};
      if (!servers[sid].members) servers[sid].members = {};
      servers[sid].members[currentUser.uid] = _joinMemberData;
      renderServerList();
      selectServer(sid);
      toast('✅ انضممت للعالم!');
    })();
  }
}

// ════ استماع للسيرفرات ════
function listenServers() {
  if (!currentUser) return;
  // فصل الـ listener القديم إن وُجد (يمنع تراكم listeners عند إعادة تسجيل الدخول)
  if (_serversListenerRef) { _serversListenerRef.off('value'); _serversListenerRef = null; }
  const ref = db.ref('users/' + currentUser.uid + '/servers');
  _serversListenerRef = ref;
  ref.on('value', snap => {
    const sids = snap.val() || {};
    // نبني خريطة جديدة ونُسندها دفعةً واحدة — يمنع أي لحظة تكون فيها servers = {}
    const newServers = {};
    Promise.all(Object.keys(sids).map(sid =>
      db.ref('servers/' + sid).once('value').then(s => { if (s.val()) newServers[sid] = s.val(); })
    )).then(() => {
      servers = newServers;
      renderServerList();
      if (!window._loaded) {
        window._loaded = true;
        restoreLastServer();
        listenDMs();
      }
    });
  });
}

// ════ عرض قائمة السيرفرات ════
function renderServerList() {
  if (currentChannel) { _refreshSvIcons(); return; }
  renderHomeServers();
  const container = document.getElementById('svItems');
  container.innerHTML = '';
  const seen = new Set();
  Object.entries(servers).forEach(([sid, sv]) => {
    if (seen.has(sid)) return;
    seen.add(sid);
    const div = _makeSvIcon(sid, sv);
    container.appendChild(div);
  });
  document.getElementById('homeBtn').classList.toggle('active', !currentServer);
}

function _refreshSvIcons() {
  const container = document.getElementById('svItems');
  if (!container) return;
  container.innerHTML = '';
  const seen = new Set();
  Object.entries(servers).forEach(([sid, sv]) => {
    if (seen.has(sid)) return;
    seen.add(sid);
    container.appendChild(_makeSvIcon(sid, sv));
  });
  document.getElementById('homeBtn').classList.toggle('active', !currentServer);
}

function _makeSvIcon(sid, sv) {
  const div = document.createElement('div');
  div.className = 'sv-item' + (currentServer === sid ? ' active' : '');
  div.style.cssText = 'cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;position:relative;overflow:hidden';
  if (sv.avatarUrl) div.innerHTML = `<img src="${sv.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
  else div.textContent = sv.emoji || sv.name?.[0] || '?';
  div.title = sv.name || '';
  div.addEventListener('click', e => { e.stopPropagation(); selectServer(sid); });
  div.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showSvCtx(sid, sv, div); });
  let lpTimer;
  div.addEventListener('touchstart', () => { lpTimer = setTimeout(() => showSvCtx(sid, sv, div), 600); }, {passive:true});
  div.addEventListener('touchend', () => clearTimeout(lpTimer), {passive:true});
  div.addEventListener('touchmove', () => clearTimeout(lpTimer), {passive:true});
  return div;
}

// ════ قائمة سياق السيرفر ════
function showSvCtx(sid, sv, anchorEl) {
  const old = document.getElementById('svCtxPopup');
  if (old) old.remove();
  const isOwner = sv.ownerId === currentUser?.uid || sv.members?.[currentUser?.uid]?.role === 'owner';
  const popup = document.createElement('div');
  popup.id = 'svCtxPopup';
  popup.style.cssText = 'position:fixed;z-index:9000;background:linear-gradient(160deg,#122530,#0d1e28);border:1px solid var(--border2);border-radius:12px;padding:6px;min-width:160px;box-shadow:0 8px 30px rgba(0,0,0,0.6);font-family:Tajawal,sans-serif;';
  document.body.appendChild(popup);
  const rect = anchorEl.getBoundingClientRect();
  const pw = popup.offsetWidth || 170;
  let top = rect.top;
  let right = window.innerWidth - rect.left + 6;
  if (top + 150 > window.innerHeight - 10) top = window.innerHeight - 150 - 10;
  if (top < 8) top = 8;
  popup.style.top = top + 'px';
  popup.style.right = right + 'px';
  const label = document.createElement('div');
  label.style.cssText = 'font-size:11px;color:var(--gold);padding:6px 12px 8px;font-weight:800;border-bottom:1px solid rgba(180,150,80,0.2);margin-bottom:4px;white-space:nowrap';
  label.textContent = (sv.emoji||'🌍') + ' ' + (sv.name||'');
  popup.appendChild(label);
  const mkBtn = (icon, text, danger, fn) => {
    const b = document.createElement('button');
    b.style.cssText = `display:block;width:100%;padding:9px 14px;background:transparent;border:none;color:${danger?'#e06060':'var(--text)'};font-family:Tajawal,sans-serif;font-size:14px;font-weight:600;cursor:pointer;text-align:right;border-radius:8px;`;
    b.textContent = icon + ' ' + text;
    b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.07)');
    b.addEventListener('mouseleave', () => b.style.background = 'transparent');
    b.addEventListener('click', e => { e.stopPropagation(); popup.remove(); fn(); });
    return b;
  };
  popup.appendChild(mkBtn('💬', 'فتح', false, () => selectServer(sid)));
  popup.appendChild(mkBtn('⚙️', 'الإعدادات', false, () => { selectServer(sid); openServerSettings(); }));
  if (isOwner) popup.appendChild(mkBtn('🗑️', 'حذف', true, () => { currentServer = sid; confirmDeleteServer(); }));
  else popup.appendChild(mkBtn('🚪', 'مغادرة', true, () => { currentServer = sid; confirmLeaveServer(); }));
  const close = e => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 50);
}

// ════ إنشاء سيرفر ════
async function createServer() {
  const name = document.getElementById('svNameInp').value.trim();
  if (!name) return;
  const inviteCode = Math.random().toString(36).substr(2,8).toUpperCase();
  const sid = 'sv_' + Date.now();
  const sv = {
    name, emoji: '🌍', inviteCode, ownerId: currentUser.uid,
    members: { [currentUser.uid]: { role: 'owner', name: userProfile.displayName || '', avatar: userProfile.avatar || null } },
    channels: {
      ['ch_' + Date.now()]: { name: 'عام', type: 'text', position: 0 },
      ['ch_' + (Date.now()+1)]: { name: 'صوتي عام', type: 'voice', position: 1 }
    }
  };
  await db.ref('servers/' + sid).set(sv);
  await db.ref('users/' + currentUser.uid + '/servers/' + sid).set(true);
  servers[sid] = sv;
  document.getElementById('svNameInp').value = '';
  closeModal('createServerModal');
  renderServerList();
  selectServer(sid);
  toast('✅ تم إنشاء العالم');
}

// ════ الانضمام لسيرفر ════
async function joinServer() {
  let input = document.getElementById('joinCodeInp').value.trim();
  if (!input) return;
  let code = input.includes('?join=') ? input.split('?join=').pop().toUpperCase() : input.toUpperCase();
  const snap = await db.ref('servers').orderByChild('inviteCode').equalTo(code).once('value');
  if (!snap.exists()) { toast('❌ كود خاطئ'); return; }
  const sid = Object.keys(snap.val())[0];
  const isBanned = await checkBanned(sid);
  if (isBanned) { toast('⛔ أنت محظور من هذا العالم'); return; }
  const alreadyMember = await db.ref('servers/' + sid + '/members/' + currentUser.uid).once('value');
  if (alreadyMember.exists() || servers[sid]) {
    toast('⚠️ أنت بالفعل في هذا العالم');
    closeModal('joinServerModal');
    servers[sid] = snap.val()[sid];
    renderServerList(); selectServer(sid); return;
  }
  const memberData = {
    role: 'member',
    name: userProfile.displayName || currentUser.displayName || 'عضو',
    avatar: userProfile.avatar || currentUser.photoURL || null,
    joinedAt: Date.now()
  };
  await db.ref('servers/' + sid + '/members/' + currentUser.uid).set(memberData);
  await db.ref('users/' + currentUser.uid + '/servers/' + sid).set(true);
  // Inject our member entry into the local cache — the snapshot predates the write
  servers[sid] = snap.val()[sid] || {};
  if (!servers[sid].members) servers[sid].members = {};
  servers[sid].members[currentUser.uid] = memberData;
  document.getElementById('joinCodeInp').value = '';
  closeModal('joinServerModal');
  renderServerList(); selectServer(sid);
  toast('✅ انضممت للسيرفر!');
}

// ════ اختيار سيرفر ════
function selectServer(sid) {
  cleanupMessagesListener();
  cleanupVoiceListener();
  currentServer = sid;
  currentChannel = null;
  window.currentServerId = sid;
  window.currentChannelId = null;
  renderServerList();
  renderChannels(sid);
  _listenMembership(sid);
  _listenRestrictions(sid);
  _ensureMemberRegistered(sid);
  if (isMobile() && !window._restoringSession) openDrawer();
  else {
    const sv = servers[sid];
    if (sv && sv.channels) {
      const chs = Object.entries(sv.channels).sort((a,b) => (a[1].position||0) - (b[1].position||0));
      const firstText = chs.find(([,ch]) => ch.type !== 'voice');
      if (firstText) { selectChannel(sid, firstText[0], firstText[1]); return; }
    }
    showView('home');
  }
  document.getElementById('chSettingsBtn').style.display = '';
}

// ════ القائمة الرئيسية ════
function showHome() {
  const sidebar = document.getElementById('channelSidebar');
  const overlay = document.getElementById('drawerOverlay');
  if (sidebar) sidebar.classList.remove('drawer-open');
  if (overlay) overlay.classList.remove('show');
  cleanupMessagesListener();
  cleanupVoiceListener();
  if (_membershipListener) { db.ref(_membershipListener.path).off('value', _membershipListener.fn); _membershipListener = null; }
  if (_restrictionListener) { db.ref(_restrictionListener.path).off('value', _restrictionListener.fn); _restrictionListener = null; }
  _currentUserMuted = false;
  _applyMuteState(false);
  currentServer = null; currentChannel = null;
  window.currentServerId = null; window.currentChannelId = null;
  renderServerList();
  document.getElementById('chServerName').textContent = 'الرئيسية';
  document.getElementById('chSettingsBtn').style.display = 'none';
  document.getElementById('channelList').innerHTML = '';
  document.getElementById('mhName').textContent = 'الرئيسية';
  document.getElementById('mhIcon').textContent = '🏠';
  showView('home');
  renderHomeServers();
}

// ════ عرض السيرفرات في الصفحة الرئيسية ════
function renderHomeServers() {
  const container = document.getElementById('homeServersList');
  const empty = document.getElementById('homeEmpty');
  if (!container) return;
  const svList = Object.entries(servers);
  if (svList.length === 0) {
    container.style.display = 'none';
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';
  container.style.display = 'flex';
  container.innerHTML = '';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:13px;color:var(--gold);font-weight:800;padding:0 4px 4px';
  hdr.textContent = 'عوالمك';
  container.appendChild(hdr);
  svList.forEach(([sid, sv]) => {
    const chs = sv.channels || {};
    const sorted = Object.entries(chs).sort((a,b)=>(a[1].position||0)-(b[1].position||0));
    const isOwner = sv.ownerId === currentUser?.uid || sv.members?.[currentUser?.uid]?.role === 'owner';
    const card = document.createElement('div');
    card.style.cssText = 'background:rgba(26,95,95,0.15);border:1.5px solid rgba(180,150,80,0.25);border-radius:14px;margin-bottom:2px';
    const cardHead = document.createElement('div');
    cardHead.style.cssText = 'padding:14px;display:flex;align-items:center;gap:12px;background:rgba(0,0,0,0.2);border-radius:13px 13px 0 0;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none';
    const avatar = document.createElement('div');
    avatar.style.cssText = 'width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#1a6060,#0d4545);border:2px solid var(--gold);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0';
    avatar.textContent = sv.emoji || '🌍';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    info.innerHTML = `<div style="font-size:17px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(sv.name||'عالم')}</div><div style="font-size:12px;color:var(--muted)">${sorted.length} كوكب</div>`;
    cardHead.appendChild(avatar); cardHead.appendChild(info);
    cardHead.addEventListener('click', () => selectServer(sid));
    const chBody = document.createElement('div');
    chBody.style.cssText = 'padding:8px 10px;display:flex;flex-direction:column;gap:4px';
    sorted.slice(0,5).forEach(([cid, ch]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.04);cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none';
      row.innerHTML = `<span style="font-size:16px;color:var(--muted)">${ch.type==='voice'?'🔊':'#'}</span><span style="font-size:15px;font-weight:600;color:var(--text)">${escHtml(ch.name)}</span>`;
      row.addEventListener('click', e => { e.stopPropagation(); selectChannel(sid, cid, ch); if(isMobile()) closeDrawer(); });
      chBody.appendChild(row);
    });
    const actions = document.createElement('div');
    actions.style.cssText = 'padding:8px 10px 12px;display:flex;gap:8px';
    const makeBtn = (text, bg, border, color, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText = `flex:1;padding:10px;background:${bg};color:${color};border:1px solid ${border};border-radius:9px;font-family:Tajawal,sans-serif;font-size:13px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation`;
      b.textContent = text; b.addEventListener('click', fn);
      return b;
    };
    if (isOwner) actions.appendChild(makeBtn('🗑️ حذف العالم','rgba(192,64,64,0.12)','rgba(192,64,64,0.3)','#e06060',() => confirmDeleteServerById(sid)));
    else actions.appendChild(makeBtn('🚪 مغادرة','rgba(192,64,64,0.08)','rgba(192,64,64,0.25)','#e06060',() => confirmLeaveServerById(sid)));
    card.appendChild(cardHead); card.appendChild(chBody); card.appendChild(actions);
    container.appendChild(card);
  });
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:10px;margin-top:6px;padding-bottom:8px';
  const btnCreate = document.createElement('button');
  btnCreate.type = 'button';
  btnCreate.style.cssText = 'flex:1;padding:13px;background:var(--acc);color:#fff;border:none;border-radius:10px;font-family:Tajawal,sans-serif;font-size:15px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation';
  btnCreate.textContent = 'اصنع عالمك 🌌';
  btnCreate.addEventListener('click', () => openCreateServer());
  const btnJoin = document.createElement('button');
  btnJoin.type = 'button';
  btnJoin.style.cssText = 'flex:1;padding:13px;background:rgba(26,95,95,0.25);color:var(--gold);border:1.5px solid rgba(180,150,80,0.4);border-radius:10px;font-family:Tajawal,sans-serif;font-size:15px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation';
  btnJoin.textContent = '🔗 انضمام';
  btnJoin.addEventListener('click', () => openJoinServer());
  btns.appendChild(btnCreate); btns.appendChild(btnJoin);
  container.appendChild(btns);
}

// ════ عرض القنوات ════
function renderChannels(sid) {
  const sv = servers[sid];
  if (!sv) return;
  const nameEl = document.getElementById('chServerName');
  if (nameEl) {
    if (sv.avatarUrl) nameEl.innerHTML = `<img src="${sv.avatarUrl}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-left:6px"> ${escHtml(sv.name)}`;
    else nameEl.textContent = (sv.emoji||'') + ' ' + sv.name;
  }
  const list = document.getElementById('channelList');
  list.innerHTML = '';
  const chs = sv.channels || {};
  const sorted = Object.entries(chs).sort((a,b)=>(a[1].position||0)-(b[1].position||0));
  const texts = sorted.filter(([,c])=>c.type==='text');
  const voices = sorted.filter(([,c])=>c.type==='voice');

  function makeChItem(cid, ch, icon) {
    const el = document.createElement('div');
    el.className = 'ch-item' + (currentChannel===cid?' active':'');
    el.dataset.cid = cid;
    el.innerHTML = `<span class="ch-item-icon">${icon}</span><span class="ch-item-name">${escHtml(ch.name)}</span>`;
    const unread = _unreadCounts[sid+'/'+cid]||0;
    if (unread>0 && currentChannel!==cid) {
      const badge = document.createElement('div');
      badge.className = 'ch-unread-badge';
      badge.textContent = unread>99?'99+':unread;
      el.appendChild(badge);
    }
    el.addEventListener('click', () => { selectChannel(sid,cid,ch); if(isMobile()) closeDrawer(); });
    return el;
  }

  function makeCategory(labelText, catKey, items, buildFn) {
    if (!items.length) return;
    const collapsed = !!_collapsedCategories[catKey];
    const hdr = document.createElement('div');
    hdr.className = 'ch-category' + (collapsed?' collapsed':'');
    hdr.innerHTML = `<span class="cat-arrow">▼</span><span>${labelText}</span>`;
    hdr.addEventListener('click', () => toggleCategory(catKey));
    list.appendChild(hdr);
    if (!collapsed) items.forEach(([cid,ch]) => list.appendChild(buildFn(cid,ch)));
  }

  makeCategory('القنوات النصية', sid+'_text', texts, (cid,ch) => makeChItem(cid,ch,'#'));
  makeCategory('القنوات الصوتية', sid+'_voice', voices, (cid,ch) => makeChItem(cid,ch,'🔊'));

  // قسم الرسائل الخاصة
  const dmSection = document.createElement('div');
  dmSection.style.cssText = 'margin-top:8px';
  const dmBtn = document.createElement('div');
  dmBtn.className = 'ch-item';
  dmBtn.id = 'dmChannelBtn';
  const dmUnreadTotal = Object.values(_dmUnread||{}).reduce((a,b)=>a+b,0);
  dmBtn.innerHTML = `<span class="ch-item-icon">💬</span><span class="ch-item-name">رسائلي الخاصة</span>${dmUnreadTotal>0?`<span class="ch-badge">${dmUnreadTotal>9?'9+':dmUnreadTotal}</span>`:''}`;
  dmBtn.addEventListener('click', () => { closeSidebar(); openDMScreen(); });
  dmSection.appendChild(dmBtn);
  list.appendChild(dmSection);
  setTimeout(() => updateDmBadge(), 100);
}

// ════ اختيار قناة ════
function selectChannel(sid, cid, ch) {
  localStorage.setItem('awalem_lastServer', sid);
  localStorage.setItem('awalem_lastChannel', cid);
  currentServer = sid; currentChannel = cid;
  window.currentServerId = sid; window.currentChannelId = cid;
  renderChannels(sid);
  closeSidebar();
  const icon = document.getElementById('mhIcon');
  const name = document.getElementById('mhName');
  if (icon) icon.textContent = ch.type === 'voice' ? '🔊' : '#';
  if (name) name.textContent = ch.name;
  if (ch.type === 'voice') showVoiceChannel(sid, cid, ch);
  else showMessages(sid, cid);
}

// ════ إضافة قناة ════
let selectedChType = 'text';
function selectChType(type) {
  selectedChType = type;
  document.getElementById('chTypeText').className = 'ch-type-tab' + (type==='text'?' active':'');
  document.getElementById('chTypeVoice').className = 'ch-type-tab' + (type==='voice'?' active':'');
}
async function addChannel() {
  const name = document.getElementById('chNameInp').value.trim();
  if (!name) return;
  const cid = 'ch_' + Date.now();
  await db.ref('servers/' + currentServer + '/channels/' + cid).set({ name, type: selectedChType, position: 99 });
  if (!servers[currentServer].channels) servers[currentServer].channels = {};
  servers[currentServer].channels[cid] = { name, type: selectedChType, position: 99 };
  document.getElementById('chNameInp').value = '';
  renderChannels(currentServer);
  closeModal('addChannelModal');
  toast('✅ تمت إضافة الكوكب');
}

// ════ إعدادات السيرفر ════
function openServerSettings() {
  if (!currentServer || !servers[currentServer]) return;
  const sv = servers[currentServer];
  const isOwner = sv.ownerId === currentUser?.uid || sv.members?.[currentUser?.uid]?.role === 'owner';
  const isAdmin = isOwner || sv.members?.[currentUser?.uid]?.role === 'admin';
  document.getElementById('svSettingsTitle').textContent = (sv.emoji||'') + ' ' + sv.name;
  document.getElementById('svSettingsAddCh').style.display = isAdmin ? '' : 'none';
  document.getElementById('svSettingsCustomize').style.display = isOwner ? '' : 'none';
  document.getElementById('svSettingsMemberMgmt').style.display = isAdmin ? '' : 'none';
  document.getElementById('svLeaveBtn').style.display = isOwner ? 'none' : '';
  document.getElementById('svDeleteBtn').style.display = isOwner ? '' : 'none';
  openModal('serverSettingsModal');
}

function openInvite() {
  const sv = servers[currentServer];
  if (!sv) return;
  document.getElementById('inviteLink').textContent = location.origin + location.pathname + '?join=' + sv.inviteCode;
  document.getElementById('inviteCodeDisplay').textContent = sv.inviteCode;
  closeModal('serverSettingsModal');
  openModal('inviteModal');
}
function copyInvite() { navigator.clipboard?.writeText(document.getElementById('inviteLink').textContent).then(() => toast('📋 تم نسخ الرابط')); }
function copyCode() { const code = document.getElementById('inviteCodeDisplay').textContent; navigator.clipboard?.writeText(code).then(() => toast('📋 تم نسخ الكود: ' + code)); }

// ════ مغادرة / حذف السيرفر ════
function confirmLeaveServerById(sid) {
  const sv = servers[sid];
  document.getElementById('confirmLeaveText').textContent = `هل أنت متأكد أنك تريد مغادرة عالم "${sv?.name||''}"؟`;
  document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show'));
  window._pendingLeaveSid = sid;
  closeDrawer(); showView('home');
  openModal('confirmLeaveModal');
}
function confirmLeaveServer() { if (currentServer) confirmLeaveServerById(currentServer); }
async function doLeaveServer() {
  const sid = window._pendingLeaveSid || currentServer;
  if (!sid || !currentUser) return;
  window._pendingLeaveSid = null;
  closeModal('confirmLeaveModal');
  try {
    await db.ref('servers/' + sid + '/members/' + currentUser.uid).remove();
    await db.ref('users/' + currentUser.uid + '/servers/' + sid).remove();
    delete servers[sid]; currentServer = null; currentChannel = null;
    renderServerList(); showHome();
    toast('👋 غادرت العالم');
  } catch(e) { toast('❌ فشل في المغادرة: ' + e.message); }
}

function confirmDeleteServerById(sid) {
  const sv = servers[sid];
  document.getElementById('confirmDeleteText').textContent = `سيُحذف عالم "${sv?.name||''}" نهائياً. لا يمكن التراجع.`;
  document.querySelectorAll('.modal-bg.show').forEach(m => m.classList.remove('show'));
  window._pendingDeleteSid = sid;
  closeDrawer(); showView('home');
  openModal('confirmDeleteModal');
}
function confirmDeleteServer() { if (currentServer) confirmDeleteServerById(currentServer); }
async function doDeleteServer() {
  const sid = window._pendingDeleteSid || currentServer;
  if (!sid || !currentUser) return;
  window._pendingDeleteSid = null;
  const sv = servers[sid];
  if (!sv) return;
  const isOwner = sv.ownerId === currentUser.uid || sv.members?.[currentUser.uid]?.role === 'owner';
  if (!isOwner) { toast('❌ فقط المالك يمكنه الحذف'); return; }
  closeModal('confirmDeleteModal');
  try {
    const members = sv.members || {};
    await Promise.all(Object.keys(members).map(uid => db.ref('users/' + uid + '/servers/' + sid).remove()));
    await db.ref('servers/' + sid).remove();
    await db.ref('messages/' + sid).remove();
    await db.ref('voice/' + sid).remove();
    delete servers[sid]; currentServer = null; currentChannel = null;
    renderServerList(); showHome();
    toast('🗑️ تم حذف العالم');
  } catch(e) { toast('❌ فشل في الحذف: ' + e.message); }
}

// ════ إدارة الأعضاء ════
async function openMemberMgmt() {
  closeModal('serverSettingsModal');
  if (!currentServer) return;
  const sv = servers[currentServer];
  const members = sv?.members || {};
  const isOwner = sv?.ownerId === currentUser?.uid || members[currentUser?.uid]?.role === 'owner';
  if (!isOwner && members[currentUser?.uid]?.role !== 'admin') { toast('❌ هذه الصلاحية للمالك والأدمن فقط'); return; }
  const container = document.getElementById('memberMgmtList');
  container.innerHTML = '<div style="text-align:center;color:var(--muted);padding:12px">⏳ جاري التحميل...</div>';
  openModal('memberMgmtModal');
  const usersData = await Promise.all(Object.keys(members).map(uid =>
    db.ref('users/' + uid).once('value').then(s => ({ uid, data: s.val()||{}, role: members[uid]?.role||'member' }))
  ));
  const roleOrder = { owner:0, admin:1, member:2 };
  usersData.sort((a,b) => (roleOrder[a.role]||2)-(roleOrder[b.role]||2));
  container.innerHTML = '';
  usersData.forEach(({ uid, data, role }) => {
    const name = data.displayName || 'عضو';
    const isSelf = uid === currentUser?.uid;
    const isTargetOwner = role === 'owner';
    const row = document.createElement('div');
    row.className = 'member-row';
    const av = document.createElement('div');
    av.style.cssText = 'width:36px;height:36px;border-radius:50%;flex-shrink:0;overflow:hidden;background:linear-gradient(135deg,var(--teal),var(--acc));display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff';
    if (data.avatar) av.innerHTML = `<img src="${data.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    else av.textContent = name[0]||'?';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    const roleLabel = role==='owner'?'👑 مالك':role==='admin'?'🛡️ أدمن':'👤 عضو';
    info.innerHTML = `<div style="font-size:14px;font-weight:700;color:var(--text)">${escHtml(name)}</div><div style="font-size:11px;color:var(--muted)">${roleLabel}</div>`;
    row.appendChild(av); row.appendChild(info);
    if (!isSelf && !isTargetOwner && isOwner) {
      const btns = document.createElement('div');
      btns.className = 'member-action-btns';
      if (role === 'member') { const b = document.createElement('button'); b.className='member-action-btn promote'; b.textContent='⬆️ أدمن'; b.addEventListener('click',()=>changeMemberRole(uid,name,'admin')); btns.appendChild(b); }
      else if (role === 'admin') { const b = document.createElement('button'); b.className='member-action-btn demote'; b.textContent='⬇️ عضو'; b.addEventListener('click',()=>changeMemberRole(uid,name,'member')); btns.appendChild(b); }
      const kickBtn = document.createElement('button'); kickBtn.className='member-action-btn kick'; kickBtn.textContent='🚫 طرد'; kickBtn.addEventListener('click',()=>kickMember(uid,name)); btns.appendChild(kickBtn);
      const banBtn = document.createElement('button'); banBtn.className='member-action-btn kick'; banBtn.style.background='rgba(180,30,30,0.15)'; banBtn.textContent='⛔ حظر'; banBtn.addEventListener('click',()=>banMember(uid,name)); btns.appendChild(banBtn);
      row.appendChild(btns);
    }
    container.appendChild(row);
  });
}

async function changeMemberRole(uid, name, newRole) {
  if (!currentServer || !confirm(`تغيير دور "${name}"؟`)) return;
  await db.ref('servers/' + currentServer + '/members/' + uid + '/role').set(newRole);
  if (servers[currentServer]?.members?.[uid]) servers[currentServer].members[uid].role = newRole;
  toast(`✅ تم تغيير دور ${name}`);
  openMemberMgmt();
}
async function kickMember(uid, name) {
  if (!currentServer || !confirm(`طرد "${name}"؟`)) return;
  await db.ref('servers/' + currentServer + '/members/' + uid).remove();
  await db.ref('users/' + uid + '/servers/' + currentServer).remove();
  await db.ref('servers/' + currentServer + '/restrictions/' + uid).remove();
  if (servers[currentServer]?.members) delete servers[currentServer].members[uid];
  toast(`🚫 تم طرد ${name}`);
  openMemberMgmt();
}
async function banMember(uid, name) {
  if (!currentServer || !confirm(`حظر "${name}"؟`)) return;
  await db.ref('servers/' + currentServer + '/banned/' + uid).set({ name, bannedAt: Date.now(), bannedBy: currentUser.uid });
  await db.ref('servers/' + currentServer + '/members/' + uid).remove();
  await db.ref('users/' + uid + '/servers/' + currentServer).remove();
  if (servers[currentServer]?.members) delete servers[currentServer].members[uid];
  toast(`⛔ تم حظر ${name}`);
  openMemberMgmt();
}
async function checkBanned(sid) {
  const snap = await db.ref('servers/' + sid + '/banned/' + currentUser.uid).once('value');
  return snap.exists();
}

// ════ ضمان تسجيل العضوية الكاملة ════
// يقرأ مباشرة من DB (لا يعتمد على الكاش المحلي الذي قد يكون قديماً)،
// ويكتب السجل كاملاً إن كان غائباً أو ناقصاً، بدون catch صامت.
async function _ensureMemberRegistered(sid) {
  if (!currentUser || !sid) return;
  if (_registeredServers.has(sid)) return; // تم التحقق مسبقاً في هذه الجلسة

  // استخدام auth.currentUser مباشرة كمرجع أساسي للهوية
  const authUser = auth.currentUser;
  if (!authUser) return;

  const displayName = userProfile.displayName
    || authUser.displayName
    || authUser.email?.split('@')[0]
    || 'عضو';
  const avatar = userProfile.avatar || authUser.photoURL || null;

  const memberRef = db.ref('servers/' + sid + '/members/' + currentUser.uid);
  const snap = await memberRef.once('value');
  const entry = snap.val();

  if (!entry) {
    // لا يوجد سجل عضوية — تحقق أن المستخدم مضاف فعلاً لهذا السيرفر
    const svSnap = await db.ref('users/' + currentUser.uid + '/servers/' + sid).once('value');
    if (!svSnap.exists()) return; // ليس عضواً — لا تتدخل
    const newEntry = { role: 'member', name: displayName, avatar, joinedAt: Date.now() };
    await memberRef.set(newEntry); // يرفع استثناءً إن رُفضت الصلاحية
    if (servers[sid]) {
      if (!servers[sid].members) servers[sid].members = {};
      servers[sid].members[currentUser.uid] = newEntry;
    }
    console.log('[MEMBERS] ✓ تم إنشاء سجل العضوية لـ', currentUser.uid, 'في', sid);
  } else if (!entry.name || !entry.avatar) {
    // السجل موجود لكن ناقص — أضف name/avatar دون المساس بالـ role
    const update = { name: displayName, avatar };
    await memberRef.update(update); // يرفع استثناءً إن رُفضت الصلاحية
    if (servers[sid]?.members?.[currentUser.uid]) {
      Object.assign(servers[sid].members[currentUser.uid], update);
    }
    console.log('[MEMBERS] ✓ تم تحديث سجل العضوية لـ', currentUser.uid, 'في', sid);
  }

  _registeredServers.add(sid); // لا تعيد الاستعلام في هذه الجلسة
}

// ════ استماع عضوية السيرفر — كشف الطرد الفوري ════
function _listenMembership(sid) {
  if (_membershipListener) {
    db.ref(_membershipListener.path).off('value', _membershipListener.fn);
    _membershipListener = null;
  }
  if (!sid || !currentUser) return;
  const path = 'servers/' + sid + '/members/' + currentUser.uid;
  let initialized = false;
  const fn = snap => {
    if (!initialized) { initialized = true; return; }
    if (!snap.exists() && currentServer === sid) {
      toast('🚫 تم إزالتك من هذا العالم');
      cleanupMessagesListener();
      cleanupVoiceListener();
      if (_restrictionListener) { db.ref(_restrictionListener.path).off('value', _restrictionListener.fn); _restrictionListener = null; }
      delete servers[sid];
      currentServer = null; currentChannel = null;
      window.currentServerId = null; window.currentChannelId = null;
      _currentUserMuted = false;
      renderServerList();
      showView('home');
    }
  };
  db.ref(path).on('value', fn);
  _membershipListener = { path, fn };
}

// ════ استماع قيود الكتم — تطبيق فوري على المكتوم ════
function _listenRestrictions(sid) {
  if (_restrictionListener) {
    db.ref(_restrictionListener.path).off('value', _restrictionListener.fn);
    _restrictionListener = null;
  }
  if (!sid || !currentUser) return;
  const path = 'servers/' + sid + '/restrictions/' + currentUser.uid;
  const fn = snap => {
    const isMuted = !!(snap.val()?.muted);
    _currentUserMuted = isMuted;
    _applyMuteState(isMuted);
  };
  db.ref(path).on('value', fn);
  _restrictionListener = { path, fn };
}

function _applyMuteState(isMuted) {
  const inp = document.getElementById('mainChatInp');
  const sendBtn = document.getElementById('sendBtn');
  if (inp) {
    inp.disabled = isMuted;
    inp.placeholder = isMuted ? '🔇 أنت مكتوم — لا يمكنك إرسال رسائل' : 'اكتب رسالة...';
  }
  if (sendBtn) sendBtn.disabled = isMuted;
  let bar = document.getElementById('mutedNoticeBar');
  if (isMuted) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mutedNoticeBar';
      bar.textContent = '🔇 أنت مكتوم في هذا العالم — لا يمكنك إرسال رسائل';
      const inputBox = document.querySelector('.chat-input-box');
      if (inputBox && inputBox.parentNode) inputBox.parentNode.insertBefore(bar, inputBox);
    }
    bar.style.display = 'flex';
  } else {
    if (bar) bar.style.display = 'none';
  }
}

// ════ تخصيص السيرفر ════
const SV_EMOJIS = ['🌍','🌎','🌏','🎮','🎯','🏆','⚡','🔥','💎','🎵','🎨','🚀','🌙','🌟','💬','🏰','⚔️','🛡️','🎭','🌊'];
let _svCustomEmoji = '🌍';

function openServerCustomize() {
  closeModal('serverSettingsModal');
  if (!currentServer) return;
  const sv = servers[currentServer];
  const isOwner = sv?.ownerId === currentUser?.uid || sv?.members?.[currentUser?.uid]?.role === 'owner';
  if (!isOwner) { toast('❌ هذه الصلاحية للمالك فقط'); return; }
  _svCustomEmoji = sv.emoji || '🌍';
  document.getElementById('svCustomNameInp').value = sv.name || '';
  const preview = document.getElementById('svAvatarPreview');
  if (sv.avatarUrl) preview.innerHTML = `<img src="${sv.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else preview.textContent = _svCustomEmoji;
  const picker = document.getElementById('svEmojiPicker');
  picker.innerHTML = '';
  SV_EMOJIS.forEach(em => {
    const btn = document.createElement('div');
    btn.textContent = em;
    btn.style.cssText = `font-size:22px;cursor:pointer;padding:4px;border-radius:8px;transition:.15s;border:2px solid ${em===_svCustomEmoji?'var(--gold)':'transparent'}`;
    btn.addEventListener('click', () => {
      _svCustomEmoji = em;
      document.getElementById('svAvatarPreview').textContent = em;
      picker.querySelectorAll('div').forEach(b => b.style.borderColor = 'transparent');
      btn.style.borderColor = 'var(--gold)';
    });
    picker.appendChild(btn);
  });
  openModal('serverCustomizeModal');
}

async function handleSvAvatarUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('❌ الصورة أكبر من 2MB'); return; }
  toast('⏳ جاري تحميل الصورة...');
  try {
    const url = await uploadToStorage(file, `servers/${currentServer}/avatar.jpg`);
    const preview = document.getElementById('svAvatarPreview');
    preview.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    window._svAvatarPending = url;
    toast('✅ الصورة جاهزة — اضغط حفظ');
  } catch(e) { toast('❌ فشل رفع الصورة'); }
  input.value = '';
}

async function saveServerCustomize() {
  if (!currentServer) return;
  const name = document.getElementById('svCustomNameInp').value.trim();
  if (!name) { toast('❌ أدخل اسم العالم'); return; }
  const updates = { name, emoji: _svCustomEmoji };
  if (window._svAvatarPending) { updates.avatarUrl = window._svAvatarPending; window._svAvatarPending = null; }
  await db.ref('servers/' + currentServer).update(updates);
  Object.assign(servers[currentServer], updates);
  closeModal('serverCustomizeModal');
  renderServerList(); renderChannels(currentServer);
  toast('✅ تم تحديث العالم');
}

// ════ التصنيفات ════
function toggleCategory(catKey) {
  _collapsedCategories[catKey] = !_collapsedCategories[catKey];
  localStorage.setItem('collapsed_cats', JSON.stringify(_collapsedCategories));
  renderChannels(currentServer);
}

// ════ عرض الأعضاء ════
function toggleMembersPanel() {
  const panel = document.getElementById('membersPanel');
  if (!panel) return;
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderMembersList();
}

async function renderMembersList() {
  const container = document.getElementById('membersList');
  if (!container || !currentServer) return;
  const members = servers[currentServer]?.members || {};
  container.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:12px;padding:8px">⏳ جاري التحميل...</div>';
  const usersData = await Promise.all(Object.keys(members).map(uid =>
    db.ref('users/' + uid).once('value').then(s => ({ uid, data: s.val()||{}, role: members[uid]?.role||'member' }))
  ));
  container.innerHTML = '';
  const roleOrder = { owner:0, admin:1, member:2 };
  usersData.sort((a,b) => (roleOrder[a.role]||2)-(roleOrder[b.role]||2));
  usersData.forEach(({ uid, data, role }) => {
    const name = data.displayName || members[uid]?.name || 'عضو';
    const item = document.createElement('div');
    item.className = 'member-item';
    const av = document.createElement('div');
    av.className = 'member-av';
    if (data.avatar) { av.innerHTML = `<img src="${data.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; av.style.padding = '0'; }
    else av.textContent = name[0] || '?';
    const nameEl = document.createElement('div');
    nameEl.className = 'member-name'; nameEl.textContent = name;
    item.appendChild(av); item.appendChild(nameEl);
    const roleLabel = role==='owner'?'👑 مالك':role==='admin'?'🛡️ أدمن':'';
    if (roleLabel) { const badge = document.createElement('div'); badge.className='member-role-badge'; badge.textContent=roleLabel; item.appendChild(badge); }
    if (uid !== currentUser?.uid) { item.title = 'رسالة خاصة'; item.addEventListener('click', () => { openDM(uid,name); document.getElementById('membersPanel').classList.remove('open'); }); }
    container.appendChild(item);
  });
}

// ════ Unread ════
function incrementUnread(sid, cid) {
  const key = sid + '/' + cid;
  _unreadCounts[key] = (_unreadCounts[key] || 0) + 1;
  playMsgSound();
  renderChannels(sid);
}

function clearUnread(sid, cid) {
  const key = sid + '/' + cid;
  _unreadCounts[key] = 0;
  document.querySelectorAll('.ch-item').forEach(el => {
    if (el.dataset.cid === cid) { const badge = el.querySelector('.ch-unread-badge'); if (badge) badge.remove(); }
  });
}

// ════ استعادة آخر جلسة ════
function restoreLastServer() {
  window._restoringSession = true;
  const lastSid = localStorage.getItem('awalem_lastServer');
  const lastCid = localStorage.getItem('awalem_lastChannel');
  if (lastSid && servers[lastSid]) {
    currentServer = lastSid;
    renderServerList(); renderChannels(lastSid);
    document.getElementById('chSettingsBtn').style.display = '';
    if (lastCid && servers[lastSid].channels?.[lastCid]) {
      selectChannel(lastSid, lastCid, servers[lastSid].channels[lastCid]);
      if (isMobile()) setTimeout(() => openDrawer(), 100);
    } else {
      const chs = Object.entries(servers[lastSid].channels||{}).sort((a,b)=>(a[1].position||0)-(b[1].position||0));
      const first = chs.find(([,ch])=>ch.type!=='voice');
      if (first) { selectChannel(lastSid, first[0], first[1]); if (isMobile()) setTimeout(() => openDrawer(), 100); }
      else showHome();
    }
  } else {
    const svKeys = Object.keys(servers);
    if (svKeys.length > 0) {
      const sid = svKeys[0]; currentServer = sid;
      renderServerList(); renderChannels(sid);
      document.getElementById('chSettingsBtn').style.display = '';
      const chs = Object.entries(servers[sid].channels||{}).sort((a,b)=>(a[1].position||0)-(b[1].position||0));
      const first = chs.find(([,ch])=>ch.type!=='voice');
      if (first) selectChannel(sid, first[0], first[1]);
      else showHome();
    } else showHome();
  }
  window._restoringSession = false;
}

// ════ تسجيل رسالة صوتية في المحادثات الخاصة (DM) ════
// حالة مستقلة عن تسجيل القنوات (voice.js) حتى لا يتعارضا.
// يدير حالة التسجيل ذاتياً ولا يعتمد على وجود زر معيّن في ملفات الواجهة:
// كل وصول للـ DOM محميّ بـ (?.) فيعمل المنطق حتى لو لم يوجد عنصر الزر.
let _dmMediaRecorder = null, _dmAudioChunks = [], _dmRecordingTimer = null;
let _dmRecordingSeconds = 0, _dmVoiceRecordingBusy = false;

async function toggleDmVoiceRecording() {
  if (_dmVoiceRecordingBusy) return;
  if (!_currentDmUid || !currentUser) { toast('⚠️ افتح محادثة خاصة أولاً'); return; }
  const btn = document.getElementById('dmVoiceRecordBtn');

  // إيقاف التسجيل الجاري وإرساله
  if (_dmMediaRecorder && _dmMediaRecorder.state === 'recording') {
    _dmVoiceRecordingBusy = true;
    clearInterval(_dmRecordingTimer);
    if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤'; btn.disabled = true; }
    _dmMediaRecorder.stop();
    return;
  }

  // بدء تسجيل جديد
  if (!_dmMediaRecorder || _dmMediaRecorder.state === 'inactive') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _dmAudioChunks = []; _dmRecordingSeconds = 0;
      const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus']
        .find(t => MediaRecorder.isTypeSupported(t)) || '';
      _dmMediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      _dmMediaRecorder.ondataavailable = e => { if (e.data.size > 0) _dmAudioChunks.push(e.data); };
      _dmMediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(_dmAudioChunks, { type: mimeType });
        if (btn) btn.disabled = false;
        _dmVoiceRecordingBusy = false; _dmMediaRecorder = null;
        if (blob.size < 1000) { toast('⚠️ التسجيل قصير جداً'); return; }
        await _sendDmVoiceMessage(blob, _dmRecordingSeconds, mimeType);
      };
      _dmMediaRecorder.start();
      if (btn) { btn.classList.add('recording'); btn.textContent = '⏹ 0s'; }
      _dmRecordingTimer = setInterval(() => {
        _dmRecordingSeconds++;
        if (btn) btn.textContent = `⏹ ${_dmRecordingSeconds}s`;
        if (_dmRecordingSeconds >= 60) toggleDmVoiceRecording(); // حد أقصى 60 ثانية
      }, 1000);
      toast('🎤 جاري التسجيل... اضغط مرة أخرى للإرسال');
    } catch (e) {
      _dmVoiceRecordingBusy = false; _dmMediaRecorder = null;
      toast('❌ لا يمكن الوصول للميكروفون');
    }
  }
}

// رفع الرسالة الصوتية للمحادثة الخاصة الحالية وإرسالها (يطابق نمط dm.js)
async function _sendDmVoiceMessage(blob, duration, mimeType) {
  if (!_currentDmUid || !currentUser) return;
  toast('⏳ جاري إرسال الرسالة الصوتية...');
  const ct  = (mimeType || 'audio/webm').split(';')[0];
  const ext = ct === 'audio/mp4' ? 'mp4' : ct === 'audio/ogg' ? 'ogg' : 'webm';
  const dmId = getDmId(currentUser.uid, _currentDmUid);
  try {
    const url = await uploadToCloudinary(new File([blob], `voice.${ext}`, { type: ct }));
    await db.ref('dm_messages/' + dmId).push({
      uid: currentUser.uid,
      name: userProfile.displayName || 'مستخدم',
      ts: Date.now(),
      voiceUrl: url,
      voiceDuration: duration,
      text: ''
    });
    // حدّث فهرس المحادثات للطرفين
    const otherSnap = await db.ref('users/' + _currentDmUid + '/displayName').once('value');
    const otherName = otherSnap.val() || 'مستخدم';
    await db.ref('dms/' + currentUser.uid + '/' + _currentDmUid).set({ name: otherName, ts: Date.now() });
    await db.ref('dms/' + _currentDmUid + '/' + currentUser.uid).set({ name: userProfile.displayName || 'مستخدم', ts: Date.now() });
    // إشعار الطرف الآخر
    setTimeout(async () => {
      try {
        await sendPushToUser(_currentDmUid, userProfile.displayName || 'رسالة خاصة', '🎤 رسالة صوتية',
          { type: 'dm', fromUid: currentUser.uid });
      } catch (e) {}
    }, 0);
    toast('✅ تم إرسال الرسالة الصوتية');
  } catch (e) {
    toast('❌ فشل إرسال الرسالة الصوتية');
  }
}

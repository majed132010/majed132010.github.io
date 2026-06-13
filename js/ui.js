// ════ UI & NAVIGATION ════

// ════ View Management ════
function showView(name) {
  const home  = document.getElementById('homeView');
  const msgs  = document.getElementById('messagesView');
  const voice = document.getElementById('voiceView');
  const dm    = document.getElementById('dmView');
  const searchBtn  = document.getElementById('searchToggleBtn');
  const membersBtn = document.getElementById('membersToggleBtn');
  if (home)  home.style.display  = name==='home'     ? 'flex' : 'none';
  if (msgs)  { msgs.style.display = name==='messages' ? 'flex' : 'none'; msgs.style.flexDirection='column'; msgs.style.overflow='hidden'; }
  if (voice) voice.style.display = name==='voice'    ? 'flex' : 'none';
  if (dm)    dm.style.display    = name==='dm'       ? 'flex' : 'none';
  if (searchBtn)  searchBtn.style.display  = name==='messages' ? '' : 'none';
  if (membersBtn) membersBtn.style.display = name==='messages' ? '' : 'none';
  if (name!=='messages') {
    const bar=document.getElementById('searchBar');
    if (bar?.classList.contains('show')) toggleSearch();
    document.getElementById('membersPanel')?.classList.remove('open');
  }
}

function goBack() {
  if (currentChannel) {
    currentChannel=null;
    if (currentServer) { renderChannels(currentServer); showView('none'); document.getElementById('mhName').textContent=servers[currentServer]?.name||'اختر قناة'; document.getElementById('mhIcon').textContent='#'; }
    else showHome();
  } else if (currentServer) showHome();
  else showHome();
}

// ════ Drawer ════
function toggleDrawer() {
  const sidebar=document.getElementById('channelSidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('drawer-open')) closeDrawer();
  else openDrawer();
}
function openDrawer() {
  document.getElementById('channelSidebar')?.classList.add('drawer-open');
  document.getElementById('drawerOverlay')?.classList.add('show');
}
function closeDrawer() {
  document.getElementById('channelSidebar')?.classList.remove('drawer-open');
  document.getElementById('drawerOverlay')?.classList.remove('show');
  if (currentServer && !currentChannel) {
    const sv=servers[currentServer];
    if (sv?.channels) {
      const chs=Object.entries(sv.channels).sort((a,b)=>(a[1].position||0)-(b[1].position||0));
      const firstText=chs.find(([,ch])=>ch.type!=='voice');
      if (firstText){selectChannel(currentServer,firstText[0],firstText[1]);return;}
    }
  }
  if (!currentServer) {
    const svKeys=Object.keys(servers);
    if (svKeys.length>0) {
      const sid=svKeys[0]; selectServer(sid);
      const sv=servers[sid];
      if (sv?.channels) {
        const chs=Object.entries(sv.channels).sort((a,b)=>(a[1].position||0)-(b[1].position||0));
        const firstText=chs.find(([,ch])=>ch.type!=='voice');
        if (firstText) setTimeout(()=>selectChannel(sid,firstText[0],firstText[1]),100);
      }
    } else showHome();
  }
}
function closeSidebar() {
  document.getElementById('channelSidebar')?.classList.remove('drawer-open');
  document.getElementById('drawerOverlay')?.classList.remove('show');
}

// Swipe gesture
(function initTouchGestures() {
  let touchStartX=0, touchStartY=0;
  const EDGE_THRESHOLD=30, SWIPE_THRESHOLD=50;
  document.addEventListener('touchstart', e => { touchStartX=e.changedTouches[0].clientX; touchStartY=e.changedTouches[0].clientY; }, {passive:true});
  document.addEventListener('touchend', e => {
    if (!isMobile()) return;
    const dx=e.changedTouches[0].clientX-touchStartX;
    const dy=e.changedTouches[0].clientY-touchStartY;
    if (Math.abs(dy)>Math.abs(dx)) return;
    const sidebar=document.getElementById('channelSidebar');
    const isOpen=sidebar?.classList.contains('drawer-open');
    const screenW=window.innerWidth;
    if (!isOpen && dx<-SWIPE_THRESHOLD && touchStartX>screenW-65-EDGE_THRESHOLD) openDrawer();
    if (isOpen && dx>SWIPE_THRESHOLD) closeDrawer();
  }, {passive:true});
})();

// ════ Modals ════
function openModal(id) { document.getElementById(id)?.classList.add('show'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }
function openCreateServer() { openModal('createServerModal'); }
function openJoinServer() { openModal('joinServerModal'); }
function openAddChannel() { closeModal('serverSettingsModal'); openModal('addChannelModal'); }
function openSettings() { updateUserPanel(); openModal('settingsModal'); }

// ════ PWA ════
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); _deferredInstallPrompt=e;
  const btn=document.getElementById('pwaInstallBtn');
  if (btn) btn.style.display='';
});
window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt=null;
  const btn=document.getElementById('pwaInstallBtn');
  if (btn) btn.style.display='none';
  toast('✅ تم تثبيت التطبيق بنجاح!');
});
function installPWA() {
  if (_deferredInstallPrompt) {
    _deferredInstallPrompt.prompt();
    _deferredInstallPrompt.userChoice.then(choice => {
      if (choice.outcome==='accepted') toast('✅ جاري تثبيت التطبيق...');
      _deferredInstallPrompt=null;
    });
  }
}

// ════ Service Workers — مُصلح ════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // سجّل sw.js للكاش والـ PWA
      const swReg = await navigator.serviceWorker.register('/sw.js');
      console.log('✅ SW registered:', swReg.scope);

      // لا تسجّل firebase-messaging-sw.js يدوياً هنا: تسجيله بنفس نطاق sw.js ('/')
      // كان يجعل كل تحميل يستبدل أحدهما بالآخر ويكرر الإشعارات.
      // مكتبة FCM تسجّله تلقائياً بنطاقها الخاص عند getToken (notifications.js).
    } catch(err) {
      console.warn('SW registration error:', err);
    }
  });
}

// ════ No-op stubs (للتوافق) ════
function mobGoto(){}
function mobSetActive(){}
function mobShowServers(){closeDrawer();showHome();}
function mobShowChannels(){if(currentServer)openDrawer();}
function mobShowChat(){closeDrawer();}
function renderMobServers(){}
function mobSelectServer(sid){selectServer(sid);}
function renderMobChannels(){}
function mobOpenChannel(sid,cid,ch){selectChannel(sid,cid,ch);closeDrawer();}
function mobSendMsg(){sendMessage();}
function mobOpenSvSettings(){if(currentServer)openServerSettings();}
function renderMobSvPills(){}
function openBansList(){}

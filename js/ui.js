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

// ════ Drawer — نظام 3 حالات ════
// حالة 0: شاشة كاملة (لا قوائم)
// حالة 1: قائمة السيرفرات فقط
// حالة 2: قائمة السيرفرات + القنوات

let _mobState = 0;

function _setMobState(s) {
  if (!isMobile()) return;
  _mobState = Math.max(0, Math.min(2, s));
  document.body.classList.remove('mob-state-0', 'mob-state-1', 'mob-state-2');
  document.body.classList.add('mob-state-' + _mobState);
}

function openDrawer() {
  if (isMobile()) _setMobState(2);
  else {
    document.getElementById('channelSidebar')?.classList.add('drawer-open');
    document.getElementById('drawerOverlay')?.classList.add('show');
  }
}

function closeDrawer() {
  if (isMobile()) {
    _setMobState(0);
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
  } else {
    document.getElementById('channelSidebar')?.classList.remove('drawer-open');
    document.getElementById('drawerOverlay')?.classList.remove('show');
  }
}

function toggleDrawer() {
  if (isMobile()) _setMobState(_mobState === 2 ? 0 : _mobState + 1);
  else {
    const sidebar=document.getElementById('channelSidebar');
    if (sidebar?.classList.contains('drawer-open')) closeDrawer();
    else openDrawer();
  }
}

function closeSidebar() {
  if (isMobile()) _setMobState(0);
  else {
    document.getElementById('channelSidebar')?.classList.remove('drawer-open');
    document.getElementById('drawerOverlay')?.classList.remove('show');
  }
}

// عند الضغط على overlay → إغلاق
document.getElementById('drawerOverlay')?.addEventListener('click', () => {
  if (isMobile()) _setMobState(Math.max(0, _mobState - 1));
  else closeDrawer();
});

// Swipe gesture — 3 حالات
(function initTouchGestures() {
  let touchStartX=0, touchStartY=0;
  const SWIPE_THRESHOLD=50;
  document.addEventListener('touchstart', e => {
    touchStartX=e.changedTouches[0].clientX;
    touchStartY=e.changedTouches[0].clientY;
  }, {passive:true});
  document.addEventListener('touchend', e => {
    if (!isMobile()) return;
    const dx=e.changedTouches[0].clientX-touchStartX;
    const dy=e.changedTouches[0].clientY-touchStartY;
    if (Math.abs(dy)>Math.abs(dx)*0.8) return; // حركة عمودية — تجاهل
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (dx < 0) {
      // سحب يسار → زيادة الحالة (إظهار المزيد)
      _setMobState(_mobState + 1);
    } else {
      // سحب يمين → تقليل الحالة (إخفاء)
      _setMobState(_mobState - 1);
    }
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

// ════ Service Workers ════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // سجّل sw.js للكاش والـ PWA
      const swReg = await navigator.serviceWorker.register('/sw.js');
      console.log('✅ SW registered:', swReg.scope);

      // سجّل firebase-messaging-sw.js يدوياً وأجبره على التفعيل فوراً
      const fcmReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      console.log('✅ FCM SW registered:', fcmReg.scope);

      // أجبره على تخطي الانتظار إذا كان في حالة waiting
      if (fcmReg.waiting) {
        fcmReg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      fcmReg.addEventListener('updatefound', () => {
        const newWorker = fcmReg.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed') {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        }
      });

      // مرر التسجيل لـ FCM getToken
      window._fcmSwRegistration = fcmReg;
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
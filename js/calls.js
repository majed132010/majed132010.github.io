// ════════════════════════════════════════
// CALLS — Agora RTC (صوت + فيديو)
// ════════════════════════════════════════

let _call = null;
let _callClient = null;
let _localAudioTrack = null;
let _localVideoTrack = null;
let _ringTimer = null;
let _callTimer = null;
let _callSeconds = 0;
let _netStatsInterval = null;
let _callMuted = false;
let _cameraOff = false;
let _currentVideoProfile = 'auto';
let _endGuard = false;
let _responseRef = null;
let _endRef = null;
let _pendingAcceptCallId = null;
let _activeCallClickHandler = null;

// ════════════════════════════════════════
// Firebase — تنظيف مضمون
// ════════════════════════════════════════
function _detachListeners() {
  if (_responseRef) { _responseRef.off('value'); _responseRef = null; }
  if (_endRef) { _endRef.off('value'); _endRef = null; }
}

async function _wipeMyCallNode() {
  if (!currentUser) return;
  try { await db.ref('calls/' + currentUser.uid).remove(); } catch(e) {}
}

function _listenForEnd(callId) {
  if (!currentUser) return;
  if (_endRef) { _endRef.off('value'); _endRef = null; }
  const path = 'calls/' + currentUser.uid + '/end';
  _endRef = db.ref(path);
  _endRef.remove().catch(() => {}).then(() => {
    if (!_endRef) return;
    _endRef.on('value', snap => {
      const v = snap.val();
      if (!v) return;
      if (v.callId && v.callId !== callId) return;
      if (_endRef) { _endRef.off('value'); _endRef = null; }
      endCall('remote');
    });
  });
}

// ════════════════════════════════════════
// بدء مكالمة (المتصل)
// ════════════════════════════════════════
async function startCall(toUid, toName, type = 'audio') {
  if (!currentUser) { toast('❌ يجب تسجيل الدخول أولاً'); return; }
  if (!toUid) { toast('❌ معرّف الطرف الآخر مفقود'); return; }
  if (_call) { toast('⚠️ أنت في مكالمة بالفعل'); return; }

  const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const channelName = callId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
  _call = { callId, type, channelName, fromUid: currentUser.uid, toUid, role: 'caller' };

  await _wipeMyCallNode();

  try {
    await db.ref('calls/' + toUid + '/incoming').set({
      callId, type,
      fromUid: currentUser.uid,
      fromName: userProfile?.displayName || 'مستخدم',
      channelName,
      ts: Date.now()
    });
  } catch(e) {
    toast('❌ فشل إرسال المكالمة');
    _call = null;
    return;
  }

  // Push notification
  try {
    await sendPushToUser(
      toUid,
      userProfile?.displayName || 'عوالم',
      type === 'video' ? '📹 مكالمة فيديو واردة' : '📞 مكالمة صوتية واردة',
      { type: 'call', callType: type, fromUid: currentUser.uid,
        fromName: userProfile?.displayName || 'مستخدم', callId, channelName }
    );
  } catch(e) {}

  showOutgoingCallScreen(toName, type);
  _ringTimer = setTimeout(() => endCall('no_answer'), 45000);

  await db.ref('calls/' + currentUser.uid + '/response').remove().catch(() => {});
  _responseRef = db.ref('calls/' + currentUser.uid + '/response');
  _responseRef.on('value', async snap => {
    const resp = snap.val();
    if (!resp || resp.callId !== callId) return;
    if (_responseRef) { _responseRef.off('value'); _responseRef = null; }
    clearTimeout(_ringTimer);
    if (resp.status === 'accepted') {
      hideCallScreens();
      await joinCallChannel(channelName, type, toName, toUid);
    } else {
      endCall('rejected');
    }
  });
}

// ════════════════════════════════════════
// استقبال مكالمة — يُسجَّل مرة واحدة
// ════════════════════════════════════════
function listenIncomingCalls() {
  if (!currentUser) return;
  db.ref('calls/' + currentUser.uid + '/incoming').on('value', snap => {
    const call = snap.val();
    if (!call) return;
    if (Date.now() - call.ts > 45000) {
      db.ref('calls/' + currentUser.uid + '/incoming').remove();
      return;
    }
    if (_call) return;
    _call = { ...call, toUid: currentUser.uid, role: 'callee' };
    showIncomingCallScreen(call.fromName, call.type, call.callId, call.channelName);
    _listenForEnd(call.callId);
    if (_pendingAcceptCallId === call.callId) {
      _pendingAcceptCallId = null;
      acceptCall();
    }
  });
}

// ════════════════════════════════════════
// قبول / رفض / إنهاء
// ════════════════════════════════════════
async function acceptCall() {
  if (!_call || _call.role !== 'callee') return;
  _stopRingtone();
  setTimeout(_stopRingtone, 200);
  setTimeout(_stopRingtone, 600);
  clearTimeout(_ringTimer);
  _detachListeners();
  const { callId, channelName, type, fromUid, fromName } = _call;
  await Promise.allSettled([
    db.ref('calls/' + fromUid + '/response').set({ callId, status: 'accepted', ts: Date.now() }),
    db.ref('calls/' + currentUser.uid + '/incoming').remove()
  ]);
  hideCallScreens();
  await joinCallChannel(channelName, type, fromName, fromUid);
}

async function rejectCall() {
  if (!_call || _call.role !== 'callee') return;
  _stopRingtone();
  clearTimeout(_ringTimer);
  _detachListeners();
  const { callId, fromUid } = _call;
  _call = null;
  await Promise.allSettled([
    db.ref('calls/' + fromUid + '/response').set({ callId, status: 'rejected', ts: Date.now() }),
    db.ref('calls/' + currentUser.uid + '/incoming').remove()
  ]);
  hideCallScreens();
  toast('📵 رفضت المكالمة');
}

async function endCall(reason = 'ended') {
  if (_endGuard) return;
  _endGuard = true;
  _stopRingtone();
  _stopNetworkStats();
  clearTimeout(_ringTimer);
  clearInterval(_callTimer);
  _callSeconds = 0;
  _currentVideoProfile = 'auto';
  _callMuted = false;
  _cameraOff = false;
  _detachListeners();
  const snap = _call;
  _call = null;
  if (_callClient) {
    try {
      if (_localAudioTrack) { _localAudioTrack.stop(); _localAudioTrack.close(); }
      if (_localVideoTrack) { _localVideoTrack.stop(); _localVideoTrack.close(); }
      _localAudioTrack = null;
      _localVideoTrack = null;
      await _callClient.leave();
    } catch(e) {}
    _callClient = null;
  }
  if (snap && reason !== 'remote') {
    const otherUid = snap.role === 'caller' ? snap.toUid : snap.fromUid;
    try {
      await db.ref('calls/' + otherUid + '/end').set({ callId: snap.callId, ts: Date.now() });
    } catch(e) {}
  }
  await _wipeMyCallNode();
  if (snap?.role === 'caller' && snap?.toUid) {
    db.ref('calls/' + snap.toUid + '/incoming').remove().catch(() => {});
  }
  hideCallScreens();
  _endGuard = false;
  if (reason === 'no_answer') toast('📵 لم يرد');
  else if (reason === 'rejected') toast('📵 رفض المكالمة');
  else if (reason === 'remote') toast('📵 أنهى الطرف الآخر المكالمة');
  else if (reason !== 'silent') toast('📵 انتهت المكالمة');
}

// ════════════════════════════════════════
// الانضمام لقناة Agora
// ════════════════════════════════════════
async function joinCallChannel(channelName, type, otherName, otherUid) {
  showActiveCallScreen(otherName, type);
  try {
    _callClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    AgoraRTC.onAutoplayFailed = () => { toast('🔈 اضغط على الشاشة لتشغيل الصوت'); };
    const activeCallId = _call?.callId;
    if (activeCallId) _listenForEnd(activeCallId);
    _callClient.on('user-published', async (user, mediaType) => {
      try {
        await _callClient.subscribe(user, mediaType);
        if (mediaType === 'audio' && user.audioTrack) user.audioTrack.play();
        if (mediaType === 'video' && user.videoTrack) user.videoTrack.play('remote-video');
      } catch(e) { toast('⚠️ تعذّر تشغيل وسائط الطرف الآخر'); }
    });
    _callClient.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'audio' && user.audioTrack) user.audioTrack.stop();
      if (mediaType === 'video' && user.videoTrack) user.videoTrack.stop();
    });
    _callClient.on('user-left', () => endCall('remote'));
    const uidHash = Math.abs(currentUser.uid.split('').reduce((a, c) => (a << 5) - a + c.charCodeAt(0), 0)) % 999999 + 1;
    const token = await getAgoraToken(channelName, uidHash);
    if (!token) { toast('❌ فشل الحصول على رمز الاتصال'); endCall('silent'); return; }
    await _callClient.join(AGORA_APP_ID, channelName, token, uidHash);
    const tracks = [];
    try {
      _localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({ encoderConfig: 'speech_standard' });
      tracks.push(_localAudioTrack);
      if (type === 'video') {
        try {
          _localVideoTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: { width: { ideal: 1280, min: 640 }, height: { ideal: 720, min: 480 }, frameRate: { ideal: 30, min: 15 }, bitrateMax: 1500 }
          });
          await _localVideoTrack.setEncoderConfiguration({ width: 1280, height: 720, frameRate: 30, bitrateMin: 400, bitrateMax: 1500 });
        } catch(e) {
          _localVideoTrack = await AgoraRTC.createCameraVideoTrack();
          await _localVideoTrack.setEncoderConfiguration({ width: 854, height: 480, frameRate: 30, bitrateMin: 200, bitrateMax: 800 });
        }
        await _localVideoTrack.setOptimizationMode('motion');
        tracks.push(_localVideoTrack);
        _localVideoTrack.play('local-video');
      }
    } catch(mediaErr) {
      _showMediaBlockedHelp(type);
      endCall('silent');
      return;
    }
    await _callClient.publish(tracks);
    _startNetworkStats();
  } catch(e) {
    toast('❌ فشل الاتصال: ' + (e.message || ''));
    endCall('silent');
  }
}

// ════════════════════════════════════════
// شاشات المكالمة
// ════════════════════════════════════════
function showOutgoingCallScreen(name, type) {
  let scr = document.getElementById('outgoingCallScreen');
  if (!scr) {
    scr = document.createElement('div');
    scr.id = 'outgoingCallScreen';
    scr.style.cssText = 'position:fixed;inset:0;z-index:9999;background:linear-gradient(135deg,#0d2535,#1a4a4a);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Tajawal,sans-serif;color:#fff';
    document.body.appendChild(scr);
  }
  scr.innerHTML = `
    <div style="font-size:64px;animation:callPulse 2s infinite">${type === 'video' ? '📹' : '📞'}</div>
    <div style="font-size:22px;font-weight:700">${escHtml(name)}</div>
    <div style="font-size:15px;color:var(--muted)">${type === 'video' ? 'مكالمة فيديو...' : 'مكالمة صوتية...'}</div>
    <button onclick="endCall()" style="margin-top:20px;padding:14px 28px;background:#c04040;border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;font-family:Tajawal,sans-serif">📵 إنهاء المكالمة</button>
  `;
  scr.style.display = 'flex';
}

function showIncomingCallScreen(name, type, callId, channelName) {
  let scr = document.getElementById('incomingCallScreen');
  if (!scr) {
    scr = document.createElement('div');
    scr.id = 'incomingCallScreen';
    scr.style.cssText = 'position:fixed;inset:0;z-index:9999;background:linear-gradient(135deg,#0d2535,#1a4a4a);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Tajawal,sans-serif;color:#fff';
    document.body.appendChild(scr);
  }
  scr.innerHTML = `
    <div style="font-size:64px;animation:callPulse 2s infinite">${type === 'video' ? '📹' : '📞'}</div>
    <div style="font-size:22px;font-weight:700">${escHtml(name)}</div>
    <div style="font-size:15px;color:var(--muted)">${type === 'video' ? 'مكالمة فيديو واردة' : 'مكالمة صوتية واردة'}</div>
    <div style="display:flex;gap:16px;margin-top:10px">
      <button onclick="acceptCall()" style="padding:14px 28px;background:#23a55a;border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;font-family:Tajawal,sans-serif">✅ قبول</button>
      <button onclick="rejectCall()" style="padding:14px 28px;background:#c04040;border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;font-family:Tajawal,sans-serif">❌ رفض</button>
    </div>
  `;
  scr.style.display = 'flex';
  _playRingtone();
  _ringTimer = setTimeout(() => {
    _stopRingtone();
    _detachListeners();
    db.ref('calls/' + currentUser.uid + '/incoming').remove().catch(() => {});
    _call = null;
    hideCallScreens();
    toast('📵 فاتتك مكالمة من ' + escHtml(name));
  }, 45000);
}

function showActiveCallScreen(otherName, type) {
  hideCallScreens();
  _callMuted = false;
  _cameraOff = false;
  _callSeconds = 0;
  let scr = document.getElementById('activeCallScreen');
  if (!scr) {
    scr = document.createElement('div');
    scr.id = 'activeCallScreen';
    document.body.appendChild(scr);
  }
  scr.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0d1e28;display:flex;flex-direction:column;font-family:Tajawal,sans-serif;color:#fff';
  if (type === 'video') {
    scr.innerHTML = `
      <div id="local-video" style="position:absolute;bottom:16px;right:16px;width:28vw;max-width:160px;aspect-ratio:3/4;border-radius:12px;overflow:hidden;background:#1a2e3d;border:2px solid rgba(255,255,255,0.15);z-index:5"></div>
      <div id="remote-video" style="flex:1;background:#0a1520;display:flex;align-items:center;justify-content:center"></div>
      <div style="display:flex;gap:12px;justify-content:center;padding:16px;background:rgba(0,0,0,0.35);backdrop-filter:blur(8px);border-top:1px solid rgba(255,255,255,0.08)">
        <button id="callMuteBtn" onclick="toggleCallMute()" style="width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,0.12);border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center">🎤</button>
        <button id="callCameraBtn" onclick="toggleCallCamera()" style="width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,0.12);border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center">📹</button>
        <button onclick="endCall()" style="width:52px;height:52px;border-radius:50%;background:#c04040;border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center">📵</button>
        <button id="callQualityBtn" onclick="toggleQualityMenu()" style="width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,0.12);border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center">⚙️</button>
      </div>
      <div id="callQualityMenu" style="display:none">
        <div class="call-profile-opt active" id="callProfile_auto" onclick="setVideoProfile('auto')">🎯 تلقائي</div>
        <div class="call-profile-opt" id="callProfile_720p" onclick="setVideoProfile('720p')">🎬 HD 720p</div>
        <div class="call-profile-opt" id="callProfile_480p" onclick="setVideoProfile('480p')">📱 توفير 480p</div>
      </div>
      <div id="callNetStats"><div id="callNetDot"></div><div id="callNetPing">— ms</div></div>
      <div style="position:absolute;bottom:80px;left:50%;transform:translateX(-50%);font-size:14px;font-weight:700;color:rgba(255,255,255,0.7);font-family:Tajawal,sans-serif">${escHtml(otherName)}</div>
      <div id="callTimer" style="position:absolute;bottom:58px;left:50%;transform:translateX(-50%);font-size:13px;color:rgba(255,255,255,0.5);font-variant-numeric:tabular-nums">00:00</div>
    `;
  } else {
    scr.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px">
        <div style="width:96px;height:96px;border-radius:50%;background:linear-gradient(135deg,var(--teal),var(--acc));display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:900;color:#fff">${(otherName || '?')[0]}</div>
        <div style="font-size:20px;font-weight:700">${escHtml(otherName)}</div>
        <div id="callTimer" style="font-size:16px;color:rgba(255,255,255,0.6);font-variant-numeric:tabular-nums">00:00</div>
      </div>
      <div style="display:flex;gap:12px;justify-content:center;padding:16px;background:rgba(0,0,0,0.35);backdrop-filter:blur(8px);border-top:1px solid rgba(255,255,255,0.08)">
        <button id="callMuteBtn" onclick="toggleCallMute()" style="width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,0.12);border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center">🎤</button>
        <button onclick="endCall()" style="width:52px;height:52px;border-radius:50%;background:#c04040;border:none;color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center">📵</button>
      </div>
      <div id="callNetStats"><div id="callNetDot"></div><div id="callNetPing">— ms</div></div>
    `;
  }
  scr.style.display = 'flex';
  _callTimer = setInterval(() => {
    _callSeconds++;
    const m = String(Math.floor(_callSeconds / 60)).padStart(2, '0');
    const s = String(_callSeconds % 60).padStart(2, '0');
    const el = document.getElementById('callTimer');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
  if (_activeCallClickHandler) {
    scr.removeEventListener('click', _activeCallClickHandler);
    _activeCallClickHandler = null;
  }
  _activeCallClickHandler = e => {
    const menu = document.getElementById('callQualityMenu');
    const btn = document.getElementById('callQualityBtn');
    if (menu && menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== btn) {
      menu.style.display = 'none';
    }
  };
  scr.addEventListener('click', _activeCallClickHandler);
}

function hideCallScreens() {
  _stopRingtone();
  ['outgoingCallScreen', 'incomingCallScreen', 'activeCallScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const scr = document.getElementById('activeCallScreen');
  if (scr && _activeCallClickHandler) {
    scr.removeEventListener('click', _activeCallClickHandler);
    _activeCallClickHandler = null;
  }
}

async function toggleCallMute() {
  if (!_localAudioTrack) return;
  _callMuted = !_callMuted;
  await _localAudioTrack.setEnabled(!_callMuted);
  const btn = document.getElementById('callMuteBtn');
  if (btn) { btn.textContent = _callMuted ? '🔇' : '🎤'; btn.classList.toggle('active', _callMuted); }
}

async function toggleCallCamera() {
  if (!_localVideoTrack) return;
  _cameraOff = !_cameraOff;
  await _localVideoTrack.setEnabled(!_cameraOff);
  const btn = document.getElementById('callCameraBtn');
  if (btn) { btn.textContent = _cameraOff ? '📷' : '📹'; btn.classList.toggle('active', _cameraOff); }
  const lv = document.getElementById('local-video');
  if (lv) lv.style.opacity = _cameraOff ? '0.3' : '1';
}

function toggleQualityMenu() {
  const menu = document.getElementById('callQualityMenu');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

async function setVideoProfile(profile) {
  const menu = document.getElementById('callQualityMenu');
  if (menu) menu.style.display = 'none';
  _currentVideoProfile = profile;
  ['auto', '720p', '480p'].forEach(p => {
    const el = document.getElementById('callProfile_' + p);
    if (el) el.classList.toggle('active', p === profile);
  });
  if (!_localVideoTrack) return;
  try {
    if (profile === '720p') {
      await _localVideoTrack.setEncoderConfiguration({ width: 1280, height: 720, frameRate: 30, bitrateMin: 400, bitrateMax: 1500 });
    } else if (profile === '480p') {
      await _localVideoTrack.setEncoderConfiguration({ width: 854, height: 480, frameRate: 30, bitrateMin: 200, bitrateMax: 800 });
    } else {
      await _localVideoTrack.setEncoderConfiguration({ width: { ideal: 1280, min: 640 }, height: { ideal: 720, min: 480 }, frameRate: { ideal: 30, min: 15 }, bitrateMax: 1500 });
    }
    toast('✅ جودة الفيديو: ' + (profile === 'auto' ? 'تلقائي' : profile === '720p' ? 'HD 720p' : 'توفير 480p'));
  } catch(e) {
    toast('❌ فشل تغيير جودة الفيديو');
  }
}

function _startNetworkStats() {
  if (!_callClient) return;
  _callClient.on('network-quality', stats => {
    const dot = document.getElementById('callNetDot');
    if (!dot) return;
    const q = Math.max(stats.uplinkNetworkQuality || 0, stats.downlinkNetworkQuality || 0);
    dot.style.background = q === 0 ? '#888888' : q <= 2 ? '#23a55a' : q <= 4 ? '#f0b429' : '#e04040';
  });
  _netStatsInterval = setInterval(() => {
    if (!_callClient) return;
    try {
      const stats = _callClient.getRTCStats();
      const el = document.getElementById('callNetPing');
      if (el && stats?.RTT != null) el.textContent = Math.round(stats.RTT) + ' ms';
    } catch(e) {}
  }, 2000);
}

function _stopNetworkStats() {
  if (_netStatsInterval) { clearInterval(_netStatsInterval); _netStatsInterval = null; }
  if (_callClient) { try { _callClient.off('network-quality'); } catch(e) {} }
}

function _isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /FBAN|FBAV|FB_IAB|Instagram|Line|Twitter|Snapchat|TikTok|MicroMessenger|GSA\//i.test(ua) || /\bwv\b/.test(ua);
}

function _showMediaBlockedHelp(type) {
  _stopRingtone();
  const inApp = _isInAppBrowser();
  const need = type === 'video' ? 'الكاميرا والميكروفون' : 'الميكروفون';
  let scr = document.getElementById('mediaBlockedScreen');
  if (!scr) { scr = document.createElement('div'); scr.id = 'mediaBlockedScreen'; document.body.appendChild(scr); }
  scr.style.cssText = 'position:fixed;inset:0;z-index:10000;background:linear-gradient(135deg,#0d2535,#1a4a4a);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:Tajawal,sans-serif;color:#fff;padding:28px;text-align:center';
  scr.innerHTML = `
    <div style="font-size:52px">🎤🚫</div>
    <div style="font-size:20px;font-weight:700">تعذّر الوصول إلى ${need}</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.75);max-width:340px;line-height:1.6">
      ${inApp ? 'يبدو أنك فتحت الموقع من متصفّح داخل تطبيق آخر. افتح الرابط في <b>Safari</b> أو <b>Chrome</b> مباشرةً ثم أعد المحاولة.' : 'تأكد من السماح للموقع باستخدام الكاميرا والميكروفون من إعدادات المتصفح، ثم أعد المحاولة.'}
    </div>
    <button id="copyCallLinkBtn" style="margin-top:6px;padding:10px 20px;background:var(--acc);border:none;border-radius:10px;color:#fff;font-family:Tajawal,sans-serif;font-size:14px;font-weight:700;cursor:pointer">📋 نسخ الرابط</button>
    <button id="closeMediaBlockedBtn" style="padding:10px 20px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:10px;color:#fff;font-family:Tajawal,sans-serif;font-size:14px;font-weight:700;cursor:pointer">إغلاق</button>
  `;
  scr.style.display = 'flex';
  document.getElementById('copyCallLinkBtn')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(location.href).then(
      () => toast('📋 تم نسخ الرابط — الصقه في Safari أو Chrome'),
      () => toast('انسخ الرابط يدوياً من شريط العنوان')
    );
  });
  document.getElementById('closeMediaBlockedBtn')?.addEventListener('click', () => scr.remove());
}

let _ringtoneCtx = null;
let _ringtoneInterval = null;
let _ringing = false;
let _ringtoneAudio = null;

function _playRingtone() {
  _stopRingtone();
  _ringing = true;

  // نولّد نغمة رنين بسيطة بدون setInterval
  function _beep() {
    if (!_ringing) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      _ringtoneCtx = ctx;
      [0, 0.5].forEach(offset => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = offset === 0 ? 880 : 660;
        gain.gain.setValueAtTime(0.15, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.4);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.4);
      });
      setTimeout(() => { if (ctx.state !== 'closed') { try { ctx.close(); } catch(e) {} } _ringtoneCtx = null; }, 1200);
    } catch(e) {}
    if (_ringing) _ringtoneInterval = setTimeout(_beep, 1500);
  }
  _beep();
}

function _stopRingtone() {
  _ringing = false;
  if (_ringtoneInterval) { clearTimeout(_ringtoneInterval); _ringtoneInterval = null; }
  if (_ringtoneCtx) {
    if (_ringtoneCtx.state !== 'closed') { try { _ringtoneCtx.close(); } catch(e) {} }
    _ringtoneCtx = null;
  }
}

function acceptCallFromNotification(callId) {
  if (!callId) return;
  if (_call?.callId === callId) { acceptCall(); return; }
  _pendingAcceptCallId = callId;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'acceptCall') acceptCallFromNotification(d.callId);
  });
}

try {
  const _qp = new URLSearchParams(location.search).get('acceptCall');
  if (_qp) {
    acceptCallFromNotification(_qp);
    history.replaceState(null, '', location.pathname + location.hash);
  }
} catch(e) {}

document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes callPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.1)} }
    #activeCallScreen button:hover { opacity:0.85; }
    #activeCallScreen button.active { background:rgba(255,255,255,0.35) !important; }
    #callNetStats { position:absolute; top:14px; left:14px; display:flex; align-items:center; gap:7px; background:rgba(0,0,0,0.45); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); border:1px solid rgba(255,255,255,0.1); border-radius:20px; padding:5px 12px; pointer-events:none; z-index:10; }
    #callNetDot { width:9px; height:9px; border-radius:50%; background:#888; flex-shrink:0; transition:background 0.5s ease; }
    #callNetPing { font-size:11px; font-family:Tajawal,sans-serif; color:rgba(255,255,255,0.82); font-variant-numeric:tabular-nums; min-width:38px; }
    #callQualityMenu { position:absolute; bottom:68px; right:50%; transform:translateX(50%); background:#1a2e3d; border-radius:14px; overflow:hidden; min-width:172px; box-shadow:0 8px 32px rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.1); z-index:200; }
    .call-profile-opt { padding:13px 16px; font-size:14px; font-family:Tajawal,sans-serif; color:rgba(255,255,255,0.82); cursor:pointer; display:flex; align-items:center; gap:9px; border-bottom:1px solid rgba(255,255,255,0.06); transition:background 0.15s; user-select:none; }
    .call-profile-opt:last-child { border-bottom:none; }
    .call-profile-opt:hover { background:rgba(255,255,255,0.1); }
    .call-profile-opt.active { color:#23a55a; font-weight:700; }
  `;
  document.head.appendChild(s);
});

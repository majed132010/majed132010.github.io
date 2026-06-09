// ════ CALLS SYSTEM ════
let _callClient = null;
let _localAudioTrack = null;
let _localVideoTrack = null;
let _callListener = null;
let _callTimeout = null;
let _currentCall = null; // { callId, type, fromUid, toUid, channelName }
let _callTimer = null;
let _callSeconds = 0;

// ════ بدء مكالمة ════
async function startCall(toUid, toName, type = 'audio') {
  if (_currentCall) { toast('⚠️ أنت في مكالمة بالفعل'); return; }

  const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const channelName = callId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);

  _currentCall = { callId, type, fromUid: currentUser.uid, toUid, channelName, role: 'caller' };

  // اكتب المكالمة في Firebase
  await db.ref('calls/' + toUid + '/incoming').set({
    callId,
    type,
    fromUid: currentUser.uid,
    fromName: userProfile.displayName || 'مستخدم',
    channelName,
    ts: Date.now()
  });

  // أرسل إشعار push
  try {
    await sendPushToUser(toUid, userProfile.displayName || 'عوالم',
      type === 'video' ? '📹 مكالمة فيديو واردة' : '📞 مكالمة صوتية واردة',
      { type: 'call', callType: type, fromUid: currentUser.uid, fromName: userProfile.displayName || 'مستخدم', callId, channelName }
    );
  } catch(e) {}

  // عرض شاشة الاتصال الصادر
  showOutgoingCallScreen(toName, type);

  // انتظر الرد 45 ثانية
  _callTimeout = setTimeout(() => {
    endCall('no_answer');
  }, 45000);

  // استمع لرد المتصل به
  db.ref('calls/' + currentUser.uid + '/response').on('value', async snap => {
    const resp = snap.val();
    if (!resp || resp.callId !== callId) return;
    db.ref('calls/' + currentUser.uid + '/response').off('value');
    clearTimeout(_callTimeout);

    if (resp.status === 'accepted') {
      toast('✅ تم قبول المكالمة');
      hideCallScreens();
      await joinCallChannel(channelName, type, toName, toUid);
    } else {
      endCall('rejected');
    }
  });
}

// ════ استقبال مكالمة ════
function listenIncomingCalls() {
  if (!currentUser) return;
  db.ref('calls/' + currentUser.uid + '/incoming').on('value', snap => {
    const call = snap.val();
    if (!call) return;
    if (Date.now() - call.ts > 45000) {
      db.ref('calls/' + currentUser.uid + '/incoming').remove();
      return;
    }
    if (_currentCall) return; // مشغول
    _currentCall = { ...call, toUid: currentUser.uid, role: 'callee' };
    showIncomingCallScreen(call.fromName, call.type, call.fromUid, call.callId, call.channelName);
  });
}

// ════ قبول المكالمة ════
async function acceptCall() {
  if (!_currentCall) return;
  clearTimeout(_callTimeout);
  const { callId, channelName, type, fromUid, fromName } = _currentCall;

  // أرسل الرد
  await db.ref('calls/' + fromUid + '/response').set({
    callId, status: 'accepted', ts: Date.now()
  });

  // احذف المكالمة الواردة
  await db.ref('calls/' + currentUser.uid + '/incoming').remove();

  hideCallScreens();
  await joinCallChannel(channelName, type, fromName, fromUid);
}

// ════ رفض المكالمة ════
async function rejectCall() {
  if (!_currentCall) return;
  clearTimeout(_callTimeout);
  const { callId, fromUid } = _currentCall;

  await db.ref('calls/' + fromUid + '/response').set({
    callId, status: 'rejected', ts: Date.now()
  });
  await db.ref('calls/' + currentUser.uid + '/incoming').remove();

  _currentCall = null;
  hideCallScreens();
  toast('📵 رفضت المكالمة');
}

// ════ إنهاء المكالمة ════
async function endCall(reason = 'ended') {
  clearTimeout(_callTimeout);
  clearInterval(_callTimer);
  _callSeconds = 0;

  if (_callClient) {
    try {
      if (_localAudioTrack) { _localAudioTrack.stop(); _localAudioTrack.close(); _localAudioTrack = null; }
      if (_localVideoTrack) { _localVideoTrack.stop(); _localVideoTrack.close(); _localVideoTrack = null; }
      await _callClient.leave();
    } catch(e) {}
    _callClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  }

  if (_currentCall) {
    const { fromUid, toUid, callId, role } = _currentCall;
    const otherUid = role === 'caller' ? toUid : fromUid;
    try {
      await db.ref('calls/' + otherUid + '/end').set({ callId, ts: Date.now() });
      await db.ref('calls/' + currentUser.uid).remove();
    } catch(e) {}
  }

  _currentCall = null;
  hideCallScreens();

  if (reason === 'no_answer') toast('📵 لم يرد');
  else if (reason === 'rejected') toast('📵 رفض المكالمة');
  else if (reason !== 'silent') toast('📵 انتهت المكالمة');
}

// ════ الانضمام لقناة المكالمة ════
async function joinCallChannel(channelName, type, otherName, otherUid) {
  try {
    _callClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

    // استمع لإنهاء المكالمة من الطرف الآخر
    db.ref('calls/' + currentUser.uid + '/end').on('value', snap => {
      if (!snap.val()) return;
      db.ref('calls/' + currentUser.uid + '/end').off('value');
      db.ref('calls/' + currentUser.uid).remove();
      endCall('silent');
      toast('📵 أنهى ' + otherName + ' المكالمة');
    });

    // أحداث Agora
    _callClient.on('user-published', async (user, mediaType) => {
      await _callClient.subscribe(user, mediaType);
      if (mediaType === 'audio' && user.audioTrack) user.audioTrack.play();
      if (mediaType === 'video' && user.videoTrack) {
        user.videoTrack.play('remote-video');
      }
    });

    _callClient.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'audio' && user.audioTrack) user.audioTrack.stop();
      if (mediaType === 'video' && user.videoTrack) user.videoTrack.stop();
    });

    // احصل على Token
    const uidHash = Math.abs(
      currentUser.uid.split('').reduce((a,c) => (a<<5)-a+c.charCodeAt(0), 0)
    ) % 999999 + 1;

    const token = await getAgoraToken(channelName, uidHash);
    if (!token) { toast('❌ فشل الاتصال'); endCall('silent'); return; }

    await _callClient.join('3a810a3ea5a24451ab56a6b7429c929c', channelName, token, uidHash);

    // أنشئ المسارات
    const tracks = [];
    _localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({ encoderConfig: 'speech_standard' });
    tracks.push(_localAudioTrack);

    if (type === 'video') {
      _localVideoTrack = await AgoraRTC.createCameraVideoTrack({ encoderConfig: '480p' });
      tracks.push(_localVideoTrack);
      _localVideoTrack.play('local-video');
    }

    await _callClient.publish(tracks);

    showActiveCallScreen(otherName, type);

  } catch(e) {
    console.error('Call error:', e);
    toast('❌ فشل الاتصال: ' + (e.message || ''));
    endCall('silent');
  }
}

// ════ كتم الصوت في المكالمة ════
let _callMuted = false;
async function toggleCallMute() {
  if (!_localAudioTrack) return;
  _callMuted = !_callMuted;
  await _localAudioTrack.setEnabled(!_callMuted);
  const btn = document.getElementById('callMuteBtn');
  if (btn) { btn.textContent = _callMuted ? '🔇' : '🎤'; btn.classList.toggle('active', _callMuted); }
}

// ════ تشغيل/إيقاف الكاميرا ════
let _cameraOff = false;
async function toggleCallCamera() {
  if (!_localVideoTrack) return;
  _cameraOff = !_cameraOff;
  await _localVideoTrack.setEnabled(!_cameraOff);
  const btn = document.getElementById('callCameraBtn');
  if (btn) { btn.textContent = _cameraOff ? '📷' : '📹'; btn.classList.toggle('active', _cameraOff); }
  const localVideo = document.getElementById('local-video');
  if (localVideo) localVideo.style.opacity = _cameraOff ? '0.3' : '1';
}

// ════ عرض شاشة الاتصال الصادر ════
function showOutgoingCallScreen(name, type) {
  let screen = document.getElementById('outgoingCallScreen');
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'outgoingCallScreen';
    screen.style.cssText = 'position:fixed;inset:0;z-index:9999;background:linear-gradient(135deg,#0d2535,#1a4a4a);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Tajawal,sans-serif;color:#fff';
    document.body.appendChild(screen);
  }
  screen.innerHTML = `
    <div style="font-size:80px;animation:callPulse 1.5s infinite">${type==='video'?'📹':'📞'}</div>
    <div style="font-size:22px;font-weight:800">${escHtml(name)}</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.7)">${type==='video'?'مكالمة فيديو...':'مكالمة صوتية...'}</div>
    <div style="display:flex;gap:20px;margin-top:20px">
      <button onclick="endCall()" style="width:64px;height:64px;border-radius:50%;background:#e04040;border:none;font-size:28px;cursor:pointer;box-shadow:0 4px 16px rgba(224,64,64,0.5)">📵</button>
    </div>
  `;
  screen.style.display = 'flex';
}

// ════ عرض شاشة المكالمة الواردة ════
function showIncomingCallScreen(name, type, fromUid, callId, channelName) {
  let screen = document.getElementById('incomingCallScreen');
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'incomingCallScreen';
    screen.style.cssText = 'position:fixed;inset:0;z-index:9999;background:linear-gradient(135deg,#0d2535,#1a4a4a);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Tajawal,sans-serif;color:#fff';
    document.body.appendChild(screen);
  }

  // صوت الرنين
  _playRingtone();

  screen.innerHTML = `
    <div style="font-size:80px;animation:callPulse 1.5s infinite">${type==='video'?'📹':'📞'}</div>
    <div style="font-size:22px;font-weight:800">${escHtml(name)}</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.7)">${type==='video'?'مكالمة فيديو واردة':'مكالمة صوتية واردة'}</div>
    <div style="display:flex;gap:30px;margin-top:20px">
      <button onclick="rejectCall()" style="width:64px;height:64px;border-radius:50%;background:#e04040;border:none;font-size:28px;cursor:pointer;box-shadow:0 4px 16px rgba(224,64,64,0.5)">📵</button>
      <button onclick="acceptCall()" style="width:64px;height:64px;border-radius:50%;background:#23a55a;border:none;font-size:28px;cursor:pointer;box-shadow:0 4px 16px rgba(35,165,90,0.5)">📞</button>
    </div>
  `;
  screen.style.display = 'flex';

  // أوقف الرنين بعد 45 ثانية
  _callTimeout = setTimeout(() => {
    _stopRingtone();
    db.ref('calls/' + currentUser.uid + '/incoming').remove();
    _currentCall = null;
    hideCallScreens();
    toast('📵 فاتتك مكالمة من ' + name);
  }, 45000);
}

// ════ عرض شاشة المكالمة النشطة ════
function showActiveCallScreen(otherName, type) {
  hideCallScreens();
  _callMuted = false;
  _cameraOff = false;
  _callSeconds = 0;

  let screen = document.getElementById('activeCallScreen');
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'activeCallScreen';
    document.body.appendChild(screen);
  }

  screen.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0d1e28;display:flex;flex-direction:column;font-family:Tajawal,sans-serif;color:#fff';

  if (type === 'video') {
    screen.innerHTML = `
      <div style="flex:1;position:relative;background:#000">
        <div id="remote-video" style="width:100%;height:100%;object-fit:cover"></div>
        <div id="local-video" style="position:absolute;bottom:16px;right:16px;width:100px;height:140px;border-radius:12px;overflow:hidden;border:2px solid rgba(255,255,255,0.3);background:#111"></div>
        <div style="position:absolute;top:20px;left:50%;transform:translateX(-50%);text-align:center">
          <div style="font-size:16px;font-weight:700">${escHtml(otherName)}</div>
          <div id="callTimer" style="font-size:13px;color:rgba(255,255,255,0.7)">00:00</div>
        </div>
      </div>
      <div style="padding:20px;display:flex;justify-content:center;gap:20px;background:#0d1e28">
        <button id="callMuteBtn" onclick="toggleCallMute()" style="width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;font-size:24px;cursor:pointer;color:#fff">🎤</button>
        <button id="callCameraBtn" onclick="toggleCallCamera()" style="width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;font-size:24px;cursor:pointer;color:#fff">📹</button>
        <button onclick="endCall()" style="width:56px;height:56px;border-radius:50%;background:#e04040;border:none;font-size:24px;cursor:pointer">📵</button>
      </div>
    `;
  } else {
    screen.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
        <div style="width:100px;height:100px;border-radius:50%;background:var(--acc,#1a6060);display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800">${(otherName||'?')[0]}</div>
        <div style="font-size:20px;font-weight:800">${escHtml(otherName)}</div>
        <div id="callTimer" style="font-size:14px;color:rgba(255,255,255,0.6)">00:00</div>
      </div>
      <div style="padding:30px;display:flex;justify-content:center;gap:24px">
        <button id="callMuteBtn" onclick="toggleCallMute()" style="width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;font-size:26px;cursor:pointer;color:#fff">🎤</button>
        <button onclick="endCall()" style="width:60px;height:60px;border-radius:50%;background:#e04040;border:none;font-size:26px;cursor:pointer">📵</button>
      </div>
    `;
  }

  screen.style.display = 'flex';

  // تشغيل المؤقت
  _callTimer = setInterval(() => {
    _callSeconds++;
    const m = String(Math.floor(_callSeconds / 60)).padStart(2, '0');
    const s = String(_callSeconds % 60).padStart(2, '0');
    const el = document.getElementById('callTimer');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
}

// ════ إخفاء شاشات المكالمة ════
function hideCallScreens() {
  _stopRingtone();
  ['outgoingCallScreen','incomingCallScreen','activeCallScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// ════ صوت الرنين ════
let _ringtoneCtx = null, _ringtoneOsc = null;
function _playRingtone() {
  try {
    _stopRingtone();
    _ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    let beat = 0;
    const playBeat = () => {
      if (!_ringtoneCtx) return;
      const osc = _ringtoneCtx.createOscillator();
      const gain = _ringtoneCtx.createGain();
      osc.connect(gain); gain.connect(_ringtoneCtx.destination);
      osc.frequency.value = beat % 2 === 0 ? 880 : 660;
      gain.gain.setValueAtTime(0.15, _ringtoneCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, _ringtoneCtx.currentTime + 0.4);
      osc.start(_ringtoneCtx.currentTime);
      osc.stop(_ringtoneCtx.currentTime + 0.4);
      beat++;
    };
    playBeat();
    _ringtoneOsc = setInterval(playBeat, 800);
  } catch(e) {}
}
function _stopRingtone() {
  if (_ringtoneOsc) { clearInterval(_ringtoneOsc); _ringtoneOsc = null; }
  if (_ringtoneCtx) { try { _ringtoneCtx.close(); } catch(e) {} _ringtoneCtx = null; }
}

// ════ CSS للأنيميشن (معدل ليعمل بعد تحميل الصفحة) ════
const callStyle = document.createElement('style');
callStyle.textContent = `
  @keyframes callPulse {
    0%,100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }
  #activeCallScreen button:hover { opacity: 0.85; }
  #activeCallScreen button.active { background: rgba(255,255,255,0.35) !important; }
`;

document.addEventListener('DOMContentLoaded', () => {
  document.head.appendChild(callStyle);
});

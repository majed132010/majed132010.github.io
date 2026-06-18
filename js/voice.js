// ════ VOICE (Agora) — مُصلح ════
const AGORA_APP_ID = '3a810a3ea5a24451ab56a6b7429c929c';
const TOKEN_SERVER_URL = 'https://agora-token-server-production-3636.up.railway.app';

let agoraClient = null;
let localAudioTrack = null;
let isMuted = false;
let voiceChannel = null;
let selectedMicDeviceId = null;
let voiceDbListener = null;
let _speakingDetector = null;

// ping لإبقاء السيرفر مستيقظاً
setInterval(() => { fetch(TOKEN_SERVER_URL + '/').catch(() => {}); }, 10 * 60 * 1000);

// ════ الحصول على Token ════
async function getAgoraToken(channelName, uid, retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      if (i > 1) toast(`⏳ إعادة المحاولة ${i}...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const res = await fetch(
        `${TOKEN_SERVER_URL}/token?channel=${encodeURIComponent(channelName)}&uid=${uid}`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (!res.ok) throw new Error('Server error: ' + res.status);
      const data = await res.json();
      if (data.token) return data.token;
      throw new Error('No token in response');
    } catch(e) {
      console.error(`Token attempt ${i} failed:`, e.message);
      if (i === retries) return null;
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
  return null;
}

// ════ تهيئة Agora ════
function initVoice() {
  _createAgoraClient();
}

function _createAgoraClient() {
  agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  _bindAgoraEvents();
}

function _bindAgoraEvents() {
  if (!agoraClient) return;
  // استخدم off ثم on لتجنب التكرار
  try { agoraClient.off('user-published'); } catch(e) {}
  try { agoraClient.off('user-unpublished'); } catch(e) {}
  try { agoraClient.off('connection-state-change'); } catch(e) {}

  agoraClient.on('user-published', async (user, mediaType) => {
    try {
      await agoraClient.subscribe(user, mediaType);
      if (mediaType === 'audio') user.audioTrack.play();
    } catch(err) { console.warn('subscribe error:', err.message); }
  });

  agoraClient.on('user-unpublished', (user, mediaType) => {
    if (mediaType === 'audio' && user.audioTrack) user.audioTrack.stop();
  });

  agoraClient.on('connection-state-change', (cur, prev) => {
    console.log(`Agora: ${prev} → ${cur}`);
    if (cur === 'DISCONNECTED' && voiceChannel) {
      toast('⚠️ انقطع الاتصال الصوتي');
      _resetVoiceUI();
    }
  });
}

// ════ عرض القناة الصوتية ════
function showVoiceChannel(sid, cid, ch) {
  cleanupMessagesListener();
  cleanupVoiceListener();
  showView('voice');
  voiceChannel = { sid, cid, name: ch.name };
  document.getElementById('voiceViewName').textContent = ch.name;
  document.getElementById('voiceJoinBtn').style.display = '';
  document.getElementById('voiceLeaveBtn').style.display = 'none';
  const logEl = document.getElementById('voiceLog');
  if (logEl) logEl.textContent = 'جاهز...\n';

  const voicePath = 'voice/' + sid + '/' + cid;
  voiceDbListener = voicePath;
  db.ref(voicePath).on('value', snap => {
    const users = snap.val() || {};
    const ul = document.getElementById('voiceUsersList');
    if (!ul) return;
    ul.innerHTML = '';
    if (!Object.keys(users).length) {
      ul.innerHTML = '<div style="text-align:center;padding:16px;color:#6a8a80;font-size:13px">لا يوجد أحد في القناة</div>';
      return;
    }
    Object.entries(users).forEach(([uid, u]) => {
      const isSpeaking = u.speaking && !u.muted;
      const div = document.createElement('div');
      div.className = 'voice-user';
      div.innerHTML = `
        <div class="voice-user-av" id="va-${uid}" style="border:2px solid ${isSpeaking?'#23a55a':'transparent'};transition:border .15s">${(u.name||'?')[0]}</div>
        <div class="voice-user-name">${escHtml(u.name||'مستخدم')}</div>
        ${u.muted ? '<span style="font-size:16px">🔇</span>' : `<div class="voice-indicator${isSpeaking?' speaking':''}" id="vi-${uid}"></div>`}
      `;
      ul.appendChild(div);
    });
  });
}

// ════ اختيار الميكروفون ════
async function selectMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    const devices = await AgoraRTC.getMicrophones();
    if (!devices || !devices.length) { toast('❌ لا يوجد ميكروفون'); return; }
    if (devices.length === 1) {
      selectedMicDeviceId = devices[0].deviceId;
      toast('🎤 ' + (devices[0].label || 'الميكروفون الافتراضي'));
      return;
    }
    const names = devices.map((d,i) => `${i+1}. ${d.label||'ميكروفون '+(i+1)}`).join('\n');
    const choice = prompt('اختر رقم الميكروفون:\n' + names);
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < devices.length) {
      selectedMicDeviceId = devices[idx].deviceId;
      toast('✅ ' + devices[idx].label);
    }
  } catch(e) { toast('❌ لا يمكن الوصول للميكروفون'); }
}

// ════ كشف الكلام ════
function startSpeakingDetection(localTrack) {
  if (_speakingDetector) clearInterval(_speakingDetector);
  if (!localTrack) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(new MediaStream([localTrack.getMediaStreamTrack()]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;
    _speakingDetector = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,b) => a+b, 0) / data.length;
      const isSpeaking = avg > 15;
      if (isSpeaking !== wasSpeaking) {
        wasSpeaking = isSpeaking;
        updateSpeakingIndicator(currentUser?.uid, isSpeaking);
        if (voiceChannel) {
          db.ref('voice/' + voiceChannel.sid + '/' + voiceChannel.cid + '/' + currentUser.uid + '/speaking')
            .set(isSpeaking).catch(() => {});
        }
      }
    }, 100);
  } catch(e) { console.warn('Speaking detection error:', e); }
}

function stopSpeakingDetection() {
  if (_speakingDetector) { clearInterval(_speakingDetector); _speakingDetector = null; }
  if (voiceChannel && currentUser) {
    db.ref('voice/' + voiceChannel.sid + '/' + voiceChannel.cid + '/' + currentUser.uid + '/speaking')
      .set(false).catch(() => {});
  }
}

function updateSpeakingIndicator(uid, isSpeaking) {
  const el = document.getElementById('vi-' + uid);
  if (el) el.classList.toggle('speaking', isSpeaking);
  const av = document.getElementById('va-' + uid);
  if (av) av.style.border = isSpeaking ? '2px solid #23a55a' : '2px solid transparent';
}

// ════ الانضمام للقناة الصوتية ════
async function joinVoice() {
  if (!voiceChannel || !agoraClient) return;
  toast('⏳ جاري الاتصال...');

  try {
    // طلب إذن الميكروفون
    const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    testStream.getTracks().forEach(t => t.stop());

    // إنشاء مسار الصوت
    const micConfig = { encoderConfig: 'speech_standard' };
    if (selectedMicDeviceId) micConfig.microphoneId = selectedMicDeviceId;
    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack(micConfig);

    // اسم قناة فريد
    const channelName = (voiceChannel.sid + '_' + voiceChannel.cid)
      .replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);

    // uid مستقر
    const uidHash = Math.abs(
      currentUser.uid.split('').reduce((a,c) => (a<<5)-a+c.charCodeAt(0), 0)
    ) % 999999 + 1;

    toast('⏳ جاري الحصول على التصريح...');
    const token = await getAgoraToken(channelName, uidHash);

    if (!token) {
      toast('❌ فشل الحصول على تصريح الاتصال');
      if (localAudioTrack) { localAudioTrack.close(); localAudioTrack = null; }
      return;
    }

    // إعادة ربط الأحداث قبل الانضمام
    _bindAgoraEvents();

    await agoraClient.join(AGORA_APP_ID, channelName, token, uidHash);
    await agoraClient.publish([localAudioTrack]);

    startSpeakingDetection(localAudioTrack);

    await db.ref('voice/' + voiceChannel.sid + '/' + voiceChannel.cid + '/' + currentUser.uid).set({
      name: userProfile.displayName || 'مستخدم',
      muted: false,
      speaking: false,
      ts: Date.now()
    });
    db.ref('voice/' + voiceChannel.sid + '/' + voiceChannel.cid + '/' + currentUser.uid)
      .onDisconnect().remove();

    document.getElementById('voiceJoinBtn').style.display = 'none';
    document.getElementById('voiceLeaveBtn').style.display = '';
    document.getElementById('voiceConnectedBar').classList.add('show');
    document.getElementById('vcChannelName').textContent = voiceChannel.name;
    toast('🔊 انضممت للقناة الصوتية!');

  } catch(e) {
    console.error('Voice error:', e);
    // رسالة خطأ واضحة حسب النوع
    if (e.code === 'CAN_NOT_GET_GATEWAY_SERVER') {
      toast('❌ فشل الاتصال بسيرفر الصوت — حاول مرة أخرى');
    } else if (e.name === 'NotAllowedError') {
      toast('❌ يجب السماح بالوصول للميكروفون');
    } else {
      toast('❌ فشل الانضمام: ' + (e.message || 'خطأ غير معروف'));
    }
    stopSpeakingDetection();
    if (localAudioTrack) { localAudioTrack.close(); localAudioTrack = null; }
    // أعد إنشاء الـ client بالكامل بعد الفشل
    try { await agoraClient.leave(); } catch(ex) {}
    _createAgoraClient();
  }
}

// ════ مغادرة القناة الصوتية ════
async function leaveVoice() {
  if (!voiceChannel) return;
  try {
    stopSpeakingDetection();
    if (localAudioTrack) { localAudioTrack.stop(); localAudioTrack.close(); localAudioTrack = null; }
    try { await agoraClient.leave(); } catch(e) {}
    await db.ref('voice/' + voiceChannel.sid + '/' + voiceChannel.cid + '/' + currentUser.uid).remove();
    db.ref('voice/' + voiceChannel.sid + '/' + voiceChannel.cid).off();
    voiceChannel = null;
    isMuted = false;
    _resetVoiceUI();
    toast('📵 غادرت القناة');
  } catch(e) {
    console.error('leaveVoice error:', e);
  }
  // أعد إنشاء الـ client دائماً بعد المغادرة
  _createAgoraClient();
}

function _resetVoiceUI() {
  document.getElementById('voiceConnectedBar').classList.remove('show');
  const joinBtn = document.getElementById('voiceJoinBtn');
  const leaveBtn = document.getElementById('voiceLeaveBtn');
  const muteBtn = document.getElementById('vcMuteBtn');
  if (joinBtn) joinBtn.style.display = '';
  if (leaveBtn) leaveBtn.style.display = 'none';
  if (muteBtn) { muteBtn.textContent = '🎤'; muteBtn.classList.remove('muted'); }
}

async function toggleMute() {
  if (!localAudioTrack) return;
  isMuted = !isMuted;
  await localAudioTrack.setEnabled(!isMuted);
  const btn = document.getElementById('vcMuteBtn');
  if (btn) { btn.textContent = isMuted ? '🔇' : '🎤'; btn.classList.toggle('muted', isMuted); }
  if (voiceChannel) {
    await db.ref('voice/' + voiceChannel.sid + '/' + voiceChannel.cid + '/' + currentUser.uid + '/muted')
      .set(isMuted);
  }
  toast(isMuted ? '🔇 مكتوم' : '🎤 مفعّل');
}

function cleanupVoiceListener() {
  if (voiceDbListener) { db.ref(voiceDbListener).off('value'); voiceDbListener = null; }
}

// ════ رسائل صوتية ════
let _mediaRecorder = null, _audioChunks = [], _recordingTimer = null;
let _recordingSeconds = 0, _voiceRecordingBusy = false;

async function toggleVoiceRecording() {
  if (_voiceRecordingBusy) return;
  const btn = document.getElementById('voiceRecordBtn');
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _voiceRecordingBusy = true;
    clearInterval(_recordingTimer);
    btn.classList.remove('recording'); btn.textContent = '🎤'; btn.disabled = true;
    document.getElementById('voiceRecordBtn').style.background = '';
    document.getElementById('voiceRecordBtn').style.borderColor = '';
    document.getElementById('voiceRecordBtn').style.color = '';
    clearInterval(window._recTimer);
    if (window._recTimerEl) { window._recTimerEl.remove(); window._recTimerEl = null; }
    _mediaRecorder.stop();
  } else if (!_mediaRecorder || _mediaRecorder.state === 'inactive') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _audioChunks = []; _recordingSeconds = 0;
      const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus']
        .find(t => MediaRecorder.isTypeSupported(t)) || '';
      _mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _audioChunks.push(e.data); };
      _mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(_audioChunks, { type: mimeType });
        btn.disabled = false; _voiceRecordingBusy = false; _mediaRecorder = null;
        if (blob.size < 1000) { toast('⚠️ التسجيل قصير جداً'); return; }
        await sendVoiceMessage(blob, _recordingSeconds, mimeType);
      };
      _mediaRecorder.start();
      btn.classList.add('recording'); btn.textContent = '⏹ 0s';
      document.getElementById('voiceRecordBtn').style.background = 'rgba(220,50,50,0.3)';
      document.getElementById('voiceRecordBtn').style.borderColor = 'rgba(220,50,50,0.6)';
      document.getElementById('voiceRecordBtn').style.color = '#e04040';
      let _recSeconds = 0;
      window._recTimerEl = document.createElement('span');
      window._recTimerEl.id = 'recTimerDisplay';
      window._recTimerEl.style.cssText = 'font-size:13px;font-weight:700;color:#e04040;font-family:Tajawal,sans-serif;min-width:38px;text-align:center';
      window._recTimerEl.textContent = '0:00';
      document.getElementById('voiceRecordBtn').insertAdjacentElement('afterend', window._recTimerEl);
      window._recTimer = setInterval(() => {
        _recSeconds++;
        const m = Math.floor(_recSeconds/60);
        const s = String(_recSeconds%60).padStart(2,'0');
        if (window._recTimerEl) window._recTimerEl.textContent = m+':'+s;
      }, 1000);
      _recordingTimer = setInterval(() => {
        _recordingSeconds++;
        btn.textContent = `⏹ ${_recordingSeconds}s`;
        if (_recordingSeconds >= 60) toggleVoiceRecording();
      }, 1000);
      toast('🎤 جاري التسجيل... اضغط مرة أخرى للإرسال');
    } catch(e) { toast('❌ لا يمكن الوصول للميكروفون'); }
  }
}

async function sendVoiceMessage(blob, duration, mimeType) {
  if (!currentServer || !currentChannel || !currentUser) return;
  toast('⏳ جاري إرسال الرسالة الصوتية...');
  const ct = (mimeType || 'audio/webm').split(';')[0];
  const ext = ct === 'audio/mp4' ? 'mp4' : ct === 'audio/ogg' ? 'ogg' : 'webm';
  try {
    const url = await uploadToCloudinary(new File([blob], `voice.${ext}`, { type: ct }));
    await db.ref('messages/' + currentServer + '/' + currentChannel).push({
      uid: currentUser.uid,
      name: userProfile.displayName || 'مستخدم',
      ts: Date.now(),
      voiceUrl: url,
      voiceDuration: duration,
      text: ''
    });
    toast('✅ تم إرسال الرسالة الصوتية');
  } catch(e) { toast('❌ فشل إرسال الرسالة الصوتية'); }
}

function buildVoiceMsg(url, duration) {
  const wrap = document.createElement('div');
  wrap.className = 'voice-msg-wrap';
  const audio = new Audio(url);
  let playing = false;
  const playBtn = document.createElement('button');
  playBtn.className = 'voice-play-btn'; playBtn.textContent = '▶';
  const progress = document.createElement('div');
  progress.className = 'voice-progress';
  const fill = document.createElement('div');
  fill.className = 'voice-progress-fill'; fill.style.width = '0%';
  progress.appendChild(fill);
  const dur = document.createElement('div');
  dur.className = 'voice-duration';
  dur.textContent = duration ? `${duration}s` : '0s';
  audio.ontimeupdate = () => {
    fill.style.width = (audio.duration ? audio.currentTime / audio.duration * 100 : 0) + '%';
    dur.textContent = Math.ceil((audio.duration || 0) - audio.currentTime) + 's';
  };
  audio.onended = () => { playing = false; playBtn.textContent = '▶'; fill.style.width = '0%'; };
  playBtn.onclick = () => {
    if (playing) { audio.pause(); playBtn.textContent = '▶'; }
    else { audio.play().catch(() => {}); playBtn.textContent = '⏸'; }
    playing = !playing;
  };
  wrap.appendChild(playBtn); wrap.appendChild(progress); wrap.appendChild(dur);
  return wrap;
}

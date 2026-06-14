// ════ CALLS SYSTEM ════
let _callClient = null;
let _localAudioTrack = null;
let _localVideoTrack = null;
let _callListener = null;
let _callTimeout = null;
let _currentCall = null; // { callId, type, fromUid, toUid, channelName }
let _callTimer = null;
let _callSeconds = 0;
let _netStatsInterval = null;   // network-quality polling interval
let _currentVideoProfile = 'auto'; // 'auto' | '720p' | '480p'
let _incomingCallsRef = null;  // ref to calls/{uid}/incoming — detached on sign-out
let _callResponseRef = null;   // ref to calls/{uid}/response — detached after answer or endCall

// ════ بدء مكالمة ════
async function startCall(toUid, toName, type = 'audio') {
  console.log('%c[CALL] ▶ startCall', 'color:#23a55a;font-weight:bold', { toUid, toName, type });

  if (!currentUser) {
    console.error('[CALL] ✖ startCall: لا يوجد مستخدم مسجّل (currentUser = null)');
    toast('❌ يجب تسجيل الدخول أولاً');
    return;
  }
  if (!toUid) {
    console.error('[CALL] ✖ startCall: toUid مفقود', { toUid });
    toast('❌ معرّف الطرف الآخر مفقود');
    return;
  }
  if (_currentCall) {
    console.warn('[CALL] ⚠ startCall: مكالمة جارية بالفعل', _currentCall);
    toast('⚠️ أنت في مكالمة بالفعل');
    return;
  }

  const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const channelName = callId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
  // 🆕 سرّ الرفض: يصل المتلقي في الإشعار، ويُمكّنه من الرفض من الخلفية عبر دالة rejectCall دون توكن
  const rejectSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  console.log('[CALL] أنشأت callId/channelName:', { callId, channelName });

  _currentCall = { callId, type, fromUid: currentUser.uid, toUid, channelName, role: 'caller', rejectSecret };

  // اكتب المكالمة في Firebase
  const incomingPath = 'calls/' + toUid + '/incoming';
  console.log('[CALL] ✏ الكتابة في Firebase →', incomingPath);
  try {
    await db.ref(incomingPath).set({
      callId,
      type,
      fromUid: currentUser.uid,
      fromName: userProfile.displayName || 'مستخدم',
      channelName,
      ts: Date.now()
    });
    console.log('%c[CALL] ✓ نجحت الكتابة في Firebase', 'color:#23a55a', incomingPath);
    // 🆕 خزّن سرّ الرفض في عقدة خادمية (تقرأها دالة rejectCall بصلاحيات Admin فقط)
    await db.ref('call_secrets/' + callId).set({ fromUid: currentUser.uid, toUid, rejectSecret, ts: Date.now() });
  } catch (e) {
    console.error('[CALL] ✖ فشلت الكتابة في Firebase:', e.code, e.message, '\nالمسار:', incomingPath);
    toast('❌ فشل إرسال المكالمة (Firebase): ' + (e.code || e.message || ''));
    _currentCall = null;
    hideCallScreens();
    return;
  }

  // أرسل إشعار push
  console.log('[CALL] 🔔 إرسال إشعار Push إلى', toUid);
  try {
    await sendPushToUser(toUid, userProfile.displayName || 'عوالم',
      type === 'video' ? '📹 مكالمة فيديو واردة' : '📞 مكالمة صوتية واردة',
      { type: 'call', callType: type, fromUid: currentUser.uid, fromName: userProfile.displayName || 'مستخدم', callId, channelName, rejectSecret }
    );
    console.log('[CALL] ✓ تم استدعاء sendPushToUser (لا يضمن وصول الإشعار فعلياً)');
  } catch(e) {
    console.error('[CALL] ✖ فشل إرسال إشعار Push:', e);
    toast('⚠️ تعذّر إرسال إشعار الدفع — المكالمة قد تصل فقط إذا كان التطبيق مفتوحاً لدى الطرف الآخر');
  }

  // عرض شاشة الاتصال الصادر
  console.log('[CALL] 📺 عرض شاشة الاتصال الصادر');
  showOutgoingCallScreen(toName, type);

  // انتظر الرد 45 ثانية
  _callTimeout = setTimeout(() => {
    console.warn('[CALL] ⏱ انتهت مهلة 45 ثانية بدون رد');
    endCall('no_answer');
  }, 45000);

  // استمع لرد المتصل به
  const responsePath = 'calls/' + currentUser.uid + '/response';
  console.log('[CALL] 👂 الاستماع لرد الطرف الآخر على →', responsePath);
  _callResponseRef = db.ref(responsePath);
  _callResponseRef.on('value', async snap => {
    const resp = snap.val();
    console.log('[CALL] 📥 وصل حدث على مسار الرد:', resp);
    if (!resp || resp.callId !== callId) {
      console.log('[CALL] … تجاهل الرد (فارغ أو callId غير مطابق)', { got: resp?.callId, expected: callId });
      return;
    }
    _callResponseRef?.off('value'); _callResponseRef = null;
    clearTimeout(_callTimeout);

    if (resp.status === 'accepted') {
      console.log('%c[CALL] ✓ قَبِل الطرف الآخر المكالمة', 'color:#23a55a;font-weight:bold');
      toast('✅ تم قبول المكالمة');
      hideCallScreens();
      await joinCallChannel(channelName, type, toName, toUid);
    } else {
      console.warn('[CALL] ✖ رفض الطرف الآخر المكالمة، status =', resp.status);
      endCall('rejected');
    }
  });
}

// ════ استقبال مكالمة ════
function listenIncomingCalls() {
  if (_incomingCallsRef) return; // مستمع نشط مسبقاً — لا إعادة تسجيل
  if (!currentUser) {
    console.error('[CALL] ✖ listenIncomingCalls: لا يوجد مستخدم مسجّل — لن يتم تسجيل المستمع');
    return;
  }
  const incomingPath = 'calls/' + currentUser.uid + '/incoming';
  console.log('%c[CALL] 👂 تسجيل مستمع المكالمات الواردة على →', 'color:#1a9fff;font-weight:bold', incomingPath);
  _incomingCallsRef = db.ref(incomingPath);
  _incomingCallsRef.on('value', snap => {
    const call = snap.val();
    console.log('[CALL] 📥 حدث على مسار المكالمات الواردة:', call);
    if (!call) {
      console.log('[CALL] … لا توجد مكالمة واردة (تم المسح أو فارغ)');
      return;
    }
    if (Date.now() - call.ts > 45000) {
      console.warn('[CALL] ⏱ مكالمة واردة قديمة (أكثر من 45 ثانية) — سيتم حذفها', { age: Date.now() - call.ts });
      db.ref(incomingPath).remove();
      return;
    }
    if (_currentCall) {
      console.warn('[CALL] ⚠ مشغول بمكالمة أخرى — تجاهل الواردة', _currentCall);
      return; // مشغول
    }
    console.log('%c[CALL] 🔔 مكالمة واردة! عرض شاشة الاستقبال', 'color:#23a55a;font-weight:bold',
      { from: call.fromName, type: call.type });
    _currentCall = { ...call, toUid: currentUser.uid, role: 'callee' };
    showIncomingCallScreen(call.fromName, call.type, call.fromUid, call.callId, call.channelName);
    // 🆕 إن كان هناك طلب قبول معلّق من إشعار خارجي لنفس المكالمة → اقبل تلقائياً
    if (_pendingAcceptCallId && _pendingAcceptCallId === call.callId) {
      console.log('[CALL] 📲 تنفيذ طلب القبول المعلّق من الإشعار:', call.callId);
      _pendingAcceptCallId = null;
      acceptCall();
    }
  }, err => {
    console.error('[CALL] ✖ خطأ في مستمع المكالمات الواردة (قد تكون قواعد Firebase تمنع القراءة):', err.code, err.message);
    toast('❌ تعذّر الاستماع للمكالمات الواردة: ' + (err.code || err.message || ''));
  });
}

// ════ قبول المكالمة ════
async function acceptCall() {
  if (!_currentCall) return;
  _stopRingtone(); // kill ringing instantly on accept
  clearTimeout(_callTimeout);
  _stopIncomingCancelListener(); // أوقف مستمع الإلغاء — joinCallChannel سيسجّل مستمع الإنهاء الخاص بما بعد الرد
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
  _stopRingtone(); // kill ringing instantly on reject
  clearTimeout(_callTimeout);
  _stopIncomingCancelListener(); // أوقف مستمع الإلغاء قبل إرسال الرفض
  const { callId, fromUid } = _currentCall;

  await db.ref('calls/' + fromUid + '/response').set({
    callId, status: 'rejected', ts: Date.now()
  });
  await db.ref('calls/' + currentUser.uid + '/incoming').remove();
  db.ref('call_secrets/' + callId).remove().catch(() => {}); // 🆕 نظّف سرّ الرفض

  _currentCall = null;
  hideCallScreens();
  toast('📵 رفضت المكالمة');
}

// ════ الاستماع لإنهاء المكالمة من الطرف الآخر ════
function _listenToCallEnd() {
  if (!currentUser) return;
  const endPath = 'calls/' + currentUser.uid + '/end';
  console.log('[CALL] 👂 الاستماع لإشارة الإنهاء على →', endPath);
  // أزل أي مستمع سابق لتفادي التكرار
  db.ref(endPath).off('value');
  db.ref(endPath).on('value', snap => {
    const v = snap.val();
    console.log('[CALL] 📥 حدث على مسار الإنهاء:', v);
    if (!v) return; // فارغ (أو تم حذفه) — تجاهل
    console.warn('[CALL] ✖ أنهى الطرف الآخر المكالمة');
    db.ref(endPath).off('value');
    // ننهي محلياً فقط دون إعادة الكتابة للطرف الآخر (لتفادي حلقة لا نهائية)
    endCall('remote');
  }, err => {
    console.error('[CALL] ✖ خطأ في مستمع الإنهاء (تحقق من قواعد Firebase):', err.code, err.message);
  });
}

// ════ إنهاء المكالمة ════
async function endCall(reason = 'ended') {
  console.log('%c[CALL] ▶ endCall', 'color:#e04040;font-weight:bold', { reason, call: _currentCall });
  _stopRingtone();      // kill ringing instantly, before any async Firebase/Agora work
  _stopNetworkStats();  // detach network-quality listener and clear ping interval
  _currentVideoProfile = 'auto';
  clearTimeout(_callTimeout);
  clearInterval(_callTimer);
  _callSeconds = 0;

  // أوقف المستمع على عقدتنا فوراً قبل أي تنظيف
  if (currentUser) { try { db.ref('calls/' + currentUser.uid + '/end').off('value'); } catch(e) {} }
  _incomingCallsRef?.off('value'); _incomingCallsRef = null;
  _callResponseRef?.off('value');  _callResponseRef = null;

  // أوقف الوسائط المحلية وغادر قناة Agora
  if (_callClient) {
    try {
      if (_localAudioTrack) { _localAudioTrack.stop(); _localAudioTrack.close(); _localAudioTrack = null; }
      if (_localVideoTrack) { _localVideoTrack.stop(); _localVideoTrack.close(); _localVideoTrack = null; }
      await _callClient.leave();
      console.log('[CALL] ✓ غادرت قناة Agora');
    } catch(e) { console.warn('[CALL] ⚠ خطأ أثناء مغادرة Agora:', e); }
    // إعادة إنشاء Client للمكالمة التالية — داخل try/catch لحماية من أخطاء CORS/SDK
    try {
      _callClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    } catch(e) {
      console.warn('[CALL] ⚠ فشل إعادة إنشاء Agora client (CORS أو تحميل SDK):', e);
      _callClient = null;
    }
  }

  // أبلغ الطرف الآخر بالإنهاء — إلا إذا كنا ننهي ردّاً على إشارته هو ('remote')
  if (_currentCall && reason !== 'remote') {
    const { fromUid, toUid, callId, role } = _currentCall;
    const otherUid = role === 'caller' ? toUid : fromUid;
    const otherEndPath = 'calls/' + otherUid + '/end';
    try {
      await db.ref(otherEndPath).set({ callId, ts: Date.now() });
      console.log('[CALL] ✓ أبلغت الطرف الآخر بالإنهاء →', otherEndPath);
    } catch(e) {
      console.error('[CALL] ✖ فشل إبلاغ الطرف الآخر بالإنهاء:', e.code, e.message);
    }
  }

  // نظّف عقدة المكالمة الخاصة بنا في Firebase
  if (currentUser) {
    try {
      await db.ref('calls/' + currentUser.uid).remove();
      console.log('[CALL] ✓ حذفت calls/' + currentUser.uid);
    } catch(e) { console.error('[CALL] ✖ فشل حذف عقدة المكالمة:', e.code, e.message); }
  }

  // 🆕 نظّف سرّ الرفض الخاص بهذه المكالمة
  if (_currentCall && _currentCall.callId) {
    db.ref('call_secrets/' + _currentCall.callId).remove().catch(() => {});
  }
  _currentCall = null;
  hideCallScreens();

  if (reason === 'no_answer') toast('📵 لم يرد');
  else if (reason === 'rejected') toast('📵 رفض المكالمة');
  else if (reason === 'remote') toast('📵 أنهى الطرف الآخر المكالمة');
  else if (reason !== 'silent') toast('📵 انتهت المكالمة');
}

// ════ كشف متصفّح داخل التطبيقات (in-app WebView) ════
// هذه المتصفحات (Google app, Facebook, Instagram, ...) تمنع غالباً الكاميرا/الميكروفون
function _isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /FBAN|FBAV|FB_IAB|Instagram|Line|Twitter|Snapchat|TikTok|MicroMessenger|GSA\//i.test(ua)
    || /\bwv\b/.test(ua); // Android WebView
}

// ════ شاشة إرشادية عند منع الكاميرا/الميكروفون ════
function _showMediaBlockedHelp(type) {
  _stopRingtone();
  const inApp = _isInAppBrowser();
  const need = type === 'video' ? 'الكاميرا والميكروفون' : 'الميكروفون';
  console.warn('[CALL] 🚫 عرض شاشة منع الوسائط — inAppBrowser =', inApp);

  let scr = document.getElementById('mediaBlockedScreen');
  if (!scr) { scr = document.createElement('div'); scr.id = 'mediaBlockedScreen'; document.body.appendChild(scr); }
  scr.style.cssText = 'position:fixed;inset:0;z-index:10000;background:linear-gradient(135deg,#0d2535,#1a4a4a);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:Tajawal,sans-serif;color:#fff;padding:28px;text-align:center';
  scr.innerHTML = `
    <div style="font-size:60px">🎤🚫</div>
    <div style="font-size:20px;font-weight:800">تعذّر الوصول إلى ${need}</div>
    <div style="font-size:15px;color:rgba(255,255,255,0.85);max-width:340px;line-height:1.8">
      ${inApp
        ? 'يبدو أنك فتحت الموقع من متصفّح داخل تطبيق آخر (مثل Google أو فيسبوك)، وهو لا يسمح باستخدام الكاميرا/الميكروفون.<br><br>افتح الرابط في <b>Safari</b> أو <b>Chrome</b> مباشرةً ثم أعد المحاولة.'
        : 'تأكد من السماح للموقع باستخدام الكاميرا والميكروفون من إعدادات المتصفح، ثم أعد المحاولة.'}
    </div>
    <button id="copyCallLinkBtn" style="background:#23a55a;color:#fff;border:none;border-radius:12px;padding:13px 26px;font-family:Tajawal,sans-serif;font-size:15px;font-weight:700;cursor:pointer">📋 نسخ رابط الموقع</button>
    <button id="closeMediaBlockedBtn" style="background:rgba(255,255,255,0.15);color:#fff;border:none;border-radius:12px;padding:11px 24px;font-family:Tajawal,sans-serif;font-size:14px;cursor:pointer">إغلاق</button>
  `;
  scr.style.display = 'flex';
  const copyBtn = document.getElementById('copyCallLinkBtn');
  if (copyBtn) copyBtn.onclick = () => {
    navigator.clipboard?.writeText(location.href).then(
      () => toast('📋 تم نسخ الرابط — الصقه في Safari أو Chrome'),
      () => toast('انسخ الرابط يدوياً من شريط العنوان')
    );
  };
  const closeBtn = document.getElementById('closeMediaBlockedBtn');
  if (closeBtn) closeBtn.onclick = () => scr.remove();
}

// ════ الانضمام لقناة المكالمة ════
async function joinCallChannel(channelName, type, otherName, otherUid) {
  console.log('%c[CALL] ▶ joinCallChannel', 'color:#23a55a;font-weight:bold', { channelName, type, otherName, otherUid });

  // ① ابنِ شاشة المكالمة النشطة أولاً لضمان وجود عناصر #remote-video و #local-video
  //    قبل أي استدعاء لـ .play()، وإلا تظهر الشاشة سوداء.
  showActiveCallScreen(otherName, type);

  try {
    _callClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

    // عالج حظر التشغيل التلقائي للصوت (شائع لدى المتصِل لأنه ينضم من callback وليس من نقرة)
    AgoraRTC.onAutoplayFailed = () => {
      console.warn('[CALL] ⚠ التشغيل التلقائي محظور — في انتظار تفاعل المستخدم');
      toast('🔈 اضغط على الشاشة لتشغيل الصوت');
      document.body.addEventListener('click', () => {}, { once: true });
    };

    // ② امسح أي إشارة إنهاء قديمة ثم سجّل المستمع — قبل الانضمام
    await db.ref('calls/' + currentUser.uid + '/end').remove();
    _listenToCallEnd();

    // ③ أحداث Agora — استقبال وسائط الطرف الآخر وتوصيلها بعناصر DOM (الموجودة الآن)
    _callClient.on('user-published', async (user, mediaType) => {
      console.log('[CALL] 📡 user-published:', mediaType, 'من', user.uid);
      try {
        await _callClient.subscribe(user, mediaType);
        if (mediaType === 'audio' && user.audioTrack) {
          user.audioTrack.play();
          console.log('[CALL] 🔊 تشغيل صوت الطرف الآخر');
        }
        if (mediaType === 'video' && user.videoTrack) {
          user.videoTrack.play('remote-video');
          console.log('[CALL] 🎥 تشغيل فيديو الطرف الآخر في #remote-video');
        }
      } catch(err) {
        console.error('[CALL] ✖ فشل الاشتراك/التشغيل لوسائط الطرف الآخر:', err);
        toast('⚠️ تعذّر تشغيل وسائط الطرف الآخر');
      }
    });

    _callClient.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'audio' && user.audioTrack) user.audioTrack.stop();
      if (mediaType === 'video' && user.videoTrack) user.videoTrack.stop();
    });

    // إذا غادر الطرف الآخر قناة Agora فجأة (إغلاق التبويب مثلاً)، أنهِ المكالمة هنا أيضاً
    _callClient.on('user-left', user => {
      console.log('[CALL] 👋 غادر الطرف الآخر قناة Agora:', user.uid);
      endCall('remote');
    });

    // احصل على Token
    const uidHash = Math.abs(
      currentUser.uid.split('').reduce((a,c) => (a<<5)-a+c.charCodeAt(0), 0)
    ) % 999999 + 1;

    const token = await getAgoraToken(channelName, uidHash);
    if (!token) { console.error('[CALL] ✖ تعذّر الحصول على token'); toast('❌ فشل الاتصال'); endCall('silent'); return; }

    await _callClient.join('3a810a3ea5a24451ab56a6b7429c929c', channelName, token, uidHash);
    console.log('[CALL] ✓ انضممت لقناة Agora:', channelName, '(uid:', uidHash + ')');

    // ④ أنشئ ونشر المسارات المحلية — عنصر #local-video موجود الآن
    const tracks = [];
    try {
      _localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({ encoderConfig: 'speech_standard' });
      tracks.push(_localAudioTrack);

      if (type === 'video') {
        // جودة HD مرنة مع fallback تلقائي لو عجز جوال عن استيعاب الدقة العالية
        try {
          _localVideoTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: {
              width: { ideal: 1280, min: 640 },
              height: { ideal: 720, min: 480 },
              frameRate: { ideal: 30, min: 15 },
              bitrateMax: 1500
            }
          });
          // Lock in 720p@30fps explicitly after creation
          await _localVideoTrack.setEncoderConfiguration({
            width: 1280, height: 720, frameRate: 30, bitrateMin: 400, bitrateMax: 1500
          });
          console.log('[CALL] 🎥 أُنشئ فيديو محلي بجودة HD (1280×720@30fps)');
        } catch(hdErr) {
          console.warn('[CALL] ⚠ فشلت دقة HD على هذا الجهاز — التحويل للإعداد الافتراضي:', hdErr.message || hdErr);
          toast('⚠️ تعذّرت الجودة العالية — استخدام الجودة الافتراضية');
          _localVideoTrack = await AgoraRTC.createCameraVideoTrack();
          // Stable 480p@30fps for the fallback path
          await _localVideoTrack.setEncoderConfiguration({
            width: 854, height: 480, frameRate: 30, bitrateMin: 200, bitrateMax: 800
          });
          console.log('[CALL] 🎥 أُنشئ فيديو محلي بإعداد 480p@30fps (fallback)');
        }

        // Prioritise framerate over sharpness — keeps video smooth on slow mobile networks
        await _localVideoTrack.setOptimizationMode('motion');

        // Low-light beauty enhancement — optional, not available on all SDK builds
        try {
          if (typeof _localVideoTrack.setBeautyEffect === 'function') {
            await _localVideoTrack.setBeautyEffect(true, {
              lighteningContrastLevel: 1,  // 0–2: moderate contrast boost
              lighteningLevel: 0.6,        // 0–1: brightens dark environments
              smoothnessLevel: 0.5,        // 0–1: light skin smoothing
              sharpnessLevel: 0.1          // 0–1: subtle edge sharpening
            });
            console.log('[CALL] ✨ تم تفعيل تأثير التجميل (تعزيز الإضاءة المنخفضة)');
          }
        } catch(beautyErr) {
          console.warn('[CALL] ⚠ تأثير التجميل غير متاح في هذا الإصدار:', beautyErr.message || beautyErr);
        }

        tracks.push(_localVideoTrack);
        _localVideoTrack.play('local-video');
        console.log('[CALL] 🎥 تشغيل الفيديو المحلي في #local-video');
      }
    } catch(mediaErr) {
      // فشل الوصول للكاميرا/الميكروفون كلياً — غالباً متصفّح داخل تطبيق يمنع الوسائط
      console.error('[CALL] ✖ تعذّر الوصول للكاميرا/الميكروفون:', mediaErr.code || '', mediaErr.message || mediaErr);
      _showMediaBlockedHelp(type);
      endCall('silent');
      return;
    }

    await _callClient.publish(tracks);
    console.log('%c[CALL] ✓ تم نشر الوسائط المحلية — المكالمة نشطة', 'color:#23a55a;font-weight:bold');
    _startNetworkStats();

  } catch(e) {
    console.error('[CALL] ✖ خطأ في joinCallChannel:', e);
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
  // ① أنشئ عنصر الشاشة إن لم يكن موجوداً
  let screen = document.getElementById('incomingCallScreen');
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'incomingCallScreen';
    screen.style.cssText = 'position:fixed;inset:0;z-index:9999;background:linear-gradient(135deg,#0d2535,#1a4a4a);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:Tajawal,sans-serif;color:#fff';
    document.body.appendChild(screen);
  }

  // ② اعرض أزرار القبول/الرفض فوراً قبل أي عمليات صوت أو شبكة
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

  // ③ ثم صوت الرنين (قد يُرفض بدون تفاعل مستخدم على بعض المتصفحات — لا يؤثر على الشاشة)
  _playRingtone();

  // ④ ثم مستمع إلغاء المتصل (Firebase) — بعد ظهور الشاشة كاملاً
  _listenIncomingCancel(callId, name);

  // ⑤ أوقف الرنين بعد 45 ثانية
  _callTimeout = setTimeout(() => {
    _stopRingtone();
    _stopIncomingCancelListener();
    db.ref('calls/' + currentUser.uid + '/incoming').remove();
    _currentCall = null;
    hideCallScreens();
    toast('📵 فاتتك مكالمة من ' + name);
  }, 45000);
}

// ════ 🆕 الاستماع لإلغاء المتصل أثناء الرنين (cancelled) ════
// المتصل عند ضغط "إنهاء" قبل الرد يستدعي endCall() التي تكتب في calls/{المتلقي}/end.
// نلتقط ذلك هنا لنغلق شاشة الرنين ونوقف النغمة فوراً بدل انتظار مهلة الـ 45 ثانية.
function _listenIncomingCancel(callId, name) {
  if (!currentUser) return;
  const endPath = 'calls/' + currentUser.uid + '/end';
  db.ref(endPath).off('value'); // أزل أي مستمع سابق
  db.ref(endPath).on('value', snap => {
    const v = snap.val();
    if (!v) return; // فارغ/محذوف — تجاهل
    if (v.callId && callId && v.callId !== callId) return; // إشارة لمكالمة أخرى
    console.warn('%c[CALL] ✖ ألغى المتصل المكالمة قبل الرد (cancelled)', 'color:#e04040;font-weight:bold');
    db.ref(endPath).off('value');
    clearTimeout(_callTimeout);
    _stopRingtone();
    db.ref('calls/' + currentUser.uid + '/incoming').remove().catch(() => {});
    _currentCall = null;
    hideCallScreens();
    toast('📵 أُلغيت المكالمة من ' + (name || 'المتصل'));
  }, err => {
    console.error('[CALL] ✖ خطأ في مستمع الإلغاء أثناء الرنين:', err.code, err.message);
  });
}

// إيقاف مستمع الإلغاء (يُستدعى عند القبول/الرفض لتفادي التعارض مع مستمع الإنهاء بعد الرد)
function _stopIncomingCancelListener() {
  if (currentUser) { try { db.ref('calls/' + currentUser.uid + '/end').off('value'); } catch (e) {} }
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
        <div id="callNetStats">
          <div id="callNetDot"></div>
          <span id="callNetPing">— ms</span>
        </div>
        <div style="position:absolute;top:20px;left:50%;transform:translateX(-50%);text-align:center;pointer-events:none">
          <div style="font-size:16px;font-weight:700">${escHtml(otherName)}</div>
          <div id="callTimer" style="font-size:13px;color:rgba(255,255,255,0.7)">00:00</div>
        </div>
      </div>
      <div style="padding:20px;display:flex;justify-content:center;align-items:center;gap:16px;background:#0d1e28;position:relative">
        <button id="callMuteBtn" onclick="toggleCallMute()" style="width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;font-size:24px;cursor:pointer;color:#fff">🎤</button>
        <button id="callCameraBtn" onclick="toggleCallCamera()" style="width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;font-size:24px;cursor:pointer;color:#fff">📹</button>
        <button onclick="endCall()" style="width:64px;height:64px;border-radius:50%;background:#e04040;border:none;font-size:28px;cursor:pointer;box-shadow:0 4px 16px rgba(224,64,64,0.45)">📵</button>
        <div style="position:relative">
          <button id="callQualityBtn" onclick="toggleQualityMenu()" style="width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.15);border:none;font-size:20px;cursor:pointer;color:#fff" title="جودة الفيديو">⚙️</button>
          <div id="callQualityMenu" style="display:none">
            <div class="call-profile-opt active" id="callProfile_auto" onclick="setVideoProfile('auto')">🔄 تلقائي</div>
            <div class="call-profile-opt" id="callProfile_720p" onclick="setVideoProfile('720p')">🎥 HD 720p</div>
            <div class="call-profile-opt" id="callProfile_480p" onclick="setVideoProfile('480p')">📶 توفير 480p</div>
          </div>
        </div>
      </div>
    `;
  } else {
    screen.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
        <div style="width:100px;height:100px;border-radius:50%;background:var(--acc,#1a6060);display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800">${(otherName||'?')[0]}</div>
        <div style="font-size:20px;font-weight:800">${escHtml(otherName)}</div>
        <div id="callTimer" style="font-size:14px;color:rgba(255,255,255,0.6)">00:00</div>
        <div id="callNetStats" style="margin-top:4px">
          <div id="callNetDot"></div>
          <span id="callNetPing">— ms</span>
        </div>
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

  // Close quality dropdown when clicking anywhere outside it
  screen.addEventListener('click', e => {
    const menu = document.getElementById('callQualityMenu');
    const btn  = document.getElementById('callQualityBtn');
    if (menu && menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== btn) {
      menu.style.display = 'none';
    }
  });
}

// ════ إحصاءات الشبكة اللحظية ════
function _startNetworkStats() {
  if (!_callClient) return;

  // Agora fires this every ~2 s — quality 1=excellent … 6=disconnected, 0=unknown
  _callClient.on('network-quality', stats => {
    const dot = document.getElementById('callNetDot');
    if (!dot) return;
    const q = Math.max(stats.uplinkNetworkQuality || 0, stats.downlinkNetworkQuality || 0);
    dot.style.background =
      q === 0           ? '#888888' :
      q <= 2            ? '#23a55a' :  // excellent / good  → green
      q <= 4            ? '#f0b429' :  // poor / bad        → amber
                          '#e04040';   // very bad / lost   → red
  });

  // Poll getRTCStats() for RTT (ping) — not exposed as an event
  _netStatsInterval = setInterval(() => {
    if (!_callClient) return;
    try {
      const stats = _callClient.getRTCStats();
      const el = document.getElementById('callNetPing');
      if (el && stats && stats.RTT != null) el.textContent = Math.round(stats.RTT) + ' ms';
    } catch(e) {}
  }, 2000);
}

function _stopNetworkStats() {
  if (_netStatsInterval) { clearInterval(_netStatsInterval); _netStatsInterval = null; }
  if (_callClient) { try { _callClient.off('network-quality'); } catch(e) {} }
}

// ════ قائمة جودة الفيديو ════
function toggleQualityMenu() {
  const menu = document.getElementById('callQualityMenu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
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
    const label = profile === 'auto' ? 'تلقائي' : profile === '720p' ? 'HD 720p' : 'توفير 480p';
    toast('✅ جودة الفيديو: ' + label);
    console.log('[CALL] 🎥 تغيير جودة الفيديو →', profile);
  } catch(e) {
    toast('❌ فشل تغيير جودة الفيديو');
    console.error('[CALL] ✖ setEncoderConfiguration:', e);
  }
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

// ════ 🆕 قبول المكالمة من إشعار الـ Service Worker الخارجي ════
// عند ضغط "قبول ✅" في إشعار الخلفية، يرسل الـ SW إما postMessage للنافذة المفتوحة،
// أو يفتح التطبيق برابط ?acceptCall=callId إن كان مغلقاً. نتعامل مع الحالتين هنا.
let _pendingAcceptCallId = null;

function acceptCallFromNotification(callId) {
  if (!callId) return;
  console.log('%c[CALL] 📲 طلب قبول من إشعار خارجي', 'color:#23a55a;font-weight:bold', callId);

  // المكالمة الواردة جاهزة بالفعل ومطابقة → اقبل فوراً
  if (_currentCall && _currentCall.callId === callId) {
    acceptCall();
    return;
  }
  // وإلا خزّن الطلب ريثما يلتقط listenIncomingCalls المكالمة من calls/{uid}/incoming فيقبلها تلقائياً
  console.log('[CALL] … المكالمة لم تصل بعد — حفظ القبول كـ معلّق');
  _pendingAcceptCallId = callId;
}

// (1) التطبيق مفتوح في الخلفية: الـ SW يرسل postMessage
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'acceptCall') acceptCallFromNotification(d.callId);
  });
}

// (2) التطبيق كان مغلقاً ففُتح عبر الرابط ?acceptCall=callId
try {
  const _qpCall = new URLSearchParams(location.search).get('acceptCall');
  if (_qpCall) {
    acceptCallFromNotification(_qpCall);
    // نظّف الرابط حتى لا يتكرر القبول عند إعادة التحميل
    history.replaceState(null, '', location.pathname + location.hash);
  }
} catch (e) { console.warn('[CALL] تعذّر قراءة باراميتر acceptCall:', e); }

// ════ CSS للأنيميشن (معدل ليعمل بعد تحميل الصفحة) ════
const callStyle = document.createElement('style');
callStyle.textContent = `
  @keyframes callPulse {
    0%,100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }
  #activeCallScreen button:hover { opacity: 0.85; }
  #activeCallScreen button.active { background: rgba(255,255,255,0.35) !important; }

  /* ── Network stats pill ── */
  #callNetStats {
    position: absolute;
    top: 14px;
    left: 14px;
    display: flex;
    align-items: center;
    gap: 7px;
    background: rgba(0,0,0,0.45);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    padding: 5px 12px;
    pointer-events: none;
    z-index: 10;
  }
  #callNetDot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #888;
    flex-shrink: 0;
    transition: background 0.5s ease;
  }
  #callNetPing {
    font-size: 11px;
    font-family: Tajawal, sans-serif;
    color: rgba(255,255,255,0.82);
    font-variant-numeric: tabular-nums;
    min-width: 38px;
  }

  /* ── Video quality dropdown ── */
  #callQualityMenu {
    position: absolute;
    bottom: 68px;
    right: 50%;
    transform: translateX(50%);
    background: #1a2e3d;
    border-radius: 14px;
    overflow: hidden;
    min-width: 172px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    border: 1px solid rgba(255,255,255,0.1);
    z-index: 200;
  }
  .call-profile-opt {
    padding: 13px 16px;
    font-size: 14px;
    font-family: Tajawal, sans-serif;
    color: rgba(255,255,255,0.82);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 9px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    transition: background 0.15s;
    user-select: none;
  }
  .call-profile-opt:last-child { border-bottom: none; }
  .call-profile-opt:hover     { background: rgba(255,255,255,0.1); }
  .call-profile-opt.active    { color: #23a55a; font-weight: 700; }
`;

document.addEventListener('DOMContentLoaded', () => {
  document.head.appendChild(callStyle);
});

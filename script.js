/* =========================================================================
   Movie Together — script.js
   منطق التطبيق: الصفحة الرئيسية + صفحة الغرفة (مشغل الفيديو والدردشة)

   ملاحظة معمارية:
   كل تخزين البيانات هنا يمرّ عبر طبقة "storage.js" وهمية مُدمجة أدناه
   (كائن RoomStore) تحاكي واجهة قاعدة بيانات فايربيس (Firebase Realtime
   Database) باستخدام localStorage مؤقتًا. عند ربط فايربيس لاحقًا، يكفي
   استبدال تنفيذ دوال RoomStore دون تغيير بقية الكود الذي يستدعيها.
   ========================================================================= */

(function () {
  'use strict';

  /* ======================================================================
     أدوات عامة
     ====================================================================== */

  /** توليد معرّف غرفة عشوائي مكوّن من 6 محارف (أحرف كبيرة + أرقام) */
  function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون أحرف متشابهة (O/0, I/1)
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  /** توليد معرّف مستخدم عشوائي لتمييز الجهاز الحالي داخل الغرفة */
  function generateUserId() {
    return 'u_' + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  }

  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  /* ======================================================================
     طبقة تخزين الغرفة (RoomStore)
     -----------------------------------------------------------------------
     تحاكي حاليًا قاعدة بيانات فايربيس عبر localStorage.
     البنية المخطط لها في Firebase Realtime Database مستقبلًا:

       rooms/
         {roomId}/
           createdAt: number
           video: { url: string, type: 'mp4' | 'hls', updatedAt, updatedBy }
           playback: { isPlaying: bool, currentTime: number, updatedAt }
           viewers/
             {userId}: { name: string, joinedAt: number }
           messages/
             {messageId}: { userId, name, text, ts }

     كل دالة أدناه هي نقطة الاستبدال المستقبلية بمكافئها في Firebase
     (مثال: onValue / set / push / onDisconnect...).
     ====================================================================== */

  const RoomStore = {
    _key(roomId) {
      return `movieTogether_room_${roomId}`;
    },

    /** قراءة كامل بيانات الغرفة (أو إنشاء بنية فارغة) */
    read(roomId) {
      const raw = localStorage.getItem(this._key(roomId));
      if (raw) {
        try { return JSON.parse(raw); } catch (e) { /* تجاهل بيانات تالفة */ }
      }
      return {
        createdAt: Date.now(),
        video: { url: '', type: '' },
        playback: { isPlaying: false, currentTime: 0, updatedAt: Date.now() },
        viewers: {},
        messages: []
      };
    },

    /** كتابة كامل بيانات الغرفة */
    write(roomId, data) {
      localStorage.setItem(this._key(roomId), JSON.stringify(data));
      // TODO(Firebase): استبدال هذا بـ:
      //   set(ref(db, `rooms/${roomId}`), data)
    },

    /** إضافة/تحديث مشاهد في الغرفة */
    upsertViewer(roomId, userId, name) {
      const data = this.read(roomId);
      data.viewers[userId] = { name, joinedAt: data.viewers[userId]?.joinedAt || Date.now() };
      this.write(roomId, data);
      // TODO(Firebase): set(ref(db, `rooms/${roomId}/viewers/${userId}`), { name, joinedAt })
      // TODO(Firebase): استخدام onDisconnect(ref) لإزالة المشاهد تلقائيًا عند الخروج
    },

    /** إضافة رسالة دردشة جديدة */
    addMessage(roomId, message) {
      const data = this.read(roomId);
      data.messages.push(message);
      // الاحتفاظ بآخر 200 رسالة فقط لتفادي تضخم التخزين المحلي
      if (data.messages.length > 200) data.messages = data.messages.slice(-200);
      this.write(roomId, data);
      // TODO(Firebase): push(ref(db, `rooms/${roomId}/messages`), message)
    },

    /** تحديث مصدر الفيديو الحالي للغرفة */
    setVideo(roomId, url, type) {
      const data = this.read(roomId);
      data.video = { url, type, updatedAt: Date.now() };
      this.write(roomId, data);
      // TODO(Firebase): set(ref(db, `rooms/${roomId}/video`), data.video)
    },

    /** تحديث حالة التشغيل (تشغيل/إيقاف/موضع) */
    setPlayback(roomId, isPlaying, currentTime) {
      const data = this.read(roomId);
      data.playback = { isPlaying, currentTime, updatedAt: Date.now() };
      this.write(roomId, data);
      // TODO(Firebase): set(ref(db, `rooms/${roomId}/playback`), data.playback)
    }
  };

  /* ======================================================================
     الصفحة الرئيسية (index.html)
     ====================================================================== */

  function initHomePage() {
    const createBtn = document.getElementById('create-room-btn');
    if (!createBtn) return;

    createBtn.addEventListener('click', function () {
      const roomId = generateRoomId();

      // تهيئة بنية الغرفة مبدئيًا في التخزين المحلي
      RoomStore.write(roomId, RoomStore.read(roomId));

      // التوجيه إلى صفحة الغرفة مع معرّف الغرفة في الرابط
      window.location.href = `room.html?id=${encodeURIComponent(roomId)}`;
    });
  }

  /* ======================================================================
     صفحة الغرفة (room.html)
     ====================================================================== */

  function initRoomPage() {
    const joinModal = document.getElementById('join-modal');
    if (!joinModal) return; // لسنا في صفحة الغرفة

    const roomId = getQueryParam('id');

    // إن لم يوجد معرّف غرفة صالح، أعد التوجيه إلى الرئيسية
    if (!roomId) {
      window.location.href = 'index.html';
      return;
    }

    document.getElementById('room-id-label').textContent = roomId;
    document.getElementById('modal-room-code').textContent = `غرفة #${roomId}`;
    document.title = `غرفة ${roomId} — Movie Together`;

    /* ---------------------------------------------------------------
       عناصر DOM
       --------------------------------------------------------------- */
    const usernameInput = document.getElementById('username-input');
    const usernameError = document.getElementById('username-error');
    const joinBtn = document.getElementById('join-btn');

    const videoEl = document.getElementById('video-player');
    const emptyState = document.getElementById('player-empty-state');
    const videoUrlInput = document.getElementById('video-url-input');
    const loadVideoBtn = document.getElementById('load-video-btn');
    const syncStatusText = document.getElementById('sync-status-text');

    // عناصر وضع الاتصال الضعيف
    const bufferingOverlay = document.getElementById('buffering-overlay');
    const bufferingLabel = document.getElementById('buffering-label');
    const bufferBarFill = document.getElementById('buffer-bar-fill');
    const bufferingSub = document.getElementById('buffering-sub');
    const slowModeToggle = document.getElementById('slow-mode-toggle');
    const ratioBadge = document.getElementById('ratio-badge');
    const ratioDot = document.getElementById('ratio-dot');
    const ratioText = document.getElementById('ratio-text');
    const netSettingsToggle = document.getElementById('net-settings-toggle');
    const netSettingsPanel = document.getElementById('net-settings-panel');
    const prebufferInput = document.getElementById('prebuffer-input');
    const resumeBufferInput = document.getElementById('resume-buffer-input');
    const speedInput = document.getElementById('speed-input');
    const calcBtn = document.getElementById('calc-btn');
    const calcResult = document.getElementById('calc-result');

    const chatMessagesEl = document.getElementById('chat-messages');
    const chatEmptyEl = document.getElementById('chat-empty');
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');
    const chatCountEl = document.getElementById('chat-count');

    const viewersRow = document.getElementById('viewers-row');
    const copyLinkBtn = document.getElementById('copy-link-btn');
    const copyToast = document.getElementById('copy-toast');

    let currentUser = null; // { id, name }
    let hlsInstance = null;
    let renderedMessageCount = 0;
    let suppressPlaybackEvents = false; // لتفادي حلقة إعادة بث عند تطبيق تحديثات خارجية

    /* ---------------------------------------------------------------
       1) تدفق الانضمام إلى الغرفة (إدخال اسم المستخدم)
       --------------------------------------------------------------- */

    function tryAutoFillName() {
      const saved = sessionStorage.getItem(`movieTogether_username_${roomId}`);
      if (saved) usernameInput.value = saved;
    }
    tryAutoFillName();

    function handleJoin() {
      const name = usernameInput.value.trim();
      if (!name) {
        usernameError.textContent = 'الرجاء إدخال اسم للمتابعة';
        usernameInput.focus();
        return;
      }
      if (name.length > 20) {
        usernameError.textContent = 'الاسم طويل جدًا (٢٠ محرفًا كحد أقصى)';
        return;
      }

      usernameError.textContent = '';
      const userId = sessionStorage.getItem(`movieTogether_userid_${roomId}`) || generateUserId();
      sessionStorage.setItem(`movieTogether_userid_${roomId}`, userId);
      sessionStorage.setItem(`movieTogether_username_${roomId}`, name);

      currentUser = { id: userId, name };

      // تسجيل المشاهد في الغرفة (طبقة التخزين المؤقتة)
      RoomStore.upsertViewer(roomId, userId, name);

      // رسالة نظام ترحيبية محلية
      addSystemMessage(`${name} انضم إلى الغرفة`);

      joinModal.style.display = 'none';
      enterRoom();
    }

    joinBtn.addEventListener('click', handleJoin);
    usernameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') handleJoin();
    });

    /* ---------------------------------------------------------------
       2) الدخول الفعلي إلى الغرفة: تحميل الحالة + بدء "الاستماع" للتحديثات
       --------------------------------------------------------------- */

    function enterRoom() {
      const data = RoomStore.read(roomId);

      // استرجاع مصدر الفيديو المحفوظ (إن وجد) وتحميله
      if (data.video && data.video.url) {
        videoUrlInput.value = data.video.url;
        loadVideoSource(data.video.url, false);
      }

      // استرجاع سجل الدردشة المحفوظ
      renderAllMessages(data.messages || []);

      // استرجاع قائمة المشاهدين
      renderViewers(data.viewers || {});

      // بدء الاستماع للتغييرات القادمة من نوافذ/تبويبات أخرى (محاكاة الوقت الحقيقي)
      window.addEventListener('storage', handleExternalStorageChange);

      // TODO(Firebase): هنا نستبدل حدث "storage" بمستمعي Firebase الحقيقيين:
      //   onValue(ref(db, `rooms/${roomId}/messages`), snapshot => renderAllMessages(...))
      //   onValue(ref(db, `rooms/${roomId}/viewers`), snapshot => renderViewers(...))
      //   onValue(ref(db, `rooms/${roomId}/playback`), snapshot => applyRemotePlayback(...))
      //   onValue(ref(db, `rooms/${roomId}/video`), snapshot => loadVideoSource(...))
    }

    /** يُستدعى عند أي تغيير في localStorage من تبويب آخر لنفس الغرفة (محاكاة realtime) */
    function handleExternalStorageChange(e) {
      if (e.key !== RoomStore._key(roomId)) return;
      const data = RoomStore.read(roomId);
      renderAllMessages(data.messages || []);
      renderViewers(data.viewers || {});

      if (data.video && data.video.url && data.video.url !== videoUrlInput.value) {
        videoUrlInput.value = data.video.url;
        loadVideoSource(data.video.url, false);
      }
    }

    /* ---------------------------------------------------------------
       3) مشغّل الفيديو (MP4 + M3U8 عبر HLS.js)
       --------------------------------------------------------------- */

    function detectVideoType(url) {
      if (/\.m3u8($|\?)/i.test(url)) return 'hls';
      return 'mp4';
    }

    /* -----------------------------------------------------------------
       وضع الاتصال الضعيف (Low-Bandwidth Mode)
       -------------------------------------------------------------------
       فكرته: عدم السماح بالتشغيل إلا بعد تخزين عدد ثوانٍ كافٍ مسبقًا،
       وإيقاف التشغيل تلقائيًا وإعادة التخزين إذا اقترب المشغل من نفاد
       ما تم تحميله، بدل أن يتقطّع الفيديو أثناء المشاهدة. كما نقيس نسبة
       "سرعة التحميل إلى سرعة التشغيل" مباشرة من طول الجزء المخزَّن
       مؤقتًا (buffered) دون الحاجة لأي طلب شبكة إضافي — وبالتالي يعمل
       بدقة معقولة حتى مع روابط من خوادم خارجية (CORS). */

    let watchdogTimer = null;
    let hasStartedOnce = false;   // هل بدأ التشغيل فعليًا مرة واحدة على الأقل
    let isAutoPaused = false;     // هل الإيقاف الحالي تسبب به المراقب وليس المستخدم
    let userWantsToPlay = false;  // المستخدم ضغط تشغيل وننتظر التخزين قبل التنفيذ
    let lastFrontier = 0;
    let lastFrontierTime = performance.now();

    const LOW_BUFFER_THRESHOLD = 3; // إن قلّ المخزون عن هذا أثناء التشغيل → إيقاف فوري

    function isSlowModeOn() { return slowModeToggle.checked; }
    function getPrebufferTarget() { return parseFloat(prebufferInput.value) || 25; }
    function getResumeTarget() { return parseFloat(resumeBufferInput.value) || 12; }

    /** كمية الثواني المخزّنة أمام موضع التشغيل الحالي مباشرة */
    function getBufferedAhead() {
      const t = videoEl.currentTime;
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (videoEl.buffered.start(i) - 0.5 <= t && t <= videoEl.buffered.end(i)) {
          return videoEl.buffered.end(i) - t;
        }
      }
      return 0;
    }

    /** أقصى نقطة تم تحميلها فعليًا (حافة التحميل) */
    function getDownloadFrontier() {
      if (!videoEl.buffered.length) return 0;
      return videoEl.buffered.end(videoEl.buffered.length - 1);
    }

    function showBufferingOverlay(label) {
      bufferingOverlay.classList.remove('hidden');
      bufferingLabel.textContent = label;
    }

    function hideBufferingOverlay() {
      bufferingOverlay.classList.add('hidden');
    }

    function updateBufferingProgress(current, target) {
      const pct = Math.max(0, Math.min(100, (current / target) * 100));
      bufferBarFill.style.width = pct + '%';
      bufferingSub.textContent = `${Math.floor(current)} من ${Math.floor(target)} ثانية`;
    }

    function updateRatioBadge(ratio) {
      if (!isFinite(ratio) || ratio < 0) return;
      ratioBadge.classList.remove('good', 'bad');
      if (ratio >= 1.1) {
        ratioBadge.classList.add('good');
        ratioText.textContent = `التحميل أسرع من التشغيل (×${ratio.toFixed(1)})`;
      } else if (ratio <= 0.85) {
        ratioBadge.classList.add('bad');
        ratioText.textContent = `التحميل أبطأ من التشغيل (×${ratio.toFixed(1)}) — يُتوقع تقطيع`;
      } else {
        ratioText.textContent = `التحميل قريب من سرعة التشغيل (×${ratio.toFixed(1)})`;
      }
    }

    function startWatchdog() {
      stopWatchdog();
      lastFrontier = getDownloadFrontier();
      lastFrontierTime = performance.now();
      watchdogTimer = setInterval(watchdogTick, 1000);
    }

    function stopWatchdog() {
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
    }

    function watchdogTick() {
      if (!videoEl.src && !videoEl.currentSrc) return;

      // --- قياس نسبة التحميل إلى التشغيل ---
      const now = performance.now();
      const frontier = getDownloadFrontier();
      const dtReal = (now - lastFrontierTime) / 1000;
      if (dtReal > 0.2) {
        const ratio = (frontier - lastFrontier) / dtReal;
        updateRatioBadge(ratio);
        lastFrontier = frontier;
        lastFrontierTime = now;
      }

      if (!isSlowModeOn()) {
        if (isAutoPaused) { isAutoPaused = false; userWantsToPlay = false; hideBufferingOverlay(); }
        return;
      }

      const bufferedAhead = getBufferedAhead();

      // المستخدم بانتظار وصول التخزين للحد المطلوب (أولي أو بعد انقطاع)
      if (userWantsToPlay && isAutoPaused) {
        const target = hasStartedOnce ? getResumeTarget() : getPrebufferTarget();
        updateBufferingProgress(bufferedAhead, target);
        if (bufferedAhead >= target) {
          isAutoPaused = false;
          videoEl.play().catch(() => {});
        }
        return;
      }

      // يشغّل الآن لكن المخزون قارب على النفاد → إيقاف تلقائي لإعادة التخزين
      const nearEnd = isFinite(videoEl.duration) && frontier >= videoEl.duration - 0.5;
      if (!videoEl.paused && bufferedAhead < LOW_BUFFER_THRESHOLD && !nearEnd) {
        isAutoPaused = true;
        userWantsToPlay = true;
        videoEl.pause();
        showBufferingOverlay('إعادة التخزين المؤقت — الاتصال بطيء…');
        updateBufferingProgress(bufferedAhead, getResumeTarget());
      }
    }

    // اعتراض محاولات التشغيل لتطبيق بوّابة التخزين المسبق
    videoEl.addEventListener('play', function () {
      if (suppressPlaybackEvents) return;

      if (isSlowModeOn()) {
        const bufferedAhead = getBufferedAhead();
        const needed = hasStartedOnce ? getResumeTarget() : getPrebufferTarget();
        if (bufferedAhead < needed) {
          isAutoPaused = true;
          userWantsToPlay = true;
          videoEl.pause();
          showBufferingOverlay(hasStartedOnce ? 'إعادة التخزين المؤقت — الاتصال بطيء…' : 'جارِ التجهيز للمشاهدة السلسة…');
          updateBufferingProgress(bufferedAhead, needed);
          return;
        }
      }

      isAutoPaused = false;
      userWantsToPlay = false;
      hasStartedOnce = true;
      hideBufferingOverlay();
      broadcastPlay(videoEl.currentTime);
    });

    /* -----------------------------------------------------------------
       تحميل مصدر الفيديو (MP4 أو HLS) مع إعدادات مهيّأة لسرعات منخفضة
       ----------------------------------------------------------------- */

    function buildHlsConfig() {
      if (!isSlowModeOn()) return {};
      return {
        // تخزين أعمق مقدمًا بدل ملاحقة اللحظة الحالية فقط
        maxBufferLength: 60,
        maxMaxBufferLength: 180,
        // ابدأ بأقل جودة متاحة لتفادي تقطيع أولي، ثم اسمح لـ hls.js بالتكيّف
        startLevel: 0,
        capLevelToPlayerSize: true,
        // تقدير مبدئي متحفظ للسرعة (بالبت/ث) يقارب ١٥٠ كيلوبايت/ث
        abrEwmaDefaultEstimate: 1200000
      };
    }

    function loadVideoSource(url, persist) {
      if (!url) return;
      const type = detectVideoType(url);

      // إعادة ضبط حالة مراقب الاتصال الضعيف عند كل تحميل جديد
      hasStartedOnce = false;
      isAutoPaused = false;
      userWantsToPlay = false;
      hideBufferingOverlay();

      // تفكيك أي جلسة HLS سابقة قبل تحميل مصدر جديد
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      if (type === 'hls') {
        if (window.Hls && window.Hls.isSupported()) {
          hlsInstance = new Hls(buildHlsConfig());
          hlsInstance.loadSource(url);
          hlsInstance.attachMedia(videoEl);
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          // دعم أصلي (Safari / iOS) — لا يوفر هذا المسار ضبط تخزين مؤقت مخصص
          videoEl.src = url;
        } else {
          syncStatusText.textContent = 'المتصفح لا يدعم بث M3U8';
          return;
        }
      } else {
        videoEl.src = url;
      }

      emptyState.classList.add('hidden');
      syncStatusText.textContent = 'تم تحميل الفيديو — جاهز للمشاهدة';
      startWatchdog();

      if (persist) {
        RoomStore.setVideo(roomId, url, type);
        addSystemMessage(`${currentUser.name} غيّر الفيديو`);
      }
    }

    loadVideoBtn.addEventListener('click', function () {
      const url = videoUrlInput.value.trim();
      if (!url) return;
      loadVideoSource(url, true);
    });

    // إظهار/إخفاء لوحة إعدادات الاتصال الضعيف
    netSettingsToggle.addEventListener('click', function () {
      netSettingsPanel.classList.toggle('hidden');
    });

    // حاسبة الجودة الموصى بها بناءً على السرعة التقريبية
    calcBtn.addEventListener('click', function () {
      const kbps = parseFloat(speedInput.value);
      if (!kbps || kbps <= 0) {
        calcResult.textContent = 'أدخل سرعة صالحة أولًا';
        return;
      }
      // نترك هامشًا ٢٥٪ لتذبذب الشبكة ورسائل الدردشة، ونحوّل لكيلوبت/ث
      const recommendedKbps = Math.round(kbps * 8 * 0.75);
      let resNote;
      if (recommendedKbps >= 1200) resNote = 'دقة 720p مناسبة غالبًا';
      else if (recommendedKbps >= 600) resNote = 'دقة 480p هي الأنسب';
      else resNote = 'دقة 360p أو أقل لتفادي التقطيع';

      calcResult.innerHTML =
        `بمعدل <b>${kbps} كيلوبايت/ث</b>، معدل البت الموصى به للفيديو تقريبًا ` +
        `<b>${recommendedKbps} كيلوبت/ث</b> — ${resNote}.<br>` +
        `أمر ffmpeg مقترح لإعادة الترميز:<br>` +
        `<code>ffmpeg -i in.mp4 -vf scale=-2:480 -c:v libx264 -b:v ${recommendedKbps}k -c:a aac -b:a 96k out.mp4</code>`;
    });

    /* ---- دوال التزامن المستقبلي للتشغيل (تشغيل/إيقاف/تقديم) ----
       هذه الدوال جاهزة الآن للعمل محليًا فقط، وستُبَث لبقية المشاهدين
       عبر Firebase Realtime Database أو WebSocket لاحقًا. */

    function broadcastPlay(currentTime) {
      RoomStore.setPlayback(roomId, true, currentTime);
      // TODO(Firebase/WebSocket): بث حدث "play" مع currentTime للحظة الحالية
      // socket.emit('play', { roomId, currentTime, ts: Date.now() });
    }

    function broadcastPause(currentTime) {
      RoomStore.setPlayback(roomId, false, currentTime);
      // TODO(Firebase/WebSocket): بث حدث "pause" مع currentTime
      // socket.emit('pause', { roomId, currentTime, ts: Date.now() });
    }

    function broadcastSeek(currentTime) {
      RoomStore.setPlayback(roomId, !videoEl.paused, currentTime);
      // TODO(Firebase/WebSocket): بث حدث "seek" مع الموضع الجديد
      // socket.emit('seek', { roomId, currentTime, ts: Date.now() });
    }

    /** يُستدعى عند استقبال تحديث تشغيل من مستخدم آخر (مستقبلًا عبر Firebase) */
    function applyRemotePlayback(playback) {
      suppressPlaybackEvents = true;
      if (Math.abs(videoEl.currentTime - playback.currentTime) > 1.5) {
        videoEl.currentTime = playback.currentTime;
      }
      if (playback.isPlaying) videoEl.play().catch(() => {});
      else videoEl.pause();
      suppressPlaybackEvents = false;
    }

    // ملاحظة: مستمع "play" الفعلي (مع بوّابة التخزين المسبق لوضع الاتصال
    // الضعيف) مُعرَّف أعلاه مباشرة بعد تعريف الدوال المساعدة للمراقب.

    videoEl.addEventListener('pause', function () {
      if (suppressPlaybackEvents) return;
      if (isAutoPaused) return; // إيقاف تسبب به المراقب (إعادة تخزين) — لا نبثّه
      broadcastPause(videoEl.currentTime);
    });

    videoEl.addEventListener('seeked', function () {
      if (suppressPlaybackEvents) return;
      broadcastSeek(videoEl.currentTime);
    });

    /* ---------------------------------------------------------------
       4) نظام الدردشة
       --------------------------------------------------------------- */

    function renderAllMessages(messages) {
      if (messages.length === renderedMessageCount && renderedMessageCount !== 0) return;

      chatMessagesEl.innerHTML = '';
      if (messages.length === 0) {
        chatMessagesEl.appendChild(chatEmptyEl);
        chatCountEl.textContent = '0 رسالة';
        renderedMessageCount = 0;
        return;
      }

      messages.forEach(function (msg) {
        chatMessagesEl.appendChild(buildMessageEl(msg));
      });

      renderedMessageCount = messages.length;
      chatCountEl.textContent = `${messages.length} رسالة`;
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function buildMessageEl(msg) {
      const wrap = document.createElement('div');

      if (msg.type === 'system') {
        wrap.className = 'msg system';
        wrap.innerHTML = `<div class="msg-bubble">${escapeHtml(msg.text)}</div>`;
        return wrap;
      }

      const isOwn = currentUser && msg.userId === currentUser.id;
      wrap.className = 'msg' + (isOwn ? ' own' : '');
      wrap.innerHTML = `
        <div class="msg-author">${escapeHtml(msg.name)}</div>
        <div class="msg-bubble">${escapeHtml(msg.text)}</div>
        <div class="msg-time">${formatTime(msg.ts)}</div>
      `;
      return wrap;
    }

    function addSystemMessage(text) {
      RoomStore.addMessage(roomId, {
        type: 'system',
        text,
        ts: Date.now()
      });
      renderAllMessages(RoomStore.read(roomId).messages);
    }

    function sendChatMessage() {
      const text = chatInput.value.trim();
      if (!text || !currentUser) return;

      const message = {
        type: 'user',
        userId: currentUser.id,
        name: currentUser.name,
        text,
        ts: Date.now()
      };

      // TODO(Firebase): استبدال هذا السطر بـ:
      //   push(ref(db, `rooms/${roomId}/messages`), message)
      RoomStore.addMessage(roomId, message);

      renderAllMessages(RoomStore.read(roomId).messages);
      chatInput.value = '';
      chatInput.focus();
    }

    chatSendBtn.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendChatMessage();
    });

    /* ---------------------------------------------------------------
       5) قائمة المشاهدين
       --------------------------------------------------------------- */

    function renderViewers(viewers) {
      viewersRow.innerHTML = '';
      Object.values(viewers).forEach(function (v) {
        const chip = document.createElement('div');
        chip.className = 'viewer-chip';
        const initial = (v.name || '?').trim().charAt(0).toUpperCase();
        chip.innerHTML = `<span class="avatar">${escapeHtml(initial)}</span> ${escapeHtml(v.name)}`;
        viewersRow.appendChild(chip);
      });
    }

    /* ---------------------------------------------------------------
       6) نسخ رابط الغرفة
       --------------------------------------------------------------- */

    copyLinkBtn.addEventListener('click', function () {
      const url = window.location.href;
      navigator.clipboard.writeText(url).then(function () {
        copyToast.classList.add('show');
        setTimeout(() => copyToast.classList.remove('show'), 2200);
      }).catch(function () {
        // بديل بسيط في حال فشل الوصول لحافظة النظام
        window.prompt('انسخ رابط الغرفة:', url);
      });
    });
  }

  /* ======================================================================
     التهيئة عند تحميل الصفحة
     ====================================================================== */

  document.addEventListener('DOMContentLoaded', function () {
    initHomePage();
    initRoomPage();
  });

})();

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
     طبقة تخزين الغرفة المحلية (RoomStore) — الوضع الاحتياطي بدون فايربيس
     -----------------------------------------------------------------------
     تُستخدم فقط إذا لم يُعدّ فايربيس بعد (راجع firebase-config.js). بمجرد
     ضبط الإعداد، الموقع يستخدم الطبقة الحقيقية بملف firebase-backend.js
     (window.RoomBackend) بدل هذا الكائن تلقائيًا — بدون أي تعديل إضافي.

     نفس بنية البيانات مطابقة لما هو مطبَّق فعليًا على Firebase Realtime
     Database بملف firebase-backend.js:

       rooms/
         {roomId}/
           video: { url: string, type: 'mp4' | 'hls', updatedAt, updatedBy }
           playback: { isPlaying: bool, currentTime: number, updatedAt, updatedBy }
           viewers/
             {userId}: { name: string, joinedAt: number }
           messages/
             {messageId}: { type, userId?, name?, text, ts }
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
    },

    /** إضافة/تحديث مشاهد في الغرفة */
    upsertViewer(roomId, userId, name) {
      const data = this.read(roomId);
      data.viewers[userId] = { name, joinedAt: data.viewers[userId]?.joinedAt || Date.now() };
      this.write(roomId, data);
    },

    /** إضافة رسالة دردشة جديدة */
    addMessage(roomId, message) {
      const data = this.read(roomId);
      data.messages.push(message);
      // الاحتفاظ بآخر 200 رسالة فقط لتفادي تضخم التخزين المحلي
      if (data.messages.length > 200) data.messages = data.messages.slice(-200);
      this.write(roomId, data);
    },

    /** تحديث مصدر الفيديو الحالي للغرفة */
    setVideo(roomId, url, type) {
      const data = this.read(roomId);
      data.video = { url, type, updatedAt: Date.now() };
      this.write(roomId, data);
    },

    /** تحديث حالة التشغيل (تشغيل/إيقاف/موضع) */
    setPlayback(roomId, isPlaying, currentTime) {
      const data = this.read(roomId);
      data.playback = { isPlaying, currentTime, updatedAt: Date.now() };
      this.write(roomId, data);
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
    const ffmpegHintBtn = document.getElementById('ffmpeg-hint-btn');
    const ffmpegHintResult = document.getElementById('ffmpeg-hint-result');
    const chunkProgressEl = document.getElementById('chunk-progress');
    const modeBadge = document.getElementById('mode-badge');
    const modeBadgeText = document.getElementById('mode-badge-text');
    const cacheUsageText = document.getElementById('cache-usage-text');
    const clearCacheBtn = document.getElementById('clear-cache-btn');

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
    let chunkedPlayer = null; // ChunkedMp4Player instance عند تفعيل وضع الملفات الكبيرة
    let renderedMessageCount = 0;
    let suppressPlaybackEvents = false; // لتفادي حلقة إعادة بث عند تطبيق تحديثات خارجية

    // هل فايربيس مُعدّ فعليًا؟ إن لا، نستمر بالعمل محليًا عبر localStorage (RoomStore بالأسفل)
    const useFirebase = !!(window.RoomBackend && window.RoomBackend.isAvailable());

    const syncModeText = document.getElementById('sync-mode-text');
    if (syncModeText) {
      syncModeText.textContent = useFirebase ? '🟢 مزامنة حقيقية' : '⚪ وضع محلي (بدون فايربيس)';
      syncModeText.parentElement.title = useFirebase
        ? 'متصل بفايربيس — التغييرات تصل لكل من بالغرفة فورًا'
        : 'لم يُعدّ فايربيس بعد (راجع firebase-config.js) — التجربة محلية بهذا المتصفح فقط';
    }

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

      // تسجيل المشاهد في الغرفة (فايربيس إن كان مُعدًّا، وإلا محليًا)
      if (useFirebase) {
        window.RoomBackend.joinAsViewer(roomId, userId, name);
      } else {
        RoomStore.upsertViewer(roomId, userId, name);
      }

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
      if (useFirebase) {
        enterRoomFirebase();
      } else {
        enterRoomLocal();
      }
    }

    /** وضع المزامنة الحقيقية: اشتراكات فايربيس تستقبل التحديثات لحظيًا */
    function enterRoomFirebase() {
      window.RoomBackend.subscribeVideo(roomId, function (video) {
        if (video && video.url && video.url !== videoUrlInput.value) {
          videoUrlInput.value = video.url;
          loadVideoSource(video.url, false);
        }
      });

      window.RoomBackend.subscribePlayback(roomId, function (playback) {
        // تجاهل تحديثاتي أنا نفسي (سبق أن طبّقتها محليًا لحظة الإرسال) لتفادي حلقة مزامنة
        if (playback.updatedBy === currentUser.id) return;
        applyRemotePlayback(playback);
      });

      window.RoomBackend.subscribeViewers(roomId, function (viewers) {
        renderViewers(viewers);
      });

      // كل رسالة جديدة تصل فورًا (بما فيها رسائلي أنا، فنعرضها بنفس المسار للجميع)
      window.RoomBackend.subscribeNewMessages(roomId, function (message) {
        appendSingleMessage(message);
      });
    }

    /** وضع تجريبي محلي (بدون فايربيس): قراءة أولية + محاكاة realtime بين تبويبات نفس المتصفح */
    function enterRoomLocal() {
      const data = RoomStore.read(roomId);

      if (data.video && data.video.url) {
        videoUrlInput.value = data.video.url;
        loadVideoSource(data.video.url, false);
      }

      renderAllMessages(data.messages || []);
      renderViewers(data.viewers || {});

      window.addEventListener('storage', handleExternalStorageChange);
    }

    /** يُستدعى عند أي تغيير في localStorage من تبويب آخر لنفس الغرفة (محاكاة realtime محليًا فقط) */
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

    function formatMb(bytes) {
      return (bytes / (1024 * 1024)).toFixed(1);
    }

    function showChunkProgress(loaded, total) {
      chunkProgressEl.classList.remove('hidden');
      const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
      chunkProgressEl.innerHTML =
        `تحميل الملف: ${formatMb(loaded)} / ${formatMb(total)} ميجابايت (${pct.toFixed(0)}٪)` +
        `<div class="track"><div class="fill" style="width:${pct}%"></div></div>`;
    }

    function hideChunkProgress() {
      chunkProgressEl.classList.add('hidden');
      chunkProgressEl.innerHTML = '';
    }

    function setModeBadge(text, kind) {
      modeBadge.classList.remove('good', 'bad');
      if (kind) modeBadge.classList.add(kind);
      modeBadgeText.textContent = text;
    }

    /** يشغّل الفيديو بالطريقة العادية (وسم video مباشرة) */
    function playNatively(url) {
      videoEl.src = url;
    }

    /** يحمّل ملف MP4 عبر المشغل المخصص (chunked/MSE)، مع رجوع تلقائي للمشغل العادي عند أي فشل */
    function loadViaChunkedPlayer(url) {
      chunkedPlayer = new window.ChunkedMp4Player(videoEl, {
        onProgress: showChunkProgress,
        onReady: function () {
          setModeBadge('🎯 مشغّل التحميل المجزّأ نشط', 'good');
        },
        onError: function (message) {
          setModeBadge('▶️ تشغيل مباشر (تعذّر المشغّل المخصص)', '');
          hideChunkProgress();
          if (chunkedPlayer) { chunkedPlayer.destroy(); chunkedPlayer = null; }
          playNatively(url);
          startWatchdog();
        }
      });

      chunkedPlayer.load(url).catch(function (err) {
        setModeBadge('▶️ تشغيل مباشر (تعذّر المشغّل المخصص)', '');
        hideChunkProgress();
        chunkedPlayer = null;
        playNatively(url);
        startWatchdog();
      });
    }

    ffmpegHintBtn.addEventListener('click', function () {
      ffmpegHintResult.classList.toggle('hidden');
      if (!ffmpegHintResult.classList.contains('hidden')) {
        ffmpegHintResult.innerHTML =
          'حوّل أي ملف MP4 عادي إلى صيغة مجزّأة متوافقة (بدون إعادة ترميز، سريع):<br>' +
          '<code>ffmpeg -i in.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 out.mp4</code><br><br>' +
          'أو مع إعادة ترميز لدقة 480p (أنسب لسرعتك):<br>' +
          '<code>ffmpeg -i in.mp4 -vf scale=-2:480 -c:v libx264 -c:a aac -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 out.mp4</code>';
      }
    });

    /* -----------------------------------------------------------------
       تحميل مصدر الفيديو (MP4 أو HLS) مع كشف تلقائي لأنسب طريقة تشغيل
       ----------------------------------------------------------------- */

    function loadVideoSource(url, persist) {
      if (!url) return;
      const type = detectVideoType(url);

      // إعادة ضبط حالة مراقب الاتصال الضعيف عند كل تحميل جديد
      hasStartedOnce = false;
      isAutoPaused = false;
      userWantsToPlay = false;
      hideBufferingOverlay();
      hideChunkProgress();
      ffmpegHintBtn.classList.add('hidden');
      ffmpegHintResult.classList.add('hidden');

      // تفكيك أي جلسة سابقة (HLS أو المشغل المخصص) قبل تحميل مصدر جديد
      if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
      if (chunkedPlayer) { chunkedPlayer.destroy(); chunkedPlayer = null; }

      if (type === 'hls') {
        setModeBadge('📡 بث HLS', 'good');
        if (window.Hls && window.Hls.isSupported()) {
          hlsInstance = new Hls(buildHlsConfig());
          hlsInstance.loadSource(url);
          hlsInstance.attachMedia(videoEl);
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          playNatively(url); // دعم أصلي (Safari / iOS)
        } else {
          syncStatusText.textContent = 'المتصفح لا يدعم بث M3U8';
          return;
        }
        emptyState.classList.add('hidden');
        syncStatusText.textContent = 'تم تحميل الفيديو — جاهز للمشاهدة';
        startWatchdog();
      } else if (type === 'mp4' && window.ChunkedMp4Player && window.MediaSource && window.detectFragmentedMp4) {
        // فحص تلقائي: هل الملف مجزّأ؟ نقرر بناءً على النتيجة بدون أي تدخل من المستخدم
        setModeBadge('🔍 جارِ فحص الملف…', '');
        syncStatusText.textContent = 'جارِ فحص بنية الملف لاختيار أنسب طريقة تشغيل…';

        window.detectFragmentedMp4(url).then(function (result) {
          if (result.fragmented) {
            loadViaChunkedPlayer(url);
          } else {
            setModeBadge('▶️ تشغيل مباشر (الملف غير مجزّأ)', '');
            syncStatusText.textContent = 'الملف بصيغة MP4 عادية — تم استخدام التشغيل المباشر';
            ffmpegHintBtn.classList.remove('hidden'); // نتيح تلميح التحويل لمن يريد تفعيل المشغل المخصص لاحقًا
            playNatively(url);
          }
          startWatchdog();
        }).catch(function () {
          // تعذّر الفحص (غالبًا CORS أو الخادم لا يدعم Range) — رجوع آمن للتشغيل المباشر
          setModeBadge('▶️ تشغيل مباشر (تعذّر فحص الملف)', '');
          syncStatusText.textContent = 'تعذّر فحص الملف تلقائيًا — تم استخدام التشغيل المباشر';
          playNatively(url);
          startWatchdog();
        });

        emptyState.classList.add('hidden');
      } else {
        setModeBadge('▶️ تشغيل مباشر', '');
        playNatively(url);
        emptyState.classList.add('hidden');
        syncStatusText.textContent = 'تم تحميل الفيديو — جاهز للمشاهدة';
        startWatchdog();
      }

      if (persist) {
        if (useFirebase) {
          window.RoomBackend.setVideo(roomId, url, type, currentUser.id);
        } else {
          RoomStore.setVideo(roomId, url, type);
        }
        addSystemMessage(`${currentUser.name} غيّر الفيديو`);
      }
    }

    loadVideoBtn.addEventListener('click', function () {
      const url = videoUrlInput.value.trim();
      if (!url) return;
      loadVideoSource(url, true);
    });

    // إظهار/إخفاء لوحة إعدادات الاتصال الضعيف + تحديث حجم الكاش المعروض
    netSettingsToggle.addEventListener('click', function () {
      netSettingsPanel.classList.toggle('hidden');
      if (!netSettingsPanel.classList.contains('hidden') && window.ChunkedMp4Player) {
        window.ChunkedMp4Player.getCacheUsageMb().then(function (mb) {
          cacheUsageText.textContent = `${mb} ميجابايت`;
        }).catch(function () {
          cacheUsageText.textContent = 'غير متاح';
        });
      }
    });

    clearCacheBtn.addEventListener('click', function () {
      if (!window.ChunkedMp4Player) return;
      window.ChunkedMp4Player.clearAllCache().then(function () {
        cacheUsageText.textContent = '٠ ميجابايت';
        syncStatusText.textContent = 'تم مسح ذاكرة الفيديو المؤقتة';
      });
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

    /* ---- مزامنة التشغيل بين المشاهدين (تشغيل/إيقاف/تقديم) ----
       تُبث عبر فايربيس إن كان مُعدًّا، وإلا تبقى محلية فقط (RoomStore). */

    function broadcastPlay(currentTime) {
      if (useFirebase) window.RoomBackend.setPlayback(roomId, true, currentTime, currentUser.id);
      else RoomStore.setPlayback(roomId, true, currentTime);
    }

    function broadcastPause(currentTime) {
      if (useFirebase) window.RoomBackend.setPlayback(roomId, false, currentTime, currentUser.id);
      else RoomStore.setPlayback(roomId, false, currentTime);
    }

    function broadcastSeek(currentTime) {
      const isPlaying = !videoEl.paused;
      if (useFirebase) window.RoomBackend.setPlayback(roomId, isPlaying, currentTime, currentUser.id);
      else RoomStore.setPlayback(roomId, isPlaying, currentTime);
    }

    /** يُستدعى عند استقبال تحديث تشغيل من مستخدم آخر — يعوّض زمن الوصول (latency)
        حتى يبدأ الجميع من نفس اللحظة تقريبًا رغم اختلاف سرعة كل واحد */
    function applyRemotePlayback(playback) {
      suppressPlaybackEvents = true;

      let targetTime = playback.currentTime;
      if (playback.isPlaying && playback.updatedAt) {
        const now = useFirebase ? window.RoomBackend.serverNow() : Date.now();
        const elapsedSinceBroadcast = Math.max(0, (now - playback.updatedAt) / 1000);
        targetTime = playback.currentTime + elapsedSinceBroadcast;
      }

      if (Math.abs(videoEl.currentTime - targetTime) > 1.5) {
        videoEl.currentTime = targetTime;
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

    // عند التمرير لموضع غير محمَّل ووضع المشغل المخصص مفعّل — نطلب منه القفز
    videoEl.addEventListener('seeking', function () {
      if (chunkedPlayer) {
        chunkedPlayer.seekTo(videoEl.currentTime).catch(function () {});
      }
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

    /** يضيف رسالة واحدة فورًا للواجهة — يُستخدم مع اشتراك فايربيس (child_added) */
    function appendSingleMessage(msg) {
      if (chatEmptyEl.isConnected) chatEmptyEl.remove();
      chatMessagesEl.appendChild(buildMessageEl(msg));
      renderedMessageCount++;
      chatCountEl.textContent = `${renderedMessageCount} رسالة`;
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function addSystemMessage(text) {
      const message = { type: 'system', text, ts: Date.now() };
      if (useFirebase) {
        window.RoomBackend.sendMessage(roomId, message); // ستصل عبر الاشتراك وتُعرض تلقائيًا
      } else {
        RoomStore.addMessage(roomId, message);
        renderAllMessages(RoomStore.read(roomId).messages);
      }
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

      if (useFirebase) {
        window.RoomBackend.sendMessage(roomId, message); // يصل لي وللجميع عبر نفس الاشتراك
      } else {
        RoomStore.addMessage(roomId, message);
        renderAllMessages(RoomStore.read(roomId).messages);
      }

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

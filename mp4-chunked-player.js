/* =========================================================================
   كاشف تجزئة MP4 (Fragmentation Probe)
   -----------------------------------------------------------------------
   يحدد تلقائيًا إن كان ملف MP4 مجزّأً (fragmented) أم عاديًا، بقراءة
   "رؤوس الصناديق" (box headers) فقط — بضع عشرات البايتات لكل صندوق —
   دون تحميل أي جزء فعلي من محتوى الفيديو. هذا يسمح باختيار طريقة
   التشغيل المناسبة تلقائيًا لأي رابط، دون الحاجة لمعرفة مسبقة بصيغة
   الملف من قبل المستخدم.

   آلية عمل صيغة MP4 (ISO BMFF): الملف مبني من "صناديق" (boxes) متتالية،
   كل صندوق يبدأ بـ 4 بايت للحجم + 4 بايت للنوع (أو 16 بايت إذا كان
   الحجم أكبر من 32-bit). الملف المجزّأ يحتوي داخل صندوق "moov" على
   صندوق فرعي اسمه "mvex" — وجوده هو المعيار القياسي لتحديد التجزئة.
   ========================================================================= */

async function detectFragmentedMp4(url) {
  async function fetchHeader(offset) {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + 15}` } });
    if (!res.ok && res.status !== 206) throw new Error('range-not-supported');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 8) throw new Error('unexpected-eof');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    let size = dv.getUint32(0);
    let headerSize = 8;
    if (size === 1 && bytes.length >= 16) {
      size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
      headerSize = 16;
    } else if (size === 0) {
      size = Infinity;
    }
    return { size, type, headerSize };
  }

  // يبحث عن صندوق "mvex" كابن مباشر لصندوق moov الممتد من start إلى start+length
  async function moovHasMvex(start, length) {
    let offset = start;
    const end = start + length;
    for (let i = 0; i < 80 && offset < end; i++) {
      const { size, type, headerSize } = await fetchHeader(offset);
      if (type === 'mvex') return true;
      if (!isFinite(size) || size < headerSize) break;
      offset += size;
    }
    return false;
  }

  let offset = 0;
  for (let i = 0; i < 40; i++) {
    const { size, type, headerSize } = await fetchHeader(offset);

    if (type === 'moov') {
      const fragmented = await moovHasMvex(offset + headerSize, size - headerSize);
      return { fragmented, checked: true };
    }

    if (type === 'mdat') {
      // وصلنا لبيانات الوسائط قبل إيجاد moov — الملف غير مهيأ للبدء السريع
      // (moov في نهاية الملف)، وبالتالي غير مناسب للمشغل المخصص بأي حال
      return { fragmented: false, checked: true, moovAtEnd: true };
    }

    if (!isFinite(size) || size < headerSize) break;
    offset += size;
  }

  return { fragmented: false, checked: false };
}

window.detectFragmentedMp4 = detectFragmentedMp4;

/* =========================================================================
   VideoChunkCache — تخزين مؤقت دائم على القرص عبر IndexedDB
   -----------------------------------------------------------------------
   لماذا: ذاكرة المتصفح (RAM) محدودة وتُفرَّغ بمجرد إغلاق التبويب أو
   إعادة التحميل. بتخزين الأجزاء المُحمَّلة فعليًا على القرص عبر
   IndexedDB نحقق فائدتين:
     ١) ملفات ١ جيجابايت+ لا تُحمَّل بالكامل بذاكرة المتصفح دفعة واحدة —
        نُبقي بالذاكرة الحيّة (SourceBuffer) نافذة قصيرة فقط (retentionSeconds)
        بينما النسخة الكاملة تراكميًا محفوظة على القرص.
     ٢) لو أعاد المستخدم فتح الصفحة على نفس الرابط، يُستأنف التشغيل من
        حيث توقف دون إعادة تحميل ما سبق تحميله عبر الشبكة.

   حماية من امتلاء التخزين: سقف إجمالي (MAX_CACHE_BYTES) مع إخلاء تلقائي
   لأقدم الملفات استخدامًا (LRU) عند الحاجة لمساحة لملف جديد.
   ========================================================================= */

const CACHE_DB_NAME = 'movieTogetherVideoCache';
const CACHE_DB_VERSION = 1;
const CHUNKS_STORE = 'chunks';
const META_STORE = 'meta';
const MAX_CACHE_BYTES = 1.5 * 1024 * 1024 * 1024; // سقف افتراضي: ١.٥ جيجابايت لكل الملفات مجتمعة

function openCacheDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB غير مدعوم بهذا المتصفح')); return; }
    const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    req.onupgradeneeded = function (e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const store = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        store.createIndex('by_url', 'url', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class VideoChunkCache {
  constructor() { this._dbPromise = null; }
  _db() { if (!this._dbPromise) this._dbPromise = openCacheDB(); return this._dbPromise; }

  async getMeta(url) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async setMeta(meta) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllMeta() {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async putChunk(url, start, end, data) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNKS_STORE, 'readwrite');
      tx.objectStore(CHUNKS_STORE).put({ id: `${url}#${start}`, url, start, end, data });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** يعيد كل الأجزاء المخزّنة لرابط معيّن، مرتّبة حسب موضع البداية */
  async getChunksForUrl(url) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const idx = db.transaction(CHUNKS_STORE, 'readonly').objectStore(CHUNKS_STORE).index('by_url');
      const req = idx.getAll(IDBKeyRange.only(url));
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.start - b.start));
      req.onerror = () => reject(req.error);
    });
  }

  async deleteUrl(url) {
    const db = await this._db();
    const chunks = await this.getChunksForUrl(url);
    return new Promise((resolve, reject) => {
      const tx = db.transaction([CHUNKS_STORE, META_STORE], 'readwrite');
      const chunkStore = tx.objectStore(CHUNKS_STORE);
      chunks.forEach(c => chunkStore.delete(c.id));
      tx.objectStore(META_STORE).delete(url);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAll() {
    const all = await this.getAllMeta();
    for (const m of all) await this.deleteUrl(m.url);
  }

  async getTotalUsageBytes() {
    const all = await this.getAllMeta();
    return all.reduce((s, m) => s + (m.cachedBytes || 0), 0);
  }

  /** يخلي مساحة كافية لملف جديد بحذف أقدم الملفات استخدامًا (LRU) عند تجاوز السقف */
  async ensureQuota(incomingBytes) {
    let all = await this.getAllMeta();
    let total = all.reduce((s, m) => s + (m.cachedBytes || 0), 0);
    all.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
    while (total + incomingBytes > MAX_CACHE_BYTES && all.length) {
      const oldest = all.shift();
      total -= (oldest.cachedBytes || 0);
      await this.deleteUrl(oldest.url);
    }
  }
}

const videoCache = new VideoChunkCache();
window.MovieTogetherVideoCache = videoCache; // إتاحة عامة (مثلًا لزر "مسح الملفات المخزّنة" بالواجهة)

/* =========================================================================
   ChunkedMp4Player
   -----------------------------------------------------------------------
   مشغّل مخصّص بالكامل بجافاسكربت (بدون مكتبات) لملفات MP4 كبيرة الحجم
   (تصل لجيجابايت) على اتصالات بطيئة جدًا.

   الفكرة: بدل ترك المتصفح يقرر متى وكم يحمّل من الفيديو (سلوك أصلي غير
   قابل للتحكم وأحيانًا محافظ جدًا)، نحمّل الملف بأنفسنا على شكل أجزاء
   (Range requests) ونغذّي المتصفح بها مباشرة عبر MediaSource Extensions
   (MSE)، مع تحكّم كامل بحجم كل جزء، سرعة التحميل المسبق، وتفريغ الذاكرة.

   ⚠️ شرط أساسي: الملف يجب أن يكون MP4 "مجزّأ" (Fragmented MP4) وليس
   MP4 عاديًا. MSE لا يستطيع تشغيل ملف MP4 عادي بشكل تدريجي.

   لإنتاج ملف متوافق عبر ffmpeg:
     ffmpeg -i input.mp4 -c:v libx264 -c:a aac \
       -movflags frag_keyframe+empty_moov+default_base_moof \
       -f mp4 output.mp4

   أو تحويل ملف جاهز بدون إعادة ترميز (أسرع بكثير):
     ffmpeg -i input.mp4 -c copy \
       -movflags frag_keyframe+empty_moov+default_base_moof \
       -f mp4 output.mp4

   ⚠️ يتطلب أيضًا أن يدعم الخادم المستضيف للملف:
     - طلبات Range (رؤوس Accept-Ranges / Content-Range)
     - رؤوس CORS (Access-Control-Allow-Origin) لأن الجلب يتم عبر fetch()
       وليس عبر وسم <video> مباشرة (المتصفح يفرض CORS على fetch حتى لو
       كان نفس الملف يعمل مباشرة داخل <video src="...">).
   ========================================================================= */

class ChunkedMp4Player {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {Object} opts
   * @param {number} opts.chunkSize - حجم كل جزء بالبايت (افتراضي 2 ميجابايت)
   * @param {number} opts.maxBufferAheadSeconds - أقصى تخزين مسبق قبل إيقاف التحميل مؤقتًا (تحكم بالذاكرة وهدر البيانات)
   * @param {number} opts.retentionSeconds - كم ثانية نُبقيها خلف موضع التشغيل قبل تفريغها من الذاكرة
   * @param {function} opts.onProgress - callback(loadedBytes, totalBytes)
   * @param {function} opts.onError - callback(message)
   * @param {function} opts.onReady - callback() — أول جزء جاهز للتشغيل
   */
  constructor(videoEl, opts = {}) {
    this.video = videoEl;
    this.chunkSize = opts.chunkSize || 2 * 1024 * 1024; // 2MB افتراضيًا
    this.maxBufferAheadSeconds = opts.maxBufferAheadSeconds || 40;
    this.retentionSeconds = opts.retentionSeconds || 60;
    this.onProgress = opts.onProgress || function () {};
    this.onError = opts.onError || function () {};
    this.onReady = opts.onReady || function () {};

    // قائمة مرشّحة لسلاسل الترميز (Codec strings) — يُختار أول واحد مدعوم
    this.codecCandidates = opts.codecCandidates || [
      'video/mp4; codecs="avc1.64001F, mp4a.40.2"', // H.264 High
      'video/mp4; codecs="avc1.4D401F, mp4a.40.2"', // H.264 Main
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'  // H.264 Baseline
    ];

    this.mediaSource = null;
    this.sourceBuffer = null;
    this.url = null;
    this.totalBytes = 0;
    this.loadedBytes = 0;
    this.aborted = false;
    this.evictTimer = null;
  }

  /** يبدأ تحميل وتشغيل رابط MP4 مجزّأ */
  async load(url) {
    this.url = url;
    this.aborted = false;

    // 1) معرفة حجم الملف الكامل عبر HEAD (Content-Length مُتاح افتراضيًا
    //    عبر CORS لأنه من الرؤوس "الآمنة" المسموح قراءتها دائمًا)
    let head;
    try {
      head = await fetch(url, { method: 'HEAD' });
    } catch (e) {
      throw new Error('تعذّر الوصول للملف — تحقق من الرابط أو دعم CORS على الخادم');
    }
    const len = head.headers.get('content-length');
    if (!len) throw new Error('الخادم لا يوفر حجم الملف (Content-Length) — لا يمكن استخدام المشغل المخصص');
    this.totalBytes = parseInt(len, 10);

    const acceptsRanges = head.headers.get('accept-ranges');
    if (acceptsRanges && acceptsRanges.toLowerCase() === 'none') {
      throw new Error('الخادم لا يدعم طلبات Range — لا يمكن التحميل الجزئي');
    }

    // 2) اختيار أول codec مدعوم من المتصفح
    this.mimeType = this.codecCandidates.find(c => window.MediaSource && MediaSource.isTypeSupported(c));
    if (!this.mimeType) throw new Error('المتصفح لا يدعم أي من ترميزات الفيديو المتاحة');

    // 3) إنشاء MediaSource وربطه بعنصر الفيديو
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    await new Promise((resolve, reject) => {
      this.mediaSource.addEventListener('sourceopen', () => {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
          this.sourceBuffer.mode = 'sequence'; // الطوابع الزمنية تُبنى بالتسلسل بدل الاعتماد على tfdt المطلق
          resolve();
        } catch (e) {
          reject(e);
        }
      }, { once: true });
    });

    // 4) استرجاع أي أجزاء محفوظة سابقًا من IndexedDB لهذا الرابط بالذات
    //    (استئناف بدون شبكة إن كانت محفوظة، أو حجز مساحة كافية للتحميل الجديد)
    let cachedPrefixBytes = 0;
    try {
      const meta = await videoCache.getMeta(url);
      if (meta && meta.totalBytes === this.totalBytes) {
        const chunks = await videoCache.getChunksForUrl(url);
        let offset = 0;
        for (const c of chunks) {
          if (c.start !== offset) break; // أول فجوة تُوقف الاسترجاع — نكتفي بالتغطية المتصلة من البداية
          await this._appendBuffer(c.data);
          offset = c.end + 1;
        }
        cachedPrefixBytes = offset;
      } else if (meta) {
        await videoCache.deleteUrl(url); // الملف تغيّر أو الحجم غير مطابق — نمسح النسخة القديمة
      }
    } catch (e) { /* تعذّر الوصول لـ IndexedDB ليس خطأ حرجًا — نكمل بدون كاش */ }

    this.loadedBytes = cachedPrefixBytes;
    if (cachedPrefixBytes > 0) {
      this.onProgress(cachedPrefixBytes, this.totalBytes);
      this.onReady(); // لدينا محتوى جاهز فورًا من الكاش
    }

    try {
      await videoCache.ensureQuota(this.totalBytes - cachedPrefixBytes);
      await videoCache.setMeta({ url, totalBytes: this.totalBytes, mimeType: this.mimeType, cachedBytes: cachedPrefixBytes, lastAccessed: Date.now() });
    } catch (e) { /* تجاهل */ }

    // 5) بدء التحميل المتسلسل لما تبقى + مراقبة تفريغ الذاكرة الحيّة
    this._startEvictionLoop();
    this._pump().catch(err => this.onError(err.message || String(err)));
  }

  /** يحفظ جزءًا جديدًا بـ IndexedDB بعد نجاح تحميله (لا يعطّل حلقة التحميل عند الفشل) */
  async _persistChunk(start, end, buf) {
    try {
      await videoCache.putChunk(this.url, start, end, buf);
      await videoCache.setMeta({
        url: this.url, totalBytes: this.totalBytes, mimeType: this.mimeType,
        cachedBytes: this.loadedBytes, lastAccessed: Date.now()
      });
    } catch (e) { /* تجاهل — التخزين المؤقت تحسين اختياري وليس شرطًا للتشغيل */ }
  }

  /** حلقة التحميل الرئيسية: تجلب جزءًا، تنتظر التزاحم إن لزم، ثم تكرر */
  async _pump() {
    let firstChunk = true;

    while (!this.aborted && this.loadedBytes < this.totalBytes) {
      // تحكم بالتزاحم (Backpressure): لا تُحمّل أكثر مما يحتاجه التشغيل الحالي
      await this._waitForBackpressure();
      if (this.aborted) return;

      const start = this.loadedBytes;
      const end = Math.min(start + this.chunkSize - 1, this.totalBytes - 1);

      let res;
      try {
        res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } });
      } catch (e) {
        this.onError('انقطع الاتصال أثناء تحميل الفيديو');
        return;
      }

      if (!res.ok && res.status !== 206) {
        this.onError('الخادم رفض طلب الجزء — تحقق من دعم Range/CORS');
        return;
      }

      const buf = await res.arrayBuffer();

      try {
        await this._appendBuffer(buf);
      } catch (e) {
        this.onError('تعذّر تشغيل هذا الملف — تأكد أنه MP4 مجزّأ (fragmented) بترميز H.264/AAC');
        return;
      }

      this.loadedBytes = end + 1;
      this.onProgress(this.loadedBytes, this.totalBytes);
      this._persistChunk(start, end, buf); // غير حاجب — لا ننتظره لتفادي إبطاء التحميل

      if (firstChunk) {
        firstChunk = false;
        this.onReady();
      }
    }

    if (!this.aborted && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch (e) { /* تجاهل — قد يكون أُنهي مسبقًا */ }
    }
  }

  /** يضيف جزءًا إلى SourceBuffer وينتظر انتهاء المعالجة قبل المتابعة */
  _appendBuffer(buf) {
    return new Promise((resolve, reject) => {
      const onUpdateEnd = () => {
        this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        this.sourceBuffer.removeEventListener('error', onError);
        resolve();
      };
      const onError = (e) => {
        this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        this.sourceBuffer.removeEventListener('error', onError);
        reject(e);
      };
      this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
      this.sourceBuffer.addEventListener('error', onError);
      try {
        this.sourceBuffer.appendBuffer(buf);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** ينتظر إن كان المخزون الحالي أمام موضع التشغيل كافيًا (لتفادي تحميل أكثر من اللازم) */
  _waitForBackpressure() {
    return new Promise(resolve => {
      const check = () => {
        if (this.aborted) return resolve();
        const ahead = this._getBufferedAhead();
        if (ahead < this.maxBufferAheadSeconds) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  _getBufferedAhead() {
    if (!this.sourceBuffer || !this.video.buffered.length) return 0;
    const t = this.video.currentTime;
    for (let i = 0; i < this.video.buffered.length; i++) {
      if (this.video.buffered.start(i) - 0.5 <= t && t <= this.video.buffered.end(i)) {
        return this.video.buffered.end(i) - t;
      }
    }
    return 0;
  }

  /** يحذف دوريًا الأجزاء القديمة خلف موضع التشغيل لتفادي استهلاك ذاكرة زائد مع ملفات ١ جيجا+ */
  _startEvictionLoop() {
    this.evictTimer = setInterval(() => {
      if (!this.sourceBuffer || this.sourceBuffer.updating) return;
      const t = this.video.currentTime;
      if (t > this.retentionSeconds && this.video.buffered.length) {
        const removeEnd = t - this.retentionSeconds;
        try { this.sourceBuffer.remove(0, removeEnd); } catch (e) { /* تجاهل أخطاء التفريغ غير الحرجة */ }
      }
    }, 5000);
  }

  /** محاولة قفز تقريبية (Best-effort seek) لموضع لم يُحمَّل بعد — تعتمد على تقدير نسبة الحجم للزمن (تقريبي وليس دقيقًا لملفات VBR) */
  async seekTo(timeSeconds) {
    if (!this.sourceBuffer || !this.video.duration || !isFinite(this.video.duration)) return;

    const alreadyBuffered = Array.from({ length: this.video.buffered.length }, (_, i) => i)
      .some(i => this.video.buffered.start(i) <= timeSeconds && timeSeconds <= this.video.buffered.end(i));
    if (alreadyBuffered) {
      this.video.currentTime = timeSeconds; // ضمن ما تم تحميله فعلًا — قفز عادي
      return;
    }

    // خارج المخزَّن: نعيد البدء من نقطة بايت مقدّرة تقريبيًا (تقدير خطي)
    this.aborted = true;
    await this._waitForUpdateIdle();

    try {
      if (this.video.buffered.length) {
        this.sourceBuffer.remove(0, this.video.duration);
        await this._waitForUpdateIdle();
      }
    } catch (e) { /* تجاهل */ }

    const estimatedByte = Math.floor((timeSeconds / this.video.duration) * this.totalBytes);
    this.loadedBytes = Math.max(0, estimatedByte - (estimatedByte % this.chunkSize));
    this.aborted = false;

    this._pump().catch(err => this.onError(err.message || String(err)));
  }

  _waitForUpdateIdle() {
    return new Promise(resolve => {
      if (!this.sourceBuffer || !this.sourceBuffer.updating) return resolve();
      this.sourceBuffer.addEventListener('updateend', function handler() {
        this.removeEventListener('updateend', handler);
        resolve();
      });
    });
  }

  /** إيقاف كامل وتحرير الموارد (لا يحذف الكاش — يبقى محفوظًا للاستئناف لاحقًا) */
  destroy() {
    this.aborted = true;
    if (this.evictTimer) clearInterval(this.evictTimer);
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
    } catch (e) { /* تجاهل */ }
    if (this.video.src) {
      URL.revokeObjectURL(this.video.src);
    }
  }

  /** يمسح كل الفيديوهات المخزّنة مؤقتًا على القرص (زر "مسح الذاكرة المؤقتة" بالواجهة) */
  static clearAllCache() {
    return videoCache.clearAll();
  }

  /** حجم التخزين المؤقت المستخدم حاليًا بالميجابايت */
  static async getCacheUsageMb() {
    const bytes = await videoCache.getTotalUsageBytes();
    return (bytes / (1024 * 1024)).toFixed(1);
  }
}

// إتاحة الصنف عالميًا لاستخدامه من script.js
window.ChunkedMp4Player = ChunkedMp4Player;

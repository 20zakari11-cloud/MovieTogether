/* =========================================================================
   firebase-backend.js
   -----------------------------------------------------------------------
   الطبقة الحقيقية للمزامنة بين المستخدمين عبر Firebase Realtime Database.

   يُفعَّل هذا الملف نفسه تلقائيًا فقط إذا وجد إعدادًا صالحًا بملف
   firebase-config.js. إن لم يجد، يترك window.RoomBackend بحالة "غير
   متاح" ويستمر باقي الموقع بالعمل عبر localStorage كما كان (بدون كسر
   أي شيء) — راجع RoomStore بملف script.js.

   بنية البيانات على Firebase:
     rooms/{roomId}/
       video:    { url, type, updatedAt, updatedBy }
       playback: { isPlaying, currentTime, updatedAt, updatedBy }
       viewers/{userId}: { name, joinedAt }
       messages/{messageId}: { type, userId?, name?, text, ts }

   قواعد أمان مبسّطة مقترحة (الصقها بتبويب Rules بقاعدة البيانات):
     {
       "rules": {
         "rooms": {
           "$roomId": {
             ".read": true,
             ".write": true
           }
         }
       }
     }
   (بدون نظام دخول، أي شخص يملك رابط الغرفة يقدر يقرأ/يكتب فيها — نفس
   مبدأ الأمان "بالغموض" المستخدم أصلًا بمعرّف الغرفة العشوائي)
   ========================================================================= */

(function () {
  'use strict';

  const config = window.MOVIE_TOGETHER_FIREBASE_CONFIG;
  const isConfigured = !!(config && config.apiKey && config.databaseURL &&
    config.apiKey.indexOf('PASTE_YOUR') === -1);

  if (!isConfigured || typeof firebase === 'undefined') {
    // لا إعداد صالح (أو مكتبة فايربيس لم تُحمَّل) — الموقع يستمر محليًا فقط
    window.RoomBackend = { isAvailable: function () { return false; } };
    return;
  }

  firebase.initializeApp(config);
  const db = firebase.database();

  // تعويض فرق الساعة بين جهاز المستخدم وخوادم فايربيس، لحساب "كم ثانية
  // مرّت منذ آخر تحديث تشغيل" بدقة حتى لو ساعة الجهاز غير مضبوطة
  let serverTimeOffset = 0;
  db.ref('.info/serverTimeOffset').on('value', function (snap) {
    serverTimeOffset = snap.val() || 0;
  });

  function roomRef(roomId, path) {
    return db.ref(`rooms/${roomId}${path ? '/' + path : ''}`);
  }

  window.RoomBackend = {
    isAvailable: function () { return true; },

    /** الوقت الحالي بتوقيت خادم فايربيس (لتفادي فروقات ساعة الأجهزة) */
    serverNow: function () { return Date.now() + serverTimeOffset; },

    subscribeVideo: function (roomId, cb) {
      roomRef(roomId, 'video').on('value', function (snap) {
        const v = snap.val();
        if (v) cb(v);
      });
    },

    subscribePlayback: function (roomId, cb) {
      roomRef(roomId, 'playback').on('value', function (snap) {
        const p = snap.val();
        if (p) cb(p);
      });
    },

    subscribeViewers: function (roomId, cb) {
      roomRef(roomId, 'viewers').on('value', function (snap) {
        cb(snap.val() || {});
      });
    },

    /** يستمع فقط للرسائل الجديدة المضافة (أكفأ بكثير من إعادة تحميل كل السجل بكل مرة) */
    subscribeNewMessages: function (roomId, cb) {
      roomRef(roomId, 'messages').limitToLast(200).on('child_added', function (snap) {
        cb(snap.val());
      });
    },

    setVideo: function (roomId, url, type, userId) {
      return roomRef(roomId, 'video').set({
        url, type, updatedBy: userId,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      });
    },

    setPlayback: function (roomId, isPlaying, currentTime, userId) {
      return roomRef(roomId, 'playback').set({
        isPlaying, currentTime, updatedBy: userId,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      });
    },

    sendMessage: function (roomId, message) {
      return roomRef(roomId, 'messages').push(message);
    },

    /** يسجّل المستخدم كمشاهد نشط، ويزيله تلقائيًا فور قطع الاتصال
        (إغلاق التبويب، فقدان الشبكة، إلخ) عبر onDisconnect — أدق بكثير
        من أي محاولة تنظيف يدوية عند إغلاق الصفحة */
    joinAsViewer: function (roomId, userId, name) {
      const ref = roomRef(roomId, `viewers/${userId}`);
      ref.set({ name, joinedAt: firebase.database.ServerValue.TIMESTAMP });
      ref.onDisconnect().remove();
    },

    leaveRoom: function (roomId, userId) {
      return roomRef(roomId, `viewers/${userId}`).remove();
    }
  };
})();

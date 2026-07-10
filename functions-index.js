// functions/index.js
// GlowTrack — Cloud Function: изпраща FCM push за напомняния зададени от потребителя
// Деплой: firebase deploy --only functions
//
// v1.1 — ПОПРАВКА: атомарен "claim" на напомняне през Firestore transaction,
// за да не се пращат дубликати при паралелно/повторно изпълнение на cron-а
// (Pub/Sub scheduled functions имат at-least-once delivery — може да гръмне 2 пъти).

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

// Конвертира UTC Date в локална дата/час за Europe/Sofia (auto DST — зимно +2 / лятно +3)
function toSofiaTime(utcDate) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Sofia',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(utcDate);
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    timeStr: `${get('hour')}:${get('minute')}`,
  };
}

// Взима UTC offset за Europe/Sofia за дадена дата (auto DST)
function getSofiaOffsetHours(date) {
  const utcHour = date.getUTCHours();
  const sofiaHour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Sofia',
      hour: '2-digit', hour12: false,
    }).formatToParts(date).find(p => p.type === 'hour')?.value || '0'
  );
  let diff = sofiaHour - utcHour;
  if (diff < -12) diff += 24;
  if (diff > 12)  diff -= 24;
  return diff; // +2 зимно / +3 лятно
}

// Атомарно "заявява" право да прати push за конкретно напомняне.
// Връща true само ако успешно е маркирало notif.sent=true (никой друг не го е взел преди него).
async function claimNotif(userId, notifId) {
  const ref = db.collection('users').doc(userId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const notifs = snap.data()?.notifs || [];
    const idx = notifs.findIndex(n => n.id === notifId);
    if (idx === -1) return false;          // изтрито междувременно
    if (notifs[idx].sent) return false;    // вече е взето/пратено от друго изпълнение
    const updated = [...notifs];
    updated[idx] = { ...updated[idx], sent: true };
    tx.update(ref, { notifs: updated });
    return true;
  });
}

// Пуска се на всеки 5 минути — проверява напомняния в следващите 30 минути.
// (По-честият интервал прави времето на пристигане по-предвидимо спрямо зададения час,
//  вместо да чака до 30 мин и да пусне всичко накуп.)
exports.sendScheduledReminders = functions.pubsub
  .schedule('every 5 minutes')
  .timeZone('Europe/Sofia')
  .onRun(async () => {

    const now = new Date();
    const windowEnd = new Date(now.getTime() + 30 * 60 * 1000); // +30 минути

    const { dateStr: startDateStr, timeStr: startTimeStr } = toSofiaTime(now);
    const { dateStr: endDateStr,   timeStr: endTimeStr   } = toSofiaTime(windowEnd);
    console.log(`Проверка: ${startDateStr} ${startTimeStr} → ${endDateStr} ${endTimeStr} (Sofia)`);

    const usersSnapshot = await db.collection('users').get();
    const messages = [];

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const data = userDoc.data();
      const fcmToken = data.fcmToken;
      if (!fcmToken) continue;

      const notifs = data.notifs || [];
      if (!notifs.length) continue;

      for (const notif of notifs) {
        if (notif.sent) continue;
        if (!notif.date || !notif.time) continue;

        // Намираме UTC offset за тази дата в Sofia (DST автоматично)
        const refDate = new Date(notif.date + 'T12:00:00Z');
        const offsetHours = getSofiaOffsetHours(refDate);

        // Sofia local → UTC
        const [hh, mm] = notif.time.split(':').map(Number);
        const notifUtc = new Date(notif.date + 'T00:00:00Z');
        notifUtc.setUTCHours(hh - offsetHours, mm, 0, 0);

        // Попада ли в следващите 30 минути?
        if (notifUtc < now || notifUtc >= windowEnd) continue;

        // Атомарно "заявяваме" правото да пратим точно тази нотификация.
        // Ако друго паралелно/повторно изпълнение вече го е взело — прескачаме.
        const claimed = await claimNotif(userId, notif.id);
        if (!claimed) continue;

        const isBooking = notif.type === 'booking';
        const title = isBooking ? '📅 Резервация — GlowTrack' : '🔔 Напомняне — GlowTrack';
        const body  = notif.procName
          ? `${notif.procName} — ${notif.date} в ${notif.time}`
          : `${isBooking ? 'Резервация' : 'Напомняне'} в ${notif.time}`;

        messages.push({
          token: fcmToken,
          notification: { title, body },
          data: {
            notifId: notif.id    || '',
            procId:  notif.procId || '',
            type:    notif.type   || 'reminder',
            date:    notif.date,
            time:    notif.time,
          },
          apns: {
            payload: { aps: { sound: 'default', badge: 1 } },
          },
          android: {
            priority: 'high',
            notification: { sound: 'default', channelId: 'glowtrack_reminders' },
          },
        });

        console.log(`Push: ${userId} — ${notif.procName} на ${notif.date} в ${notif.time} (UTC+${offsetHours})`);
      }
    }

    if (messages.length > 0) {
      const response = await admin.messaging().sendEach(messages);
      console.log(`✅ Изпратени ${response.successCount}/${messages.length} нотификации`);
    } else {
      console.log('Няма напомняния за следващите 30 минути.');
    }

    return null;
  });

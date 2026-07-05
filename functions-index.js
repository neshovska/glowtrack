// functions/index.js
// GlowTrack — Cloud Function: изпраща FCM push за напомняния зададени от потребителя
// Деплой: firebase deploy --only functions

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
  // Handle midnight wraparound
  let diff = sofiaHour - utcHour;
  if (diff < -12) diff += 24;
  if (diff > 12)  diff -= 24;
  return diff; // +2 зимно / +3 лятно
}

// Пуска се всеки час — проверява чии напомняния са в следващите 60 минути
exports.sendScheduledReminders = functions.pubsub
  .schedule('0 * * * *')
  .timeZone('Europe/Sofia')
  .onRun(async () => {

    const now = new Date();
    const windowEnd = new Date(now.getTime() + 60 * 60 * 1000);

    const { dateStr: startDateStr, timeStr: startTimeStr } = toSofiaTime(now);
    const { dateStr: endDateStr,   timeStr: endTimeStr   } = toSofiaTime(windowEnd);
    console.log(`Проверка: ${startDateStr} ${startTimeStr} → ${endDateStr} ${endTimeStr} (Sofia)`);

    const usersSnapshot = await db.collection('users').get();
    const messages = [];
    const sentUpdates = [];

    for (const userDoc of usersSnapshot.docs) {
      const data = userDoc.data();
      const fcmToken = data.fcmToken;
      if (!fcmToken) continue;

      const notifs = data.notifs || [];
      if (!notifs.length) continue;

      for (const notif of notifs) {
        if (notif.sent) continue;
        if (!notif.date || !notif.time) continue;

        // Намираме UTC offset за тази дата в Sofia (DST автоматично)
        const refDate = new Date(notif.date + 'T12:00:00Z'); // обед UTC за offset
        const offsetHours = getSofiaOffsetHours(refDate);

        // Sofia local → UTC
        const [hh, mm] = notif.time.split(':').map(Number);
        const notifUtc = new Date(notif.date + 'T00:00:00Z');
        notifUtc.setUTCHours(hh - offsetHours, mm, 0, 0);

        // Попада ли в следващия час?
        if (notifUtc < now || notifUtc >= windowEnd) continue;

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

        sentUpdates.push({ userId: userDoc.id, notifId: notif.id });
        console.log(`Push: ${userDoc.id} — ${notif.procName} на ${notif.date} в ${notif.time} Sofia (UTC+${offsetHours})`);
      }
    }

    if (messages.length > 0) {
      const response = await admin.messaging().sendEach(messages);
      console.log(`✅ Изпратени ${response.successCount}/${messages.length} нотификации`);

      for (const { userId, notifId } of sentUpdates) {
        const userRef = db.collection('users').doc(userId);
        const snap    = await userRef.get();
        const notifs  = snap.data()?.notifs || [];
        const updated = notifs.map(n => n.id === notifId ? { ...n, sent: true } : n);
        await userRef.update({ notifs: updated });
      }
    } else {
      console.log('Няма напомняния за следващия час.');
    }

    return null;
  });

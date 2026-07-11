// functions/index.js
// GlowTrack — Cloud Function: изпраща push точно за записаните напомняния
// (users/{uid}.notifs = [{id, procId, procName, date, time, type, sent?}])
// Деплой: firebase deploy --only functions
//
// v2 — ПОПРАВКА: атомарен "claim" на всяко напомняне през Firestore transaction,
// за да не се пращат дубликати при паралелно/повторно изпълнение на cron-а
// (Cloud Scheduler / Pub/Sub имат at-least-once delivery — може да гръмне 2 пъти).

const {onSchedule} = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

function sofiaWallTimeToUTC(dateStr, timeStr) {
  const naive = new Date(`${dateStr}T${timeStr}:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Sofia",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(naive).reduce((a, p) => {
    a[p.type] = p.value; return a;
  }, {});
  const sofiaDisplayedAsUTC = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour === "24" ? 0 : parts.hour, parts.minute, parts.second,
  );
  const offsetMs = sofiaDisplayedAsUTC - naive.getTime();
  return new Date(naive.getTime() - offsetMs);
}

// Атомарно "заявява" право да прати push за конкретно напомняне.
// Връща true само ако успешно е маркирало notif.sent=true (никой друг не го е взел преди него).
async function claimNotif(userRef, notifId) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const notifs = snap.data()?.notifs || [];
    const idx = notifs.findIndex((n) => n.id === notifId);
    if (idx === -1) return false;          // изтрито междувременно
    if (notifs[idx].sent) return false;    // вече е взето/пратено от друго изпълнение
    const updated = [...notifs];
    updated[idx] = {...updated[idx], sent: true};
    tx.update(userRef, {notifs: updated});
    return true;
  });
}

exports.sendScheduledReminders = onSchedule(
    {
      schedule: "every 1 minutes",
      timeZone: "Europe/Sofia",
    },
    async (event) => {
      const now = new Date();
      const usersSnapshot = await db.collection("users").get();

      const messages = [];

      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        const fcmToken = userData.fcmToken;
        const notifs = userData.notifs;
        if (!fcmToken || !Array.isArray(notifs) || notifs.length === 0) continue;

        for (const n of notifs) {
          if (n.sent) continue;
          const notifDateTime = sofiaWallTimeToUTC(n.date, n.time || "10:00");
          const diffMinutes = (notifDateTime - now) / 60000;

          if (diffMinutes <= 0 && diffMinutes > -60 * 48) {
            // Атомарно "заявяваме" правото да пратим точно тази нотификация.
            // Ако друго паралелно/повторно изпълнение вече го е взело — прескачаме.
            const claimed = await claimNotif(userDoc.ref, n.id);
            if (!claimed) continue;

            const isBooking = n.type === "booking";
            messages.push({
              token: fcmToken,
              notification: {
                title: isBooking ? "GlowTrack — резервация" : "GlowTrack напомняне",
                body: n.procName ?
                  `${isBooking ? "Резервация за" : "Наближава"}: ${n.procName}` :
                  "Имаш предстояща процедура.",
              },
              data: {notifId: n.id, procId: n.procId || "", type: n.type || "reminder"},
            });
          }
        }
      }

      if (messages.length > 0) {
        const response = await admin.messaging().sendEach(messages);
        console.log(`Изпратени ${response.successCount}/${messages.length} напомняния.`);
      } else {
        console.log("Няма напомняния за изпращане в този цикъл.");
      }

      return null;
    },
);

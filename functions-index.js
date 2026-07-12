// functions/index.js
// GlowTrack — Cloud Functions
// (users/{uid}.notifs = [{id, procId, procName, date, time, type, sent?}])
// Деплой: firebase deploy --only functions
//
// v2 — ПОПРАВКА: атомарен "claim" на всяко напомняне през Firestore transaction,
// за да не се пращат дубликати при паралелно/повторно изпълнение на cron-а
// (Cloud Scheduler / Pub/Sub имат at-least-once delivery — може да гръмне 2 пъти).
//
// v4 — ПОПРАВКА: DATA-ONLY FCM payload вместо notification+data едновременно.
// Firebase Web SDK автоматично показва системно известие само от `notification`
// полето на payload-а, ПАРАЛЕЛНО с ръчния onBackgroundMessage handler в sw.js,
// който ТОЖЕ показва известие от същото съобщение. Резултат: 1 сървърно
// съобщение → 2 показани известия на устройството (реален корен на "дублиране",
// не грешка в claimNotif — сървърът винаги е пращал точно по едно съобщение).
// С data-only payload показването е изцяло под наш контрол, само от sw.js.
//
// v5 — ПОПРАВКА: премахнато notification: {} от sendScheduledReminders И от
// notifyOnUserMilestone. И двете функции вече пращат САМО data поле.

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

const ADMIN_UID = "7lNa6gWSDxb7kgR1AR8VEeKPgap2";
const MILESTONE_STEP = 100;

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

function computeNextReminderAtServer(notifs, now) {
  if (!Array.isArray(notifs) || !notifs.length) return null;
  let soonest = null;
  for (const n of notifs) {
    if (n.sent || !n.date) continue;
    try {
      const dt = sofiaWallTimeToUTC(n.date, n.time || "10:00");
      const diffMinutes = (dt - now) / 60000;
      if (diffMinutes <= -60 * 48) continue;
      if (!soonest || dt < soonest) soonest = dt;
    } catch (e) {}
  }
  return soonest ? soonest.toISOString() : null;
}

async function claimNotif(userRef, notifId, now) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const notifs = snap.data()?.notifs || [];
    const idx = notifs.findIndex((n) => n.id === notifId);
    if (idx === -1) return false;
    if (notifs[idx].sent) return false;
    const updated = [...notifs];
    updated[idx] = {...updated[idx], sent: true};
    const nextReminderAt = computeNextReminderAtServer(updated, now);
    tx.update(userRef, {notifs: updated, nextReminderAt});
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
      const usersSnapshot = await db.collection("users")
          .where("nextReminderAt", "<=", now.toISOString())
          .get();

      const messages = [];

      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        const fcmToken = userData.fcmToken;
        const notifs = userData.notifs;
        if (!fcmToken || !Array.isArray(notifs) || notifs.length === 0) continue;

        let anyClaimed = false;

        for (const n of notifs) {
          if (n.sent) continue;
          const notifDateTime = sofiaWallTimeToUTC(n.date, n.time || "10:00");
          const diffMinutes = (notifDateTime - now) / 60000;

          if (diffMinutes <= 0 && diffMinutes > -60 * 48) {
            const claimed = await claimNotif(userDoc.ref, n.id, now);
            if (!claimed) continue;
            anyClaimed = true;

            const isBooking = n.type === "booking";
            const title = isBooking ? "GlowTrack — резервация" : "GlowTrack напомняне";
            const body = n.procName ?
              `${isBooking ? "Резервация за" : "Наближава"}: ${n.procName}` :
              "Имаш предстояща процедура.";

            // DATA-ONLY — без notification поле!
            // notification поле кара Firebase SDK автоматично да показва известие,
            // паралелно с onBackgroundMessage в sw.js → двойни известия.
            messages.push({
              token: fcmToken,
              data: {
                title,
                body,
                notifId: n.id,
                procId: n.procId || "",
                type: n.type || "reminder",
              },
            });
          }
        }

        if (!anyClaimed) {
          const newNextReminderAt = computeNextReminderAtServer(notifs, now);
          if (newNextReminderAt !== (userData.nextReminderAt || null)) {
            await userDoc.ref.update({nextReminderAt: newNextReminderAt});
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


exports.notifyOnUserMilestone = onDocumentCreated("users/{uid}", async (event) => {
  const counterRef = db.collection("meta").doc("userCounter");
  const processedRef = counterRef.collection("processedEvents").doc(event.id);

  let milestoneReached = null;

  await db.runTransaction(async (tx) => {
    const processedSnap = await tx.get(processedRef);
    if (processedSnap.exists) return;

    const counterSnap = await tx.get(counterRef);
    const currentCount = counterSnap.exists ? (counterSnap.data().count || 0) : 0;
    const newCount = currentCount + 1;

    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000);
    tx.set(processedRef, {expiresAt});
    tx.set(counterRef, {count: newCount}, {merge: true});

    if (newCount % MILESTONE_STEP === 0) {
      milestoneReached = newCount;
    }
  });

  if (milestoneReached === null) return null;

  const adminSnap = await db.collection("users").doc(ADMIN_UID).get();
  const adminToken = adminSnap.data()?.fcmToken;
  if (!adminToken) {
    console.log(`Milestone ${milestoneReached} достигнат, но админ няма fcmToken.`);
    return null;
  }

  try {
    // DATA-ONLY — без notification поле!
    await admin.messaging().send({
      token: adminToken,
      data: {
        title: "GlowTrack — нов milestone",
        body: `Достигнахте ${milestoneReached} регистрирани потребители!`,
      },
    });
    console.log(`Milestone push изпратен: ${milestoneReached} потребители.`);
  } catch (e) {
    console.error("Грешка при изпращане на milestone push:", e);
  }

  return null;
});


const AI_DAILY_LIMIT = 5;
const AI_MODEL = "claude-haiku-4-5-20251001";

function todaySofiaDateStr() {
  return new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/Sofia"}).format(new Date());
}

exports.askAiAssistant = onCall(
    {secrets: [anthropicApiKey]},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Трябва да си логната.");
      }
      const uid = request.auth.uid;
      const data = request.data || {};

      const systemPrompt = (data.systemPrompt || "").toString().slice(0, 2000);
      const messages = Array.isArray(data.messages) ? data.messages.slice(-20) : [];
      if (!messages.length) {
        throw new HttpsError("invalid-argument", "Липсва съобщение.");
      }

      const userRef = db.collection("users").doc(uid);
      const today = todaySofiaDateStr();

      const txResult = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const usage = snap.exists ? (snap.data().aiUsage || {}) : {};
        const currentCount = usage.date === today ? (usage.count || 0) : 0;

        if (currentCount >= AI_DAILY_LIMIT) {
          return {allowed: false, newCount: currentCount};
        }
        const newCount = currentCount + 1;
        tx.set(userRef, {
          aiUsage: {date: today, count: newCount},
        }, {merge: true});
        return {allowed: true, newCount};
      });

      if (!txResult.allowed) {
        throw new HttpsError(
            "resource-exhausted",
            `Достигнахте дневния лимит от ${AI_DAILY_LIMIT} въпроса. Опитайте пак утре.`,
        );
      }

      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicApiKey.value(),
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: AI_MODEL,
            max_tokens: 1000,
            system: systemPrompt,
            messages: messages,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          console.error("Anthropic API грешка:", resp.status, errText);
          throw new HttpsError("internal", "Грешка при връзка с AI.");
        }

        const result = await resp.json();
        const reply = result?.content?.[0]?.text || "Нещо се обърка. Опитай пак.";

        return {
          reply,
          remaining: AI_DAILY_LIMIT - txResult.newCount,
        };
      } catch (e) {
        if (e instanceof HttpsError) throw e;
        console.error("askAiAssistant грешка:", e);
        throw new HttpsError("internal", "Грешка при връзка с AI.");
      }
    },
);

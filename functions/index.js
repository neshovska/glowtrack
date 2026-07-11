// functions/index.js
// GlowTrack — Cloud Functions
// (users/{uid}.notifs = [{id, procId, procName, date, time, type, sent?}])
// Деплой: firebase deploy --only functions
//
// v2 — ПОПРАВКА: атомарен "claim" на всяко напомняне през Firestore transaction,
// за да не се пращат дубликати при паралелно/повторно изпълнение на cron-а
// (Cloud Scheduler / Pub/Sub имат at-least-once delivery — може да гръмне 2 пъти).

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

// Админ на GlowTrack — получава push при всеки milestone от +100 нови регистрации.
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

// Огледален вариант на window._computeNextReminderAt от index.html — трябва двете
// да остават синхронизирани по логика. Пропуска notifs, по-стари от 48ч прозореца
// за изпращане, за да не остане nextReminderAt "заклещено" в миналото завинаги.
function computeNextReminderAtServer(notifs, now) {
  if (!Array.isArray(notifs) || !notifs.length) return null;
  let soonest = null;
  for (const n of notifs) {
    if (n.sent || !n.date) continue;
    try {
      const dt = sofiaWallTimeToUTC(n.date, n.time || "10:00");
      const diffMinutes = (dt - now) / 60000;
      if (diffMinutes <= -60 * 48) continue; // твърде остаряло, никога няма да се прати
      if (!soonest || dt < soonest) soonest = dt;
    } catch (e) {}
  }
  return soonest ? soonest.toISOString() : null;
}

// Атомарно "заявява" право да прати push за конкретно напомняне.
// Връща true само ако успешно е маркирало notif.sent=true (никой друг не го е взел преди него).
// Обновява и nextReminderAt в същата transaction, за да остане полето винаги точно.
async function claimNotif(userRef, notifId, now) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const notifs = snap.data()?.notifs || [];
    const idx = notifs.findIndex((n) => n.id === notifId);
    if (idx === -1) return false;          // изтрито междувременно
    if (notifs[idx].sent) return false;    // вече е взето/пратено от друго изпълнение
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
      // v3: заявяваме само "назрели" потребители по nextReminderAt, вместо цялата
      // users колекция. nextReminderAt се пази като ISO string (виж
      // computeNextReminderAtServer / window._computeNextReminderAt), затова
      // лексикографското <= сравнение съвпада с хронологичното.
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
            // Атомарно "заявяваме" правото да пратим точно тази нотификация.
            // Ако друго паралелно/повторно изпълнение вече го е взело — прескачаме.
            const claimed = await claimNotif(userDoc.ref, n.id, now);
            if (!claimed) continue;
            anyClaimed = true;

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

        // Self-healing: ако в този цикъл не сме claim-нали нищо за потребителя
        // (напр. всички останали notifs вече са извън 48ч прозореца за изпращане),
        // nextReminderAt няма да се обнови от claimNotif. Преизчисляваме го тук ръчно,
        // за да не влиза потребителят в заявката отново и отново завинаги.
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


// ═══════════════════════════════════════════════════════════
// MILESTONE УВЕДОМЛЕНИЯ
// ═══════════════════════════════════════════════════════════

exports.notifyOnUserMilestone = onDocumentCreated("users/{uid}", async (event) => {
  const counterRef = db.collection("meta").doc("userCounter");
  // Идемпотентност: Firestore Eventarc тригерите имат at-least-once доставка —
  // едно и също събитие може да пристигне повторно при retry. Пазим event.id,
  // за да не преброим един и същ нов потребител два пъти.
  const processedRef = counterRef.collection("processedEvents").doc(event.id);

  let milestoneReached = null;

  await db.runTransaction(async (tx) => {
    const processedSnap = await tx.get(processedRef);
    if (processedSnap.exists) return; // вече обработено — дублирана доставка на събитието

    const counterSnap = await tx.get(counterRef);
    const currentCount = counterSnap.exists ? (counterSnap.data().count || 0) : 0;
    const newCount = currentCount + 1;

    // TTL полето пази бъдещ момент на изтичане (сега + 30 дни), не момента на
    // създаване — Firestore TTL policy трие документа автоматично след тази дата.
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
    await admin.messaging().send({
      token: adminToken,
      notification: {
        title: "GlowTrack — нов milestone 🎉",
        body: `Достигнахте ${milestoneReached} регистрирани потребители!`,
      },
    });
    console.log(`Milestone push изпратен: ${milestoneReached} потребители.`);
  } catch (e) {
    console.error("Грешка при изпращане на milestone push:", e);
  }

  return null;
});


// ═══════════════════════════════════════════════════════════
// AI АСИСТЕНТ
// ═══════════════════════════════════════════════════════════

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

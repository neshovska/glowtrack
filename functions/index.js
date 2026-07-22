// functions/index.js
// GlowTrack — Cloud Functions
// (users/{uid}.notifs = [{id, procId, procName, date, time, type, sent?}])
// Деплой: firebase deploy --only functions
//
// v2 — ПОПРАВКА: атомарен "claim" на всяко напомняне през Firestore transaction,
// за да не се пращат дубликати при паралелно/повторно изпълнение на cron-а
// (Cloud Scheduler / Pub/Sub имат at-least-once delivery — може да гръмне 2 пъти).
// CI test commit: проверка дали deploy-functions.yml минава след .env fix-а.

const crypto = require("crypto");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {defineSecret, defineString} = require("firebase-functions/params");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
admin.initializeApp();

// Всички функции в един регион — europe-west1, colocated с Firestore (eur3),
// за да няма cross-region hop при Firestore тригери (onDocumentCreated) и по-ниска
// latency общо. Firestore базата не може да се мести без пресъздаване, затова
// функциите се местят към нея, не обратното.
setGlobalOptions({region: "europe-west1"});

const db = admin.firestore();
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

// SMTP за админ имейл известия (напр. B2B запитвания от клиники).
// info@glowtrack.eu е хоствана в Zoho Mail (EU регион) — smtp.zoho.eu,
// SSL порт 465. USER/PASS са тайни — задават се веднъж през:
//   firebase functions:secrets:set SMTP_USER   (пълният имейл: info@glowtrack.eu)
//   firebase functions:secrets:set SMTP_PASS   (Zoho паролата / app-specific password)
const smtpHost = defineString("SMTP_HOST", {default: "smtp.zoho.eu"});
const smtpPort = defineString("SMTP_PORT", {default: "465"});
const smtpUser = defineSecret("SMTP_USER");
const smtpPass = defineSecret("SMTP_PASS");
const CLINIC_NOTIFICATION_EMAIL = "info@glowtrack.eu";

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

// Форматира UTC момент като дата/час по Sofia стенен час, за текста на push
// известието (напр. "15.07.2026" / "10:00").
function formatSofiaDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Sofia",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).reduce((a, p) => {
    a[p.type] = p.value; return a;
  }, {});
  const dateStr = `${parts.day}.${parts.month}.${parts.year}`;
  const timeStr = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  return {dateStr, timeStr};
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
            const title = isBooking ? "GlowTrack — резервация" : "GlowTrack напомняне";
            const {dateStr, timeStr} = formatSofiaDateTime(notifDateTime);
            const body = n.procName ?
              `${isBooking ? "Резервация за" : "Наближава"}: ${n.procName} — ${dateStr} в ${timeStr}` :
              "Имаш предстояща процедура.";
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
// РОЖДЕНИ ДНИ
// ═══════════════════════════════════════════════════════════

// Веднъж дневно (не всяка минута като напомнянията) — пълно сканиране на
// users е приемливо тук заради ниската честота на изпълнение. lastBirthdayYear
// пази годината, в която последно е пратено поздравление, за да не се
// дублира при retry на Cloud Scheduler (at-least-once delivery) или ако
// рожденият ден се провери повторно в рамките на същата година.
exports.sendBirthdayNotifications = onSchedule(
    {
      schedule: "every day 09:00",
      timeZone: "Europe/Sofia",
    },
    async (event) => {
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Sofia",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(now).reduce((a, p) => {
        a[p.type] = p.value; return a;
      }, {});
      const todayMMDD = `${parts.month}-${parts.day}`;
      const currentYear = parseInt(parts.year, 10);

      const usersSnapshot = await db.collection("users").get();
      const messages = [];
      const claimed = [];

      for (const userDoc of usersSnapshot.docs) {
        const data = userDoc.data();
        if (!data.dob || !data.fcmToken) continue;
        if (typeof data.dob !== "string" || data.dob.length < 10) continue;
        const dobMMDD = data.dob.slice(5, 10); // "YYYY-MM-DD" -> "MM-DD"
        if (dobMMDD !== todayMMDD) continue;
        if (data.lastBirthdayYear === currentYear) continue; // вече поздравен тази година

        claimed.push(userDoc.ref);
        messages.push({
          token: data.fcmToken,
          data: {
            title: "GlowTrack",
            body: "Честит рожден ден! Пожелаваме ти красива и сияйна година напред.",
            type: "birthday",
          },
        });
      }

      if (messages.length > 0) {
        const response = await admin.messaging().sendEach(messages);
        console.log(`Рожденодневни известия: ${response.successCount}/${messages.length}`);
        await Promise.all(claimed.map((ref) =>
          ref.update({lastBirthdayYear: currentYear}).catch(() => {}),
        ));
      } else {
        console.log("Няма рождени дни днес.");
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


// ═══════════════════════════════════════════════════════════
// REFERRAL СИСТЕМА — "успешен" referral при ПЪРВИ diary entry
// ═══════════════════════════════════════════════════════════

// Кумулативни нива — трябва да остане синхронизирано с REFERRAL_MILESTONES
// в index.html (Profile "Покани приятели" секция).
const REFERRAL_REWARD_THRESHOLDS = [
  {count: 1, key: "badge"},
  {count: 2, key: "rosegold_theme"},
  {count: 3, key: "archetype_test"},
  {count: 5, key: "level4_locked"},
];

// Server-side близнак на _generateReferralCode() в index.html — byte-идентична
// (SHA-256 hash на uid, пресечен до 7 символа през същия alphabet; crypto.createHash
// в Node дава същия digest като браузърния crypto.subtle, само API-то е различно).
// ВАЖНО: ако някога промениш алгоритъма в index.html, промени го синхронно и тук.
//
// Firestore Rules за /referrals позволяват на всеки signed-in потребител да създаде
// 'pending' документ с произволен referrerUid (проверяват само refereeUid ==
// request.auth.uid) — самò съвпадение между referrerUid и referralCode В ДОКУМЕНТА
// не доказва нищо, защото атакуващият контролира и двете полета в един и същ write.
// Затова кодът тук се преизчислява НЕЗАВИСИМО от referrerUid и се сравнява с
// подадения referralCode, вместо да се вярва на клиентски подадени стойности.
const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // без 0/O, 1/I
function generateReferralCode(uid) {
  const hash = crypto.createHash("sha256").update(uid).digest();
  let code = "";
  for (let i = 0; i < 7; i++) {
    code += REFERRAL_CODE_ALPHABET[hash[i] % REFERRAL_CODE_ALPHABET.length];
  }
  return code;
}

// Anti-fraud: регистрацията сама по себе си НЕ брои referral — само след като
// доведеният приятел добави поне 1 запис в дневника (виж _applyReferralSignup
// в index.html, което създава 'pending' документ в referrals при регистрация
// през ?ref=CODE линк). Тук маркираме completed и увеличаваме referralCount на
// referrer-а, но само при ПЪРВИЯ diary entry на доведения — проверено чрез
// query в същата транзакция, не чрез отделен брояч на потребителя.
exports.onDiaryEntryCreated = onDocumentCreated("diary_entries/{entryId}", async (event) => {
  const data = event.data?.data();
  if (!data || !data.userId) return null;
  const uid = data.userId;

  const processedRef = db.collection("meta").doc("referralEvents")
      .collection("processedEvents").doc(event.id);

  // Извън транзакцията — Admin Auth API не е част от Firestore transaction
  // модела; еднократен lookup, не искаме да се повтаря при transaction retry.
  // Anti-abuse: mass fake/disposable-email акаунти за farming на referral
  // rewards са по-трудни, ако наградата изисква потвърден имейл на доведения.
  let refereeEmailVerified = false;
  try {
    const refereeAuthRecord = await admin.auth().getUser(uid);
    refereeEmailVerified = !!refereeAuthRecord.emailVerified;
  } catch (e) {
    console.error(`Неуспешен getUser(${uid}) за referral email verification проверка:`, e);
  }

  try {
    await db.runTransaction(async (tx) => {
      // ---- всички reads първо (Firestore transaction изисква reads преди writes) ----
      const processedSnap = await tx.get(processedRef);
      if (processedSnap.exists) return; // дублирана доставка на събитието (retry)

      const entriesSnap = await tx.get(
          db.collection("diary_entries").where("userId", "==", uid),
      );
      const isFirstEntry = entriesSnap.size === 1; // включва и току-що създадения документ

      let referralDoc = null; let referrerRef = null;
      let referrerData = null; let newCount = null;
      let invalidReferralDoc = null; let invalidReason = null;

      if (isFirstEntry) {
        const userSnap = await tx.get(db.collection("users").doc(uid));
        const userData = userSnap.exists ? userSnap.data() : {};
        if (userData.referredBy) {
          const referralsSnap = await tx.get(
              db.collection("referrals")
                  .where("refereeUid", "==", uid)
                  .where("status", "==", "pending"),
          );
          if (!referralsSnap.empty) {
            const candidateDoc = referralsSnap.docs[0];
            const candidateData = candidateDoc.data();
            const expectedCode = generateReferralCode(candidateData.referrerUid);
            if (expectedCode !== candidateData.referralCode) {
              // referrerUid не притежава referralCode-а в документа — подправен/
              // невалиден referral claim. Не кредитираме нищо.
              invalidReferralDoc = candidateDoc;
              invalidReason = "referral_code_mismatch";
              console.warn(
                  `Referral fraud опит уловен: referrerUid=${candidateData.referrerUid} ` +
                  `твърди код ${candidateData.referralCode}, реалният му код е ${expectedCode} ` +
                  `(refereeUid=${uid}, referralId=${candidateDoc.id})`,
              );
            } else if (!refereeEmailVerified) {
              // Кодът е верен, но доведеният няма потвърден имейл — не маркираме
              // rejected (за разлика от code mismatch): непотвърден имейл е
              // ВРЕМЕННО състояние, не искаме перманентно да наказваме легитимен
              // потребител, който просто още не е кликнал verification линка към
              // момента на първия си diary entry. Оставаме на 'pending' (известно
              // ограничение: няма re-trigger механизъм да го преоцени по-късно,
              // ако потвърди имейла след това — приемлив compromise за defense-
              // in-depth срещу mass fake-акаунти, не е критичен UX path).
              console.log(
                  `Referral не се кредитира — refereeUid=${uid} няма потвърден ` +
                  `имейл (referralId=${candidateDoc.id}).`,
              );
            } else {
              referralDoc = candidateDoc;
              referrerRef = db.collection("users").doc(candidateData.referrerUid);
              const referrerSnap = await tx.get(referrerRef);
              referrerData = referrerSnap.exists ? referrerSnap.data() : {};
              newCount = (referrerData.referralCount || 0) + 1;
            }
          }
        }
      }

      // ---- сега всички writes ----
      const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000);
      tx.set(processedRef, {expiresAt});

      if (referralDoc && referrerRef) {
        const unlockedRewards = new Set(referrerData.unlockedRewards || []);
        REFERRAL_REWARD_THRESHOLDS.forEach((r) => {
          if (newCount >= r.count) unlockedRewards.add(r.key);
        });
        tx.update(referralDoc.ref, {
          status: "completed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.set(referrerRef, {
          referralCount: newCount,
          unlockedRewards: Array.from(unlockedRewards),
        }, {merge: true});
      } else if (invalidReferralDoc) {
        tx.update(invalidReferralDoc.ref, {
          status: "rejected",
          rejectedReason: invalidReason,
          rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (e) {
    console.error("onDiaryEntryCreated (referral) грешка:", e);
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


// ═══════════════════════════════════════════════════════════
// B2B КЛИНИКИ — ИМЕЙЛ ИЗВЕСТИЕ ПРИ НОВО ЗАПИТВАНЕ
// ═══════════════════════════════════════════════════════════

// Landing страницата (#for-clinics в index.html) пише директно в тази
// колекция от клиента (window.submitClinicInquiry). Тук само известяваме
// администратора по имейл — самият запис вече е направен.
exports.notifyOnClinicInquiry = onDocumentCreated(
    {document: "clinic_inquiries/{docId}", secrets: [smtpUser, smtpPass]},
    async (event) => {
      const data = event.data?.data();
      if (!data) return null;

      const port = parseInt(smtpPort.value(), 10) || 465;
      const transporter = nodemailer.createTransport({
        host: smtpHost.value(),
        port,
        secure: port === 465,
        auth: {user: smtpUser.value(), pass: smtpPass.value()},
      });

      const PARTNER_TYPE_LABELS = {
        clinics: "Клиника",
        distributors: "Дистрибутор",
        brands: "Козметичен бранд",
        training: "Обучителен център",
      };
      const partnerTypeLabel = PARTNER_TYPE_LABELS[data.partnerType] || data.partnerType || "—";

      const summary = [
        `Тип партньор: ${partnerTypeLabel}`,
        `Име: ${data.clinicName || "—"}`,
        `Град: ${data.city || "—"}`,
        `Имейл: ${data.email || "—"}`,
        `Телефон: ${data.phone || "—"}`,
        `План: ${data.plan || "—"}`,
      ].join("\n");

      try {
        await transporter.sendMail({
          from: `"GlowTrack" <${smtpUser.value()}>`,
          to: CLINIC_NOTIFICATION_EMAIL,
          replyTo: data.email || undefined,
          subject: `Ново B2B запитване (${partnerTypeLabel}) — ${data.clinicName || "—"} (${data.plan || "—"})`,
          text: `Получено е ново запитване от партньор през glowtrack.eu/#for-clinics:\n\n${summary}`,
        });
        console.log("Имейл известие за клиника изпратено:", data.clinicName);
      } catch (e) {
        console.error("Грешка при изпращане на имейл известие за клиника:", e);
      }
      return null;
    },
);


// ═══════════════════════════════════════════════════════════
// БРАНДИРАН PASSWORD RESET — праща от info@glowtrack.eu вместо
// Firebase-default noreply@<project>.firebaseapp.com
// ═══════════════════════════════════════════════════════════

// Anti-spam throttle — две независими граници, проверени в ЕДНА транзакция:
// 1) per-email — max PASSWORD_RESET_PER_EMAIL_HOURLY_LIMIT заявки/час, спира
//    targeted harassment на конкретен имейл.
// 2) global — max PASSWORD_RESET_GLOBAL_PER_MINUTE_LIMIT заявки/минута общо,
//    независимо от email, спира volumetric/enumeration abuse (много различни
//    имейли). Важно е, защото тази функция споделя SMTP акаунта (smtpUser/
//    smtpPass) с notifyOnClinicInquiry — sustained spam риск да маркира
//    акаунта abuse при доставчика (Zoho), което би счупило и B2B известията.
// Проверката е ПРЕДИ generatePasswordResetLink, за да важи и за несъществуващи
// имейли (enumeration probing) — старата логика пишеше throttle-а само СЛЕД
// успешен generatePasswordResetLink, оставяйки unknown-email заявки напълно
// нелимитирани.
// Fixed-window bucket-и (час/минута), не sliding window — по-прост модел,
// същия паттърн като AI_DAILY_LIMIT по-долу; worst case позволява ~2x burst
// близо до границата на bucket-а, приемлив компромис за простота.
const PASSWORD_RESET_PER_EMAIL_HOURLY_LIMIT = 3;
const PASSWORD_RESET_GLOBAL_PER_MINUTE_LIMIT = 20;

exports.sendBrandedPasswordReset = onCall(
    {secrets: [smtpUser, smtpPass]},
    async (request) => {
      const email = (request.data?.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        throw new HttpsError("invalid-argument", "Невалиден имейл адрес.");
      }

      const now = Date.now();
      const hourBucket = Math.floor(now / (60 * 60 * 1000));
      const minuteBucket = Math.floor(now / (60 * 1000));
      const emailThrottleRef = db.collection("password_reset_throttle").doc(email);
      // "_global" е reserved doc ID — не може да съвпадне с реален имейл (винаги съдържа "@").
      const globalThrottleRef = db.collection("password_reset_throttle").doc("_global");

      const throttle = await db.runTransaction(async (tx) => {
        const [emailSnap, globalSnap] = await Promise.all([
          tx.get(emailThrottleRef),
          tx.get(globalThrottleRef),
        ]);

        const emailData = emailSnap.exists ? emailSnap.data() : {};
        const emailCount = emailData.hourBucket === hourBucket ? (emailData.count || 0) : 0;
        if (emailCount >= PASSWORD_RESET_PER_EMAIL_HOURLY_LIMIT) {
          return {allowed: false, reason: "per-email"};
        }

        const globalData = globalSnap.exists ? globalSnap.data() : {};
        const globalCount = globalData.minuteBucket === minuteBucket ? (globalData.count || 0) : 0;
        if (globalCount >= PASSWORD_RESET_GLOBAL_PER_MINUTE_LIMIT) {
          return {allowed: false, reason: "global"};
        }

        tx.set(emailThrottleRef, {hourBucket, count: emailCount + 1});
        tx.set(globalThrottleRef, {minuteBucket, count: globalCount + 1});
        return {allowed: true};
      });

      if (!throttle.allowed) {
        // тих no-op, не разкриваме throttle статус на клиента (anti-enumeration)
        console.log(`Password reset throttled (${throttle.reason}) за ${throttle.reason === "per-email" ? email : "global limit"}.`);
        return {ok: true};
      }

      // url тук е само continueUrl fallback — не се използва реално, защото по-долу
      // строим собствен линк към glowtrack.eu с самия oobCode. glowtrack.eu пак
      // трябва да е в Authentication > Settings > Authorized domains, иначе
      // generatePasswordResetLink хвърля auth/unauthorized-continue-uri.
      const actionCodeSettings = {url: "https://glowtrack.eu/"};

      let resetLink;
      try {
        resetLink = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);
      } catch (e) {
        // auth/user-not-found и др. — НЕ разкриваме дали имейлът съществува
        // (anti-enumeration). Просто не пращаме нищо, но връщаме success.
        console.log(`Password reset заявка за непознат/невалиден имейл (не се разкрива на клиента).`);
        return {ok: true};
      }

      // Firebase-генерираният линк сочи към after-care-treatment.firebaseapp.com/__/auth/action
      // (Firebase-хостната action-handler страница), защото glowtrack.eu не е Firebase Hosting
      // сайт (в момента е GitHub Pages) — само custom domain, свързан през Firebase Hosting,
      // би сменил това. Вместо да минаваме по този път (DNS промени, риск), извличаме oobCode-а
      // от генерирания линк и строим собствен URL към glowtrack.eu — index.html сам разпознава
      // ?mode=resetPassword&oobCode=... и показва форма за нова парола. oobCode-ът е валиден
      // независимо от кой домейн е сервиран линкът — Firebase го проверява по стойността му.
      const oobCode = new URL(resetLink).searchParams.get("oobCode");
      if (!oobCode) {
        console.error("generatePasswordResetLink не върна oobCode в линка.");
        throw new HttpsError("internal", "Грешка при генериране на линка.");
      }
      const brandedResetLink = `https://glowtrack.eu/?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`;

      const port = parseInt(smtpPort.value(), 10) || 465;
      const transporter = nodemailer.createTransport({
        host: smtpHost.value(),
        port,
        secure: port === 465,
        auth: {user: smtpUser.value(), pass: smtpPass.value()},
      });

      try {
        await transporter.sendMail({
          from: `"GlowTrack" <${smtpUser.value()}>`,
          to: email,
          subject: "GlowTrack — възстановяване на парола",
          text: `Здравей,\n\nПолучихме заявка за нова парола за твоя GlowTrack акаунт.\n\n` +
            `Натисни линка по-долу, за да зададеш нова парола:\n${brandedResetLink}\n\n` +
            `Ако не си заявявала това, просто игнорирай този имейл — паролата ти няма да се промени.\n\n` +
            `— Екипът на GlowTrack`,
        });
        console.log(`Branded password reset изпратен успешно.`);
      } catch (e) {
        console.error("Грешка при изпращане на password reset имейл:", e);
        throw new HttpsError("internal", "Грешка при изпращане на имейла.");
      }

      return {ok: true};
    },
);

// ═══════════════════════════════════════════════════════════
// ИЗТРИВАНЕ НА АКАУНТ (server-side)
// ═══════════════════════════════════════════════════════════

// Server-side изтриване вместо клиентско — admin.auth().deleteUser() (Admin SDK)
// няма "recent login" изискване, за разлика от клиентския deleteUser(), затова
// не съществува вариант диарито/профилът да се изтрият, а Auth акаунтът да
// оцелее в "празна черупка" заради изтекла сесия (виж стария confirmDeleteAccount
// в index.html — точно този ред на операции беше рисков).
// region-ът идва от setGlobalOptions по-горе, не се задава изрично тук.
exports.deleteAccountData = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Трябва да си логнат.");
  }
  const uid = request.auth.uid;
  const bucket = admin.storage().bucket();

  const diarySnap = await db.collection("diary_entries").where("userId", "==", uid).get();
  await Promise.all(diarySnap.docs.map((doc) => doc.ref.delete()));

  await bucket.deleteFiles({prefix: `diary-photos/${uid}/`}).catch(() => {});

  // refereeUid — виж референс схемата в onDiaryEntryCreated по-горе (не referredUid).
  const refSnap = await db.collection("referrals").where("refereeUid", "==", uid).get().catch(() => null);
  if (refSnap) await Promise.all(refSnap.docs.map((doc) => doc.ref.delete()));

  await db.collection("users").doc(uid).delete().catch(() => {});

  // Последна стъпка — Admin SDK, без "recent login" риск.
  await admin.auth().deleteUser(uid);

  return {success: true};
});

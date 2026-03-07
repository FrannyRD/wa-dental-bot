import express from "express";
import axios from "axios";
import crypto from "crypto";
import { google } from "googleapis";
import Redis from "ioredis";

// =========================
// ENV
// =========================
const PORT = process.env.PORT || 3000;

const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const CLINIC_NAME = process.env.CLINIC_NAME || "Consultorio Dental";
const CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || "";
const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || "America/Santo_Domingo";

const WORK_HOURS = safeJson(process.env.WORK_HOURS_JSON, null) || defaultWorkHours();
const SERVICE_DURATION = safeJson(process.env.SERVICE_DURATION_JSON, null) || defaultServiceDuration();
const SLOT_STEP_MIN = parseInt(process.env.SLOT_STEP_MIN || "15", 10);

// ✅ LISTADO SIMPLE: 8am a 5pm cada 1 hora, PERO solo muestra los disponibles
const HOURLY_LIST_MODE = (process.env.HOURLY_LIST_MODE || "1") === "1";
const HOURLY_LIST_START = parseInt(process.env.HOURLY_LIST_START || "8", 10); // 8am
const HOURLY_LIST_END = parseInt(process.env.HOURLY_LIST_END || "17", 10); // 5pm
const HOURLY_LIST_COUNT = HOURLY_LIST_END - HOURLY_LIST_START + 1; // 10

// ✅ NEW: mínimo de minutos de anticipación para permitir agendar (default 60)
const MIN_BOOKING_LEAD_MIN = parseInt(process.env.MIN_BOOKING_LEAD_MIN || "60", 10);

// ✅ NEW: cuántos mostrar en el mensaje (si NO usas HOURLY_LIST_MODE)
const DISPLAY_SLOTS_LIMIT = parseInt(process.env.DISPLAY_SLOTS_LIMIT || "16", 10);
// ✅ NEW: máximo de slots a guardar/retornar para no inflar payload
const MAX_SLOTS_RETURN = parseInt(process.env.MAX_SLOTS_RETURN || "80", 10);

const REMINDER_24H = (process.env.REMINDER_24H || "1") === "1";
const REMINDER_2H = (process.env.REMINDER_2H || "1") === "1";

// ✅ NEW: tu WhatsApp personal para recibir resumen de citas
const PERSONAL_WA_TO = (process.env.PERSONAL_WA_TO || "").trim();

// =========================
// ✅ BOTHUB (para ver todo en el Hub)
// =========================
const BOTHUB_WEBHOOK_URL = (process.env.BOTHUB_WEBHOOK_URL || "").trim();
const BOTHUB_WEBHOOK_SECRET = (process.env.BOTHUB_WEBHOOK_SECRET || "").trim();
const BOTHUB_TIMEOUT_MS = Number(process.env.BOTHUB_TIMEOUT_MS || 6000);

// ✅ NEW: media proxy para BotHub (sin tocar lo demás)
const BOT_PUBLIC_BASE_URL = (process.env.BOT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const HUB_MEDIA_SECRET =
  (process.env.HUB_MEDIA_SECRET || BOTHUB_WEBHOOK_SECRET || VERIFY_TOKEN || "").trim();
const HUB_MEDIA_TTL_SEC = parseInt(process.env.HUB_MEDIA_TTL_SEC || "900", 10); // 15 min
const META_GRAPH_VERSION =
  process.env.WHATSAPP_GRAPH_VERSION || process.env.META_GRAPH_VERSION || "v23.0";

// =========================
// ✅ PERSISTENCIA (REDIS)
// =========================
const REDIS_URL_RAW = (process.env.REDIS_URL || "").trim();
const SESSION_TTL_SEC = parseInt(process.env.SESSION_TTL_SEC || String(60 * 60 * 24 * 14), 10); // 14 días
const SESSION_PREFIX = process.env.SESSION_PREFIX || "tekko:dental:sess:";

function normalizeRedisUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (u.startsWith("redis://")) return "rediss://" + u.slice("redis://".length);
  return u;
}

const redisUrl = normalizeRedisUrl(REDIS_URL_RAW);
const redis = redisUrl
  ? new Redis(redisUrl, {
      tls: redisUrl.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    })
  : null;

// fallback in-memory si no configuras REDIS_URL
const sessions = new Map();

function defaultSession() {
  return {
    messages: [],
    state: "idle", // idle | await_slot_choice | await_name | await_phone | post_booking | await_day

    // ✅ aquí guardamos TODOS los slots libres (no solo los 8 primeros)
    lastSlots: [],

    // ✅ NUEVO: lista mostrada (solo disponibles dentro de 8am..5pm cada 1h)
    lastDisplaySlots: [],

    selectedSlot: null,
    pendingService: null,
    pendingRange: null,
    pendingName: null,
    lastBooking: null, // {appointment_id,start,end,service,patient_name,phone}
    greeted: false,

    // ✅ dedupe webhook retries
    lastMsgId: null,

    // ✅ NUEVO: modo reprogramación (para no crear evento nuevo)
    reschedule: {
      active: false,
      appointment_id: "",
      phone: "",
      patient_name: "",
      service: "",
    },
  };
}

function sanitizeSession(session) {
  if (!session || typeof session !== "object") return defaultSession();
  if (!Array.isArray(session.messages)) session.messages = [];
  session.messages = session.messages.slice(-20);

  if (!Array.isArray(session.lastSlots)) session.lastSlots = [];
  session.lastSlots = session.lastSlots.slice(0, MAX_SLOTS_RETURN);

  if (!Array.isArray(session.lastDisplaySlots)) session.lastDisplaySlots = [];
  // ✅ no inflar (normalmente será <=10, pero lo limitamos igual)
  session.lastDisplaySlots = session.lastDisplaySlots.slice(0, HOURLY_LIST_COUNT);

  if (!session.reschedule || typeof session.reschedule !== "object") {
    session.reschedule = defaultSession().reschedule;
  } else {
    if (typeof session.reschedule.active !== "boolean") session.reschedule.active = false;
    if (typeof session.reschedule.appointment_id !== "string") session.reschedule.appointment_id = "";
    if (typeof session.reschedule.phone !== "string") session.reschedule.phone = "";
    if (typeof session.reschedule.patient_name !== "string") session.reschedule.patient_name = "";
    if (typeof session.reschedule.service !== "string") session.reschedule.service = "";
  }

  if (typeof session.state !== "string") session.state = "idle";
  if (typeof session.greeted !== "boolean") session.greeted = false;

  return session;
}

async function getSession(userId) {
  if (!userId) return sanitizeSession(defaultSession());

  if (!redis) {
    if (!sessions.has(userId)) sessions.set(userId, defaultSession());
    return sanitizeSession(sessions.get(userId));
  }

  const key = `${SESSION_PREFIX}${userId}`;
  const raw = await redis.get(key);
  const s = raw ? safeJson(raw, defaultSession()) : defaultSession();
  return sanitizeSession(s);
}

async function saveSession(userId, session) {
  if (!userId || !session) return;

  session = sanitizeSession(session);

  if (!redis) {
    sessions.set(userId, session);
    return;
  }

  const key = `${SESSION_PREFIX}${userId}`;
  await redis.set(key, JSON.stringify(session), "EX", SESSION_TTL_SEC);
}

// =====================================================
// Stable stringify (para firma HMAC consistente)
// =====================================================
function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
}

function removeUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, removeUndefinedDeep(v)])
    );
  }

  return value;
}

function bothubHmacStable(payload, secret) {
  const raw = stableStringify(payload);
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

function bothubHmacJson(payload, secret) {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

function getHubSignature(req) {
  const h =
    req.get("X-HUB-SIGNATURE") ||
    req.get("x-hub-signature") ||
    req.get("X-Hub-Signature") ||
    req.get("X-HUB-SIGNATURE-256") ||
    req.get("X-Hub-Signature-256") ||
    req.get("x-hub-signature-256") ||
    "";

  const sig = String(h || "").trim();
  if (!sig) return "";
  return sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig;
}

function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "utf8");
  const b = Buffer.from(String(bHex || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyHubSignature(reqBody, signatureHex, secret) {
  if (!signatureHex || !secret) return false;

  const expectedStable = bothubHmacStable(reqBody, secret);
  if (timingSafeEqualHex(signatureHex, expectedStable)) return true;

  const expectedJson = bothubHmacJson(reqBody, secret);
  if (timingSafeEqualHex(signatureHex, expectedJson)) return true;

  return false;
}

async function bothubReportMessage(payload) {
  if (!BOTHUB_WEBHOOK_URL || !BOTHUB_WEBHOOK_SECRET) return;

  try {
    const cleanPayload = removeUndefinedDeep(payload);
    const raw = stableStringify(cleanPayload);
    const sig = crypto.createHmac("sha256", BOTHUB_WEBHOOK_SECRET).update(raw).digest("hex");

    await axios.post(BOTHUB_WEBHOOK_URL, raw, {
      headers: {
        "Content-Type": "application/json",
        "X-HUB-SIGNATURE": sig,
      },
      timeout: BOTHUB_TIMEOUT_MS,
      transformRequest: [(data) => data],
    });
  } catch (e) {
    console.error("Bothub report failed:", e?.response?.data || e?.message || e);
  }
}

// ✅ Meta para audio/ubicación/attachments (para que en Hub se vea TODO)
function extractInboundMeta(msg) {
  if (!msg) return {};

  if (msg?.type === "audio") {
    return {
      kind: "AUDIO",
      mediaId: msg?.audio?.id,
      mimeType: msg?.audio?.mime_type,
      voice: msg?.audio?.voice,
    };
  }

  if (msg?.type === "location") {
    return {
      kind: "LOCATION",
      latitude: msg?.location?.latitude,
      longitude: msg?.location?.longitude,
      name: msg?.location?.name,
      address: msg?.location?.address,
    };
  }

  if (msg?.type === "image")
    return {
      kind: "IMAGE",
      mediaId: msg?.image?.id,
      mimeType: msg?.image?.mime_type,
      caption: msg?.image?.caption,
    };

  if (msg?.type === "video")
    return {
      kind: "VIDEO",
      mediaId: msg?.video?.id,
      mimeType: msg?.video?.mime_type,
      caption: msg?.video?.caption,
    };

  if (msg?.type === "document")
    return {
      kind: "DOCUMENT",
      mediaId: msg?.document?.id,
      mimeType: msg?.document?.mime_type,
      filename: msg?.document?.filename,
    };

  if (msg?.type === "sticker")
    return { kind: "STICKER", mediaId: msg?.sticker?.id, mimeType: msg?.sticker?.mime_type };

  if (msg?.type === "contacts") return { kind: "CONTACTS", count: msg?.contacts?.length || 0 };

  if (msg?.type === "reaction")
    return { kind: "REACTION", emoji: msg?.reaction?.emoji, messageId: msg?.reaction?.message_id };

  return { kind: msg?.type ? String(msg.type).toUpperCase() : "UNKNOWN" };
}

// =========================
// ✅ NEW: media proxy helpers (solo agregado)
// =========================
function extFromMimeType(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("audio/ogg")) return ".ogg";
  if (m.includes("audio/mpeg") || m.includes("audio/mp3")) return ".mp3";
  if (m.includes("audio/wav")) return ".wav";
  if (m.includes("audio/webm")) return ".webm";
  if (m.includes("image/jpeg")) return ".jpg";
  if (m.includes("image/png")) return ".png";
  if (m.includes("image/gif")) return ".gif";
  if (m.includes("image/webp")) return ".webp";
  if (m.includes("video/mp4")) return ".mp4";
  if (m.includes("application/pdf")) return ".pdf";
  if (m.includes("word")) return ".docx";
  if (m.includes("sheet")) return ".xlsx";
  if (m.includes("presentation")) return ".pptx";
  return "";
}

function sanitizeFileName(name, fallback = "file") {
  const raw = String(name || fallback).trim() || fallback;
  return raw.replace(/[\\/:*?"<>|]+/g, "_");
}

function getRequestBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();

  if (!host) return BOT_PUBLIC_BASE_URL || "";
  return `${proto}://${host}`;
}

function getBotPublicBaseUrl(req) {
  return BOT_PUBLIC_BASE_URL || getRequestBaseUrl(req);
}

function signHubMediaToken(mediaId, ts) {
  if (!HUB_MEDIA_SECRET) return "";
  return crypto
    .createHmac("sha256", HUB_MEDIA_SECRET)
    .update(`${String(mediaId)}:${String(ts)}`)
    .digest("hex");
}

function verifyHubMediaToken(mediaId, ts, sig) {
  if (!HUB_MEDIA_SECRET) return false;
  if (!mediaId || !ts || !sig) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;

  const ageMs = Math.abs(Date.now() - tsNum);
  if (ageMs > HUB_MEDIA_TTL_SEC * 1000) return false;

  const expected = signHubMediaToken(mediaId, ts);
  return timingSafeEqualHex(sig, expected);
}

function buildHubMediaUrl(req, mediaId) {
  if (!mediaId) return "";
  if (!HUB_MEDIA_SECRET) return "";

  const base = getBotPublicBaseUrl(req);
  if (!base) return "";

  const ts = String(Date.now());
  const sig = signHubMediaToken(mediaId, ts);

  return `${base.replace(/\/$/, "")}/hub_media/${encodeURIComponent(mediaId)}?ts=${encodeURIComponent(
    ts
  )}&sig=${encodeURIComponent(sig)}`;
}

function attachHubMediaUrl(req, meta) {
  const out = { ...(meta || {}) };
  const kind = String(out?.kind || "").toUpperCase();

  if (
    out?.mediaId &&
    ["AUDIO", "IMAGE", "VIDEO", "DOCUMENT", "STICKER"].includes(kind)
  ) {
    const mediaUrl = buildHubMediaUrl(req, out.mediaId);
    if (mediaUrl) out.mediaUrl = mediaUrl;
  }

  return out;
}

async function getMetaMediaInfo(mediaId) {
  if (!WA_TOKEN) throw new Error("WA_TOKEN not configured");
  const res = await axios.get(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`,
    {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      res?.data?.error?.message ||
        res?.data?.error?.error_user_msg ||
        `Meta media lookup failed (${res.status})`
    );
  }

  return res.data || {};
}

async function downloadMetaMedia(mediaId) {
  const info = await getMetaMediaInfo(mediaId);
  const mediaUrl = info?.url;
  const mimeType = info?.mime_type || "application/octet-stream";

  if (!mediaUrl) throw new Error("Meta respondió sin url para ese mediaId");

  const bin = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 60000,
    validateStatus: () => true,
  });

  if (bin.status < 200 || bin.status >= 300) {
    throw new Error(
      typeof bin.data === "string"
        ? bin.data
        : `Meta media download failed (${bin.status})`
    );
  }

  return {
    buffer: Buffer.from(bin.data),
    mimeType,
  };
}

// =========================
// Express (raw body for signature check)
// =========================
const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// =========================
// Services (requested list)
// =========================
const SERVICES = [
  { key: "estetica_dental", title: "Estética dental", id: "svc_estetica" },
  { key: "ortodoncia", title: "Ortodoncia", id: "svc_ortodoncia" },
  { key: "implantes", title: "Implantes", id: "svc_implantes" },
  { key: "urgencias", title: "Urgencias", id: "svc_urgencias" },
  { key: "limpieza_prevencion", title: "Limpiezas y prevención", id: "svc_limpieza_prevencion" },
  { key: "odontopediatria", title: "Odontopediatría", id: "svc_odontopediatria" },
];

const SERVICE_ID_TO_KEY = Object.fromEntries(SERVICES.map((s) => [s.id, s.key]));

// =========================
// Helpers
// =========================
function safeJson(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// ✅ FIX: para que exista el slot de 5:00 pm (17:00–17:30) cuando la duración lo permita,
// el fin por defecto debe permitir el bloque final (puedes sobrescribirlo con WORK_HOURS_JSON).
function defaultWorkHours() {
  return {
    mon: { start: "08:00", end: "17:30" }, // ✅ FIX
    tue: { start: "08:00", end: "17:30" }, // ✅ FIX
    wed: { start: "08:00", end: "17:30" }, // ✅ FIX
    thu: { start: "08:00", end: "17:30" }, // ✅ FIX
    fri: { start: "08:00", end: "17:30" }, // ✅ FIX
    sat: { start: "08:00", end: "13:00" },
    sun: null,
  };
}

function defaultServiceDuration() {
  return {
    estetica_dental: 60,
    ortodoncia: 30,
    implantes: 60,
    urgencias: 30,
    limpieza_prevencion: 45,
    odontopediatria: 45,
    otro: 30,
  };
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true;
  const signature = req.get("X-Hub-Signature-256");
  if (!signature) return false;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(req.rawBody || Buffer.from(""))
      .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function normalizeText(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function weekdayKeyFromISOWeekday(isoWeekday) {
  return ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"][isoWeekday];
}

function isGreeting(textNorm) {
  const t = textNorm || "";
  const greetings = [
    "hola",
    "buen dia",
    "buen día",
    "buenos dias",
    "buenos días",
    "buenas",
    "buenas tardes",
    "buenas noches",
    "saludos",
    "hey",
    "hi",
  ];
  const isOnlyGreeting =
    greetings.some((g) => t === g || t.startsWith(g + " ")) || /^(hola+|buenas+)\b/.test(t);

  const hasBookingIntent =
    t.includes("cita") ||
    t.includes("agendar") ||
    t.includes("agenda") ||
    t.includes("reservar") ||
    t.includes("reserva") ||
    t.includes("reprogram") ||
    t.includes("cancel");

  return isOnlyGreeting && !hasBookingIntent && t.length <= 40;
}

function quickHelpText() {
  return (
    `¡Hola! 😊\n` +
    `¿Qué servicio deseas agendar?\n\n` +
    `Puedes escribir el servicio (ej: "Ortodoncia") o escribir "servicios" para ver el menú.`
  );
}

function isThanks(textNorm) {
  return ["gracias", "ok", "okay", "listo", "perfecto", "dale", "bien", "genial"].some(
    (k) => textNorm === k || textNorm.includes(k)
  );
}

function isChoice(textNorm, n) {
  const t = (textNorm || "").trim();
  return t === String(n) || t === `${n}.` || t.startsWith(`${n} `);
}

function looksLikeConfirm(textNorm) {
  return ["confirmar", "confirmo", "confirmada", "confirmado", "confirmacion", "confirmación"].some((k) =>
    (textNorm || "").includes(k)
  );
}

function looksLikeCancel(textNorm) {
  return ["cancelar", "cancela", "anular", "anula", "no puedo", "ya no", "cancelacion", "cancelación"].some((k) =>
    (textNorm || "").includes(k)
  );
}

function looksLikeReschedule(textNorm) {
  return ["reprogramar", "reprograma", "cambiar", "cambio", "mover", "posponer", "otro horario"].some((k) =>
    (textNorm || "").includes(k)
  );
}

function looksLikeNewAppointment(textNorm) {
  return ["nueva cita", "otra cita", "agendar", "reservar", "cita nueva", "quiero cita"].some((k) =>
    (textNorm || "").includes(k)
  );
}

// ---- Timezone utilities ----
function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  return {
    year: parseInt(obj.year, 10),
    month: parseInt(obj.month, 10),
    day: parseInt(obj.day, 10),
    hour: parseInt(obj.hour, 10),
    minute: parseInt(obj.minute, 10),
    second: parseInt(obj.second, 10),
  };
}

function getOffsetMinutes(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}

function zonedTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMin = getOffsetMinutes(guess, timeZone);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60000);
}

function formatTimeInTZ(iso, timeZone) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-DO", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function formatDateInTZ(iso, timeZone) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-DO", {
    timeZone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(d);
}

// ✅ NEW: “ahora” + lead time en la zona de la clínica (pero en UTC real para comparar)
function getNowPlusLeadUTC() {
  const now = new Date();
  const lead = Math.max(0, Number.isFinite(MIN_BOOKING_LEAD_MIN) ? MIN_BOOKING_LEAD_MIN : 60);
  return addMinutes(now, lead);
}

// =========================
// ✅ WhatsApp helpers (NEW, no rompe lo existente)
// =========================
function normalizePhoneDigits(raw) {
  return String(raw || "").replace(/[^\d]/g, "");
}

// ✅ Si el cliente escribe 8/10 dígitos (RD), lo convertimos a 1 + 10 dígitos (E.164 sin +)
function toE164DigitsRD(phoneDigits) {
  const d = normalizePhoneDigits(phoneDigits);
  if (d.length === 10) return "1" + d; // RD NANP
  if (d.length === 11 && d.startsWith("1")) return d;
  return d;
}

// =========================
// WhatsApp send text / interactive list
// =========================
async function sendWhatsAppText(to, text, reportSource = "BOT") {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );

  await bothubReportMessage({
    direction: "OUTBOUND",
    to: String(to),
    body: String(text),
    source: reportSource,
    kind: "TEXT",
  });
}

// ✅ NEW: envío seguro para recordatorios (prioriza wa_id real del webhook)
async function sendReminderWhatsAppToBestTarget(priv, fallbackPhoneDigits, text) {
  const candidates = [];

  if (priv?.wa_id) candidates.push(String(priv.wa_id).trim());
  if (priv?.wa_phone) candidates.push(toE164DigitsRD(priv.wa_phone));
  if (fallbackPhoneDigits) candidates.push(toE164DigitsRD(fallbackPhoneDigits));

  const tried = [];
  let lastErr = null;

  for (const c of candidates) {
    const to = String(c || "").replace(/[^\d]/g, "");
    if (!to) continue;
    if (tried.includes(to)) continue;
    tried.push(to);

    try {
      await sendWhatsAppText(to, text, "BOT");
      return { ok: true, to };
    } catch (e) {
      lastErr = e;
      console.error("[reminder] send failed for:", to, e?.response?.data || e?.message || e);
    }
  }

  return { ok: false, tried, error: lastErr?.response?.data || lastErr?.message || lastErr };
}

async function notifyPersonalWhatsAppBookingSummary(booking) {
  try {
    if (!PERSONAL_WA_TO) return;

    const myTo = String(PERSONAL_WA_TO).replace(/[^\d]/g, "");
    if (!myTo) return;

    const patientPhone = String(booking?.phone || "").replace(/[^\d]/g, "");
    if (patientPhone && myTo === patientPhone) return;

    const prettyService = SERVICES.find((s) => s.key === booking.service)?.title || booking.service;

    const summary =
      `📌 *Nueva cita agendada*\n\n` +
      `🏥 Clínica: *${CLINIC_NAME}*\n` +
      `🦷 Servicio: *${prettyService}*\n` +
      `👤 Paciente: *${booking.patient_name}*\n` +
      `📞 Tel: *${patientPhone || "—"}*\n` +
      `📅 Fecha: *${formatDateInTZ(booking.start, CLINIC_TIMEZONE)}*\n` +
      `⏰ Hora: *${formatTimeInTZ(booking.start, CLINIC_TIMEZONE)}*\n` +
      `📍 Dirección: ${CLINIC_ADDRESS || "—"}\n` +
      `🆔 ID: ${booking.appointment_id || "—"}`;

    await sendWhatsAppText(myTo, summary, "BOT");
  } catch (e) {
    console.error("notifyPersonalWhatsAppBookingSummary error:", e?.response?.data || e?.message || e);
  }
}

async function sendServicesList(to) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const rows = SERVICES.map((s) => ({ id: s.id, title: s.title, description: "" }));

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Nuestros servicios" },
        body: { text: "Selecciona un servicio para agendar tu cita 👇\n(O si prefieres, escríbelo)" },
        footer: { text: CLINIC_NAME },
        action: { button: "Ver servicios", sections: [{ title: "Servicios", rows }] },
      },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );

  const rendered =
    `*Nuestros servicios*\nSelecciona un servicio para agendar tu cita 👇\n(O si prefieres, escríbelo)\n\n` +
    rows.map((r) => `• [${r.id}] ${r.title}`).join("\n");

  await bothubReportMessage({
    direction: "OUTBOUND",
    to: String(to),
    body: rendered,
    source: "BOT",
    kind: "LIST",
    meta: { rows },
  });
}

function servicesEmojiText() {
  return (
    `👋 ¡Hola! Soy el asistente de *${CLINIC_NAME}*.\n\n` +
    `Elige una opción:\n\n` +
    `A) Escríbeme el servicio que deseas:\n` +
    `✨ Estética dental\n` +
    `🦷 Ortodoncia\n` +
    `🔩 Implantes\n` +
    `🆘 Urgencias\n` +
    `🧼 Limpiezas y prevención\n` +
    `👶 Odontopediatría\n\n` +
    `B) O toca el botón *“Ver servicios”* para elegir en el menú 👇`
  );
}

// =========================
// Google Calendar Auth (Service Account)
// =========================
function getCalendarClient() {
  const json = safeJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, null);
  if (!json?.client_email || !json?.private_key) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  const auth = new google.auth.JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  return google.calendar({ version: "v3", auth });
}

// =========================
// ✅ Encontrar cita por teléfono
// =========================
async function findUpcomingAppointmentByPhone(phone, windowDays = 120) {
  try {
    const phoneDigits = String(phone || "").replace(/[^\d]/g, "");
    if (!phoneDigits) return null;

    const calendar = getCalendarClient();
    const now = new Date();
    const end = addMinutes(now, windowDays * 24 * 60);

    const list = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
    });

    const events = list.data.items || [];
    for (const ev of events) {
      const priv = ev.extendedProperties?.private || {};
      if (priv.status === "cancelled") continue;

      const wa = String(priv.wa_phone || "").replace(/[^\d]/g, "");
      if (!wa || wa !== phoneDigits) continue;

      const start = ev.start?.dateTime;
      const endDT = ev.end?.dateTime;
      if (!start || !endDT) continue;

      const service = String(priv.service || "").trim() || inferServiceFromSummary(ev.summary || "");
      const patient_name = String(priv.patient_name || "").trim() || "";

      return {
        appointment_id: ev.id,
        start,
        end: endDT,
        service: service || "limpieza_prevencion",
        patient_name,
        phone: phoneDigits,
      };
    }

    return null;
  } catch (e) {
    console.error("findUpcomingAppointmentByPhone error:", e?.response?.data || e?.message || e);
    return null;
  }
}

function inferServiceFromSummary(summary) {
  const s = normalizeText(summary || "");
  if (s.includes("ortodon")) return "ortodoncia";
  if (s.includes("implan")) return "implantes";
  if (s.includes("urgenc")) return "urgencias";
  if (s.includes("limp") || s.includes("prevenc")) return "limpieza_prevencion";
  if (s.includes("pedi")) return "odontopediatria";
  if (s.includes("estet") || s.includes("estetic")) return "estetica_dental";
  return "";
}

// =========================
// Calendar: FreeBusy => generate slots
// =========================
async function getBusyRanges(calendar, timeMinISO, timeMaxISO) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      timeZone: CLINIC_TIMEZONE,
      items: [{ id: GOOGLE_CALENDAR_ID }],
    },
  });

  const busy = fb.data.calendars?.[GOOGLE_CALENDAR_ID]?.busy || [];
  return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function buildCandidateSlotsZoned({ service, fromISO, toISO, durationMin }) {
  const from = new Date(fromISO);
  const to = new Date(toISO);

  const fromP = getZonedParts(from, CLINIC_TIMEZONE);
  const toP = getZonedParts(to, CLINIC_TIMEZONE);

  let curUTC = zonedTimeToUtc(
    { year: fromP.year, month: fromP.month, day: fromP.day, hour: 0, minute: 0 },
    CLINIC_TIMEZONE
  );
  const endUTC = zonedTimeToUtc(
    { year: toP.year, month: toP.month, day: toP.day, hour: 23, minute: 59 },
    CLINIC_TIMEZONE
  );

  const slots = [];

  while (curUTC <= endUTC) {
    const curLocal = getZonedParts(curUTC, CLINIC_TIMEZONE);

    const js = new Date(Date.UTC(curLocal.year, curLocal.month - 1, curLocal.day, 12, 0, 0));
    const isoWeekday = ((js.getUTCDay() + 6) % 7) + 1;
    const key = weekdayKeyFromISOWeekday(isoWeekday);
    const wh = WORK_HOURS[key];

    if (wh) {
      const [sh, sm] = wh.start.split(":").map((n) => parseInt(n, 10));
      const [eh, em] = wh.end.split(":").map((n) => parseInt(n, 10));

      let cursorMin = sh * 60 + sm;
      const endMin = eh * 60 + em;

      cursorMin = Math.ceil(cursorMin / SLOT_STEP_MIN) * SLOT_STEP_MIN;

      while (cursorMin + durationMin <= endMin) {
        const h = Math.floor(cursorMin / 60);
        const m = cursorMin % 60;

        const slotStartUTC = zonedTimeToUtc(
          { year: curLocal.year, month: curLocal.month, day: curLocal.day, hour: h, minute: m },
          CLINIC_TIMEZONE
        );
        const slotEndUTC = new Date(slotStartUTC.getTime() + durationMin * 60000);

        if (slotStartUTC >= from && slotEndUTC <= to) {
          slots.push({
            slot_id: "slot_" + slotStartUTC.getTime(),
            service: service || "limpieza_prevencion",
            start: slotStartUTC.toISOString(),
            end: slotEndUTC.toISOString(),
          });
        }

        cursorMin += SLOT_STEP_MIN;
      }
    }

    const nextDayUTC = zonedTimeToUtc(
      { year: curLocal.year, month: curLocal.month, day: curLocal.day, hour: 0, minute: 0 },
      CLINIC_TIMEZONE
    );
    curUTC = new Date(nextDayUTC.getTime() + 24 * 60 * 60000);
  }

  return slots;
}

// ✅ FIX: devolvemos más slots (ej 80) y además filtramos por “mínimo 1h antes”
async function getAvailableSlotsTool({ service, from, to }) {
  const calendar = getCalendarClient();

  const durationMin = SERVICE_DURATION[service] || SERVICE_DURATION["otro"] || 30;
  const busyRanges = await getBusyRanges(calendar, from, to);
  const candidates = buildCandidateSlotsZoned({ service, fromISO: from, toISO: to, durationMin });

  const nowPlusLead = getNowPlusLeadUTC();

  const free = candidates
    .filter((c) => {
      const cs = new Date(c.start);
      const ce = new Date(c.end);

      // ✅ NEW: no permitir slots que empiezan demasiado pronto (ej: ahora 2:30 -> no 3:00)
      if (cs < nowPlusLead) return false;

      return !busyRanges.some((b) => overlaps(cs, ce, b.start, b.end));
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return free.slice(0, MAX_SLOTS_RETURN);
}

// =========================
// Calendar: book / reschedule / cancel
// =========================
async function bookAppointmentTool({
  patient_name,
  phone,
  slot_id,
  service,
  notes,
  slot_start,
  slot_end,
  wa_id, // ✅ NEW (opcional, no rompe llamadas viejas)
}) {
  const calendar = getCalendarClient();
  if (!slot_start || !slot_end) throw new Error("Missing slot_start/slot_end");

  const event = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: `Cita - ${service} - ${patient_name}`,
      location: CLINIC_ADDRESS || undefined,
      description: `Paciente: ${patient_name}\nTel: ${phone}\nServicio: ${service}\nNotas: ${notes || ""}\nSlotId: ${slot_id}`,
      start: { dateTime: slot_start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: slot_end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: {
        private: {
          wa_phone: phone,
          wa_id: wa_id || "",
          patient_name,
          service,
          slot_id,
          reminder24hSent: "false",
          reminder2hSent: "false",
        },
      },
    },
  });

  return { appointment_id: event.data.id, start: slot_start, end: slot_end, service, patient_name, phone };
}

async function rescheduleAppointmentTool({
  appointment_id,
  new_slot_id,
  new_start,
  new_end,
  service,
  patient_name,
  phone,
  wa_id,
}) {
  const calendar = getCalendarClient();
  if (!new_start || !new_end) throw new Error("Missing new_start/new_end");

  const current = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: appointment_id });
  const priv = current.data.extendedProperties?.private || {};

  const nextService = String(service || priv.service || "").trim();
  const nextName = String(patient_name || priv.patient_name || "").trim();
  const nextPhone = String(phone || priv.wa_phone || "").trim();
  const nextWaId = String(wa_id || priv.wa_id || "").trim();

  const nextPriv = {
    ...priv,
    slot_id: new_slot_id,
    reminder24hSent: "false",
    reminder2hSent: "false",
  };

  if (nextService) nextPriv.service = nextService;
  if (nextName) nextPriv.patient_name = nextName;
  if (nextPhone) nextPriv.wa_phone = nextPhone;
  if (nextWaId) nextPriv.wa_id = nextWaId;

  const nextSummary =
    nextService && nextName ? `Cita - ${nextService} - ${nextName}` : current.data.summary || "Cita";

  const updated = await calendar.events.patch({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId: appointment_id,
    requestBody: {
      summary: nextSummary,
      start: { dateTime: new_start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: new_end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: { private: nextPriv },
    },
  });

  return { ok: true, appointment_id: updated.data.id, new_start, new_end };
}

async function cancelAppointmentTool({ appointment_id, reason }) {
  const calendar = getCalendarClient();

  const event = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: appointment_id });

  const summary = event.data.summary || "Cita";
  await calendar.events.patch({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId: appointment_id,
    requestBody: {
      summary: `CANCELADA - ${summary}`,
      description: (event.data.description || "") + `\n\nCancelación: ${reason || ""}`,
      extendedProperties: {
        private: { ...(event.data.extendedProperties?.private || {}), status: "cancelled" },
      },
    },
  });

  return { ok: true, appointment_id };
}

async function handoffToHumanTool({ summary }) {
  return { ok: true, routed: true, summary };
}

// =========================
// Date parsing
// =========================
const DOW = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
  domingo: 7,
};

const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function startOfLocalDayUTC(date, tz) {
  const p = getZonedParts(date, tz);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, tz);
}

function addLocalDaysUTC(dateUTC, days, tz) {
  const p = getZonedParts(dateUTC, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return zonedTimeToUtc(
    { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), hour: 0, minute: 0 },
    tz
  );
}

function nextWeekdayFromTodayUTC(targetIsoDow, tz, isNext = false) {
  const now = new Date();
  const todayLocal = startOfLocalDayUTC(now, tz);

  const p = getZonedParts(todayLocal, tz);
  const mid = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 12, minute: 0 }, tz);
  const js = new Date(mid.toISOString());
  const isoToday = ((js.getUTCDay() + 6) % 7) + 1;

  let diff = targetIsoDow - isoToday;
  if (diff < 0) diff += 7;
  if (diff === 0 && isNext) diff = 7;

  return addLocalDaysUTC(todayLocal, diff, tz);
}

function rangeForWholeMonth(year, month) {
  const from = zonedTimeToUtc({ year, month, day: 1, hour: 0, minute: 0 }, CLINIC_TIMEZONE);
  const toMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const to = zonedTimeToUtc(
    { year: toMonth.year, month: toMonth.month, day: 1, hour: 0, minute: 0 },
    CLINIC_TIMEZONE
  );
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseDateRangeFromText(userText) {
  const t = normalizeText(userText);

  if (t.includes("hoy")) {
    const from = startOfLocalDayUTC(new Date(), CLINIC_TIMEZONE);
    const to = addLocalDaysUTC(from, 1, CLINIC_TIMEZONE);
    return { from: from.toISOString(), to: to.toISOString(), label: "hoy" };
  }
  if (t.includes("pasado manana") || t.includes("pasado mañana")) {
    const from = addLocalDaysUTC(startOfLocalDayUTC(new Date(), CLINIC_TIMEZONE), 2, CLINIC_TIMEZONE);
    const to = addLocalDaysUTC(from, 1, CLINIC_TIMEZONE);
    return { from: from.toISOString(), to: to.toISOString(), label: "pasado mañana" };
  }
  if (t.includes("manana") || t.includes("mañana")) {
    const from = addLocalDaysUTC(startOfLocalDayUTC(new Date(), CLINIC_TIMEZONE), 1, CLINIC_TIMEZONE);
    const to = addLocalDaysUTC(from, 1, CLINIC_TIMEZONE);
    return { from: from.toISOString(), to: to.toISOString(), label: "mañana" };
  }

  if (t.includes("semana que viene") || t.includes("la semana que viene") || t.includes("siguiente semana")) {
    const from = addLocalDaysUTC(startOfLocalDayUTC(new Date(), CLINIC_TIMEZONE), 1, CLINIC_TIMEZONE);
    const to = addLocalDaysUTC(from, 7, CLINIC_TIMEZONE);
    return { from: from.toISOString(), to: to.toISOString(), label: "la semana que viene" };
  }

  for (const [mname, mnum] of Object.entries(MONTHS)) {
    if (t === mname || t.includes(`en ${mname}`) || t.includes(`para ${mname}`)) {
      const nowP = getZonedParts(new Date(), CLINIC_TIMEZONE);
      let year = nowP.year;
      if (mnum < nowP.month) year += 1;
      const r = rangeForWholeMonth(year, mnum);
      return { ...r, label: mname };
    }
  }

  for (const [name, iso] of Object.entries(DOW)) {
    if (t.includes(name)) {
      const isNext =
        t.includes("proximo") || t.includes("próximo") || t.includes("que viene") || t.includes("siguiente");
      const fromDay = nextWeekdayFromTodayUTC(iso, CLINIC_TIMEZONE, isNext);
      const toDay = addLocalDaysUTC(fromDay, 1, CLINIC_TIMEZONE);
      return { from: fromDay.toISOString(), to: toDay.toISOString(), label: name };
    }
  }

  const m1 = t.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)(\s+de\s+(\d{4}))?/);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const monthName = normalizeText(m1[2]);
    const month = MONTHS[monthName];
    if (month) {
      const now = new Date();
      const nowP = getZonedParts(now, CLINIC_TIMEZONE);
      let year = m1[4] ? parseInt(m1[4], 10) : nowP.year;

      if (!m1[4]) {
        const candidateUTC = zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 }, CLINIC_TIMEZONE);
        if (candidateUTC < startOfLocalDayUTC(now, CLINIC_TIMEZONE)) year += 1;
      }

      const from = zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 }, CLINIC_TIMEZONE);
      const to = addLocalDaysUTC(from, 1, CLINIC_TIMEZONE);
      return { from: from.toISOString(), to: to.toISOString(), label: `${day} de ${monthName}` };
    }
  }

  return null;
}

// =========================
// Slot formatting (LISTADO SIMPLE 8..5 SOLO DISPONIBLES)
// =========================
function buildHourlyDisplaySlotsAvailableOnly(allFreeSlots) {
  const out = [];
  for (let h = HOURLY_LIST_START; h <= HOURLY_LIST_END; h++) {
    const match = allFreeSlots.find((s) => {
      const parts = getZonedParts(new Date(s.start), CLINIC_TIMEZONE);
      return parts.hour === h && parts.minute === 0;
    });
    if (match) out.push(match);
  }
  return out;
}

function formatSlotsList(serviceKey, slots, session) {
  if (!slots?.length) return null;
  const dateLabel = formatDateInTZ(slots[0].start, CLINIC_TIMEZONE);
  const prettyService = SERVICES.find((s) => s.key === serviceKey)?.title || serviceKey;

  if (HOURLY_LIST_MODE) {
    const displaySlots = buildHourlyDisplaySlotsAvailableOnly(slots);
    if (session) session.lastDisplaySlots = displaySlots;

    if (!displaySlots.length) {
      return (
        `No veo horarios disponibles entre *8:00 am* y *5:00 pm* para *${prettyService}* el *${dateLabel}* 🙏\n` +
        `Dime otro día (ej: "viernes") o intenta otro rango.`
      );
    }

    const lines = displaySlots.map((s, i) => {
      const a = formatTimeInTZ(s.start, CLINIC_TIMEZONE);
      const b = formatTimeInTZ(s.end, CLINIC_TIMEZONE);
      return `${i + 1}. ${a} - ${b}`;
    });

    return (
      `Estos son los horarios disponibles para *${prettyService}* el *${dateLabel}*:\n\n` +
      `${lines.join("\n")}\n\n` +
      `Responde con el *número* (1,2,3...) o escribe la *hora* (ej: 10:00 am / 3:00 pm).`
    );
  }

  const view = slots.slice(0, Math.max(1, DISPLAY_SLOTS_LIMIT));
  const lines = view.map((s, i) => {
    const a = formatTimeInTZ(s.start, CLINIC_TIMEZONE);
    const b = formatTimeInTZ(s.end, CLINIC_TIMEZONE);
    return `${i + 1}. ${a} - ${b}`;
  });

  return (
    `Estos son los horarios disponibles para *${prettyService}* el *${dateLabel}*:\n\n` +
    `${lines.join("\n")}\n\n` +
    `Responde con el *número* (1,2,3...) o escribe la *hora* (ej: 10:00 am / 3:00 pm).`
  );
}

// ✅ FIX: parsear hora del usuario con AM/PM robusto (pero NO interpretar "1" / "10" como hora)
function parseUserTimeTo24h(userText) {
  const raw = String(userText || "").trim().toLowerCase();
  if (!raw) return null;

  let compact = raw.replace(/\./g, "").replace(/\s+/g, " ").trim();
  compact = compact.replace(/\b([ap])\s*m\b/g, "$1m");

  if (/^\d{1,2}$/.test(compact)) return null;

  const m = compact.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;

  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] ? String(m[3]).toLowerCase() : "";

  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (mm < 0 || mm > 59) return null;

  if (mer === "am" || mer === "pm") {
    if (hh < 1 || hh > 12) return null;
    if (mer === "pm" && hh !== 12) hh += 12;
    if (mer === "am" && hh === 12) hh = 0;
  } else {
    if (hh < 0 || hh > 23) return null;
  }

  return { hh, mm, meridian: mer || null };
}

function tryPickSlotFromUserText(session, userText) {
  const t = normalizeText(userText);

  if (/^\d+$/.test(t)) {
    const num = parseInt(t, 10);
    if (!Number.isNaN(num)) {
      if (HOURLY_LIST_MODE) {
        if (num >= 1 && num <= (session.lastDisplaySlots?.length || 0)) {
          return session.lastDisplaySlots[num - 1] || null;
        }
        return null;
      }

      if (num >= 1 && num <= Math.min(session.lastSlots.length, DISPLAY_SLOTS_LIMIT)) {
        return session.lastSlots[num - 1];
      }
    }
  }

  const parsed = parseUserTimeTo24h(userText);
  if (parsed) {
    const { hh, mm } = parsed;

    if (HOURLY_LIST_MODE) {
      if (mm !== 0) return null;
      if (hh < HOURLY_LIST_START || hh > HOURLY_LIST_END) return null;

      const found = session.lastSlots.find((s) => {
        const parts = getZonedParts(new Date(s.start), CLINIC_TIMEZONE);
        return parts.hour === hh && parts.minute === 0;
      });
      if (found) return found;
      return null;
    }

    const found = session.lastSlots.find((s) => {
      const d = new Date(s.start);
      const parts = getZonedParts(d, CLINIC_TIMEZONE);
      return parts.hour === hh && parts.minute === mm;
    });

    if (found) return found;
    return null;
  }

  const m = t.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;

    const found = session.lastSlots.find((s) => {
      const d = new Date(s.start);
      const parts = getZonedParts(d, CLINIC_TIMEZONE);
      return parts.hour === hh && parts.minute === mm;
    });
    if (found) return found;
  }

  return null;
}

// =========================
// OpenAI: tool calling (kept)
// =========================
async function callOpenAI({ session, userId, userText, userPhone, extraSystem = "" }) {
  const today = new Date();
  const tzParts = getZonedParts(today, CLINIC_TIMEZONE);
  const todayStr = `${tzParts.year}-${String(tzParts.month).padStart(2, "0")}-${String(tzParts.day).padStart(2, "0")}`;

  const system = {
    role: "system",
    content: `
Eres un asistente de WhatsApp de ${CLINIC_NAME} para agendar citas.
Reglas:
- No diagnostiques ni des consejo médico. Solo agenda y triage.
- Urgencias reales (dolor severo, sangrado fuerte, fiebre, trauma, hinchazón intensa): llama a handoff_to_human.
- NO inventes horarios. Solo ofrece slots de get_available_slots.
- Para reservar, debes llamar a book_appointment con slot_start y slot_end EXACTOS del slot elegido.
- Mantén respuestas cortas, claras y con opciones.
- Fecha actual (zona ${CLINIC_TIMEZONE}): ${todayStr}. Interpreta "mañana", "viernes", "próximo martes", etc. correctamente.
- Importante: no ofrezcas horarios que inicien en menos de ${MIN_BOOKING_LEAD_MIN} minutos desde ahora.

Servicios disponibles (usuario puede escribirlos):
- Estética dental
- Ortodoncia
- Implantes
- Urgencias
- Limpiezas y prevención
- Odontopediatría

${extraSystem}
Tel usuario: ${userPhone}.
`,
  };

  session.messages.push({ role: "user", content: userText });
  const messages = [system, ...session.messages].slice(-14);

  const tools = [
    {
      type: "function",
      function: {
        name: "get_available_slots",
        description: "Obtiene horarios reales disponibles para un servicio en rango de fechas.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
          },
          required: ["from", "to"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "book_appointment",
        description: "Reserva una cita en el calendario usando el slot elegido (start/end exactos).",
        parameters: {
          type: "object",
          properties: {
            patient_name: { type: "string" },
            phone: { type: "string" },
            slot_id: { type: "string" },
            service: { type: "string" },
            notes: { type: "string" },
            slot_start: { type: "string" },
            slot_end: { type: "string" },
          },
          required: ["patient_name", "phone", "slot_id", "service", "slot_start", "slot_end"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reschedule_appointment",
        description: "Reagenda una cita a un nuevo slot (start/end exactos).",
        parameters: {
          type: "object",
          properties: {
            appointment_id: { type: "string" },
            new_slot_id: { type: "string" },
            new_start: { type: "string" },
            new_end: { type: "string" },
          },
          required: ["appointment_id", "new_slot_id", "new_start", "new_end"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_appointment",
        description: "Cancela una cita por id.",
        parameters: {
          type: "object",
          properties: {
            appointment_id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["appointment_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "handoff_to_human",
        description: "Deriva a humano si urgencia o caso especial.",
        parameters: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    },
  ];

  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1-mini",
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  const msg = resp.data.choices?.[0]?.message;

  if (msg?.tool_calls?.length) {
    const toolResults = [];
    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments || "{}");

      if (name === "get_available_slots") {
        const slots = await getAvailableSlotsTool(args);
        toolResults.push({ tool_call_id: tc.id, role: "tool", name, content: JSON.stringify({ slots }) });
      }

      if (name === "book_appointment") {
        const booked = await bookAppointmentTool(args);
        toolResults.push({ tool_call_id: tc.id, role: "tool", name, content: JSON.stringify({ booked }) });
      }

      if (name === "reschedule_appointment") {
        const out = await rescheduleAppointmentTool(args);
        toolResults.push({ tool_call_id: tc.id, role: "tool", name, content: JSON.stringify(out) });
      }

      if (name === "cancel_appointment") {
        const out = await cancelAppointmentTool(args);
        toolResults.push({ tool_call_id: tc.id, role: "tool", name, content: JSON.stringify(out) });
      }

      if (name === "handoff_to_human") {
        const out = await handoffToHumanTool(args);
        toolResults.push({ tool_call_id: tc.id, role: "tool", name, content: JSON.stringify(out) });
      }
    }

    const resp2 = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4.1-mini", messages: [...messages, msg, ...toolResults], temperature: 0.2 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    const finalText = resp2.data.choices?.[0]?.message?.content?.trim() || "";
    session.messages.push({ role: "assistant", content: finalText });
    return finalText || "¿En cuál servicio deseas agendar tu cita?";
  }

  const text = msg?.content?.trim() || "Hola 👋 ¿Deseas agendar una cita? Escribe el servicio o te muestro el menú.";
  session.messages.push({ role: "assistant", content: text });
  return text;
}

// =========================
// Webhooks
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

function extractIncomingText(msg) {
  if (!msg) return "";

  if (msg?.text?.body) return msg.text.body;

  if (msg?.type === "interactive" && msg?.interactive?.list_reply) {
    const lr = msg.interactive.list_reply;
    return lr.id || lr.title || "";
  }

  if (msg?.type === "interactive" && msg?.interactive?.button_reply) {
    const br = msg.interactive.button_reply;
    return br.id || br.title || "";
  }

  if (msg?.type === "audio" && msg?.audio?.id) return "[AUDIO]";

  if (msg?.type === "location" && msg?.location) {
    const { latitude, longitude, name, address } = msg.location;
    return `📍 Ubicación: ${name || ""} ${address || ""} (${latitude}, ${longitude})`.trim();
  }

  if (msg?.type === "image" && msg?.image?.id) return "[IMAGE]";
  if (msg?.type === "video" && msg?.video?.id) return "[VIDEO]";
  if (msg?.type === "document" && msg?.document?.id) return "[DOCUMENT]";
  if (msg?.type === "sticker" && msg?.sticker?.id) return "[STICKER]";

  if (msg?.type === "contacts" && msg?.contacts?.length) return "[CONTACTS]";
  if (msg?.type === "reaction" && msg?.reaction) return `[REACTION] ${msg.reaction.emoji || ""}`.trim();

  return `[${(msg?.type || "UNKNOWN").toUpperCase()}]`;
}

function detectServiceKeyFromUser(text) {
  const t = normalizeText(text);

  if (SERVICE_ID_TO_KEY[text]) return SERVICE_ID_TO_KEY[text];

  for (const s of SERVICES) {
    const nt = normalizeText(s.title);
    if (t === nt) return s.key;
    if (t.includes(nt)) return s.key;
  }

  if (t.includes("limpieza")) return "limpieza_prevencion";
  if (t.includes("prevencion")) return "limpieza_prevencion";
  if (t.includes("orto")) return "ortodoncia";
  if (t.includes("implante")) return "implantes";
  if (t.includes("pediatr")) return "odontopediatria";
  if (t.includes("estetica") || t.includes("estética")) return "estetica_dental";
  if (t.includes("urgencia")) return "urgencias";

  return null;
}

// =====================================================
// ✅ endpoint para recibir mensaje del AGENTE desde BotHub
// =====================================================
app.post("/agent_message", async (req, res) => {
  try {
    if (!BOTHUB_WEBHOOK_SECRET) {
      return res.status(400).json({ error: "BOTHUB_WEBHOOK_SECRET not configured" });
    }

    const signature = getHubSignature(req);
    const okSig = verifyHubSignature(req.body, signature, BOTHUB_WEBHOOK_SECRET);

    if (!signature || !okSig) {
      console.warn("[agent_message] Invalid signature", {
        hasSignature: Boolean(signature),
        sigLen: signature ? String(signature).length : 0,
      });
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { waTo, text } = req.body || {};
    if (!waTo || !String(waTo).trim()) return res.status(400).json({ error: "waTo is required" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });

    await sendWhatsAppText(String(waTo), String(text), "AGENT");
    return res.json({ ok: true });
  } catch (e) {
    console.error("agent_message error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ error: "Internal error" });
  }
});

// =====================================================
// ✅ NEW: media proxy para BotHub
// - El CRM NO necesita WA_TOKEN
// - El bot usa SU propio WA_TOKEN para traer audio/doc/imagen
// =====================================================
app.get("/hub_media/:mediaId", async (req, res) => {
  try {
    const { mediaId } = req.params || {};
    const ts = String(req.query?.ts || "");
    const sig = String(req.query?.sig || "");

    if (!mediaId) {
      return res.status(400).json({ error: "mediaId is required" });
    }

    if (!verifyHubMediaToken(mediaId, ts, sig)) {
      return res.status(401).json({ error: "Invalid or expired media signature" });
    }

    if (!WA_TOKEN) {
      return res.status(500).json({ error: "WA_TOKEN not configured in bot" });
    }

    const info = await getMetaMediaInfo(mediaId);
    const mimeType = String(info?.mime_type || "application/octet-stream");
    const filename = sanitizeFileName(
      info?.filename || `media-${mediaId}${extFromMimeType(mimeType)}`,
      `media-${mediaId}${extFromMimeType(mimeType)}`
    );

    const downloaded = await downloadMetaMedia(mediaId);

    res.setHeader("Content-Type", downloaded.mimeType || mimeType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Disposition", `inline; filename="${String(filename).replace(/"/g, "")}"`);

    return res.status(200).send(downloaded.buffer);
  } catch (e) {
    console.error("hub_media error:", e?.response?.data || e?.message || e);
    return res.status(500).json({
      error: "hub_media_failed",
      detail: e?.response?.data || e?.message || "unknown",
    });
  }
});

app.post("/webhook", async (req, res) => {
  let from = "";
  let session = null;

  try {
    if (!verifyMetaSignature(req)) return res.sendStatus(403);

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const incomingPhoneNumberId = String(value?.metadata?.phone_number_id || "").trim();
const incomingDisplayPhone = String(value?.metadata?.display_phone_number || "").trim();
const expectedPhoneNumberId = String(PHONE_NUMBER_ID || "").trim();

console.log("[WEBHOOK FILTER]", {
  expectedPhoneNumberId,
  incomingPhoneNumberId,
  incomingDisplayPhone,
});

if (incomingPhoneNumberId && expectedPhoneNumberId && incomingPhoneNumberId !== expectedPhoneNumberId) {
  console.log("[WEBHOOK FILTER] Ignorado por phone_number_id distinto");
  return res.sendStatus(200);
}

    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    from = msg.from;
    if (!from) return res.sendStatus(200);

    session = await getSession(from);

    const msgId = msg?.id;
    if (msgId && session.lastMsgId === msgId) return res.sendStatus(200);
    if (msgId) session.lastMsgId = msgId;

    const userTextRaw = extractIncomingText(msg);
    const userText = (userTextRaw || "").trim();
    const tNorm = normalizeText(userText);

    if (!userText) return res.sendStatus(200);

    const inboundMeta = extractInboundMeta(msg);
    const inboundMetaWithMediaUrl = attachHubMediaUrl(req, inboundMeta);

    console.log(
      "BOTHUB INBOUND DEBUG: ",
      JSON.stringify(
        {
          msgType: msg?.type,
          from,
          userText,
          inboundMeta,
          inboundMetaWithMediaUrl,
        },
        null,
        2
      )
    );

    await bothubReportMessage({
      direction: "INBOUND",
      from: String(from),
      body: String(userText),
      source: "WHATSAPP",
      waMessageId: msg?.id,
      name: value?.contacts?.[0]?.profile?.name,
      kind: inboundMetaWithMediaUrl?.kind || (msg?.type ? String(msg.type).toUpperCase() : "UNKNOWN"),
      meta: inboundMetaWithMediaUrl,
      mediaUrl: inboundMetaWithMediaUrl?.mediaUrl || undefined,
    });

    const wantsCancel = looksLikeCancel(tNorm) || isChoice(tNorm, 3);
    const wantsReschedule = looksLikeReschedule(tNorm) || isChoice(tNorm, 2);
    const wantsConfirm = looksLikeConfirm(tNorm) || isChoice(tNorm, 1);

    if ((wantsCancel || wantsReschedule || wantsConfirm) && !session.lastBooking) {
      const found = await findUpcomingAppointmentByPhone(from);
      if (found) {
        session.lastBooking = found;
        session.state = "post_booking";
      }
    }

    const detectedServiceEarly = detectServiceKeyFromUser(userText);
    const detectedRangeEarly = parseDateRangeFromText(userText);
    const hasEarlyIntent =
      !!detectedServiceEarly ||
      !!detectedRangeEarly ||
      tNorm.includes("cita") ||
      tNorm.includes("agendar") ||
      tNorm.includes("reservar") ||
      tNorm.includes("reprogram") ||
      tNorm.includes("cancel");

    if (session.greeted && session.state === "idle" && isGreeting(tNorm) && !hasEarlyIntent) {
      await sendWhatsAppText(from, quickHelpText());
      return res.sendStatus(200);
    }

    if (!session.greeted && session.state === "idle" && isGreeting(tNorm) && !hasEarlyIntent) {
      session.greeted = true;
      await sendWhatsAppText(from, servicesEmojiText());
      await sendServicesList(from);
      return res.sendStatus(200);
    }

    if (!session.greeted && session.state === "idle") {
      session.greeted = true;
    }

    // POST-BOOKING
    if (session.state === "post_booking" && session.lastBooking) {
      if (wantsConfirm) {
        const b = session.lastBooking;
        await sendWhatsAppText(
          from,
          `✅ ¡Confirmado!\n\n🦷 Servicio: ${
            SERVICES.find((s) => s.key === b.service)?.title || b.service
          }\n📅 Fecha: ${formatDateInTZ(b.start, CLINIC_TIMEZONE)}\n⏰ Hora: ${formatTimeInTZ(
            b.start,
            CLINIC_TIMEZONE
          )}\n\nResponde:\n2) Reprogramar\n3) Cancelar`
        );
        return res.sendStatus(200);
      }

      if (wantsCancel) {
        await cancelAppointmentTool({ appointment_id: session.lastBooking.appointment_id, reason: userText });
        await sendWhatsAppText(from, `✅ Listo. Tu cita fue cancelada.\n\nSi deseas agendar una nueva, escribe "Nueva cita" o dime el servicio.`);

        session.state = "idle";
        session.lastSlots = [];
        session.lastDisplaySlots = [];
        session.selectedSlot = null;
        session.pendingService = null;
        session.pendingRange = null;
        session.pendingName = null;
        session.lastBooking = null;
        session.reschedule = defaultSession().reschedule;
        return res.sendStatus(200);
      }

      if (wantsReschedule) {
        session.reschedule.active = true;
        session.reschedule.appointment_id = session.lastBooking.appointment_id;
        session.reschedule.phone = session.lastBooking.phone || String(from).replace(/[^\d]/g, "");
        session.reschedule.patient_name = session.lastBooking.patient_name || "";
        session.reschedule.service = session.lastBooking.service || "";

        session.pendingService = session.reschedule.service || session.pendingService;
        session.state = "await_day";
        session.lastSlots = [];
        session.lastDisplaySlots = [];
        session.selectedSlot = null;
        session.pendingRange = null;
        session.pendingName = null;

        const prettyService = SERVICES.find((s) => s.key === session.pendingService)?.title || session.pendingService;
        await sendWhatsAppText(
          from,
          `Perfecto ✅ Vamos a reprogramar tu cita.\nServicio: *${prettyService}*\n\n¿Para qué día?\nEj: "mañana", "viernes", "próximo martes".`
        );
        return res.sendStatus(200);
      }

      if (looksLikeNewAppointment(tNorm)) {
        session.state = "idle";
        session.reschedule = defaultSession().reschedule;
        await sendWhatsAppText(from, `Claro ✅ Vamos a agendar una nueva cita.\nElige un servicio:`);
        await sendServicesList(from);
        return res.sendStatus(200);
      }

      if (isThanks(tNorm)) {
        const b = session.lastBooking;
        await sendWhatsAppText(
          from,
          `¡Perfecto! ✅\nTu cita queda confirmada.\n\n🦷 Servicio: ${
            SERVICES.find((s) => s.key === b.service)?.title || b.service
          }\n📅 Fecha: ${formatDateInTZ(b.start, CLINIC_TIMEZONE)}\n⏰ Hora: ${formatTimeInTZ(
            b.start,
            CLINIC_TIMEZONE
          )}\n\nSi necesitas *reprogramar* o *cancelar*, escríbelo aquí.`
        );
        return res.sendStatus(200);
      }

      await sendWhatsAppText(
        from,
        `Estoy aquí ✅\nSi deseas *reprogramar* o *cancelar* tu cita, responde:\n2) Reprogramar\n3) Cancelar\n\nSi deseas una *nueva cita*, escribe "Nueva cita".`
      );
      return res.sendStatus(200);
    }

    // AWAIT SLOT CHOICE
    if (session.state === "await_slot_choice" && session.lastSlots?.length) {
      if (["reiniciar", "reset", "resetear", "empezar", "inicio"].some((k) => tNorm.includes(k))) {
        session.state = "idle";
        session.lastSlots = [];
        session.lastDisplaySlots = [];
        session.selectedSlot = null;
        session.pendingRange = null;
        session.pendingName = null;
        session.reschedule = defaultSession().reschedule;

        await sendWhatsAppText(from, `Listo ✅ Reinicié el proceso.\n¿Qué servicio deseas agendar?`);
        await sendWhatsAppText(from, servicesEmojiText());
        await sendServicesList(from);
        return res.sendStatus(200);
      }

      if (["reprogramar", "cambiar", "otro dia", "otro día"].some((k) => tNorm.includes(k))) {
        session.state = "await_day";
        session.lastSlots = [];
        session.lastDisplaySlots = [];
        session.selectedSlot = null;
        session.pendingRange = null;
        session.pendingName = null;

        const prettyService =
          SERVICES.find((s) => s.key === session.pendingService)?.title || session.pendingService || "tu servicio";
        await sendWhatsAppText(
          from,
          `Perfecto ✅ Vamos a elegir *otro día* para *${prettyService}*.\n\n¿Para qué día?\nEj: "mañana", "viernes", "próximo martes", "la semana que viene" o "14 de junio".`
        );
        return res.sendStatus(200);
      }

      const picked = tryPickSlotFromUserText(session, userText);

      if (!picked) {
        if (/^\d+$/.test(tNorm)) {
          await sendWhatsAppText(
            from,
            `Ese número no corresponde a un horario disponible 🙏\nResponde con uno de los números que ves en la lista, o escribe una hora como "10:00 am".`
          );
          return res.sendStatus(200);
        }

        const parsed = parseUserTimeTo24h(userText);

        if (parsed) {
          await sendWhatsAppText(
            from,
            `Entendí *${userText}* ✅\nPero ese horario no está disponible.\n\nResponde con el *número* (1,2,3...) o elige una *hora disponible* (ej: 10:00 am / 3:00 pm).`
          );
          return res.sendStatus(200);
        }

        await sendWhatsAppText(
          from,
          `No entendí el horario 🙏\nResponde con el *número* (1,2,3...) o la *hora* (ej: 10:00 am / 3:00 pm).`
        );
        return res.sendStatus(200);
      }

      if (session.reschedule?.active && session.reschedule.appointment_id) {
        const appointment_id = session.reschedule.appointment_id;
        const nextService = session.pendingService || picked.service || session.reschedule.service;

        await rescheduleAppointmentTool({
          appointment_id,
          new_slot_id: picked.slot_id,
          new_start: picked.start,
          new_end: picked.end,
          service: nextService,
          patient_name: session.reschedule.patient_name,
          phone: session.reschedule.phone || from,
          wa_id: from,
        });

        const prettyService = SERVICES.find((s) => s.key === nextService)?.title || nextService;

        session.lastBooking = {
          appointment_id,
          start: picked.start,
          end: picked.end,
          service: nextService,
          patient_name: session.reschedule.patient_name || session.lastBooking?.patient_name || "",
          phone: session.reschedule.phone || String(from).replace(/[^\d]/g, ""),
        };

        session.state = "post_booking";
        session.lastSlots = [];
        session.lastDisplaySlots = [];
        session.selectedSlot = null;
        session.pendingRange = null;
        session.pendingName = null;
        session.reschedule = defaultSession().reschedule;

        await sendWhatsAppText(
          from,
          `✅ *Cita reprogramada*\n\n🦷 Servicio: *${prettyService}*\n📅 Fecha: *${formatDateInTZ(
            picked.start,
            CLINIC_TIMEZONE
          )}*\n⏰ Hora: *${formatTimeInTZ(picked.start, CLINIC_TIMEZONE)}*\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
        );
        return res.sendStatus(200);
      }

      session.selectedSlot = picked;
      session.state = "await_name";
      await sendWhatsAppText(
        from,
        `Perfecto ✅ Queda seleccionado el horario ${formatTimeInTZ(picked.start, CLINIC_TIMEZONE)}.\nAhora indícame tu *nombre completo* para reservar.`
      );
      return res.sendStatus(200);
    }

    // AWAIT NAME
    if (session.state === "await_name" && session.selectedSlot) {
      if (tNorm.length < 3 || ["si", "sí", "ok", "listo"].includes(tNorm)) {
        await sendWhatsAppText(from, `Por favor, envíame tu *nombre completo* 🙂`);
        return res.sendStatus(200);
      }
      session.pendingName = userText;
      session.state = "await_phone";
      await sendWhatsAppText(from, `Gracias. Ahora envíame tu *número de teléfono* (ej: 829XXXXXXX) para completar la reserva.`);
      return res.sendStatus(200);
    }

    // AWAIT PHONE -> BOOK
    if (session.state === "await_phone" && session.selectedSlot && session.pendingName) {
      const phoneDigits = userText.replace(/[^\d]/g, "");
      if (phoneDigits.length < 8) {
        await sendWhatsAppText(from, `Ese número parece incompleto 🙏\nEnvíame el teléfono así: 829XXXXXXX`);
        return res.sendStatus(200);
      }

      const slot = session.selectedSlot;
      const booked = await bookAppointmentTool({
        patient_name: session.pendingName,
        phone: phoneDigits,
        slot_id: slot.slot_id,
        service: session.pendingService || slot.service,
        notes: "",
        slot_start: slot.start,
        slot_end: slot.end,
        wa_id: from,
      });

      const prettyService = SERVICES.find((s) => s.key === booked.service)?.title || booked.service;

      await sendWhatsAppText(
        from,
        `✅ *Cita reservada*\n\n🦷 Servicio: *${prettyService}*\n👤 Paciente: *${booked.patient_name}*\n📞 Teléfono: *${phoneDigits}*\n📅 Fecha: *${formatDateInTZ(booked.start, CLINIC_TIMEZONE)}*\n⏰ Hora: *${formatTimeInTZ(booked.start, CLINIC_TIMEZONE)}*\n📍 Dirección: ${CLINIC_ADDRESS || "—"}\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
      );

      await notifyPersonalWhatsAppBookingSummary(booked);

      session.lastBooking = booked;
      session.state = "post_booking";
      session.lastSlots = [];
      session.lastDisplaySlots = [];
      session.selectedSlot = null;
      session.pendingName = null;
      session.pendingRange = null;
      session.reschedule = defaultSession().reschedule;

      return res.sendStatus(200);
    }

    // Services menu ask
    if (
      tNorm.includes("servicios") ||
      tNorm.includes("cuales servicios") ||
      tNorm.includes("qué servicios") ||
      tNorm.includes("que servicios") ||
      tNorm.includes("menu") ||
      tNorm.includes("menú")
    ) {
      await sendWhatsAppText(from, servicesEmojiText());
      await sendServicesList(from);
      return res.sendStatus(200);
    }

    // Detect service and date range
    const serviceKey = detectServiceKeyFromUser(userText);

    if (serviceKey === "urgencias") {
      await sendWhatsAppText(
        from,
        `⚠️ Para *urgencias*, descríbeme brevemente qué ocurre (dolor, sangrado, inflamación, golpe) y te ayudamos de inmediato.\n\nSi es una emergencia severa, llama a emergencias o acude al centro más cercano.`
      );
      return res.sendStatus(200);
    }

    if (!serviceKey && (tNorm.includes("agendar") || tNorm.includes("cita") || tNorm.includes("reservar"))) {
      await sendWhatsAppText(from, `Claro ✅ ¿Qué servicio deseas?`);
      await sendWhatsAppText(from, servicesEmojiText());
      await sendServicesList(from);
      return res.sendStatus(200);
    }

    if (serviceKey) {
      session.pendingService = serviceKey;

      const range = parseDateRangeFromText(userText);

      if (!range) {
        session.state = "await_day";
        await sendWhatsAppText(
          from,
          `Perfecto ✅ deseas cita para *${SERVICES.find((s) => s.key === serviceKey)?.title || serviceKey}*.\n\n¿Para qué día?\nEj: "mañana", "viernes", "próximo martes", "la semana que viene" o "14 de junio".`
        );
        return res.sendStatus(200);
      }

      const slots = await getAvailableSlotsTool({ service: serviceKey, from: range.from, to: range.to });

      if (!slots.length) {
        await sendWhatsAppText(
          from,
          `No veo espacios disponibles para ese rango 🙏\nDime otro día (ej: "próximo viernes") o un mes (ej: "en junio").`
        );
        session.state = "await_day";
        return res.sendStatus(200);
      }

      session.pendingRange = range;
      session.lastSlots = slots;
      session.state = "await_slot_choice";

      const listText = formatSlotsList(serviceKey, slots, session);
      await sendWhatsAppText(from, listText);
      return res.sendStatus(200);
    }

    if (!serviceKey && session.pendingService) {
      const range = parseDateRangeFromText(userText);
      if (range) {
        const slots = await getAvailableSlotsTool({ service: session.pendingService, from: range.from, to: range.to });

        if (!slots.length) {
          await sendWhatsAppText(
            from,
            `No veo espacios disponibles para ese rango 🙏\nDime otro día (ej: "próximo viernes") o un mes (ej: "en junio").`
          );
          return res.sendStatus(200);
        }

        session.pendingRange = range;
        session.lastSlots = slots;
        session.state = "await_slot_choice";

        const listText = formatSlotsList(session.pendingService, slots, session);
        await sendWhatsAppText(from, listText);
        return res.sendStatus(200);
      }

      if (session.state === "await_day") {
        await sendWhatsAppText(
          from,
          `Para elegir el día, puedes escribir: "mañana", "viernes", "próximo martes", "la semana que viene", "14 de junio" o "en junio".`
        );
        return res.sendStatus(200);
      }
    }

    // Fallback: OpenAI
    const reply = await callOpenAI({
      session,
      userId: from,
      userText,
      userPhone: from,
      extraSystem: session.pendingService ? `Nota: el servicio actual pendiente es ${session.pendingService}.` : "",
    });

    if (normalizeText(reply).includes("servicio")) {
      await sendWhatsAppText(from, reply);
      await sendWhatsAppText(from, servicesEmojiText());
      await sendServicesList(from);
      return res.sendStatus(200);
    }

    await sendWhatsAppText(from, reply);
    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e?.message || e);
    return res.sendStatus(200);
  } finally {
    try {
      if (from && session) await saveSession(from, session);
    } catch (e) {
      console.error("saveSession error:", e?.message || e);
    }
  }
});

app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// =========================
// Recordatorios (24h y 2h)
// =========================
async function reminderLoop() {
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const in26h = addMinutes(now, 26 * 60);

    const list = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: in26h.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });

    const events = list.data.items || [];

    for (const ev of events) {
      const priv = ev.extendedProperties?.private || {};
      if (priv.status === "cancelled") continue;

      const phone = priv.wa_phone;
      const startISO = ev.start?.dateTime;
      if (!phone || !startISO) continue;

      const start = new Date(startISO);
      const minutesToStart = Math.round((start.getTime() - now.getTime()) / 60000);

      const in24hWindow = minutesToStart <= 25 * 60 && minutesToStart >= 23 * 60;
      const in2hWindow = minutesToStart <= 135 && minutesToStart >= 90;

      if (REMINDER_24H && in24hWindow && priv.reminder24hSent !== "true") {
        const msg =
          `Recordatorio 🦷: tienes cita mañana a las ${formatTimeInTZ(startISO, CLINIC_TIMEZONE)} en ${CLINIC_NAME}.\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`;

        const sendRes = await sendReminderWhatsAppToBestTarget(priv, phone, msg);

        if (sendRes.ok) {
          await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: ev.id,
            requestBody: { extendedProperties: { private: { ...priv, reminder24hSent: "true" } } },
          });
        } else {
          console.error("[reminder24h] could not send", { tried: sendRes.tried, error: sendRes.error });
        }
      }

      if (REMINDER_2H && in2hWindow && priv.reminder2hSent !== "true") {
        const msg =
          `Recordatorio 🦷: tu cita es hoy a las ${formatTimeInTZ(startISO, CLINIC_TIMEZONE)} en ${CLINIC_NAME}.\nDirección: ${CLINIC_ADDRESS || "—"}\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`;

        const sendRes = await sendReminderWhatsAppToBestTarget(priv, phone, msg);

        if (sendRes.ok) {
          await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: ev.id,
            requestBody: { extendedProperties: { private: { ...priv, reminder2hSent: "true" } } },
          });
        } else {
          console.error("[reminder2h] could not send", { tried: sendRes.tried, error: sendRes.error });
        }
      }
    }
  } catch (e) {
    console.error("Reminder loop error:", e?.response?.data || e?.message || e);
  }
}

app.get("/tick", async (_req, res) => {
  try {
    await reminderLoop();
  } catch {}
  return res.status(200).send("tick ok");
});

// =========================
// Start
// =========================
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));

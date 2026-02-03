import express from "express";
import axios from "axios";
import crypto from "crypto";
import { google } from "googleapis";

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

const REMINDER_24H = (process.env.REMINDER_24H || "1") === "1";
const REMINDER_2H = (process.env.REMINDER_2H || "1") === "1";

// =========================
// Express (raw body for signature check)
// =========================
const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// =========================
// Simple memory (MVP)
// In prod: Redis / DB
// =========================
const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      messages: [],
      state: "idle", // idle | awaiting_slot | awaiting_name | awaiting_phone | post_appointment | awaiting_reschedule_slot
      lastSlots: null,
      pendingSlot: null,
      pendingService: null,
      pendingRange: null,
      patientName: null,
      patientPhone: null,
      activeAppointment: null, // { appointment_id, start, end, service, patient_name, phone }
    });
  }
  return sessions.get(userId);
}

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

function defaultWorkHours() {
  return {
    mon: { start: "09:00", end: "18:00" },
    tue: { start: "09:00", end: "18:00" },
    wed: { start: "09:00", end: "18:00" },
    thu: { start: "09:00", end: "18:00" },
    fri: { start: "09:00", end: "18:00" },
    sat: { start: "09:00", end: "13:00" },
    sun: null,
  };
}

function defaultServiceDuration() {
  return { limpieza: 45, caries: 45, ortodoncia: 30, blanqueamiento: 60, evaluacion: 30, otro: 30 };
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true;
  const signature = req.get("X-Hub-Signature-256");
  if (!signature) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || Buffer.from("")).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function parseHM(hm) {
  const [h, m] = hm.split(":").map((n) => parseInt(n, 10));
  return { h, m };
}

// ---------- Timezone-safe helpers (CLINIC_TIMEZONE) ----------
function partsInTZ(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return map;
}

function ymdInClinicTZ(date) {
  const p = partsInTZ(date, CLINIC_TIMEZONE);
  return `${p.year}-${p.month}-${p.day}`;
}

function addDaysYMD(ymd, days) {
  const [Y, M, D] = ymd.split("-").map(Number);
  const t = Date.UTC(Y, M - 1, D) + days * 86400000;
  const d = new Date(t);
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function getTimeZoneOffsetMs(date, timeZone) {
  // Offset = (time in TZ as UTC) - (real UTC time)
  const p = partsInTZ(date, timeZone);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

function makeDateInTZ(ymd, hm, timeZone) {
  const [Y, M, D] = ymd.split("-").map(Number);
  const { h, m } = parseHM(hm);

  // Start with a UTC guess, then correct with timezone offset at that instant
  const utcGuess = new Date(Date.UTC(Y, M - 1, D, h, m, 0));
  const offset = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function toISOInClinicTZFromYMD(ymd, hm) {
  return makeDateInTZ(ymd, hm, CLINIC_TIMEZONE).toISOString();
}

function formatInClinicTZ(iso) {
  const dt = new Date(iso);
  return new Intl.DateTimeFormat("es-DO", {
    timeZone: CLINIC_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}

function formatTimeInClinicTZ(iso) {
  const dt = new Date(iso);
  return new Intl.DateTimeFormat("es-DO", {
    timeZone: CLINIC_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(dt);
}

function weekdayKeyFromYMD(ymd) {
  const noon = makeDateInTZ(ymd, "12:00", CLINIC_TIMEZONE);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TIMEZONE, weekday: "short" }).format(noon);
  const map = { Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat" };
  return map[wd] || "mon";
}

function ceilToStep(date, stepMin) {
  const ms = date.getTime();
  const stepMs = stepMin * 60000;
  const rounded = Math.ceil(ms / stepMs) * stepMs;
  return new Date(rounded);
}

function normalizeISO(input, kind = "from") {
  if (!input) return null;
  const s = String(input).trim();

  // YYYY-MM-DD => start/end of day in clinic TZ
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return kind === "to" ? toISOInClinicTZFromYMD(s, "23:59") : toISOInClinicTZFromYMD(s, "00:00");
  }

  // Otherwise try Date parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();

  return null;
}

function looksLikeThanks(text) {
  return /^(ok|okay|listo|gracias|perfecto|dale|genial|bien|👍|✅)\b/i.test(text.trim());
}

function wantsCancel(text) {
  return /\b(cancel(ar|a|o|ación)?|anular)\b/i.test(text);
}

function wantsReschedule(text) {
  return /\b(reprogram(ar|a|o)?|mover|cambiar\s*(la\s*)?cita|reagendar)\b/i.test(text);
}

function wantsNewAppointment(text) {
  return /\b(nueva\s*cita|agendar\s*otra|otra\s*cita|cita\s*nueva|agendar\s*nuevamente)\b/i.test(text);
}

function extractPhone(text) {
  const digits = String(text || "").replace(/[^\d]/g, "");
  if (digits.length >= 8) return digits;
  return null;
}

function extractSlotChoice(text, slots) {
  const t = String(text || "").trim();

  // If user replies a number (1..n)
  const n = parseInt(t, 10);
  if (!isNaN(n) && n >= 1 && n <= slots.length) return slots[n - 1];

  // If user replies hour like "10" or "10:00"
  if (/^\d{1,2}(:\d{2})?$/.test(t)) {
    const hm = t.includes(":") ? t : `${t}:00`;
    const [hh, mm] = hm.split(":").map((x) => parseInt(x, 10));

    for (const s of slots) {
      const p = partsInTZ(new Date(s.start), CLINIC_TIMEZONE);
      const sh = parseInt(p.hour, 10);
      const sm = parseInt(p.minute, 10);
      if (sh === hh && sm === mm) return s;
    }
  }

  return null;
}

function formatSlotLine(slot, i) {
  const startT = formatTimeInClinicTZ(slot.start);
  const endT = formatTimeInClinicTZ(slot.end);
  return `${i + 1}. ${startT} - ${endT}`;
}

function prettyConfirmation(appt) {
  return (
    `✅ *Cita reservada*\n\n` +
    `🦷 Servicio: *${appt.service}*\n` +
    `👤 Nombre: *${appt.patient_name}*\n` +
    `📞 Teléfono: *${appt.phone}*\n` +
    `📅 Fecha: *${formatInClinicTZ(appt.start)}*\n` +
    `⏰ Hora: *${formatTimeInClinicTZ(appt.start)}*\n` +
    (CLINIC_ADDRESS ? `📍 Dirección: ${CLINIC_ADDRESS}\n` : "") +
    `\n¿Deseas *reprogramar* o *cancelar*?`
  );
}

// =========================
// WhatsApp send text
// =========================
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
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
  return busy.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function buildCandidateSlots({ service, fromISO, toISO, durationMin }) {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const slots = [];

  // Range in clinic YMD
  const startYMD = ymdInClinicTZ(from);
  const endYMD = ymdInClinicTZ(to);

  // iterate day by day by YMD (clinic local)
  for (let ymd = startYMD; ymd <= endYMD; ymd = addDaysYMD(ymd, 1)) {
    const key = weekdayKeyFromYMD(ymd);
    const wh = WORK_HOURS[key];
    if (!wh) continue;

    const dayStart = makeDateInTZ(ymd, wh.start, CLINIC_TIMEZONE);
    const dayEnd = makeDateInTZ(ymd, wh.end, CLINIC_TIMEZONE);

    // window within [from,to]
    let cursor = new Date(Math.max(dayStart.getTime(), from.getTime()));
    cursor = ceilToStep(cursor, SLOT_STEP_MIN);

    while (addMinutes(cursor, durationMin) <= dayEnd && cursor <= to) {
      const end = addMinutes(cursor, durationMin);
      slots.push({
        slot_id: "slot_" + cursor.getTime(),
        service: service || "evaluacion",
        start: cursor.toISOString(),
        end: end.toISOString(),
      });
      cursor = addMinutes(cursor, SLOT_STEP_MIN);
    }
  }

  // sort
  slots.sort((a, b) => new Date(a.start) - new Date(b.start));
  return slots;
}

async function getAvailableSlotsTool({ service, from, to }) {
  const calendar = getCalendarClient();

  const durationMin = SERVICE_DURATION?.[service] || SERVICE_DURATION?.["otro"] || 30;

  // Normalize input ISO
  let normFrom = normalizeISO(from, "from");
  let normTo = normalizeISO(to, "to");

  // ✅ Blindaje: si viene en pasado (ej. 2024), lo movemos a hoy -> +7 días (en RD)
  const todayYMD = ymdInClinicTZ(new Date());
  const todayStart = new Date(toISOInClinicTZFromYMD(todayYMD, "00:00"));

  if (!normFrom) normFrom = toISOInClinicTZFromYMD(todayYMD, "00:00");
  if (!normTo) normTo = toISOInClinicTZFromYMD(addDaysYMD(todayYMD, 7), "23:59");

  const fromDate = new Date(normFrom);
  const toDate = new Date(normTo);

  if (toDate < todayStart) {
    normFrom = toISOInClinicTZFromYMD(todayYMD, "00:00");
    normTo = toISOInClinicTZFromYMD(addDaysYMD(todayYMD, 7), "23:59");
  } else {
    if (fromDate < todayStart) {
      normFrom = toISOInClinicTZFromYMD(todayYMD, "00:00");
    }
    if (new Date(normTo) < new Date(normFrom)) {
      normTo = toISOInClinicTZFromYMD(addDaysYMD(todayYMD, 7), "23:59");
    }
  }

  const busyRanges = await getBusyRanges(calendar, normFrom, normTo);
  const candidates = buildCandidateSlots({ service, fromISO: normFrom, toISO: normTo, durationMin });

  const free = candidates.filter((c) => {
    const cs = new Date(c.start);
    const ce = new Date(c.end);
    return !busyRanges.some((b) => overlaps(cs, ce, b.start, b.end));
  });

  return free.slice(0, 8);
}

// =========================
// Calendar: book / reschedule / cancel
// =========================
async function bookAppointmentTool({ patient_name, phone, slot_id, service, notes, slot_start, slot_end }) {
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
          patient_name,
          service,
          slot_id,
          reminder24hSent: "false",
          reminder2hSent: "false",
        },
      },
    },
  });

  return {
    appointment_id: event.data.id,
    start: slot_start,
    end: slot_end,
    service,
    patient_name,
    phone,
  };
}

async function rescheduleAppointmentTool({ appointment_id, new_slot_id, new_start, new_end }) {
  const calendar = getCalendarClient();

  if (!new_start || !new_end) throw new Error("Missing new_start/new_end");

  const updated = await calendar.events.patch({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId: appointment_id,
    requestBody: {
      start: { dateTime: new_start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: new_end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: {
        private: {
          slot_id: new_slot_id,
          reminder24hSent: "false",
          reminder2hSent: "false",
        },
      },
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
        private: {
          ...(event.data.extendedProperties?.private || {}),
          status: "cancelled",
        },
      },
    },
  });

  return { ok: true, appointment_id };
}

async function handoffToHumanTool({ summary }) {
  return { ok: true, routed: true, summary };
}

// =========================
// OpenAI: tool calling
// =========================
async function callOpenAI({ userId, userText, userPhone }) {
  const session = getSession(userId);

  // ✅ Mini pre-procesamiento de typo común
  let cleaned = String(userText || "").trim();
  cleaned = cleaned.replace(/agrandar/gi, "agendar");

  // ✅ Estado post-cita: no reiniciar flujo
  if (session.state === "post_appointment" && session.activeAppointment) {
    if (looksLikeThanks(cleaned)) {
      return `¡Perfecto! ✅\nTe esperamos el ${formatInClinicTZ(session.activeAppointment.start)} a las ${formatTimeInClinicTZ(
        session.activeAppointment.start
      )}.\n\nSi necesitas *reprogramar* o *cancelar*, escríbelo aquí.`;
    }

    if (wantsNewAppointment(cleaned)) {
      // reinicia para cita nueva
      session.state = "idle";
      session.lastSlots = null;
      session.pendingSlot = null;
      session.pendingService = null;
      session.patientName = null;
      session.patientPhone = null;
      // seguimos al flow normal (OpenAI)
    } else if (wantsCancel(cleaned)) {
      // cancelar directo con memoria
      const out = await cancelAppointmentTool({
        appointment_id: session.activeAppointment.appointment_id,
        reason: "Cancelación solicitada por el paciente (WhatsApp).",
      });
      session.state = "idle";
      const when = `${formatInClinicTZ(session.activeAppointment.start)} ${formatTimeInClinicTZ(session.activeAppointment.start)}`;
      session.activeAppointment = null;
      return out.ok ? `✅ Listo. Tu cita (${when}) fue *cancelada*.\n\n¿Deseas agendar una cita nueva?` : `No pude cancelar ahora mismo. ¿Puedes intentar de nuevo?`;
    } else if (wantsReschedule(cleaned)) {
      // pedir slots para reprogramar (próximos 7 días)
      session.state = "awaiting_reschedule_slot";
      session.pendingService = session.activeAppointment.service;

      const todayYMD = ymdInClinicTZ(new Date());
      const from = toISOInClinicTZFromYMD(todayYMD, "00:00");
      const to = toISOInClinicTZFromYMD(addDaysYMD(todayYMD, 7), "23:59");

      const slots = await getAvailableSlotsTool({ service: session.pendingService, from, to });
      session.lastSlots = slots;

      if (!slots.length) {
        return `Ahora mismo no veo espacios disponibles en los próximos días para *${session.pendingService}*.\n¿Quieres que lo revise para otra semana?`;
      }

      const lines = slots.map((s, i) => formatSlotLine(s, i)).join("\n");
      return `Perfecto ✅\nEstos son los horarios disponibles para *${session.pendingService}* (hora Santo Domingo):\n\n${lines}\n\nResponde con el *número* (1-${slots.length}) o con la *hora* (ej: 10:00).`;
    }
  }

  // ✅ Selección de slot (nuevo agendamiento)
  if (session.state === "awaiting_slot" && Array.isArray(session.lastSlots) && session.lastSlots.length) {
    const chosen = extractSlotChoice(cleaned, session.lastSlots);
    if (chosen) {
      session.pendingSlot = chosen;
      session.pendingService = chosen.service;
      session.state = "awaiting_name";
      return `Perfecto ✅ Queda seleccionado el horario *${formatTimeInClinicTZ(chosen.start)}*.\nAhora indícame tu *nombre completo* para reservar.`;
    }
    return `Dime el *número* del horario (1-${session.lastSlots.length}) o la *hora* (ej: 10:00).`;
  }

  // ✅ Selección de slot (reprogramación)
  if (session.state === "awaiting_reschedule_slot" && session.activeAppointment && session.lastSlots?.length) {
    const chosen = extractSlotChoice(cleaned, session.lastSlots);
    if (chosen) {
      const out = await rescheduleAppointmentTool({
        appointment_id: session.activeAppointment.appointment_id,
        new_slot_id: chosen.slot_id,
        new_start: chosen.start,
        new_end: chosen.end,
      });

      if (out.ok) {
        // actualizar memoria de cita
        session.activeAppointment.start = chosen.start;
        session.activeAppointment.end = chosen.end;
        session.state = "post_appointment";
        return (
          `✅ Listo. Tu cita fue *reprogramada*.\n\n` +
          `📅 Nueva fecha: *${formatInClinicTZ(chosen.start)}*\n` +
          `⏰ Nueva hora: *${formatTimeInClinicTZ(chosen.start)}*\n\n` +
          `Si deseas *cancelar* o hacer una *cita nueva*, dímelo.`
        );
      }

      return `No pude reprogramar ahora mismo. ¿Puedes intentar de nuevo?`;
    }
    return `Responde con el *número* (1-${session.lastSlots.length}) o con la *hora* (ej: 10:00).`;
  }

  // ✅ Captura nombre
  if (session.state === "awaiting_name") {
    // Evitar que el nombre sea solo números
    if (/^\d+$/.test(cleaned)) {
      return `Necesito tu *nombre completo* (ej: Franny Inoa).`;
    }
    session.patientName = cleaned;
    session.state = "awaiting_phone";
    return `Gracias, *${session.patientName}*.\nAhora envíame tu *número de teléfono* (ej: 829XXXXXXX) para completar la reserva.`;
  }

  // ✅ Captura teléfono + BOOK REAL (con start/end exactos)
  if (session.state === "awaiting_phone") {
    const phone = extractPhone(cleaned);
    if (!phone) {
      return `¿Me confirmas tu *número de teléfono*? (solo números, ej: 8294926619)`;
    }
    session.patientPhone = phone;

    if (!session.pendingSlot) {
      // por seguridad
      session.state = "idle";
      return `Se me perdió el horario seleccionado 😅\n¿Quieres que te muestre los horarios disponibles otra vez?`;
    }

    const booked = await bookAppointmentTool({
      patient_name: session.patientName || "Paciente",
      phone: session.patientPhone,
      slot_id: session.pendingSlot.slot_id,
      service: session.pendingSlot.service || "evaluacion",
      notes: "",
      slot_start: session.pendingSlot.start,
      slot_end: session.pendingSlot.end,
    });

    session.activeAppointment = booked;
    session.state = "post_appointment";

    // limpiar pendientes para no duplicar
    session.lastSlots = null;
    session.pendingSlot = null;

    return prettyConfirmation(booked);
  }

  // ---- OpenAI normal flow (para preguntas, pedir servicio, pedir rango, etc.) ----
  const now = new Date();
  const TODAY_YMD = ymdInClinicTZ(now);
  const NOW_HUMAN = new Intl.DateTimeFormat("es-DO", {
    timeZone: CLINIC_TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  const apptCtx = session.activeAppointment
    ? `\nCita activa en memoria:\n- appointment_id: ${session.activeAppointment.appointment_id}\n- servicio: ${session.activeAppointment.service}\n- fecha: ${formatInClinicTZ(session.activeAppointment.start)}\n- hora: ${formatTimeInClinicTZ(session.activeAppointment.start)}\n`
    : "";

  const system = {
    role: "system",
    content: `
Eres un asistente de WhatsApp de ${CLINIC_NAME} para agendar citas.

Fecha y hora REALES ahora (Santo Domingo):
- Hoy: ${TODAY_YMD}
- Hora: ${NOW_HUMAN}
Zona horaria: ${CLINIC_TIMEZONE}

Reglas:
- No diagnostiques ni des consejo médico. Solo agenda y triage.
- Urgencias (dolor severo, sangrado fuerte, fiebre, trauma, hinchazón intensa): llama a handoff_to_human.
- NO inventes horarios. Solo ofrece slots de get_available_slots.
- Para reservar, debes pedir al usuario que elija un slot por número o por hora.
- Mantén respuestas cortas, claras y con opciones.

Servicios válidos: limpieza, caries, ortodoncia, blanqueamiento, evaluacion, otro.
Tel usuario: ${userPhone}.
${apptCtx}
`,
  };

  // Guardar historial para la IA
  session.messages.push({ role: "user", content: cleaned });
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
          properties: {
            summary: { type: "string" },
          },
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

  // Tool calls
  if (msg?.tool_calls?.length) {
    const toolResults = [];
    let lastSlots = null;

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments || "{}");

      if (name === "get_available_slots") {
        const slots = await getAvailableSlotsTool(args);
        lastSlots = slots;

        // ✅ Guardar slots en memoria para que el usuario responda con número/hora
        session.lastSlots = slots;
        session.state = "awaiting_slot";
        session.pendingService = args.service || "evaluacion";

        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify({ slots }),
        });
      }

      if (name === "book_appointment") {
        const booked = await bookAppointmentTool(args);
        session.activeAppointment = booked;
        session.state = "post_appointment";

        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify({ booked }),
        });
      }

      if (name === "reschedule_appointment") {
        const out = await rescheduleAppointmentTool(args);
        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify(out),
        });
      }

      if (name === "cancel_appointment") {
        const out = await cancelAppointmentTool(args);
        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify(out),
        });
      }

      if (name === "handoff_to_human") {
        const out = await handoffToHumanTool(args);
        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify(out),
        });
      }
    }

    const resp2 = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [...messages, msg, ...toolResults],
        temperature: 0.2,
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    let finalText = resp2.data.choices?.[0]?.message?.content?.trim() || "";

    // ✅ Si obtuvimos slots, los mostramos en formato fijo y pedimos elección
    if (lastSlots?.length) {
      const dateLabel = formatInClinicTZ(lastSlots[0].start);
      const lines = lastSlots.map((s, i) => formatSlotLine(s, i)).join("\n");
      finalText =
        `Estos son los horarios disponibles para *${session.pendingService}* (${dateLabel}) (hora Santo Domingo):\n\n` +
        `${lines}\n\n` +
        `Responde con el *número* (1-${lastSlots.length}) o con la *hora* (ej: 10:00).`;
    }

    session.messages.push({ role: "assistant", content: finalText });
    return finalText || "¿Para qué servicio deseas la cita? (limpieza, caries, ortodoncia, blanqueamiento, evaluación)";
  }

  const text =
    msg?.content?.trim() ||
    "Hola 👋 ¿Qué servicio deseas agendar? (limpieza, caries, ortodoncia, blanqueamiento, evaluación)";
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

app.post("/webhook", async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) return res.sendStatus(403);

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    // ✅ Ignorar eventos que no son mensajes de texto reales (tests, estados, etc.)
    if (!msg.from || !msg.text?.body) return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text.body;

    const reply = await callOpenAI({ userId: from, userText: text, userPhone: from });
    await sendWhatsAppText(from, reply);

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.message || e);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("OK"));

// =========================
// Recordatorios (24h y 2h)
// =========================
async function reminderLoop() {
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const in26h = addMinutes(now, 26 * 60);
    const in3h = addMinutes(now, 3 * 60);

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

      // 24h reminder
      if (
        REMINDER_24H &&
        minutesToStart <= 24 * 60 &&
        minutesToStart >= 24 * 60 - 30 &&
        priv.reminder24hSent !== "true"
      ) {
        await sendWhatsAppText(
          phone,
          `Recordatorio 🦷: tienes cita *mañana* en ${CLINIC_NAME}.\n📅 ${formatInClinicTZ(startISO)}\n⏰ ${formatTimeInClinicTZ(
            startISO
          )}\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
        );

        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: { private: { ...priv, reminder24hSent: "true" } },
          },
        });
      }

      // 2h reminder
      if (REMINDER_2H && minutesToStart <= 120 && minutesToStart >= 105 && priv.reminder2hSent !== "true") {
        await sendWhatsAppText(
          phone,
          `Recordatorio 🦷: tu cita es *hoy* en ${CLINIC_NAME}.\n📅 ${formatInClinicTZ(startISO)}\n⏰ ${formatTimeInClinicTZ(
            startISO
          )}\n${CLINIC_ADDRESS ? `📍 ${CLINIC_ADDRESS}\n` : ""}\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
        );

        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: { private: { ...priv, reminder2hSent: "true" } },
          },
        });
      }
    }
  } catch (e) {
    console.error("Reminder loop error:", e?.message || e);
  }
}

// cada 5 minutos
setInterval(reminderLoop, 5 * 60 * 1000);

// =========================
// Start
// =========================
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));

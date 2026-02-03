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
      state: "IDLE", // IDLE | BOOKED | RESCHEDULE
      lastAppointment: null, // {appointment_id,start,end,service,patient_name,phone}
      lastSlots: [], // last get_available_slots results (for numeric selection)
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

// ---- Timezone helpers (fix hora RD) ----
function fixedOffsetForTZ() {
  // RD no usa DST: siempre -04:00
  if (CLINIC_TIMEZONE === "America/Santo_Domingo") return "-04:00";
  // fallback: si cambias TZ a otra, usa Z (puedes mejorar luego con luxon)
  return "Z";
}

function normalizeISO(input, kind = "from") {
  // kind: "from" -> 00:00 ; "to" -> 23:59
  const offset = fixedOffsetForTZ();
  const s = String(input || "").trim();
  if (!s) throw new Error("Missing date input");

  const hasTZ = /([zZ]|[+-]\d{2}:\d{2})$/.test(s);

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const time = kind === "to" ? "23:59:00" : "00:00:00";
    return `${s}T${time}${offset === "Z" ? "Z" : offset}`;
  }

  // Has time but no timezone suffix
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !hasTZ) {
    return `${s}${offset === "Z" ? "Z" : offset}`;
  }

  // Already ISO with TZ
  return s;
}

function ymdInClinicTZ(date) {
  // en-CA => YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function weekdayKeyFromYMD(ymd) {
  // ymd in clinic tz; compute weekday in UTC date (safe for weekday when using pure ymd)
  const [yy, mm, dd] = ymd.split("-").map((n) => parseInt(n, 10));
  const utc = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0)); // noon avoids edge cases
  const d = utc.getUTCDay(); // 0=Sun..6=Sat
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d];
}

function addDaysYMD(ymd, days) {
  const [yy, mm, dd] = ymd.split("-").map((n) => parseInt(n, 10));
  const utc = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
  utc.setUTCDate(utc.getUTCDate() + days);
  const yyyy = utc.getUTCFullYear();
  const m2 = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d2 = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${m2}-${d2}`;
}

function toISOInClinicTZFromYMD(ymd, hm) {
  const offset = fixedOffsetForTZ();
  const suffix = offset === "Z" ? "Z" : offset;
  return `${ymd}T${hm}:00${suffix}`;
}

function formatInClinicTZ(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-DO", {
    timeZone: CLINIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function formatTimeInClinicTZ(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-DO", {
    timeZone: CLINIC_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function formatDateInClinicTZ(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-DO", {
    timeZone: CLINIC_TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

function formatSlotLine(slot, i) {
  const t = formatTimeInClinicTZ(slot.start);
  return `${i + 1}) ${t}`;
}

function looksLikeChoiceNumber(text) {
  const t = String(text || "").trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = parseInt(t, 10);
  if (n >= 1 && n <= 20) return n;
  return null;
}

function looksLikePhone(text) {
  const digits = String(text || "").replace(/\D/g, "");
  return digits.length >= 9;
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
  // fromISO/toISO ya normalizados con offset
  const from = new Date(fromISO);
  const to = new Date(toISO);

  const startYMD = ymdInClinicTZ(from);
  const endYMD = ymdInClinicTZ(to);

  const slots = [];
  let ymd = startYMD;
  let guard = 0;

  while (true) {
    guard++;
    if (guard > 400) break; // safety

    const key = weekdayKeyFromYMD(ymd);
    const wh = WORK_HOURS[key];
    if (wh) {
      const dayStartISO = toISOInClinicTZFromYMD(ymd, wh.start);
      const dayEndISO = toISOInClinicTZFromYMD(ymd, wh.end);

      const dayStart = new Date(dayStartISO);
      const dayEnd = new Date(dayEndISO);

      // clamp to [from,to]
      let cursor = new Date(Math.max(dayStart.getTime(), from.getTime()));
      cursor.setSeconds(0, 0);

      while (addMinutes(cursor, durationMin) <= dayEnd && cursor <= to) {
        const end = addMinutes(cursor, durationMin);
        slots.push({
          slot_id: "slot_" + cursor.getTime(),
          service: service || "evaluacion",
          start: cursor.toISOString(), // instante real
          end: end.toISOString(),
          local_time: formatTimeInClinicTZ(cursor.toISOString()),
          local_date: formatDateInClinicTZ(cursor.toISOString()),
        });
        cursor = addMinutes(cursor, SLOT_STEP_MIN);
      }
    }

    if (ymd === endYMD) break;
    ymd = addDaysYMD(ymd, 1);
  }

  return slots;
}

async function getAvailableSlotsTool({ service, from, to }, session) {
  const calendar = getCalendarClient();

  const normFrom = normalizeISO(from, "from");
  const normTo = normalizeISO(to, "to");

  const durationMin = SERVICE_DURATION?.[service] || SERVICE_DURATION?.["otro"] || 30;

  const busyRanges = await getBusyRanges(calendar, normFrom, normTo);
  const candidates = buildCandidateSlots({ service, fromISO: normFrom, toISO: normTo, durationMin });

  const free = candidates.filter((c) => {
    const cs = new Date(c.start);
    const ce = new Date(c.end);
    return !busyRanges.some((b) => overlaps(cs, ce, b.start, b.end));
  });

  const limited = free.slice(0, 8);

  // guarda para selección por número
  if (session) session.lastSlots = limited;

  return limited;
}

// =========================
// Calendar: book / reschedule / cancel
// =========================
async function bookAppointmentTool({ patient_name, phone, slot_id, service, notes, slot_start, slot_end }) {
  const calendar = getCalendarClient();
  if (!slot_start || !slot_end) throw new Error("Missing slot_start/slot_end");

  const cleanPhone = String(phone || "").replace(/\D/g, "");

  const event = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: `Cita - ${service} - ${patient_name}`,
      location: CLINIC_ADDRESS || undefined,
      description: `Paciente: ${patient_name}\nTel: ${cleanPhone}\nServicio: ${service}\nNotas: ${notes || ""}\nSlotId: ${slot_id}`,
      start: { dateTime: slot_start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: slot_end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: {
        private: {
          wa_phone: cleanPhone,
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
    phone: cleanPhone,
  };
}

async function rescheduleAppointmentTool({ appointment_id, new_slot_id, new_start, new_end }) {
  const calendar = getCalendarClient();
  if (!new_start || !new_end) throw new Error("Missing new_start/new_end");

  const existing = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: appointment_id });
  const prevPriv = existing.data.extendedProperties?.private || {};

  const updated = await calendar.events.patch({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId: appointment_id,
    requestBody: {
      start: { dateTime: new_start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: new_end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: {
        private: {
          ...prevPriv,
          slot_id: new_slot_id,
          reminder24hSent: "false",
          reminder2hSent: "false",
        },
      },
    },
  });

  return {
    ok: true,
    appointment_id: updated.data.id,
    new_start,
    new_end,
  };
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
async function callOpenAI({ session, userId, userText, userPhone }) {
  // Enrich: si el usuario manda un número y tenemos slots, tradúcelo a elección explícita
  const n = looksLikeChoiceNumber(userText);
  if (n && session.lastSlots?.length) {
    const chosen = session.lastSlots[n - 1];
    if (chosen) {
      userText = `El usuario eligió la opción #${n}. Slot elegido: start=${chosen.start}, end=${chosen.end}, local_time=${chosen.local_time}, local_date=${chosen.local_date}, service=${chosen.service}.`;
    }
  }

  // Contexto post-cita (para que NO reinicie flujo)
  const appt = session.lastAppointment;

  const system = {
    role: "system",
    content: `
Eres un asistente de WhatsApp de ${CLINIC_NAME} para agendar citas.

Reglas:
- No diagnostiques ni des consejo médico. Solo agenda y triage.
- Urgencias (dolor severo, sangrado fuerte, fiebre, trauma, hinchazón intensa): llama a handoff_to_human.
- NO inventes horarios. Solo ofrece slots de get_available_slots.
- Para reservar, debes llamar a book_appointment con slot_start y slot_end EXACTOS del slot elegido.
- Para reprogramar una cita existente, usa get_available_slots y luego reschedule_appointment con new_start/new_end EXACTOS.
- Para cancelar una cita existente, usa cancel_appointment con appointment_id.
- Mantén respuestas cortas, claras y con opciones. Evita pedir datos repetidos.
- Si el usuario dice "listo/ok/gracias" después de confirmar, responde amable y ofrece reprogramar/cancelar/nueva cita.

Servicios válidos: limpieza, caries, ortodoncia, blanqueamiento, evaluacion, otro.
Zona horaria: ${CLINIC_TIMEZONE}.
Dirección: ${CLINIC_ADDRESS || "No especificada"}.
Tel usuario (WhatsApp): ${userPhone}.

${
  appt
    ? `CITA ACTUAL (ya reservada):
- appointment_id: ${appt.appointment_id}
- servicio: ${appt.service}
- fecha/hora: ${formatInClinicTZ(appt.start)} (hora local)
- nombre: ${appt.patient_name}
- teléfono: ${appt.phone}

Si el usuario quiere "reprogramar" o "cancelar", se refiere a esta cita por defecto.
Si el usuario quiere "otra" / "nueva" cita adicional, procede a agendar una nueva sin borrar el appointment_id anterior.`
    : ``
}
`,
  };

  session.messages.push({ role: "user", content: userText });
  const messages = [system, ...session.messages].slice(-18);

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
    let bookedResult = null;
    let rescheduledResult = null;
    let cancelledResult = null;

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments || "{}");

      if (name === "get_available_slots") {
        const slots = await getAvailableSlotsTool(args, session);
        lastSlots = slots;
        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify({
            slots: slots.map((s) => ({
              slot_id: s.slot_id,
              service: s.service,
              start: s.start,
              end: s.end,
              local_time: s.local_time,
              local_date: s.local_date,
              display: `${s.local_date} - ${s.local_time}`,
            })),
            hint: "Muestra opciones enumeradas (1..n) y pide que respondan con el número elegido.",
          }),
        });
      }

      if (name === "book_appointment") {
        const booked = await bookAppointmentTool(args);

        // guarda estado post-cita
        session.state = "BOOKED";
        session.lastAppointment = {
          appointment_id: booked.appointment_id,
          start: booked.start,
          end: booked.end,
          service: booked.service,
          patient_name: booked.patient_name,
          phone: booked.phone,
        };

        bookedResult = booked;

        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify({ booked }),
        });
      }

      if (name === "reschedule_appointment") {
        // si el modelo no envía appointment_id pero tenemos uno en sesión, úsalo
        if (!args.appointment_id && session.lastAppointment?.appointment_id) {
          args.appointment_id = session.lastAppointment.appointment_id;
        }

        const out = await rescheduleAppointmentTool(args);

        // actualiza cita en sesión
        if (session.lastAppointment?.appointment_id === out.appointment_id) {
          session.lastAppointment.start = out.new_start;
          session.lastAppointment.end = out.new_end;
          session.state = "BOOKED";
        }

        rescheduledResult = out;

        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify(out),
        });
      }

      if (name === "cancel_appointment") {
        if (!args.appointment_id && session.lastAppointment?.appointment_id) {
          args.appointment_id = session.lastAppointment.appointment_id;
        }

        const out = await cancelAppointmentTool(args);

        // limpia estado
        session.state = "IDLE";
        session.lastAppointment = null;

        cancelledResult = out;

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

    // UX fallback: si devolvió slots y no formateó
    if (lastSlots?.length && finalText.length < 5) {
      const lines = lastSlots.map((s, i) => `${i + 1}. ${s.local_time}`).join("\n");
      finalText = `Estos son los horarios disponibles (${lastSlots[0]?.local_date}):\n\n${lines}\n\nResponde con el número (1,2,3...) para elegir.`;
    }

    // Mensaje bonito y consistente si se reservó
    if (bookedResult) {
      const dt = formatInClinicTZ(bookedResult.start);
      const endT = formatTimeInClinicTZ(bookedResult.end);

      finalText =
        `✅ *Cita reservada con éxito*\n\n` +
        `🦷 Servicio: *${bookedResult.service}*\n` +
        `📅 Fecha/Hora: *${dt}* (hasta ${endT})\n` +
        `👤 Paciente: *${bookedResult.patient_name}*\n` +
        `📞 Teléfono: *${bookedResult.phone}*\n` +
        (CLINIC_ADDRESS ? `📍 Dirección: ${CLINIC_ADDRESS}\n` : ``) +
        `\n¿Deseas *reprogramar*, *cancelar* o agendar *otra* cita?`;
    }

    // Mensaje bonito si se reprogramó
    if (rescheduledResult?.ok && session.lastAppointment) {
      const dt = formatInClinicTZ(session.lastAppointment.start);
      const endT = formatTimeInClinicTZ(session.lastAppointment.end);

      finalText =
        `✅ *Cita reprogramada*\n\n` +
        `🦷 Servicio: *${session.lastAppointment.service}*\n` +
        `📅 Nueva fecha/hora: *${dt}* (hasta ${endT})\n` +
        `\n¿Necesitas *cancelar* o agendar *otra* cita?`;
    }

    // Mensaje bonito si se canceló
    if (cancelledResult?.ok) {
      finalText = `✅ Listo, tu cita fue *cancelada*.\n\nSi deseas agendar una nueva, dime el servicio (limpieza, caries, ortodoncia, blanqueamiento, evaluación).`;
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

    // Ignorar eventos que no son mensajes de texto
    if (!msg.from) return res.sendStatus(200);

    const from = msg.from;
    const session = getSession(from);

    const text = (msg.text?.body || "").trim();
    if (!text) return res.sendStatus(200);

    // --------- Estado post-cita: no reiniciar flujo ---------
    if (session.state === "BOOKED" && session.lastAppointment) {
      const cleaned = text.toLowerCase();

      // 1) Confirmación/ack
      if (/^(listo|ok|okay|gracias|perfecto|dale|bien|👍)$/i.test(text)) {
        await sendWhatsAppText(
          from,
          "✅ Perfecto. Tu cita ya quedó registrada.\n\nSi deseas *reprogramar*, *cancelar* o agendar *otra* cita, escríbelo por aquí."
        );
        return res.sendStatus(200);
      }

      // 2) Cancelar
      if (cleaned.includes("cancel")) {
        await cancelAppointmentTool({
          appointment_id: session.lastAppointment.appointment_id,
          reason: "Solicitado por el paciente (WhatsApp)",
        });
        session.state = "IDLE";
        session.lastAppointment = null;

        await sendWhatsAppText(
          from,
          "✅ Listo, tu cita fue *cancelada*.\n\nSi deseas agendar una nueva, dime el servicio (limpieza, caries, ortodoncia, blanqueamiento, evaluación)."
        );
        return res.sendStatus(200);
      }

      // 3) Reprogramar
      if (cleaned.includes("reprogram") || cleaned.includes("cambiar") || cleaned.includes("mover")) {
        session.state = "RESCHEDULE";
        await sendWhatsAppText(
          from,
          "Perfecto ✅ ¿Para qué fecha te gustaría *reprogramar*?\n\nEjemplos: “mañana”, “viernes”, o “del 10 al 15”."
        );
        return res.sendStatus(200);
      }

      // 4) Nueva cita adicional
      if (cleaned.includes("otra") || cleaned.includes("nueva") || cleaned.includes("adicional") || cleaned.includes("segunda")) {
        // mantenemos lastAppointment para historial, pero dejamos que la IA agende otra
        session.state = "IDLE";
      }
    }

    // Si venimos de RESCHEDULE y el usuario da fechas, la IA debe entender intención
    // (Le damos pista en el texto sin romper la conversación)
    let enrichedText = text;
    if (session.state === "RESCHEDULE" && session.lastAppointment) {
      enrichedText =
        `El usuario quiere REPROGRAMAR la cita existente. appointment_id=${session.lastAppointment.appointment_id}. ` +
        `La cita actual es ${formatInClinicTZ(session.lastAppointment.start)}. ` +
        `Mensaje del usuario: "${text}"`;
      // mantenemos state BOOKED, porque la IA hará reschedule_appointment
      session.state = "BOOKED";
    }

    const reply = await callOpenAI({ session, userId: from, userText: enrichedText, userPhone: from });
    await sendWhatsAppText(from, reply);

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.message || e);
    return res.sendStatus(200);
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

      // 24h reminder (24h +/- 30 min)
      if (
        REMINDER_24H &&
        minutesToStart <= 24 * 60 &&
        minutesToStart >= 24 * 60 - 30 &&
        priv.reminder24hSent !== "true"
      ) {
        await sendWhatsAppText(
          phone,
          `Recordatorio 🦷: tienes cita *mañana* a las *${formatTimeInClinicTZ(startISO)}* en *${CLINIC_NAME}*.\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
        );
        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: { private: { ...priv, reminder24hSent: "true" } },
          },
        });
      }

      // 2h reminder (2h +/- 15 min)
      if (REMINDER_2H && minutesToStart <= 120 && minutesToStart >= 105 && priv.reminder2hSent !== "true") {
        await sendWhatsAppText(
          phone,
          `Recordatorio 🦷: tu cita es *hoy* a las *${formatTimeInClinicTZ(startISO)}* en *${CLINIC_NAME}*.\n` +
            (CLINIC_ADDRESS ? `Dirección: ${CLINIC_ADDRESS}\n\n` : `\n`) +
            `Responde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
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

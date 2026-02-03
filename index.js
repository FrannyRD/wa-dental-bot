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

// ✅ NUEVO: Servicios (para botones + entendimiento por texto)
const SERVICES = [
  "Estética dental",
  "Ortodoncia",
  "Implantes",
  "Urgencias",
  "Limpiezas y prevención",
  "Odontopediatría",
];

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
  if (!sessions.has(userId)) sessions.set(userId, { messages: [] });
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

// ✅ Ajustado: duraciones para los nuevos servicios (mantengo fallback)
function defaultServiceDuration() {
  return {
    "Estética dental": 60,
    Ortodoncia: 30,
    Implantes: 60,
    Urgencias: 30,
    "Limpiezas y prevención": 45,
    Odontopediatría: 45,
    Otro: 30,
  };
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

function toISO(date) {
  return date.toISOString();
}

function parseHM(hm) {
  const [h, m] = hm.split(":").map((n) => parseInt(n, 10));
  return { h, m };
}

function weekdayKey(date) {
  // JS: 0=Sun..6=Sat
  const d = date.getDay();
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d];
}

function formatSlotLine(slot, i) {
  // slot.start is ISO
  const dt = new Date(slot.start);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${i + 1}) ${hh}:${mm} (${slot.service})`;
}

// ✅ NUEVO: normaliza servicio por botón o texto
function normalizeService(input) {
  const raw = String(input || "").trim();

  // Viene de lista: "service:Ortodoncia"
  if (raw.toLowerCase().startsWith("service:")) {
    const chosen = raw.split(":").slice(1).join(":").trim();
    if (SERVICES.includes(chosen)) return chosen;
  }

  const t = raw.toLowerCase();

  // Sinónimos / escritura libre
  if (/(limpieza|profilaxis|higiene|sarro|prevenci)/i.test(t)) return "Limpiezas y prevención";
  if (/(brackets|ortodon|alineador|retenedor)/i.test(t)) return "Ortodoncia";
  if (/(implante|tornillo|corona sobre implante)/i.test(t)) return "Implantes";
  if (/(urgencia|emergenc|dolor fuerte|sangrado|golpe|trauma|hinchaz)/i.test(t)) return "Urgencias";
  if (/(estet|carilla|blanquea|sonrisa|resina|diseño de sonrisa)/i.test(t)) return "Estética dental";
  if (/(pediatr|niñ|infant|odontopedi)/i.test(t)) return "Odontopediatría";

  return null;
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

// ✅ NUEVO: Lista bonita de servicios (interactive list)
async function sendWhatsAppServiceList(to) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const rows = SERVICES.map((s) => ({
    id: `service:${s}`,
    title: s,
    description: "",
  }));

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Nuestros servicios" },
        body: { text: "Elige el servicio que necesitas 👇" },
        footer: { text: "También puedes escribirlo (ej: limpieza, brackets, implantes)." },
        action: {
          button: "Ver servicios",
          sections: [{ title: "Servicios disponibles", rows }],
        },
      },
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

  for (let day = new Date(from); day <= to; day = addMinutes(day, 24 * 60)) {
    const key = weekdayKey(day);
    const wh = WORK_HOURS[key];
    if (!wh) continue;

    const { h: sh, m: sm } = parseHM(wh.start);
    const { h: eh, m: em } = parseHM(wh.end);

    const dayStart = new Date(day);
    dayStart.setHours(sh, sm, 0, 0);

    const dayEnd = new Date(day);
    dayEnd.setHours(eh, em, 0, 0);

    let cursor = new Date(Math.max(dayStart.getTime(), from.getTime()));
    cursor.setSeconds(0, 0);

    while (addMinutes(cursor, durationMin) <= dayEnd && cursor <= to) {
      const end = addMinutes(cursor, durationMin);
      slots.push({
        slot_id: "slot_" + cursor.getTime(),
        service: service || "Otro",
        start: cursor.toISOString(),
        end: end.toISOString(),
      });
      cursor = addMinutes(cursor, SLOT_STEP_MIN);
    }
  }

  return slots;
}

async function getAvailableSlotsTool({ service, from, to }) {
  const calendar = getCalendarClient();

  const durationMin = SERVICE_DURATION[service] || SERVICE_DURATION["Otro"] || 30;

  const busyRanges = await getBusyRanges(calendar, from, to);
  const candidates = buildCandidateSlots({ service, fromISO: from, toISO: to, durationMin });

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

  const cleaned = String(userText || "").trim();

  // ✅ NUEVO: si pide agendar pero no dijo servicio => mandamos lista bonita
  const maybeService = normalizeService(cleaned);
  const wantsAppointment = /(agendar|cita|reservar|turno|appointment)/i.test(cleaned);
  if (wantsAppointment && !maybeService) {
    // guardamos el mensaje del usuario en sesión (para contexto) y devolvemos acción
    session.messages.push({ role: "user", content: cleaned });
    return "__SEND_SERVICE_LIST__";
  }

  // ✅ NUEVO: si viene de botón service:..., conviértelo a texto limpio
  const normalizedFromButton = normalizeService(cleaned);
  const finalUserText = normalizedFromButton && cleaned.toLowerCase().startsWith("service:")
    ? normalizedFromButton
    : cleaned;

  const system = {
    role: "system",
    content: `
Eres un asistente de WhatsApp de ${CLINIC_NAME} para agendar citas.
Reglas:
- No diagnostiques ni des consejo médico. Solo agenda y triage.
- Urgencias (dolor severo, sangrado fuerte, fiebre, trauma, hinchazón intensa): llama a handoff_to_human.
- NO inventes horarios. Solo ofrece slots de get_available_slots.
- Para reservar, debes llamar a book_appointment con slot_start y slot_end EXACTOS del slot elegido.
- Mantén respuestas cortas, claras y con opciones.

Servicios válidos: ${SERVICES.join(", ")}.
Interpretación por texto:
- “limpieza / profilaxis / sarro” => “Limpiezas y prevención”
- “brackets / alineadores” => “Ortodoncia”
- “implante(s)” => “Implantes”
- “niños / infantil” => “Odontopediatría”
- “urgencia / dolor fuerte / sangrado / golpe / hinchazón” => “Urgencias”
- “carillas / blanqueamiento / estética” => “Estética dental”

Zona horaria: ${CLINIC_TIMEZONE}.
Tel usuario: ${userPhone}.
`,
  };

  session.messages.push({ role: "user", content: finalUserText });
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

  if (msg?.tool_calls?.length) {
    const toolResults = [];
    let lastSlots = null;

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments || "{}");

      if (name === "get_available_slots") {
        const slots = await getAvailableSlotsTool(args);
        lastSlots = slots;
        toolResults.push({
          tool_call_id: tc.id,
          role: "tool",
          name,
          content: JSON.stringify({ slots }),
        });
      }

      if (name === "book_appointment") {
        const booked = await bookAppointmentTool(args);
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

    if (lastSlots?.length && /slots/i.test(JSON.stringify(toolResults)) && finalText.length < 5) {
      const lines = lastSlots.map((s, i) => formatSlotLine(s, i)).join("\n");
      finalText = `Estos son los horarios disponibles:\n${lines}\n\nRespóndeme con el número (1,2,3...) y tu nombre completo.`;
    }

    session.messages.push({ role: "assistant", content: finalText });
    return finalText || "¿Para qué servicio deseas la cita?";
  }

  const text = msg?.content?.trim() || "Hola 👋 ¿Qué servicio deseas agendar?";
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

    // ✅ CAMBIO: aceptar texto o interactive (lista/botón), ignorar estados/tests/etc.
    if (!msg.from) return res.sendStatus(200);
    const hasText = !!msg.text?.body;
    const hasInteractive = !!msg.interactive;
    if (!hasText && !hasInteractive) return res.sendStatus(200);

    const from = msg.from;

    // Texto normal
    let text = msg.text?.body?.trim() || "";

    // Selección lista (service list)
    const listReplyId = msg.interactive?.list_reply?.id;
    if (listReplyId) text = listReplyId;

    // (Opcional) reply buttons
    const buttonReplyId = msg.interactive?.button_reply?.id;
    if (buttonReplyId) text = buttonReplyId;

    const reply = await callOpenAI({ userId: from, userText: text, userPhone: from });

    // ✅ Si toca mostrar lista bonita de servicios
    if (reply === "__SEND_SERVICE_LIST__") {
      await sendWhatsAppServiceList(from);
      return res.sendStatus(200);
    }

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

      if (
        REMINDER_24H &&
        minutesToStart <= 24 * 60 &&
        minutesToStart >= 24 * 60 - 30 &&
        priv.reminder24hSent !== "true"
      ) {
        await sendWhatsAppText(
          phone,
          `Recordatorio 🦷: tienes cita mañana a las ${String(start.getHours()).padStart(2, "0")}:${String(
            start.getMinutes()
          ).padStart(2, "0")} en ${CLINIC_NAME}.\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
        );
        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: { private: { ...priv, reminder24hSent: "true" } },
          },
        });
      }

      if (
        REMINDER_2H &&
        minutesToStart <= 120 &&
        minutesToStart >= 105 &&
        priv.reminder2hSent !== "true"
      ) {
        await sendWhatsAppText(
          phone,
          `Recordatorio 🦷: tu cita es hoy a las ${String(start.getHours()).padStart(2, "0")}:${String(
            start.getMinutes()
          ).padStart(2, "0")} en ${CLINIC_NAME}.\nDirección: ${CLINIC_ADDRESS}\n\nResponde:\n1) Confirmar\n2) Reprogramar\n3) Cancelar`
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

setInterval(reminderLoop, 5 * 60 * 1000);

// =========================
// Start
// =========================
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));

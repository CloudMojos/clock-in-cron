import { Resend } from "resend";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);
const BASE = "https://penbrothers-ess-api.payrollsolutions.ph";
const TIMEZONE = "Asia/Manila";
const OFF_DAYS_FILE = new URL("./off-days.txt", import.meta.url);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function getManilaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function getWorkDate(type, now = new Date()) {
  const manilaDate = getManilaDate(now);
  return type === "OUT" ? shiftDate(manilaDate, -1) : manilaDate;
}

function parseOffDays(raw) {
  return raw.split(/[\n,]/).reduce((dates, entry) => {
    const value = entry.split("#")[0].trim();

    if (!value) return dates;
    if (!ISO_DATE.test(value)) {
      console.warn(`Ignoring invalid off day "${value}". Use YYYY-MM-DD.`);
      return dates;
    }

    dates.add(value);
    return dates;
  }, new Set());
}

function loadOffDays() {
  const offDays = new Set();

  if (existsSync(OFF_DAYS_FILE)) {
    for (const date of parseOffDays(readFileSync(OFF_DAYS_FILE, "utf8"))) {
      offDays.add(date);
    }
  }

  return offDays;
}

function shouldSkipClock(type, now = new Date()) {
  const workDate = getWorkDate(type, now);
  return {
    workDate,
    skip: loadOffDays().has(workDate),
  };
}

async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.ESS_USERNAME,
      password: process.env.ESS_PASSWORD,
      is_mobile: "0",
      is_keep_me_logged_in: "0",
    }),
  });

  if (!res.ok) throw new Error(`Login failed: ${res.status}`);

  const token = res.headers.get("x-auth-token");
  const cookie = res.headers.get("set-cookie");
  if (!token) throw new Error("No auth token in response");

  return { token, cookie };
}

async function bundy(token, cookie, type) {
  const isIn = type === "IN";

  const res = await fetch(`${BASE}/bundy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": token,
      ...(cookie && { Cookie: cookie }),
    },
    body: JSON.stringify({
      time_log_type_name: type,
      time_log_type_id: isIn ? 1 : 2,
      longitude: isIn ? 121.05484504859514 : 121.05506061193887,
      latitude: isIn ? 14.54114051458121 : 14.54100408764181,
    }),
  });

  if (!res.ok) throw new Error(`Clock ${type} failed: ${res.status}`);
  // Try to parse as JSON, but fallback to text if not JSON
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // Not JSON, return as plain text
    return text;
  }
}

async function sendEmail(type, success, detail) {
  const timestamp = new Date().toLocaleString("en-PH", {
    timeZone: TIMEZONE,
  });
  try {
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: process.env.NOTIFY_EMAIL,
      subject: success
        ? `✅ Clock ${type} Successful — ${timestamp}`
        : `❌ Clock ${type} Failed — ${timestamp}`,
      html: success
        ? `<h2>✅ Clock ${type} successful</h2><p><strong>Time:</strong> ${timestamp}</p><pre>${JSON.stringify(detail, null, 2)}</pre>`
        : `<h2>❌ Clock ${type} failed</h2><p><strong>Time:</strong> ${timestamp}</p><p><strong>Error:</strong> ${detail}</p>`,
    });
    console.log(
      `📧 Email sent to ${process.env.NOTIFY_EMAIL} for Clock ${type} (${success ? "success" : "failure"}) at ${timestamp}`,
    );
  } catch (emailErr) {
    console.error(
      `❌ Failed to send email to ${process.env.NOTIFY_EMAIL} for Clock ${type} at ${timestamp}:`,
      emailErr.message,
    );
  }
}

async function main() {
  const type = (process.argv[2] || "IN").toUpperCase();

  if (!["IN", "OUT"].includes(type)) {
    throw new Error('Clock type must be "IN" or "OUT".');
  }

  const { skip, workDate } = shouldSkipClock(type);
  if (skip) {
    console.log(`Skipping Clock ${type} for off day ${workDate}`);
    return;
  }

  try {
    const { token, cookie } = await login();
    const data = await bundy(token, cookie, type);
    await sendEmail(type, true, data);
    console.log(`✅ Clock ${type} success`);
  } catch (err) {
    await sendEmail(type, false, err.message);
    console.error(`❌ Clock ${type} failed:`, err.message);
    process.exit(1); // marks the workflow run as failed
  }
}

main();

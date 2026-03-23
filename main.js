import { Resend } from "resend";
import dotenv from "dotenv";
dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);
const BASE = "https://penbrothers-ess-api.payrollsolutions.ph";

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
  return await res.json();
}

async function sendEmail(type, success, detail) {
  const timestamp = new Date().toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
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

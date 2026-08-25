// EVI Station Alert — Scriptable widget
// iOS + Scriptable
//
// First run inside Scriptable: configure Worker URL + CONTROL_TOKEN.
// Add the script as a Medium Home Screen widget.

const SCRIPT_NAME = Script.name();
const KEY_URL = "evi.workerURL";
const KEY_TOKEN = "evi.controlToken";

const action = args.queryParameters?.action || "";

if (!config.runsInWidget) {
  if (action) {
    await handleAction(action);
  } else {
    await showMenu();
  }
  Script.complete();
  return;
}

const widget = await buildWidget();
Script.setWidget(widget);
Script.complete();

async function showMenu() {
  const alert = new Alert();
  alert.title = "EVI Station Alert";
  alert.message = "גמלא 3, חדרה";
  alert.addAction("הגדרה / שינוי שרת");
  alert.addAction("בדיקה עכשיו");
  alert.addCancelAction("סגור");

  const choice = await alert.presentSheet();
  if (choice === 0) {
    await setup();
  } else if (choice === 1) {
    const result = await apiRequest("/refresh", "POST");
    await presentStatus(result);
  }
}

async function setup() {
  const alert = new Alert();
  alert.title = "הגדרת EVI Station Alert";
  alert.message = "הכנס את כתובת ה-Worker ואת ה-CONTROL_TOKEN. הנתונים נשמרים מקומית ב-Keychain של Scriptable.";
  alert.addTextField("Worker URL", Keychain.contains(KEY_URL) ? Keychain.get(KEY_URL) : "");
  alert.addTextField("CONTROL_TOKEN", Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : "");
  alert.addAction("שמור");
  alert.addCancelAction("ביטול");

  const result = await alert.presentAlert();
  if (result < 0) return;

  let url = alert.textFieldValue(0).trim();
  const token = alert.textFieldValue(1).trim();
  if (url.endsWith("/")) url = url.slice(0, -1);

  if (!url.startsWith("https://") || !token) {
    const err = new Alert();
    err.title = "הגדרה לא תקינה";
    err.message = "נדרשים Worker URL מסוג https:// ו-CONTROL_TOKEN.";
    err.addAction("OK");
    await err.presentAlert();
    return;
  }

  Keychain.set(KEY_URL, url);
  Keychain.set(KEY_TOKEN, token);

  const ok = new Alert();
  ok.title = "נשמר ✓";
  ok.message = "אפשר כעת להוסיף את הסקריפט כווידג׳ט למסך הבית.";
  ok.addAction("OK");
  await ok.presentAlert();
}

async function handleAction(action) {
  try {
    if (action === "toggle") {
      const current = await apiRequest("/status", "GET");
      await apiRequest("/monitor", "POST", { enabled: !current.enabled });
    } else if (action === "refresh") {
      await apiRequest("/refresh", "POST");
    } else if (action === "setup") {
      await setup();
    }
  } catch (error) {
    const alert = new Alert();
    alert.title = "EVI Station Alert";
    alert.message = String(error);
    alert.addAction("OK");
    await alert.presentAlert();
  }
}

async function buildWidget() {
  const widget = new ListWidget();
  widget.setPadding(14, 14, 12, 14);

  let status;
  let errorText = null;

  try {
    status = await apiRequest("/status", "GET");
  } catch (error) {
    status = emptyStatus();
    errorText = String(error);
  }

  const header = widget.addStack();
  header.centerAlignContent();

  const title = header.addText("⚡ גמלא 3, חדרה");
  title.font = Font.boldSystemFont(15);

  header.addSpacer();

  const toggle = header.addText(status.enabled ? "🟢 ON" : "⚫ OFF");
  toggle.font = Font.boldSystemFont(13);
  toggle.url = actionURL("toggle");

  widget.addSpacer(8);

  if (errorText || status.lastError) {
    const error = widget.addText(`⚠️ ${errorText || status.lastError}`);
    error.font = Font.systemFont(11);
    error.textColor = Color.secondaryLabel();
    error.lineLimit = 3;
  } else {
    const summary = widget.addStack();
    summary.centerAlignContent();

    const count = summary.addText(String(status.availableCount ?? 0));
    count.font = Font.boldSystemFont(30);

    summary.addSpacer(5);

    const label = summary.addText("פנויים");
    label.font = Font.systemFont(13);
    label.textColor = Color.secondaryLabel();

    summary.addSpacer();

    const refresh = summary.addText("↻ רענן");
    refresh.font = Font.systemFont(12);
    refresh.textColor = Color.link();
    refresh.url = actionURL("refresh");

    widget.addSpacer(7);

    for (const socket of (status.sockets || []).slice(0, 4)) {
      const row = widget.addStack();
      row.centerAlignContent();

      const icon = row.addText(statusEmoji(socket.status));
      icon.font = Font.systemFont(12);
      row.addSpacer(6);

      const name = row.addText(socket.name || `מחבר ${socket.id}`);
      name.font = Font.systemFont(12);
      name.lineLimit = 1;

      row.addSpacer();

      const state = row.addText(statusHebrew(socket.status));
      state.font = Font.systemFont(11);
      state.textColor = Color.secondaryLabel();

      widget.addSpacer(3);
    }
  }

  widget.addSpacer();

  const footer = widget.addStack();
  footer.centerAlignContent();

  const monitorText = footer.addText(status.enabled ? "בדיקה בענן כל 5 דקות" : "המעקב כבוי");
  monitorText.font = Font.systemFont(9);
  monitorText.textColor = Color.secondaryLabel();

  footer.addSpacer();

  const last = footer.addText(formatLastCheck(status.lastCheck));
  last.font = Font.systemFont(9);
  last.textColor = Color.secondaryLabel();

  // This is only a request to iOS. The reliable 5-minute polling happens in Cloudflare.
  widget.refreshAfterDate = new Date(Date.now() + (status.enabled ? 5 : 30) * 60 * 1000);
  return widget;
}

async function apiRequest(path, method, body = null) {
  if (!Keychain.contains(KEY_URL) || !Keychain.contains(KEY_TOKEN)) {
    throw new Error("הסקריפט עדיין לא מוגדר. פתח אותו ב-Scriptable ובצע Setup.");
  }

  const base = Keychain.get(KEY_URL).replace(/\/$/, "");
  const token = Keychain.get(KEY_TOKEN);

  const request = new Request(base + path);
  request.method = method;
  request.headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  };

  if (body) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(body);
  }

  const data = await request.loadJSON();
  if (request.response?.statusCode < 200 || request.response?.statusCode >= 300) {
    throw new Error(data?.error || `HTTP ${request.response?.statusCode}`);
  }

  return data;
}

function actionURL(action) {
  const name = encodeURIComponent(SCRIPT_NAME);
  return `scriptable:///run?scriptName=${name}&action=${encodeURIComponent(action)}`;
}

function statusEmoji(status) {
  switch (String(status || "").toUpperCase()) {
    case "AVAILABLE": return "🟢";
    case "CHARGING":
    case "OCCUPIED":
    case "DISCHARGING": return "🔴";
    case "RESERVED": return "🟡";
    case "IN_MAINTENANCE": return "🛠️";
    case "FAULTED": return "⚠️";
    case "UNAVAILABLE": return "⚫";
    default: return "⚪";
  }
}

function statusHebrew(status) {
  switch (String(status || "").toUpperCase()) {
    case "AVAILABLE": return "פנוי";
    case "CHARGING": return "בטעינה";
    case "OCCUPIED": return "תפוס";
    case "DISCHARGING": return "בשימוש";
    case "PAUSED": return "מושהה";
    case "PREPARING": return "בהכנה";
    case "FINISHING": return "מסיים";
    case "RESERVED": return "שמור";
    case "FAULTED": return "תקלה";
    case "UNAVAILABLE": return "לא זמין";
    case "IN_MAINTENANCE": return "בתחזוקה";
    default: return "לא ידוע";
  }
}

function formatLastCheck(iso) {
  if (!iso) return "טרם נבדק";
  const date = new Date(iso);
  const formatter = new DateFormatter();
  formatter.locale = "he_IL";
  formatter.useNoDateStyle();
  formatter.useShortTimeStyle();
  return `עודכן ${formatter.string(date)}`;
}

function emptyStatus() {
  return {
    enabled: false,
    lastCheck: null,
    lastError: null,
    availableCount: 0,
    station: null,
    sockets: [],
  };
}

async function presentStatus(status) {
  const alert = new Alert();
  alert.title = "גמלא 3, חדרה";
  alert.message = `פנויים: ${status.availableCount ?? 0}\nמעקב: ${status.enabled ? "ON" : "OFF"}`;
  alert.addAction("OK");
  await alert.presentAlert();
}

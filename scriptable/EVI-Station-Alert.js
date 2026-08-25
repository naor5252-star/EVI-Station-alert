// EVI Station Alert — Scriptable widget
// Monitors SONOL EVI stations 2733 + 2790 at Gamla 3, Hadera.

const SCRIPT_NAME = Script.name();
const KEY_URL = "evi.workerURL";
const KEY_TOKEN = "evi.controlToken";

const action = args.queryParameters?.action || "";

async function main() {
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
}

await main();

async function showMenu() {
  const alert = new Alert();
  alert.title = "EVI Station Alert";
  alert.message = "גמלא 3, חדרה — תחנות 2733 + 2790";
  alert.addAction("הגדרה / שינוי שרת");
  alert.addAction("בדיקה עכשיו");
  alert.addAction("הפעל / כבה מעקב");
  alert.addCancelAction("סגור");

  const choice = await alert.presentSheet();

  if (choice === 0) {
    await setup();
  } else if (choice === 1) {
    const result = await apiRequest("/refresh", "POST");
    await presentStatus(result);
  } else if (choice === 2) {
    const current = await apiRequest("/status", "GET");
    const result = await apiRequest("/monitor", "POST", {
      enabled: !current.enabled,
    });
    await presentStatus(result);
  }
}

async function setup() {
  const alert = new Alert();
  alert.title = "הגדרת EVI Station Alert";
  alert.message =
    "הכנס את כתובת ה-Worker ואת ה-CONTROL_TOKEN. הנתונים נשמרים מקומית ב-Keychain של Scriptable.";

  alert.addTextField(
    "Worker URL",
    Keychain.contains(KEY_URL) ? Keychain.get(KEY_URL) : "",
  );

  alert.addTextField(
    "CONTROL_TOKEN",
    Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : "",
  );

  alert.addAction("שמור");
  alert.addCancelAction("ביטול");

  const result = await alert.presentAlert();
  if (result < 0) return;

  let url = alert.textFieldValue(0).trim();
  const token = alert.textFieldValue(1).trim();

  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  if (!url.startsWith("https://") || !token) {
    const err = new Alert();
    err.title = "הגדרה לא תקינה";
    err.message =
      "נדרשים Worker URL מסוג https:// ו-CONTROL_TOKEN.";
    err.addAction("OK");
    await err.presentAlert();
    return;
  }

  Keychain.set(KEY_URL, url);
  Keychain.set(KEY_TOKEN, token);

  const ok = new Alert();
  ok.title = "נשמר ✓";
  ok.message =
    "הווידג׳ט יעקוב אחרי תחנות 2733 ו-2790.";
  ok.addAction("OK");
  await ok.presentAlert();
}

async function handleAction(action) {
  try {
    if (action === "toggle") {
      const current = await apiRequest("/status", "GET");

      const result = await apiRequest(
        "/monitor",
        "POST",
        { enabled: !current.enabled },
      );

      await presentStatus(result);
    } else if (action === "refresh") {
      const result = await apiRequest(
        "/refresh",
        "POST",
      );

      await presentStatus(result);
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
  widget.setPadding(12, 14, 10, 14);

  let status;
  let errorText = null;

  try {
    status = normalizeStatus(
      await apiRequest("/status", "GET"),
    );
  } catch (error) {
    status = emptyStatus();
    errorText = String(error);
  }

  const header = widget.addStack();
  header.centerAlignContent();

  const title = header.addText("⚡ גמלא 3, חדרה");
  title.font = Font.boldSystemFont(15);

  header.addSpacer();

  const toggle = header.addText(
    status.enabled ? "🟢 ON" : "⚫ OFF",
  );

  toggle.font = Font.boldSystemFont(13);
  toggle.url = actionURL("toggle");

  widget.addSpacer(6);

  if (errorText || status.lastError) {
    const error = widget.addText(
      `⚠️ ${errorText || status.lastError}`,
    );

    error.font = Font.systemFont(10);
    error.textColor = Color.secondaryLabel();
    error.lineLimit = 4;
  } else {
    const summary = widget.addStack();
    summary.centerAlignContent();

    const count = summary.addText(
      String(status.availableCount ?? 0),
    );

    count.font = Font.boldSystemFont(28);

    summary.addSpacer(5);

    const label = summary.addText("פנויים");
    label.font = Font.systemFont(13);
    label.textColor = Color.secondaryLabel();

    summary.addSpacer();

    const refresh = summary.addText("↻ רענן");
    refresh.font = Font.systemFont(12);
    refresh.textColor = Color.link();
    refresh.url = actionURL("refresh");

    widget.addSpacer(5);

    const rows = (status.sockets || []).slice(0, 4);

    if (rows.length === 0) {
      const noSockets = widget.addText(
        "לא התקבלו מחברים מהתחנות",
      );
      noSockets.font = Font.systemFont(11);
      noSockets.textColor = Color.secondaryLabel();
    }

    for (const socket of rows) {
      const row = widget.addStack();
      row.centerAlignContent();

      const icon = row.addText(
        statusEmoji(socket.status),
      );
      icon.font = Font.systemFont(11);

      row.addSpacer(5);

      const station = row.addText(
        `${socket.stationId || "?"}`,
      );
      station.font = Font.boldSystemFont(11);

      row.addSpacer(5);

      const name = row.addText(
        compactConnectorName(socket),
      );
      name.font = Font.systemFont(11);
      name.lineLimit = 1;

      row.addSpacer();

      const state = row.addText(
        statusHebrew(socket.status),
      );
      state.font = Font.systemFont(10);
      state.textColor = Color.secondaryLabel();

      widget.addSpacer(2);
    }
  }

  widget.addSpacer();

  const footer = widget.addStack();
  footer.centerAlignContent();

  const monitorText = footer.addText(
    status.enabled
      ? "2733 + 2790 • כל 5 דקות"
      : "המעקב כבוי",
  );

  monitorText.font = Font.systemFont(8);
  monitorText.textColor = Color.secondaryLabel();

  footer.addSpacer();

  const last = footer.addText(
    formatLastCheck(status.lastCheck),
  );

  last.font = Font.systemFont(8);
  last.textColor = Color.secondaryLabel();

  widget.refreshAfterDate = new Date(
    Date.now() +
      (status.enabled ? 5 : 30) * 60 * 1000,
  );

  return widget;
}

async function apiRequest(
  path,
  method,
  body = null,
) {
  if (
    !Keychain.contains(KEY_URL) ||
    !Keychain.contains(KEY_TOKEN)
  ) {
    throw new Error(
      "הסקריפט עדיין לא מוגדר. פתח אותו ב-Scriptable ובצע Setup.",
    );
  }

  const base = Keychain
    .get(KEY_URL)
    .replace(/\/$/, "");

  const token = Keychain.get(KEY_TOKEN);

  const request = new Request(base + path);
  request.method = method;

  request.headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  if (body) {
    request.headers["Content-Type"] =
      "application/json";
    request.body = JSON.stringify(body);
  }

  const data = await request.loadJSON();
  const code = request.response?.statusCode;

  if (code < 200 || code >= 300) {
    throw new Error(
      data?.error || `HTTP ${code}`,
    );
  }

  return data;
}

function actionURL(action) {
  const name = encodeURIComponent(SCRIPT_NAME);

  return (
    `scriptable:///run?scriptName=${name}` +
    `&action=${encodeURIComponent(action)}`
  );
}

function normalizeStatus(status) {
  const normalized = {
    ...emptyStatus(),
    ...(status || {}),
  };

  normalized.sockets = (
    normalized.sockets || []
  ).map((socket) => ({
    ...socket,
    stationId:
      socket.stationId ||
      normalized.station?.id ||
      "?",
  }));

  return normalized;
}

function compactConnectorName(socket) {
  const name = String(
    socket.name || `מחבר ${socket.id}`,
  );

  if (/^connector\s+\d+$/i.test(name)) {
    return name.replace(
      /^connector/i,
      "מחבר",
    );
  }

  return name;
}

function statusEmoji(status) {
  switch (
    String(status || "").toUpperCase()
  ) {
    case "AVAILABLE":
      return "🟢";

    case "CHARGING":
    case "OCCUPIED":
    case "DISCHARGING":
      return "🔴";

    case "RESERVED":
      return "🟡";

    case "IN_MAINTENANCE":
      return "🛠️";

    case "FAULTED":
      return "⚠️";

    case "UNAVAILABLE":
      return "⚫";

    default:
      return "⚪";
  }
}

function statusHebrew(status) {
  switch (
    String(status || "").toUpperCase()
  ) {
    case "AVAILABLE":
      return "פנוי";

    case "CHARGING":
      return "בטעינה";

    case "OCCUPIED":
      return "תפוס";

    case "DISCHARGING":
      return "בשימוש";

    case "PAUSED":
      return "מושהה";

    case "PREPARING":
      return "בהכנה";

    case "FINISHING":
      return "מסיים";

    case "RESERVED":
      return "שמור";

    case "FAULTED":
      return "תקלה";

    case "UNAVAILABLE":
      return "לא זמין";

    case "IN_MAINTENANCE":
      return "בתחזוקה";

    default:
      return "לא ידוע";
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
    stations: [],
    station: null,
    sockets: [],
  };
}

async function presentStatus(status) {
  const normalized = normalizeStatus(status);

  const stationLines = (
    normalized.stations || []
  ).map((station) =>
    `${station.id}: ${station.availableCount ?? 0}/${station.socketCount ?? 0} פנויים`
  );

  const alert = new Alert();
  alert.title = "גמלא 3, חדרה";

  alert.message = [
    `סה״כ פנויים: ${normalized.availableCount ?? 0}`,
    ...stationLines,
    `מעקב: ${normalized.enabled ? "ON" : "OFF"}`,
  ].join("\n");

  alert.addAction("OK");
  await alert.presentAlert();
}

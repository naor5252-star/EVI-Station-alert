// EVI Station Alert — Scriptable widget
// Separate monitoring: SONOL = home, EV Edge KLA = work.

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
  alert.message = "🏠 SONOL לבית · 🏢 EV Edge לעבודה";
  alert.addAction("🏠 רענן SONOL");
  alert.addAction("🏠 הפעל / כבה SONOL");
  alert.addAction("🏢 רענן EV Edge");
  alert.addAction("🏢 הפעל / כבה EV Edge");
  alert.addAction("⚙️ הגדרה / שינוי שרת");
  alert.addCancelAction("סגור");

  const choice = await alert.presentSheet();

  if (choice === 0) {
    await refreshProvider("sonol");
  } else if (choice === 1) {
    await toggleProvider("sonol");
  } else if (choice === 2) {
    await refreshProvider("evedge");
  } else if (choice === 3) {
    await toggleProvider("evedge");
  } else if (choice === 4) {
    await setup();
  }
}

async function setup() {
  const alert = new Alert();
  alert.title = "הגדרת EVI Station Alert";
  alert.message =
    "הכנס את כתובת ה-Worker ואת ה-CONTROL_TOKEN. פרטי EV Edge נשמרים רק ב-Cloudflare.";

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
  ok.message = "SONOL ו-EV Edge משתמשים באותו Worker עם כפתורי ניטור נפרדים.";
  ok.addAction("OK");
  await ok.presentAlert();
}

async function handleAction(action) {
  try {
    // Keep old deep-links working for SONOL.
    if (action === "toggle" || action === "toggle-sonol") {
      await toggleProvider("sonol");
    } else if (action === "refresh" || action === "refresh-sonol") {
      await refreshProvider("sonol");
    } else if (action === "toggle-evedge") {
      await toggleProvider("evedge");
    } else if (action === "refresh-evedge") {
      await refreshProvider("evedge");
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

async function toggleProvider(provider) {
  const current = await apiRequest(`/${provider}/status`, "GET");
  const result = await apiRequest(
    `/${provider}/monitor`,
    "POST",
    { enabled: !current.enabled },
  );
  await presentProviderStatus(provider, result);
}

async function refreshProvider(provider) {
  const result = await apiRequest(`/${provider}/refresh`, "POST");
  await presentProviderStatus(provider, result);
}

async function buildWidget() {
  const widget = new ListWidget();
  widget.setPadding(12, 14, 10, 14);

  let all;
  let errorText = null;

  try {
    all = await apiRequest("/status/all", "GET");
  } catch (error) {
    all = {
      sonol: emptySonolStatus(),
      evedge: emptyEVEdgeStatus(),
    };
    errorText = String(error);
  }

  const sonol = normalizeSonol(all.sonol);
  const evedge = normalizeEVEdge(all.evedge);

  const header = widget.addStack();
  header.centerAlignContent();

  const title = header.addText("⚡ טעינה");
  title.font = Font.boldSystemFont(15);

  header.addSpacer();

  const sub = header.addText("בית + עבודה");
  sub.font = Font.systemFont(10);
  sub.textColor = Color.gray();

  widget.addSpacer(8);

  if (errorText) {
    const error = widget.addText(`⚠️ ${errorText}`);
    error.font = Font.systemFont(10);
    error.textColor = Color.gray();
    error.lineLimit = 4;
  } else {
    const sonolTotal = (sonol.stations || []).reduce(
      (sum, station) => sum + Number(station.socketCount || 0),
      0,
    );

    const sonolRows = (sonol.stations || []).map((station) => ({
      label: `תחנה ${station.id}`,
      available: Number(station.availableCount || 0),
      total: Number(station.socketCount || 0),
    }));

    addStatusGroup(widget, {
      icon: "🏠",
      title: "בית · גמלא 3",
      provider: "sonol",
      status: sonol,
      available: Number(sonol.availableCount || 0),
      total: sonolTotal,
      cadence: "כל 30 שנ׳",
      subRows: sonolRows,
    });

    widget.addSpacer(8);

    const evEdgeRows = (evedge.locations || []).map((location) => ({
      label: location.building || location.id,
      available: Number(location.availableCount || 0),
      total: Number(location.totalCount || 0),
    }));

    addStatusGroup(widget, {
      icon: "🏢",
      title: "עבודה · KLA",
      provider: "evedge",
      status: evedge,
      available: Number(evedge.availableCount || 0),
      total: Number(evedge.totalCount || 0),
      cadence: "כל דקה",
      subRows: evEdgeRows,
    });
  }

  widget.addSpacer();

  const footer = widget.addText(
    "דגימה = ניטור אוטומטי · 🟢 יש פנוי · 🔴 אין פנוי",
  );
  footer.font = Font.systemFont(8);
  footer.textColor = Color.gray();
  footer.lineLimit = 1;

  widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

  return widget;
}

function availabilityPresentation(available, total) {
  const free = Number(available || 0);
  const capacity = Number(total || 0);

  if (free > 0) {
    return {
      icon: "🟢",
      text: "יש עמדות פנויות",
      count: capacity > 0 ? `${free}/${capacity}` : `${free}`,
    };
  }

  if (capacity > 0) {
    return {
      icon: "🔴",
      text: "אין עמדות פנויות",
      count: `0/${capacity}`,
    };
  }

  return {
    icon: "⚪",
    text: "מצב לא ידוע",
    count: "",
  };
}

function addStatusGroup(
  widget,
  {
    icon,
    title,
    provider,
    status,
    available,
    total,
    cadence,
    subRows = [],
  },
) {
  const sampleActive = status.enabled === true;
  const availability = availabilityPresentation(available, total);

  const header = widget.addStack();
  header.centerAlignContent();

  const label = header.addText(`${icon} ${title}`);
  label.font = Font.boldSystemFont(13);

  header.addSpacer();

  const sampling = header.addText(
    sampleActive ? "🟢 דגימה פעילה" : "⚫ דגימה כבויה",
  );
  sampling.font = Font.boldSystemFont(10);
  sampling.url = actionURL(`toggle-${provider}`);

  widget.addSpacer(2);

  const availabilityRow = widget.addStack();
  availabilityRow.centerAlignContent();

  const availabilityText = availabilityRow.addText(
    `${availability.icon} ${availability.text}`,
  );
  availabilityText.font = Font.boldSystemFont(12);

  availabilityRow.addSpacer();

  if (availability.count) {
    const count = availabilityRow.addText(availability.count);
    count.font = Font.boldSystemFont(12);
  }

  for (const row of subRows) {
    widget.addSpacer(2);

    const item = widget.addStack();
    item.centerAlignContent();

    const itemStatus = availabilityPresentation(
      row.available,
      row.total,
    );

    const itemLabel = item.addText(
      `${itemStatus.icon} ${row.label}`,
    );
    itemLabel.font = Font.systemFont(9);

    item.addSpacer();

    const itemText = item.addText(
      itemStatus.count
        ? `${itemStatus.text} · ${itemStatus.count}`
        : itemStatus.text,
    );
    itemText.font = Font.systemFont(9);
    itemText.textColor = Color.gray();
    itemText.lineLimit = 1;
  }

  widget.addSpacer(2);

  const bottom = widget.addStack();
  bottom.centerAlignContent();

  const detail = bottom.addText(
    status.lastError
      ? `⚠️ ${status.lastError}`
      : `דגימה: ${sampleActive ? "פעילה" : "כבויה"} · ${cadence}`,
  );
  detail.font = Font.systemFont(8);
  detail.textColor = Color.gray();
  detail.lineLimit = 1;

  bottom.addSpacer();

  const refresh = bottom.addText("↻ רענון");
  refresh.font = Font.systemFont(9);
  refresh.textColor = Color.blue();
  refresh.url = actionURL(`refresh-${provider}`);
}

async function apiRequest(path, method, body = null) {
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
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(body);
  }

  const data = await request.loadJSON();
  const code = request.response?.statusCode;

  if (code < 200 || code >= 300) {
    throw new Error(data?.error || `HTTP ${code}`);
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

function normalizeSonol(status) {
  return {
    ...emptySonolStatus(),
    ...(status || {}),
  };
}

function normalizeEVEdge(status) {
  return {
    ...emptyEVEdgeStatus(),
    ...(status || {}),
  };
}

function emptySonolStatus() {
  return {
    enabled: false,
    lastCheck: null,
    lastError: null,
    availableCount: 0,
    stations: [],
    sockets: [],
  };
}

function emptyEVEdgeStatus() {
  return {
    enabled: false,
    lastCheck: null,
    lastError: null,
    availableCount: 0,
    totalCount: 0,
    locations: [],
    evses: [],
  };
}

async function presentProviderStatus(provider, status) {
  const alert = new Alert();

  if (provider === "sonol") {
    const s = normalizeSonol(status);
    const stationLines = (s.stations || []).map(
      (station) =>
        `${station.id}: ${station.availableCount ?? 0}/${station.socketCount ?? 0} פנויים`,
    );

    alert.title = "🏠 SONOL · גמלא 3";
    alert.message = [
      `סה״כ פנויים: ${s.availableCount ?? 0}`,
      ...stationLines,
      `מעקב: ${s.enabled ? "ON" : "OFF"}`,
      "קצב: כל 30 שניות",
    ].join("\n");
  } else {
    const s = normalizeEVEdge(status);
    const locationLines = (s.locations || []).map((location) => {
      const available = Number(location.availableCount || 0);
      const total = Number(location.totalCount || 0);
      const icon = total === 0 ? "⚪" : (available > 0 ? "🟢" : "🔴");
      return (
        `${icon} ${location.building || location.id}: ` +
        `${available}/${total} פנויות`
      );
    });

    alert.title = "🏢 EV Edge · KLA";
    alert.message = [
      `סה״כ פנויות: ${s.availableCount ?? 0}/${s.totalCount ?? 0}`,
      ...locationLines,
      `מעקב: ${s.enabled ? "ON" : "OFF"}`,
      "קצב: כל דקה",
      s.lastError ? `שגיאה: ${s.lastError}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  alert.addAction("OK");
  await alert.presentAlert();
}

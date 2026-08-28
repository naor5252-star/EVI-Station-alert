const SONOL_BASE = "https://account.sonolevi.co.il";
const MAP_PAGE = `${SONOL_BASE}/findCharger`;
const EVEDGE_BASE = "https://evedge.il-evedge.charge.ampeco.tech";

const DEFAULT_STATION_IDS = ["2733", "2790"];
const DEFAULT_EVEDGE_LOCATION_IDS = ["724", "725"];

const EMPTY_SONOL_STATE = {
  enabled: false,
  lastCheck: null,
  lastError: null,
  availableCount: 0,
  stations: [],
  sockets: [],
  availableSocketKeys: [],
  baselineHasAvailable: null,
};

const EMPTY_EVEDGE_STATE = {
  enabled: false,
  lastCheck: null,
  lastError: null,
  availableCount: 0,
  totalCount: 0,
  locations: [],
  evses: [],
  baselineHasAvailable: null,
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/health") {
        return responseJSON({
          ok: true,
          service: "EVI Station Alert",
          monitors: {
            sonol: {
              interval: "30 seconds",
              stationIds: getSonolStationIds(env),
            },
            evedge: {
              interval: "60 seconds",
              locationIds: getEVEdgeLocationIds(env),
            },
          },
        });
      }

      requireAuth(request, env);

      // Backward-compatible SONOL routes.
      if (url.pathname === "/status" && request.method === "GET") {
        return responseJSON(await loadSonolState(env));
      }
      if (url.pathname === "/monitor" && request.method === "POST") {
        return handleSonolMonitor(request, env);
      }
      if (url.pathname === "/refresh" && request.method === "POST") {
        return responseJSON(await checkSonolAndStore(env, {
          notifyChanges: false,
          preserveBaseline: true,
          forcePersist: true,
        }));
      }

      // Explicit SONOL routes.
      if (url.pathname === "/sonol/status" && request.method === "GET") {
        return responseJSON(await loadSonolState(env));
      }
      if (url.pathname === "/sonol/monitor" && request.method === "POST") {
        return handleSonolMonitor(request, env);
      }
      if (url.pathname === "/sonol/refresh" && request.method === "POST") {
        return responseJSON(await checkSonolAndStore(env, {
          notifyChanges: false,
          preserveBaseline: true,
          forcePersist: true,
        }));
      }

      // EV Edge work monitor.
      if (url.pathname === "/evedge/status" && request.method === "GET") {
        return responseJSON(await loadEVEdgeState(env));
      }
      if (url.pathname === "/evedge/monitor" && request.method === "POST") {
        return handleEVEdgeMonitor(request, env);
      }
      if (url.pathname === "/evedge/refresh" && request.method === "POST") {
        return responseJSON(await checkEVEdgeAndStore(env, {
          notifyChanges: false,
          preserveBaseline: true,
          forcePersist: true,
        }));
      }

      if (url.pathname === "/status/all" && request.method === "GET") {
        const [sonol, evedge] = await Promise.all([
          loadSonolState(env),
          loadEVEdgeState(env),
        ]);
        return responseJSON({ sonol, evedge });
      }

      if (url.pathname === "/test-notification" && request.method === "POST") {
        await sendTelegramText(
          env,
          "⚡ בדיקת EVI Station Alert\nה-Worker מחובר ל-Telegram בהצלחה.",
        );
        return responseJSON({ ok: true, notification: "sent" });
      }

      return responseJSON({ error: "Not found" }, 404);
    } catch (error) {
      return responseJSON(
        { error: String(error?.message || error) },
        error?.status || 500,
      );
    }
  },

  async scheduled(_controller, env, _ctx) {
    // Once each minute: SONOL + EV Edge.
    await runScheduledSonolCheck(env);
    await runScheduledEVEdgeCheck(env);

    // Second SONOL sample ~30 seconds later.
    await scheduler.wait(30_000);
    await runScheduledSonolCheck(env);
  },
};

async function handleSonolMonitor(request, env) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.enabled !== "boolean") {
    return responseJSON({ error: "Body must contain boolean enabled" }, 400);
  }

  const state = await loadSonolState(env);

  if (!body.enabled) {
    state.enabled = false;
    state.lastError = null;
    await saveSonolState(env, state);
    return responseJSON(state);
  }

  if (state.enabled) {
    return responseJSON(state);
  }

  state.enabled = true;
  state.lastError = null;
  await saveSonolState(env, state);

  const current = await checkSonolAndStore(env, {
    notifyChanges: false,
    preserveBaseline: false,
    forcePersist: true,
    previousState: state,
  });

  try {
    await sendSonolAvailabilityNotification(env, current, true);
  } catch (error) {
    current.lastError =
      `Notification failed: ${String(error?.message || error)}`;
    await saveSonolState(env, current);
  }

  return responseJSON(current);
}

async function handleEVEdgeMonitor(request, env) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.enabled !== "boolean") {
    return responseJSON({ error: "Body must contain boolean enabled" }, 400);
  }

  const state = await loadEVEdgeState(env);

  if (!body.enabled) {
    state.enabled = false;
    state.lastError = null;
    await saveEVEdgeState(env, state);
    return responseJSON(state);
  }

  if (state.enabled) {
    return responseJSON(state);
  }

  assertEVEdgeConfigured(env);

  state.enabled = true;
  state.lastError = null;
  await saveEVEdgeState(env, state);

  const current = await checkEVEdgeAndStore(env, {
    notifyChanges: false,
    preserveBaseline: false,
    forcePersist: true,
    previousState: state,
  });

  try {
    await sendEVEdgeAvailabilityNotification(env, current, true);
  } catch (error) {
    current.lastError =
      `Notification failed: ${String(error?.message || error)}`;
    await saveEVEdgeState(env, current);
  }

  return responseJSON(current);
}

async function runScheduledSonolCheck(env) {
  const state = await loadSonolState(env);
  if (!state.enabled) return;

  try {
    await checkSonolAndStore(env, {
      notifyChanges: true,
      preserveBaseline: false,
      forcePersist: false,
      previousState: state,
    });
  } catch (error) {
    const errorText = String(error?.message || error);
    if (state.lastError !== errorText) {
      state.lastError = errorText;
      state.lastCheck = new Date().toISOString();
      await saveSonolState(env, state);
    }
  }
}

async function runScheduledEVEdgeCheck(env) {
  const state = await loadEVEdgeState(env);
  if (!state.enabled) return;

  try {
    await checkEVEdgeAndStore(env, {
      notifyChanges: true,
      preserveBaseline: false,
      forcePersist: false,
      previousState: state,
    });
  } catch (error) {
    const errorText = String(error?.message || error);
    if (state.lastError !== errorText) {
      state.lastError = errorText;
      state.lastCheck = new Date().toISOString();
      await saveEVEdgeState(env, state);
    }
  }
}

function getSonolStationIds(env) {
  if (env.GAMLA_STATION_IDS) {
    const ids = String(env.GAMLA_STATION_IDS)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  return DEFAULT_STATION_IDS;
}

function getEVEdgeLocationIds(env) {
  if (env.EVEDGE_LOCATION_IDS) {
    const ids = String(env.EVEDGE_LOCATION_IDS)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  return DEFAULT_EVEDGE_LOCATION_IDS;
}

function requireAuth(request, env) {
  const token = env.CONTROL_TOKEN || "";
  const actual = request.headers.get("Authorization") || "";

  if (!token || actual !== `Bearer ${token}`) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
}

async function loadSonolState(env) {
  // Keep the old key so existing SONOL state survives this upgrade.
  const saved = await env.STATE.get("monitor", "json");
  return { ...EMPTY_SONOL_STATE, ...(saved || {}) };
}

async function saveSonolState(env, state) {
  await env.STATE.put("monitor", JSON.stringify(state));
}

async function loadEVEdgeState(env) {
  const saved = await env.STATE.get("evedge-monitor", "json");
  return { ...EMPTY_EVEDGE_STATE, ...(saved || {}) };
}

async function saveEVEdgeState(env, state) {
  await env.STATE.put("evedge-monitor", JSON.stringify(state));
}

async function checkSonolAndStore(
  env,
  {
    notifyChanges,
    preserveBaseline = false,
    forcePersist = false,
    previousState = null,
  },
) {
  const previous = previousState || await loadSonolState(env);
  const live = await fetchGamlaStatus(env);

  const currentHasAvailable = live.availableCount > 0;
  const previousHasAvailable =
    typeof previous.baselineHasAvailable === "boolean"
      ? previous.baselineHasAvailable
      : ((previous.availableCount || 0) > 0);

  const next = {
    ...previous,
    lastCheck: new Date().toISOString(),
    lastError: null,
    availableCount: live.availableCount,
    stations: live.stations,
    sockets: live.sockets,
    availableSocketKeys: live.availableSocketKeys,
    baselineHasAvailable: preserveBaseline
      ? previousHasAvailable
      : currentHasAvailable,
  };

  const availabilityFlipped =
    previousHasAvailable !== currentHasAvailable;

  if (notifyChanges && previous.enabled && availabilityFlipped) {
    try {
      await sendSonolAvailabilityNotification(env, next, false);
    } catch (error) {
      const errorText =
        `Notification failed: ${String(error?.message || error)}`;

      if (previous.lastError !== errorText) {
        const failed = {
          ...previous,
          lastCheck: next.lastCheck,
          lastError: errorText,
          availableCount: live.availableCount,
          stations: live.stations,
          sockets: live.sockets,
          availableSocketKeys: live.availableSocketKeys,
          baselineHasAvailable: previousHasAvailable,
        };
        await saveSonolState(env, failed);
      }

      return {
        ...next,
        lastError: errorText,
        baselineHasAvailable: previousHasAvailable,
      };
    }
  }

  const recoveredFromError = Boolean(previous.lastError);
  const shouldPersist =
    forcePersist ||
    availabilityFlipped ||
    recoveredFromError;

  if (shouldPersist) {
    await saveSonolState(env, next);
  }

  return next;
}

async function checkEVEdgeAndStore(
  env,
  {
    notifyChanges,
    preserveBaseline = false,
    forcePersist = false,
    previousState = null,
  },
) {
  const previous = previousState || await loadEVEdgeState(env);
  const live = await fetchEVEdgeStatus(env);

  const currentHasAvailable = live.availableCount > 0;
  const previousHasAvailable =
    typeof previous.baselineHasAvailable === "boolean"
      ? previous.baselineHasAvailable
      : ((previous.availableCount || 0) > 0);

  const next = {
    ...previous,
    lastCheck: new Date().toISOString(),
    lastError: null,
    availableCount: live.availableCount,
    totalCount: live.totalCount,
    locations: live.locations,
    evses: live.evses,
    baselineHasAvailable: preserveBaseline
      ? previousHasAvailable
      : currentHasAvailable,
  };

  const availabilityFlipped =
    previousHasAvailable !== currentHasAvailable;
  const countChanged =
    Number(previous.availableCount || 0) !== Number(live.availableCount || 0) ||
    Number(previous.totalCount || 0) !== Number(live.totalCount || 0);

  if (notifyChanges && previous.enabled && availabilityFlipped) {
    try {
      await sendEVEdgeAvailabilityNotification(env, next, false);
    } catch (error) {
      const errorText =
        `Notification failed: ${String(error?.message || error)}`;

      if (previous.lastError !== errorText) {
        const failed = {
          ...previous,
          lastCheck: next.lastCheck,
          lastError: errorText,
          availableCount: live.availableCount,
          totalCount: live.totalCount,
          locations: live.locations,
          evses: live.evses,
          baselineHasAvailable: previousHasAvailable,
        };
        await saveEVEdgeState(env, failed);
      }

      return {
        ...next,
        lastError: errorText,
        baselineHasAvailable: previousHasAvailable,
      };
    }
  }

  const recoveredFromError = Boolean(previous.lastError);
  const shouldPersist =
    forcePersist ||
    availabilityFlipped ||
    countChanged ||
    recoveredFromError;

  if (shouldPersist) {
    await saveEVEdgeState(env, next);
  }

  return next;
}

async function fetchGamlaStatus(env) {
  const session = await openPublicSession();
  const stationIds = getSonolStationIds(env);

  const stations = [];
  const sockets = [];

  for (const stationId of stationIds) {
    const result = await fetchStationById(session, stationId);
    stations.push(result.station);
    sockets.push(...result.sockets);
  }

  const availableSocketKeys = sockets
    .filter((socket) => socket.available)
    .map((socket) => `${socket.stationId}:${socket.id}`);

  return {
    stations,
    sockets,
    availableCount: sockets.filter((socket) => socket.available).length,
    availableSocketKeys,
  };
}

async function fetchEVEdgeStatus(env) {
  assertEVEdgeConfigured(env);

  const locationIds = getEVEdgeLocationIds(env);
  const locationsBody = {};
  for (const id of locationIds) {
    locationsBody[id] = "";
  }

  const response = await fetch(
    `${EVEDGE_BASE}/api/v1/app/locations?operatorCountry=IL`,
    {
      method: "POST",
      headers: {
        "x-operator-country": "IL",
        "Accept": "application/json, text/plain, */*",
        "Authorization": `Bearer ${env.EVEDGE_TOKEN}`,
        "x-mobile-app-bundle-id": "il.evedge.evedge",
        "Accept-Language": "he",
        "User-Agent":
          "ChargeMobile/1787248731 CFNetwork/3860.700.1 Darwin/25.6.0",
        "x-device-id": String(env.EVEDGE_DEVICE_ID),
        "x-platform": "ios",
        "x-internal-app-version": "3.234.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ locations: locationsBody }),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `EV Edge HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `EV Edge did not return JSON: ${text.slice(0, 300)}`,
    );
  }

  const rawLocations = Array.isArray(parsed?.locations)
    ? parsed.locations
    : [];

  if (rawLocations.length === 0) {
    throw new Error(
      "EV Edge returned no locations. Refresh EVEDGE_TOKEN / EVEDGE_DEVICE_ID.",
    );
  }

  const locations = [];
  const evses = [];

  for (const rawLocation of rawLocations) {
    const locationId = String(rawLocation?.id ?? "");
    const name = String(rawLocation?.name || `Location ${locationId}`);
    const building = locationId === "724"
      ? "בניין 3"
      : (locationId === "725" ? "בניין 7" : name);

    const locationEVSEs = [];

    for (const zone of (rawLocation?.zones || [])) {
      for (const evse of (zone?.evses || [])) {
        const normalized = normalizeEVEdgeEVSE(evse, locationId, building);
        locationEVSEs.push(normalized);
        evses.push(normalized);
      }
    }

    locations.push({
      id: locationId,
      name,
      building,
      address: String(rawLocation?.address || ""),
      availableCount: locationEVSEs.filter((evse) => evse.available).length,
      totalCount: locationEVSEs.length,
    });
  }

  return {
    locations,
    evses,
    availableCount: evses.filter((evse) => evse.available).length,
    totalCount: evses.length,
  };
}

function normalizeEVEdgeEVSE(evse, locationId, building) {
  const available = evse?.isAvailable === true;
  const temporary = evse?.isTemporarilyUnavailable === true;
  const longTerm = evse?.isLongTermUnavailable === true;
  const rawStatus = String(evse?.status || "unknown").toUpperCase();

  let status;
  if (available) {
    status = "AVAILABLE";
  } else if (longTerm) {
    status = "LONG_TERM_UNAVAILABLE";
  } else if (temporary) {
    status = "TEMP_UNAVAILABLE";
  } else if (rawStatus && rawStatus !== "AVAILABLE") {
    status = rawStatus;
  } else {
    status = "NOT_AVAILABLE";
  }

  return {
    id: String(evse?.id ?? ""),
    identifier: String(evse?.identifier || ""),
    locationId,
    building,
    networkId: String(evse?.networkId ?? ""),
    status,
    rawStatus,
    available,
    isTemporarilyUnavailable: temporary,
    isLongTermUnavailable: longTerm,
    maxPower: Number(evse?.maxPower || 0),
    connector: String(evse?.connectors?.[0]?.name || ""),
  };
}

function assertEVEdgeConfigured(env) {
  if (!env.EVEDGE_TOKEN || !env.EVEDGE_DEVICE_ID) {
    const error = new Error(
      "EV Edge is not configured. Set EVEDGE_TOKEN and EVEDGE_DEVICE_ID in Cloudflare.",
    );
    error.status = 503;
    throw error;
  }
}

async function fetchStationById(session, stationId) {
  const result = await sonolAPI(
    session,
    "GET",
    "/stationFacade/findStationById",
    { stationId },
  );

  const rawStation = result?.data;
  if (!rawStation || typeof rawStation !== "object") {
    throw new Error(`findStationById returned no data for station ${stationId}`);
  }

  const station = {
    id: String(stationId),
    name: stationLabel(rawStation),
    address: stationAddress(rawStation),
    availableCount: 0,
    socketCount: 0,
  };

  const rawSockets = Array.isArray(rawStation.stationSockets)
    ? rawStation.stationSockets
    : (Array.isArray(rawStation.sockets) ? rawStation.sockets : []);

  const sockets = rawSockets.map((socket, index) => {
    const status = effectiveStatus(socket);

    return {
      id: String(socket?.id ?? socket?.stationSocketId ?? index + 1),
      stationId: String(stationId),
      stationName: station.name,
      name: String(
        socket?.socketCaption ??
        socket?.caption ??
        socket?.connectorName ??
        socket?.socketName ??
        socket?.connectorType ??
        socket?.socketTypeName ??
        `Connector ${index + 1}`
      ),
      status,
      available: status === "AVAILABLE",
      reserved: socket?.reserved === true,
      blocked: socket?.blocked === true,
      inMaintenance: socket?.inMaintenance === true,
    };
  });

  station.socketCount = sockets.length;
  station.availableCount = sockets.filter((socket) => socket.available).length;

  return { station, sockets };
}

async function openPublicSession() {
  const response = await fetch(MAP_PAGE, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`findCharger HTTP ${response.status}`);
  }

  const page = await response.text();

  const csrf =
    firstMatch(
      page,
      /<meta\s+name=["']_csrf["']\s+content=["']([^"']+)["']/i,
    ) ||
    firstMatch(
      page,
      /name=["']_csrf["'][^>]*content=["']([^"']+)["']/i,
    );

  const csrfHeader =
    firstMatch(
      page,
      /<meta\s+name=["']_csrf_header["']\s+content=["']([^"']+)["']/i,
    ) || "X-CSRF-TOKEN";

  const setCookie = response.headers.get("set-cookie") || "";
  const sessionCookie = firstMatch(setCookie, /(JSESSIONID=[^;]+)/i);

  if (!csrf) throw new Error("Could not extract CSRF token");
  if (!sessionCookie) throw new Error("Could not extract JSESSIONID");

  return { csrf, csrfHeader, cookie: sessionCookie };
}

async function sonolAPI(session, method, path, data) {
  let url = `${SONOL_BASE}${path}`;

  const headers = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-JSON-TYPES": "None",
    "X-APP-TYPE": "WEB",
    "X-Requested-With": "XMLHttpRequest",
    "Accept-Language": "he-IL",
    "Referer": MAP_PAGE,
    "Origin": SONOL_BASE,
    "Cookie": session.cookie,
    [session.csrfHeader]: session.csrf,
  };

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  if (query) url += `?${query}`;

  const response = await fetch(url, {
    method,
    headers,
    redirect: "follow",
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `${path} HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${path} did not return JSON: ${text.slice(0, 300)}`,
    );
  }

  if (parsed?.success === false) {
    throw new Error(
      `${path} returned success=false: ${JSON.stringify(parsed).slice(0, 500)}`,
    );
  }

  return parsed;
}

function effectiveStatus(socket) {
  if (socket?.blocked === true) return "UNAVAILABLE";
  if (socket?.inMaintenance === true) return "IN_MAINTENANCE";
  if (socket?.reserved === true) return "RESERVED";

  return String(
    socket?.socketStatusId ??
    socket?.socketStatus ??
    socket?.status ??
    "UNKNOWN"
  ).toUpperCase();
}

function stationLabel(station) {
  return String(
    station?.stationCaption ??
    station?.caption ??
    station?.name ??
    station?.displayName ??
    station?.siteDisplayName ??
    station?.stationName ??
    `Station ${station?.id ?? station?.stationId ?? "?"}`
  );
}

function stationAddress(station) {
  return [
    station?.stationAddressStreet,
    station?.stationAddressHouseNumber,
    station?.stationAddressCity,
  ]
    .filter(
      (value) => value != null && String(value).trim() !== "",
    )
    .join(" ");
}

async function sendSonolAvailabilityNotification(
  env,
  state,
  monitoringStarted,
) {
  const available = (state.sockets || []).filter(
    (socket) => socket.available
  );

  let message;

  if (available.length > 0) {
    const lines = available.map(
      (socket) =>
        `🟢 תחנה ${socket.stationId} — ${socket.name}: פנוי`
    );

    message = [
      monitoringStarted ? "✅ מעקב הבית הופעל" : "🟢 יש עמדה פנויה בגמלא 3",
      monitoringStarted ? "🟢 יש עמדה פנויה בגמלא 3" : null,
      ...lines,
      `סה״כ פנויים: ${available.length}`,
    ]
      .filter(Boolean)
      .join("\n");
  } else {
    message = [
      monitoringStarted ? "✅ מעקב הבית הופעל" : "🔴 אין עמדות פנויות בגמלא 3",
      monitoringStarted ? "🔴 אין עמדות פנויות בגמלא 3" : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  await sendTelegramText(env, message);
}

async function sendEVEdgeAvailabilityNotification(
  env,
  state,
  monitoringStarted,
) {
  const locations = state.locations || [];

  const availableLocations = locations.filter(
    (location) => Number(location.availableCount || 0) > 0
  );

  const availableBuildingNames = availableLocations.map(
    (location) => String(location.building || location.id)
  );

  let headline;
  if (availableBuildingNames.length === 1) {
    headline = `🟢 יש עמדה פנויה: ${availableBuildingNames[0]}`;
  } else if (availableBuildingNames.length > 1) {
    headline =
      `🟢 יש עמדות פנויות: ${availableBuildingNames.join(" + ")}`;
  } else {
    headline = "🔴 אין עמדות פנויות ב-KLA";
  }

  const lines = locations.map((location) => {
    const available = Number(location.availableCount || 0);
    const total = Number(location.totalCount || 0);
    const icon = total === 0 ? "⚪" : (available > 0 ? "🟢" : "🔴");

    return (
      `${icon} ${location.building || location.id}: ` +
      `${available}/${total} פנויות`
    );
  });

  const message = [
    monitoringStarted ? "✅ מעקב העבודה הופעל" : null,
    headline,
    ...lines,
    `סה״כ: ${state.availableCount ?? 0}/${state.totalCount ?? 0} פנויות`,
  ]
    .filter(Boolean)
    .join("\n");

  await sendTelegramText(env, message);
}

async function sendTelegramText(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Telegram secrets are not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    },
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}: ${body.slice(0, 250)}`
    );
  }
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : null;
}

function responseJSON(body, status = 200) {
  return new Response(
    JSON.stringify(body, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

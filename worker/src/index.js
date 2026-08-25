const SONOL_BASE = "https://account.sonolevi.co.il";
const MAP_PAGE = `${SONOL_BASE}/findCharger`;

// Known SONOL EVI stations at Center Park / Gamla 3, Hadera.
// Optional override in Cloudflare:
// GAMLA_STATION_IDS=2733,2790
const DEFAULT_STATION_IDS = ["2733", "2790"];

const EMPTY_STATE = {
  enabled: false,
  lastCheck: null,
  lastError: null,
  availableCount: 0,
  stations: [],
  sockets: [],
  availableSocketKeys: [],
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/health") {
        return responseJSON({
          ok: true,
          service: "EVI Station Alert",
          monitorInterval: "5 minutes",
          stationIds: getStationIds(env),
        });
      }

      requireAuth(request, env);

      if (url.pathname === "/status" && request.method === "GET") {
        return responseJSON(await loadState(env));
      }

      if (url.pathname === "/monitor" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (typeof body.enabled !== "boolean") {
          return responseJSON({ error: "Body must contain boolean enabled" }, 400);
        }

        const state = await loadState(env);
        const wasEnabled = state.enabled;
        state.enabled = body.enabled;
        state.lastError = null;

        if (body.enabled && !wasEnabled) {
          state.availableSocketKeys = [];
        }

        await saveState(env, state);

        if (body.enabled) {
          return responseJSON(await checkAndStore(env, { notify: true }));
        }

        return responseJSON(await loadState(env));
      }

      if (url.pathname === "/refresh" && request.method === "POST") {
        return responseJSON(await checkAndStore(env, { notify: false }));
      }

      return responseJSON({ error: "Not found" }, 404);
    } catch (error) {
      return responseJSON(
        { error: String(error?.message || error) },
        error?.status || 500,
      );
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const state = await loadState(env);
      if (!state.enabled) return;

      try {
        await checkAndStore(env, { notify: true });
      } catch (error) {
        state.lastCheck = new Date().toISOString();
        state.lastError = String(error?.message || error);
        await saveState(env, state);
      }
    })());
  },
};

function getStationIds(env) {
  if (env.GAMLA_STATION_IDS) {
    const ids = String(env.GAMLA_STATION_IDS)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length) return [...new Set(ids)];
  }

  return DEFAULT_STATION_IDS;
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

async function loadState(env) {
  const saved = await env.STATE.get("monitor", "json");
  return { ...EMPTY_STATE, ...(saved || {}) };
}

async function saveState(env, state) {
  await env.STATE.put("monitor", JSON.stringify(state));
}

async function checkAndStore(env, { notify }) {
  const previous = await loadState(env);
  const live = await fetchGamlaStatus(env);

  const next = {
    ...previous,
    lastCheck: new Date().toISOString(),
    lastError: null,
    availableCount: live.availableCount,
    stations: live.stations,
    sockets: live.sockets,
    availableSocketKeys: live.availableSocketKeys,
  };

  const previousSet = new Set(previous.availableSocketKeys || []);
  const newlyAvailableKeys = live.availableSocketKeys.filter(
    (key) => !previousSet.has(key),
  );

  await saveState(env, next);

  if (notify && next.enabled && newlyAvailableKeys.length > 0) {
    await sendNotification(env, live, newlyAvailableKeys);
  }

  return next;
}

async function fetchGamlaStatus(env) {
  const session = await openPublicSession();
  const stationIds = getStationIds(env);

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
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

async function sendNotification(env, live, newlyAvailableKeys) {
  if (!env.NTFY_TOPIC) return;

  const newlyAvailableSet = new Set(newlyAvailableKeys);
  const newlyAvailable = live.sockets.filter((socket) =>
    newlyAvailableSet.has(`${socket.stationId}:${socket.id}`)
  );

  const connectorText = newlyAvailable
    .map(
      (socket) =>
        `תחנה ${socket.stationId} — ${socket.name}`,
    )
    .join(" | ");

  const message =
    newlyAvailable.length === 1
      ? `${connectorText} פנוי עכשיו`
      : `${newlyAvailable.length} מחברים התפנו: ${connectorText}`;

  const response = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      topic: env.NTFY_TOPIC,
      title: "⚡ עמדה פנויה בגמלא 3",
      message,
      priority: 4,
      tags: ["zap", "electric_plug"],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Notification service HTTP ${response.status}`,
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

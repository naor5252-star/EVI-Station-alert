const SONOL_BASE = "https://account.sonolevi.co.il";
const MAP_PAGE = `${SONOL_BASE}/findCharger`;

const HADERA_BOUNDS = {
  northEastLat: 32.50,
  northEastLng: 35.01,
  southWestLat: 32.37,
  southWestLng: 34.84,
};

const MATCH_TOKENS = [
  ["גמלא 3", 30],
  ["gamla 3", 30],
  ["סנטר פארק", 20],
  ["center park", 20],
  ["גמלא", 10],
  ["gamla", 10],
  ["חדרה", 6],
  ["hadera", 6],
];

const EMPTY_STATE = {
  enabled: false,
  lastCheck: null,
  lastError: null,
  availableCount: 0,
  station: null,
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
        state.enabled = body.enabled;
        state.lastError = null;
        await saveState(env, state);

        if (body.enabled) {
          const updated = await checkAndStore(env, { notify: true });
          return responseJSON(updated);
        }

        return responseJSON(await loadState(env));
      }

      if (url.pathname === "/refresh" && request.method === "POST") {
        return responseJSON(await checkAndStore(env, { notify: false }));
      }

      return responseJSON({ error: "Not found" }, 404);
    } catch (error) {
      return responseJSON({ error: String(error?.message || error) }, error?.status || 500);
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
    station: live.station,
    sockets: live.sockets,
    availableSocketKeys: live.availableSocketKeys,
  };

  const previousSet = new Set(previous.availableSocketKeys || []);
  const newlyAvailable = live.availableSocketKeys.filter((key) => !previousSet.has(key));

  await saveState(env, next);

  if (notify && next.enabled && live.availableCount > 0 && newlyAvailable.length > 0) {
    await sendNotification(env, live);
  }

  return next;
}

async function fetchGamlaStatus(env) {
  const session = await openPublicSession();

  // After the first successful live run, set GAMLA_STATION_ID as a Worker secret/variable
  // to skip discovery and make each 5-minute check a single station-details request.
  if (env.GAMLA_STATION_ID) {
    return fetchStationById(session, String(env.GAMLA_STATION_ID));
  }

  const boundsResponse = await sonolAPI(
    session,
    "POST",
    "/stationFacade/findStationsInBounds",
    {
      filterByIsManaged: true,
      filterByBounds: HADERA_BOUNDS,
    },
    true,
  );

  const stations = Array.isArray(boundsResponse?.data) ? boundsResponse.data : [];
  if (!stations.length) {
    throw new Error("SONOL returned no stations in the Hadera search area");
  }

  const ranked = stations
    .map((station) => ({ station, score: matchScore(station) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 10) {
    const candidates = ranked.slice(0, 8).map(({ station, score }) => ({
      score,
      id: station?.id ?? station?.stationId,
      text: searchableText(station).slice(0, 220),
    }));
    throw new Error(`Could not confidently identify Gamla 3. Candidates: ${JSON.stringify(candidates)}`);
  }

  const stationId = best.station?.id ?? best.station?.stationId;
  if (stationId == null) throw new Error("Matched station has no station ID");

  return fetchStationById(session, String(stationId), best.score);
}

async function fetchStationById(session, stationId, discoveryScore = 100) {
  const result = await sonolAPI(
    session,
    "GET",
    "/stationFacade/findStationById",
    { stationId },
    false,
  );

  const station = result?.data;
  if (!station || typeof station !== "object") {
    throw new Error("findStationById returned no station data");
  }

  if (discoveryScore < 100 && Math.max(discoveryScore, matchScore(station)) < 10) {
    throw new Error("Station details did not validate the Gamla 3 match");
  }

  const rawSockets = Array.isArray(station.stationSockets)
    ? station.stationSockets
    : (Array.isArray(station.sockets) ? station.sockets : []);

  const sockets = rawSockets.map((socket, index) => {
    const status = effectiveStatus(socket);
    return {
      id: String(socket?.id ?? socket?.stationSocketId ?? index + 1),
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

  const availableSocketKeys = sockets
    .filter((socket) => socket.available)
    .map((socket) => `${stationId}:${socket.id}`);

  return {
    station: {
      id: String(stationId),
      name: stationLabel(station),
      address: stationAddress(station),
    },
    sockets,
    availableCount: sockets.filter((socket) => socket.available).length,
    availableSocketKeys,
  };
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

  if (!response.ok) throw new Error(`findCharger HTTP ${response.status}`);

  const page = await response.text();
  const csrf = firstMatch(page, /<meta\s+name=["']_csrf["']\s+content=["']([^"']+)["']/i)
    || firstMatch(page, /name=["']_csrf["'][^>]*content=["']([^"']+)["']/i);
  const csrfHeader = firstMatch(page, /<meta\s+name=["']_csrf_header["']\s+content=["']([^"']+)["']/i)
    || "X-CSRF-TOKEN";
  const setCookie = response.headers.get("set-cookie") || "";
  const sessionCookie = firstMatch(setCookie, /(JSESSIONID=[^;]+)/i);

  if (!csrf) throw new Error("Could not extract CSRF token");
  if (!sessionCookie) throw new Error("Could not extract JSESSIONID");

  return { csrf, csrfHeader, cookie: sessionCookie };
}

async function sonolAPI(session, method, path, data, jsonMode) {
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

  let body;
  if (method === "GET") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data || {})) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const query = params.toString();
    if (query) url += `?${query}`;
  } else if (jsonMode) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(data || {});
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data || {})) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    body = params.toString();
  }

  const response = await fetch(url, { method, headers, body, redirect: "follow" });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 300)}`);
  }

  if (parsed?.success === false) {
    throw new Error(`${path} returned success=false: ${JSON.stringify(parsed).slice(0, 500)}`);
  }

  return parsed;
}

function effectiveStatus(socket) {
  if (socket?.blocked === true) return "UNAVAILABLE";
  if (socket?.inMaintenance === true) return "IN_MAINTENANCE";
  if (socket?.reserved === true) return "RESERVED";
  return String(socket?.socketStatusId ?? socket?.socketStatus ?? socket?.status ?? "UNKNOWN").toUpperCase();
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
  ].filter((value) => value != null && String(value).trim() !== "").join(" ");
}

function searchableText(value) {
  const parts = [];
  walk(value, parts);
  return parts.join(" | ").toLowerCase();
}

function walk(value, parts) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, parts);
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) walk(item, parts);
  } else if (["string", "number", "boolean"].includes(typeof value)) {
    parts.push(String(value));
  }
}

function matchScore(value) {
  const text = searchableText(value);
  let score = 0;
  for (const [token, weight] of MATCH_TOKENS) {
    if (text.includes(token.toLowerCase())) score += weight;
  }
  if (value?.isManaged === true) score += 1;
  return score;
}

async function sendNotification(env, live) {
  if (!env.NTFY_TOPIC) return;

  const connectorNames = live.sockets
    .filter((socket) => socket.available)
    .map((socket) => socket.name)
    .join(", ");

  const message = live.availableCount === 1
    ? `יש מחבר אחד פנוי כרגע${connectorNames ? `: ${connectorNames}` : ""}`
    : `יש ${live.availableCount} מחברים פנויים כרגע${connectorNames ? `: ${connectorNames}` : ""}`;

  const response = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: env.NTFY_TOPIC,
      title: "⚡ עמדה פנויה בגמלא 3",
      message,
      priority: 4,
      tags: ["zap", "electric_plug"],
    }),
  });

  if (!response.ok) {
    throw new Error(`Notification service HTTP ${response.status}`);
  }
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : null;
}

function responseJSON(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

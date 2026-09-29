import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(root, "public");
const athleteIdDefault = "BraulioMurtaBaiaoAlbino";
const allowedPeriods = new Set([7, 30, 90]);
const sessionCookie = "pulso_session";
const sessionMaxAgeSeconds = 8 * 60 * 60;
const maxBodyBytes = 4 * 1024;
const maxFailedAttempts = 10;
const failedAttemptWindowMs = 10 * 60 * 1000;
const validAthleteId = /^[^/\\?#\u0000-\u001f]{1,80}$/u;
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function errorBody(code, message) {
  return { error: { code, message } };
}

function localDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

async function sendStaticFile(response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    jsonResponse(response, 400, errorBody("invalid_path", "Caminho inválido."));
    return;
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(publicDirectory, `.${requestedPath}`);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    jsonResponse(response, 404, errorBody("not_found", "Página não encontrada."));
    return;
  }

  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) {
      jsonResponse(response, 404, errorBody("not_found", "Página não encontrada."));
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Length": fileInfo.size,
      "Content-Type": mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      jsonResponse(response, 404, errorBody("not_found", "Página não encontrada."));
      return;
    }
    throw error;
  }
}

function readCookie(request, name) {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function basicAuth(apiKey) {
  return `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString("base64")}`;
}

function upstreamFailure(status) {
  if (status === 401 || status === 403) {
    return errorBody(
      "invalid_credentials",
      "O Intervals.icu recusou o usuário ou a chave informados. Confira os dados e as permissões.",
    );
  }
  if (status === 429) {
    return errorBody(
      "rate_limited",
      "O limite de consultas do Intervals.icu foi atingido. Tente novamente mais tarde.",
    );
  }
  return errorBody(
    "upstream_error",
    "O Intervals.icu não conseguiu responder agora. Tente novamente em instantes.",
  );
}

const upstreamUnavailable = () =>
  errorBody(
    "upstream_unavailable",
    "Não foi possível conectar ao Intervals.icu. Verifique sua conexão e tente novamente.",
  );

export function createServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const sessions = new Map();
  const failures = new Map();

  function currentCredentials(request) {
    const token = readCookie(request, sessionCookie);
    const session = token ? sessions.get(token) : null;
    if (session && session.expiresAt > Date.now()) {
      return { athleteId: session.athleteId, apiKey: session.apiKey, token };
    }
    if (token) sessions.delete(token);

    const apiKey = env.INTERVALS_API_KEY?.trim();
    if (!apiKey) return null;
    return { athleteId: env.INTERVALS_ATHLETE_ID?.trim() || athleteIdDefault, apiKey, token: null };
  }

  function tooManyFailures(address) {
    const entry = failures.get(address);
    return Boolean(entry && entry.resetAt > Date.now() && entry.count >= maxFailedAttempts);
  }

  function registerFailure(address) {
    const entry = failures.get(address);
    if (!entry || entry.resetAt <= Date.now()) {
      failures.set(address, { count: 1, resetAt: Date.now() + failedAttemptWindowMs });
    } else {
      entry.count += 1;
    }
  }

  function sameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }

  function clearedCookie() {
    return `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  async function handleConnect(request, response) {
    if (!sameOrigin(request)) {
      jsonResponse(response, 403, errorBody("forbidden_origin", "Origem não permitida."));
      return;
    }
    const address = request.socket.remoteAddress ?? "unknown";
    if (tooManyFailures(address)) {
      jsonResponse(
        response,
        429,
        errorBody("too_many_attempts", "Muitas tentativas. Aguarde alguns minutos e tente novamente."),
      );
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      jsonResponse(response, 400, errorBody("invalid_request", "Não foi possível ler os dados enviados."));
      return;
    }

    const athleteId = typeof body?.athleteId === "string" ? body.athleteId.trim() : "";
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!athleteId || !apiKey) {
      jsonResponse(
        response,
        400,
        errorBody("missing_fields", "Informe o usuário (ID do atleta) e a senha (chave da API)."),
      );
      return;
    }
    if (!validAthleteId.test(athleteId) || apiKey.length > 200) {
      jsonResponse(response, 400, errorBody("invalid_fields", "Usuário ou senha em formato inválido."));
      return;
    }

    let upstream;
    try {
      upstream = await fetchImpl(
        new URL(`/api/v1/athlete/${encodeURIComponent(athleteId)}`, "https://intervals.icu"),
        {
          headers: { Accept: "application/json", Authorization: basicAuth(apiKey) },
          signal: AbortSignal.timeout(12_000),
        },
      );
    } catch {
      jsonResponse(response, 502, upstreamUnavailable());
      return;
    }

    if (!upstream.ok) {
      if (upstream.status === 401 || upstream.status === 403) registerFailure(address);
      jsonResponse(response, upstream.status === 401 || upstream.status === 403 ? 401 : 502, upstreamFailure(upstream.status));
      return;
    }

    const previous = readCookie(request, sessionCookie);
    if (previous) sessions.delete(previous);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { athleteId, apiKey, expiresAt: Date.now() + sessionMaxAgeSeconds * 1000 });
    failures.delete(address);

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAgeSeconds}`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({ connected: true, athlete: athleteId }));
  }

  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "POST" && url.pathname === "/api/connect") {
      await handleConnect(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/disconnect") {
      if (!sameOrigin(request)) {
        jsonResponse(response, 403, errorBody("forbidden_origin", "Origem não permitida."));
        return;
      }
      const token = readCookie(request, sessionCookie);
      if (token) sessions.delete(token);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": clearedCookie(),
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify({ connected: false }));
      return;
    }

    if (request.method !== "GET") {
      jsonResponse(response, 405, errorBody("method_not_allowed", "Método não permitido."));
      return;
    }

    if (url.pathname === "/api/session") {
      const credentials = currentCredentials(request);
      jsonResponse(response, 200, {
        connected: Boolean(credentials),
        athlete: credentials?.athleteId ?? null,
      });
      return;
    }

    if (url.pathname === "/api/dashboard") {
      const period = Number(url.searchParams.get("days") ?? "7");
      if (!allowedPeriods.has(period)) {
        jsonResponse(response, 400, errorBody("invalid_period", "Selecione um período válido."));
        return;
      }

      const credentials = currentCredentials(request);
      if (!credentials) {
        jsonResponse(
          response,
          401,
          errorBody("not_connected", "Informe seu usuário e sua senha da API do Intervals.icu para conectar."),
        );
        return;
      }

      const { athleteId, apiKey } = credentials;
      const newest = now();
      const oldest = new Date(newest);
      oldest.setDate(oldest.getDate() - (period - 1));
      const endpoint = new URL(
        `/api/v1/athlete/${encodeURIComponent(athleteId)}/activities`,
        "https://intervals.icu",
      );
      endpoint.searchParams.set("oldest", localDate(oldest));
      endpoint.searchParams.set("newest", localDate(newest));
      endpoint.searchParams.set("limit", "100");
      endpoint.searchParams.set(
        "fields",
        "id,start_date_local,start_date,type,name,distance,moving_time,elapsed_time,total_elevation_gain",
      );

      let upstream;
      try {
        upstream = await fetchImpl(endpoint, {
          headers: { Accept: "application/json", Authorization: basicAuth(apiKey) },
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        jsonResponse(response, 502, upstreamUnavailable());
        return;
      }

      if (!upstream.ok) {
        if ((upstream.status === 401 || upstream.status === 403) && credentials.token) {
          sessions.delete(credentials.token);
        }
        jsonResponse(response, 502, upstreamFailure(upstream.status));
        return;
      }

      let activities;
      try {
        activities = await upstream.json();
      } catch {
        jsonResponse(
          response,
          502,
          errorBody("invalid_response", "A resposta do Intervals.icu não pôde ser interpretada."),
        );
        return;
      }
      if (!Array.isArray(activities)) {
        jsonResponse(
          response,
          502,
          errorBody("invalid_response", "A resposta do Intervals.icu veio em um formato inesperado."),
        );
        return;
      }

      jsonResponse(response, 200, { athlete: athleteId, period, activities });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      jsonResponse(response, 404, errorBody("not_found", "Rota de API não encontrada."));
      return;
    }

    try {
      await sendStaticFile(response, url.pathname);
    } catch {
      jsonResponse(response, 500, errorBody("server_error", "Não foi possível carregar a página."));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Painel disponível em http://${host}:${port}`);
  });
}

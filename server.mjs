import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { env } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(root, "public");
const athleteIdDefault = "BraulioMurtaBaiaoAlbino";
const allowedPeriods = new Set([7, 30, 90]);
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

export function createServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method !== "GET") {
      jsonResponse(response, 405, errorBody("method_not_allowed", "Método não permitido."));
      return;
    }

    if (url.pathname === "/api/dashboard") {
      const period = Number(url.searchParams.get("days") ?? "7");
      if (!allowedPeriods.has(period)) {
        jsonResponse(response, 400, errorBody("invalid_period", "Selecione um período válido."));
        return;
      }

      const apiKey = env.INTERVALS_API_KEY?.trim();
      if (!apiKey) {
        jsonResponse(
          response,
          503,
          errorBody(
            "missing_configuration",
            "A chave da API ainda não foi configurada. Siga as instruções no README.",
          ),
        );
        return;
      }

      const athleteId = env.INTERVALS_ATHLETE_ID?.trim() || athleteIdDefault;
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
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString("base64")}`,
          },
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        jsonResponse(
          response,
          502,
          errorBody(
            "upstream_unavailable",
            "Não foi possível conectar ao Intervals.icu. Verifique sua conexão e tente novamente.",
          ),
        );
        return;
      }

      if (!upstream.ok) {
        if (upstream.status === 401 || upstream.status === 403) {
          jsonResponse(
            response,
            502,
            errorBody(
              "invalid_credentials",
              "O Intervals.icu recusou a chave configurada. Confira a chave e as permissões.",
            ),
          );
          return;
        }
        if (upstream.status === 429) {
          jsonResponse(
            response,
            502,
            errorBody(
              "rate_limited",
              "O limite de consultas do Intervals.icu foi atingido. Tente novamente mais tarde.",
            ),
          );
          return;
        }
        jsonResponse(
          response,
          502,
          errorBody(
            "upstream_error",
            "O Intervals.icu não conseguiu responder agora. Tente novamente em instantes.",
          ),
        );
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

      jsonResponse(response, 200, {
        athlete: athleteId,
        period,
        activities,
      });
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

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.mjs";
import { connectRealtime, profiles } from "./realtime.mjs";

const publicRoot = resolve(import.meta.dirname, "../public");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wav": "audio/wav",
};
function sameOrigin(req) {
  return (
    !req.headers.origin || req.headers.origin === `http://${req.headers.host}`
  );
}
function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100000) throw new Error("输入太长，请缩短后重试。");
  }
  return JSON.parse(body);
}

export function makeServer(config = loadConfig()) {
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/") && !sameOrigin(req))
      return json(res, 403, { error: "请求来源不匹配。" });
    if (url.pathname === "/api/status" && req.method === "GET")
      return json(res, 200, {
        voiceConfigured: Boolean(config.dashscopeKey),
        textConfigured: Boolean(config.deepseekKey),
        model: config.model,
      });
    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!config.deepseekKey)
        return json(res, 503, {
          error: "文字模型未配置，请在 .env 填写 DEEPSEEK_API_KEY。",
        });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      res.on("close", () => controller.abort());
      try {
        const body = await readBody(req);
        if (
          !Array.isArray(body.messages) ||
          !body.messages.length ||
          body.messages.length > 60 ||
          body.messages.some(
            (m) =>
              !["user", "assistant"].includes(m.role) ||
              typeof m.content !== "string" ||
              m.content.length > 6000,
          )
        )
          return json(res, 400, { error: "对话内容无效或过长，请新建对话。" });
        const upstream = await fetch(
          `${config.deepseekBase.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${config.deepseekKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: config.deepseekModel,
              messages: [
                {
                  role: "system",
                  content: profiles[body.profile] || profiles.friend,
                },
                ...body.messages,
              ],
              stream: true,
              max_tokens: 400,
            }),
          },
        );
        if (!upstream.ok)
          throw new Error(
            upstream.status === 401
              ? "文字模型密钥无效，请检查配置。"
              : "文字模型暂时不可用，请稍后重试。",
          );
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        res.end();
      } catch (error) {
        const message =
          error.name === "AbortError"
            ? "回复已停止或请求超时。"
            : error.message.startsWith("文字模型")
              ? error.message
              : "请求失败，请检查网络后重试。";
        if (!res.headersSent) json(res, 502, { error: message });
        else {
          if (!res.destroyed)
            res.write(
              `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`,
            );
          res.end();
        }
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
    if (!["GET", "HEAD"].includes(req.method))
      return json(res, 405, { error: "Method not allowed" });
    try {
      const pathname = decodeURIComponent(url.pathname);
      const path = resolve(
        publicRoot,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
      if (!path.startsWith(`${publicRoot}/`) || !types[extname(path)])
        return json(res, 404, { error: "Not found" });
      const data = await readFile(path);
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      res.writeHead(200, {
        "Content-Type": types[extname(path)],
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      json(res, 404, { error: "Not found" });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 100000 });
  server.on("upgrade", (req, socket, head) => {
    if (
      !sameOrigin(req) ||
      !["localhost", "127.0.0.1"].includes(
        (req.headers.host || "").split(":")[0],
      ) ||
      !req.url.startsWith("/realtime?")
    )
      return socket.destroy();
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (wss.clients.size >= 4) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) =>
      connectRealtime(client, config, {
        voice: url.searchParams.get("voice"),
        profile: url.searchParams.get("profile"),
        pause: url.searchParams.get("pause"),
      }),
    );
  });
  server.on("close", () => {
    for (const client of wss.clients) client.close();
    wss.close();
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const config = loadConfig();
  const server = makeServer(config);
  server.listen(config.port, "127.0.0.1", () =>
    console.log(
      `小伴已启动 http://localhost:${config.port} · 千问实时语音 / DeepSeek 文字对话`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}

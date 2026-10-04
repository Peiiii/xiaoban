import config from "./gateway-config.js";
import { profiles } from "./profiles.js";
export const gatewayEnabled = Boolean(config?.projectId);
function token() {
  const sdk = window.gemigo;
  return sdk?.auth.getAccessToken();
}
export async function login() {
  if (!gatewayEnabled) return;
  await window.gemigo.auth.login({
    appId: config.appId,
    platformOrigin: config.platformOrigin || "https://gemigo.io",
    apiBaseUrl: config.apiBase,
    persist: "local",
    display: "redirect",
  });
}
export async function resumeLogin() {
  if (!gatewayEnabled) return null;
  return window.gemigo.auth.handleRedirectCallback();
}
export function loggedIn() {
  return Boolean(token());
}
export function logout() {
  window.gemigo?.auth.logout();
}
async function ticket(connection, signal) {
  const accessToken = token();
  if (config.requireLogin && !accessToken)
    throw new Error("请先点击「登录 GemiGo」，再开始对话。");
  const response = await fetch(
    `${config.apiBase}/apps/${encodeURIComponent(config.projectId)}/connections/${encodeURIComponent(connection)}/tickets`,
    {
      method: "POST",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      signal,
    },
  );
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error(
      response.status === 401
        ? "登录已失效，请重新登录 GemiGo。"
        : data.error || "应用连接暂时不可用。",
    );
  }
  return data;
}
export async function connectVoice(signal) {
  const data = await ticket(config.voiceConnection || "voice", signal);
  return new WebSocket(
    `${data.websocketUrl}?ticket=${encodeURIComponent(data.ticket)}`,
  );
}
export async function chat(messages, profile, signal) {
  const data = await ticket(config.textConnection || "text", signal);
  return fetch(data.httpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gemigo-Ticket": data.ticket,
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: profiles[profile] || profiles.friend },
        ...messages,
      ],
      stream: true,
    }),
    signal,
  });
}
export function configureSession(socket, settings, profile) {
  socket.send(
    JSON.stringify({
      type: "session.update",
      session: {
        voice: settings.voice,
        instructions: profiles[profile] || profiles.friend,
        turn_detection: { silence_duration_ms: settings.pause },
      },
    }),
  );
}

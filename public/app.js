import { AudioEngine } from "./audio.js";
import { createOrb } from "./orb.js";
import * as gateway from "./gateway.js";

const $ = (id) => document.getElementById(id);
const orb = createOrb($("orb"));
const modes = {
  friend: {
    title: "随心聊聊",
    headline: ["让想法，有个", "回声。"],
    subtitle: "不必组织好语言。今天想聊什么，就说什么。",
  },
  ideas: {
    title: "灵感搭子",
    headline: ["把灵感，一起", "打开。"],
    subtitle: "那些还没想明白的事，我们可以慢慢聊。",
  },
  english: {
    title: "英语练习",
    headline: ["Make a little", "conversation."],
    subtitle: "说错也没关系。我们一起，让表达更自然。",
  },
};
const storageKey = "xiaoban-sessions-v1";
let sessions = [],
  settings = { voice: "Tina", speed: 1, pause: 800, playback: "smooth" },
  current;
try {
  sessions = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (!Array.isArray(sessions)) sessions = [];
  sessions = sessions
    .filter(
      (s) =>
        s &&
        typeof s.id === "string" &&
        modes[s.profile] &&
        Array.isArray(s.messages),
    )
    .slice(0, 20);
} catch {
  sessions = [];
}
try {
  const saved = JSON.parse(localStorage.getItem("xiaoban-settings") || "{}");
  settings = { ...settings, ...saved };
} catch {
  /* Use defaults for invalid browser storage. */
}
// Earlier versions saved voices that Qwen 3.8 cannot generate.
if (!["Tina", "Serena", "Zane"].includes(settings.voice))
  settings.voice = "Tina";
if (!["smooth", "realtime"].includes(settings.playback))
  settings.playback = "smooth";
let phase = "idle",
  calling = false,
  socket = null,
  callEpoch = 0,
  textEpoch = 0,
  controller = null,
  assistant = null,
  replyComplete = true,
  timer = null,
  callStart = 0,
  toastTimer,
  previewing = false,
  outputWarning = false;
const userItems = new Map();
const canceledResponses = new Set();
let voiceResponseId = null;
let loginButton;
function updateLoginButton() {
  if (loginButton && !loginButton.disabled)
    loginButton.textContent = gateway.loggedIn() ? "已登录 · 退出" : "登录 GemiGo";
}
const engine = new AudioEngine(
  (audio) => {
    if (
      socket?.readyState === WebSocket.OPEN &&
      calling &&
      phase !== "connecting"
    ) {
      if (socket.bufferedAmount > 512000) {
        endCall();
        notify("网络传输跟不上麦克风，已停止通话。请检查连接后重试。");
        return;
      }
      socket.send(
        JSON.stringify({
          type: gateway.gatewayEnabled ? "input_audio_buffer.append" : "audio",
          audio,
        }),
      );
    }
  },
  () => {
    if (previewing) {
      stopPreview();
      $("sound-check-status").textContent =
        "试听结束。没有听到时，请检查浏览器标签页静音和输出设备。";
    }
    if (calling && replyComplete && !engine.busy) setPhase("listening");
  },
  (value) => orb.setLevel(value),
  (message) => {
    endCall();
    notify(message || "麦克风连接中断，请重新开始通话。");
  },
  (state) => {
    updateSpeakerButton();
    if (state === "blocked") {
      if (calling) setPhase("audio-paused");
      if (!outputWarning)
        notify("浏览器暂停了声音。请点击右侧扬声器按钮恢复播放。", 12000);
      outputWarning = true;
    } else if (state === "buffering") {
      if (calling && engine.speaker) setPhase("buffering");
    } else {
      outputWarning = false;
      if (calling && engine.speaker) {
        if (engine.buffering) setPhase("buffering");
        else if (engine.sources.size) setPhase("speaking");
      }
    }
  },
);
engine.rate = Number(settings.speed) || 1;
engine.mode = settings.playback;

function notify(message, duration = 6500) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), duration);
}
function save() {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(
        sessions.filter((s) => s.messages.some((m) => m.content)).slice(0, 20),
      ),
    );
  } catch {
    notify("浏览器没有足够空间保存对话，可以先导出记录。");
  }
}
function newSession(profile = current?.profile || "friend") {
  stopText();
  endCall();
  current = {
    id: crypto.randomUUID(),
    profile,
    created: Date.now(),
    messages: [],
  };
  sessions = sessions.filter((s) => s.messages.some((m) => m.content));
  sessions.unshift(current);
  sessions = sessions.slice(0, 20);
  updateMode();
  renderMessages();
  renderHistory();
  setPhase("idle");
}
function updateMode() {
  const mode = modes[current.profile];
  $("mode-title").textContent = mode.title;
  $("headline").replaceChildren(document.createTextNode(mode.headline[0]));
  const accent = document.createElement("span");
  accent.textContent = mode.headline[1];
  $("headline").append(accent);
  $("subheading").textContent = mode.subtitle;
  document.querySelectorAll("[data-profile]").forEach((b) => {
    b.setAttribute("aria-label", modes[b.dataset.profile].title);
    b.title = modes[b.dataset.profile].title;
    b.classList.toggle("active", b.dataset.profile === current.profile);
    b.setAttribute(
      "aria-pressed",
      String(b.dataset.profile === current.profile),
    );
  });
}
function setPhase(value) {
  updateLoginButton();
  phase = value;
  document.body.dataset.phase = value;
  orb.setPhase(value);
  const labels = {
    idle: "我在这里，准备听你说。",
    connecting: "正在连接，稍等一下…",
    listening: engine.muted ? "麦克风已静音" : "正在听，你可以说话了。",
    hearing: "嗯，我在听…",
    thinking: "让我想一想…",
    speaking: "小伴正在回应…",
    buffering:
      engine.responseMode === "smooth"
        ? "正在准备完整语音，稍等一下…"
        : "正在缓冲语音，稍等一下…",
    "audio-paused": "声音播放被暂停，请点扬声器按钮恢复。",
    error: "暂时没有连上，可以再试一次。",
  };
  $("phase-text").textContent =
    calling &&
    !engine.speaker &&
    ["speaking", "thinking", "buffering", "listening"].includes(value)
      ? "声音已关闭，回复会显示在右侧。"
      : labels[value];
  $("connection-label").textContent = calling
    ? value === "connecting"
      ? "正在连接"
      : "通话进行中"
    : controller
      ? "文字对话中"
      : "随时可以开始";
  $("interrupt").hidden = !["thinking", "buffering", "speaking", "audio-paused"].includes(
    value,
  );
}
function renderHistory() {
  for (const list of [$("history-list"), $("mobile-history-list")]) {
    list.replaceChildren();
    const recent = sessions.filter((s) =>
      s.messages.some((m) => m.role === "user" && m.content),
    );
    if (!recent.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "还没有记录，开始聊聊吧";
      list.append(empty);
    }
    for (const session of recent.slice(0, 10)) {
      const button = document.createElement("button");
      button.className = "history-item";
      button.textContent = session.messages.find(
        (m) => m.role === "user" && m.content,
      ).content;
      button.title = button.textContent;
      button.onclick = () => {
        stopText();
        endCall();
        current = session;
        updateMode();
        renderMessages();
        setPhase("idle");
        $("history-dialog").close();
      };
      list.append(button);
    }
  }
}
function renderMessages() {
  $("messages").replaceChildren();
  const records = current.messages.filter((m) => m.content || m.pending);
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = "✳";
    const heading = document.createElement("h2");
    heading.textContent = "有些话，说出来就轻一点。";
    const text = document.createElement("p");
    text.textContent = "你说的，和小伴的回应，都会静静留在这里。";
    const line = document.createElement("div");
    line.className = "empty-line";
    const note = document.createElement("span");
    note.className = "empty-note";
    note.textContent = "每一段对话，都从一句你好开始。";
    empty.append(icon, heading, text, line, note);
    $("messages").append(empty);
  } else
    for (const message of records) {
      const card = document.createElement("article");
      card.className = `message ${message.role}${message.pending ? " partial" : ""}`;
      const head = document.createElement("div");
      head.className = "message-head";
      const avatar = document.createElement("span");
      avatar.className = "message-avatar";
      avatar.textContent = message.role === "user" ? "你" : "✳";
      const name = document.createElement("span");
      name.textContent = message.role === "user" ? "你" : "小伴";
      const time = document.createElement("time");
      time.textContent = new Date(message.time).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const text = document.createElement("div");
      text.className = "message-text";
      text.textContent =
        message.content || (message.role === "user" ? "正在听…" : "…");
      head.append(avatar, name, time);
      card.append(head, text);
      $("messages").append(card);
    }
  $("message-count").textContent = String(records.length);
  $("messages").scrollTop = $("messages").scrollHeight;
}
function addMessage(role, content = "", pending = false) {
  const message = {
    id: crypto.randomUUID(),
    role,
    content,
    pending,
    time: Date.now(),
  };
  current.messages.push(message);
  current.messages = current.messages.slice(-60);
  renderMessages();
  return message;
}
function finaliseReply(interrupted = false) {
  if (assistant) {
    assistant.pending = false;
    assistant.interrupted = interrupted;
    if (!assistant.content)
      current.messages = current.messages.filter((m) => m !== assistant);
  }
  assistant = null;
  replyComplete = true;
  renderMessages();
  save();
  renderHistory();
}
function stopText() {
  ++textEpoch;
  controller?.abort();
  controller = null;
  if (assistant && !calling) finaliseReply(true);
  $("send-text").disabled = false;
}
function endCall() {
  stopPreview();
  ++callEpoch;
  calling = false;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
  engine.stop();
  engine.setMuted(false);
  clearInterval(timer);
  timer = null;
  if (assistant) finaliseReply(true);
  for (const message of current?.messages || []) message.pending = false;
  if (current) {
    current.messages = current.messages.filter((m) => m.content);
    renderMessages();
    save();
  }
  userItems.clear();
  $("call-button").classList.remove("in-call");
  $("call-button").querySelector("span").textContent = "开始通话";
  $("call-button").querySelector("use").setAttribute("href", "#i-phone");
  $("mic-toggle").disabled = true;
  $("mic-toggle").classList.remove("muted");
  $("mic-toggle").querySelector("use").setAttribute("href", "#i-mic");
  $("mic-toggle").setAttribute("aria-label", "静音麦克风");
  $("mic-toggle").title = "静音麦克风";
  $("text-input").disabled = false;
  $("send-text").disabled = false;
  $("text-input").placeholder = "不方便说话？打字也可以…";
  $("text-mode-label").textContent = "文字模式 · 只显示文字";
  $("call-timer").hidden = true;
  $("call-hint").textContent = "自然说话 · 自动回应 · 随时打断";
  setPhase("idle");
}
async function startCall() {
  stopPreview();
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)
    return notify("这个浏览器不支持实时麦克风，请用 Chrome 打开本机地址。");
  if (current.messages.length) newSession(current.profile);
  stopText();
  calling = true;
  const epoch = ++callEpoch;
  $("call-button").classList.add("in-call");
  $("call-button").querySelector("span").textContent = "取消连接";
  $("call-button").querySelector("use").setAttribute("href", "#i-end");
  $("text-input").disabled = true;
  $("send-text").disabled = true;
  $("text-input").placeholder = "通话中，直接说出你的想法…";
  $("text-mode-label").textContent = "语音模式 · 千问 3.8";
  setPhase("connecting");
  try {
    if (!(await engine.start()) || epoch !== callEpoch) return;
    const params = new URLSearchParams({
      voice: settings.voice,
      profile: current.profile,
      pause: settings.pause,
    });
    const connection = gateway.gatewayEnabled
      ? await gateway.connectVoice()
      : new WebSocket(`ws://${location.host}/realtime?${params}`);
    if (epoch !== callEpoch) {
      connection.close();
      return;
    }
    socket = connection;
    socket.onmessage = (event) => {
      if (epoch !== callEpoch) return;
      try {
        onVoiceEvent(JSON.parse(event.data));
      } catch {
        endCall();
        notify("语音数据无法播放，请重新连接。");
      }
    };
    socket.onerror = () => {
      if (epoch === callEpoch) {
        endCall();
        notify(
          gateway.gatewayEnabled
            ? "语音连接失败，请检查应用连接配置并重试。"
            : "本机服务连接失败，请确认 npm start 正在运行。",
        );
        setPhase("error");
      }
    };
    socket.onclose = () => {
      if (epoch === callEpoch) {
        endCall();
        notify("通话已断开，点击开始通话重连。");
      }
    };
  } catch (error) {
    if (epoch !== callEpoch) return;
    endCall();
    notify(
      error.name === "NotAllowedError"
        ? "麦克风权限未开启。请在浏览器地址栏允许麦克风后，再开始通话。"
        : error.name === "AudioOutputError"
          ? "浏览器未允许播放声音。请点击声音设置里的「试听 AI 声音」，或在 Chrome 中重试。"
          : error.name === "NotFoundError"
            ? "没有找到麦克风。连接麦克风后重试，或用文字聊天。"
            : gateway.gatewayEnabled
              ? error.message
              : "麦克风启动失败。请关闭占用麦克风的应用后重试。",
    );
    setPhase("error");
  }
}
function onVoiceEvent(event) {
  const type = event.type;
  if (gateway.gatewayEnabled) {
    const responseId = event.response_id || event.response?.id;
    if (canceledResponses.has(responseId) && /delta|done/.test(type)) return;
    if (type === "response.created") voiceResponseId = event.response.id;
    if (canceledResponses.size > 32)
      canceledResponses.delete(canceledResponses.values().next().value);
  }
  if (gateway.gatewayEnabled && type === "session.created") {
    gateway.configureSession(socket, settings, current.profile);
  } else if (
    type === "app.ready" ||
    (gateway.gatewayEnabled && type === "session.updated")
  ) {
    setPhase("listening");
    $("call-button").querySelector("span").textContent = "结束通话";
    $("mic-toggle").disabled = false;
    $("call-hint").textContent = "戴上耳机体验更好 · 直接说话就能打断";
    callStart = Date.now();
    $("call-timer").textContent = "00:00";
    $("call-timer").hidden = false;
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - callStart) / 1000);
      $("call-timer").textContent =
        `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  } else if (type === "error" && gateway.gatewayEnabled) {
    if (/cancel|no.*response|not.*active/i.test(event.error?.message || ""))
      return;
    endCall();
    notify("千问拒绝了语音请求，请检查应用的 Key、模型权限与余额。", 12000);
    setPhase("error");
  } else if (type === "app.error") {
    endCall();
    notify(event.message, 12000);
    setPhase("error");
  } else if (type === "app.warning") {
    notify(event.message);
  } else if (type === "input_audio_buffer.speech_started") {
    if (gateway.gatewayEnabled && !replyComplete) {
      if (voiceResponseId) canceledResponses.add(voiceResponseId);
      socket?.send(JSON.stringify({ type: "response.cancel" }));
    }
    engine.interrupt();
    finaliseReply(true);
    replyComplete = true;
    if (!userItems.has(event.item_id))
      userItems.set(event.item_id, addMessage("user", "", true));
    setPhase("hearing");
  } else if (type === "input_audio_buffer.speech_stopped") {
    setPhase("thinking");
  } else if (type === "conversation.item.input_audio_transcription.completed") {
    let message = userItems.get(event.item_id);
    if (!message) message = addMessage("user");
    message.content = event.transcript || "（这句话没有识别清楚）";
    message.pending = false;
    renderMessages();
    save();
  } else if (type === "conversation.item.input_audio_transcription.failed") {
    notify("这句话的文字记录没有识别成功，你可以重新说一遍。");
  } else if (type === "response.created") {
    if (assistant) finaliseReply();
    assistant = addMessage("assistant", "", true);
    replyComplete = false;
    setPhase("thinking");
    engine.beginResponse();
  } else if (
    type === "response.audio_transcript.delta" ||
    type === "response.text.delta"
  ) {
    if (!assistant) assistant = addMessage("assistant", "", true);
    assistant.content += event.delta || "";
    renderMessages();
  } else if (
    type === "response.audio_transcript.done" ||
    type === "response.text.done"
  ) {
    if (assistant && (event.transcript || event.text)) {
      assistant.content = event.transcript || event.text;
      renderMessages();
    }
  } else if (type === "response.audio.delta") {
    engine.play(event.delta);
    if (engine.speaker)
      setPhase(
        engine.outputBlocked
          ? "audio-paused"
          : engine.buffering
            ? "buffering"
            : "speaking",
      );
  } else if (type === "response.audio.done") {
    engine.completeResponse();
  } else if (type === "response.done") {
    if (event.response?.status === "cancelled") engine.interrupt();
    else engine.completeResponse();
    finaliseReply();
    if (!engine.busy) setPhase("listening");
  } else if (type === "app.interrupted") {
    engine.interrupt();
    finaliseReply(true);
    setPhase("listening");
  }
}
async function sendText(text) {
  if (!text.trim()) return;
  if (calling) return notify("通话中请直接说话，结束通话后可以打字。");
  stopText();
  const epoch = textEpoch;
  controller = new AbortController();
  addMessage("user", text.trim());
  assistant = addMessage("assistant", "", true);
  save();
  $("send-text").disabled = true;
  setPhase("thinking");
  $("text-input").value = "";
  const messages = current.messages
    .filter((m) => m.content && ["user", "assistant"].includes(m.role))
    .slice(-40)
    .map(({ role, content }) => ({ role, content }));
  try {
    const response = gateway.gatewayEnabled
      ? await gateway.chat(messages, current.profile, controller.signal)
      : await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ messages, profile: current.profile }),
        });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "文字对话暂时不可用。");
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      hadContent = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (epoch !== textEpoch) {
        await reader.cancel();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of frame.split("\n"))
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            const event = JSON.parse(data);
            if (event.error)
              throw new Error(
                typeof event.error === "string"
                  ? event.error
                  : "文字模型回复失败。",
              );
            const delta = event.choices?.[0]?.delta?.content;
            if (delta && assistant) {
              assistant.content += delta;
              hadContent = true;
              renderMessages();
            }
          }
      }
    }
    if (!hadContent) throw new Error("模型没有返回文字，请重新试一次。");
    if (epoch === textEpoch) {
      controller = null;
      finaliseReply();
      $("send-text").disabled = false;
      setPhase("idle");
    }
  } catch (error) {
    if (epoch !== textEpoch) return;
    controller = null;
    finaliseReply(true);
    $("send-text").disabled = false;
    setPhase("idle");
    if (error.name !== "AbortError") notify(error.message, 10000);
  }
}

$("call-button").onclick = () => (calling ? endCall() : startCall());
$("mic-toggle").onclick = () => {
  engine.setMuted(!engine.muted);
  $("mic-toggle").classList.toggle("muted", engine.muted);
  $("mic-toggle").setAttribute(
    "aria-label",
    engine.muted ? "打开麦克风" : "静音麦克风",
  );
  $("mic-toggle").title = engine.muted ? "打开麦克风" : "静音麦克风";
  $("mic-toggle")
    .querySelector("use")
    .setAttribute("href", engine.muted ? "#i-mute" : "#i-mic");
  if (phase === "listening" || phase === "hearing") setPhase("listening");
};
function updateSpeakerButton() {
  const label =
    engine.outputBlocked && engine.speaker
      ? "恢复声音"
      : engine.speaker
        ? "关闭声音"
        : "打开声音";
  $("speaker-toggle").classList.toggle("muted", !engine.speaker);
  $("speaker-toggle").setAttribute("aria-label", label);
  $("speaker-toggle").title = label;
}
$("speaker-toggle").onclick = () => {
  if (engine.outputBlocked && engine.speaker) {
    void engine.resumeOutput();
    return;
  }
  engine.setSpeaker(!engine.speaker);
  updateSpeakerButton();
  if (!engine.speaker && replyComplete && calling) setPhase("listening");
};
function stopPreview() {
  if (!previewing) return;
  previewing = false;
  engine.stop();
  updateSpeakerButton();
  $("sound-check").textContent = "试听 AI 声音";
}
$("sound-check").onclick = async () => {
  if (calling) return notify("请先结束通话，再试听声音。");
  if (previewing) {
    stopPreview();
    return;
  }
  previewing = true;
  const epoch = callEpoch;
  const generation = engine.generation;
  $("sound-check").textContent = "停止试听";
  $("sound-check-status").textContent = "正在准备声音…";
  engine.setSpeaker(true);
  updateSpeakerButton();
  try {
    // Unlock audio within the click gesture, before the sample fetch.
    if (!(await engine.startOutput()))
      throw new Error(
        "浏览器阻止了声音播放，请再次点击试听，或用 Chrome 打开。",
      );
    const response = await fetch("/sound-check.wav");
    if (!response.ok) throw new Error("试听语音加载失败，请刷新后重试。");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!previewing || epoch !== callEpoch || generation !== engine.generation)
      return;
    let raw = "";
    for (const byte of bytes.subarray(44)) raw += String.fromCharCode(byte);
    engine.beginResponse();
    engine.play(btoa(raw));
    engine.completeResponse();
    $("sound-check-status").textContent = "正在播放千问 3.8 语音样例…";
  } catch (error) {
    if (!previewing || epoch !== callEpoch || generation !== engine.generation)
      return;
    stopPreview();
    $("sound-check-status").textContent = error.message;
  }
};
$("interrupt").onclick = () => {
  if (calling) {
    if (gateway.gatewayEnabled && voiceResponseId)
      canceledResponses.add(voiceResponseId);
    engine.interrupt();
    socket?.send(
      JSON.stringify({
        type: gateway.gatewayEnabled ? "response.cancel" : "interrupt",
      }),
    );
    finaliseReply(true);
    setPhase("listening");
  } else {
    stopText();
    setPhase("idle");
  }
};
$("new-chat").onclick = () => newSession();
document.querySelectorAll("[data-profile]").forEach(
  (button) =>
    (button.onclick = () => {
      if (current.profile !== button.dataset.profile)
        newSession(button.dataset.profile);
    }),
);
document.querySelectorAll("[data-prompt]").forEach(
  (button) =>
    (button.onclick = () => {
      $("text-input").value = button.dataset.prompt;
      $("text-input").focus();
      if (calling) notify("可以直接说出这个话题，或挂断后发送文字。");
    }),
);
$("text-form").onsubmit = (event) => {
  event.preventDefault();
  if (!controller) sendText($("text-input").value);
};
$("text-input").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!controller) sendText($("text-input").value);
  }
};
$("export").onclick = () => {
  if (!current.messages.some((m) => m.content))
    return notify("还没有可以导出的对话。");
  const text =
    `小伴 · ${modes[current.profile].title}\n${new Date(current.created).toLocaleString("zh-CN")}\n\n` +
    current.messages
      .filter((m) => m.content)
      .map((m) => `${m.role === "user" ? "你" : "小伴"}：${m.content}`)
      .join("\n\n");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `小伴对话-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("clear").onclick = () => {
  if (!current.messages.length) return;
  if (!confirm("清空这段对话？需要的话可以先导出记录。")) return;
  stopText();
  endCall();
  current.messages = [];
  save();
  renderMessages();
  renderHistory();
  notify("这段对话已经清空。");
};
$("settings-btn").onclick = async () => {
  $("voice").value = settings.voice;
  $("speed").value = settings.speed;
  $("pause").value = settings.pause;
  $("playback").value = settings.playback;
  $("speed-label").textContent = `${Number(settings.speed).toFixed(1)}×`;
  $("settings-dialog").showModal();
  if (gateway.gatewayEnabled) {
    $("config-note").textContent =
      "语音使用千问 3.8，文字使用 DeepSeek；密钥由 GemiGo 保存在服务端。";
    return;
  }
  try {
    const data = await (await fetch("/api/status")).json();
    $("config-note").textContent =
      `${data.voiceConfigured ? "已读取千问密钥，连接时验证权限。" : "千问密钥未配置：请设置项目 .env 的 DASHSCOPE_API_KEY。"} ${data.textConfigured ? "文字模型已配置。" : "文字模型未配置。"}`;
  } catch {
    $("config-note").textContent = "本机服务未连接，请运行 npm start。";
  }
};
$("history-btn").onclick = () => {
  renderHistory();
  $("history-dialog").showModal();
};
$("close-history").onclick = () => $("history-dialog").close();
$("close-settings").onclick = () => $("settings-dialog").close();
$("settings-dialog").onclose = () => stopPreview();
$("settings-dialog").onclick = (event) => {
  if (event.target === $("settings-dialog")) {
    const r = event.target.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      event.target.close();
  }
};
$("speed").oninput = () =>
  ($("speed-label").textContent = `${Number($("speed").value).toFixed(1)}×`);
$("settings-form").onsubmit = (event) => {
  event.preventDefault();
  settings = {
    voice: $("voice").value,
    speed: Number($("speed").value),
    pause: Number($("pause").value),
    playback: $("playback").value,
  };
  engine.rate = settings.speed;
  engine.mode = settings.playback;
  try {
    localStorage.setItem("xiaoban-settings", JSON.stringify(settings));
  } catch {
    notify("设置无法保存到浏览器，下次打开将使用默认值。");
  }
  $("settings-dialog").close();
  notify("声音设置已保存。", 2200);
};
window.addEventListener("pagehide", () => {
  stopText();
  endCall();
});
newSession("friend");

if (gateway.gatewayEnabled) {
  const button = document.createElement("button");
  loginButton = button;
  button.className = "small-button";
  updateLoginButton();
  button.onclick = async () => {
    if (gateway.loggedIn()) {
      stopText();
      endCall();
      gateway.logout();
      updateLoginButton();
      notify("已退出登录。", 2200);
      return;
    }
    try {
      button.disabled = true;
      button.textContent = "正在前往 GemiGo…";
      await gateway.login();
      button.disabled = false;
      updateLoginButton();
      notify("登录成功，可以开始对话了。");
    } catch (error) {
      button.disabled = false;
      button.textContent = "登录 GemiGo";
      notify(error.message);
    }
  };
  $("settings-btn").parentElement.append(button);
  try {
    const result = await gateway.resumeLogin();
    updateLoginButton();
    if (result) {
      notify("登录成功，可以开始对话了。");
    }
  } catch (error) {
    notify(error.message === "Login cancelled." ? "已取消登录。" : "登录未完成，请重新登录 GemiGo。");
  }
}

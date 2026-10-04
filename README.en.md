# Xiaoban · 小伴

A browser-based AI voice companion for everyday conversation, brainstorming, and English practice. Built with plain JavaScript, Web Audio, and a small Node.js server.

[中文](README.md) · [Live demo](https://xiaoban-voice.gemigo.app) · [MIT](LICENSE)

![Xiaoban desktop](docs/images/desktop.jpg)

Features include Qwen 3.8 realtime voice, automatic turn detection, interruptible replies, microphone/speaker controls, three conversation profiles, local history, and optional streaming text chat through DeepSeek or an OpenAI-compatible endpoint. English practice is conversational, without pronunciation scoring. The current interface is in Chinese.

The default smooth playback mode waits for the complete audio reply before playing it continuously. A lower-latency streaming mode is also available. This is an early release: slow networks and speaker echo can still affect conversations. Headphones are recommended.

## Run locally

Node.js 22+ and your own enabled Model Studio API account are required. Provider API usage may incur charges. No GemiGo account is needed for local use.

```sh
git clone https://github.com/Peiiii/xiaoban.git
cd xiaoban
npm ci
cp .env.example .env
```

Set `DASHSCOPE_API_KEY` and replace `YOUR_WORKSPACE_ID` in `DASHSCOPE_REALTIME_URL`. Use matching API key, workspace and region. Qwen 3.8 requires a workspace-specific endpoint:

```dotenv
DASHSCOPE_MODEL=qwen3.8-omni-flash-realtime
DASHSCOPE_REALTIME_URL=wss://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime
```

For Singapore, use `YOUR_WORKSPACE_ID.ap-southeast-1.maas.aliyuncs.com`. See [official setup documentation](https://help.aliyun.com/zh/model-studio/omni-realtime-python-sdk).

```sh
npm start
```

Open **http://localhost:4318**, start a call, and allow microphone access. End the call to release the microphone. To enable optional text-only chat, configure `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL` in `.env`, then restart. Text chat does not synthesize speech.

## Privacy and deployment

Keys stay on the server. Browser history uses localStorage; audio and conversations are processed by the configured model providers. The local server does not record audio. The app is not an offline model.

The local server binds to `127.0.0.1` and has no public authentication or quotas. Public deployment needs additional access control. The hosted demo uses GemiGo, requires login, and has usage limits. Building static files alone does not supply the local WebSocket bridge. See the [Chinese README](README.md) for the optional GemiGo build configuration.

## Development

```sh
npm run check
npm test
npm run build
```

See [architecture](docs/architecture.md) and [dependency notices](NOTICE). The GemiGo SDK is pinned to an official vendor tarball and generated locally, not committed. The browser fixture emits synthetic test tones; use port 4318 for normal use.

Issues and contributions are welcome. If you find the project useful, a star helps others discover it.

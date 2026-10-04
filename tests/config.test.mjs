import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.mjs";

test("an unconfigured installation has no credentials, even on a configured developer machine", () => {
  const config = loadConfig({});
  assert.equal(config.dashscopeKey, "");
  assert.equal(config.deepseekKey, "");
  assert.equal(config.port, 4318);
});

test("explicit provider credentials, workspace endpoint and text provider stay independent", () => {
  const config = loadConfig({
    PORT: "4321", DASHSCOPE_API_KEY: "fixture-voice",
    DASHSCOPE_MODEL: "qwen3.8-omni-flash-realtime",
    DASHSCOPE_REALTIME_URL: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
    DEEPSEEK_API_KEY: "fixture-text", DEEPSEEK_BASE_URL: "https://text.example/v1",
    DEEPSEEK_MODEL: "custom-text-model",
  });
  assert.equal(config.port, 4321);
  assert.equal(config.dashscopeKey, "fixture-voice");
  assert.equal(config.deepseekKey, "fixture-text");
  assert.equal(config.realtimeUrl, "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime");
  assert.equal(config.deepseekBase, "https://text.example/v1");
  assert.equal(config.deepseekModel, "custom-text-model");
});

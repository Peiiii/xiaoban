export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 4318),
    dashscopeKey: env.DASHSCOPE_API_KEY || "",
    realtimeUrl:
      env.DASHSCOPE_REALTIME_URL ||
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    model: env.DASHSCOPE_MODEL || "qwen3.8-omni-flash-realtime",
    deepseekKey: env.DEEPSEEK_API_KEY || "",
    deepseekBase:
      env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    deepseekModel: env.DEEPSEEK_MODEL || "deepseek-flash",
  };
}

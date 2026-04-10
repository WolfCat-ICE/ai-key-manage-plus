import type {
  OpenAIProxyBenchmarkRoundRequest,
  OpenAIProxyBenchmarkRoundResponse,
  OpenAIProxyProbeRequest,
  OpenAIProxyProbeResponse,
  OpenAIProxyTestRequest,
  OpenAIProxyTestResponse,
} from "@/lib/openai-proxy-types";

const FAIL_TEXT = "主人，我不行了";
const PASS_TEXT = "主人，快鞭策我吧";
const MODEL_CANDIDATES = ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1", "gpt-4o", "gpt-5-mini", "gpt-5"];

type ModelTextResult = {
  ok: boolean;
  text: string;
  elapsedMs: number;
  error?: string;
};

type StreamTextResult = {
  ok: boolean;
  text: string;
  elapsedMs: number;
  firstTokenMs?: number;
  error?: string;
};

type TestResponseSource = "stream" | "chat" | "responses";
type SourcedModelTextResult = ModelTextResult & {
  source: TestResponseSource;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanOneLineText(input: string, maxLen = 220): string {
  const singleLine = input.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen)}...`;
}

function cleanMultilineText(input: string, maxLen = 2000): string {
  const normalized = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen).trimEnd()}...`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function isLowSignalResponseText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;

  return [
    "ok",
    "okay",
    "ok.",
    "ok!",
    "ok？",
    "ok?",
    "好的",
    "收到",
    "收到。",
    "已收到",
    "明白",
    "在",
    "在的",
    "hi",
    "hello",
  ].includes(normalized);
}

function scoreResponseText(text: string): number {
  const normalized = text.trim();
  if (!normalized) return -1;

  let score = Math.min(normalized.length, 240);
  if (/[\u4e00-\u9fa5]/.test(normalized)) score += 40;
  if (!isLowSignalResponseText(normalized)) score += 120;
  if (/[，。！？,.!?]/.test(normalized)) score += 20;
  return score;
}

function pickBestTextResult(results: SourcedModelTextResult[]): SourcedModelTextResult | undefined {
  const successful = results.filter((item) => item.ok && item.text.trim());
  if (successful.length === 0) return undefined;

  return [...successful].sort((left, right) => {
    const scoreDiff = scoreResponseText(right.text) - scoreResponseText(left.text);
    if (scoreDiff !== 0) return scoreDiff;
    return left.elapsedMs - right.elapsedMs;
  })[0];
}

function normalizeBaseUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  if (!/^https?:\/\//i.test(cleaned)) return `https://${cleaned}`;
  return cleaned;
}

function toOpenAIBaseUrl(raw: string): string {
  const normalized = normalizeBaseUrl(raw);
  if (!normalized) return "";

  const withoutEndpoint = normalized
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/responses$/i, "")
    .replace(/\/response$/i, "")
    .replace(/\/completions$/i, "");

  if (/\/v\d+$/i.test(withoutEndpoint)) return withoutEndpoint;
  return `${withoutEndpoint}/v1`;
}

function cleanKey(raw: string): string {
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function toReadableResponseText(content: unknown): string {
  if (typeof content === "string") return cleanMultilineText(content);
  if (!Array.isArray(content)) return "";

  const texts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      const text = part.text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean);

  return cleanMultilineText(texts.join("\n"));
}

function extractChatMessageContent(payload: unknown): unknown {
  const firstChoice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const message = isRecord(firstChoice) ? firstChoice.message : undefined;
  return isRecord(message) ? message.content : undefined;
}

function extractResponsesText(payload: unknown): string {
  if (!isRecord(payload)) return "";

  const directText = payload.output_text;
  if (typeof directText === "string" && directText.trim()) {
    return cleanMultilineText(directText);
  }

  if (!Array.isArray(payload.output)) return "";

  const texts = payload.output
    .flatMap((item) => {
      if (!isRecord(item)) return [];

      const content = item.content;
      if (!Array.isArray(content)) return [];

      return content
        .map((part) => {
          if (!isRecord(part)) return "";
          if (typeof part.text === "string") return part.text;
          if (typeof part.refusal === "string") return part.refusal;
          return "";
        })
        .filter(Boolean);
    })
    .join("\n");

  return cleanMultilineText(texts);
}

function getErrorMessage(error: unknown): string {
  if (!isRecord(error)) return "";

  const directError = error.error;
  if (typeof directError === "string" && directError.trim()) return cleanOneLineText(directError, 260);

  const directMessage = error.message;
  if (typeof directMessage === "string" && directMessage.trim()) return cleanOneLineText(directMessage, 260);

  const nestedPaths = [
    ["error", "message"],
    ["response", "error", "message"],
    ["response", "data", "error", "message"],
    ["response", "body", "error", "message"],
    ["data", "error", "message"],
    ["body", "error", "message"],
    ["cause", "message"],
  ];

  for (const path of nestedPaths) {
    let current: unknown = error;
    for (const key of path) {
      if (!isRecord(current)) {
        current = "";
        break;
      }
      current = current[key];
    }
    if (typeof current === "string" && current.trim()) return cleanOneLineText(current, 260);
  }

  return "";
}

function makeErrorDetail(error: unknown): string {
  const baseError = isRecord(error) ? error : {};
  const status = typeof baseError.status === "number" ? baseError.status : undefined;
  const name = typeof baseError.name === "string" ? baseError.name : "";
  const raw = getErrorMessage(error);

  let detail = "测试异常，请检查地址或模型";
  if (status === 401 || status === 403) detail = "Key 无效或权限不足";
  else if (status === 404) detail = "地址可达，但聊天接口不存在";
  else if (typeof status === "number") detail = `请求失败（HTTP ${status}）`;
  else if (name === "AbortError" || /timeout|timed out/i.test(raw)) detail = "请求超时，请检查地址";
  else if (/network|fetch failed|connection|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
    detail = "请求失败，请检查网络或地址";
  }

  if (!raw) return detail;
  if (detail.includes(raw)) return detail;
  return `${detail}；接口返回：${raw}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw {
      status: response.status,
      message: getErrorMessage(payload) || `HTTP ${response.status}`,
    };
  }

  return payload;
}

async function requestModelText(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<ModelTextResult> {
  const startedAt = performance.now();

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
        }),
      },
      12000,
    );

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const elapsedMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      return {
        ok: false,
        text: "",
        elapsedMs,
        error: getErrorMessage(payload) || `HTTP ${response.status}`,
      };
    }

    if (isRecord(payload) && "error" in payload) {
      return {
        ok: false,
        text: "",
        elapsedMs,
        error: getErrorMessage(payload) || "模型不可用或上游渠道异常",
      };
    }

    const content = extractChatMessageContent(payload);
    const text = toReadableResponseText(content);

    if (text || content) {
      return { ok: true, text, elapsedMs };
    }

    return { ok: false, text: "", elapsedMs, error: "未返回消息内容" };
  } catch (error: unknown) {
    return {
      ok: false,
      text: "",
      elapsedMs: Math.round(performance.now() - startedAt),
      error: makeErrorDetail(error),
    };
  }
}

async function requestResponsesText(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<ModelTextResult> {
  const startedAt = performance.now();

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/responses`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: prompt,
        }),
      },
      12000,
    );

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const elapsedMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      return {
        ok: false,
        text: "",
        elapsedMs,
        error: getErrorMessage(payload) || `HTTP ${response.status}`,
      };
    }

    if (isRecord(payload) && "error" in payload) {
      return {
        ok: false,
        text: "",
        elapsedMs,
        error: getErrorMessage(payload) || "模型不可用或上游渠道异常",
      };
    }

    const text = extractResponsesText(payload);
    if (text) {
      return { ok: true, text, elapsedMs };
    }

    return { ok: false, text: "", elapsedMs, error: "未返回消息内容" };
  } catch (error: unknown) {
    return {
      ok: false,
      text: "",
      elapsedMs: Math.round(performance.now() - startedAt),
      error: makeErrorDetail(error),
    };
  }
}

function shouldTryResponsesFallback(error: string): boolean {
  return /404|not found|不存在|does not exist|unsupported/i.test(error);
}

async function requestModelTextBestEffort(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
  options?: {
    preferStream?: boolean;
  },
): Promise<ModelTextResult> {
  if (options?.preferStream) {
    const streamResponse = await requestModelTextStream(baseUrl, apiKey, model, prompt, maxTokens);
    if (streamResponse.ok) {
      return {
        ok: true,
        text: streamResponse.text,
        elapsedMs: streamResponse.elapsedMs,
      };
    }

    const chatResponse = await requestModelText(baseUrl, apiKey, model, prompt, maxTokens);
    if (chatResponse.ok) return chatResponse;

    const shouldTryResponses =
      chatResponse.error === "未返回消息内容" ||
      shouldTryResponsesFallback(streamResponse.error || "") ||
      shouldTryResponsesFallback(chatResponse.error || "");

    if (shouldTryResponses) {
      const responsesResponse = await requestResponsesText(baseUrl, apiKey, model, prompt);
      if (responsesResponse.ok) return responsesResponse;

      return {
        ok: false,
        text: "",
        elapsedMs: streamResponse.elapsedMs,
        error:
          uniqueStrings([
            streamResponse.error || "",
            chatResponse.error || "",
            responsesResponse.error || "",
          ])[0] || "请求失败",
      };
    }

    return {
      ok: false,
      text: "",
      elapsedMs: streamResponse.elapsedMs,
      error: uniqueStrings([streamResponse.error || "", chatResponse.error || ""])[0] || "请求失败",
    };
  }

  const chatResponse = await requestModelText(baseUrl, apiKey, model, prompt, maxTokens);
  if (chatResponse.ok) return chatResponse;

  if (chatResponse.error === "未返回消息内容") {
    const streamResponse = await requestModelTextStream(baseUrl, apiKey, model, prompt, maxTokens);
    if (streamResponse.ok) {
      return {
        ok: true,
        text: streamResponse.text,
        elapsedMs: streamResponse.elapsedMs,
      };
    }

    const responsesResponse = await requestResponsesText(baseUrl, apiKey, model, prompt);
    if (responsesResponse.ok) return responsesResponse;

    return {
      ok: false,
      text: "",
      elapsedMs: chatResponse.elapsedMs,
      error:
        uniqueStrings([
          chatResponse.error || "",
          streamResponse.error || "",
          responsesResponse.error || "",
        ])[0] || "未返回消息内容",
    };
  }

  if (shouldTryResponsesFallback(chatResponse.error || "")) {
    const responsesResponse = await requestResponsesText(baseUrl, apiKey, model, prompt);
    if (responsesResponse.ok) return responsesResponse;

    return {
      ok: false,
      text: "",
      elapsedMs: chatResponse.elapsedMs,
      error: uniqueStrings([chatResponse.error || "", responsesResponse.error || ""])[0] || "请求失败",
    };
  }

  return chatResponse;
}

function extractStreamDeltaText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return "";

  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice)) return "";

  const delta = firstChoice.delta;
  if (!isRecord(delta)) return "";

  const directContent = delta.content;
  if (typeof directContent === "string") return directContent;

  if (Array.isArray(directContent)) {
    return directContent
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return typeof part.text === "string" ? part.text : "";
      })
      .join("");
  }

  const reasoningContent = delta.reasoning_content;
  if (typeof reasoningContent === "string") return reasoningContent;

  return "";
}

async function readStreamError(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as unknown;
    const message = getErrorMessage(payload);
    if (message) return message;
  } catch {
    // Ignore parse errors and fall back to raw text.
  }

  try {
    const rawText = await response.text();
    const cleaned = cleanOneLineText(rawText, 260);
    if (cleaned) return cleaned;
  } catch {
    // Ignore read errors and fall back to status code.
  }

  return `HTTP ${response.status}`;
}

async function requestModelTextStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<StreamTextResult> {
  const startedAt = performance.now();

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          stream: true,
        }),
      },
      20000,
    );

    if (!response.ok) {
      return {
        ok: false,
        text: "",
        elapsedMs: Math.round(performance.now() - startedAt),
        error: await readStreamError(response),
      };
    }

    if (!response.body) {
      return {
        ok: false,
        text: "",
        elapsedMs: Math.round(performance.now() - startedAt),
        error: "流式响应不可用",
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let collectedText = "";
    let firstTokenMs: number | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const lines = chunk
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"));

        for (const line of lines) {
          const data = line.replace(/^data:\s*/, "");
          if (!data || data === "[DONE]") continue;

          try {
            const payload = JSON.parse(data) as unknown;
            const deltaText = extractStreamDeltaText(payload);
            if (!deltaText) continue;
            if (firstTokenMs === undefined) {
              firstTokenMs = Math.round(performance.now() - startedAt);
            }
            collectedText += deltaText;
          } catch {
            // Ignore malformed SSE events from relays and continue reading.
          }
        }
      }
    }

    const elapsedMs = Math.round(performance.now() - startedAt);
    const text = cleanMultilineText(collectedText.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim());
    if (!text) {
      return { ok: false, text: "", elapsedMs, error: "流式响应未返回可读内容" };
    }

    return {
      ok: true,
      text,
      elapsedMs,
      firstTokenMs,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      text: "",
      elapsedMs: Math.round(performance.now() - startedAt),
      error: makeErrorDetail(error),
    };
  }
}

function chooseRecommendedModel(currentModel: string, models: string[]): string {
  const normalized = models.map((item) => item.trim()).filter(Boolean);
  const current = currentModel.trim();
  if (current && normalized.includes(current)) return current;

  for (const candidate of MODEL_CANDIDATES) {
    if (normalized.includes(candidate)) return candidate;
  }

  return normalized[0] || "";
}

function extractModelsFromResponse(input: unknown): string[] {
  if (!isRecord(input) || !Array.isArray(input.data)) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of input.data) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

export async function runOpenAITest(input: OpenAIProxyTestRequest): Promise<OpenAIProxyTestResponse> {
  const baseUrl = toOpenAIBaseUrl(input.baseUrl);
  const apiKey = cleanKey(input.apiKey);
  const testedAt = new Date().toISOString();
  const prompt = "你是谁？请用一句简短中文回复，不要使用 Markdown。";

  if (!baseUrl || !apiKey) {
    return {
      ok: false,
      result: {
        status: "error",
        message: FAIL_TEXT,
        detail: "地址或 Key 为空",
        testedAt,
      },
    };
  }

  const model = input.model?.trim() || "gpt-4o-mini";
  const attempts: SourcedModelTextResult[] = [];

  const streamResponse = await requestModelTextStream(baseUrl, apiKey, model, prompt, 48);
  attempts.push({ ...streamResponse, source: "stream" });

  if (!(streamResponse.ok && !isLowSignalResponseText(streamResponse.text))) {
    const chatResponse = await requestModelText(baseUrl, apiKey, model, prompt, 48);
    attempts.push({ ...chatResponse, source: "chat" });

    const shouldTryResponses =
      !chatResponse.ok ||
      isLowSignalResponseText(chatResponse.text) ||
      shouldTryResponsesFallback(streamResponse.error || "") ||
      shouldTryResponsesFallback(chatResponse.error || "");

    if (shouldTryResponses) {
      const responsesResponse = await requestResponsesText(baseUrl, apiKey, model, prompt);
      attempts.push({ ...responsesResponse, source: "responses" });
    }
  }

  const bestResponse = pickBestTextResult(attempts);

  if (bestResponse) {
    const sourceLabel =
      bestResponse.source === "stream" ? "流式" : bestResponse.source === "responses" ? "Responses" : "普通";
    return {
      ok: true,
      result: {
        status: "success",
        message: PASS_TEXT,
        detail: bestResponse.text ? `接口连通，已收到对"你是谁"的简短回复（${sourceLabel}）` : "返回消息正常",
        responseText: bestResponse.text || undefined,
        responseSource: bestResponse.source,
        elapsedMs: bestResponse.elapsedMs,
        firstTokenMs: "firstTokenMs" in bestResponse ? bestResponse.firstTokenMs : undefined,
        testedAt,
      },
    };
  }

  const response = attempts[0];
  const elapsedMs =
    [...attempts].sort((left, right) => left.elapsedMs - right.elapsedMs)[0]?.elapsedMs ?? response?.elapsedMs;

  return {
    ok: false,
    result: {
      status: "error",
      message: FAIL_TEXT,
      detail: response?.error || uniqueStrings(attempts.map((item) => item.error || ""))[0] || "未返回消息内容",
      elapsedMs,
      testedAt,
    },
  };
}

export async function runOpenAIProbe(input: OpenAIProxyProbeRequest): Promise<OpenAIProxyProbeResponse> {
  const baseUrl = toOpenAIBaseUrl(input.baseUrl);
  const apiKey = cleanKey(input.apiKey);
  const currentModel = input.currentModel?.trim() || "";
  const testedAt = new Date().toISOString();

  if (!baseUrl || !apiKey) {
    return {
      ok: false,
      result: {
        status: "error",
        supportedModels: [],
        detail: "地址或 Key 为空，无法探测模型",
        testedAt,
      },
    };
  }

  let modelsError = "";

  try {
    const payload = await fetchJsonWithTimeout(
      `${baseUrl}/models`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      10000,
    );
    const supportedModels = extractModelsFromResponse(payload);
    if (supportedModels.length > 0) {
      return {
        ok: true,
        result: {
          status: "success",
          supportedModels,
          recommendedModel: chooseRecommendedModel(currentModel, supportedModels) || undefined,
          detail: `读取 /models 成功，共识别 ${supportedModels.length} 个模型`,
          testedAt,
        },
      };
    }
    modelsError = "/models 可达，但未返回可识别模型";
  } catch (error: unknown) {
    modelsError = makeErrorDetail(error);
  }

  const supportedModels: string[] = [];
  let fallbackError = "";

  for (const candidate of MODEL_CANDIDATES) {
    const response = await requestModelTextBestEffort(baseUrl, apiKey, candidate, "你好，请回复：ok", 12);
    if (response.ok) {
      supportedModels.push(candidate);
      continue;
    }
    if (!fallbackError && response.error) fallbackError = response.error;
  }

  if (supportedModels.length > 0) {
    return {
      ok: true,
      result: {
        status: "success",
        supportedModels,
        recommendedModel: chooseRecommendedModel(currentModel, supportedModels) || undefined,
        detail: `已通过候选模型试探识别 ${supportedModels.length} 个模型${modelsError ? `；/models：${modelsError}` : ""}`,
        testedAt,
      },
    };
  }

  return {
    ok: false,
    result: {
      status: "error",
      supportedModels: [],
      detail: modelsError ? `${modelsError}${fallbackError ? `；候选试探：${fallbackError}` : ""}` : fallbackError || "未探测到可用模型",
      testedAt,
    },
  };
}

export async function runOpenAIBenchmarkRound(
  input: OpenAIProxyBenchmarkRoundRequest,
): Promise<OpenAIProxyBenchmarkRoundResponse> {
  const baseUrl = toOpenAIBaseUrl(input.baseUrl);
  const apiKey = cleanKey(input.apiKey);
  const model = input.model.trim();

  if (!baseUrl || !apiKey) {
    return {
      ok: false,
      error: "地址或 Key 为空，无法执行模型测试",
    };
  }

  if (!model) {
    return {
      ok: false,
      error: "模型为空，无法执行模型测试",
    };
  }

  const streamedResponse = await requestModelTextStream(
    baseUrl,
    apiKey,
    model,
    "Reply with exactly OK. Do not add anything else.",
    8,
  );

  if (streamedResponse.ok) {
    return {
      ok: true,
      sample: {
        elapsedMs: streamedResponse.elapsedMs,
        firstTokenMs: streamedResponse.firstTokenMs,
      },
    };
  }

  const fallbackResponse = await requestModelTextBestEffort(
    baseUrl,
    apiKey,
    model,
    "Reply with exactly OK. Do not add anything else.",
    8,
  );

  if (fallbackResponse.ok) {
    return {
      ok: true,
      sample: {
        elapsedMs: fallbackResponse.elapsedMs,
      },
    };
  }

  return {
    ok: false,
    error: uniqueStrings([fallbackResponse.error || "", streamedResponse.error || ""])[0] || "测速失败，未返回可读内容",
  };
}

export type OpenAIProxyBaseRequest = {
  baseUrl: string;
  apiKey: string;
};

export type OpenAIProxyTestRequest = OpenAIProxyBaseRequest & {
  model?: string;
};

export type OpenAIProxyTestResponse = {
  ok: boolean;
  result: {
    status: "success" | "error";
    message: string;
    detail?: string;
    responseText?: string;
    responseSource?: "stream" | "chat" | "responses";
    elapsedMs?: number;
    firstTokenMs?: number;
    testedAt: string;
  };
};

export type OpenAIProxyProbeRequest = OpenAIProxyBaseRequest & {
  currentModel?: string;
};

export type OpenAIProxyProbeResponse = {
  ok: boolean;
  result: {
    status: "success" | "error";
    supportedModels: string[];
    recommendedModel?: string;
    detail?: string;
    testedAt: string;
  };
};

export type OpenAIProxyBenchmarkRoundRequest = OpenAIProxyBaseRequest & {
  model: string;
};

export type OpenAIProxyBenchmarkRoundResponse = {
  ok: boolean;
  sample?: {
    elapsedMs: number;
    firstTokenMs?: number;
  };
  error?: string;
};

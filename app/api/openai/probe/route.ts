import { NextRequest, NextResponse } from "next/server";

import { runOpenAIProbe } from "@/lib/openai-proxy";
import { listPreferredModels } from "@/lib/public-config-store";
import type { OpenAIProxyProbeRequest } from "@/lib/openai-proxy-types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<OpenAIProxyProbeRequest>;
    const storedPreferredModels = await listPreferredModels();
    const requestPreferredModels = Array.isArray(body.preferredModels)
      ? body.preferredModels.map((item) => String(item))
      : [];

    return NextResponse.json(
      await runOpenAIProbe({
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
        apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
        currentModel: typeof body.currentModel === "string" ? body.currentModel : "",
        preferredModels: requestPreferredModels.length > 0 ? requestPreferredModels : storedPreferredModels,
      }),
    );
  } catch {
    return NextResponse.json({ message: "请求体不是合法 JSON" }, { status: 400 });
  }
}

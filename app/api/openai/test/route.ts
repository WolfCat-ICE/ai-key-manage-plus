import { NextRequest, NextResponse } from "next/server";

import { runOpenAITest } from "@/lib/openai-proxy";
import type { OpenAIProxyTestRequest } from "@/lib/openai-proxy-types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<OpenAIProxyTestRequest>;

    return NextResponse.json(
      await runOpenAITest({
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
        apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
        model: typeof body.model === "string" ? body.model : "",
      }),
    );
  } catch {
    return NextResponse.json({ message: "请求体不是合法 JSON" }, { status: 400 });
  }
}

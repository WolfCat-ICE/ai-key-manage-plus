import { NextRequest, NextResponse } from "next/server";

import { createPublicConfig, listPublicConfigs } from "@/lib/public-config-store";
import type { PublicConfigInput } from "@/lib/public-config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ configs: await listPublicConfigs() });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<PublicConfigInput>;
    const config = await createPublicConfig({
      name: typeof body.name === "string" ? body.name : "",
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
      apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
      model: typeof body.model === "string" ? body.model : ""
    });

    return NextResponse.json({ config });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "保存公开配置失败";
    return NextResponse.json({ message }, { status: 400 });
  }
}

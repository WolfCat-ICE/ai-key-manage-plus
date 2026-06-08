import { NextRequest, NextResponse } from "next/server";

import { listPreferredModels, replacePreferredModels } from "@/lib/public-config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ models: await listPreferredModels() });
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { models?: unknown };
    const models = Array.isArray(body.models) ? body.models.map((item) => String(item)) : [];
    return NextResponse.json({ models: await replacePreferredModels(models) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "保存优先模型失败";
    return NextResponse.json({ message }, { status: 400 });
  }
}

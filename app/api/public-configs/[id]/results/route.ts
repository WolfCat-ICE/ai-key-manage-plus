import { NextRequest, NextResponse } from "next/server";

import { updatePublicConfigResults } from "@/lib/public-config-store";
import type { PublicConfigResultInput } from "@/lib/public-config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    const { id } = await Promise.resolve(context.params);
    const body = (await request.json()) as Partial<PublicConfigResultInput>;

    await updatePublicConfigResults(decodeURIComponent(id), {
      model: typeof body.model === "string" ? body.model : undefined,
      lastTest: typeof body.lastTest === "undefined" ? undefined : body.lastTest,
      probe: typeof body.probe === "undefined" ? undefined : body.probe
    });

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "保存公开配置测试数据失败";
    return NextResponse.json({ message }, { status: 400 });
  }
}

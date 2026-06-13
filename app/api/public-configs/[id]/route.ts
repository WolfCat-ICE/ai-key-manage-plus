import { NextResponse } from "next/server";

import { deletePublicConfig } from "@/lib/public-config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    const { id } = await Promise.resolve(context.params);
    const deleted = await deletePublicConfig(decodeURIComponent(id));

    if (!deleted) {
      return NextResponse.json({ message: "公开配置不存在或已删除" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "删除公开配置失败";
    return NextResponse.json({ message }, { status: 400 });
  }
}

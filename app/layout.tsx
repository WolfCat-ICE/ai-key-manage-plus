import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Key Vault",
  description: "本地管理 AI API Key 配置",
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png"
  }
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="overflow-x-hidden bg-zinc-50"
      >
        {children}
      </body>
    </html>
  );
}

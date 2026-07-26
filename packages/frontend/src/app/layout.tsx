import type { Metadata, Viewport } from "next";
import "./globals.css"
import { AppShell } from "@/components/layout/app-shell";
import { Providers } from "@/components/providers";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "DeChat | Privacy-First Realtime Chat",
  description: "Secure, pseudonymous, and fully end-to-end encrypted messaging rooms.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "DeChat",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icons/dechat_logo_192.png",
    apple: "/icons/dechat_logo_192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
        <Toaster theme="dark" position="top-center" />
      </body>
    </html>
  );
}

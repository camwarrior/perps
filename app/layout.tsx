import type { Metadata } from "next";
import localFont from "next/font/local";

import "./globals.css";

// Archivo, self-hosted with its width axis (62–125). No request to Google at build or run time.
const archivo = localFont({
  src: "../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2",
  variable: "--font-archivo",
  weight: "100 900",
  style: "normal",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

export const metadata: Metadata = {
  title: "Perps, RISEx y Txflow",
  description: "Métricas en vivo de perpetuos en RISEx y Txflow.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    noarchive: true,
    nosnippet: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      noarchive: true,
      nosnippet: true,
    },
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-CL" className={`${archivo.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}

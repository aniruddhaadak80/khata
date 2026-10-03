import { ImageResponse } from "next/og";
import { site } from "@/config/site";

export const alt = `${site.name} — ${site.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The social card is drawn, not screenshotted: the indigo cloth, the madder
 * rule and the ruled ledger margin are all CSS in this file, so the card is
 * generated at build time with no image asset and no external fetch.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#131f3f",
          backgroundImage:
            "repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 3px), repeating-linear-gradient(0deg, rgba(0,0,0,0.06) 0 1px, transparent 1px 4px)",
          padding: 72,
          fontFamily: "serif",
          color: "#f4eee0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 6, height: 46, background: "#c03f3f" }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 62, lineHeight: 1, letterSpacing: -1 }}>khata</span>
            <span style={{ fontSize: 20, letterSpacing: 6, color: "#f0cd76", fontFamily: "monospace" }}>
              HOUSEHOLD LEDGER
            </span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <span style={{ fontSize: 56, lineHeight: 1.12, maxWidth: 980 }}>
            Reads your payment messages. Settles in the fewest transfers.
          </span>
          <span style={{ fontSize: 26, color: "#7c93d6", maxWidth: 900, lineHeight: 1.35 }}>
            An open-weight NLI model runs in your own browser. Every line is sealed with SHA-384, so
            nobody has to take your word for it.
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <span style={{ fontSize: 22, fontFamily: "monospace", color: "#7c93d6" }}>
            github.com/{site.repo.owner}/{site.repo.name}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              border: "3px solid #c03f3f",
              padding: "10px 20px",
              color: "#c03f3f",
              fontSize: 22,
              fontFamily: "monospace",
              letterSpacing: 4,
              transform: "rotate(-3.5deg)",
            }}
          >
            SEALED
          </div>
        </div>
      </div>
    ),
    size,
  );
}
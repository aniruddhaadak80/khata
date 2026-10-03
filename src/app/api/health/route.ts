/**
 * `GET /api/health`
 *
 * A health check that actually checks. It opens the production persistence
 * path, runs a real query against it, and reports which adapter answered —
 * because a route that returns `{ ok: true }` without touching the database
 * proves only that the process is alive.
 */

import { NextResponse } from "next/server";
import { getRepository, resolveDatabaseUrl } from "@/lib/repository";
import { getFxSnapshot } from "@/lib/fx";
import { cloudConfig } from "@/lib/cloud-model";
import { ENGINE_VERSION } from "@/lib/engine";
import { site } from "@/config/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Probe {
  name: string;
  ok: boolean;
  detail: string;
  source?: string;
  status?: string;
  asOf?: string;
}

export async function GET() {
  const probes: Probe[] = [];

  /* Persistence ------------------------------------------------------------- */
  let adapter = "unknown";
  try {
    const repository = await getRepository();
    adapter = repository.kind;
    await repository.init();
    const result = await repository.health();
    probes.push({
      name: "persistence",
      ok: result.ok,
      detail: result.detail,
      source: adapter,
    });
  } catch (err) {
    probes.push({
      name: "persistence",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
      source: adapter,
    });
  }

  /* Production guard ------------------------------------------------------- */
  const isProduction = process.env.NODE_ENV === "production";
  const hasConnectionString = Boolean(resolveDatabaseUrl());
  probes.push({
    name: "production-store",
    ok: !isProduction || (hasConnectionString && adapter === "neon-postgres"),
    detail: isProduction
      ? hasConnectionString
        ? "A hosted connection string is configured."
        : "No DATABASE_URL, and khata refuses to fall back to an embedded database in production."
      : "Not a production runtime; the embedded adapter is allowed here.",
    source: adapter,
  });

  /* Live feed --------------------------------------------------------------- */
  try {
    const fx = await getFxSnapshot("INR");
    probes.push({
      name: "fx-feed",
      ok: fx.rates.USD !== undefined,
      detail:
        fx.status === "live"
          ? `Live European Central Bank rates via Frankfurter, ${Object.keys(fx.rates).length} currencies.`
          : fx.status === "stale"
            ? `Serving a cached rate set from ${fx.asOf} because the live fetch did not succeed.`
            : `Serving sealed sample rates from ${fx.asOf} because no live fetch has succeeded.`,
      source: fx.provider,
      status: fx.status,
      asOf: fx.asOf,
    });
  } catch (err) {
    probes.push({
      name: "fx-feed",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
    });
  }

  const ok = probes.every((p) => p.ok);

  return NextResponse.json(
    {
      ok: true,
      data: {
        status: ok ? "healthy" : "degraded",
        service: site.name,
        engine: ENGINE_VERSION,
        runtime: isProduction ? "production" : "development",
        productionStore: adapter === "neon-postgres",
        adapter,
        model: {
          id: site.model.id,
          runs: "in the visitor's browser via @huggingface/transformers",
          license: site.model.license,
        },
        /**
         * Configuration, not a live probe: health must stay green when a
         * hosted model is unreachable, because khata never needs it. The key
         * itself is never reported — only whether one exists.
         */
        cloud: {
          ...cloudConfig(),
          required: false,
          role: "optional third tier, only for directions the rules left unclear",
        },
        probes,
        checkedAt: new Date().toISOString(),
      },
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
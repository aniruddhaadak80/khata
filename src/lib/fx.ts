/**
 * Live external data: exchange rates and consumer prices.
 *
 * Two keyless sources, both allowlisted by origin, both bounded by a timeout
 * and a retry budget, both cached, and both degrading to a sealed sample rather
 * than failing the request. The payload always says which of the three states
 * it is in:
 *
 *   live     — fetched from the provider just now
 *   stale    — the fetch failed or exceeded the freshness window, and a cached
 *              live copy older than the window was served instead
 *   fallback — no live copy has ever been obtained in this process; these are
 *              the sealed sample values below, with their real as-of date
 *
 * A fallback snapshot is never presented as current. The UI reads `status` and
 * prints the as-of date next to every rate.
 */

import type { CpiPoint, CpiSnapshot, CurrencyCode, FxSnapshot, SourceStatus } from "./types";

const FRANKFURTER_ORIGIN = "https://api.frankfurter.app";
const WORLDBANK_ORIGIN = "https://api.worldbank.org";

const FX_TTL_MS = 6 * 60 * 60 * 1000; // ECB publishes once a working day.
const CPI_TTL_MS = 7 * 24 * 60 * 60 * 1000; // The indicator updates a few times a year.
const FX_STALE_MS = 5 * 24 * 60 * 60 * 1000; // After this a cache is "stale", not "live".
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_ATTEMPTS = 2;

const FX_ATTRIBUTION =
  "Exchange rates published by the European Central Bank, served by the Frankfurter API.";
const CPI_ATTRIBUTION = "Consumer price index from World Bank Open Data (indicator FP.CPI.TOTL).";

/**
 * Sealed sample rates, per 1 INR, as published for 2026-10-02.
 *
 * These are real provider values, captured once, and frozen here so a build, a
 * cold start or an outage never leaves the interface empty. They are never
 * mixed with live data and never written over user records.
 */
const SEALED_FX_RATES: Record<CurrencyCode, number> = {
  AUD: 0.01496, BRL: 0.05421, CAD: 0.01478, CHF: 0.00858, CNY: 0.06961,
  CZK: 0.22632, DKK: 0.06912, EUR: 0.00925, GBP: 0.00786, HKD: 0.08147,
  HUF: 3.4145, IDR: 186.36, ILS: 0.03182, ISK: 1.2671, JPY: 1.637,
  KRW: 13.9978, MXN: 0.19035, MYR: 0.04241, NOK: 0.10018, NZD: 0.0185,
  PHP: 0.64988, PLN: 0.04049, RON: 0.04947, SEK: 0.10442, SGD: 0.01329,
  THB: 0.34878, TRY: 0.51022, USD: 0.01038, ZAR: 0.17373,
};

/** The rate table above is expressed per 1 INR, so it converts to any base. */
const SEALED_FX_AS_OF = "2026-10-02";
const SEALED_FX_BASE = "INR";

const SEALED_CPI: Record<string, { series: CpiPoint[]; lastUpdated: string }> = {
  IN: {
    lastUpdated: "2026-07-13",
    series: [
      { year: 2025, value: 233.063 }, { year: 2024, value: 227.603 },
      { year: 2023, value: 216.862 }, { year: 2022, value: 205.266 },
      { year: 2021, value: 192.379 }, { year: 2020, value: 182.989 },
      { year: 2019, value: 171.622 }, { year: 2018, value: 165.451 },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Bounded fetch                                                               */
/* -------------------------------------------------------------------------- */

interface FetchOutcome<T> {
  ok: boolean;
  value: T | null;
  detail: string | null;
}

async function fetchJson<T>(url: string, origin: string): Promise<FetchOutcome<T>> {
  let lastDetail = "no attempt made";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // Defence in depth: the URL is built from constants and a validated
      // currency code, and this refuses anything that is not the allowlisted
      // origin.
      if (!url.startsWith(origin)) {
        return { ok: false, value: null, detail: `refused non-allowlisted origin for ${url}` };
      }
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        // Next reads `next.revalidate` to persist the response in its data
        // cache. Spread through a Record so this module also type-checks
        // (and unit-tests) outside the Next compiler.
        ...({ next: { revalidate: Math.floor(TTL_FOR_URL(url) / 1000) } } as Record<string, unknown>),
      } as RequestInit);
      if (!res.ok) {
        lastDetail = `HTTP ${res.status}`;
        continue;
      }
      const value = (await res.json()) as T;
      return { ok: true, value, detail: null };
    } catch (err) {
      lastDetail = err instanceof Error ? err.name : "unknown error";
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, value: null, detail: lastDetail };
}

function TTL_FOR_URL(url: string): number {
  return url.includes("worldbank") ? CPI_TTL_MS : FX_TTL_MS;
}

/* -------------------------------------------------------------------------- */
/* Exchange rates                                                              */
/* -------------------------------------------------------------------------- */

interface CacheEntry<T> {
  value: T;
  at: number;
}

const fxCache = new Map<string, CacheEntry<FxSnapshot>>();

/** Every currency Frankfurter knows about, from its own registry endpoint. */
let supportedPromise: Promise<CurrencyCode[]> | null = null;

export async function supportedCurrencies(): Promise<CurrencyCode[]> {
  if (!supportedPromise) {
    supportedPromise = (async () => {
      const res = await fetchJson<Record<string, string>>(`${FRANKFURTER_ORIGIN}/currencies`, FRANKFURTER_ORIGIN);
      if (res.ok && res.value) return Object.keys(res.value).sort();
      return Object.keys(SEALED_FX_RATES).sort();
    })();
  }
  return supportedPromise;
}

function sealedFx(base: CurrencyCode, fetchedAt: string): FxSnapshot {
  const basePerInr = base === SEALED_FX_BASE ? 1 : SEALED_FX_RATES[base];
  const rates: Record<CurrencyCode, number> = {};
  if (basePerInr && basePerInr > 0) {
    // rates[c] = units of c per 1 unit of `base`, from the sealed per-INR table.
    for (const [code, perInr] of Object.entries(SEALED_FX_RATES)) {
      rates[code] = perInr / basePerInr;
    }
    rates[base] = 1;
  }
  return {
    status: "fallback",
    base,
    asOf: SEALED_FX_AS_OF,
    fetchedAt,
    provider: "sealed-sample",
    providerUrl: `${FRANKFURTER_ORIGIN}`,
    attribution: `${FX_ATTRIBUTION} These are sealed sample rates from ${SEALED_FX_AS_OF}, not a live quote.`,
    rates,
    supported: Object.keys(SEALED_FX_RATES).sort(),
  };
}

/**
 * The multiplier that converts `currency` into the snapshot's base currency:
 * **units of base per one unit of `currency`**.
 *
 * The direction matters and is easy to get backwards. A snapshot with
 * `base = INR` publishes `rates.USD = 0.01038`, which reads "one INR buys
 * 0.01038 USD". To turn USD 100 into INR, that must be inverted to 96.32 INR
 * per USD. Getting this backwards makes every foreign line wrong by a factor of
 * about 9,600, which is why the inversion lives in one documented place rather
 * than being repeated at each call site.
 *
 * Returns null when the rate is genuinely unknown, so a caller refuses the
 * record instead of silently converting at 1:1.
 */
export function rateFor(snapshot: FxSnapshot, currency: CurrencyCode): number | null {
  const code = currency.toUpperCase();
  const base = snapshot.base.toUpperCase();
  if (code === base) return 1;
  const perBase = snapshot.rates[code];
  if (typeof perBase !== "number" || !Number.isFinite(perBase) || perBase <= 0) return null;
  return 1 / perBase;
}

export async function getFxSnapshot(base: CurrencyCode): Promise<FxSnapshot> {
  const baseCode = base.toUpperCase();
  const now = new Date();
  const fetchedAt = now.toISOString();
  const cached = fxCache.get(baseCode);
  if (cached && now.getTime() - cached.at < FX_TTL_MS) {
    // A cached live snapshot stays "live" only while it is inside the window.
    const age = now.getTime() - cached.at;
    if (age < FX_STALE_MS) return cached.value;
    return { ...cached.value, status: "stale" satisfies SourceStatus };
  }

  /*
   * Everything below is inside a try, because a rates page that 500s because an
   * upstream is slow is strictly worse than a rates page that says "sealed
   * sample, as of 2026-10-02". Degrading is the whole point of shipping a sealed
   * sample, so nothing in here is allowed to escape.
   */
  try {
    const res = await fetchJson<{ amount: number; base: string; date: string; rates: Record<string, number> }>(
      `${FRANKFURTER_ORIGIN}/latest?from=${baseCode}`,
      FRANKFURTER_ORIGIN,
    );

    if (res.ok && res.value && res.value.rates && res.value.date) {
      const snapshot: FxSnapshot = {
        status: "live",
        base: res.value.base.toUpperCase(),
        asOf: res.value.date,
        fetchedAt,
        provider: "European Central Bank via Frankfurter",
        providerUrl: `${FRANKFURTER_ORIGIN}/latest?from=${baseCode}`,
        attribution: FX_ATTRIBUTION,
        rates: Object.fromEntries(
          Object.entries(res.value.rates).map(([k, v]) => [k.toUpperCase(), Number(v)]),
        ),
        supported: await supportedCurrencies(),
      };
      fxCache.set(baseCode, { value: snapshot, at: now.getTime() });
      return snapshot;
    }
  } catch {
    // Fall through to the cache or the sealed sample below.
  }

  if (cached) {
    return { ...cached.value, status: "stale", fetchedAt };
  }
  return sealedFx(baseCode, fetchedAt);
}

/* -------------------------------------------------------------------------- */
/* Consumer price index                                                        */
/* -------------------------------------------------------------------------- */

const cpiCache = new Map<string, CacheEntry<CpiSnapshot>>();

export async function getCpiSnapshot(countryCode: string): Promise<CpiSnapshot> {
  const code = countryCode.toUpperCase();
  const now = new Date();
  const fetchedAt = now.toISOString();

  const cached = cpiCache.get(code);
  if (cached && now.getTime() - cached.at < CPI_TTL_MS) return cached.value;

  const url =
    `${WORLDBANK_ORIGIN}/v2/country/${code}/indicator/FP.CPI.TOTL` +
    `?format=json&per_page=8&mrnev=8`;

  // Same reasoning as the FX snapshot: an upstream hiccup degrades to sealed
  // sample or stale, and never propagates a 500 to the caller.
  try {
    const res = await fetchJson<unknown[]>(url, WORLDBANK_ORIGIN);
    if (res.ok && Array.isArray(res.value) && res.value.length >= 2) {
      const meta = res.value[0] as { lastupdated?: string } | undefined;
      const rows = res.value[1] as Array<{ date: string; value: number | null }> | undefined;
      if (Array.isArray(rows) && rows.length > 0) {
        const series = rows
          .map((r): CpiPoint => ({ year: Number.parseInt(r.date, 10), value: r.value }))
          .filter((p) => Number.isFinite(p.year))
          .sort((a, b) => b.year - a.year);
        const snapshot: CpiSnapshot = {
          status: "live",
          country: code,
          indicator: "FP.CPI.TOTL",
          indicatorName: "Consumer price index (2010 = 100)",
          lastUpdated: meta?.lastupdated ?? null,
          fetchedAt,
          provider: "World Bank Open Data",
          providerUrl: `https://data.worldbank.org/indicator/FP.CPI.TOTL?locations=${code}`,
          attribution: CPI_ATTRIBUTION,
          series,
        };
        cpiCache.set(code, { value: snapshot, at: now.getTime() });
        return snapshot;
      }
    }
  } catch {
    // Fall through to the cache or the sealed sample below.
  }

  if (cached) return { ...cached.value, status: "stale", fetchedAt };

  const sealed = SEALED_CPI[code];
  return {
    status: "fallback",
    country: code,
    indicator: "FP.CPI.TOTL",
    indicatorName: "Consumer price index (2010 = 100)",
    lastUpdated: sealed?.lastUpdated ?? null,
    fetchedAt,
    provider: sealed ? "sealed-sample" : "unavailable",
    providerUrl: `https://data.worldbank.org/indicator/FP.CPI.TOTL?locations=${code}`,
    attribution: sealed
      ? `${CPI_ATTRIBUTION} These are sealed sample values, not a live reading.`
      : `No CPI series is available for ${code} from khata.`,
    series: sealed?.series ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Derived context                                                             */
/* -------------------------------------------------------------------------- */

/** Year-on-year CPI change as a fraction, e.g. 0.0244 for +2.44%. Null when unknown. */
export function cpiYearOnYear(snapshot: CpiSnapshot): number | null {
  const sorted = [...snapshot.series].sort((a, b) => b.year - a.year);
  const latest = sorted.find((p) => p.value !== null);
  const prior = sorted.find((p) => p.value !== null && latest !== undefined && p.year === (latest?.year ?? 0) - 1);
  if (!latest?.value || !prior?.value || prior.value === 0) return null;
  return (latest.value - prior.value) / prior.value;
}

/** Test seam: drop every memo so each test starts from a sealed state. */
export function resetFeedCache(): void {
  fxCache.clear();
  cpiCache.clear();
  supportedPromise = null;
}
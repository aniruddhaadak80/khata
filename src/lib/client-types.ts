import type { CpiSnapshot, Household, LedgerEntry } from "./types";

/** Shared response shapes the client components consume. */

export interface ListEntriesResponse {
  items: LedgerEntry[];
  total: number;
  page: { limit: number; offset: number; returned: number };
  household: Household;
  nextOffset: number | null;
}

export interface EntryDetailResponse {
  entry: LedgerEntry;
  chain: {
    events: Array<{
      id: string;
      chainId: string;
      action: string;
      payload: string;
      prevSeal: string;
      seal: string;
      createdAt: string;
    }>;
    ok: boolean;
    checked: number;
    headSeal: string;
    headSealShort: string;
    firstBrokenAt: number | null;
    firstBrokenId: string | null;
    reason: string | null;
  };
  household: Household;
}

export interface SettlementResponse {
  settlement: import("./types").SettlementResult;
  fx: import("./types").FxSnapshot;
  cpi: CpiSnapshot | null;
  members: import("./types").Member[];
}

export interface RatesResponse {
  fx: import("./types").FxSnapshot;
  cpi: CpiSnapshot | null;
  baseCurrency: string;
  countryCode: string;
}

export interface VerifyResponse {
  ok: boolean;
  chains: number;
  events: number;
  truncated: boolean;
  available: number;
  ledgerSeal: string;
  ledgerSealShort: string;
  brokenChains: Array<{
    chainId: string;
    firstBrokenAt: number | null;
    firstBrokenId: string | null;
    reason: string | null;
  }>;
  heads: Array<{ chainId: string; headSeal: string; events: number }>;
  timeline: Array<{
    chainId: string;
    action: string;
    seal: string;
    sealShort: string;
    prevSealShort: string;
    createdAt: string;
  }>;
  algorithm: { seal: string; genesis: string; canonicalJson: string; order: string };
  checkedAt: string;
}
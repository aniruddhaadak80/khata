/**
 * Repository access layer.
 *
 * Two adapters behind one interface:
 *   - Neon Postgres  (production, requires DATABASE_URL)
 *   - PGlite         (zero-config local dev + tests, embedded WASM Postgres)
 *
 * Both speak the same SQL, so the schema, queries, indexes and constraints are
 * written once. PGlite is never selected in production: adapter selection
 * throws if NODE_ENV === "production" without a real DATABASE_URL, because
 * silently using an embedded database in production would lose every saved
 * ledger line on the next cold start.
 */

import { randomUUID } from "node:crypto";
import { GENESIS_SEAL, sealEvent } from "./integrity";
import { convertMinor } from "./money";
import type {
  AuditAction,
  AuditEvent,
  Category,
  CurrencyCode,
  Direction,
  EntryStatus,
  EvidenceSource,
  Household,
  LedgerEntry,
  Member,
  ParseEngine,
  ShareLink,
  SplitMode,
} from "./types";

export type SqlExecutor = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export function resolveDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim() || undefined;
}

/**
 * Postgres schema for khata tables.
 *
 * Defaults to `public`. A deployment sharing one Postgres instance with another
 * application can set `DATABASE_SCHEMA` to namespace instead of colliding. The
 * value is interpolated into DDL, so it is validated against a strict
 * identifier pattern before use.
 */
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function resolveSchema(): string {
  const raw = process.env.DATABASE_SCHEMA?.trim();
  if (!raw) return "public";
  if (!SCHEMA_PATTERN.test(raw)) {
    throw new Error(
      `DATABASE_SCHEMA must match ${SCHEMA_PATTERN} (lowercase letters, digits and underscores, not starting with a digit).`,
    );
  }
  return raw;
}

/**
 * Normalise a driver result into `{ rows }`.
 *
 * `@neondatabase/serverless` returns a plain array of row objects while the
 * pg-compatible surface returns `{ rows }`. Reading `.rows` off a bare array
 * yields undefined, which turns every SELECT into an empty result set: reads
 * look like "no data" rather than like an error, and the failure is silent.
 */
export function normalizeRows<T>(result: unknown): { rows: T[] } {
  if (Array.isArray(result)) return { rows: result as T[] };
  const rows = (result as { rows?: T[] } | null | undefined)?.rows;
  return { rows: Array.isArray(rows) ? rows : [] };
}

export interface CreateEntryRecord {
  householdId: string;
  occurredOn: string;
  direction: Direction;
  amountMinor: number;
  currency: CurrencyCode;
  fxRateToBase: number;
  amountBaseMinor: number;
  paidBy: string | null;
  category: Category;
  note: string;
  rawText: string;
  evidence: EvidenceSource;
  parseEngine: ParseEngine;
  parseConfidence: number;
  splitMode: SplitMode;
  participants: string[];
  exactShares: Record<string, number> | null;
  status: EntryStatus;
  receiptRef: string | null;
  idempotencyKey?: string | null;
}

export type UpdateEntryRecord = Partial<Omit<CreateEntryRecord, "householdId">> & {
  /**
   * The household's base currency, supplied by the service layer.
   *
   * The base amount is always derived, never accepted from a client. When it is
   * present the repository recomputes `amountBaseMinor` from the amount,
   * currency and rate, so editing an amount can never leave the book
   * disagreeing with itself.
   */
  baseCurrency?: CurrencyCode;
};

export interface ListQuery {
  limit: number;
  offset: number;
  status: EntryStatus | "all";
  direction: Direction | "all";
  category: Category | "all";
  member?: string;
  sort: "created_desc" | "created_asc" | "occurred_desc" | "occurred_asc";
}

export interface Repository {
  readonly kind: "neon-postgres" | "pglite-embedded";
  init(): Promise<void>;
  getHousehold(ownerId: string): Promise<Household | null>;
  createHousehold(ownerId: string, input: Omit<Household, "id" | "ownerId" | "createdAt" | "updatedAt">): Promise<Household>;
  updateHousehold(ownerId: string, input: Partial<Omit<Household, "id" | "ownerId" | "createdAt" | "updatedAt">>): Promise<Household | null>;
  createEntry(ownerId: string, input: CreateEntryRecord): Promise<LedgerEntry>;
  listEntries(ownerId: string, householdId: string, query: ListQuery): Promise<{ items: LedgerEntry[]; total: number }>;
  getEntry(ownerId: string, id: string): Promise<LedgerEntry | null>;
  updateEntry(ownerId: string, id: string, input: UpdateEntryRecord): Promise<LedgerEntry | null>;
  deleteEntry(ownerId: string, id: string): Promise<LedgerEntry | null>;
  findEntryByIdempotencyKey(ownerId: string, key: string): Promise<LedgerEntry | null>;
  createShareLink(ownerId: string, input: ShareLink): Promise<ShareLink>;
  getShareLink(token: string): Promise<ShareLink | null>;
  appendAudit(chainId: string, action: AuditAction, payload: unknown, ownerId: string): Promise<AuditEvent>;
  /**
   * Every read of the audit log is scoped to an owner.
   *
   * This parameter is not optional and is not a convenience. `khata` has no
   * accounts: ownership *is* the only access control there is, so an unscoped
   * `SELECT * FROM audit_events` returns the sealed history of every household
   * on the database, including their members' names and amounts in the payload
   * of each event.
   */
  listAudit(ownerId: string, chainId?: string): Promise<AuditEvent[]>;
  headSeal(ownerId: string, chainId?: string): Promise<string>;
  health(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

/**
 * Schema DDL, one statement per entry.
 *
 * Issued individually rather than as a multi-statement script because both
 * drivers use the PostgreSQL extended query protocol for `query()`, which
 * rejects more than one statement per call.
 */
function schemaStatements(schema: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${schema}.households (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      base_currency TEXT NOT NULL,
      country_code  TEXT NOT NULL,
      members       JSONB NOT NULL DEFAULT '[]'::jsonb,
      owner_id      TEXT NOT NULL,
      deleted       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_households_owner
       ON ${schema}.households (owner_id)
       WHERE deleted = FALSE`,
    // NOTE: Postgres does not allow a schema-qualified *index name*. Only the
    // target table may be qualified; an index lives in its table's schema.
    `CREATE TABLE IF NOT EXISTS ${schema}.entries (
      id               TEXT PRIMARY KEY,
      household_id     TEXT NOT NULL,
      occurred_on      TEXT NOT NULL,
      direction        TEXT NOT NULL,
      amount_minor     BIGINT NOT NULL,
      currency         TEXT NOT NULL,
      fx_rate_to_base  DOUBLE PRECISION NOT NULL DEFAULT 1,
      amount_base_minor BIGINT NOT NULL,
      paid_by          TEXT,
      category         TEXT NOT NULL DEFAULT 'other',
      note             TEXT NOT NULL DEFAULT '',
      raw_text         TEXT NOT NULL DEFAULT '',
      evidence         TEXT NOT NULL DEFAULT 'manual',
      parse_engine     TEXT NOT NULL DEFAULT 'manual',
      parse_confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
      split_mode       TEXT NOT NULL DEFAULT 'equal',
      participants     JSONB NOT NULL DEFAULT '[]'::jsonb,
      exact_shares     JSONB,
      status           TEXT NOT NULL DEFAULT 'draft',
      receipt_ref      TEXT,
      owner_id         TEXT NOT NULL,
      idempotency_key  TEXT,
      deleted          BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      CONSTRAINT entries_direction_check CHECK (direction IN ('outflow','inflow')),
      CONSTRAINT entries_status_check CHECK (status IN ('draft','confirmed','disputed')),
      CONSTRAINT entries_split_check CHECK (split_mode IN ('equal','exact')),
      CONSTRAINT entries_amount_positive CHECK (amount_minor > 0),
      CONSTRAINT entries_base_positive CHECK (amount_base_minor > 0),
      CONSTRAINT entries_engine_check CHECK (parse_engine IN ('manual','deterministic','mobilebert-mnli','ollama','agent','gemini')),
      CONSTRAINT entries_evidence_check CHECK (evidence IN ('paste','sms','forward','manual','agent')),
      CONSTRAINT entries_confidence_range CHECK (parse_confidence BETWEEN 0 AND 1)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_entries_household
       ON ${schema}.entries (household_id, occurred_on DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_entries_owner
       ON ${schema}.entries (owner_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_entries_status
       ON ${schema}.entries (household_id, status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_idem
       ON ${schema}.entries (owner_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${schema}.share_links (
      token        TEXT PRIMARY KEY,
      household_id TEXT NOT NULL,
      owner_id     TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      label        TEXT NOT NULL DEFAULT '',
      seal         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_share_owner
       ON ${schema}.share_links (owner_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${schema}.audit_events (
      seq         BIGSERIAL PRIMARY KEY,
      id          TEXT NOT NULL UNIQUE,
      chain_id    TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      action      TEXT NOT NULL,
      payload     TEXT NOT NULL,
      prev_seal   TEXT NOT NULL,
      seal        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_chain
       ON ${schema}.audit_events (chain_id, seq ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_seq
       ON ${schema}.audit_events (seq ASC)`,
  ];
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rowToHousehold(row: Record<string, unknown>): Household {
  return {
    id: str(row.id),
    name: str(row.name),
    baseCurrency: str(row.base_currency).toUpperCase(),
    countryCode: str(row.country_code).toUpperCase(),
    members: (row.members ?? []) as Member[],
    ownerId: str(row.owner_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function rowToEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    id: str(row.id),
    householdId: str(row.household_id),
    occurredOn: str(row.occurred_on),
    direction: str(row.direction) as Direction,
    amountMinor: num(row.amount_minor),
    currency: str(row.currency).toUpperCase(),
    fxRateToBase: num(row.fx_rate_to_base) || 1,
    amountBaseMinor: num(row.amount_base_minor),
    paidBy: row.paid_by === null || row.paid_by === undefined ? null : str(row.paid_by),
    category: str(row.category) as Category,
    note: str(row.note),
    rawText: str(row.raw_text),
    evidence: str(row.evidence) as EvidenceSource,
    parseEngine: str(row.parse_engine) as ParseEngine,
    parseConfidence: num(row.parse_confidence),
    splitMode: str(row.split_mode) as SplitMode,
    participants: (row.participants ?? []) as string[],
    exactShares:
      row.exact_shares === null || row.exact_shares === undefined
        ? null
        : (row.exact_shares as Record<string, number>),
    status: str(row.status) as EntryStatus,
    receiptRef: row.receipt_ref === null || row.receipt_ref === undefined ? null : str(row.receipt_ref),
    idempotencyKey:
      row.idempotency_key === null || row.idempotency_key === undefined ? null : str(row.idempotency_key),
    deleted: Boolean(row.deleted),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

const ENTRY_COLUMNS = `id, household_id, occurred_on, direction, amount_minor, currency,
  fx_rate_to_base, amount_base_minor, paid_by, category, note, raw_text, evidence,
  parse_engine, parse_confidence, split_mode, participants, exact_shares, status,
  receipt_ref, idempotency_key, deleted, created_at, updated_at`;

/**
 * The write column list, which includes `owner_id`.
 *
 * `ENTRY_COLUMNS` deliberately omits it because no read ever needs to select it
 * back — ownership is always decided by the scope, never by a row. Reusing it
 * for the INSERT would bind `owner_id` to `receipt_ref`, so the two lists are
 * kept separate and the INSERT ends at `$24` with `created_at` and `updated_at`
 * sharing one timestamp parameter.
 */
const ENTRY_INSERT_COLUMNS = `id, household_id, occurred_on, direction, amount_minor, currency,
  fx_rate_to_base, amount_base_minor, paid_by, category, note, raw_text, evidence,
  parse_engine, parse_confidence, split_mode, participants, exact_shares, status,
  receipt_ref, owner_id, idempotency_key, deleted, created_at, updated_at`;

const SORT_SQL: Record<ListQuery["sort"], string> = {
  created_desc: "created_at DESC, id DESC",
  created_asc: "created_at ASC, id ASC",
  occurred_desc: "occurred_on DESC, created_at DESC, id DESC",
  occurred_asc: "occurred_on ASC, created_at ASC, id ASC",
};

/* -------------------------------------------------------------------------- */
/* Shared implementation                                                       */
/* -------------------------------------------------------------------------- */

function makeRepository(kind: Repository["kind"], db: SqlExecutor): Repository {
  const exec = (sql: string, params?: unknown[]) => db.query(sql, params);
  const schema = resolveSchema();

  /**
   * Schema creation, once per process.
   *
   * The DDL is idempotent, which made it tempting to run on every request. That
   * was a real performance bug: fourteen `CREATE ... IF NOT EXISTS` statements
   * meant fourteen network round trips to Neon on *every* request, adding
   * seconds to every page. A cold start pays it once; after that the process
   * remembers.
   *
   * Two flags rather than one: `initialised` is the settled state, and
   * `initPromise` collapses the concurrent first requests that a serverless
   * burst produces into a single set of statements.
   */
  let initialised = false;
  let initPromise: Promise<void> | null = null;

  const repo: Repository = {
    kind,

    async init() {
      // Guarded here as well as in getRepository, so the guard holds however the
      // adapter is reached.
      if (initPromise) return initPromise;
      if (initialised) return;
      initPromise = (async () => {
        for (const statement of schemaStatements(schema)) {
          await exec(statement);
        }
        initialised = true;
      })();
      try {
        await initPromise;
      } finally {
        initPromise = null;
      }
    },

    async getHousehold(ownerId) {
      const res = await exec(
        `SELECT * FROM ${schema}.households WHERE owner_id = $1 AND deleted = FALSE LIMIT 1`,
        [ownerId],
      );
      const row = res.rows[0];
      return row ? rowToHousehold(row) : null;
    },

    async createHousehold(ownerId, input) {
      // One household per owner. A concurrent double-create loses on the unique
      // index and reads the winner's row, which is the honest outcome rather
      // than an error the caller cannot act on.
      const existing = await repo.getHousehold(ownerId);
      if (existing) return existing;
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        await exec(
          `INSERT INTO ${schema}.households (id, name, base_currency, country_code, members, owner_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)`,
          [id, input.name, input.baseCurrency.toUpperCase(), input.countryCode.toUpperCase(), JSON.stringify(input.members), ownerId, now],
        );
      } catch {
        const raced = await repo.getHousehold(ownerId);
        if (raced) return raced;
        throw new Error("Could not create the household.");
      }
      return {
        id,
        name: input.name,
        baseCurrency: input.baseCurrency.toUpperCase(),
        countryCode: input.countryCode.toUpperCase(),
        members: input.members,
        ownerId,
        createdAt: now,
        updatedAt: now,
      };
    },

    async updateHousehold(ownerId, input) {
      const current = await repo.getHousehold(ownerId);
      if (!current) return null;
      const now = new Date().toISOString();
      await exec(
        `UPDATE ${schema}.households
            SET name = $1, base_currency = $2, country_code = $3, members = $4::jsonb, updated_at = $5
          WHERE id = $6 AND owner_id = $7`,
        [
          input.name ?? current.name,
          (input.baseCurrency ?? current.baseCurrency).toUpperCase(),
          (input.countryCode ?? current.countryCode).toUpperCase(),
          JSON.stringify(input.members ?? current.members),
          now,
          current.id,
          ownerId,
        ],
      );
      return {
        ...current,
        name: input.name ?? current.name,
        baseCurrency: (input.baseCurrency ?? current.baseCurrency).toUpperCase(),
        countryCode: (input.countryCode ?? current.countryCode).toUpperCase(),
        members: input.members ?? current.members,
        updatedAt: now,
      };
    },

    async createEntry(ownerId, input) {
      if (input.idempotencyKey) {
        const found = await repo.findEntryByIdempotencyKey(ownerId, input.idempotencyKey);
        if (found) return found;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const entry: LedgerEntry = {
        id,
        householdId: input.householdId,
        occurredOn: input.occurredOn,
        direction: input.direction,
        amountMinor: input.amountMinor,
        currency: input.currency.toUpperCase(),
        fxRateToBase: input.fxRateToBase,
        amountBaseMinor: input.amountBaseMinor,
        paidBy: input.paidBy,
        category: input.category,
        note: input.note,
        rawText: input.rawText,
        evidence: input.evidence,
        parseEngine: input.parseEngine,
        parseConfidence: input.parseConfidence,
        splitMode: input.splitMode,
        participants: input.participants,
        exactShares: input.exactShares,
        status: input.status,
        receiptRef: input.receiptRef,
        idempotencyKey: input.idempotencyKey ?? null,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await exec(
          `INSERT INTO ${schema}.entries (${ENTRY_INSERT_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24,$24)`,
          [
            entry.id, entry.householdId, entry.occurredOn, entry.direction, entry.amountMinor, entry.currency,
            entry.fxRateToBase, entry.amountBaseMinor, entry.paidBy, entry.category, entry.note, entry.rawText,
            entry.evidence, entry.parseEngine, entry.parseConfidence, entry.splitMode,
            JSON.stringify(entry.participants),
            entry.exactShares ? JSON.stringify(entry.exactShares) : null,
            entry.status, entry.receiptRef, ownerId, entry.idempotencyKey, entry.deleted, now,
          ],
        );
      } catch (err) {
        if (input.idempotencyKey) {
          const raced = await repo.findEntryByIdempotencyKey(ownerId, input.idempotencyKey);
          if (raced) return raced;
        }
        throw err;
      }
      return entry;
    },

    async listEntries(ownerId, householdId, query) {
      const clauses = ["household_id = $1", "owner_id = $2", "deleted = FALSE"];
      const params: unknown[] = [householdId, ownerId];

      if (query.status !== "all") {
        params.push(query.status);
        clauses.push(`status = $${params.length}`);
      }
      if (query.direction !== "all") {
        params.push(query.direction);
        clauses.push(`direction = $${params.length}`);
      }
      if (query.category !== "all") {
        params.push(query.category);
        clauses.push(`category = $${params.length}`);
      }
      if (query.member) {
        // A member filter matches either role: they paid it, or they bear it.
        params.push(query.member);
        clauses.push(`(paid_by = $${params.length} OR participants @> $${params.length + 1}::jsonb)`);
        params.push(JSON.stringify([query.member]));
      }

      const where = clauses.join(" AND ");
      const order = SORT_SQL[query.sort];
      params.push(query.limit, query.offset);
      const rows = await exec(
        `SELECT ${ENTRY_COLUMNS} FROM ${schema}.entries
          WHERE ${where}
          ORDER BY ${order}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const count = await exec(
        `SELECT COUNT(*)::int AS total FROM ${schema}.entries WHERE ${where}`,
        params.slice(0, params.length - 2),
      );
      const totalRow = count.rows[0] as { total?: number } | undefined;
      return { items: rows.rows.map(rowToEntry), total: totalRow?.total ?? 0 };
    },

    async getEntry(ownerId, id) {
      const res = await exec(
        `SELECT ${ENTRY_COLUMNS} FROM ${schema}.entries WHERE id = $1 AND owner_id = $2 AND deleted = FALSE`,
        [id, ownerId],
      );
      const row = res.rows[0];
      return row ? rowToEntry(row) : null;
    },

    async updateEntry(ownerId, id, input) {
      const current = await repo.getEntry(ownerId, id);
      if (!current || current.deleted) return null;
      const now = new Date().toISOString();

      const next = {
        occurredOn: input.occurredOn ?? current.occurredOn,
        direction: input.direction ?? current.direction,
        amountMinor: input.amountMinor ?? current.amountMinor,
        currency: (input.currency ?? current.currency).toUpperCase(),
        fxRateToBase: input.fxRateToBase ?? current.fxRateToBase,
        paidBy: input.paidBy === undefined ? current.paidBy : input.paidBy,
        category: input.category ?? current.category,
        note: input.note ?? current.note,
        rawText: input.rawText ?? current.rawText,
        parseEngine: input.parseEngine ?? current.parseEngine,
        parseConfidence: input.parseConfidence ?? current.parseConfidence,
        splitMode: input.splitMode ?? current.splitMode,
        participants: input.participants ?? current.participants,
        exactShares: input.exactShares === undefined ? current.exactShares : input.exactShares,
        status: input.status ?? current.status,
        receiptRef: input.receiptRef === undefined ? current.receiptRef : input.receiptRef,
      };

      // The base-currency amount is derived, never typed in directly. The service
      // always supplies `baseCurrency`, and the derived amount is recomputed so
      // editing an amount can never leave the book disagreeing with itself. If
      // it is absent, the stored value is left alone rather than guessed at.
      const amountBaseMinor = input.baseCurrency
        ? convertMinor(next.amountMinor, next.currency, input.baseCurrency, next.fxRateToBase)
        : current.amountBaseMinor;

      await exec(
        `UPDATE ${schema}.entries
            SET occurred_on = $1, direction = $2, amount_minor = $3, currency = $4,
                fx_rate_to_base = $5, amount_base_minor = $6, paid_by = $7, category = $8,
                note = $9, raw_text = $10, parse_engine = $11, parse_confidence = $12,
                split_mode = $13, participants = $14::jsonb, exact_shares = $15::jsonb,
                status = $16, receipt_ref = $17, updated_at = $18
          WHERE id = $19 AND owner_id = $20`,
        [
          next.occurredOn, next.direction, next.amountMinor, next.currency, next.fxRateToBase,
          amountBaseMinor, next.paidBy, next.category, next.note, next.rawText, next.parseEngine,
          next.parseConfidence, next.splitMode, JSON.stringify(next.participants),
          next.exactShares ? JSON.stringify(next.exactShares) : null,
          next.status, next.receiptRef, now, id, ownerId,
        ],
      );

      return {
        ...current,
        ...next,
        amountBaseMinor,
        updatedAt: now,
      };
    },

    async deleteEntry(ownerId, id) {
      const current = await repo.getEntry(ownerId, id);
      if (!current || current.deleted) return null;
      const now = new Date().toISOString();
      // Soft delete: the tombstone row stays so the per-entry seal chain remains
      // replayable and a deleted line can still be shown to have existed.
      await exec(`UPDATE ${schema}.entries SET deleted = TRUE, updated_at = $1 WHERE id = $2 AND owner_id = $3`, [
        now, id, ownerId,
      ]);
      return { ...current, deleted: true, updatedAt: now };
    },

    async findEntryByIdempotencyKey(ownerId, key) {
      const res = await exec(
        `SELECT ${ENTRY_COLUMNS} FROM ${schema}.entries WHERE owner_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [ownerId, key],
      );
      const row = res.rows[0];
      return row ? rowToEntry(row) : null;
    },

    async createShareLink(ownerId, input) {
      await exec(
        `INSERT INTO ${schema}.share_links (token, household_id, owner_id, expires_at, label, seal, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [input.token, input.householdId, ownerId, input.expiresAt, input.label, input.seal, input.createdAt],
      );
      return input;
    },

    async getShareLink(token) {
      const res = await exec(`SELECT * FROM ${schema}.share_links WHERE token = $1 LIMIT 1`, [token]);
      const row = res.rows[0];
      if (!row) return null;
      return {
        token: str(row.token),
        householdId: str(row.household_id),
        ownerId: str(row.owner_id),
        expiresAt: str(row.expires_at),
        label: str(row.label),
        seal: str(row.seal),
        createdAt: str(row.created_at),
      } satisfies ShareLink;
    },

    async appendAudit(chainId, action, payload, ownerId) {
      // Per-entity chain: each ledger line's history starts from genesis and is
      // independent of every other line's. Scoped to the owner on read-back so
      // one household can never walk another's chain.
      const prevSeal = await repo.headSeal(ownerId, chainId);
      const event = sealEvent(prevSeal, {
        id: randomUUID(),
        chainId,
        action,
        payload: JSON.stringify(payload ?? null),
        prevSeal,
        createdAt: new Date().toISOString(),
      });
      await exec(
        `INSERT INTO ${schema}.audit_events (id, chain_id, owner_id, action, payload, prev_seal, seal, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [event.id, chainId, ownerId, event.action, event.payload, event.prevSeal, event.seal, event.createdAt],
      );
      return event;
    },

    async listAudit(ownerId, chainId) {
      const res = chainId
        ? await exec(
            `SELECT * FROM ${schema}.audit_events WHERE owner_id = $1 AND chain_id = $2 ORDER BY seq ASC`,
            [ownerId, chainId],
          )
        : await exec(`SELECT * FROM ${schema}.audit_events WHERE owner_id = $1 ORDER BY seq ASC`, [ownerId]);
      return res.rows.map(
        (r): AuditEvent => ({
          id: str(r.id),
          chainId: str(r.chain_id),
          action: r.action as AuditAction,
          payload: str(r.payload),
          seal: str(r.seal),
          prevSeal: str(r.prev_seal),
          createdAt: str(r.created_at),
        }),
      );
    },

    async headSeal(ownerId, chainId) {
      const res = chainId
        ? await exec(
            `SELECT seal FROM ${schema}.audit_events WHERE owner_id = $1 AND chain_id = $2 ORDER BY seq DESC LIMIT 1`,
            [ownerId, chainId],
          )
        : await exec(`SELECT seal FROM ${schema}.audit_events WHERE owner_id = $1 ORDER BY seq DESC LIMIT 1`, [
            ownerId,
          ]);
      const row = res.rows[0] as { seal?: string } | undefined;
      return row?.seal ?? GENESIS_SEAL;
    },

    async health() {
      try {
        const res = await exec(`SELECT 1 AS ok`);
        const row = res.rows[0] as { ok?: number } | undefined;
        if (row?.ok === 1) return { ok: true, detail: "SELECT 1 succeeded" };
        return { ok: false, detail: "health query returned no rows" };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : "unknown database error" };
      }
    },

    async close() {
      /* PGlite is a singleton in this process; nothing to close for Neon. */
    },
  };

  return repo;
}

/* -------------------------------------------------------------------------- */
/* Neon adapter (production)                                                  */
/* -------------------------------------------------------------------------- */

let neonRepo: Repository | null = null;

async function getNeonRepository(): Promise<Repository> {
  if (neonRepo) return neonRepo;
  const url = resolveDatabaseUrl();
  if (!url) {
    throw new Error(
      "No production database configured. Set DATABASE_URL (or POSTGRES_URL, which the Vercel/Neon integrations provide) to a hosted Postgres connection string.",
    );
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  const executor: SqlExecutor = {
    async query<T>(statement: string, params: unknown[] = []) {
      const result = (await sql.query(statement, params as never[])) as unknown;
      return normalizeRows<T>(result);
    },
  };
  neonRepo = makeRepository("neon-postgres", executor);
  return neonRepo;
}

/* -------------------------------------------------------------------------- */
/* PGlite adapter (zero-config local + tests)                                  */
/* -------------------------------------------------------------------------- */

let pgliteRepo: Repository | null = null;
let pgliteInit: Promise<Repository> | null = null;

async function getPgliteRepository(): Promise<Repository> {
  if (pgliteRepo) return pgliteRepo;
  if (pgliteInit) return pgliteInit;

  pgliteInit = (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = await PGlite.create();
    const executor: SqlExecutor = {
      async query<T>(statement: string, params: unknown[] = []) {
        const result = await client.query<T>(statement, params as never[]);
        return { rows: result.rows };
      },
    };
    pgliteRepo = makeRepository("pglite-embedded", executor);
    return pgliteRepo;
  })();

  return pgliteInit;
}

export async function getRepository(): Promise<Repository> {
  const isProduction = process.env.NODE_ENV === "production";
  const hasDatabaseUrl = Boolean(resolveDatabaseUrl());

  if (isProduction && !hasDatabaseUrl) {
    throw new Error(
      "Refusing to start in production without a database connection string. Set DATABASE_URL " +
        "(or POSTGRES_URL). khata will not fall back to an embedded database in production, because " +
        "that would silently lose every saved ledger line on the next cold start.",
    );
  }

  if (hasDatabaseUrl) return getNeonRepository();
  return getPgliteRepository();
}

export { makeRepository };
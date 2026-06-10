import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

export type PublicConfigInput = {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  createdAt?: string;
};

export type PublicConfigResultInput = {
  model?: string;
  lastTest?: unknown;
  probe?: unknown;
  benchmarks?: unknown;
};

export type PublicConfigRecord = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  createdAt: string;
  isPublic: true;
  lastTest?: unknown;
  probe?: unknown;
  benchmarks?: unknown;
  sourceMeta: {
    kind: "manual";
  };
};

export type PreferredModelRecord = {
  model: string;
  sortOrder: number;
};

export const DEFAULT_PREFERRED_MODELS = ["gpt-5.5", "claude-opus-4-7"];

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "public-configs.sqlite3");

let sqlPromise: Promise<SqlJsStatic> | null = null;
let writeQueue = Promise.resolve();

function normalizeBaseUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  if (!/^https?:\/\//i.test(cleaned)) return `https://${cleaned}`;
  return cleaned;
}

function cleanKey(raw: string): string {
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function makeClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `pub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeName(baseUrl: string): string {
  return baseUrl.trim().replace(/^https?:\/\//i, "") || "公开配置";
}

async function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file)
  });
  return sqlPromise;
}

async function openDatabase(): Promise<Database> {
  const SQL = await getSql();
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const bytes = await readFile(DB_PATH);
    return new SQL.Database(bytes);
  } catch {
    return new SQL.Database();
  }
}

function ensureSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS public_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_test_json TEXT,
      probe_json TEXT,
      benchmarks_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_public_configs_created_at
      ON public_configs(created_at DESC);

    CREATE TABLE IF NOT EXISTS preferred_models (
      model TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, "public_configs", "last_test_json", "TEXT");
  ensureColumn(db, "public_configs", "probe_json", "TEXT");
  ensureColumn(db, "public_configs", "benchmarks_json", "TEXT");

  const count = Number(db.exec("SELECT COUNT(*) FROM preferred_models")[0]?.values[0]?.[0] || 0);
  if (count === 0) {
    const now = new Date().toISOString();
    for (let index = 0; index < DEFAULT_PREFERRED_MODELS.length; index += 1) {
      db.run(
        "INSERT INTO preferred_models (model, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [DEFAULT_PREFERRED_MODELS[index], index, now, now]
      );
    }
  }
}

function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.exec(`PRAGMA table_info(${table})`)[0]?.values || [];
  const exists = columns.some((row) => String(row[1] || "") === column);
  if (!exists) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function saveDatabase(db: Database) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_PATH, Buffer.from(db.export()));
}

async function withDatabase<T>(fn: (db: Database) => T | Promise<T>, save = false): Promise<T> {
  const run = async () => {
    const db = await openDatabase();
    try {
      ensureSchema(db);
      const result = await fn(db);
      if (save) await saveDatabase(db);
      return result;
    } finally {
      db.close();
    }
  };

  if (!save) return run();

  const next = writeQueue.then(run, run);
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function parseStoredJson(value: unknown): unknown | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringifyStoredJson(value: unknown): string {
  return JSON.stringify(value);
}

function mapRow(row: unknown[]): PublicConfigRecord {
  const [id, name, baseUrl, apiKey, model, createdAt, lastTestJson, probeJson, benchmarksJson] = row;
  const lastTest = parseStoredJson(lastTestJson);
  const probe = parseStoredJson(probeJson);
  const benchmarks = parseStoredJson(benchmarksJson);

  return {
    id: String(id || ""),
    name: String(name || ""),
    baseUrl: String(baseUrl || ""),
    apiKey: String(apiKey || ""),
    model: String(model || ""),
    createdAt: String(createdAt || ""),
    isPublic: true,
    ...(lastTest ? { lastTest } : {}),
    ...(probe ? { probe } : {}),
    ...(benchmarks ? { benchmarks } : {}),
    sourceMeta: {
      kind: "manual"
    }
  };
}

export async function listPublicConfigs(): Promise<PublicConfigRecord[]> {
  return withDatabase((db) => {
    const result = db.exec(`
      SELECT id, name, base_url, api_key, model, created_at, last_test_json, probe_json, benchmarks_json
      FROM public_configs
      ORDER BY created_at DESC
    `);
    const rows = result[0]?.values || [];
    return rows.map(mapRow);
  });
}

export async function createPublicConfig(input: PublicConfigInput): Promise<PublicConfigRecord> {
  const baseUrl = normalizeBaseUrl(input.baseUrl || "");
  const apiKey = cleanKey(input.apiKey || "");
  const model = (input.model || "").trim();
  const name = (input.name || "").trim() || makeName(baseUrl);
  const id = input.id?.trim() || makeClientId();
  const createdAt = input.createdAt?.trim() || new Date().toISOString();
  const updatedAt = new Date().toISOString();

  if (!baseUrl || !apiKey) {
    throw new Error("保存并公开需要填写地址和 Key");
  }

  await withDatabase(
    (db) => {
      db.run(
        `
          INSERT INTO public_configs (id, name, base_url, api_key, model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            base_url = excluded.base_url,
            api_key = excluded.api_key,
            model = excluded.model,
            updated_at = excluded.updated_at
        `,
        [id, name, baseUrl, apiKey, model, createdAt, updatedAt]
      );
    },
    true
  );

  return {
    id,
    name,
    baseUrl,
    apiKey,
    model,
    createdAt,
    isPublic: true,
    sourceMeta: {
      kind: "manual"
    }
  };
}

export async function updatePublicConfigResults(id: string, input: PublicConfigResultInput): Promise<void> {
  const trimmedId = id.trim();
  if (!trimmedId) throw new Error("公开配置 ID 不能为空");

  const assignments: string[] = [];
  const values: string[] = [];

  if (typeof input.model === "string") {
    assignments.push("model = ?");
    values.push(input.model.trim());
  }
  if (typeof input.lastTest !== "undefined") {
    assignments.push("last_test_json = ?");
    values.push(stringifyStoredJson(input.lastTest));
  }
  if (typeof input.probe !== "undefined") {
    assignments.push("probe_json = ?");
    values.push(stringifyStoredJson(input.probe));
  }
  if (typeof input.benchmarks !== "undefined") {
    assignments.push("benchmarks_json = ?");
    values.push(stringifyStoredJson(input.benchmarks));
  }

  if (assignments.length === 0) return;

  assignments.push("updated_at = ?");
  values.push(new Date().toISOString(), trimmedId);

  await withDatabase(
    (db) => {
      db.run(
        `
          UPDATE public_configs
          SET ${assignments.join(", ")}
          WHERE id = ?
        `,
        values
      );
      if (db.getRowsModified() === 0) {
        throw new Error("公开配置不存在");
      }
    },
    true
  );
}

export async function listPreferredModels(): Promise<string[]> {
  return withDatabase((db) => {
    const result = db.exec(`
      SELECT model
      FROM preferred_models
      ORDER BY sort_order ASC, created_at ASC
    `);
    return (result[0]?.values || []).map((row) => String(row[0] || "").trim()).filter(Boolean);
  });
}

export async function replacePreferredModels(models: string[]): Promise<string[]> {
  const normalized = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  const nextModels = normalized.length > 0 ? normalized : [...DEFAULT_PREFERRED_MODELS];
  const now = new Date().toISOString();

  await withDatabase(
    (db) => {
      db.run("DELETE FROM preferred_models");
      for (let index = 0; index < nextModels.length; index += 1) {
        db.run(
          "INSERT INTO preferred_models (model, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [nextModels[index], index, now, now]
        );
      }
    },
    true
  );

  return nextModels;
}

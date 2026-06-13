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

type PublicConfigBaseRecord = PublicConfigRecord & {
  lastTestJson?: unknown;
  probeJson?: unknown;
  benchmarksJson?: unknown;
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

function ensureSchema(db: Database): boolean {
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

    CREATE TABLE IF NOT EXISTS public_config_test_results (
      config_id TEXT PRIMARY KEY,
      model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      detail TEXT,
      response_text TEXT,
      response_source TEXT,
      elapsed_ms INTEGER,
      first_token_ms INTEGER,
      tested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_public_config_test_results_tested_at
      ON public_config_test_results(tested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_public_config_test_results_status
      ON public_config_test_results(status);

    CREATE TABLE IF NOT EXISTS public_config_probe_results (
      config_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      recommended_model TEXT,
      detail TEXT,
      tested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_public_config_probe_results_tested_at
      ON public_config_probe_results(tested_at DESC);

    CREATE TABLE IF NOT EXISTS public_config_probe_models (
      config_id TEXT NOT NULL,
      model TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (config_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_public_config_probe_models_model
      ON public_config_probe_models(model);

    CREATE TABLE IF NOT EXISTS public_config_benchmarks (
      config_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      tags_json TEXT,
      detail TEXT,
      tested_at TEXT NOT NULL,
      rounds INTEGER,
      median_ms INTEGER,
      avg_ms INTEGER,
      success_rate REAL,
      stability_ms INTEGER,
      samples_ms_json TEXT,
      first_token_median_ms INTEGER,
      first_token_avg_ms INTEGER,
      first_token_samples_ms_json TEXT,
      round_details_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (config_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_public_config_benchmarks_model
      ON public_config_benchmarks(model);
    CREATE INDEX IF NOT EXISTS idx_public_config_benchmarks_tested_at
      ON public_config_benchmarks(tested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_public_config_benchmarks_median_ms
      ON public_config_benchmarks(median_ms);
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

  return migrateJsonResultsToStructuredTables(db);
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
      const shouldSaveSchemaChanges = ensureSchema(db);
      const result = await fn(db);
      if (save || shouldSaveSchemaChanges) await saveDatabase(db);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoString(value: unknown): string {
  const raw = cleanString(value);
  if (!raw) return "";
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "number" && Number.isFinite(item) ? Math.max(0, Math.round(item)) : 0))
    .filter((item) => item > 0);
}

function objectEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value
      .map((item, index): [string, unknown] | null => {
        const model = isRecord(item) ? cleanString(item.model) || cleanString(item.name) || cleanString(item.id) : "";
        return model ? [model || String(index), item] : null;
      })
      .filter((item): item is [string, unknown] => Boolean(item));
  }
  return isRecord(value) ? Object.entries(value) : [];
}

function normalizeTestResult(input: unknown) {
  if (!isRecord(input)) return null;
  const status = cleanString(input.status);
  if (status !== "success" && status !== "error") return null;
  const testedAt = isoString(input.testedAt);
  if (!testedAt) return null;

  const responseSource = cleanString(input.responseSource);
  return {
    status,
    message: cleanString(input.message) || (status === "success" ? "测试通过" : "测试失败"),
    detail: cleanString(input.detail) || undefined,
    responseText: cleanString(input.responseText) || undefined,
    responseSource:
      responseSource === "stream" || responseSource === "chat" || responseSource === "responses"
        ? responseSource
        : undefined,
    elapsedMs: finiteInteger(input.elapsedMs),
    firstTokenMs: finiteInteger(input.firstTokenMs),
    testedAt
  };
}

function normalizeProbeResult(input: unknown) {
  if (!isRecord(input)) return null;
  const status = cleanString(input.status);
  if (status !== "success" && status !== "error") return null;
  const testedAt = isoString(input.testedAt);
  if (!testedAt) return null;

  return {
    status,
    supportedModels: stringArray(input.supportedModels),
    recommendedModel: cleanString(input.recommendedModel) || undefined,
    detail: cleanString(input.detail) || undefined,
    testedAt
  };
}

function normalizeBenchmarkResult(input: unknown, modelKey: string) {
  if (!isRecord(input)) return null;
  const status = cleanString(input.status);
  if (status !== "success" && status !== "error") return null;
  const model = cleanString(input.model) || modelKey.trim();
  const testedAt = isoString(input.testedAt);
  if (!model || !testedAt) return null;

  const speed = isRecord(input.speed) ? input.speed : {};
  const tags = stringArray(input.tags);
  const samplesMs = numberArray(speed.samplesMs);
  const firstTokenSamplesMs = numberArray(speed.firstTokenSamplesMs);

  return {
    status,
    model,
    tags,
    detail: cleanString(input.detail) || undefined,
    testedAt,
    speed: {
      rounds: finiteInteger(speed.rounds),
      medianMs: finiteInteger(speed.medianMs),
      avgMs: finiteInteger(speed.avgMs),
      successRate: finiteNumber(speed.successRate),
      stabilityMs: finiteInteger(speed.stabilityMs),
      samplesMs,
      firstTokenMedianMs: finiteInteger(speed.firstTokenMedianMs),
      firstTokenAvgMs: finiteInteger(speed.firstTokenAvgMs),
      firstTokenSamplesMs,
      roundDetails: Array.isArray(speed.roundDetails) ? speed.roundDetails : []
    }
  };
}

function mapRow(row: unknown[]): PublicConfigBaseRecord {
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
    lastTestJson: lastTest,
    probeJson: probe,
    benchmarksJson: benchmarks,
    ...(lastTest ? { lastTest } : {}),
    ...(probe ? { probe } : {}),
    ...(benchmarks ? { benchmarks } : {}),
    sourceMeta: {
      kind: "manual"
    }
  };
}

function hydrateStructuredResults(db: Database, records: PublicConfigBaseRecord[]): PublicConfigRecord[] {
  if (records.length === 0) return [];

  const byId = new Map(records.map((record) => [record.id, record]));

  const testRows =
    db.exec(`
      SELECT config_id, model, status, message, detail, response_text, response_source,
             elapsed_ms, first_token_ms, tested_at
      FROM public_config_test_results
    `)[0]?.values || [];

  for (const row of testRows) {
    const [configId, model, status, message, detail, responseText, responseSource, elapsedMs, firstTokenMs, testedAt] = row;
    const record = byId.get(String(configId || ""));
    if (!record) continue;
    record.lastTest = {
      status: status === "success" ? "success" : "error",
      message: String(message || ""),
      ...(detail ? { detail: String(detail) } : {}),
      ...(responseText ? { responseText: String(responseText) } : {}),
      ...(responseSource === "stream" || responseSource === "chat" || responseSource === "responses"
        ? { responseSource }
        : {}),
      ...(typeof elapsedMs === "number" ? { elapsedMs } : {}),
      ...(typeof firstTokenMs === "number" ? { firstTokenMs } : {}),
      testedAt: String(testedAt || "")
    };
    if (!record.model && model) record.model = String(model);
  }

  const probeRows =
    db.exec(`
      SELECT config_id, status, recommended_model, detail, tested_at
      FROM public_config_probe_results
    `)[0]?.values || [];

  for (const row of probeRows) {
    const [configId, status, recommendedModel, detail, testedAt] = row;
    const record = byId.get(String(configId || ""));
    if (!record) continue;
    record.probe = {
      status: status === "success" ? "success" : "error",
      supportedModels: [],
      ...(recommendedModel ? { recommendedModel: String(recommendedModel) } : {}),
      ...(detail ? { detail: String(detail) } : {}),
      testedAt: String(testedAt || "")
    };
  }

  const probeModelRows =
    db.exec(`
      SELECT config_id, model
      FROM public_config_probe_models
      ORDER BY config_id ASC, sort_order ASC
    `)[0]?.values || [];

  for (const row of probeModelRows) {
    const [configId, model] = row;
    const record = byId.get(String(configId || ""));
    const probe = record?.probe;
    if (!isRecord(probe) || !Array.isArray(probe.supportedModels)) continue;
    probe.supportedModels.push(String(model || ""));
  }

  const benchmarkRows =
    db.exec(`
      SELECT config_id, model, status, tags_json, detail, tested_at,
             rounds, median_ms, avg_ms, success_rate, stability_ms,
             samples_ms_json, first_token_median_ms, first_token_avg_ms,
             first_token_samples_ms_json, round_details_json
      FROM public_config_benchmarks
      ORDER BY tested_at DESC
    `)[0]?.values || [];

  for (const row of benchmarkRows) {
    const [
      configId,
      model,
      status,
      tagsJson,
      detail,
      testedAt,
      rounds,
      medianMs,
      avgMs,
      successRate,
      stabilityMs,
      samplesMsJson,
      firstTokenMedianMs,
      firstTokenAvgMs,
      firstTokenSamplesMsJson,
      roundDetailsJson
    ] = row;
    const record = byId.get(String(configId || ""));
    if (!record) continue;

    const modelName = String(model || "");
    if (!modelName) continue;

    const samplesMs = parseStoredJson(samplesMsJson);
    const firstTokenSamplesMs = parseStoredJson(firstTokenSamplesMsJson);
    const roundDetails = parseStoredJson(roundDetailsJson);
    const tags = parseStoredJson(tagsJson);
    const speed = {
      ...(typeof rounds === "number" ? { rounds } : {}),
      ...(typeof medianMs === "number" ? { medianMs } : {}),
      ...(typeof avgMs === "number" ? { avgMs } : {}),
      ...(typeof successRate === "number" ? { successRate } : {}),
      ...(typeof stabilityMs === "number" ? { stabilityMs } : {}),
      ...(Array.isArray(samplesMs) ? { samplesMs } : {}),
      ...(typeof firstTokenMedianMs === "number" ? { firstTokenMedianMs } : {}),
      ...(typeof firstTokenAvgMs === "number" ? { firstTokenAvgMs } : {}),
      ...(Array.isArray(firstTokenSamplesMs) && firstTokenSamplesMs.length > 0 ? { firstTokenSamplesMs } : {}),
      ...(Array.isArray(roundDetails) && roundDetails.length > 0 ? { roundDetails } : {})
    };

    record.benchmarks = {
      ...(record.benchmarks && isRecord(record.benchmarks) ? record.benchmarks : {}),
      [modelName]: {
        status: status === "success" ? "success" : "error",
        model: modelName,
        tags: Array.isArray(tags) ? tags.map((item) => String(item)) : [],
        ...(Object.keys(speed).length > 0 ? { speed } : {}),
        ...(detail ? { detail: String(detail) } : {}),
        testedAt: String(testedAt || "")
      }
    };
  }

  return records.map((record) => {
    const cleaned = { ...record };
    delete cleaned.lastTestJson;
    delete cleaned.probeJson;
    delete cleaned.benchmarksJson;
    return cleaned;
  });
}

export async function listPublicConfigs(): Promise<PublicConfigRecord[]> {
  return withDatabase((db) => {
    const result = db.exec(`
      SELECT id, name, base_url, api_key, model, created_at, last_test_json, probe_json, benchmarks_json
      FROM public_configs
      ORDER BY created_at DESC
    `);
    const rows = result[0]?.values || [];
    return hydrateStructuredResults(db, rows.map(mapRow));
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

function saveStructuredTestResult(db: Database, configId: string, model: string, input: unknown, updatedAt: string) {
  const result = normalizeTestResult(input);
  if (!result) return;

  db.run(
    `
      INSERT INTO public_config_test_results (
        config_id, model, status, message, detail, response_text, response_source,
        elapsed_ms, first_token_ms, tested_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET
        model = excluded.model,
        status = excluded.status,
        message = excluded.message,
        detail = excluded.detail,
        response_text = excluded.response_text,
        response_source = excluded.response_source,
        elapsed_ms = excluded.elapsed_ms,
        first_token_ms = excluded.first_token_ms,
        tested_at = excluded.tested_at,
        updated_at = excluded.updated_at
    `,
    [
      configId,
      model.trim(),
      result.status,
      result.message,
      result.detail || null,
      result.responseText || null,
      result.responseSource || null,
      result.elapsedMs ?? null,
      result.firstTokenMs ?? null,
      result.testedAt,
      updatedAt
    ]
  );
}

function saveStructuredProbeResult(db: Database, configId: string, input: unknown, updatedAt: string) {
  const result = normalizeProbeResult(input);
  if (!result) return;

  db.run(
    `
      INSERT INTO public_config_probe_results (
        config_id, status, recommended_model, detail, tested_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(config_id) DO UPDATE SET
        status = excluded.status,
        recommended_model = excluded.recommended_model,
        detail = excluded.detail,
        tested_at = excluded.tested_at,
        updated_at = excluded.updated_at
    `,
    [
      configId,
      result.status,
      result.recommendedModel || null,
      result.detail || null,
      result.testedAt,
      updatedAt
    ]
  );

  db.run("DELETE FROM public_config_probe_models WHERE config_id = ?", [configId]);
  result.supportedModels.forEach((model, index) => {
    db.run(
      `
        INSERT INTO public_config_probe_models (config_id, model, sort_order, created_at)
        VALUES (?, ?, ?, ?)
      `,
      [configId, model, index, updatedAt]
    );
  });
}

function saveStructuredBenchmarkResults(db: Database, configId: string, input: unknown, updatedAt: string) {
  for (const [modelKey, value] of objectEntries(input)) {
    const result = normalizeBenchmarkResult(value, modelKey);
    if (!result) continue;

    db.run(
      `
        INSERT INTO public_config_benchmarks (
          config_id, model, status, tags_json, detail, tested_at,
          rounds, median_ms, avg_ms, success_rate, stability_ms,
          samples_ms_json, first_token_median_ms, first_token_avg_ms,
          first_token_samples_ms_json, round_details_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(config_id, model) DO UPDATE SET
          status = excluded.status,
          tags_json = excluded.tags_json,
          detail = excluded.detail,
          tested_at = excluded.tested_at,
          rounds = excluded.rounds,
          median_ms = excluded.median_ms,
          avg_ms = excluded.avg_ms,
          success_rate = excluded.success_rate,
          stability_ms = excluded.stability_ms,
          samples_ms_json = excluded.samples_ms_json,
          first_token_median_ms = excluded.first_token_median_ms,
          first_token_avg_ms = excluded.first_token_avg_ms,
          first_token_samples_ms_json = excluded.first_token_samples_ms_json,
          round_details_json = excluded.round_details_json,
          updated_at = excluded.updated_at
      `,
      [
        configId,
        result.model,
        result.status,
        stringifyStoredJson(result.tags),
        result.detail || null,
        result.testedAt,
        result.speed.rounds ?? null,
        result.speed.medianMs ?? null,
        result.speed.avgMs ?? null,
        result.speed.successRate ?? null,
        result.speed.stabilityMs ?? null,
        stringifyStoredJson(result.speed.samplesMs),
        result.speed.firstTokenMedianMs ?? null,
        result.speed.firstTokenAvgMs ?? null,
        result.speed.firstTokenSamplesMs.length > 0 ? stringifyStoredJson(result.speed.firstTokenSamplesMs) : null,
        result.speed.roundDetails.length > 0 ? stringifyStoredJson(result.speed.roundDetails) : null,
        updatedAt
      ]
    );
  }
}

function hasStructuredRows(db: Database, table: string, configId: string): boolean {
  const statement = db.prepare(`SELECT 1 FROM ${table} WHERE config_id = ? LIMIT 1`);
  try {
    statement.bind([configId]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function migrateJsonResultsToStructuredTables(db: Database): boolean {
  const rows =
    db.exec(`
      SELECT id, model, last_test_json, probe_json, benchmarks_json, updated_at
      FROM public_configs
      WHERE last_test_json IS NOT NULL
         OR probe_json IS NOT NULL
         OR benchmarks_json IS NOT NULL
    `)[0]?.values || [];

  let changed = false;

  for (const row of rows) {
    const [id, model, lastTestJson, probeJson, benchmarksJson, updatedAtValue] = row;
    const configId = String(id || "");
    if (!configId) continue;

    const updatedAt = isoString(updatedAtValue) || new Date().toISOString();
    const lastTest = parseStoredJson(lastTestJson);
    const probe = parseStoredJson(probeJson);
    const benchmarks = parseStoredJson(benchmarksJson);

    if (lastTest && !hasStructuredRows(db, "public_config_test_results", configId)) {
      saveStructuredTestResult(db, configId, String(model || ""), lastTest, updatedAt);
      changed = true;
    }
    if (probe && !hasStructuredRows(db, "public_config_probe_results", configId)) {
      saveStructuredProbeResult(db, configId, probe, updatedAt);
      changed = true;
    }
    if (benchmarks && !hasStructuredRows(db, "public_config_benchmarks", configId)) {
      saveStructuredBenchmarkResults(db, configId, benchmarks, updatedAt);
      changed = true;
    }
  }

  return changed;
}

export async function updatePublicConfigResults(id: string, input: PublicConfigResultInput): Promise<void> {
  const trimmedId = id.trim();
  if (!trimmedId) throw new Error("公开配置 ID 不能为空");

  const assignments: string[] = [];
  const values: string[] = [];
  const updatedAt = new Date().toISOString();

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
  values.push(updatedAt, trimmedId);

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

      if (typeof input.lastTest !== "undefined") {
        saveStructuredTestResult(db, trimmedId, typeof input.model === "string" ? input.model : "", input.lastTest, updatedAt);
      }
      if (typeof input.probe !== "undefined") {
        saveStructuredProbeResult(db, trimmedId, input.probe, updatedAt);
      }
      if (typeof input.benchmarks !== "undefined") {
        saveStructuredBenchmarkResults(db, trimmedId, input.benchmarks, updatedAt);
      }
    },
    true
  );
}

export async function deletePublicConfig(id: string): Promise<boolean> {
  const trimmedId = id.trim();
  if (!trimmedId) throw new Error("公开配置 ID 不能为空");

  return withDatabase(
    (db) => {
      db.run("DELETE FROM public_config_test_results WHERE config_id = ?", [trimmedId]);
      db.run("DELETE FROM public_config_probe_results WHERE config_id = ?", [trimmedId]);
      db.run("DELETE FROM public_config_probe_models WHERE config_id = ?", [trimmedId]);
      db.run("DELETE FROM public_config_benchmarks WHERE config_id = ?", [trimmedId]);
      db.run("DELETE FROM public_configs WHERE id = ?", [trimmedId]);
      return db.getRowsModified() > 0;
    },
    true
  );
}

export async function deletePublicConfigs(ids: string[]): Promise<number> {
  const normalizedIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (normalizedIds.length === 0) return 0;

  return withDatabase(
    (db) => {
      let deleted = 0;
      for (const id of normalizedIds) {
        db.run("DELETE FROM public_config_test_results WHERE config_id = ?", [id]);
        db.run("DELETE FROM public_config_probe_results WHERE config_id = ?", [id]);
        db.run("DELETE FROM public_config_probe_models WHERE config_id = ?", [id]);
        db.run("DELETE FROM public_config_benchmarks WHERE config_id = ?", [id]);
        db.run("DELETE FROM public_configs WHERE id = ?", [id]);
        deleted += db.getRowsModified();
      }
      return deleted;
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

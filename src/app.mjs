import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const MB = 1024 * 1024;
export const MAX_UPLOAD_SIZE_MB = 200;
export const MAX_UPLOAD_SIZE = MAX_UPLOAD_SIZE_MB * MB;
export const ALLOWED_EXTENSIONS = Object.freeze(["*"]);

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

export function loadConfig(env = process.env) {
  const ttlHours = Math.min(24, positiveInteger(env.FILE_TTL_HOURS, 24));
  const maxFileSizeMb = Math.min(MAX_UPLOAD_SIZE_MB, positiveInteger(env.MAX_FILE_SIZE_MB, MAX_UPLOAD_SIZE_MB));
  const maxBatchSizeMb = Math.min(MAX_UPLOAD_SIZE_MB, positiveInteger(env.MAX_BATCH_SIZE_MB, MAX_UPLOAD_SIZE_MB));
  const dailyQuotaMb = positiveInteger(env.DAILY_QUOTA_MB, 1000);
  const storageDir = path.resolve(env.STORAGE_DIR || path.join(process.cwd(), "storage"));
  const frontendOrigins = String(
    env.FRONTEND_ORIGINS ||
      "https://deuzimarsouza.github.io,http://localhost:8080,http://127.0.0.1:8080",
  )
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  return {
    port: positiveInteger(env.PORT, 3000),
    storageDir,
    sharesDir: path.join(storageDir, "shares"),
    incomingDir: path.join(storageDir, ".incoming"),
    usageFile: path.join(storageDir, "usage.json"),
    frontendOrigins,
    shareTtlMs: ttlHours * 60 * 60 * 1000,
    ttlHours,
    maxFileSize: maxFileSizeMb * MB,
    maxFileSizeMb,
    maxBatchSize: maxBatchSizeMb * MB,
    maxBatchSizeMb,
    dailyQuota: dailyQuotaMb * MB,
    dailyQuotaMb,
    maxFiles: Math.min(20, positiveInteger(env.MAX_FILES, 10)),
    cleanupIntervalMs: positiveInteger(env.CLEANUP_INTERVAL_MINUTES, 15) * 60 * 1000,
    deleteAfterDownload: booleanValue(env.DELETE_AFTER_DOWNLOAD, false),
    trustProxy: positiveInteger(env.TRUST_PROXY_HOPS, 1, 0),
    disableRateLimit: booleanValue(env.DISABLE_RATE_LIMIT, false),
  };
}

function normalizeConfig(overrides = {}) {
  const base = loadConfig();
  const config = { ...base, ...overrides };
  config.storageDir = path.resolve(config.storageDir);
  config.sharesDir = path.resolve(overrides.sharesDir || path.join(config.storageDir, "shares"));
  config.incomingDir = path.resolve(overrides.incomingDir || path.join(config.storageDir, ".incoming"));
  config.usageFile = path.resolve(overrides.usageFile || path.join(config.storageDir, "usage.json"));
  config.ttlHours = config.ttlHours || Math.max(1, Math.ceil(config.shareTtlMs / 3_600_000));
  config.maxFileSize = Math.min(MAX_UPLOAD_SIZE, positiveInteger(config.maxFileSize, base.maxFileSize));
  config.maxBatchSize = Math.min(MAX_UPLOAD_SIZE, positiveInteger(config.maxBatchSize, base.maxBatchSize));
  config.maxFileSizeMb = config.maxFileSize / MB;
  config.maxBatchSizeMb = config.maxBatchSize / MB;
  config.dailyQuotaMb = config.dailyQuotaMb || Math.ceil(config.dailyQuota / MB);
  return config;
}

export function sanitizeFilename(filename) {
  const cleaned = String(filename || "arquivo")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.\s-]+/, "")
    .trim();
  const safe = cleaned || "arquivo";
  if (safe.length <= 180) return safe;

  const lastDot = safe.lastIndexOf(".");
  const suffix = lastDot > 0 ? safe.slice(lastDot) : "";
  if (suffix.length > 1 && suffix.length <= 12) {
    return `${safe.slice(0, 180 - suffix.length)}${suffix}`;
  }
  return safe.slice(0, 180);
}

function decodeMultipartFilename(filename) {
  const original = String(filename || "");
  const decoded = Buffer.from(original, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? original : decoded;
}

export function getExtension(filename) {
  const clean = String(filename || "").trim();
  const lastDot = clean.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === clean.length - 1) return "";
  return clean.slice(lastDot + 1).toLowerCase();
}

export function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .replace(/[IO01]/g, "")
    .slice(0, 8);
}

function createShareCode() {
  let result = "";
  while (result.length < 8) {
    const bytes = crypto.randomBytes(12);
    for (const byte of bytes) {
      if (byte >= 224) continue;
      result += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (result.length === 8) break;
    }
  }
  return result;
}

function createDeleteToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function publicShare(metadata) {
  return {
    code: metadata.code,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    files: metadata.files.map((file) => ({
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      sha256: file.sha256,
      downloadCount: file.downloadCount || 0,
    })),
  };
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function shareDirectory(config, code) {
  return path.join(config.sharesDir, code);
}

function metadataPath(config, code) {
  return path.join(shareDirectory(config, code), "metadata.json");
}

async function readShare(config, rawCode, { allowExpired = false } = {}) {
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) throw apiError(400, "INVALID_CODE", "O código informado é inválido.");

  let metadata;
  try {
    metadata = await readJson(metadataPath(config, code));
  } catch (error) {
    if (error.code === "ENOENT") throw apiError(404, "SHARE_NOT_FOUND", "Esta ponte não foi encontrada.");
    throw error;
  }

  if (!metadata || metadata.code !== code || !Array.isArray(metadata.files)) {
    throw apiError(500, "INVALID_METADATA", "Os dados desta ponte estão indisponíveis.");
  }

  if (!allowExpired && Date.parse(metadata.expiresAt) <= Date.now()) {
    await rm(shareDirectory(config, code), { recursive: true, force: true });
    throw apiError(410, "SHARE_EXPIRED", "Esta ponte expirou e os arquivos foram apagados.");
  }
  return metadata;
}

async function cleanupFiles(files = []) {
  await Promise.all(
    files.filter(Boolean).map((file) => rm(file.path, { force: true }).catch(() => {})),
  );
}

let quotaQueue = Promise.resolve();
function withQuotaLock(task) {
  const running = quotaQueue.then(task, task);
  quotaQueue = running.catch(() => {});
  return running;
}

const shareQueues = new Map();
function withShareLock(code, task) {
  const previous = shareQueues.get(code) || Promise.resolve();
  const running = previous.then(task, task);
  const settled = running.finally(() => {
    if (shareQueues.get(code) === settled) shareQueues.delete(code);
  });
  shareQueues.set(code, settled);
  return running;
}

async function reserveDailyQuota(config, bytes, operation) {
  return withQuotaLock(async () => {
    const today = utcDayKey();
    let usage = { day: today, bytes: 0 };
    try {
      const stored = await readJson(config.usageFile);
      if (stored?.day === today && Number.isSafeInteger(stored.bytes) && stored.bytes >= 0) usage = stored;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (usage.bytes + bytes > config.dailyQuota) {
      throw apiError(
        429,
        "DAILY_QUOTA_EXCEEDED",
        `A cota diária de ${config.dailyQuotaMb} MB foi atingida. Tente novamente amanhã.`,
      );
    }

    const result = await operation();
    await writeJsonAtomic(config.usageFile, { day: today, bytes: usage.bytes + bytes });
    return result;
  });
}

function requestOriginAllowed(config, origin) {
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, "");
  return config.frontendOrigins.includes("*") || config.frontendOrigins.includes(normalized);
}

function createRateLimiters(config) {
  if (config.disableRateLimit) return { api: (_req, _res, next) => next(), upload: (_req, _res, next) => next() };

  const handler = (_request, response, _next, options) => {
    response.status(options.statusCode).json({
      error: { code: "RATE_LIMITED", message: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
    });
  };
  return {
    api: rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false, handler }),
    upload: rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, handler }),
  };
}

export function createApp(overrides = {}) {
  const config = normalizeConfig(overrides);
  fs.mkdirSync(config.sharesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.incomingDir, { recursive: true, mode: 0o700 });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.incomingDir,
      filename: (_request, file, callback) => {
        const extension = file.safeExtension ?? getExtension(sanitizeFilename(file.originalname));
        callback(null, `${crypto.randomUUID()}${extension ? `.${extension}` : ""}.upload`);
      },
    }),
    // O Busboy/Multer emite LIMIT_FILE_SIZE ao atingir este valor, portanto um
    // arquivo com exatamente o teto também é rejeitado e o contrato segue < teto.
    limits: { fileSize: config.maxFileSize, files: config.maxFiles, fields: 4 },
    fileFilter: (_request, file, callback) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safeName = sanitizeFilename(file.originalname);
      const extension = getExtension(safeName);
      file.safeName = safeName;
      file.safeExtension = extension;
      callback(null, true);
    },
  });

  const app = express();
  const limiters = createRateLimiters(config);
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.locals.ponteConfig = config;
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(
    cors({
      origin(origin, callback) {
        if (requestOriginAllowed(config, origin)) callback(null, true);
        else callback(apiError(403, "ORIGIN_NOT_ALLOWED", "Este site não está autorizado a usar a API."));
      },
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-Delete-Token"],
      exposedHeaders: ["Content-Length", "X-File-Sha256"],
      maxAge: 86_400,
    }),
  );
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_request, response) => {
    response.set("Cache-Control", "no-store").json({ status: "ok", service: "ponte-api" });
  });

  app.use("/api", limiters.api);

  app.get("/api/config", (_request, response) => {
    response.set("Cache-Control", "public, max-age=300").json({
      ttlHours: config.ttlHours,
      maxFileSize: config.maxFileSize,
      maxFileSizeMb: config.maxFileSizeMb,
      maxBatchSize: config.maxBatchSize,
      maxBatchSizeMb: config.maxBatchSizeMb,
      dailyQuotaMb: config.dailyQuotaMb,
      maxFiles: config.maxFiles,
      deleteAfterDownload: config.deleteAfterDownload,
      acceptsAnyFileType: true,
      allowedExtensions: ALLOWED_EXTENSIONS,
    });
  });

  app.post("/api/shares", limiters.upload, upload.array("files", config.maxFiles), async (request, response, next) => {
    const files = request.files || [];
    try {
      if (!files.length) throw apiError(400, "NO_FILES", "Selecione pelo menos um arquivo.");
      if (files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0 || file.size >= config.maxFileSize)) {
        throw apiError(
          413,
          "FILE_TOO_LARGE",
          `Cada arquivo deve ter menos de ${config.maxFileSizeMb} MB.`,
        );
      }
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > config.maxBatchSize) {
        throw apiError(
          413,
          "BATCH_TOO_LARGE",
          `O envio pode ter no máximo ${config.maxBatchSizeMb} MB no total.`,
        );
      }

      const preparedFiles = await Promise.all(
        files.map(async (file) => ({
          id: crypto.randomUUID(),
          name: file.safeName || sanitizeFilename(file.originalname),
          extension: file.safeExtension || getExtension(file.originalname),
          mime: String(file.mimetype || "application/octet-stream").toLowerCase(),
          size: file.size,
          sha256: await hashFile(file.path),
          temporaryPath: file.path,
        })),
      );

      const result = await reserveDailyQuota(config, totalSize, async () => {
        let code;
        let directory;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          code = createShareCode();
          directory = shareDirectory(config, code);
          try {
            await mkdir(directory, { mode: 0o700 });
            break;
          } catch (error) {
            if (error.code !== "EEXIST" || attempt === 11) throw error;
          }
        }

        const deleteToken = createDeleteToken();
        const now = new Date();
        const metadata = {
          version: 1,
          code,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + config.shareTtlMs).toISOString(),
          deleteTokenHash: hashToken(deleteToken),
          files: [],
        };

        try {
          for (const file of preparedFiles) {
            const storedName = `${file.id}${file.extension ? `.${file.extension}` : ""}`;
            await rename(file.temporaryPath, path.join(directory, storedName));
            metadata.files.push({
              id: file.id,
              name: file.name,
              storedName,
              mime: file.mime,
              size: file.size,
              sha256: file.sha256,
              downloadCount: 0,
            });
          }
          await writeJsonAtomic(path.join(directory, "metadata.json"), metadata);
          return { metadata, deleteToken };
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      });

      response.status(201).set("Cache-Control", "no-store").json({
        ...publicShare(result.metadata),
        deleteToken: result.deleteToken,
      });
    } catch (error) {
      await cleanupFiles(files);
      next(error);
    }
  });

  app.get("/api/shares/:code", async (request, response, next) => {
    try {
      const metadata = await readShare(config, request.params.code);
      response.set("Cache-Control", "no-store").json(publicShare(metadata));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/shares/:code/files/:fileId", async (request, response, next) => {
    try {
      const metadata = await readShare(config, request.params.code);
      const file = metadata.files.find((candidate) => candidate.id === request.params.fileId);
      if (!file) throw apiError(404, "FILE_NOT_FOUND", "Este arquivo não foi encontrado.");

      const filePath = path.join(shareDirectory(config, metadata.code), file.storedName);
      const fileInfo = await stat(filePath).catch((error) => {
        if (error.code === "ENOENT") throw apiError(404, "FILE_NOT_FOUND", "Este arquivo não está mais disponível.");
        throw error;
      });
      if (!fileInfo.isFile() || fileInfo.size !== file.size) {
        throw apiError(500, "FILE_CORRUPTED", "O arquivo armazenado está inconsistente.");
      }

      response.set({
        "Cache-Control": "private, no-store",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.size),
        "X-File-Sha256": file.sha256,
      });
      response.download(filePath, file.name, { acceptRanges: true, lastModified: false }, (error) => {
        if (error) {
          if (!response.headersSent) next(error);
          return;
        }

        void withShareLock(metadata.code, async () => {
          let current;
          try {
            current = await readShare(config, metadata.code, { allowExpired: true });
          } catch {
            return;
          }
          const currentFile = current.files.find((candidate) => candidate.id === file.id);
          if (!currentFile) return;
          currentFile.downloadCount = (currentFile.downloadCount || 0) + 1;
          if (config.deleteAfterDownload && current.files.every((candidate) => (candidate.downloadCount || 0) > 0)) {
            await rm(shareDirectory(config, metadata.code), { recursive: true, force: true });
            return;
          }
          await writeJsonAtomic(metadataPath(config, metadata.code), current);
        }).catch((error) => console.error("[ponte-api] falha ao atualizar metadados do download", error));
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/shares/:code", async (request, response, next) => {
    try {
      const metadata = await readShare(config, request.params.code, { allowExpired: true });
      const suppliedToken = String(request.get("X-Delete-Token") || "");
      const suppliedHash = Buffer.from(hashToken(suppliedToken), "hex");
      const storedHash = Buffer.from(String(metadata.deleteTokenHash || ""), "hex");
      if (!suppliedToken || suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash)) {
        throw apiError(403, "INVALID_DELETE_TOKEN", "Somente o aparelho que enviou pode apagar esta ponte.");
      }
      await rm(shareDirectory(config, metadata.code), { recursive: true, force: true });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, _response, next) => next(apiError(404, "ROUTE_NOT_FOUND", "Rota não encontrada.")));

  app.use(async (error, request, response, _next) => {
    await cleanupFiles(request.files || []);

    if (error instanceof multer.MulterError) {
      const fileTooLarge = error.code === "LIMIT_FILE_SIZE";
      const tooManyFiles = error.code === "LIMIT_FILE_COUNT";
      const tooLarge = fileTooLarge || tooManyFiles;
      response.status(tooLarge ? 413 : 400).json({
        error: {
          code: fileTooLarge ? "FILE_TOO_LARGE" : error.code,
          message:
            fileTooLarge
              ? `Cada arquivo deve ter menos de ${config.maxFileSizeMb} MB.`
              : tooManyFiles
                ? `Envie no máximo ${config.maxFiles} arquivos por vez.`
                : "O envio multipart é inválido.",
        },
      });
      return;
    }

    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error("[ponte-api]", error);
    if (response.headersSent) return;
    response.status(status).set("Cache-Control", "no-store").json({
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: status >= 500 ? "Não foi possível concluir a operação." : error.message,
      },
    });
  });

  return app;
}

export async function cleanupExpiredShares(configOverrides = {}) {
  const config = normalizeConfig(configOverrides);
  await mkdir(config.sharesDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(config.sharesDir, { withFileTypes: true });
  let removed = 0;
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory() || !CODE_PATTERN.test(entry.name)) continue;
    const directory = shareDirectory(config, entry.name);
    try {
      const metadata = await readJson(path.join(directory, "metadata.json"));
      if (Date.parse(metadata.expiresAt) <= now) {
        await rm(directory, { recursive: true, force: true });
        removed += 1;
      }
    } catch (error) {
      const directoryInfo = await stat(directory).catch(() => null);
      if (directoryInfo && now - directoryInfo.mtimeMs > config.shareTtlMs) {
        await rm(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
  }

  await mkdir(config.incomingDir, { recursive: true, mode: 0o700 });
  const incomingEntries = await readdir(config.incomingDir, { withFileTypes: true });
  const staleUploadAge = 60 * 60 * 1000;
  for (const entry of incomingEntries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(config.incomingDir, entry.name);
    const fileInfo = await stat(filePath).catch(() => null);
    if (fileInfo && now - fileInfo.mtimeMs > staleUploadAge) {
      await rm(filePath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

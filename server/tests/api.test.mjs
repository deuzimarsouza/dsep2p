import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import request from "supertest";
import { createApp, getExtension, normalizeCode, sanitizeFilename } from "../src/app.mjs";

let temporaryDirectory;
let app;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ponte-api-test-"));
  app = createApp({
    storageDir: temporaryDirectory,
    sharesDir: path.join(temporaryDirectory, "shares"),
    incomingDir: path.join(temporaryDirectory, ".incoming"),
    usageFile: path.join(temporaryDirectory, "usage.json"),
    frontendOrigins: ["https://deuzimarsouza.github.io"],
    shareTtlMs: 60_000,
    ttlHours: 1,
    maxFileSize: 1024 * 1024,
    maxFileSizeMb: 1,
    maxBatchSize: 2 * 1024 * 1024,
    maxBatchSizeMb: 2,
    dailyQuota: 4 * 1024 * 1024,
    dailyQuotaMb: 4,
    maxFiles: 3,
    disableRateLimit: true,
    trustProxy: 0,
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("cria uma ponte, consulta, baixa com hash e apaga com token", async () => {
  const source = Buffer.from("arquivo de teste da Ponte");
  const created = await request(app)
    .post("/api/shares")
    .set("Origin", "https://deuzimarsouza.github.io")
    .attach("files", source, { filename: "relatório.pdf", contentType: "application/pdf" })
    .expect(201);

  assert.match(created.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(created.body.files.length, 1);
  assert.equal(created.body.files[0].name, "relatório.pdf");
  assert.equal(created.body.files[0].sha256, crypto.createHash("sha256").update(source).digest("hex"));
  assert.equal(typeof created.body.deleteToken, "string");

  const share = await request(app).get(`/api/shares/${created.body.code}`).expect(200);
  assert.equal(share.body.deleteToken, undefined);
  assert.equal(share.body.files[0].id, created.body.files[0].id);

  const downloaded = await request(app)
    .get(`/api/shares/${created.body.code}/files/${created.body.files[0].id}`)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.deepEqual(downloaded.body, source);
  assert.equal(downloaded.headers["x-file-sha256"], created.body.files[0].sha256);
  assert.match(downloaded.headers["content-disposition"], /attachment/);

  await request(app)
    .delete(`/api/shares/${created.body.code}`)
    .set("X-Delete-Token", "incorreto")
    .expect(403);
  await request(app)
    .delete(`/api/shares/${created.body.code}`)
    .set("X-Delete-Token", created.body.deleteToken)
    .expect(204);
  await request(app).get(`/api/shares/${created.body.code}`).expect(404);
});

test("rejeita formato não permitido, origem desconhecida e cota excedida", async () => {
  await request(app)
    .post("/api/shares")
    .set("Origin", "https://deuzimarsouza.github.io")
    .attach("files", Buffer.from("MZ"), { filename: "programa.exe", contentType: "application/octet-stream" })
    .expect(400)
    .expect(({ body }) => assert.equal(body.error.code, "TYPE_NOT_ALLOWED"));

  await request(app)
    .get("/api/config")
    .set("Origin", "https://site-invalido.example")
    .expect(403);

  const quotaApp = createApp({
    storageDir: temporaryDirectory,
    sharesDir: path.join(temporaryDirectory, "quota-shares"),
    incomingDir: path.join(temporaryDirectory, "quota-incoming"),
    usageFile: path.join(temporaryDirectory, "quota-usage.json"),
    frontendOrigins: ["*"],
    maxFileSize: 1024,
    maxFileSizeMb: 1,
    maxBatchSize: 1024,
    maxBatchSizeMb: 1,
    dailyQuota: 4,
    dailyQuotaMb: 0.000004,
    maxFiles: 1,
    disableRateLimit: true,
    trustProxy: 0,
  });
  await request(quotaApp)
    .post("/api/shares")
    .attach("files", Buffer.from("cinco"), { filename: "a.pdf", contentType: "application/pdf" })
    .expect(429)
    .expect(({ body }) => assert.equal(body.error.code, "DAILY_QUOTA_EXCEEDED"));
});

test("bloqueia e remove uma ponte assim que o prazo vence", async () => {
  const expiringApp = createApp({
    storageDir: temporaryDirectory,
    sharesDir: path.join(temporaryDirectory, "expiring-shares"),
    incomingDir: path.join(temporaryDirectory, "expiring-incoming"),
    usageFile: path.join(temporaryDirectory, "expiring-usage.json"),
    frontendOrigins: ["*"],
    shareTtlMs: 10,
    ttlHours: 1,
    maxFileSize: 1024,
    maxFileSizeMb: 1,
    maxBatchSize: 1024,
    maxBatchSizeMb: 1,
    dailyQuota: 1024,
    dailyQuotaMb: 1,
    maxFiles: 1,
    disableRateLimit: true,
    trustProxy: 0,
  });
  const created = await request(expiringApp)
    .post("/api/shares")
    .attach("files", Buffer.from("pdf"), { filename: "a.pdf", contentType: "application/pdf" })
    .expect(201);

  await new Promise((resolve) => setTimeout(resolve, 25));
  await request(expiringApp)
    .get(`/api/shares/${created.body.code}`)
    .expect(410)
    .expect(({ body }) => assert.equal(body.error.code, "SHARE_EXPIRED"));
  await request(expiringApp).get(`/api/shares/${created.body.code}`).expect(404);
});

test("normaliza códigos e nomes sem permitir travessia de diretório", () => {
  assert.equal(normalizeCode("abci 0123-xyz9"), "ABC23XYZ");
  assert.equal(sanitizeFilename("../../relatório.final.PDF"), "relatório.final.PDF");
  assert.equal(getExtension("relatório.final.PDF"), "pdf");
});

import { cleanupExpiredShares, createApp, loadConfig } from "./app.mjs";

const config = loadConfig();
await cleanupExpiredShares(config);

const app = createApp(config);
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`[ponte-api] ouvindo na porta ${config.port}`);
});

const cleanupTimer = setInterval(() => {
  cleanupExpiredShares(config)
    .then((removed) => {
      if (removed) console.log(`[ponte-api] ${removed} ponte(s) expirada(s) removida(s)`);
    })
    .catch((error) => console.error("[ponte-api] falha na limpeza", error));
}, config.cleanupIntervalMs);
cleanupTimer.unref();

function shutdown(signal) {
  console.log(`[ponte-api] ${signal} recebido; encerrando`);
  clearInterval(cleanupTimer);
  server.close((error) => {
    if (error) {
      console.error("[ponte-api] erro ao encerrar", error);
      process.exitCode = 1;
    }
    process.exit();
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

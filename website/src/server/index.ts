import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  // Passkey association files for the native apps (RP ID hapi.run).
  // express.static ignores dot-directories by default.
  app.use(
    "/.well-known",
    express.static(path.join(staticPath, ".well-known"), {
      setHeaders: (res) => res.setHeader("Content-Type", "application/json"),
    })
  );

  // Docs entry points (mirrors public/_redirects).
  app.get(["/docs", "/docs/"], (_req, res) => {
    res.redirect(301, "/docs/guide/quick-start");
  });

  // Old client-side language links (/?lng=zh) now live at /zh/.
  app.get("/", (req, res, next) => {
    if (req.query.lng === "zh") return res.redirect(301, "/zh/");
    next();
  });

  // Prerendered pages: / -> index.html, /zh/ -> zh/index.html (and /zh -> /zh/),
  // docs pages via their .html files.
  app.use(express.static(staticPath, { extensions: ["html"] }));

  // Everything else is a real 404 with the prerendered not-found page.
  app.use((_req, res) => {
    res.status(404).sendFile(path.join(staticPath, "404.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);

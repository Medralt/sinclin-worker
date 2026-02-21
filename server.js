import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  return { ok: true };
});

// rota raiz opcional (ajuda a testar no navegador)
app.get("/", async () => {
  return { service: "sinclin-worker", ok: true };
});

const port = Number(process.env.PORT || 8080);
app.listen({ port, host: "0.0.0.0" });

import { autenticar, cors, db } from "../_shared/ml.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

// GET  -> { dados, versao } (dados = null se ainda não existir)
// PUT  -> { dados, versao_base }  grava só se versao_base for a versão atual (evita um aparelho apagar o outro)
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const email = await autenticar(req);
  if (!email) return json({ error: "não autorizado" }, 401);
  try {
    const { data: atual } = await db.from("bo_dados").select("dados, versao, atualizado_em, atualizado_por").eq("id", 1).maybeSingle();
    if (req.method === "GET") return json(atual ?? { dados: null, versao: 0 });
    if (req.method === "PUT") {
      const b = await req.json();
      if (!b?.dados || !Array.isArray(b.dados.produtos) || !Array.isArray(b.dados.estoque)) {
        return json({ error: "dados inválidos" }, 400);
      }
      const versaoAtual = atual?.versao ?? 0;
      if ((b.versao_base ?? 0) !== versaoAtual) {
        return json({ error: "conflito", versao: versaoAtual, atualizado_por: atual?.atualizado_por, atualizado_em: atual?.atualizado_em }, 409);
      }
      const { error } = await db.from("bo_dados").upsert({
        id: 1, dados: b.dados, versao: versaoAtual + 1, atualizado_em: new Date().toISOString(), atualizado_por: email,
      });
      if (error) throw error;
      return json({ versao: versaoAtual + 1 });
    }
    return json({ error: "método não permitido" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

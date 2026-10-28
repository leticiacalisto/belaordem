import { autenticar, cors } from "../_shared/ml.ts";

// Repassa o resumo mensal da loja para o projeto do painel UGC (DRE da empresa).
// O site só fala com esta função (exige o login do app + e-mail em bo_acesso).
// A chave que autoriza a gravação no outro projeto fica só nos segredos desta função:
//   EMPRESA_RESUMO_URL  -> https://<ref-do-painel>.supabase.co/functions/v1/receber-resumo-frente
//   EMPRESA_RESUMO_KEY  -> o mesmo valor configurado no projeto do painel
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const FRENTE = "mercado_livre";
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const CAMPOS = [
  "receita_bruta", "impostos_estimados", "custos_diretos", "despesas_proprias", "outras_receitas", "consumo_e_perdas",
  "resultado_frente", "caixa_entradas", "caixa_saidas", "saldo_conta", "transferencias_liquidas",
  "prolabore_pago", "despesas_compartilhadas_pagas", "distribuicao_lucros_paga", "das_pago",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "método não permitido" }, 405);
  const email = await autenticar(req);
  if (!email) return json({ error: "não autorizado" }, 401);

  const url = Deno.env.get("EMPRESA_RESUMO_URL");
  const chave = Deno.env.get("EMPRESA_RESUMO_KEY");
  if (!url || !chave) {
    return json({ error: "envio ao DRE da empresa ainda não configurado (faltam os segredos EMPRESA_RESUMO_URL e EMPRESA_RESUMO_KEY)" }, 503);
  }

  const b = await req.json().catch(() => null);
  if (!b || b.frente !== FRENTE || !Array.isArray(b.linhas) || !b.linhas.length || b.linhas.length > 60) {
    return json({ error: "resumo inválido" }, 400);
  }
  const linhas = [];
  for (const l of b.linhas) {
    if (!l || typeof l.mes !== "string" || !MES.test(l.mes)) return json({ error: "mês inválido" }, 400);
    const o: Record<string, unknown> = { mes: l.mes };
    for (const c of CAMPOS) {
      if (l[c] === undefined) continue;
      const v = Number(l[c]);
      if (!Number.isFinite(v) || Math.abs(v) > 1e9) return json({ error: `valor inválido em ${c}` }, 400);
      o[c] = Math.round(v * 100) / 100;
    }
    linhas.push(o);
  }

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-resumo-key": chave },
      body: JSON.stringify({ frente: FRENTE, linhas }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error ?? `o DRE da empresa respondeu ${r.status}` }, 502);
    return json({ ok: true, gravados: j.gravados ?? linhas.length });
  } catch (e) {
    console.error(e);
    return json({ error: "não consegui falar com o DRE da empresa" }, 502);
  }
});

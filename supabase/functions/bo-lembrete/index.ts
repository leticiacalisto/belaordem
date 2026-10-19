import webpush from "npm:web-push@3.6.7";
import { autenticar, cors, db } from "../_shared/ml.ts";

// Lembrete semanal de conferência de estoque: e-mail (Resend) + notificação no navegador/celular (Web Push).
// - "semanal": chamado pelo agendador (GitHub Actions, sábado de manhã). Só roda se não houve lembrete nos últimos 5 dias.
// - "vapid", "inscrever", "teste": chamados pelo site, por quem está logado.
const SITE = "https://leticiacalisto.github.io/belaordem/";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// chaves VAPID: geradas na primeira vez e guardadas na tabela bo_kv (só a função lê)
async function vapid(): Promise<{ publica: string; privada: string }> {
  const { data } = await db.from("bo_kv").select("valor").eq("chave", "vapid").maybeSingle();
  if (data?.valor) return JSON.parse(data.valor);
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publica = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const k = { publica, privada: jwk.d as string };
  const { error } = await db.from("bo_kv").upsert({ chave: "vapid", valor: JSON.stringify(k) });
  if (error) throw error;
  return k;
}

async function resumo() {
  const { data } = await db.from("bo_dados").select("dados").eq("id", 1).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const est: any[] = data?.dados?.estoque ?? [];
  const avenda = est.filter((u) => u.status === "avenda").length;
  const desde = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const { data: abertos } = await db.from("ml_orders").select("id")
    .eq("status", "paid").gte("date_created", desde).in("envio_status", ["pending", "handling", "ready_to_ship"]);
  const ids = new Set((abertos ?? []).map((o: { id: number }) => o.id));
  const separado = est.filter((u) => u.status === "vendido" && u.mlPedido && ids.has(u.mlPedido)).length;
  return { avenda, separado, fisico: avenda + separado };
}

async function destinatarios(): Promise<string[]> {
  const env = Deno.env.get("LEMBRETE_PARA");
  if (env) return env.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const { data } = await db.from("bo_acesso").select("email");
  return (data ?? []).map((x: { email: string }) => x.email);
}

async function notificar(titulo: string, corpo: string, html: string) {
  const saida: Record<string, unknown> = { emails: [], push: { enviados: 0, removidos: 0, erros: [] as string[] } };
  const chave = Deno.env.get("RESEND_API_KEY");
  const para = await destinatarios();
  for (const p of para) {
    if (!chave) { (saida.emails as string[]).push(`${p}: sem RESEND_API_KEY`); continue; }
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "content-type": "application/json" },
      body: JSON.stringify({ from: Deno.env.get("LEMBRETE_DE") ?? "Bela Ordem <onboarding@resend.dev>", to: [p], subject: titulo, html }),
    });
    (saida.emails as string[]).push(`${p}: HTTP ${resp.status}${resp.ok ? "" : " " + (await resp.text()).slice(0, 160)}`);
  }
  const push = saida.push as { enviados: number; removidos: number; erros: string[] };
  try {
    const k = await vapid();
    webpush.setVapidDetails(`mailto:${para[0] ?? "leticiaacalisto@gmail.com"}`, k.publica, k.privada);
    const { data: subs } = await db.from("bo_push").select("endpoint, assinatura");
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(s.assinatura, JSON.stringify({ titulo, corpo, url: SITE }));
        push.enviados++;
      } catch (e) {
        // deno-lint-ignore no-explicit-any
        const sc = (e as any)?.statusCode;
        if (sc === 404 || sc === 410) { await db.from("bo_push").delete().eq("endpoint", s.endpoint); push.removidos++; }
        else push.erros.push(`${sc ?? ""} ${(e as Error).message}`.slice(0, 160));
      }
    }
  } catch (e) { push.erros.push(`push: ${(e as Error).message}`.slice(0, 200)); }
  return saida;
}
const caixaEmail = (titulo: string, linhas: string) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="font-weight:500">${titulo}</h2>${linhas}<p><a href="${SITE}" style="background:#1b1b1f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Abrir a plataforma</a></p></div>`;

async function enviar(modo: "semanal" | "teste") {
  const r = await resumo();
  const titulo = modo === "teste" ? "Teste: lembrete de conferência" : "Sábado: hora de conferir o estoque";
  const corpo = `No sistema: ${r.avenda} à venda + ${r.separado} separadas = ${r.fisico} unidades físicas. Abra Estoque → Conferência de estoque.`;
  const html = caixaEmail(titulo, `<p>${modo === "teste" ? "Este é um teste. " : "Bom dia! "}Hoje é dia da conferência semanal do estoque.</p>
    <table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:4px 14px 4px 0">À venda</td><td><b>${r.avenda}</b></td></tr>
    <tr><td style="padding:4px 14px 4px 0">Separado (vendido, ainda não enviado)</td><td><b>${r.separado}</b></td></tr>
    <tr><td style="padding:4px 14px 4px 0">Físico real</td><td><b>${r.fisico}</b></td></tr></table>`);
  return { resumo: r, ...(await notificar(titulo, corpo, html)) };
}

// 11h: quantos produtos precisam sair hoje e até que horas (prazo de despacho do ML)
async function enviosDoDia() {
  const desde = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const { data } = await db.from("ml_orders").select("id, envio_limite, items, envio_status, envio_sub")
    .eq("status", "paid").gte("date_created", desde).in("envio_status", ["pending", "handling", "ready_to_ship"]);
  const saiu = ["dropped_off", "picked_up", "in_hub", "in_transit", "at_the_door"];
  // fim do dia em Brasília (UTC-3)
  const agora = new Date(Date.now() - 3 * 3_600_000), fim = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 23, 59, 59) + 3 * 3_600_000);
  // deno-lint-ignore no-explicit-any
  const hoje = (data ?? []).filter((o: any) => !saiu.includes(o.envio_sub ?? "") && (!o.envio_limite || Date.parse(o.envio_limite) <= fim.getTime()));
  // deno-lint-ignore no-explicit-any
  const un = hoje.reduce((t: number, o: any) => t + (o.items ?? []).reduce((s: number, i: any) => s + (i.qty ?? 1), 0), 0);
  // deno-lint-ignore no-explicit-any
  const lims = hoje.map((o: any) => o.envio_limite).filter(Boolean).map((x: string) => Date.parse(x)).sort((a: number, b: number) => a - b);
  const hh = lims.length ? new Date(lims[0] - 3 * 3_600_000).toISOString().slice(11, 16).replace(":00", "h").replace(":", "h") : null;
  return { pedidos: hoje.length, unidades: un, ate: hh };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action ?? "";
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const interno = !!bearer && bearer === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (action === "aviso" && interno) {     // só chamado pelo agendador do próprio sistema
      return json(await notificar(String(body.titulo ?? "Bela Ordem"), String(body.corpo ?? ""), caixaEmail(String(body.titulo ?? "Bela Ordem"), `<p>${String(body.corpo ?? "")}</p>`)));
    }
    if (action === "envios_dia") {
      const { data } = await db.from("bo_kv").select("valor").eq("chave", "ultimo_envios_dia").maybeSingle();
      const hojeBr = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
      if (data?.valor === hojeBr) return json({ pulou: "já enviado hoje" });
      const e = await enviosDoDia();
      await db.from("bo_kv").upsert({ chave: "ultimo_envios_dia", valor: hojeBr });
      if (!e.pedidos) return json({ ...e, nada: "nada para enviar hoje" });
      const titulo = `${e.unidades} ${e.unidades === 1 ? "produto" : "produtos"} para enviar hoje${e.ate ? ` até às ${e.ate}` : ""}`;
      const r = await notificar(titulo, `${e.pedidos} ${e.pedidos === 1 ? "pedido" : "pedidos"} do Mercado Livre. Abra o Início para ver a lista.`, caixaEmail(titulo, `<p>${e.pedidos} ${e.pedidos === 1 ? "pedido" : "pedidos"} do Mercado Livre esperando despacho.</p>`));
      return json({ ...e, ...r });
    }
    if (action === "semanal") {
      const { data } = await db.from("bo_kv").select("valor").eq("chave", "ultimo_lembrete").maybeSingle();
      if (data?.valor && Date.now() - Date.parse(data.valor) < 5 * 86_400_000) return json({ pulou: "já enviado nos últimos 5 dias" });
      const r = await enviar("semanal");
      await db.from("bo_kv").upsert({ chave: "ultimo_lembrete", valor: new Date().toISOString() });
      return json(r);
    }
    const email = await autenticar(req);
    if (!email) return json({ error: "não autorizado" }, 401);
    if (action === "vapid") return json({ chave: (await vapid()).publica });
    if (action === "inscrever") {
      const a = body.assinatura;
      if (!a?.endpoint) return json({ error: "assinatura inválida" }, 400);
      const { error } = await db.from("bo_push").upsert({ endpoint: a.endpoint, assinatura: a, email });
      if (error) throw error;
      return json({ ok: true });
    }
    if (action === "teste") return json(await enviar("teste"));
    return json({ error: "ação desconhecida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

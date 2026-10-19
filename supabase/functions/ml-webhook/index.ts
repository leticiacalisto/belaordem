import { db, freteDe, getAccess, linhaAnuncio, linhaPedido } from "../_shared/ml.ts";

// Notificações do Mercado Livre (tópico orders_v2). O ML não assina a chamada, então nada do corpo é confiado:
// só lemos o número do pedido e buscamos os dados na API do ML com o nosso token.
async function processar(orderId: string, userIdNotificado: string) {
  const { token, userId } = await getAccess();
  if (String(userIdNotificado) !== String(userId)) return;
  const r = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`ML order ${orderId}: ${r.status}`);
  const o = await r.json();
  if (String(o.seller?.id) !== String(userId)) return;
  const linha = linhaPedido(o);
  const { error } = await db.from("ml_orders").upsert(linha);
  if (error) throw error;
  if (linha.shipping_id) {
    try { await db.from("ml_orders").update(await freteDe(token, linha.shipping_id)).eq("id", linha.id); }
    catch (e) { console.error("frete", e); }
  }
}

// Tópico shipments: o envio mudou de situação (pronto, coletado, enviado, entregue...). Acha o pedido pelo shipping_id e atualiza.
async function processarEnvio(shippingId: string, userIdNotificado: string) {
  const { token, userId } = await getAccess();
  if (String(userIdNotificado) !== String(userId)) return;
  const { data: ped, error } = await db.from("ml_orders").select("id").eq("shipping_id", Number(shippingId));
  if (error) throw error;
  if (!(ped ?? []).length) return;     // envio de um pedido que ainda não chegou: o orders_v2 cuida disso
  const dados = await freteDe(token, Number(shippingId));
  for (const o of ped!) await db.from("ml_orders").update(dados).eq("id", o.id);
}

// Tópico items: o anúncio mudou no ML (preço, estoque, status). Só atualiza os que já conhecemos.
async function processarAnuncio(itemId: string, userIdNotificado: string) {
  const { token, userId } = await getAccess();
  if (String(userIdNotificado) !== String(userId)) return;
  const { data: ja } = await db.from("ml_anuncios").select("item_id").eq("item_id", itemId).maybeSingle();
  const linha = await linhaAnuncio(token, itemId);
  if (!ja && linha.status !== "active" && linha.status !== "paused") return;
  const { error } = await db.from("ml_anuncios").upsert(linha);
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  let b: any = null;
  try { b = await req.json(); } catch { return new Response("ok"); }
  const m = /^\/orders\/(\d+)$/.exec(String(b?.resource ?? ""));
  if (m && b?.topic === "orders_v2") {
    // o ML exige resposta rápida: responde já e termina o trabalho em segundo plano
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(processar(m[1], String(b.user_id)).catch((e) => console.error(e)));
  }
  const e = /^\/shipments\/(\d+)$/.exec(String(b?.resource ?? ""));
  if (e && b?.topic === "shipments") {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(processarEnvio(e[1], String(b.user_id)).catch((x) => console.error(x)));
  }
  const it = /^\/items\/(MLB\d+)$/.exec(String(b?.resource ?? ""));
  if (it && b?.topic === "items") {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(processarAnuncio(it[1], String(b.user_id)).catch((x) => console.error(x)));
  }
  return new Response("ok");
});

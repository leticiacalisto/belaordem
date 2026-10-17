import { db, freteDe, getAccess, linhaPedido } from "../_shared/ml.ts";

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
  return new Response("ok");
});

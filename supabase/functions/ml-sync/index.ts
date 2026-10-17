import { autenticar, cors, db, getAccess, urlConectar } from "../_shared/ml.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

// Busca pedidos entre "from" e "to" (ISO). Pedidos com mais de ~1 ano ficam em /orders/search/archived.
async function sync(from: string, to: string, arquivados = false) {
  const { token, userId } = await getAccess();
  let offset = 0, total = 0;
  while (true) {
    const u = new URL(`https://api.mercadolibre.com/orders/search${arquivados ? "/archived" : ""}`);
    u.searchParams.set("seller", String(userId));
    u.searchParams.set("order.date_created.from", from);
    u.searchParams.set("order.date_created.to", to);
    u.searchParams.set("sort", "date_desc");
    u.searchParams.set("limit", "50");
    u.searchParams.set("offset", String(offset));
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok) throw new Error(`ML orders: ${r.status} ${j.message ?? ""}`);
    const rows = (j.results ?? []).map((o: any) => ({
      id: o.id,
      date_created: o.date_created,
      status: o.status,
      total_amount: o.total_amount,
      paid_amount: o.paid_amount,
      sale_fee: (o.order_items ?? []).reduce(
        (s: number, i: any) => s + (i.sale_fee ?? 0) * i.quantity, 0),
      shipping_id: o.shipping?.id ?? null,
      buyer_nickname: o.buyer?.nickname ?? null,
      pack_id: o.pack_id ?? null,
      date_closed: o.date_closed ?? null,
      // pagamentos: valor, tarifa do ML (marketplace_fee), frete que o comprador pagou e impostos
      pagamentos: (o.payments ?? []).map((p: any) => ({
        id: p.id, status: p.status, metodo: p.payment_method_id, parcelas: p.installments,
        valor: p.transaction_amount, total_pago: p.total_paid_amount, tarifa: p.marketplace_fee,
        frete_comprador: p.shipping_cost, impostos: p.taxes_amount, aprovado_em: p.date_approved,
      })),
      frete_comprador: (o.payments ?? []).reduce((t: number, p: any) => t + (p.shipping_cost ?? 0), 0),
      items: (o.order_items ?? []).map((i: any) => ({
        item_id: i.item?.id,
        title: i.item?.title,
        sku: i.item?.seller_sku ?? i.item?.seller_custom_field ?? null,
        qty: i.quantity,
        unit_price: i.unit_price,
        sale_fee: i.sale_fee,
      })),
      synced_at: new Date().toISOString(),
    }));
    if (rows.length) {
      const { error } = await db.from("ml_orders").upsert(rows);
      if (error) throw error;
    }
    total += rows.length;
    offset += 50;
    if (offset >= (j.paging?.total ?? 0) || !rows.length) break;
  }
  return total;
}

// Custo de frete que o VENDEDOR paga por envio (/shipments/{id}/costs) e o status/tipo do envio.
// Em lotes pequenos para caber no tempo da função; o site chama de novo até não restar nada.
async function fretes(limite: number) {
  const { token } = await getAccess();
  const { data: pend, error } = await db.from("ml_orders").select("id, shipping_id")
    .is("frete_em", null).not("shipping_id", "is", null)
    .order("date_created", { ascending: false }).limit(limite);
  if (error) throw error;
  let feitos = 0;
  const erros: string[] = [];
  const h = { Authorization: `Bearer ${token}`, "x-format-new": "true" };
  for (let i = 0; i < (pend ?? []).length; i += 5) {
    await Promise.all((pend ?? []).slice(i, i + 5).map(async (o: any) => {
      try {
        const [c, e] = await Promise.all([
          fetch(`https://api.mercadolibre.com/shipments/${o.shipping_id}/costs`, { headers: h }),
          fetch(`https://api.mercadolibre.com/shipments/${o.shipping_id}`, { headers: h }),
        ]);
        const semEnvio = c.status === 404 && e.status === 404;       // pedido sem envio (retirada, cancelado cedo)
        if (!semEnvio && !c.ok && !e.ok) throw new Error(`HTTP ${c.status}/${e.status}`);
        const cj = c.ok ? await c.json() : null, ej = e.ok ? await e.json() : null;
        const custo = cj?.senders?.[0]?.cost ?? null;
        const { error: err } = await db.from("ml_orders").update({
          frete_vendedor: custo,
          envio_status: ej?.status ?? null,
          envio_tipo: ej?.logistic_type ?? ej?.logistic?.type ?? null,
          frete_em: new Date().toISOString(),
        }).eq("id", o.id);
        if (err) throw err;
        feitos++;
      } catch (ex) { erros.push(`${o.id}: ${(ex as Error).message}`); }
    }));
  }
  const { count } = await db.from("ml_orders").select("id", { count: "exact", head: true })
    .is("frete_em", null).not("shipping_id", "is", null);
  return { feitos, restantes: count ?? 0, erros: erros.slice(0, 3) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!(await autenticar(req))) return json({ error: "não autorizado" }, 401);
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action ?? "list";
    if (action === "conectar") return json({ url: await urlConectar() });
    if (action === "status") {
      const { data } = await db.from("ml_tokens")
        .select("ml_user_id, expires_at, updated_at").eq("id", 1).maybeSingle();
      return json({ connected: !!data, ...data });
    }
    if (action === "sync") {
      const ate = body.ate ?? new Date().toISOString();
      const desde = body.desde ?? new Date(Date.now() - Math.min(Number(body.days) || 60, 365) * 86_400_000).toISOString();
      const arq = Date.parse(desde) < Date.now() - 330 * 86_400_000;   // janela antiga: tenta também os arquivados
      let n = await sync(desde, ate);
      if (arq) { try { n += await sync(desde, ate, true); } catch (_) { /* conta sem arquivados */ } }
      return json({ synced: n });
    }
    if (action === "fretes") return json(await fretes(Math.min(Number(body.limite) || 60, 100)));
    if (action === "list") {
      const off = Number(body.offset) || 0, lim = Math.min(Number(body.limit) || 1000, 1000);
      const { data, error } = await db.from("ml_orders").select("*")
        .order("date_created", { ascending: false }).range(off, off + lim - 1);
      if (error) throw error;
      return json({ orders: data });
    }
    return json({ error: "ação desconhecida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

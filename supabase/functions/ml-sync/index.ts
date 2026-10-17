import { autenticar, cors, db, freteDe, getAccess, linhaPedido, urlConectar } from "../_shared/ml.ts";

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
    const rows = (j.results ?? []).map(linhaPedido);
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

// Custo de frete que o VENDEDOR paga por envio e o status/tipo do envio.
// Em lotes pequenos para caber no tempo da função; o site chama de novo até não restar nada.
async function fretes(limite: number) {
  const { token } = await getAccess();
  const { data: pend, error } = await db.from("ml_orders").select("id, shipping_id")
    .is("frete_em", null).not("shipping_id", "is", null)
    .order("date_created", { ascending: false }).limit(limite);
  if (error) throw error;
  let feitos = 0;
  const erros: string[] = [];
  for (let i = 0; i < (pend ?? []).length; i += 5) {
    await Promise.all((pend ?? []).slice(i, i + 5).map(async (o: any) => {
      try {
        const { error: err } = await db.from("ml_orders").update(await freteDe(token, o.shipping_id)).eq("id", o.id);
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

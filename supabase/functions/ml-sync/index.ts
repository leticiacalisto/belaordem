import { cors, db, getAccess } from "../_shared/ml.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

async function sync(days: number) {
  const { token, userId } = await getAccess();
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  let offset = 0, total = 0;
  while (true) {
    const u = new URL("https://api.mercadolibre.com/orders/search");
    u.searchParams.set("seller", String(userId));
    u.searchParams.set("order.date_created.from", from);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.headers.get("x-bo-key") !== Deno.env.get("BO_KEY")) {
    return json({ error: "não autorizado" }, 401);
  }
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action ?? "list";
    if (action === "status") {
      const { data } = await db.from("ml_tokens")
        .select("ml_user_id, expires_at, updated_at").eq("id", 1).maybeSingle();
      return json({ connected: !!data, ...data });
    }
    if (action === "sync") {
      return json({ synced: await sync(Math.min(Number(body.days) || 60, 365)) });
    }
    if (action === "list") {
      const { data, error } = await db.from("ml_orders").select("*")
        .order("date_created", { ascending: false }).limit(Number(body.limit) || 500);
      if (error) throw error;
      return json({ orders: data });
    }
    return json({ error: "ação desconhecida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

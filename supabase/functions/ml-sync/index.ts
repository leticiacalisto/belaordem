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

// ---- Teste de publicidade (Product Ads) e faturamento: guarda as respostas reais do ML em ml_ads_raw para ajustarmos o painel
async function adsTeste() {
  const { token } = await getAccess();
  const passos: string[] = [];
  const reg = async (tipo: string, url: string, h: Record<string, string>) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...h } });
    const t = await r.text();
    let j: any = null;
    try { j = JSON.parse(t); } catch { /* não é JSON */ }
    await db.from("ml_ads_raw").insert({ tipo, url: url.replace(/access_token=[^&]+/, ""), status: r.status, corpo: j ?? { texto: t.slice(0, 2000) } });
    passos.push(`${tipo}: HTTP ${r.status}`);
    return { r, j };
  };
  const hoje = new Date(), ini = new Date(Date.now() - 14 * 86_400_000);
  const d2 = hoje.toISOString().slice(0, 10), d1 = ini.toISOString().slice(0, 10);

  // 1) anunciantes (precisa de Product Ads ativo na conta)
  const a = await reg("anunciantes", "https://api.mercadolibre.com/advertising/advertisers?product_id=PADS", { "Api-Version": "1" });
  const lista = a.j?.advertisers ?? a.j?.results ?? (Array.isArray(a.j) ? a.j : []);
  const adv = lista[0];
  const id = adv?.advertiser_id ?? adv?.id, site = adv?.site_id ?? "MLB";
  if (id) {
    const q = (m: string) => `date_from=${d1}&date_to=${d2}&metrics=${m}&aggregation_type=DAILY&limit=10`;
    for (const m of ["clicks,prints,cost,cpc,acos,total_amount,units_quantity", "clicks,prints,cost"]) {
      const u1 = await reg("campanhas_search", `https://api.mercadolibre.com/advertising/${site}/advertisers/${id}/product_ads/campaigns/search?${q(m)}`, { "api-version": "2" });
      if (u1.r.ok) break;
      const u2 = await reg("campanhas", `https://api.mercadolibre.com/advertising/advertisers/${id}/product_ads/campaigns?${q(m)}`, { "api-version": "2" });
      if (u2.r.ok) break;
    }
  }
  // 2) faturamento mensal (cobranças e créditos do ML), para achar a linha de publicidade
  const per = await reg("faturamento_periodos", "https://api.mercadolibre.com/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=6", {});
  const chave = per.j?.results?.[0]?.key ?? per.j?.periods?.[0]?.key ?? per.j?.[0]?.key;
  if (chave) await reg("faturamento_detalhes", `https://api.mercadolibre.com/billing/integration/periods/key/${chave}/group/ML/details?document_type=BILL&limit=150`, {});
  return { passos, anunciantes: lista.length, advertiser: id ?? null };
}

// ---- Publicidade (Product Ads): custo, cliques, impressões e vendas atribuídas, por dia
async function adsSync(desde: string, ate: string) {
  const { token } = await getAccess();
  const a = await fetch("https://api.mercadolibre.com/advertising/advertisers?product_id=PADS", { headers: { Authorization: `Bearer ${token}`, "Api-Version": "1" } });
  const aj = await a.json().catch(() => ({}));
  const adv = aj?.advertisers?.[0];
  if (!a.ok || !adv) throw new Error(`Product Ads: ${a.status} ${aj?.message ?? "conta sem anunciante"}`);
  let total = 0;
  const fimTotal = new Date(ate + "T00:00:00Z").getTime();
  for (let ini = new Date(desde + "T00:00:00Z").getTime(); ini <= fimTotal;) {
    const fim = Math.min(ini + 59 * 86_400_000, fimTotal);
    const d1 = new Date(ini).toISOString().slice(0, 10), d2 = new Date(fim).toISOString().slice(0, 10);
    const u = `https://api.mercadolibre.com/advertising/${adv.site_id}/advertisers/${adv.advertiser_id}/product_ads/campaigns/search?date_from=${d1}&date_to=${d2}&metrics=clicks,prints,cost,cpc,acos,total_amount,units_quantity,direct_amount,indirect_amount&aggregation_type=DAILY`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, "api-version": "2" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Product Ads ${d1}: ${r.status} ${j?.message ?? ""}`);
    const rows = (j.results ?? []).filter((x: any) => x.date).map((x: any) => ({
      dia: x.date, custo: x.cost ?? 0, cliques: x.clicks ?? 0, impressoes: x.prints ?? 0, vendas: x.total_amount ?? 0,
      unidades: x.units_quantity ?? 0, direto: x.direct_amount ?? 0, indireto: x.indirect_amount ?? 0,
    }));
    if (rows.length) { const { error } = await db.from("ml_ads_dia").upsert(rows); if (error) throw error; }
    total += rows.length;
    ini = fim + 86_400_000;
  }
  return total;
}

// ---- Cobranças do ML (faturamento): tarifa de venda, envio, parcelamento, Mercado Pago, Product Ads, Minha página, devoluções...
async function cobrancaPeriodos() {
  const { token } = await getAccess();
  const r = await fetch("https://api.mercadolibre.com/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=12", { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Faturamento: ${r.status} ${j?.message ?? ""}`);
  return (j.results ?? []).map((x: any) => ({ key: x.key, de: x.period?.date_from, ate: x.period?.date_to, valor: x.amount, status: x.period_status }));
}
async function cobrancas(key: string, offset: number, paginas: number) {
  const { token } = await getAccess();
  let gravados = 0, total = 0, off = offset;
  for (let i = 0; i < paginas; i++) {
    const r = await fetch(`https://api.mercadolibre.com/billing/integration/periods/key/${key}/group/ML/details?document_type=BILL&limit=150&offset=${off}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 429) return { proximo: off, total, gravados, espera: true };
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Faturamento ${key}: ${r.status} ${j?.message ?? ""}`);
    total = j.total ?? total;
    const rows = (j.results ?? []).map((x: any) => {
      const c = x.charge_info ?? {};
      return {
        detail_id: c.detail_id, periodo: key, criado: c.creation_date_time ?? null, tipo: c.detail_type ?? null, subtipo: c.detail_sub_type ?? null,
        descricao: c.transaction_detail ?? null, marketplace: x.marketplace_info?.marketplace ?? null, valor: c.detail_amount ?? 0,
        bruto: x.discount_info?.charge_amount_without_discount ?? null,
        order_id: x.sales_info?.[0]?.order_id ?? x.items_info?.[0]?.order_id ?? null, item_id: x.items_info?.[0]?.item_id ?? null,
        debitado: c.debited_from_operation ?? null, doc_status: c.legal_document_status ?? null,
      };
    }).filter((x: any) => x.detail_id);
    if (rows.length) { const { error } = await db.from("ml_cobrancas").upsert(rows); if (error) throw error; }
    gravados += rows.length;
    off += 150;
    if (off >= total || !(j.results ?? []).length) return { proximo: null, total, gravados };
    await new Promise((res) => setTimeout(res, 250));
  }
  return { proximo: off, total, gravados };
}

// ---- Reclamações / devoluções do ML (só leitura): guarda as respostas cruas em ml_ads_raw (tipo recl_*) para analisarmos
async function reclamacoesTeste(_pedidos: number[]) {
  const { token } = await getAccess();
  const passos: Record<string, number> = {};
  const base = "https://api.mercadolibre.com/post-purchase";
  const esperar = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const reg = async (tipo: string, url: string) => {
    let r: Response | null = null, t = "";
    for (let k = 0; k < 4; k++) {                       // o ML limita a taxa: espera e tenta de novo
      r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      t = await r.text();
      if (r.status !== 429) break;
      await esperar(1200 * (k + 1));
    }
    let j: any = null;
    try { j = JSON.parse(t); } catch { /* não é JSON */ }
    await db.from("ml_ads_raw").insert({ tipo, url, status: r!.status, corpo: j ?? { texto: t.slice(0, 2000) } });
    passos[`${tipo} ${r!.status}`] = (passos[`${tipo} ${r!.status}`] ?? 0) + 1;
    return { r: r!, j };
  };
  const claims = new Map<number, any>();
  for (const st of ["closed", "opened"]) {
    for (let off = 0, p = 0; p < 12; p++, off += 50) {
      const { j } = await reg("recl_lista", `${base}/v1/claims/search?status=${st}&limit=50&offset=${off}`);
      const d: any[] = j?.data ?? [];
      d.forEach((c) => c?.id && claims.set(Number(c.id), c));
      if (d.length < 50) break;
    }
  }
  // significado dos motivos
  const motivos = new Set<string>();
  claims.forEach((c) => c.reason_id && motivos.add(String(c.reason_id)));
  for (const m of motivos) await reg("recl_motivo", `${base}/v1/claims/reasons/${m}`);
  // devoluções físicas: só onde o ML diz que houve devolução do item
  const devs = [...claims.values()].filter((c) => (c.resolution?.reason ?? "") === "item_returned").map((c) => Number(c.id));
  for (const id of devs.slice(0, 60)) {
    await reg("recl_devolucao", `${base}/v2/claims/${id}/returns`);
    await esperar(350);
  }
  return { passos, reclamacoes: claims.size };
}

// Status do envio dos pedidos que ainda não saíram (para o estoque "separado"): atualiza em lotes pequenos
async function envios(limite: number) {
  const { token } = await getAccess();
  const desde = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const { data: pend, error } = await db.from("ml_orders").select("id, shipping_id")
    .not("shipping_id", "is", null).gte("date_created", desde).neq("status", "cancelled")
    .or("envio_status.is.null,envio_status.in.(pending,handling,ready_to_ship)")
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
  return { abertos: (pend ?? []).length, feitos, erros: erros.slice(0, 3) };
}

// ---- Anúncios do ML: preço, tipo de anúncio, taxa vigente e quantidade (para manter o site igual ao ML)
async function anuncios() {
  const { token, userId } = await getAccess();
  const h = { Authorization: `Bearer ${token}` };
  const ids: string[] = [];
  for (const st of ["active", "paused"]) {
    for (let off = 0; off < 1500; off += 100) {
      const r = await fetch(`https://api.mercadolibre.com/users/${userId}/items/search?status=${st}&limit=100&offset=${off}`, { headers: h });
      const j = await r.json();
      if (!r.ok) throw new Error(`ML anúncios: ${r.status} ${j.message ?? ""}`);
      ids.push(...(j.results ?? []));
      if ((j.results ?? []).length < 100) break;
    }
  }
  // deno-lint-ignore no-explicit-any
  const itens: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const r = await fetch(`https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=id,title,price,available_quantity,sold_quantity,listing_type_id,category_id,status,seller_custom_field,attributes,shipping,variations`, { headers: h });
    const j = await r.json();
    if (!r.ok) throw new Error(`ML itens: ${r.status}`);
    for (const x of j) if (x.code === 200 && x.body) itens.push(x.body);
  }
  // taxa vigente de cada anúncio (depende do preço, do tipo de anúncio e da categoria)
  // deno-lint-ignore no-explicit-any
  const linhas: any[] = [];
  for (let i = 0; i < itens.length; i += 5) {
    await Promise.all(itens.slice(i, i + 5).map(async (it) => {
      let taxaValor: number | null = null;
      try {
        const r = await fetch(`https://api.mercadolibre.com/sites/MLB/listing_prices?price=${it.price}&listing_type_id=${it.listing_type_id}&category_id=${it.category_id}`, { headers: h });
        if (r.ok) { const j = await r.json(); taxaValor = Number((Array.isArray(j) ? j[0] : j)?.sale_fee_amount ?? NaN); if (Number.isNaN(taxaValor)) taxaValor = null; }
      } catch (_) { /* segue sem taxa */ }
      const sku = it.seller_custom_field ?? (it.attributes ?? []).find((a: { id: string }) => a.id === "SELLER_SKU")?.value_name ?? null;
      linhas.push({
        item_id: it.id, titulo: it.title, sku, preco: it.price, tipo: it.listing_type_id, categoria: it.category_id,
        taxa_valor: taxaValor, taxa_pct: taxaValor != null && it.price ? taxaValor / it.price : null,
        frete_gratis: it.shipping?.free_shipping ?? null, logistica: it.shipping?.logistic_type ?? null,
        qtd: it.available_quantity ?? null, vendidos: it.sold_quantity ?? null, status: it.status,
        tem_variacoes: (it.variations ?? []).length > 0, atualizado: new Date().toISOString(),
      });
    }));
  }
  for (let i = 0; i < linhas.length; i += 100) {
    const { error } = await db.from("ml_anuncios").upsert(linhas.slice(i, i + 100));
    if (error) throw error;
  }
  return { total: linhas.length, ativos: linhas.filter((x) => x.status === "active").length };
}

// Envia a quantidade em estoque para o ML (só o que o site mandar; cada anúncio individualmente)
async function estoqueMl(itens: { item_id: string; qtd: number }[]) {
  const { token } = await getAccess();
  const res: { item_id: string; ok: boolean; msg?: string }[] = [];
  for (const x of itens.slice(0, 60)) {
    const q = Math.max(0, Math.floor(Number(x.qtd)));
    if (!/^MLB\d+$/.test(String(x.item_id)) || !Number.isFinite(q)) { res.push({ item_id: String(x.item_id), ok: false, msg: "dados inválidos" }); continue; }
    const r = await fetch(`https://api.mercadolibre.com/items/${x.item_id}`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ available_quantity: q }),
    });
    if (r.ok) { res.push({ item_id: x.item_id, ok: true }); await db.from("ml_anuncios").update({ qtd: q, atualizado: new Date().toISOString() }).eq("item_id", x.item_id); }
    else { const j = await r.json().catch(() => ({})); res.push({ item_id: x.item_id, ok: false, msg: `${r.status} ${j.message ?? j.error ?? ""}`.slice(0, 160) }); }
    await new Promise((ok) => setTimeout(ok, 150));
  }
  return { resultados: res };
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
    if (action === "ads_sync") return json({ dias: await adsSync(String(body.desde), String(body.ate)) });
    if (action === "cobranca_periodos") return json({ periodos: await cobrancaPeriodos() });
    if (action === "cobrancas") return json(await cobrancas(String(body.key), Number(body.offset) || 0, Math.min(Number(body.paginas) || 4, 8)));
    if (action === "marketing") {
      const { data: ads, error: e1 } = await db.from("ml_ads_dia").select("*").order("dia");
      if (e1) throw e1;
      const { data: cob, error: e2 } = await db.rpc("bo_cobrancas_resumo");
      if (e2) throw e2;
      return json({ ads, cobrancas: cob });
    }
    if (action === "ads_teste") return json(await adsTeste());
    if (action === "reclamacoes_teste") return json(await reclamacoesTeste((body.pedidos ?? []).map(Number)));
    if (action === "fretes") return json(await fretes(Math.min(Number(body.limite) || 60, 100)));
    if (action === "envios") return json(await envios(Math.min(Number(body.limite) || 40, 80)));
    if (action === "anuncios") return json(await anuncios());
    if (action === "anuncios_list") {
      const { data, error } = await db.from("ml_anuncios").select("*").order("titulo");
      if (error) throw error;
      return json({ anuncios: data });
    }
    if (action === "estoque_ml") return json(await estoqueMl(Array.isArray(body.itens) ? body.itens : []));
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

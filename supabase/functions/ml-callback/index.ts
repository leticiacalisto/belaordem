import { checkState, exchangeCode, makeState, redirectUri, saveTokens } from "../_shared/ml.ts";

// o Supabase serve HTML como texto no domínio padrão, então respondemos texto simples
const page = (msg: string, status = 200) =>
  new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  const u = new URL(req.url);

  // 1) início: /ml-callback?connect=<BO_KEY> -> manda para o login do ML
  const connect = u.searchParams.get("connect");
  if (connect !== null) {
    if (connect !== Deno.env.get("BO_KEY")) return page("Chave inválida", 403);
    const a = new URL("https://auth.mercadolivre.com.br/authorization");
    a.searchParams.set("response_type", "code");
    a.searchParams.set("client_id", Deno.env.get("ML_CLIENT_ID")!);
    a.searchParams.set("redirect_uri", redirectUri());
    a.searchParams.set("state", await makeState());
    return Response.redirect(a.toString(), 302);
  }

  // 2) retorno do ML com ?code=
  const code = u.searchParams.get("code");
  if (!code) return page("Nada para fazer aqui.", 400);
  if (!(await checkState(u.searchParams.get("state")))) {
    return page("Pedido expirado ou inválido. Comece de novo pelo site.", 400);
  }
  try {
    await saveTokens(await exchangeCode(code));
    return page("Mercado Livre conectado! Pode fechar esta aba.");
  } catch (e) {
    console.error(e);
    return page(`Não foi possível conectar.\n\nMotivo: ${(e as Error).message}`, 500);
  }
});

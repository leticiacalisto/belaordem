import { checkState, exchangeCode, saveTokens } from "../_shared/ml.ts";

// o Supabase serve HTML como texto no domínio padrão, então respondemos texto simples
const page = (msg: string, status = 200) =>
  new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  const u = new URL(req.url);

  // retorno do ML com ?code= (o início do fluxo agora é a ação "conectar" do ml-sync, que exige login)
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

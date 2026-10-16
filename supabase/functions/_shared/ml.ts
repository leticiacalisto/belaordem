import { createClient } from "npm:@supabase/supabase-js@2";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const redirectUri = () =>
  `${Deno.env.get("SUPABASE_URL")}/functions/v1/ml-callback`;

// state assinado: "<timestamp>.<hmac>", vale 10 min
async function hmac(msg: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(Deno.env.get("BO_KEY")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function makeState() {
  const t = Date.now().toString();
  return `${t}.${await hmac(t)}`;
}
export async function checkState(s: string | null) {
  if (!s) return false;
  const [t, h] = s.split(".");
  return !!t && h === (await hmac(t)) && Date.now() - Number(t) < 10 * 60_000;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("ML_CLIENT_ID")!,
      client_secret: Deno.env.get("ML_CLIENT_SECRET")!,
      ...params,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`ML token: ${r.status} ${j.message ?? JSON.stringify(j)}`);
  return j;
}

export async function saveTokens(j: any) {
  const { error } = await db.from("ml_tokens").upsert({
    id: 1,
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    ml_user_id: j.user_id,
    expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export const exchangeCode = (code: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });

// devolve um access token válido, renovando se precisar (refresh token é de uso único)
export async function getAccess() {
  const { data } = await db.from("ml_tokens").select("*").eq("id", 1).maybeSingle();
  if (!data) throw new Error("Mercado Livre ainda não conectado");
  if (new Date(data.expires_at).getTime() - Date.now() > 60_000) {
    return { token: data.access_token as string, userId: data.ml_user_id as number };
  }
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: data.refresh_token });
  await saveTokens(j);
  return { token: j.access_token as string, userId: j.user_id as number };
}

// Login obrigatório: o token do Supabase Auth precisa ser válido E o e-mail estar na lista bo_acesso.
export async function autenticar(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await db.auth.getUser(jwt);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return null;
  const { data: ok } = await db.from("bo_acesso").select("email").eq("email", email).maybeSingle();
  return ok ? email : null;
}

export async function urlConectar() {
  const a = new URL("https://auth.mercadolivre.com.br/authorization");
  a.searchParams.set("response_type", "code");
  a.searchParams.set("client_id", Deno.env.get("ML_CLIENT_ID")!);
  a.searchParams.set("redirect_uri", redirectUri());
  a.searchParams.set("state", await makeState());
  return a.toString();
}

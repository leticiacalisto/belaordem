-- Tokens do Mercado Livre (uma linha só). Sem policies: só a service role acessa.
create table if not exists ml_tokens (
  id int primary key default 1 check (id = 1),
  access_token text not null,
  refresh_token text not null,
  ml_user_id bigint not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table ml_tokens enable row level security;

-- Pedidos do ML (só os campos usados)
create table if not exists ml_orders (
  id bigint primary key,
  date_created timestamptz not null,
  status text,
  total_amount numeric(12,2),
  paid_amount numeric(12,2),
  sale_fee numeric(12,2),
  shipping_id bigint,
  buyer_nickname text,
  items jsonb not null default '[]',
  synced_at timestamptz not null default now()
);
create index if not exists ml_orders_date_idx on ml_orders (date_created desc);
alter table ml_orders enable row level security;

-- Banco inteiro da plataforma como um documento (uma linha só)
create table if not exists bo_dados (
  id int primary key default 1 check (id = 1),
  dados jsonb not null,
  versao int not null default 1,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);
alter table bo_dados enable row level security;

-- E-mails autorizados a usar o site (além de ter login)
create table if not exists bo_acesso (
  email text primary key check (email = lower(email))
);
alter table bo_acesso enable row level security;

-- Dados extras do pedido (frete cobrado do vendedor, pagamento, envio)
alter table ml_orders add column if not exists pack_id bigint;
alter table ml_orders add column if not exists date_closed timestamptz;
alter table ml_orders add column if not exists pagamentos jsonb;
alter table ml_orders add column if not exists frete_vendedor numeric(12,2);
alter table ml_orders add column if not exists frete_comprador numeric(12,2);
alter table ml_orders add column if not exists envio_status text;
alter table ml_orders add column if not exists envio_tipo text;
alter table ml_orders add column if not exists frete_em timestamptz;
create index if not exists ml_orders_frete_idx on ml_orders (frete_em) where frete_em is null;

-- Respostas cruas da API de publicidade/faturamento do ML (para ajustar o painel de marketing)
create table if not exists ml_ads_raw (
  id bigserial primary key,
  criado timestamptz not null default now(),
  tipo text, url text, status int, corpo jsonb
);
alter table ml_ads_raw enable row level security;
create table if not exists ml_ads_dia (
  dia date primary key,
  custo numeric(12,2) not null default 0, cliques int not null default 0, impressoes int not null default 0,
  vendas numeric(12,2) not null default 0, unidades int not null default 0,
  direto numeric(12,2) not null default 0, indireto numeric(12,2) not null default 0
);
alter table ml_ads_dia enable row level security;
create table if not exists ml_cobrancas (
  detail_id bigint primary key, periodo date, criado timestamp, tipo text, subtipo text, descricao text, marketplace text,
  valor numeric(12,2), bruto numeric(12,2), order_id bigint, item_id text, debitado text, doc_status text
);
create index if not exists ml_cobrancas_criado_idx on ml_cobrancas (criado);
alter table ml_cobrancas enable row level security;
create or replace function bo_cobrancas_resumo()
returns table(mes text, subtipo text, descricao text, marketplace text, qtd bigint, valor numeric)
language sql stable as $$
  select to_char(criado, 'YYYY-MM'), c.subtipo, max(c.descricao), max(c.marketplace), count(*),
         sum(case when c.tipo = 'CHARGE' then c.valor else -c.valor end)
  from ml_cobrancas c where criado is not null
  group by 1, 2 order by 1 desc, 6 desc;
$$;

-- Lembrete semanal: assinaturas de notificação do navegador/celular e valores internos (chaves VAPID, último envio)
alter table ml_orders add column if not exists envio_sub text;
create table if not exists bo_push (
  endpoint text primary key, assinatura jsonb not null, email text, criado timestamptz not null default now()
);
alter table bo_push enable row level security;
create table if not exists bo_kv (chave text primary key, valor text not null);
alter table bo_kv enable row level security;

-- Anúncios do ML (preço, taxa vigente, quantidade) para sincronizar com o site
create table if not exists ml_anuncios (
  item_id text primary key, titulo text, sku text, preco numeric(12,2), tipo text, categoria text,
  taxa_valor numeric(12,2), taxa_pct numeric(8,5), frete_gratis boolean, logistica text,
  qtd int, vendidos int, status text, tem_variacoes boolean, atualizado timestamptz default now()
);
alter table ml_anuncios enable row level security;
alter table ml_orders add column if not exists envio_limite timestamptz;

-- Segurança: o site só fala com o banco pelas funções (chave de serviço). Anon e authenticated não têm acesso direto.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
revoke execute on function bo_cobrancas_resumo() from public, anon, authenticated;

-- Resumo da fatura do ML por mês da fatura, separando o que é debitado na venda (YES) do que você paga por fora (NO)
drop function if exists bo_cobrancas_resumo();
create or replace function bo_cobrancas_resumo() returns table(mes text, subtipo text, descricao text, marketplace text, debitado text, qtd bigint, valor numeric)
language sql stable as $$
  select to_char(coalesce(c.periodo, c.criado::date), 'YYYY-MM'), c.subtipo, max(c.descricao), max(c.marketplace), coalesce(c.debitado, '?'), count(*),
         sum(case when c.tipo = 'CHARGE' then c.valor else -c.valor end)
  from ml_cobrancas c where coalesce(c.periodo, c.criado::date) is not null group by 1, 2, 5 order by 1 desc, 7 desc;
$$;
revoke execute on function bo_cobrancas_resumo() from public, anon, authenticated;

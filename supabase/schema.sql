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

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

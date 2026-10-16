# Bela Ordem

Plataforma de gestão da loja (Mercado Livre e vendas físicas) que substitui o workspace "Mercado Livre Bela Ordem" do Notion.

## Como abrir

Dê dois cliques em `index.html`. Não precisa instalar nada.

## Onde ficam os dados

- **Na primeira abertura**, a plataforma carrega os dados migrados do Notion (`dados-iniciais.js`).
- **Depois disso**, tudo o que você lança fica salvo no navegador (localStorage) deste computador.
- Se trocar de navegador ou de computador, ou limpar os dados de navegação, os dados não vão junto. Use **Dados e backup → Baixar backup** com frequência. Para levar os dados a outro lugar, use **Importar backup**.

## Seções

| Seção | O que tinha no Notion |
|---|---|
| Início | Página principal (resumo do mês, validade próxima, estoque baixo) |
| Produtos | Banco de dados Produtos (Disponível, Vendidos, Custo médio, Margem média) e botão Compra |
| Estoque | Movimentação de Estoque (visões À venda, Vendidos e Geral) e botões Vender e Devolução |
| Compras | Visão Compras (agrupada por nota fiscal) |
| Vendas | Vendas Gerais (visões Mês atual e por mês) |
| Vendas Físicas | Vendas Físicas (visões Pendente e Pagos) |
| Encomendas | Seção Encomendas (estava vazia no Notion) |
| DRE e Despesas | Página DRE, agora calculada automaticamente |

## Fórmulas

- **Lucro** = V. Venda − V. Venda × Taxa ML − Frete − Custo
- **Margem** = Lucro ÷ V. Venda
- **Status pgto**: Pago (pago ≥ valor da venda), Parcial (pagou uma parte), Pendente (não pagou nada)
- **Lucro líquido (DRE)** = soma dos lucros do mês − despesas do mês

## Antes de publicar no GitHub

O arquivo `dados-iniciais.js` contém os dados reais da loja: custos, fornecedores, notas fiscais e nomes de clientes. **Num repositório público, qualquer pessoa consegue ver esses dados.** Use um repositório privado, ou apague o conteúdo desse arquivo antes de publicar (a plataforma abre vazia, e você importa um backup).

## Publicação

O site é publicado no GitHub Pages **sem os dados da loja**: `dados-iniciais.js`, backups e arquivos `.json` ficam fora do repositório (veja `.gitignore`). Nunca remova essas regras. Os dados ficam no Supabase (projeto "ML Admin") e no navegador.

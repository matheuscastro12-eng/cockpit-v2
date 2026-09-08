# Remanejo — LDI SAFETY: VICTOR → ISABELY (Curva F)

**Data:** 2026-09-08 · **Autorizado por:** Carlos (chat) · **Executado via:** RPC
`public.remanejar_cliente_operador` (mig 360), conforme `docs/REMANEJAR_CLIENTE.md`.
**Classificação:** remanejo VIA RPC → liberado pro Carlos
(`docs/POLITICA_MIGRATIONS.md`). Remanejo à mão continuaria TIPO B / só Caio.

> **STATUS: EXECUTADO EM PRODUÇÃO em 2026-09-08 14:53**, com ordem explícita do
> Carlos ("Boa! Fiz isso já. Se estiver tudo certo, pode rodar") e após ele
> confirmar a troca da espécie/responsável no SSW. Todos os critérios de
> conclusão passaram e a idempotência foi confirmada em produção. Ver seção 11.

---

## 1. Pedido

Transferir o cliente **LDI SAFETY** do operador **VICTOR** para a operadora
**ISABELY**, porque o faturamento está **abaixo de 20 mil/mês** — logo ele é
**Curva F**, a carteira da ISABELY.

| CNPJ | Formatado | Nome |
|---|---|---|
| `27153141000281` | 27.153.141/0002-81 | LDI SAFETY |

Confirmado pelo Carlos em 2026-09-08 que o piso é **20k/mês** (bate com o
comentário do `sync-bastao`, não com os 30k citados no pedido original).

## 2. Estado verificado ANTES (2026-09-08, produção)

| Camada | Valor |
|---|---|
| `operadores.carteira` | **VICTOR** (e só ele — invariante "1 CNPJ = 1 operador" íntegra) |
| `clientes.segmento_codigo` | **`008` = EPI** (segmento do VICTOR) |
| `contatos_cliente` | **1** |
| `tracking_credentials` | **1** — LDI SAFETY, ativa, responsável VICTOR |
| **`cards`** | **8** — ver seção 2.1 |
| Ação autônoma armada / AVH | **0 / 0** |

**Operadores:** VICTOR (`ativo`, `cockpit_ativo`, segmentos
`006,008,011,012,013,020,041`, carteira 44) · ISABELY (`ativo`, `cockpit_ativo`,
segmento **`043`**, carteira 385).

**Sem filiais:** varredura por raiz `27153141` retorna só este CNPJ. Não há irmão
para arrastar junto.

### 2.1 Os 8 cards — e por que quase passaram batido

**`cards.pagador` guarda o NOME, não o CNPJ.** A busca por
`pagador LIKE '%27153141%'` devolve **zero** e dá a falsa impressão de que o
cliente não tem card nenhum. Quem casa de verdade é
`agent_state->>'cnpj_pagador'` — que é exatamente o par de condições que a RPC
usa (`lpad(regexp_replace(...,'\D','','g'),14,'0')` nos dois campos).

Fica registrado como armadilha de diagnóstico: **contar card de um cliente só por
`cards.pagador` subestima o blast radius.**

| NF | CTRC | Estado | Criado | Última atividade |
|---|---|---|---|---|
| **21413** | APO571799-0 | TRANSFERIDO | 02/09 | **08/09 — hoje** |
| 21355 | APO566633-3 | RESOLVIDO | 31/08 | 03/09 |
| 21162 | APO539542-9 | TRANSFERIDO | 21/08 | 25/08 |
| 21183 | APO539545-3 | TRANSFERIDO | 21/08 | 22/08 |
| 21162 | APO539542-9 | RESOLVIDO | 21/08 | 21/08 |
| 20748 | APO482625-6 | RESOLVIDO | 04/08 | 05/08 |
| 20082 | APO379431-8 | TRANSFERIDO | 02/07 | 15/07 |
| 19955 | APO359118-2 | TRANSFERIDO | 01/07 | 15/07 |

Todos hoje no **VICTOR**. 5 TRANSFERIDO · 3 RESOLVIDO.

**A NF 21413 está viva.** Eventos de hoje (08/09): `SeedRomaneioAvaliado`,
`DossieExtravioAtualizado`, `InterpretadorRespostaClienteConcluido`,
`RetornoClienteEmAguardo` (12:34) e `HistoricoSswPuxado` +
`AtualizadoViaPortalSsw` (13:02). **O cliente respondeu hoje e o agente tratou.**
É o único card com atividade recente — os outros 7 são histórico.

## 3. Pré-requisito humano — FEITO

Espécie/responsável de LDI SAFETY **já trocada para ISABELY no SSW** por Carlos,
confirmado por ele em 2026-09-08 imediatamente antes da execução.

Sem isso, o trigger `resolve_assigned_operator_from_name` (migs 007/305) — que
casa card novo por NOME vindo do SSW e não olha carteira — devolve card novo pro
VICTOR. Foi o que aconteceu com o SULMEDIC entre 17 e 19/08.

## 4. Automações que poderiam sobrescrever o novo responsável

Cascata do `_shared/operador-resolver.ts`:

| Ordem | Regra | Neste caso |
|---|---|---|
| Path 0 | blacklist `cnpjs_excluidos_cockpit` | não se aplica |
| **Path 1** | **CNPJ na carteira** (prioridade absoluta) | **é o que garante o resultado** → ISABELY |
| Path 2 | nome do Bastão (`responsavel_relacionamento`) | diria VICTOR hoje — neutralizado pela troca no SSW (item 3) + Path 1 |
| **Path 3** | **segmento** | **reforço: `043` aponta ISABELY** |
| Path 4 | fallback órfão (`recebe_cards_orfaos`) | é a própria ISABELY — não há como cair errado |

Aqui os Paths 1, 3 e 4 **convergem todos na ISABELY**. É um caso mais protegido
que o do grupo JPES (28/08), onde só o Path 1 sustentava.

### 4.1 Por que o segmento tem de ir junto (o ponto crítico)

A policy `cards_select_visibilidade` em `public.cards` (verificada em produção):

```
papel = 'gestor'
OR assigned_operator_id = current_operador_id()
OR pagador         IN (unnest(current_operador_carteira()))
OR segmento_codigo IN (unnest(current_operador_segmentos()))   ← esta
```

O último `OR` dá visão **por segmento**. Como o VICTOR é dono do `008` e o LDI é
`008`, mover **só a carteira** deixaria o VICTOR continuando a enxergar todos os
cards do cliente pela porta do segmento.

Por isso `p_segmento_codigo => '043'` + `p_segmento_nome => 'CURVA F'` **não são
opcionais neste remanejo** — são o que fecha a segunda porta.

Efeito colateral desejado: a exceção Curva F do `sync-bastao`
([index.ts:1259-1267](../../supabase/functions/sync-bastao/index.ts#L1259-L1267))
ignora a allowlist de carteira para quem tem `043` e puxa 100% do que o Bastão
marcar como segmento 043. Com o cliente em `008`, ele entraria na ISABELY só pela
allowlist — sem a exceção desenhada justamente para os clientes de baixo
faturamento.

## 5. Como executar

```bash
python3 scripts/dbq.py -c "SELECT jsonb_pretty(public.remanejar_cliente_operador(
  p_cnpj             => '27153141000281',
  p_operador_destino => 'ISABELY',
  p_segmento_codigo  => '043',
  p_segmento_nome    => 'CURVA F',
  p_motivo           => 'Faturamento abaixo de 20k/mes: cliente e Curva F. A planilha de 23/07 (mig 307) classificou por segmento de produto (008 EPI, carteira do VICTOR) em vez de por faturamento. Especie/responsavel trocada no SSW antes.',
  p_autorizado_por   => 'CARLOS'
));"
```

`p_cliente_novo_ok` **não** é necessário: o LDI já existe em `clientes` — não bate
na trava anti-digitação (diferente do caso JPES).

## 6. Dry-run (RODADO E APROVADO — `BEGIN … ROLLBACK`, nada gravado)

**Relatório da RPC:**

```json
{"cnpj": "27153141000281", "cliente": "LDI SAFETY",
 "de": ["VICTOR"], "para": "ISABELY",
 "cards": 8, "contatos": 1, "tracking": 1, "alertas": 0, "veto_desarmado": 0,
 "autorizado_por": "CARLOS",
 "avisos": ["Confira que a especie/responsavel do cliente JA FOI trocada no SSW ..."]}
```

**Medições antes × depois, na mesma transação:**

| Medida | Antes | Depois | ✓ |
|---|---|---|---|
| Dono do CNPJ | VICTOR | **ISABELY** | ✅ |
| Nº de donos (invariante 1 CNPJ = 1 operador) | 1 | 1 | ✅ |
| Carteira VICTOR | 44 | **43** | ✅ |
| Carteira ISABELY | 385 | **386** | ✅ |
| Segmento do LDI | `008` | **`043 CURVA F`** | ✅ |
| Clientes no seg `008` EPI | 11 | 10 | ✅ |
| Clientes no seg `043` CURVA F | 373 | 374 | ✅ |
| Total de clientes | 853 | 853 (nada criado/apagado) | ✅ |
| Contatos do CNPJ | 1 | 1 (movido, não duplicado) | ✅ |
| **`cards` criados/apagados** | **delta 0** | — | ✅ |
| `card_events` gerados | **+8** (1 `OperadorReatribuido` por card) | — | ✅ |
| CNPJ em 2 carteiras (invariante global) | **0** | — | ✅ |

**Isolamento provado por hash (md5 antes × depois):**

| Conjunto | Resultado |
|---|---|
| Todos os outros 852 clientes | **idêntico** ✅ |
| Todas as demais entradas de carteira de todos os operadores | **idêntico** ✅ |

Os 9 pós-checks internos da RPC passaram — nenhuma EXCEPTION.

## 7. Efeito esperado

Diferente do caso JPES (que era registrar titularidade antes do primeiro card),
aqui **há carga real movendo**: 8 cards saem da tela do VICTOR e entram na da
ISABELY, com `card_event OperadorReatribuido` em cada um — histórico preservado,
nada reescrito.

**Ponto operacional a combinar antes:** a NF 21413 é uma tratativa **viva**, com
resposta do cliente hoje. Se o VICTOR estiver com ela na mão neste momento, o card
some da tela dele e aparece na da ISABELY. Não é problema técnico — é passagem de
bastão, e precisa ser avisada.

## 8. Validação pós-execução (critérios de conclusão)

- [ ] Relatório JSON sem erro; campo `avisos` lido
- [ ] `27153141000281` na carteira da ISABELY e **em nenhuma outra**
- [ ] `clientes.segmento_codigo = '043'` / `segmento_nome = 'CURVA F'`
- [ ] Os 8 cards com `assigned_operator_id = ISABELY`
- [ ] 8 `card_events` `OperadorReatribuido` — um por card
- [ ] Carteira VICTOR = 43 · ISABELY = 386
- [ ] Invariante global "1 CNPJ = 1 operador" = 0 duplicados
- [ ] Simular a identidade do VICTOR pela RLS: **não** enxerga mais o cliente
- [ ] Re-execução devolve relatório zerado (idempotência)
- [ ] `/verify-cockpit`
- [ ] **Critério final:** o próximo card do LDI nasce direto na ISABELY

## 9. Reversão

Mesma RPC apontando `p_operador_destino => 'VICTOR'` com
`p_segmento_codigo => '008'` / `p_segmento_nome => 'EPI'`.

Diferente do caso JPES, aqui a reversão **é** um retorno fiel ao estado de hoje:
o cliente tinha dono (VICTOR) e segmento (`008`) definidos, então voltar não passa
por nenhum estado "sem dono". Os 8 cards voltariam com novo
`OperadorReatribuido` — o histórico acumula, não se apaga.

## 10. Causa raiz (para não repetir)

**Não houve bug.** A planilha "Relacionamento Atualizado" de 23/07
([mig 307, linha 675](../../migration/2026-07-23_307_relacionamento_atualizado.sql#L675))
classificou LDI SAFETY como `008 EPI` — pelo **que a empresa vende** — quando o
critério aplicável era **quanto ela fatura** (`043 CURVA F`). O Cockpit espelhou a
planilha fielmente.

```sql
('27153141000281','LDI SAFETY','008','EPI','VICTOR',NULL,NULL,NULL),
```

**O campo `segmento_codigo` carrega dois critérios incompatíveis:** tipo de produto
(006 cosméticos, 008 EPI, 011 suplementos, 041 periféricos — carteira do VICTOR) e
faixa de faturamento (043 CURVA F — carteira da ISABELY). Quando um cliente se
encaixa nos dois, **vence quem preencheu a planilha**. Não há nada no sistema que
detecte a colisão: **o Cockpit não tem nenhum dado de faturamento** — varredura por
`%fatur%`, `%curva%`, `%receita%`, `%ticket%` em todas as colunas do schema
`public` retorna zero.

Consequência: **este erro não é auto-detectável nem auto-corrigível.** Só aparece
quando um humano que conhece o faturamento olha e aponta — como aconteceu aqui.
Qualquer outro cliente pequeno rotulado por tipo de produto está no mesmo estado,
silenciosamente.

**Não regenerar a mig 307** para "consertar a origem": ela é o retrato imutável da
planilha daquela data e outras coisas dependem dela. A correção é o remanejo.

---

## 11. Execução em produção — 2026-09-08 14:53

**Pré-check imediato antes do disparo** (para garantir que nada mudou entre o
dry-run e a execução — a NF 21413 estava viva): dono=VICTOR · segmento=`008 EPI` ·
cards=8, todos no VICTOR · carteira VICTOR=44 · ISABELY=385 · ação armada=0 ·
último evento da NF 21413 = 13:02:39. **Idêntico ao baseline do dry-run.**

**Relatório da RPC:**

```json
{"cnpj": "27153141000281", "cliente": "LDI SAFETY",
 "de": ["VICTOR"], "para": "ISABELY",
 "cards": 8, "contatos": 1, "tracking": 1, "alertas": 0, "veto_desarmado": 0,
 "autorizado_por": "CARLOS"}
```

Idêntico, número a número, ao previsto pelo dry-run.

**Critérios de conclusão — todos passaram:**

| # | Verificação | Esperado | Resultado |
|---|---|---|---|
| 1 | Na carteira da ISABELY | 1 | **1** ✅ |
| 2 | Em qualquer outra carteira | 0 | **0** ✅ |
| 3 | CNPJ em 2 carteiras (invariante global) | 0 | **0** ✅ |
| 4 | Segmento do cliente | `043 CURVA F` | **`043 CURVA F`** ✅ |
| 5 | Cards na ISABELY | 8 | **8** ✅ |
| 6 | Cards ainda no VICTOR | 0 | **0** ✅ |
| 6b | Cards sem dono | 0 | **0** ✅ |
| 7 | Carteira VICTOR | 43 | **43** ✅ |
| 8 | Carteira ISABELY | 386 | **386** ✅ |
| 9 | Clientes seg `008` / `043` | 10 / 374 | **10 / 374** ✅ |
| 10 | Total de clientes (nada criado/apagado) | 853 | **853** ✅ |
| 11 | Contato / tracking na ISABELY | 1 / 1 | **1 / 1** ✅ |
| 12 | `card_events` `OperadorReatribuido` hoje | 8 | **8** ✅ |
| 13 | Total de cards do cliente | 8 | **8** ✅ |

**Prova pela RLS — identidade real de cada operador simulada** (`request.jwt.claims`
com o `user_id` verdadeiro + `role=authenticated`, contando os cards do LDI que
cada um enxerga com a policy rodando de verdade):

```
ISABELY enxerga 8 card(s) do LDI
VICTOR  enxerga 0 card(s) do LDI
```

É esta linha que fecha o caso: **o VICTOR não vê mais nada do cliente** — nem pela
carteira, nem pela porta do segmento (seção 4.1). O `008` deixou de alcançá-lo
porque o cliente virou `043`.

**Idempotência confirmada em produção:** 2ª execução devolveu `de: []`, `cards: 0`,
`contatos: 0`, `tracking: 0` — nada mexido, nenhum evento duplicado.

**Em aberto até acontecer:** o critério final "o próximo card do LDI nasce direto
na ISABELY". Os Paths 1, 3 e 4 do resolver apontam ISABELY e a espécie no SSW já
foi trocada, fechando a porta lateral do trigger por nome — mas só o primeiro card
novo confirma na prática.

**Passagem de bastão avisada:** a NF 21413 (tratativa viva, cliente respondeu às
12:34 de hoje) saiu da tela do VICTOR e entrou na da ISABELY no momento da
execução. Histórico preservado — o card carrega o `OperadorReatribuido`.

# ADR 0027 — Correção 09.09: pendência de documento ≠ extravio total, e a 33 diz o que falta

**Data:** 2026-09-09
**Autor:** Carlos (ordem), Claude (execução)
**Status:** implementado na branch `fix/correcao-09-09-sugestao-59-33`, **não mergeado**
**Relacionado:** ADR 0023 (dossiê de extravio parcial), INV-062 (59 em extravio total), ADR 0004

## Contexto

Karol relatou dois casos de "o COCKPIT não sugeriu a ocorrência necessária":

* **Caso 1** — NF 75249 (oc 19, LEONE COMERCIO): a oc **59** não apareceu.
* **Caso 2** — NFs 350882 (ACACIA) e 431734 (ALFALAGOS): a oc **33** não apareceu.

A hipótese trazida no relato era deduplicação: *"a existência de uma 33 anterior
bloqueou a nova sugestão"*.

## O que foi medido (e não presumido)

### A hipótese de deduplicação está ERRADA

| Achado | Fonte |
|---|---|
| A dedup usa `STATUS_ATIVOS = {pendente, aprovado}` — **nunca** consulta o histórico do SSW | `regras-auto-acao.ts:953` |
| `codigosJaPropostos` sai só de `existingTodos` | `regras-auto-acao.ts:970-984` |
| `executando` e `cancelado` **não** ocupam o código (liberado de propósito — o comentário cita a NF 2148226) | `regras-auto-acao.ts:950-953` |
| O índice único de to-dos cobre só `pendente`/`aprovado` | `uniq_todos_card_tool_cod_ativo` |
| A idempotência do SSW é `(card_id, codigo_oc, ctrc, **todo_id**)` — to-do novo não bate nela | `pg_indexes` |

**E a 33 ESTAVA sendo sugerida nos dois cards** — aparece nas telas que Karol
enviou e o banco confirma: NF 350882 com 2 to-dos de 33 `pendente` desde 19/08;
NF 431734 com 9 to-dos `pendente` desde 03/09 (21,54,59,55,44,56,33,41,33).

Não existe regra de deduplicação impedindo nova sugestão de 33. São **dois bugs
com causas independentes** — e nenhuma é a do relato.

### Erro de medição corrigido no caminho

A primeira sonda buscou o template em `args.template_email` e devolveu 0 para
tudo. O campo real é `args.template_id` — é o que o próprio código consulta
(`propostas-pos-resposta-cliente.ts:168`). O "0" inicial era artefato da sonda,
não evidência. Refeita a medição com o campo certo, o quadro mudou por completo.

## Causa raiz — Caso 1

O menu pós-resposta tem **dois trilhos** decididos pela oc-âncora
(`propostas-pos-resposta-cliente.ts:121-128`): âncora 59 → trilho indenização;
qualquer outra → trilho tratativa, onde `ocReaguardar = 54`.

No trilho tratativa o 59 só sobrevivia se `ehExtravioTotalPorTodos59()` fosse
verdadeiro — e essa função exige um to-do de 59 com o template
`EXTRAVIO_TOTAL_PEDIR_ROMANEIO`, **que só o override de extravio TOTAL cria**.

A NF 75249 é oc 19 (entrega com falta de volumes = **parcial**). Sequência medida:

| Quando | O quê |
|---|---|
| 03/09 22:01:31 | `REGRAS_AUTO_ACAO[19]` propõe `[33, 59, 55, 56]` — o 59 nasce `pendente` |
| 03/09 22:07:07 | cliente responde, menu pós-resposta assume e **cancela o 59 como "obsoleto"**, pondo "re-lançar 54" no lugar |
| 04/09 15:01:00 | novo lote pós-resposta: 21, 33, 44, 55, 56, 54, 54 — sem 59 |

Os 59 desse card carregam `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` e
`EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO` — **zero** com o template de total.
O portão não reconhece o caminho parcial.

## Causa raiz — Caso 2

A 33 é sugerida; o que trava é a **execução**. O executor barra a 33 quando o
dossiê de extravio parcial está incompleto, com a flag
`extravio_parcial_dossie_enabled = true` (verificada ligada):

* `executor/index.ts:2334` — "Combo 33+44 bloqueado: extravio parcial sem romaneio no dossiê"
* `executor/index.ts:2899` — "Email+oc 33 (romaneio interno) bloqueado: dossiê incompleto"

Estado dos dois cards:

| NF | romaneio | descrição | valor | completo |
|---|---|---|---|---|
| 350882 | **false** | true | true | false |
| 431734 | true | **false** | **false** | false |

Mesmo portão, peça faltante diferente. O bloqueio é **deliberado** (ADR 0023):
sem romaneio o SSW reverte a 33. O que faltava era o card **dizer isso** — o
motivo só aparecia depois de abrir o modal, e a linha mostrava "LANÇAR →" como
se estivesse pronta.

## Não é específico da Karol

Cards abertos com 33 sugerida e dossiê incompleto, por operador:

```
DUILIO 37 | FELIPE 34 | KAROLINE 17 | MARIA 17 | VICTOR 16
INGRID 13 | JULIA 12 | LARISSA 9 | ISABELY 6 | CAMILA 1
```

**162 cards, 10 operadores.** Karol é a terceira.

## Decisão

### Caso 1 — o critério passa a ser PENDÊNCIA DE DOCUMENTO, não "é total?"

Novo sinal `temPendenciaDocumento59`, sobre os **três** templates de pedido de
romaneio (`TEMPLATES_59_PEDIDO_DOCUMENTO`). Contagem no banco que justifica o
conjunto:

```
dentro:  EXTRAVIO_TOTAL_PEDIR_ROMANEIO 5682 | ENTREGUE_COM_FALTA_PEDIR_ROMANEIO 5279
         EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO 552
fora:    EXTRAVIO_PARCIAL 456 | RECUSA_TOTAL 22 | RECUSA_PARCIAL 13
         TENTATIVAS_ESGOTADAS 2 | <sem template> 7159
```

Os de fora são **notificação**, não pedido de documento — incluí-los ofereceria
59 em card sem pendência documental.

**A ASSIMETRIA É O CORAÇÃO DA CORREÇÃO:**

| Caminho | Sinal | Mudou? |
|---|---|---|
| Preservar 59 `pendente` na whitelist | `pendenciaDoc59` (3 templates, só `pendente`/`aprovado`) | **SIM** — é o fix |
| Ressuscitar 59 `cancelado` (bloco 3b) | `ehExtravioTotal` (só TOTAL) | **NÃO** — idêntico a antes |

Por que a revivência **não** foi alargada: mexeria em **3307 cards abertos** de
uma vez, e um 59 revivido pode ser auto-aprovado pela janela de veto — medido:
**75** to-dos de 59 com `auto_approval_rule` =
`veto_janela:agente-sugere-ocs-padrao:lancar_oc_e_enviar_email:59`. Isso é
e-mail ao cliente sem clique do operador. Preservar um pendente que o próprio
sistema acabou de propor não tem esse risco.

### Caso 2 — transparência, não desbloqueio

O gate não se toca. Módulo puro novo no front (`lib/dossie33Faltando.ts`) que lê
o dossiê já em `agent_state` e a linha da 33 passa a dizer
`falta romaneio de coleta assinado`, `falta descrição dos itens + valor dos itens`
etc. Segue o padrão do `AvisoRomaneioBanner` que já existia (mesmo const JSX
inserido nos 5 branches de render).

É **ESPELHO** de `_shared/extravio-parcial-dossie.ts`. Pra este espelho não virar
detector descalibrado, o teste do front **lê o fonte do backend** e falha se os
rótulos ou as três checagens `presente` mudarem lá sem mudar aqui.

### Bônus — rótulo que informava a ocorrência errada

`ProposedActions.tsx:1696` tinha **"54" literal** na frase "Lança só a oc 54 no
SSW", enquanto o título logo acima já usava `{codigo}`. Numa linha de 59 a tela
dizia "59" no rótulo e "oc 54" na explicação — visível na tela da NF 350882.
Passou a `{codigo}`.

## Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Alargar também a revivência do 59 | 3307 cards abertos mudariam de estado de uma vez, com risco de e-mail via janela de veto (75 casos medidos de auto-aprovação de 59) |
| Incluir todos os templates de 59 no sinal | `EXTRAVIO_PARCIAL`, `RECUSA_*` e `TENTATIVAS_ESGOTADAS` são notificação — dariam 59 sem pendência documental |
| Mexer na dedup de `regras-auto-acao` | A dedup não é a causa; está correta. Mexer ali arriscaria os 8 fluxos que dependem dela |
| Desbloquear a 33 sem dossiê | O SSW reverte o lançamento. Foi o incidente que criou o gate (NF 158084) |
| Marcar a natureza da 33 como operacional por padrão | O fallback conservador do backend existe justamente pra não liberar 33 só com romaneio por engano |

## Guards (convenção nº 8)

* **INV-149** — `oc59-extravio-total.test.ts`: 4 testes novos. Cobrem o conjunto
  de 3 templates (e os 4 que ficam de fora), o sinal só ligar em
  `pendente`/`aprovado`, e um teste de **fonte** que trava a assimetria: falha se
  alguém trocar a whitelist de volta pro sinal estreito.
* **INV-150** — `dossie33Faltando.test.ts`: 10 testes, incluindo os dois
  casos-âncora medidos (350882 e 431734), o fallback conservador do combo, e a
  **paridade lida do fonte do backend**.

## Verificação executada

| O quê | Baseline (master `da647aa`) | Depois |
|---|---|---|
| Backend `deno test` | 1155 passed / 2 failed | **1159 / 2** (mesmos 2 pré-existentes) |
| Front `vitest` | 32 arquivos / 240 testes | **33 / 250** |
| `tsc --noEmit` | exit 0 | **exit 0** |
| `deno check` no arquivo alterado | — | **exit 0** |
| `vite build` | — | **✓ built** (só o aviso de chunk pré-existente) |

Os 2 failures do backend são os mesmos de antes da correção
(`regras-auto-acao.sem-email-54.test.ts:169` e
`tools-registrados-no-front.test.ts:128`).

## Dívida registrada, não feita

* **Doc divergente do banco:** o `CLAUDE.md` descreve
  `UNIQUE(card_id, codigo_oc, ctrc)` mas o índice real é
  `(card_id, codigo_oc, ctrc, todo_id)`. Foi o que me fez descartar uma hipótese
  — e quem ler o doc vai raciocinar errado sobre idempotência.
* **15630 to-dos em `executando`**, o mais antigo de 29/04 (133 dias). Pode ser
  acúmulo por desenho (`executando` está fora de `STATUS_ATIVOS` de propósito),
  mas ninguém mediu se algum ficou preso no meio de um lançamento.
* **Os 162 cards já bloqueados** não foram tocados. A correção só faz o card
  dizer o que falta; cobrar o cliente segue sendo trabalho do operador.
* **A janela em que a 33 pode ter faltado de verdade:** a NF 350882 ficou de
  07/08 a 19/08 sem 33 ativa. Não consegui reconstruir o que estava na tela nesse
  intervalo — fica como hipótese não confirmada.

## Registro de deploy — 2026-09-09 (APLICADO E PROVADO)

Autorizado pelo Carlos em 2026-09-09 ("autorizado, garanta que a master, git,
supabase e deploy estejam 100% alinhados"). Merge `f701cc2`, master = origin.

### Edge functions

Fecho transitivo do `_shared/propostas-pos-resposta-cliente.ts`:
`cron-ia-resposta-pendentes`, `scan-email-pre-card`, `vinculador`.

Conferi o fecho POR FORA do script antes de deployar, porque `executor/index.ts`
também casa no grep. Dos 8 hits da string no repo, só 4 são `import`; os outros
4 são **comentário** (`executor:3923`, `destaque-resposta-cliente:18`,
`devolucao-cte-44:30`, `extravio-parcial-dossie:492`). O único intermediário real
é `_shared/acionar-resposta-cliente.ts:28`, importado pelas mesmas 3 funções. O
`deploy_pendente.py` estava certo e o `executor` **não** entra.

| | pré | pós |
|---|---|---|
| cron-ia-resposta-pendentes | v40 | **v41** ACTIVE 13:05Z |
| scan-email-pre-card | v40 | **v41** ACTIVE 13:05Z |
| vinculador | v133 | **v134** ACTIVE 13:05Z |

### Prova direta (não a mensagem do CLI, não a data)

`supabase functions download` das 3 + `cmp` contra `f701cc2`: **39/39 arquivos
byte-a-byte idênticos**, 0 diferentes, 0 ausentes. No bundle de produção de
`propostas-pos-resposta-cliente.ts`:

* portão novo presente — `(pendenciaDoc59 && cod === 59 && !ehCombo4459)` na linha 302;
* portão antigo **ausente** — `(ehExtravioTotal && cod === 59 && !ehCombo4459)` = 0 ocorrências;
* assimetria preservada — `if (ehExtravioTotal) {` na 328 com
  `escolher59IndenizacaoParaReviver(todos59Total)` na 329 (revivência segue estreita);
* query ampliada — `.in("proposta_payload->args->>template_id", [...TEMPLATES_59_PEDIDO_DOCUMENTO])` na 216.

### Prova comportamental em produção

**NF 798761** (fato verificado). Agente classificou `caso_oc49: extravio_sem_qtd`
→ `ehExtravioTotal` = false, ou seja o portão ANTIGO cancelaria. Resposta do
cliente interpretada às **13:07:13Z (pós-deploy)** e o 59
`ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` criado 13:01:42 **segue `pendente`**. No
mesmo card, um 59 do mesmo template de 24/08 está `cancelado` — o comportamento
antigo. Mesma NF, mesmo template, antes/depois.

**NF 1846810 NÃO é contra-exemplo** (fato verificado). O 59 dela foi cancelado às
13:09:35 por `TodosConcorrentesCancelados`, motivo "Operadora escolheu uma das
opções" — a operadora aprovou acareação, oc 56 lançada 13:10:42 e confirmada pelo
SSW 13:10:49. Fluxo do menu, não o desta correção.

População protegida hoje: **125 to-dos de 59 parcial em `pendente`**.

Saúde pós-deploy: 406 `card_events` entre 13:00Z e 13:10Z, e os 3 crons das
funções deployadas com **`succeeded` e zero `failed`** (8 / 20 / 40 execuções).

### Front (Vercel, automático no push)

`https://cockpit-aisalexpress.vercel.app` — `Last-Modified 13:16:54Z`, bundle
`/assets/index-Dj3J-bT3.js`. Impressões digitais exclusivas do commit `5bcd668`
presentes: "o SSW reverte a 33 sem isso", "Cobre o cliente ou anexe ao dossiê
antes de lançar", "no SSW (não envia e-mail)". E o check negativo do bug da NF
350882: **"Lança só a oc 54 no SSW" ausente** do bundle publicado.

### Banco

**Nada a aplicar.** O merge tem **0 arquivos `.sql`**; última migration do repo
segue a 389 (08/09). Advisors de segurança: 174 lints, **5 ERROR** — os mesmos 5
`security_definer_view` pré-existentes, baseline intacto.

### Invariantes na master pós-deploy

INV-062 PASS (test=ok, whitelist=1) · INV-149 PASS (portão novo=1, antigo=0,
assimetria=1) · INV-150 PASS (10/10 testes de paridade front↔backend).

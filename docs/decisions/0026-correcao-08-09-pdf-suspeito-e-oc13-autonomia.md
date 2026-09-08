# 0026 — Correção 08.09: página de PDF suspeita vai pro humano, e visibilidade da oc 13 deixa de ligar autonomia

**Data:** 2026-09-08
**Status:** aceito (branch `fix/correcao-08-09`; merge e aplicação de migrations pendentes de autorização do Caio/Carlos)
**Invariantes:** INV-147, INV-148
**Origem:** dois bugs relatados pela operadora **LARISSA**

## Contexto

Dois sintomas chegaram juntos, na mesma operadora. Foram investigados como **dois sintomas**, não como dois bugs, até haver prova de causas independentes — e as causas se mostraram independentes de verdade.

### Caso 1 — o PDF do 33 + 44 não anexava

No card da NF 1102170 (UNIÃO QUÍMICA), a Larissa selecionava `10803714.pdf` no modal "Lançar 33 + Lançar 44" e recebia:

> Falha ao converter "10803714.pdf" em imagem — Página 2 perdeu o conteúdo na conversão (a página convertida ficou quase em branco). Esse PDF é um scan em formato incompatível (JBIG2). Contorno: tire um print/foto do documento e anexe como imagem JPEG.

### Caso 2 — a NF 1037746 nunca apareceu nas pendências

Oc 13 (`ENDERECO NAO ENCONTRADO (SSWMOBILE)`) lançada em 28/08 15:36 na filial BHE, CTRC PRT562381-2. Não foi tratada. O caso só apareceu porque **o cliente cobrou retorno**.

## O que foi medido (e não presumido)

O diagnóstico não saiu de leitura de código. Saiu de medição.

**Caso 1.** Baixei o arquivo do storage e olhei por dentro: 22 imagens `JBIG2Decode` + 2 `DCTDecode`, 2 páginas — é o padrão MRC de scan comprimido, o JBIG2 é real. Depois rodei o **PDFium** (o motor do `converter-anexo-pdf`, que decodifica JBIG2) localmente sobre os arquivos reais de produção:

| Arquivo | Página | Tinta | Realidade |
|---|---|---|---|
| `10803714.pdf` (União Química / Larissa) | 1 | 6,41% | ok |
| `10803714.pdf` | 2 | **1,37%** | **legível** |
| `Scanned_from_a_Lexmark….pdf` (AGV / **Maria**) | 4 | **1,23%** | **legível** |
| `minuta assinada.pdf` (quebra CALADA: 0,38% no pdf.js) | 1 | 2,53% | ok |
| `NF 135724.pdf` (âncora da ADR 0014) | 1 | 6,16% | ok |

E renderizei as duas páginas reprovadas em PNG **para olhar**: a pág. 2 do `10803714.pdf` é o "DOCUMENTO DE TRANSPORTE 10803714", com placa manuscrita `SEM-7B68`, data `22/07/26` e código de barras; a pág. 4 do Lexmark é uma ficha "AGENDAMENTOS / Coleta na AGV" com placa e motorista à mão. **Documentos perfeitamente legíveis, reprovados pelo guard.**

### Contraprova no motor REAL do front (pdf.js), 08/09

O PDFium é o motor do **servidor**. Como a decisão acontece no front, montei um harness que replica o `convertPdfBlobToJpegFiles` fielmente — `pdfjs-dist@5.7.284` legacy + `wasmUrl` + render em canvas na escala 2.5 + hook no `console.warn` + o mesmo predicado de pixel — e rodei nos arquivos reais:

| arquivo | pág | **pdf.js** | PDFium | política nova |
|---|---|---|---|---|
| `10803714.pdf` | 1 | **6,34%** | 6,41% | passa |
| `10803714.pdf` | 2 | **1,35%** | 1,37% | **confirma (prévia)** |
| `Scanned_from_a_Lexmark….pdf` | 4 | **1,22%** | 1,23% | **confirma (prévia)** |
| `minuta assinada.pdf` | 1 | **2,48%** | 2,53% | passa |
| `NF 135724.pdf` | 1 | **6,03%** | 6,16% | passa |

Os dois motores concordam dentro de **0,15 pp**. E o resultado reproduz exatamente o que a produção mostrou no print da Larissa: pág. 1 passa, pág. 2 é a reprovada — o que valida o harness contra a realidade.

**Correção de premissa (importante):** a ADR 0014 registra `minuta assinada.pdf` quebrando **calado** a 0,38%. Isso **não reproduz mais** — hoje o arquivo renderiza 2,48% e passa. Aquela medição é de 17/07 e o `wasmUrl` entrou em **25/07**, depois dela. Logo o 0,38% é da era pré-wasm e não serve de âncora viva.

Isso obrigou a **recalibrar o piso de 0,5% em dado novo**. Rodando o pdf.js sem conseguir carregar o wasm (`Jbig2Error: JBig2 failed to initialize`) sobre o mesmo arquivo, medi a classe "decodificador desligado": pág. 1 = **0,42%**, pág. 2 = **0,10%**. Então o piso de 0,5% fica entre **0,42%** (falha) e **1,22%** (conteúdo legítimo) — fronteira **medida**, não estimada. E o cenário que ele protege é real e concreto: se os assets de `public/pdfjs-wasm/` deixarem de ser servidos, as páginas caem pra 0,1–0,4% e são **barradas**, em vez de chegarem como prévia em branco pro operador aprovar no automático.

Também verifiquei que a produção **não** está defasada: `cockpit-aisalexpress.vercel.app/pdfjs-wasm/jbig2.wasm` responde 206 `application/wasm`, o bundle publicado contém `pdfjs-wasm`, `ConversaoPdfBloqueadaGuard` e o regex do warning, e os `.wasm` locais são byte-a-byte iguais ao `pdfjs-dist@5.7.284` instalado. A hipótese "o wasm não chegou em produção" foi **descartada com evidência**.

**Caso 2.** No Cockpit: zero cards com aquela NF ou CTRC (busquei pelos dois) — o card nunca existiu, não era problema de busca nem de visibilidade. No Bastão a pendência existe e está completa: `oc 13`, `28/08`, `cnpj_pagador 73856593001057` (PRATI DONADUZZI A3), `responsavel_atual "operacao"`, **`responsavel_relacionamento "LARISSA"`**, segmento `018`. Os dois CNPJs da Prati estão na carteira da Larissa. A Prati já tivera **14** cards com oc 13, todos terminando em `TRANSFERIDO`.

## Decisão

### 1. Sinal fraco de qualidade pede olho humano; não reprova sozinho (INV-147)

O piso de 2% de pixels não-brancos **não foi mexido**. A medição mostra que mexer nele não resolve: conteúdo legítimo (1,23%) e conversão quebrada (0,38%) ocupam a mesma faixa estreita, e o próprio arquivo que quebra calado renderiza a 2,53% quando o motor funciona. **Nenhum limiar separa as duas classes com margem confiável.**

O que muda é a **consequência** de cada sinal, no front:

| Sinal | Antes | Agora |
|---|---|---|
| warning do pdf.js (`dependent image isn't ready`) | bloqueia o PDF todo | **bloqueia** (igual) |
| tinta `< 0,5%` (folha praticamente vazia) | bloqueia o PDF todo | **bloqueia** (igual) |
| tinta entre `0,5%` e `2%` | bloqueia o PDF todo | **prévia na tela, operador decide** |
| tinta `>= 2%` | passa | passa |

E a decisão passa a ser **por página**: uma página reprovada não derruba as outras (no caso real, a pág. 1 a 6,41% ia pro lixo junto).

O corte de 0,5% é escolhido com `n=1` na classe "quebrada" — e isso é aceitável porque ele **não** separa "barrar" de "aceitar calado", separa "barrar" de "perguntar pro humano". Se uma quebra futura cair na faixa 0,5–2%, chega como prévia em branco na tela e o operador descarta. O erro é visível.

**Assimetria deliberada com o servidor:** `_shared/pdf-conversao-guard.ts` mantém bloqueio duro. Lá não existe humano (conversão autônoma do romaneio pelo `veto-agendamento`). Mesmo limiar, política diferente — documentado nos dois arquivos e travado por teste, pra ninguém "restaurar a paridade" e reabrir o buraco.

### 2. Visibilidade e autonomia da oc 13 são interruptores separados (INV-148)

`cliente_config_oc13` era **um interruptor pra duas coisas**: o card aparecer *e* o `agente-oc13-autonomo` agir. Medido em 08/09: 962 decisões do agente (**23 delas 100% autônomas**), **1.379** oc 21 lançadas com sucesso, flag `acao_autonoma_veto_enabled` **ligada**, LARISSA habilitada no trilho de veto de 60 min.

Regra do negócio, verbatim (Carlos, 08/09): **"o cliente sempre precisa ser notificado antes e somente com a autorização deles é possível seguir."** Um robô que lança oc 21 e cancela reentrega sozinho contraria isso frontalmente.

Portanto: coluna `autonomo_ativo`, lida **só** pelo agente; `ativo` continua sendo a visibilidade, lida **só** pelo sync. Cliente novo nasce visível e sem robô.

### 3. A Prati entra na exceção — visível, sem robô

Premissa confirmada pelo Carlos: a reentrega da Prati **não** é automática. Então o card precisa aparecer. Blast radius medido: **+1 card** (a própria NF 1037746). O segundo CNPJ do grupo tem 0 pendências abertas.

### 4. A telemetria do front era cega — e isso é causa raiz própria

`ConversaoPdfBloqueadaGuard` **nunca** gravou um evento do front. O `actor_id` era a string `"front-conversao-pdf"`, mas a política `card_events_insert_operator` exige `actor_id = current_operador_id()`; o insert era recusado e engolido pelo `catch` de best-effort. Os 2 únicos eventos do banco vinham do servidor (`converter-anexo-pdf`).

Consequência séria: **a ADR 0014 definiu como critério de decisão do conversor server-side "contar `ConversaoPdfBloqueadaGuard` por 2–4 semanas"** — e o contador estava quebrado desde o começo. O critério nunca pôde ser avaliado, e o bug chegou por reclamação de operadora em vez de métrica.

## Alternativas descartadas

- **Baixar o piso de 2% pra 0,5%** — era o plano inicial. Descartado pela medição do `minuta assinada.pdf`: ele renderiza a 2,53% com motor bom, o que prova que a faixa de tinta não é discriminante. Trocar 2% por 0,5% só moveria a fronteira do falso positivo, sem resolver a classe.
- **Mandar o modal chamar o `converter-anexo-pdf`** — não resolveria: a edge usa o **mesmo** piso de 2% e reprovaria igual (foi o que aconteceu com a Maria, cujo bloqueio veio do servidor). Além disso é `service role only`. Fica como dívida com caminho claro (ver abaixo).
- **Confiar só no warning do pdf.js** — refutado pela ADR 0014 com caso real: `minuta assinada.pdf` quebra **sem** warning nenhum.
- **Pôr a oc 13 como Relacionamento no dicionário** — resolveria a visibilidade de todos, mas derrubaria ~120 cards de uma vez em todas as carteiras (contagem do Bastão, 08/09). Mesmo padrão do "cron dormente não é neutro".
- **Só incluir a Prati na lista, sem separar os interruptores** — é o que parecia ser o fix de 1 linha. Ligaria o robô pra ela e violaria a regra do cliente autorizar antes.
- **`ADD COLUMN autonomo_ativo DEFAULT false`** — preencheria as 15 linhas existentes com `false` e desligaria a autonomia de O.V.D., Ferramentas Gerais, União Química, Black & Decker, F E F e Fortpel de uma vez. Regressão silenciosa em 4 carteiras. Por isso a coluna nasce **nula** (mig 385, TIPO A) e o default seguro entra na 386, que já é TIPO B.

## Próximo passo (dívida registrada, não feita)

O PDFium renderiza corretamente **exatamente os arquivos que o pdf.js perde** (`minuta assinada.pdf` 2,53%, `NF 135724.pdf` 6,16%). O fallback certo pro sinal do warning é mandar o arquivo pro `converter-anexo-pdf` em vez de exigir print/foto do operador. Requer tornar a edge chamável pelo operador (hoje `service role only`) — o que **não adiciona privilégio novo**, já que o front hoje já sobe imagem arbitrária pro card via `upload-anexo-email`. Ficou fora desta correção para não ampliar o raio. Com a telemetria consertada, agora dá pra medir se se paga.

## Guards

- `pdfConversaoGuard.test.ts` — 17 testes (eram 6), com os valores medidos como âncora **nas duas direções**: 1,37% e 1,23% *têm* que virar "confirmar"; 0,38% *tem* que continuar "bloquear"; e o piso de 0,5% tem que continuar entre os dois.
- `pdf-conversao-guard.test.ts` (servidor) — teste novo do INV-147 travando a assimetria: 1,37% segue **bloqueado** onde não há humano.
- `oc13-visibilidade-vs-autonomia.test.ts` — 4 testes de código-fonte (INV-148) nas duas direções: o agente tem que ler `autonomo_ativo !== false`; o `sync-bastao` e o `bastao-client` **não** podem olhar essa coluna.
- Itens novos no `/verify-cockpit`.

## Verificação executada nesta branch

| Suíte | Baseline (master `7127a48`) | Nesta branch |
|---|---|---|
| `deno test _shared/` | 1145 passed / 2 failed | **1150 passed / 2 failed** (mesmas 2 pré-existentes) |
| `vitest run` (front) | 32 arquivos / 227 testes | **32 arquivos / 238 testes**, 0 falhas |
| `tsc --noEmit` (front) | limpo | **limpo** |
| `deno check agente-oc13-autonomo` | 10 erros | **10 erros — diff vazio**, nenhum novo |

As 2 falhas do backend são as pré-existentes conhecidas (`regras-auto-acao.sem-email-54`, `tools-registrados-no-front`). Os 10 erros do `deno check` são dívida antiga daquele arquivo (`propostaDestacadaAcao` usada antes da declaração + genéricos do `SupabaseClient`), verificada byte-a-byte contra o master.

**Migrations NÃO aplicadas. Nada deployado.** Ordem obrigatória quando autorizado: mig 385 → 386 → 387 → deploy do `agente-oc13-autonomo` → deploy do front. O agente tolera a coluna ausente (fallback ao comportamento antigo com aviso no log), então ordem invertida não derruba o cron — mas também não entrega a proteção.

## Implantação em produção — 2026-09-08 (registro do que realmente rodou)

Autorização: Carlos, 08/09, no chat — *"siga com precisa ser feito e realize e
deployu, estando tudo 100%; apague a brench. garanta que nao quebre nada e nem
que tenha regressão. nunca presuma, apenas trabalhe com certeza."*

### Ordem executada (e por que ela mudou no meio)

| # | O quê | Quando | Resultado verificado |
|---|---|---|---|
| 1 | mig **385** (`ADD COLUMN autonomo_ativo`, TIPO A) | 15:4xZ | coluna criada, sem default, nullable; as 15 linhas ficaram NULL → zero mudança de comportamento |
| 2 | mig **386** (carimba `true` nos 15 + `DEFAULT false` + `NOT NULL`, TIPO B) | 15:5xZ | `default=false`, `nullable=NO`, e `ligados=15 / desligados=0 / nulos=0` — nenhuma carteira perdeu autonomia |
| 3 | mig **387** (PRATI: `ativo=true, autonomo_ativo=false`, TIPO B) | 15:5xZ | 17 linhas, 15 com robô, 2 sem |
| 4 | mig **388** (TRAVA: PRATI `ativo=false`) | 15:56Z | **não estava no plano** — ver abaixo |
| 5 | deploy `agente-oc13-autonomo` + `converter-anexo-pdf` | 15:56Z | v57 e v3; `deploy_pendente.py` → "nenhuma função pendente" |
| 6 | mig **389** (destrava PRATI `ativo=true`) | 16:00:3xZ | 17 visíveis, 15 robô ligado, 2 robô desligado |

### A trava da 388 — o furo que a ordem "migrations primeiro" abriu

Aplicar 385/386/387 antes do deploy **ligou a feature pela metade, e a metade
perigosa primeiro.** A versão então em produção do `agente-oc13-autonomo` não
conhecia `autonomo_ativo`: ela selecionava `cnpj_pagador ... where ativo = true`.
Com a PRATI em `ativo=true`, o agente **deployado** a tratava como elegível e
podia lançar oc 21 + cancelar reentrega via `auto_aprovar_e_executar`, sem
aprovação por card — exatamente o que a regra do cliente proíbe.

O `sync-bastao` fecharia a corrente sozinho: ele lê só `ativo` (INV-148) e já
estava deployado, então criaria o card de oc 13 da Prati no ciclo seguinte.

Estado medido na hora: cron 23 (agente) `3-59/5`, active, execução 15:38Z
`succeeded`; cron 27 (sync) `*/30`, próxima 16:00Z. Restavam ~6 minutos, e
ocorrência lançada no SSW não tem desfazer (advertência da mig 383). Optei por
travar antes de deployar em vez de correr o deploy contra o relógio.

Descartado: desligar o cron 23. Pararia a autonomia das 15 carteiras legítimas
(regressão ampla) e religar varre backlog acumulado. A trava escopada nos 2
CNPJs foi a ação mínima.

O risco **não se materializou**: quando a 388 entrou havia só 2 cards da Prati,
ambos de 04/05 e ambos `CANCELADO`, nenhum de oc 13.

### Por que "OK" no `deploy_pendente.py` não bastou como prova

Duas evidências que pareciam prova e **não são**:

* `deploy_pendente.py` compara **data** — último commit que toca o conjunto de
  imports transitivos vs `updated_at` da Management API. Não compara conteúdo.
* `succeeded` em `cron.job_run_details` só diz que o HTTP respondeu. E o agente
  só grava em `agent_runs` quando tem card pra processar, então a execução de
  15:58Z não deixou registro nenhum.

A prova aceita foi `supabase functions download` das duas funções + `diff`
contra o master:

* agente: **14/14** arquivos byte-a-byte idênticos; o bundle em produção contém
  `excecaoRows.filter((r) => r.autonomo_ativo !== false)` (index.ts:151);
* conversor: **3/3** idênticos, com `PISO_PIXELS_NAO_BRANCOS = 0.02` confirmado
  no bundle — o bloqueio duro do servidor (INV-147) segue intacto.

Só depois disso a 389 destravou a PRATI.

### Contraprova pós-implantação

* Fase 7 do `/verify-cockpit`: **PASS** nas 5 linhas (gate libera deploy
  legítimo, gate bloqueia função proibida, marcadores do manifest presentes,
  `dbq.py --selftest` OK, `deploy_pendente` exit 0 e zerado).
* INV-147: **PASS** (`piso=1 sem_tinta=3 politica=2 servidor_duro=2
  actor_literal=0 test=PASS`).
* INV-148: **PASS** (`agente=9 filtro=1 sync_limpo=0 client_limpo=0
  query_oc13=1 test=PASS`).
* INV-027b e INV-095 (também tocam o arquivo do agente): PASS.
* INV-089 dá 0 arquivos com `autoAprovarSeFatiaAutonoma` — **idêntico em
  `7127a48`, antes desta correção**. FAIL pré-existente: o símbolo mora só em
  `_shared/autonomia-fatias.ts` e o grep do invariante está desatualizado. Não é
  regressão desta entrega; fica registrado como dívida do próprio invariante.
* Suítes na árvore mesclada: backend **1155 passed / 2 failed** (os mesmos dois
  que já falhavam em `7127a48`), front **240/240**, `tsc --noEmit` limpo.

### Achado: BUG no classificador do `dbq.py` (corrigido aqui)

As migs 388 e 389 foram classificadas como **TIPO A** pelo `dbq.py`, apesar de
serem `UPDATE` em tabela de produção. Passei `--autorizado-por` nas duas de
qualquer forma (pelo critério do cabeçalho, mais conservador que o do script) —
e fui atrás do motivo em vez de deixar como curiosidade.

**Causa raiz, reproduzida em isolamento:** o gatilho TIPO B do UPDATE era

```python
re.compile(r"UPDATE\s+(?:ONLY\s+)?[a-z_\".]+\s+SET", re.I)
```

A classe `[a-z_\".]+` **não inclui `0-9`**. Em `UPDATE public.cliente_config_oc13
SET ...` ela consome até `..._oc`, tropeça no `1`, e o `\s+SET` não casa. O
UPDATE some do radar e a migration escapa da exigência de `--autorizado-por`.

Contraprova direta (mesma tabela, com e sem dígito):

| SQL | Antes | Depois |
|---|---|---|
| `UPDATE public.cliente_config SET ativo=false ...` | B | B |
| `UPDATE public.cliente_config_oc13 SET ativo=false ...` | **A** | B |
| `UPDATE public.cards2 SET x=1 ...` | **A** | B |
| `DELETE FROM public.cliente_config_oc13 ...` | B | B |

O `DELETE` não tinha o problema porque o regex dele é só `DELETE\s+FROM`,
sem nome de tabela. E o selftest não pegava porque todos os seus casos usavam
nomes sem dígito (`feature_flags`, `cards`, `todos`).

**Fix:** `[a-z0-9_\".]+` na classe, com o porquê no comentário, mais 3 casos
novos no selftest (tabela com dígito, `cards2`, e a forma multi-linha que é como
as migrations do repo escrevem). `dbq.py --selftest` é a Fase 7.1 do
`/verify-cockpit`, então o guard já está no trilho — não precisou de INV novo.

Depois do fix, as minhas reclassificam certo: 385 A, 386 B, 387 A, 388 B, 389 B.

**Exposição histórica medida:** varri `migration/*.sql` comparando os dois
regexes. Duas migrations antigas tinham `UPDATE` que o gate deixou passar como
TIPO A na época — `2026-05-18_116_dias_uteis_pendentes_finalizadas.sql` e
`2026-08-27_362_oc49_sombra_e_monitor.sql`. Já rodaram; fica o registro, não há
o que desfazer.

### Dívida NÃO corrigida: seed de config com `ativo=true`

A mig 387 classifica como TIPO A e **isso é por desenho**, não bug: o `dbq.py`
trata `cliente_config*` como seed de configuração, e o comentário do
`TABELAS_OPERACIONAIS` diz que seed é TIPO A "quando idempotente e nascendo
desligado". A minha 387 é idempotente (`ON CONFLICT DO NOTHING`) mas entra com
`ativo=true` — ou seja, nasce com a VISIBILIDADE ligada, e é justamente isso que
muda o que o `sync-bastao` puxa.

O classificador não verifica a condição "nascendo desligado" para essas tabelas.
Não mexi: fechar isso reclassificaria seeds antigos e é decisão de política, não
de código. Registrado aqui pra quem revisar a `docs/POLITICA_MIGRATIONS.md`.

## Contraprova de ponta a ponta — 2026-09-08 16:31Z a 16:56Z

O que faltava era provar o comportamento no fluxo real, não só na configuração.
O Bastão tinha uma pendência de oc 13 aberta pra Prati **do próprio dia**:
NF `001040401`, CTRC `AMB588440-3`, `cod_ultima_ocorrencia=13`,
`data_ultima_ocorrencia=2026-09-08` (verificado via REST no Bastão).

Depois do destravamento (mig 389, 16:00:30Z), a primeira `sync-bastao` foi a de
**16:30:00Z**. Resultado medido:

| O que se esperava | O que aconteceu |
|---|---|
| card nasce na fila do operador | **card `4bf3e59f-7162-423e-b6ad-195219457107` criado 16:31:04Z**, NF 1040401, CTRC AMB588440-3 |
| responsável = a operadora do caso | `responsavel_relacionamento = LARISSA` |
| estado = validação humana explícita | `state = AGUARDANDO_VALIDACAO_HUMANA`, 5 to-dos propostos |
| eventos só de importação, sem ação | `BastaoCardImportado` + `TodoPropostoAutomaticamente`, ambos `actor=system/sync-bastao` |
| agente NÃO age | `acoes_executadas_ssw = 0`, `acoes_agendadas = 0`, `agente_oc13_feedback = 0`, `agent_runs = 0` |

O "não agiu" só tem valor porque o agente **rodou**: `cron.job_run_details`
registra **5 execuções** do job 23 entre 16:31:04Z e 16:53:00Z, todas depois de
o card existir. Cinco oportunidades de agir, zero ações.

É exatamente a regra do negócio: a Prati **aparece** (deixa de ser invisível,
que era a causa da NF 1037746 morrer) e o robô fica **quieto**, esperando o
cliente ser notificado e autorizar.

**Armadilha de medição no caminho:** a minha primeira sonda filtrava
`cards.pagador in ('73856593001057', ...)` e devolvia 0 — conclusão errada de
que o card não nascera. `cards.pagador` guarda o **nome** do cliente
(`PRATI DONADUZZI E CIA LTDA`), não o CNPJ. Achei o card buscando por NF e CTRC.
Quem for conferir isso de novo: filtre por NF/CTRC, ou por `pagador ilike`.

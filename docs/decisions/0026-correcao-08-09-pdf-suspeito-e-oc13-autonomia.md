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

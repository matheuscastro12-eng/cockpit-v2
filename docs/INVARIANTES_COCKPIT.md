# INVARIANTES_COCKPIT.md — Regras que NÃO podem ser violadas

Catálogo canônico de invariantes da arquitetura Cockpit v2. Cada invariante tem comando de verificação **executável** — não apenas descrição textual.

**Quando atualizar:** todo bug post-mortem que cruza ≥ 2 arquivos críticos vira novo `INV-NNN` aqui (regra durável).

**Como usar:**
- Operador editando arquivo crítico → hook PreToolUse exibe lista de INVs aplicáveis.
- `/verify-cockpit` Fase 8 executa cada INV e reporta PASS/FAIL.
- Bug em produção → procura INV violado. Se nenhum bate, escreve novo INV pro cenário.

---

## INV-001 — Bastão é INPUT canônico; SSW interno é SAÍDA

**Regra:** Cards entram no Cockpit via Bastão (sync periódico). Decisões de SAÍDA (TRANSFERIDO/RESOLVIDO/AGUARDANDO_CLIENTE/AVH) consultam SSW interno (opção 101). Tracking SSW público (`lib/ssw-tracking-client.ts`) está deprecated — sem novos callers.

**Arquivos:** todos os edge functions que decidem destino de card. Hot paths: `sync-bastao`, `voltar-para-to-do-com-rastreio`, `r-evidencia`, `executor`, `_shared/verificar-evidencia.ts`.

**Como verificar:**
```bash
grep -RIn 'from.*"\.\..*ssw-tracking-client' supabase/functions/ 2>/dev/null \
  | grep -v "@deprecated\|//\|_shared/ssw-tracking-client.ts" \
  | wc -l
# = 0 → PASS. > 0 → FAIL (novo caller do tracking público).
```

**Memory:** [project_ssw_interno_fonte_saida.md](memory/project_ssw_interno_fonte_saida.md), [project_tracking_publico_deprecated.md](memory/project_tracking_publico_deprecated.md)
**ADR:** [docs/decisions/0005-ssw-interno-fonte-canonica-saida.md](decisions/0005-ssw-interno-fonte-canonica-saida.md)
**Cenário real:** múltiplos bugs de latência RPA Bastão (NFs 26298, 64409, 422589, 1075381).

---

## INV-002 — `confirmar-acao-executada-ssw` PRESERVA snapshot Bastão pré-lançamento

**Regra:** ao mover card de ACAO_EXECUTADA → state final via SSW interno, o helper NÃO pode zerar `bastao_oc_no_lancamento` nem `bastao_updated_at_no_lancamento`. Esses 2 campos compõem a referência histórica que o Pass A do sync-bastao usa pra distinguir "Bastão re-importou mesmo snapshot" de "Bastão atualizou com nova tratativa".

**Arquivos:** `supabase/functions/_shared/confirmar-acao-executada-ssw.ts`.

**Como verificar:**
```bash
# Ausência de "bastao_oc_no_lancamento: null" e "bastao_updated_at_no_lancamento: null"
# dentro de updates do card.
grep -E "bastao_oc_no_lancamento:\s*null|bastao_updated_at_no_lancamento:\s*null" \
  supabase/functions/_shared/confirmar-acao-executada-ssw.ts | wc -l
# = 0 → PASS. > 0 → FAIL (campo sendo limpo — bug NF 1075381 voltou).
```

**Memory:** [feedback_bastao_oc_no_lancamento_guard.md](memory/feedback_bastao_oc_no_lancamento_guard.md)
**Cenário real:** NF 1075381 reabriu indevidamente em 2026-05-14 porque o helper limpava o snapshot, anulando a guarda do Pass A.

---

## INV-003 — Pass A `voltouParaRelacionamento` usa guard por OC do lançamento + safeguard 24h

**Regra (final 2026-05-23):** card que já passou por lançamento (`bastao_oc_no_lancamento != null`) e Bastão mostra a MESMA oc do lançamento → `bastaoEhMesmoSnapshotDoLancamento = true` → `voltouParaRelacionamento = false` → NO-OP completo (não muda state, não cria todo, não cancela nada).

**SAFEGUARD INVIOLÁVEL (Caio 2026-05-23):** se passou >24h desde `bastao_updated_at_no_lancamento` E Bastão ainda sinaliza oc de relacionamento → REABRE incondicionalmente. Invariante "oc de relacionamento SEMPRE no Cockpit" tem precedência absoluta. Não introduz o loop antigo da mig 095 porque o intervalo é DIÁRIO, não por update RPA (geralmente 15-60min).

Operação re-tratativa com oc DIFERENTE → guard libera → reabertura normal via `stateFinalAposBastao`. Re-tratativa com MESMA oc + <24h é caso raro tratado por outros canais (vinculador via email do cliente, ATUALIZAR AGORA manual da Larissa). >24h: safeguard libera incondicionalmente.

**Histórico:** versões anteriores tentaram tupla `(oc + updated_at)` (migration 095) e `pendencia_id` (migration 096). Ambas falharam porque o Bastão muda `updated_at` e `pendencia_id` várias vezes por hora sem mudança semântica de oc. Discriminador final = oc + safeguard temporal 24h (Caio 2026-05-23 após NFs 286697/47187/1005069/756800/693706 perdidas eternamente).

**Arquivos:** [sync-bastao/index.ts:706-718](../supabase/functions/sync-bastao/index.ts#L706-L718) (`upsertCardFromPendencia`).

**Como verificar:**
```bash
# (a) Guard existe
grep -c "bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts
# >= 2 (declaração + uso) → PASS

# (b) SELECT do Pass A carrega bastao_oc_no_lancamento (sem isso guard vira letra morta)
grep -E '\.select\([^)]*bastao_oc_no_lancamento' supabase/functions/sync-bastao/index.ts | head -1
# match → PASS, vazio → FAIL

# (c) Guard usa oc (não pendencia_id ou updated_at — discriminadores que falharam)
grep -A 4 "const bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts \
  | grep -q "p.cod_ultima_ocorrencia === bastaoOcNoLancamento"
# match → PASS

# (d) Cards travados em loop (state=AVH+lock + oc=oc_no_lançamento + acao_executada_em IS NULL) ≤ 5
psql "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and lock_aguardando_validacao=true and bastao_oc_no_lancamento is not null and cod_ultima_ocorrencia = bastao_oc_no_lancamento and acao_executada_em is null and bastao_synced_at > now() - interval '1 hour';"
# 0 → PASS (mais que isso = loop está acontecendo de novo)
```

**Memory:** [feedback_pass_a_select_completo.md](memory/feedback_pass_a_select_completo.md), [feedback_bastao_oc_no_lancamento_guard.md](memory/feedback_bastao_oc_no_lancamento_guard.md)
**Cenário real:** 2026-05-14 — 5 NFs (1005270, 177817, 1074810, 20958, 1006425) em loop de reabertura. Larissa retrabalhou cada uma múltiplas vezes antes do fix final.
**Cenário oposto (não pode bloquear):** Bastão mostra oc nova (ex: oc=49 após oc=20 do lançamento) — guard libera, card reabre pra Larissa rastrear.

---

## INV-004 — Pass A SEMPRE preserva campos críticos no `agent_state`

**Regra:** quando Pass A reescreve `agent_state` (UPDATE de card existente), PRECISA preservar `chave_cte`, `propostas_recusadas_em`, `propostas_recusadas_para_oc`, `bastao_updated_at`. Esses campos vêm de outros lugares (chave-cte-resolver, voltar-para-to-do-com-rastreio, snapshotFromPendencia) e são lidos por callers downstream.

**Arquivos:** `supabase/functions/sync-bastao/index.ts`.

**Como verificar:**
```bash
# Bloco de preservação no Pass A (em volta da declaração de agentStateNovo)
grep -A 25 'agentStateExistente = ' supabase/functions/sync-bastao/index.ts \
  | grep -E "chave_cte|propostas_recusadas_em|propostas_recusadas_para_oc|bastao_updated_at" \
  | wc -l
# >= 4 → PASS (todas as 4 chaves citadas no bloco).
```

**Memory:** [project_chave_cte_lookup_obrigatorio.md](memory/project_chave_cte_lookup_obrigatorio.md), [project_cooldown_recusa_sugestoes.md](memory/project_cooldown_recusa_sugestoes.md)
**Cenário real:** NF 422476 (chave_cte perdida); NFs 64409/422589 (cooldown propostas_recusadas perdido).

---

## INV-005 — `voltar-para-to-do-com-rastreio` consulta SSW interno (NÃO tracking público)

**Regra:** o botão "Recusar Ações Sugeridas" decide destino do card via `ssw-internal-client.obterSessao + buscarNFInterno + listarOcorrenciasNF`, não via cliente do tracking público.

**Arquivos:** `supabase/functions/voltar-para-to-do-com-rastreio/index.ts`.

**Como verificar:**
```bash
# Não pode importar createSswTrackingClient.
grep -q "createSswTrackingClient" supabase/functions/voltar-para-to-do-com-rastreio/index.ts
[ $? -ne 0 ] && echo PASS || echo FAIL
# DEVE importar buscarNFInterno.
grep -q "buscarNFInterno" supabase/functions/voltar-para-to-do-com-rastreio/index.ts
[ $? -eq 0 ] && echo PASS || echo FAIL
```

**Memory:** [project_ssw_interno_fonte_saida.md](memory/project_ssw_interno_fonte_saida.md)
**Cenário real:** loop voltar_para_to_do das NFs 64409/422589 (cooldown só foi suficiente após migração pro interno).

---

## INV-006 — oc=54 ⟺ state=AGUARDANDO_CLIENTE (exceto `cliente_respondeu_em != null`)

**Regra:** card com `cod_ultima_ocorrencia=54` precisa estar em state `AGUARDANDO_CLIENTE`, SALVO se `cliente_respondeu_em IS NOT NULL` (aí vai pra AVH+lock pra Larissa decidir).

**Arquivos:** `supabase/functions/sync-bastao/index.ts` (Pass A `forcaAguardandoClienteOc54`), `supabase/functions/_shared/transicao-aguardando-cliente.ts`.

**Como verificar (SQL contra produção, read-only):**
```sql
SELECT count(*)
FROM cards
WHERE cod_ultima_ocorrencia = 54
  AND state != 'AGUARDANDO_CLIENTE'
  AND cliente_respondeu_em IS NULL
  AND state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO');
-- = 0 → PASS. > 0 → FAIL (cards oc=54 em state errado).
```

**Memory:** [project_aguardando_cliente_state.md](memory/project_aguardando_cliente_state.md)
**Cenário real:** bug 2026-05-12 removeu 54 do set OCORRENCIAS_DE_RELACIONAMENTO; Pass B moveu 49 cards de AGUARDANDO_CLIENTE pra TRANSFERIDO.

---

## INV-007 — state `ACAO_EXECUTADA` é blindado contra Pass B

**Regra:** Pass B (release de cards que saíram do Bastão) NUNCA pode mexer em card `state='ACAO_EXECUTADA'`. Card nesse state está aguardando confirmação SSW/Bastão; Pass G/H + executor-inline cuidam.

**Arquivos:** `supabase/functions/sync-bastao/index.ts` (`runPassB`).

**Como verificar:**
```bash
# Filtro do SELECT de runPassB exclui ACAO_EXECUTADA. Busca direta pelo
# .not("state","in",...) — robusta a comentários entre from("cards") e o filtro
# (o -A 5 antigo quebrou quando o ADR 0012 (sync único) inseriu comentários, 2026-06-18).
grep -E '\.not\("state",[[:space:]]*"in",.*ACAO_EXECUTADA' supabase/functions/sync-bastao/index.ts
# != "" → PASS.
# Defesa em profundidade: early-skip explícito no loop.
grep -E '\["state"\][[:space:]]*===[[:space:]]*"ACAO_EXECUTADA"' supabase/functions/sync-bastao/index.ts
# != "" → PASS adicional.
```

**Memory:** [project_loop_passb_passa_lock_travado.md](memory/project_loop_passb_passa_lock_travado.md), [project_acao_executada_state.md](memory/project_acao_executada_state.md)
**Cenário real:** NFs 692021, 20761 (Pass B movia ACAO_EXECUTADA → TRANSFERIDO durante latência RPA).

---

## INV-008 — `stateFinalAposBastao` é fonte única de mapeamento oc→state

**Regra:** toda transição oc→state final (RESOLVIDO/TRANSFERIDO/AGUARDANDO_CLIENTE/AVH) passa pelo helper canônico [`stateFinalAposBastao`](supabase/functions/_shared/bastao-rules.ts). Não duplicar a tabela em outros lugares (state hard-coded por oc).

**Arquivos:** `supabase/functions/_shared/bastao-rules.ts` define; demais leem.

**Como verificar:**
```bash
# Quem ATRIBUI state literal (TRANSFERIDO/RESOLVIDO/AGUARDANDO_CLIENTE) por oc:
grep -RIn 'state.*=.*"\(TRANSFERIDO\|RESOLVIDO\|AGUARDANDO_CLIENTE\|AGUARDANDO_VALIDACAO_HUMANA\)"' supabase/functions/ \
  | grep -v "stateFinalAposBastao\|stateFinal\.state\|_shared/bastao-rules.ts\|//\|test\|describe" \
  | wc -l
# Esse número é a baseline atual (alguns paths legacy permanecem). Validação humana:
# se aumentar muito sem justificativa, FAIL.
```

**Memory:** [project_ssw_interno_fonte_saida.md](memory/project_ssw_interno_fonte_saida.md)
**Cenário real:** transições inconsistentes entre Pass A/Pass G/voltar-para-to-do antes da consolidação.

---

## INV-009 — Edge functions internas têm `verify_jwt=false` no config.toml

**Regra:** funções chamadas só edge-to-edge (cron, pgmq consumer, invokeNext) PRECISAM ter `verify_jwt = false` no `supabase/config.toml`. Sem isso, gateway Supabase devolve 401 silencioso quando chamada com service_role.

**Arquivos:** `supabase/config.toml`.

**Como verificar:**
```bash
# Lista esperada de funções internas:
INTERNAS="triador vinculador executor redator redator-email-saida sync-bastao \
audit-invariante cron-ia-resposta-pendentes gmail-poll-inbox processar-acoes-agendadas \
ingestor interpretador-resposta-cliente"
for f in $INTERNAS; do
  grep -A1 "\[functions\.$f\]" supabase/config.toml | grep -q "verify_jwt = false"
  [ $? -eq 0 ] && echo "  $f: PASS" || echo "  $f: FAIL"
done
```

**Memory:** [feedback_interpretador_verify_jwt_false.md](memory/feedback_interpretador_verify_jwt_false.md)
**Cenário real:** NFs 62870/351954 ficaram em CLIENTE RESPONDEU sem sugestão IA por dias.

---

## INV-011 — Callers de `temEvidenciaParaOc` / `verificarEvidenciaESinalizar` PASSAM `ctrcEsperado` quando há card com ctrc

**Regra:** NFs com reentrega ou complementar têm múltiplos CTRCs no SSW. Sem `ctrcEsperado`, `buscarNFInterno` rejeita com "múltiplos CTRCs retornados — exige ctrcEsperado". O caller interpreta isso como "evidência ausente" — falso negativo. Quem tem `card.ctrc` (ou `pendencia.ctrc`) DEVE propagar pra esses helpers.

**Arquivos:**
- `supabase/functions/executor/index.ts` (chamada de `temEvidenciaParaOc` pré-email; SELECT do card inclui `ctrc`)
- `supabase/functions/revalidar-evidencia-card/index.ts` (idem)
- `supabase/functions/sync-bastao/index.ts` (chamada de `verificarEvidenciaESinalizar` em criação de card via Pass A; passa `p.ctrc`)
- `supabase/functions/vinculador/index.ts` (idem em criação via mensagem do cliente; passa `p.ctrc`)
- `supabase/functions/_shared/verificar-evidencia.ts` (helper canônico — aceita e propaga `ctrcEsperado`)

**Como verificar:**
```bash
# 1. temEvidenciaParaOc deve aceitar ctrcEsperado na assinatura.
grep -c "ctrcEsperado" supabase/functions/_shared/verificar-evidencia.ts
# >= 3 → PASS (declaração na assinatura + uso no buscarNFInterno + propagação em verificarEvidenciaESinalizar).

# 2. Callers DIRETOS de temEvidenciaParaOc passam 5 args.
DIRECT=$(grep -E "temEvidenciaParaOc\(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | grep -v "import\|//\|export" | wc -l | tr -d ' ')
COM_CTRC=$(grep -E "temEvidenciaParaOc\(.*,.*,.*,.*,.*\)" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null \
  | grep -cE "ctrc|null")
# DIRECT == COM_CTRC → PASS.

# 3. verificarEvidenciaESinalizar callers (sync-bastao, vinculador) passam 6 args (ctrc no fim).
SINALIZAR=$(grep -B1 -A6 "verificarEvidenciaESinalizar(" supabase/functions/sync-bastao/index.ts supabase/functions/vinculador/index.ts 2>/dev/null | grep -cE "\.ctrc\s*\?\?\s*null|ctrc:")
# >= 3 chamadas reais → PASS (sync-bastao Pass A + vinculador 2x).
```

**Memory:** [feedback_multiplas_linhas_mesma_oc.md](memory/feedback_multiplas_linhas_mesma_oc.md)
**Cenário real:** NF 20761 oc=10 hoje (2026-05-14 10:46) — Larissa aprovou oc=54+email; executor consultou `temEvidenciaParaOc` sem ctrc; `buscarNFInterno` rejeitou; email bloqueado erradamente com motivo "scrape_indisponivel". Larissa precisou marcar `skip_evidencia=true` pra contornar.

---

## INV-010 — `54` está em `OCORRENCIAS_DE_RELACIONAMENTO`

**Regra:** o set de 15 ocs de Relacionamento DEVE conter o valor `54` (oc=54 é "Cliente"/`AGUARDANDO_CLIENTE`, mas precisa estar no set pra Pass B reconhecer "ainda no escopo do Cockpit").

**Arquivos:** `lib/bastao-rules.ts` (Set literal hardcoded) e `supabase/functions/_shared/bastao-rules.ts` (desde 2026-06-16 carrega o set do dicionário `ocorrencias_dicionario` em cold start e **força** `set.add(54)` independente da planilha — ver [[feedback_bastao_rules_lookup_dicionario_dinamico]]).

**Como verificar:**
```bash
# lib/: Set literal contém 54.
grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" lib/bastao-rules.ts | grep -E "\b54\b"
[ $? -eq 0 ] && echo PASS || echo FAIL
# shared/: 54 forçado via set.add(54) (carga dinâmica do dicionário; não é mais Set literal).
grep -E "set\.add\(54\)" supabase/functions/_shared/bastao-rules.ts
[ $? -eq 0 ] && echo PASS || echo FAIL
```

**Memory:** [project_aguardando_cliente_state.md](memory/project_aguardando_cliente_state.md)
**Cenário real:** bug crítico Caio 2026-05-12 — removeu 54 do set por engano. Pass B passou a tratar oc=54 como fora de escopo e moveu **49 cards** AGUARDANDO_CLIENTE → TRANSFERIDO em horas. Foi reverter na hora.

---

## INV-012 — Consumidores de evidência (IA / email / classificação) usam `obterTodasFotosDaOc`, NUNCA `obterFotoDaOc`

**Regra:** uma ocorrência no SSW pode ter **N fotos** (paginação `01/02/03` no viewer + múltiplas linhas do mesmo código). Qualquer caller que **consuma o conjunto de evidências** (análise de IA Vision, anexo de email ao cliente, classificação automática) DEVE usar `obterTodasFotosDaOc` (baixa todas numa sessão). `obterFotoDaOc` (uma foto por `idx`) é **exclusivo da galeria paginada** — o front itera os idx via header `X-Fotos-Total`. Copiar `obterFotoDaOc(idx:0)` pra um fluxo de evidência = puxar só a 1ª foto = decisão tomada sobre evidência incompleta.

**Arquivos:** definição em `supabase/functions/_shared/ssw-internal-client.ts`. Whitelist autorizada a chamar `obterFotoDaOc`: **somente** `foto-oc-card/index.ts` e `r-evidencia/index.ts` (galeria). Qualquer outro chamador é violação.

**Como verificar:**
```bash
# Nenhum 'await obterFotoDaOc(' fora das 2 telas de galeria.
VIOL=$(grep -RIn "await obterFotoDaOc(" supabase/functions/ 2>/dev/null \
  | grep -vE "foto-oc-card/index\.ts|r-evidencia/index\.ts" | wc -l | tr -d ' ')
[ "$VIOL" -eq 0 ] && echo "INV-012: PASS" || echo "INV-012: FAIL ($VIOL caller(s) fora da galeria — usar obterTodasFotosDaOc)"
```

**Memory:** [feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md](memory/feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md), [feedback_paginadores_tracking_ent_ssw_viewer.md](memory/feedback_paginadores_tracking_ent_ssw_viewer.md)
**Cenário real:** NF 357645 (2026-06-05) corrigiu só a galeria; IA e anexo de email **nunca** iteraram — sempre olhavam a foto 01. NF 355283 oc=49 ALTHAIA (2026-06-18): a IA validou evidência vendo só a caixa, ignorando a 2ª foto (DANFE de devolução, que mudaria a oc). Sintoma reincidente porque cada novo fluxo de evidência copiava o `idx:0`. Raiz: `obterTodasFotosDaOc` centralizou o "todas as fotos".

---

## INV-012b — Galeria do card serve o MANIFESTO (modo `list`) com TODAS as fotos; front renderiza declarativo

**Regra:** a 3ª recorrência do "card puxa só 1 foto" (NF 362406, 2026-06-30) foi no **FRONT**, não no backend — o backend já servia as 8 fotos (`X-Fotos-Total=8`), mas o front mostrava só a 1ª (dependia de iterar idx às cegas pelo header, ou embutia o viewer cru do SSW cujos paginadores `01..08` (`ajaxEnvia('FOT_N')`) só funcionam dentro da sessão do portal). Fix de raiz: `foto-oc-card` ganhou o **modo `list`** (`{ card_id, codigo_oc, list:true }`) que devolve o **manifesto JSON** com a metadata de TODAS as fotos (`fotos_total`, `incompleto`, `fotos:[{idx,…}]`). O front renderiza `manifesto.fotos.map(...)` — não há "lembrar de iterar". A montagem é a função PURA `montarManifestoFotos` (`_shared/foto-oc-manifest.ts`), que **nunca trunca pra 1** (`fotos_total === fotos.length` por construção). O sinal `incompleto:true` (probe de paginação falhou) faz o front avisar em vez de mascarar 8→1.

**Arquivos:** `supabase/functions/_shared/foto-oc-manifest.ts` (puro), `supabase/functions/_shared/ssw-internal-client.ts` (`listarFotosDaOcMetadata` + `incompleto` em `coletarFotosDaOc`), `supabase/functions/foto-oc-card/index.ts` (modo `list`).

**Como verificar:**
```bash
# foto-oc-card wirado no manifesto + teste do manifesto verde.
grep -q "montarManifestoFotos" supabase/functions/foto-oc-card/index.ts && \
deno test --no-check supabase/functions/_shared/foto-oc-manifest.test.ts >/dev/null 2>&1 && \
echo "INV-012b: PASS" || echo "INV-012b: FAIL"
```

**Memory:** [feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md](memory/feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md)
**Cenário real:** NF 362406 oc=49 LARISSA (2026-06-30): SSW com 8 fotos (`01..08`), card mostrava 1. Sonda read-only ao `foto-oc-card` provou `X-Fotos-Total=8` estável (8/8) com binários distintos → backend OK, defeito no front. Prompt: `prompts/lovable-galeria-evidencia-iterar-todas-fotos.md`.

---

## INV-013 — Lançamento de oc no SSW SEMPRE pela conta de serviço `ai.salex` (`readSswLancamentoEnv`)

**Regra:** TODO caller de `lancarOcorrenciaPortal` resolve a sessão SSW via `readSswLancamentoEnv` (conta única `ai.salex`, secrets `SSW_LANCAMENTO_*`), **independente do operador do card**. São 6 pontos: o envelope `lancarSswPortal` (`_shared/lancar-ssw-portal.ts`, usado por executor/sync-bastao/agente-oc13-autonomo) e as 4 tools de oc=33 no `executor/index.ts` (`lancar_oc33_solo_portal`, `lancar_combo_33_44`, `enviar_email_e_lancar_33_romaneio_interno`, `enviar_email_livre_e_lancar_oc33_portal`). Resolução por-operador (`loadSswInternalEnvForCard` / `readSswInternalEnv(env, nome)`) fica **só pra LEITURA** (foto, histórico, `descobrirUltimaOcSsw`). `readSswLancamentoEnv` **não tem fallback de conta**: faltando secret → THROW (lançamento aborta e reverte o card), nunca loga como outro operador.

**Arquivos:** definição em `supabase/functions/_shared/ssw-internal-client.ts`. Callers de lançamento: `_shared/lancar-ssw-portal.ts` + `executor/index.ts`.

**Como verificar:**
```bash
# Nenhuma sessão de LANÇAMENTO pode vir de readSswInternalEnv/loadSswInternalEnvForCard.
# (a) executor: toda sessão que alimenta lancarOcorrenciaPortal usa readSswLancamentoEnv
VIOL1=$(grep -RIn "readSswInternalEnv(Deno.env.toObject())" supabase/functions/executor/index.ts 2>/dev/null | wc -l | tr -d ' ')
# (b) envelope: resolve credencial de submit por readSswLancamentoEnv (não por-operador)
#     conta só CHAMADAS reais (open paren) — menções em comentário não violam.
VIOL2=$(grep -c "loadSswInternalEnvForCard(" supabase/functions/_shared/lancar-ssw-portal.ts 2>/dev/null | tr -d ' ')
{ [ "$VIOL1" -eq 0 ] && [ "$VIOL2" -eq 0 ]; } && echo "INV-013: PASS" || echo "INV-013: FAIL (executor=$VIOL1 readSswInternalEnv, envelope=$VIOL2 loadSswInternalEnvForCard — usar readSswLancamentoEnv)"
# Teste unitário: deno test supabase/functions/_shared/ssw-lancamento-env.test.ts
```

**Memory:** [project_lancamento_ssw_sempre_conta_ai_salex.md](memory/project_lancamento_ssw_sempre_conta_ai_salex.md)
**Cenário real:** NF 651244 / card d11717f9 (2026-06-22): Duilio **aprovou** a oc=33 no Cockpit, mas o SSW registrou o lançamento como **Larissa** — a tool `lancar_oc33_solo_portal` usava `readSswInternalEnv(env)` sem operador → credencial legada `SSW_INTERNAL_*` (= Larissa). As ocs padrão (54/21/...) saíam certas pelo envelope por-operador (Duilio), mascarando o desvio só na família oc=33. Fix: unificar todos os lançamentos na conta de serviço `ai.salex`.

> Atualização 2026-06-23 (NF 376924): as 4 tools de oc=33/44 do executor (`lancar_oc33_solo_portal`, `lancar_combo_33_44`, `enviar_email_e_lancar_33_romaneio_interno`, `enviar_email_livre_e_lancar_oc33_portal`) **não chamam mais `lancarOcorrenciaPortal` direto** — passam pelo envelope `lancarSswPortal` (adapter `lancarOcViaEnvelope`). Logo o ponto único de lançamento virou o **envelope** (ver INV-014). `lancarOcorrenciaPortal`/`obterSessao`/`readSswLancamentoEnv` não são mais importados pelo `executor/index.ts`.

---

## INV-014 — Card NUNCA aparece em CONFLITOS se a oc geradora foi lançada PELO Cockpit (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-23, inviolável):** `flagConflitoOcSemMover` (`_shared/escopo-relacionamento.ts`) **NÃO** grava `mudanca_suspeita` tipo `saiu_de_escopo` se a `para_oc` foi lançada pelo próprio Cockpit (em QUALQUER momento, com sucesso). Os 2 sinais abaixo rodam **SEMPRE, sem gate de ciclo**. Se o Cockpit lançou aquela oc, **não é conflito**. "Lançado pelo Cockpit" = QUALQUER um de DOIS sinais path-independent:
- **(a)** linha em `acoes_executadas_ssw` com `codigo_oc = para_oc` e `sucesso = true` (registro autoritativo do envelope `lancarSswPortal`); OU
- **(b)** card_event `AcaoExecutadaConfirmadaPeloSsw` com `payload->>'oc_ssw' = para_oc` (emitido por TODO lançamento confirmado pelo SSW — executor-inline / Pass H — qualquer que seja o handler).

**⚠️ Furo corrigido na RAIZ (Caio 2026-06-23):** uma versão anterior gateou os 2 sinais atrás de `emCicloAtivoDoLancamento` (= `cards.acao_executada_em != null`, "ciclo ativo"). Mas esse campo é **ZERADO assim que o Bastão confirma** o lançamento e o card volta a descansar (AGUARDANDO_CLIENTE — estado normal da maioria). Resultado: TODO card já confirmado perdia a proteção e era **re-flagado em massa** na aba CONFLITOS (NF 359849/44, 1017149/21, 3057294/56, 377696/21 — 4 falso-positivos + retrabalho). **Correção:** os 2 sinais rodam SEMPRE; `acao_executada_em` não é mais lido. **Tradeoff aceito:** se a operação reabrir o card e relançar a MESMA oc por fora num ciclo novo, NÃO flagga (suprime por número de oc). Decisão do Caio: zero falso-positivo > pegar esse caso raro ("ali não pode aparecer conflitos que vêm de ocorrências que lançamos por dentro"). Pra distinguir o caso raro no futuro: comparar a data da ocorrência no SSW com `acoes_executadas_ssw.finalizado_em`.

O sinal (b) é a **rede de segurança**: cobre caminhos de lançamento que (historicamente, ou por regressão futura) não gravem em `acoes_executadas_ssw`. Falha de qualquer checagem NÃO bloqueia (conservador: mostra o conflito; operador FORÇA e o SSW revalida).

**Pré-requisito raiz (INV-013):** TODO lançamento passa pelo envelope `lancarSswPortal` → grava em `acoes_executadas_ssw`. Os 5 callers de oc=33/44 do executor foram migrados pro envelope (2026-06-23). Enquanto INV-013 valer, o sinal (a) sozinho já basta; (b) protege contra desvio.

**Arquivos:** `_shared/escopo-relacionamento.ts` (`flagConflitoOcSemMover`); chamado por `sync-bastao/index.ts` (Pass B branches found/!current + reconciliação `A_reconc`).

**Como verificar:**
```bash
# Guard consulta os DOIS sinais SEMPRE — e o gate de ciclo (furo) NÃO existe mais.
G1=$(grep -c "acoes_executadas_ssw" supabase/functions/_shared/escopo-relacionamento.ts)
G2=$(grep -c "AcaoExecutadaConfirmadaPeloSsw" supabase/functions/_shared/escopo-relacionamento.ts)
G3=$(grep -c "emCicloAtivoDoLancamento" supabase/functions/_shared/escopo-relacionamento.ts)  # DEVE ser 0
{ [ "$G1" -ge 1 ] && [ "$G2" -ge 1 ] && [ "$G3" -eq 0 ]; } && echo "INV-014: PASS (2 sinais, sem gate de ciclo)" || echo "INV-014: FAIL"
# Teste unitário (guard 1 acoes_executadas_ssw + guard 2 AcaoExecutadaConfirmadaPeloSsw + conflito real):
#   deno test supabase/functions/_shared/escopo-relacionamento.test.ts
# Auditoria em produção (deve dar 0): card flaggado cuja para_oc foi confirmada pelo Cockpit
#   SELECT count(*) FROM cards c WHERE c.mudanca_suspeita->>'tipo'='saiu_de_escopo'
#     AND EXISTS (SELECT 1 FROM card_events e WHERE e.card_id=c.id
#       AND e.event_type='AcaoExecutadaConfirmadaPeloSsw'
#       AND (e.payload->>'oc_ssw')::int=(c.mudanca_suspeita->>'para_oc')::int);
```

**Memory:** [project_conflitos_nunca_oc_lancada_pelo_cockpit.md](memory/project_conflitos_nunca_oc_lancada_pelo_cockpit.md)
**Cenário real:** NF 376924 + 53948 (2026-06-22): oc=33 reversão lançada pela Larissa via Cockpit (`lancar_oc33_solo_portal`), mas o caminho pulava o envelope → sem registro em `acoes_executadas_ssw` → guard cego → flaggou `54→33`. Agravante: `forcaAguardandoClienteOc54` arrastou o card de `33/TRANSFERIDO` de volta pra `54/AGUARDANDO_CLIENTE` com Bastão atrasado (ver INV-003/INV-006), re-armando o escopo protegido. Fix: (1) migrar os 5 callers pro envelope; (2) guard ganha sinal (b); (3) guard pós-lançamento no `forcaAguardandoClienteOc54`.

---

## INV-015 — Limite de anexos por card conta SÓ uploads do operador (NUNCA `origem='inbound'`)

**Regra (Caio 2026-06-23):** o teto de anexos PENDENTES por card em `upload-anexo-email` (`MAX_ANEXOS_UPLOAD_POR_CARD = 20`) existe pra bound o que o **operador sobe** (vai pro SSW) — `origem='outbound'` (default da coluna). Anexos `origem='inbound'` são **auto-capturados** dos e-mails do cliente (imagens inline de assinatura/logo + PDFs do romaneio) e **não consomem o budget**. A query de contagem DEVE filtrar `.neq("origem","inbound")`. Sem isso, um card com muitos inbound bloqueia 100% dos uploads — inclusive cada página JPEG do PDF que o front converte no browser → upload 400 → supabase-js "Edge Function returned a non-2xx status code" → front "Falha ao converter PDF → JPEG".

**Arquivos:** lógica em `supabase/functions/_shared/limite-anexos.ts` (`queryAnexosQueContamProLimite`, `limiteAnexosAtingido`, `origemContaProLimite`); consumida por `supabase/functions/upload-anexo-email/index.ts`.

**Como verificar:**
```bash
# A query do limite EXCLUI inbound (o coração do fix NF 719250).
G=$(grep -c '\.neq("origem", "inbound")' supabase/functions/_shared/limite-anexos.ts)
USA=$(grep -c "queryAnexosQueContamProLimite" supabase/functions/upload-anexo-email/index.ts)
{ [ "$G" -ge 1 ] && [ "$USA" -ge 1 ]; } && echo "INV-015: PASS" || echo "INV-015: FAIL (filtro inbound=$G, uso na edge=$USA)"
# Teste unitário: deno test supabase/functions/_shared/limite-anexos.test.ts
# Auditoria em produção (cards travados que NÃO deveriam): deve ser ~0 considerando só outbound.
#   SELECT count(*) FROM (SELECT card_id, count(*) FILTER (WHERE origem<>'inbound') ob
#     FROM email_anexos WHERE enviado_em IS NULL AND deletado_em IS NULL GROUP BY card_id) t
#   WHERE t.ob >= 20;
```

**Memory:** [feedback_limite_anexos_nao_conta_inbound.md](memory/feedback_limite_anexos_nao_conta_inbound.md)
**Cenário real:** NF 719250 / card c53dbfda (2026-06-23): Duilio não conseguia converter 2 PDFs (romaneio) pra JPEG no modal da oc=33. O card tinha **29 anexos pendentes, TODOS inbound** (27 imagens inline de assinatura — 165 bytes a 4 KB — + os 2 PDFs), 0 outbound. 29 ≥ 20 → todo upload de JPEG convertido voltava 400. **18 cards** estavam bloqueados pela mesma causa; todos destravam contando só outbound. Raiz era débito conhecido (comentário "Refactor de origem (não contar inbound) fica pra depois" no código desde 2026-05-22).

---

## INV-016 — Cliente respondeu → SEMPRE visível no Cockpit com as ações (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-23):** quando o cliente responde uma tratativa, o card **TEM** que (a) pular pra aba correta (CLIENTE RESPONDEU / AGUARDANDO VOCÊ — `cliente_respondeu_em != null` + `state=AGUARDANDO_VALIDACAO_HUMANA`) e (b) ter as **propostas pendentes** (botões de ação). A criação de propostas é **determinística (sem LLM)** e vive na fonte única `_shared/propostas-pos-resposta-cliente.ts`. Falha transitória de LLM (triador/interpretador 529) **NÃO PODE** deixar o card sem ação. Defesa em 3 camadas:
1. **Caminho primário:** vinculador (pós-classificação) e scan-email-pre-card (adoção de thread) chamam `atualizarPropostasAposRespostaCliente` — scan-email chama **direto**, sem depender do re-enqueue→triador.
2. **Auto-cura de fila:** `reprocessar-dlq` drena mensagens de cliente presas no `dead_letter` de volta pras filas (backoff via `_reprocess_attempt`, cap 4). **Sem cron próprio** — disparado por `invokeNext` dentro do `cron-ia-resposta-pendentes` (o apagão de 2026-06-23 teve thundering herd de cron como causa #2; não somamos worker slot).
3. **Rede de segurança:** `cron-ia-resposta-pendentes` (1min) recria propostas pra qualquer card em CLIENTE RESPONDEU sem `todos` pendentes (RPC `cards_cliente_respondeu_sem_proposta`), e emite `PropostasRecuperadasPeloCron`. `health-check` alerta o Caio (DLQ de cliente presa + rede de segurança acionada).

**Arquivos:** `_shared/propostas-pos-resposta-cliente.ts` (fonte única), `vinculador/index.ts`, `scan-email-pre-card/index.ts`, `cron-ia-resposta-pendentes/index.ts`, `reprocessar-dlq/index.ts`, `health-check/index.ts`.

**Como verificar (código — caminho determinístico está wired):**
```bash
# scan-email-pre-card E cron-ia-resposta-pendentes DEVEM chamar a fonte única.
# = 2 → PASS. < 2 → FAIL (alguém voltou a depender só do vinculador/LLM).
grep -lR "atualizarPropostasAposRespostaCliente" \
  supabase/functions/scan-email-pre-card/index.ts \
  supabase/functions/cron-ia-resposta-pendentes/index.ts 2>/dev/null | wc -l
```

**Como verificar (runtime — nenhum card preso):**
```sql
-- DEVE retornar 0. > 0 → card em CLIENTE RESPONDEU sem botões (regra violada).
SELECT count(*) FROM public.cards_cliente_respondeu_sem_proposta(200);
```

**Memory:** [project_inv016_cliente_respondeu_sempre_visivel.md](memory/project_inv016_cliente_respondeu_sempre_visivel.md)
**Cenário real:** NF 761583 (F E F DISTRIBUI A1), 2026-06-23. Anthropic 529 (14:18–14:57 UTC) derrubou o triador → 13 respostas de clientes no `dead_letter` → vinculador nunca rodou → 761583 ficou "CLIENTE RESPONDEU + IA sugeriu oc 44 + ZERO botões"; outros 5 cards (AGUARDANDO_CLIENTE) nem apareceram como respondidos. Não havia reprocessamento de DLQ nem rede de segurança de propostas (só de `ia_sugestao`).

---

## INV-017 — Card em EXTRAVIO_MONITORADO ⟺ oc atual ∈ {6,9,16}; saída pela verdade do BASTÃO por NF (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-24):** a aba EXTRAVIOS mostra **só extravios**. Um card só fica em `state='EXTRAVIO_MONITORADO'` enquanto a ocorrência ATUAL é 6/9/16. A SAÍDA é decidida pela verdade do **Bastão consultado POR NF** (não pelo filtro de ocorrência), porque o RPA faz full-refresh e RETÉM a NF com a oc nova enquanto pendente; só larga quando FINALIZA. Cada ciclo, `sync-extravios-bastao` pega as NFs dos cards da aba, faz `fetchPendenciasByNfs` e roteia via `decidirDestinoExtravio` (delega a `stateFinalAposBastao` — INV-008):
- Bastão mostra oc ∈ {6,9,16} → fica (regrava `bastao_data_ultima_ocorrencia` → nova fotografia);
- Bastão mostra oc ∉ {6,9,16} → SAI roteado (20→AGUARDANDO VOCÊ, 33/operação→TRANSFERIDO, 1/30/32→RESOLVIDO);
- **NF AUSENTE do Bastão → finalizou → RESOLVIDO** — MAS só sob o **GATE DE FRESCOR**.

**GATE DE FRESCOR INVIOLÁVEL:** só age se `max(updated_at)` do Bastão for recente (`fetchBastaoMaxUpdatedAt` ≤ `EXTRAVIOS_BASTAO_FRESH_MIN`, default 20min). Bastão velho/down → NÃO faz NADA (senão "NF ausente" seria dado velho, não finalização). **SSW NÃO é usado no PART 1** — fica pro conflito (oc lançada pelo Cockpit e o Bastão volta com outra → máquina de ACAO_EXECUTADA/`atualizar-card-via-portal-ssw`) e pra pré-checagem do agente (PART 2). Cards com lançamento do Cockpit < 60min (`acao_executada_em`) são pulados.

**Arquivos:** `_shared/extravio-routing.ts` (decisão pura `decidirDestinoExtravio` + testes), `_shared/reconciliar-extravios-bastao.ts` (saída via Bastão por NF + sumiu→RESOLVIDO sob frescor), `sync-extravios-bastao/index.ts` (gate de frescor + entrypoint cron), `_shared/bastao-client.ts` (`fetchBastaoMaxUpdatedAt`, `fetchPendenciasByNfs`).

**Como verificar:**
```bash
# (a) Decisão pura testada (6/9/16 fica; 20→AVH; 33→TRANSFERIDO; 1/30/32→RESOLVIDO; 54→AC).
deno test supabase/functions/_shared/extravio-routing.test.ts    # 8 passed → PASS

# (b) Reconciliador usa a fonte única (decidirDestinoExtravio) + Bastão (NÃO SSW) + gate de frescor.
grep -c "decidirDestinoExtravio" supabase/functions/_shared/reconciliar-extravios-bastao.ts   # >=1
grep -c "bastaoConfirmadoFresco"  supabase/functions/_shared/reconciliar-extravios-bastao.ts   # >=1
grep -c "fetchBastaoMaxUpdatedAt" supabase/functions/sync-extravios-bastao/index.ts            # >=1
grep -rc "descobrirUltimaOcSsw\|reconciliar-extravios-ssw" supabase/functions/sync-extravios-bastao/ supabase/functions/_shared/reconciliar-extravios-bastao.ts  # = 0 (SSW fora do PART 1)

# (c) Cron de reconciliação agendado (mig 255).
psql "$SUPABASE_DB_URL" -tA -c "select count(*) from cron.job where jobname='sync-extravios-bastao';"  # = 1
```

**Como verificar (SQL produção, read-only):**
```sql
-- DURO: nenhum card EXTRAVIO_MONITORADO com oc local fora de {6,9,16}.
SELECT count(*) FROM cards
WHERE state='EXTRAVIO_MONITORADO' AND coalesce(cod_ultima_ocorrencia,0) NOT IN (6,9,16);
-- = 0 → PASS.

-- OPERACIONAL: cards não acumulam dias indefinidamente. Sem sync há > 40min com Bastão
-- fresco = reconciliador parado (cron 10min; staying card recebe synced_at a cada ciclo).
SELECT count(*) FROM cards
WHERE state='EXTRAVIO_MONITORADO' AND bastao_synced_at < now() - interval '40 minutes';
-- baixo/estável → PASS. Crescente → investigar reconciliador (NÃO o Bastão).
```

**Memory:** [project_extravios_regra_inviolavel_saida_e_reconciliador.md](memory/project_extravios_regra_inviolavel_saida_e_reconciliador.md)
**Cenário real:** 2026-06-24 — cards travados em EXTRAVIO_MONITORADO/oc=6 com a oc real já mudada (NF 43973 oc 20→1 congelada 121h, 277008/21519 entregues, 650967 oc 33). Raiz: a saída estava delegada ao pull FILTRADO por ocorrência; NF que muda pra fora do filtro sumia do pull e o card congelava (runPassB exclui EXTRAVIO_MONITORADO; cron dedicado aposentado mig 219). Validado empiricamente que o Bastão RETÉM a NF com a oc nova (33/49/14/5/53) e só some quando finaliza (1/30/32) → consultar o Bastão por NF é a fonte barata e correta; SSW vira exceção. (1ª versão usou reconciliador SSW por órfão/staleness — substituída por Bastão-por-NF + gate de frescor por ser mais barata, sem risco de estampida de SSW pós-falha, e sem confundir "saiu do relatório" com "update falhou".)

---

## INV-019 — Card AGUARDANDO_CLIENTE cuja oc vira RELACIONAMENTO ≠54 → AGUARDANDO VOCÊ (não pode ficar travado)

**Regra (Caio 2026-06-24):** `AGUARDANDO_CLIENTE` só contém oc=54. Quando a oc real (Bastão) de um card AGUARDANDO_CLIENTE vira **outra oc DE RELACIONAMENTO ≠54** (49/20/11/19/35/10/...), o card TEM que ir pra **AGUARDANDO VOCÊ** (`AGUARDANDO_VALIDACAO_HUMANA` + lock) pro operador tratar. Mover pra AGUARDANDO VOCÊ **não** fere INV "card não sai sozinho" — continua no Cockpit, só troca de aba. O ramo **out-of-escopo** (oc fora de relacionamento) é o OUTRO ramo: fica em AGUARDANDO_CLIENTE + aponta em **CONFLITOS** (Pass B `flagConflitoOcSemMover`) — esse não é coberto por este INV.

**Arquivos:** `supabase/functions/sync-bastao/index.ts` (Pass A `aguardandoClienteVirouOutraRelacionamento` — state + `effState`); `migration/2026-07-02_287_ignorar_pendencias_respeita_inv019.sql` (RPC do operador). Complementa INV-006.

**Raiz da regressão:** o Pass E (dono dessa transição) foi DESLIGADO em 2026-06-22 pela invariante "não sai sozinho", mas só o ramo out-of-escopo→CONFLITOS foi reassumido (Pass B). O ramo in-escopo (relacionamento≠54) ficou órfão → cards congelavam em AGUARDANDO_CLIENTE, invisíveis (nem AGUARDANDO VOCÊ nem CONFLITOS, pois Pass A limpa `mudanca_suspeita` pra oc de relacionamento). Restaurado no Pass A em 2026-06-24.

**4ª porta de entrada (bug NF 1119469, 2026-07-02, mig 287):** a RPC `ignorar_pendencias_resposta_cliente` (botão "IGNORAR E SEGUIR" do banner de pendências IA) fazia `UPDATE cards SET state='AGUARDANDO_CLIENTE'` **incondicionalmente** — nunca lia `cod_ultima_ocorrencia`. Toda vez que o operador ignorava pendências num card de relacionamento ≠54 (oc 19/49/20/...), a própria RPC CRIAVA a violação de INV-019 (card 98338d77, oc=19, Duilio). Fix: a RPC decide o state pelo **mesmo predicado do /verify-cockpit** (relacionamento ≠54 e não-lag pós-54 → fica em AVH+lock; emite `PendenciasRespostaIgnoradasMantidoEmAguardandoVoce` `regra=INV-019`; oc=54/lag/out-of-escopo → AGUARDANDO_CLIENTE). Era o único caminho de escrita de state que ignorava o guard `oc=54 ⟺ AGUARDANDO_CLIENTE`. Guard no `/verify-cockpit`: `INV-019 (RPC fonte)` + `INV-019 (RPC DB)` via `pg_get_functiondef`. Teste: `supabase/tests/ignorar-pendencias-inv019.test.sql`.

**Como verificar (SQL produção, read-only):**
```sql
-- exclui LAG pós-lançamento de 54 (card lançou 54, Bastão ainda mostra a oc anterior).
SELECT count(*) FROM cards c
WHERE c.state='AGUARDANDO_CLIENTE'
  AND c.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
  AND NOT EXISTS (
    SELECT 1 FROM acoes_executadas_ssw a
    WHERE a.card_id=c.id AND a.codigo_oc=54 AND a.sucesso
      AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date >= c.bastao_data_ultima_ocorrencia);
-- = 0 → PASS. > 0 → FAIL (oc de relacionamento ≠54 travada em AGUARDANDO_CLIENTE).
```

**Memory:** [project_aguardando_cliente_state.md](memory/project_aguardando_cliente_state.md), [project_inv019_aguardando_cliente_oc_relacionamento_vai_pra_voce.md](memory/project_inv019_aguardando_cliente_oc_relacionamento_vai_pra_voce.md)
**Cenário real:** NF 175621 (COMPROMISSO) ficou em AGUARDANDO_CLIENTE com oc=49 desde 2026-06-19; varredura achou 52 cards travados (39 oc=49 + 20/11/19/35/10 + 1 oc=30). Last `AguardandoClienteOcMudou` parou em 2026-06-22 05:00 (data do desligamento do Pass E). Backfill: 51 relacionamento→AGUARDANDO VOCÊ, oc=30→RESOLVIDO.

---

## INV-022 — Agente de extravio SÓ lança a oc 49 após pré-checagem SSW com última oc ∈ {6,9,16} (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-24, PART 2):** o agente autônomo `agente-extravio-d4` lança a oc 49 ("PRAZO DE PERDAS EXPIRADO") em cards de extravio com ≥4 dias úteis. **ANTES de TODO lançamento** (modo execute E modo autônomo) ele CONFERE no SSW interno a última ocorrência real via `listarOcorrenciasNF`; só lança se `podeAgenteLancar49(ocReal)` = true (oc ∈ {6,9,16} → nada lançado pós-extravio). Qualquer outra oc — ou SSW indisponível (`null`) — → **NÃO lança**, marca `agente_extravio_status='nao_rodou'` com `motivo` explicado e o card vai pra coluna AUTÔNOMO NÃO RODOU pro operador verificar/reportar. O reconciliador do PART 1 (`sync-extravios-bastao`) PULA cards `nao_rodou` (não auto-move; INV-017). Toda ação vira `card_event` + snapshot em `cards_auditoria` (`motivo='extravio_oc49_autonomo'`, filtro próprio na AUDITORIA) com RLS por operador. Lançamento via envelope `lancarSswPortal` (idempotência + tripé, INV-013/014). Autonomia gateada pela flag global `extravios_agente_autonomo_enabled` (Caio liga após validar o lote).

**Arquivos:** `_shared/agente-extravio-regras.ts` (`podeAgenteLancar49` + testes), `agente-extravio-d4/index.ts` (scan/execute, pré-checagem em ambos), `sync-extravios-bastao/index.ts` (pula `nao_rodou`), `cards` colunas `agente_extravio_*` (mig 256), auditoria (mig 258), flag (mig 259).

**Como verificar:**
```bash
# (a) Regra pura testada (6/9/16→lança; resto/null→não).
deno test --no-check supabase/functions/_shared/agente-extravio-regras.test.ts   # 4 passed

# (b) O agente usa a regra pura nos DOIS modos (scan + execute) — sem .has inline.
grep -c "podeAgenteLancar49" supabase/functions/agente-extravio-d4/index.ts        # >= 2
grep -c "EXTRAVIO_OCS.has"   supabase/functions/agente-extravio-d4/index.ts        # = 0

# (c) Lançamento via envelope (auto_aprovar_e_executar → executor → lancarSswPortal), NÃO direto.
grep -c "auto_aprovar_e_executar" supabase/functions/agente-extravio-d4/index.ts   # >= 1
grep -c "lancarOcorrenciaPortal"  supabase/functions/agente-extravio-d4/index.ts   # = 0

# (d) Reconciliador PART 1 pula nao_rodou.
grep -c "agente_extravio_status.*nao_rodou" supabase/functions/sync-extravios-bastao/index.ts  # >= 1
```

**Como verificar (SQL produção, read-only):**
```sql
-- DURO: nenhum card com a oc 49 lançada pelo agente que ainda esteja EXTRAVIO_MONITORADO
-- (lançou → tem que ter saído pra AGUARDANDO VOCÊ).
SELECT count(*) FROM cards WHERE agente_extravio_status='lancou' AND state='EXTRAVIO_MONITORADO';
-- = 0 → PASS.

-- Todo card nao_rodou tem motivo explicado (o agente SEMPRE explica).
SELECT count(*) FROM cards WHERE agente_extravio_status='nao_rodou' AND coalesce(trim(agente_extravio_motivo),'')='';
-- = 0 → PASS.
```

**Memory:** [project_agente_extravio_autonomo_d4.md](memory/project_agente_extravio_autonomo_d4.md)
**ADR:** [docs/decisions/0007-agente-extravio-autonomo-d4.md](decisions/0007-agente-extravio-autonomo-d4.md)
**Cenário real:** 2026-06-24 — 1ª validação NF 1090036 (Larissa): agente conferiu SSW (oc ainda 6), lançou a 49 via envelope, card → AGUARDANDO VOCÊ em 10s com as propostas da oc 49; leftover de extravio canceladas. Risco que a regra trava: lançar a 49 "em cima" de uma oc que já localizou/devolveu (ex: oc 20 lançada pós-extravio antes do D+4) — geraria oc duplicada/errada e estresse com o cliente.

---

## INV-023 — Visibilidade decide pela VERDADE DO SSW POR IDENTIDADE (ai.salex × terceiro), NÃO por relógio (REGRA INVIOLÁVEL)

**Regra-mãe (Caio 2026-06-30, raiz NF 346896; supersede a versão "por HORA" do ADR 0009):** **Bastão é GATILHO, SSW é JUIZ.** Quando um card parado (TRANSFERIDO/etc, ou AGUARDANDO_CLIENTE) tem o Bastão sinalizando oc de relacionamento, a visibilidade é decidida pela **ocorrência mais recente real do SSW + a IDENTIDADE de quem a lançou** — **NUNCA** por comparação de relógio (a versão por HORA misturava hora-SSW em minuto cheio × `iniciado_em` em segundos, skew ~1-2 min → escondia oc de relacionamento nova de terceiro lançada no mesmo minuto de uma ação do Cockpit; NF 346896: oc 19 marianep 13:13 acima de oc 56 ai.salex 13:12, mas iniciado_em 13:14:01 → suprimida 97×).

**Decisão (`decidirVisibilidadePorSsw`, 4 valores explícitos):** oc topo **54** → `AGUARDANDO_CLIENTE` (independe do autor). Topo **não-relacionamento** → `MANTER_FORA_RELACIONAMENTO`. Topo **relac ≠54 por `ai.salex`** (conta oficial do Cockpit, INV-013) → `MANTER_FORA` (nossa ação, Bastão lagando → mata bounce-back). Topo **relac ≠54 por TERCEIRO** → `MOSTRAR_OPERADOR` (AGUARDANDO VOCÊ). **Em dúvida NÃO esconde:** autor desconhecido / SSW indisponível / cache stale → `INDEFINIDO_RETRY`; **autor desconhecido + código igual ao último lançamento nunca vira "manter fora"** (código sozinho não é fingerprint). **Prazo do INDEFINIDO_RETRY** ~1h/2 ciclos → depois escala pra `MOSTRAR` (evento `ReaberturaPorIndefinidoExpirado`) — nenhum Relacionamento fica invisível sem prazo. **Preferir falso-positivo controlado a Relacionamento invisível.** SEM comparação `data` SSW × `iniciado_em`.

**R2 (coberto, intocado):** card AGUARDANDO_CLIENTE cuja oc vira NÃO-relacionamento → CONFLITOS (`flagConflitoOcSemMover` via `cardEmEscopoProtegido`, Pass B), não some. Este fix não toca esse caminho.

**Implementação:** `_shared/decidir-visibilidade-ssw.ts` (`decidirVisibilidadePorSsw` + `estadoFinalParaDecisao` + `normalizarAutor`) + `descobrirUltimaOcSsw` devolve `ocorrencias[]` com `usuario` (autor) + sync-bastao (`decidirReaberturaCandidato` no candidatoReabertura; `naoRebaixarComDesempateSsw` no sweep INV-019) **atrás da flag `reabertura_por_identidade_enabled` (default OFF)**. Com flag OFF o caminho per-hora (0009, `decidirReaberturaPorSsw`) fica INTACTO = rollback imediato por flag. Guard: `decidir-visibilidade-ssw.test.ts` (P1–P13 puros + mapeamento callers) + INV-023 no verify-cockpit. Shadow (`reabertura_shadow_log` / flag `reabertura_shadow_enabled`) validou nova × atual antes de ligar. Ver ADR 0011.

> **Atualização 2026-08-07 (alerta zumbi NF 371705):** o MONITOR do INV-023 (`checkReaberturaIndefinidaPresa`, health-check) rastreava a entrada no `INDEFINIDO_RETRY` mas só conhecia 4 eventos de saída — um card que saiu do limbo pelo SWEEP INV-019 (`AguardandoClienteOcMudou`), foi tratado (oc 56 confirmada) e transferido re-disparou o mesmo email de hora em hora por 13h. A decisão vive agora em `_shared/inv023-indefinido-preso.ts` (`acharIndefinidosPresos` + `EVENTOS_SAIDA_INDEFINIDO` completa). Regra: TODO caminho novo de saída do INDEFINIDO_RETRY entra em `EVENTOS_SAIDA_INDEFINIDO`; `BastaoCardAtualizado` NUNCA entra (dispara sem mudança de estado — silenciaria card genuinamente preso). Guard: `inv023-indefinido-preso.test.ts` (7 casos, âncora NF 371705) + check no verify-cockpit.

**Cenário real:** 2026-06-30 — **NF 1086787** (prova viva): suprimido correto (nossa oc=56) → terceiro `anselmo` lançou oc=49 05:44 → **reabriu sozinho** pra AGUARDANDO VOCÊ, cliente respondeu. **NF 346896** (raiz): terceiro (marianep) lançou oc=19 acima da nossa oc=56 → antes escondido pela comparação de relógio, agora MOSTRA por identidade. Validado ~27h/57 ciclos: 0 erro, 0 bounce-back, 0 bloqueador ai.salex, 0 card invisível (`audits/MONITORAMENTO_REABERTURA_IDENTIDADE_2026-06-30.md`). Risco que a regra trava: oc de relacionamento nova de terceiro sumir do operador (346896) E re-mostrar ação nossa já tratada (bounce-back 351193) — as DUAS.

---

## INV-034 — Extravio PARCIAL: oc 33 de COMPLETUDE exige romaneio + descrição + valor (extravio TOTAL não regride)

**Regra.** Duas naturezas de oc 33 (handoff pro Ressarcimento):
- **COMPLETUDE de indenização** — só pode ser lançada com as **3 evidências** (romaneio + descrição dos itens + valor dos itens). É a única oc 33 do Caso 1 (extravio parcial entregue, pós-oc 19) e a 2ª do Caso 2 (pós-devolução).
- **OPERACIONAL (combo com 44)** — Caso 2 (devolução): sai **só com romaneio**, destrava a devolução física. NÃO marca indenização completa.
- **Extravio TOTAL** — inalterado: a oc 33 exige só o romaneio (`ehExtravioParcial=false` → gate no-op).

**Onde vive.** Dossiê das 3 evidências em `cards.agent_state.extravio_parcial.dossie`, populado pelo `interpretador-resposta-cliente` (LLM classifica `evidencias_recebidas`; evidência ao SSW vem da FONTE ORIGINAL — anexo do cliente ou trecho VERBATIM do corpo, nunca paráfrase). Módulo puro `_shared/extravio-parcial-dossie.ts` (`avaliarDossie`, `classificarOc33`, `decidirGateOc33`, `mergeEvidencia`, `ehExtravioParcial`). Gate global (modo AVISADO — anota `meta.gate_oc33`, não remove a proposta) nos DOIS finalizadores: `_shared/propostas-pos-resposta-cliente.ts` e `_shared/regras-auto-acao.ts`. Enforce AUTORITATIVO no `executor/index.ts` (`gateOc33Enforce`, lê o dossiê VIVO na hora de lançar): recusa a oc 33 de completude com dossiê incompleto (e o combo operacional sem romaneio) **só quando a flag `extravio_parcial_gate_enforce` = ON** e o operador não forçou via `extras.forcar_oc33_dossie_incompleto`. Também: os handlers de oc 33 passam o texto ao SSW com `.slice(0,500)` (era 70 — truncava descrição/valor); `lancarOcorrenciaPortal` divide em f6(70)+observ(500).

**Rollout.** Shadow-first: `extravio_parcial_dossie_enabled=ON` (popula dossiê + telemetria `DossieExtravioAtualizado`/`Oc33BloqueadaDossieIncompleto`), `extravio_parcial_gate_enforce=OFF` (só observa) — mig 285.

**Guard:** `_shared/extravio-parcial-dossie.test.ts` (21 testes) + INV-034 no verify-cockpit.

**Cenário real:** 2026-07-01 — NF 66193 INOVAMED / Larissa. Extravio parcial: o agente sugeria/lançava a oc 33 (handoff pro Ressarcimento) sem garantir as 3 informações; cliente mandava só o romaneio e o processo de indenização abria incompleto. Risco que a regra trava: (a) oc 33 de completude com dossiê furado; (b) regredir o extravio total (que só precisa de romaneio); (c) o corte-em-70 voltar e truncar a descrição/valor no SSW.

---

## INV-038 — Nome de operador é CHAVE de matching Cockpit×Bastão; rename tem que ser dos DOIS lados + cards ativos

**Regra.** O match do dono do card é carteira-CNPJ primeiro, mas o fallback (Path 2 do `operador-resolver.ts` e o trigger `cards_resolve_operator`, mig 007) é **igualdade case-insensitive com `operadores.nome`**. Consequências invioláveis:
- (a) **0 cards não-terminais com `responsavel_relacionamento` preenchido e `assigned_operator_id` NULL** — órfão de resolução = nome que o Bastão manda não existe em `operadores` (drift de rename).
- (b) **0 cards não-terminais cujo `responsavel_relacionamento` não bate com nome de operador ATIVO** — texto defasado pós-rename: some dos filtros por nome (`cron-sync-prioridades-ai`, full-pull Curva F) e assina e-mail com nome errado.
- Rename de operador = migration que muda `operadores.nome` **E** o texto dos cards ativos (com `card_events`), nunca só um dos dois.
- **"Nada fica órfão" (Caio 2026-07-21, mig 305):** cascata esgotada (carteira → nome → segmento sem match) cai no operador com `operadores.recebe_cards_orfaos=true` (hoje ISABELY; índice único garante máx. 1) — Path 4 `fallback_orfao` do `operador-resolver.ts` + fallback no trigger `cards_resolve_operator` (que também canoniza o texto do card). O fallback **NÃO** se aplica a `carteira_dormente`, `cnpjs_excluidos_cockpit` (blacklist) nem a ambíguo — curtos-circuitos deliberados que continuam null (dormente/blacklist) ou acusados pelo INV-036 (ambíguo). Deve existir **exatamente 1** operador-fallback ativo.
- **Segmento é normalizado** (`normalizarCodigoSegmento`): o Bastão manda rótulo (`"043 - CURVA F"`); comparar cru com `segmentos={043}` nunca casa (era a 2ª causa do órfão de 2026-07-21 — a implementação da "Fase 2" existia só como teste no master e foi completada junto com a mig 305).
- **Secret de leitura SSW não deriva mais só do nome:** `operadores.ssw_secret_prefix` (NULL = deriva do nome como sempre) — rename de operador não pode trocar a conta SSW silenciosamente. ISABELY → `'ISA_E_KAROL'` → `SSW_INTERNAL_ISA_E_KAROL_*` (mesma conta padrão de sempre). `loadSswInternalEnvForCard` resolve o operador canônico (por id) ANTES do texto do card.

**Guard:** INV-038 no verify-cockpit (3 checks SQL + `operador-resolver.test.ts`). Receitas: `migration/2026-07-21_304_rename_isa_karol_isabely_camila_felipe.sql` + `migration/2026-07-21_305_fallback_orfao_isabely_ssw_prefix.sql`.

**Cenário real:** 2026-07-21 — Bastão renomeou ISA E KAROL→ISABELY e CAMILA→FELIPE às 17:00 UTC; o Cockpit ficou pra trás por algumas horas e produziu 2 cards ativos órfãos 'ISABELY' (invisíveis pra operação, únicos órfãos ativos do sistema) + filtros por nome no Bastão retornando vazio pros dois. Mig 304 alinhou (rename + 402 cards ativos + 2 órfãos resolvidos). No mesmo dia o Bastão mandou responsável `"KAROL"` (pessoa fora do Cockpit, ≠ KAROLINE — confirmado pelo Caio) → sem fallback, viraria órfão de novo; mig 305 fecha a classe inteira.

---

## INV-040 — Sync NUNCA fabrica cards em loop: ≥3 terminais da NF criados em 24h bloqueia criação

**Regra.** O `uniq_cards_nf_active` é **parcial de propósito** (re-ocorrência legítima de NF cria card novo; NÃO mexer no índice). Consequência: ele não protege contra o loop **criação→terminal→recriação** — se uma regressão de roteamento fizer o card nascer/virar terminal no mesmo ciclo, o sync seguinte vê "NF sem card ativo" e cria outro, 1 por ciclo (~30 min), pra sempre. Guard obrigatório nos **2 pontos de criação** do sync-bastao (`handleExtravioPendencia` e `upsertCardFromPendencia`): `bloquearCriacaoSeLoopDetectado` (`_shared/guard-anti-loop-criacao.ts`) — com ≥3 cards TERMINAIS (RESOLVIDO/CANCELADO/TRANSFERIDO) da NF criados nas últimas 24h, NÃO cria; loga + `card_event` `LoopCriacaoCardDetectado` no card mais recente (dedupe 1/24h). Fail-open: erro de banco no guard nunca bloqueia criação legítima. Caminho de criação NOVO no sync = obrigatório chamar o guard.

**Guard:** INV-040 no verify-cockpit (grep ≥3 ocorrências no sync + `guard-anti-loop-criacao.test.ts` + SQL "nenhuma NF com >3 cards criados em 24h") + marcador `bloquearCriacaoSeLoopDetectado` no `.claude/deploy-guards.json`.

**Cenário real:** 2026-07-14/15 — NF 2084: 74 cards fabricados em rajada (1 por ciclo de ~30 min). O roteamento pré-59 (deployado na época) fazia o card oc=59 **nascer direto em TRANSFERIDO** (30 cards com evento único `BastaoCardImportado`, `created_at`=`updated_at` ao milissegundo); o Bastão alternava a NF entre 2 CTRCs (AMB=oc59 relacionamento ↔ TTO=oc20 extravio), então `encerrarCardAntigoSeCtrcMudou` encerrava o card ativo a cada ciclo e o par era recriado no ciclo seguinte. Mesma classe em datas anteriores: NFs 23657 (66 cards 07-08/07), 339024 (42 cards 30/06-01/07), 137344 (42 cards 07-08/07). Dossiê: `audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md`.

---

## INV-041 — Aprovação com e-mail NUNCA às cegas + aval de evidência acessível + airbag global

**Regra.** (1) Ação que envia e-mail (`lancar_oc_e_enviar_email`, `enviar_email_e_lancar_33_romaneio_interno`, `enviar_email_livre_e_lancar_oc33_portal`) **nunca** é aprovada sem passar por uma janela de edição: o botão "aprovar ação →" do item ⭐ RECOMENDADA decide via `decidirCliqueAprovacao` (`apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts`) — e-mail/romaneio-interno → `EditarEmailModal`, e-mail livre+oc33 → modal próprio (`emailOc33ModalTodo`), combo 44+59 → modal do combo, demais → direto. (Ampliado 2026-07-22 tarde — Larissa, PRATI NF 1025518: romaneio-interno aprovava direto no `confirm()` nativo sem opção de editar o e-mail.) (2) O aval "Não validar evidência" (`extras.skip_evidencia`) pra ocs de validação forçada `{10, 11, 35}` existe em **TODAS** as superfícies que enviam e-mail: `EditarEmailModal` E `BannerInline54Composer` (espelhos exatos — mesma condição `[10, 11, 35].includes(cod_ultima_ocorrencia_card)` vinda do RPC `preview_email_todo`). (3) `main.tsx` envolve `<App />` com `<ErrorBoundary>` (+ `window.onerror`/`unhandledrejection` com prefixo `[cockpit-crash]`): crash de render vira tela de erro com stack visível, nunca tela branca morta.

**Guard:** INV-041 no verify-cockpit (arquivo+uso do decidir-clique + `decidir-clique-aprovacao.test.ts` + grep das duas superfícies skip_evidencia + grep `<ErrorBoundary>` no main).

**Cenário real:** 2026-07-22 — NF 51712 (ISABELY, oc=11): botão ⭐ RECOMENDADA aprovou com `extras=null` → executor bloqueou com "Evidencia ausente" e reverteu, 5 batidas em 30min, operador sem saída (o checkbox só existia no modal, que nunca abria). NF 556392 (FELIPE): clique em aprovar → tela 100% branca sem stack (sem ErrorBoundary, gatilho incapturável); operadores contornavam aprovando oc=41 → cliente NÃO recebia pedido de romaneio (dano silencioso). 2ª regressão do aval de evidência na história do projeto (1ª na era Lovable — prompts `lovable-restaurar-nao-validar-evidencia`).

---

## INV-042 — Premissa da resposta de cliente (Caio 2026-07-23): card ATIVO se move; terminal não ressuscita

**Regra (as 3 premissas do Caio).** (1) Resposta real de cliente (não-bounce; filtro no gmail-poll, NF 5826) + card **ATIVO** no Cockpit → o card **SE MOVE, sempre** (AVH + lock + carimbo + propostas pós-resposta + interpretador). (2) Card `TRANSFERIDO`/`RESOLVIDO` = alguém tratou → resposta **anexa SEM mover** (evento `RespostaClienteEmCardTransferido`); se a NF tiver **outro card ativo**, a resposta é **roteada pra ele** (evento `MensagemRoteadaParaCardAtivo`; o lookup por NF do vinculador também prefere card ativo). (3) Card novo criado depois pelas regras de negócio entra na premissa 1. Fonte única da decisão: `decidirAcionamentoPorRespostaCliente` (`_shared/acionamento-resposta-cliente.ts`) — usada nos DOIS caminhos do vinculador; nunca reimplementar inline (a divergência entre os 2 caminhos criou o buraco original). Detecção de violação sempre POR EVENTO, nunca por carimbo (executor zera `cliente_respondeu_em`). `EXTRAVIO_MONITORADO`/`CANCELADO` fora deliberadamente (INV-017). 3ª camada: watchdog `checkRespostaClienteEngolida` (health-check, só cards ativos, e-mail ≤2h).

**Guard:** INV-042 no verify-cockpit (fonte única + uso ≥3 no vinculador + `acionamento-resposta-cliente.test.ts` — inclui anti-regressão "terminal NUNCA volta a acionar" — + watchdog ≥2 + SQL "nenhuma resposta muda em card ATIVO em 24h").

**Cenário real:** 2026-07-16→23 — NF 73220 (LARISSA/LEONE): oc 59 lançada 08:42; confirmador pré-59 (regressão de deploy 13-21/07, corrigida na regularização de 22/07) classificou 59 como "outras" → card TRANSFERIDO às 08:42 (evento com `state_novo:'TRANSFERIDO'`). Cliente respondeu COM O ROMANEIO às 09:56 → vinculador anexou e ficou MUDO (thread path ignorava terminal; ramo de reabertura por NF suspenso em 12/05 apostando no "sync reabre" — aposta anulada pelo guard de identidade ADR 0011: **83 supressões em 7 dias**). 2ª resposta 22/07 idem. Karoline destravou na mão (FORÇAR ATUALIZAÇÃO 23/07). Escala: 52 confirmações pré-59 mandaram oc 54/59 pra TRANSFERIDO; ~22 ainda presos; 15+ NFs com respostas engolidas (uma com 18). Retroativo: `audits/retroativo-respostas-engolidas-e-oc59-transferido-2026-07-23.sql`.

---

## INV-043 — Camada de captura viva: toda caixa Gmail com credencial tem rodada de leitura

**Regra.** O gmail-poll roda a cada 5min com orçamento global (100s) e **fatia por caixa** (25s) sobre a ordenação **mais-defasada-primeiro** — fonte única `lastPollAtDoEmbed`+`ordenarPorDefasagem` (`_shared/gmail-poll-batch.ts`), tolerante ao formato do embed do PostgREST (OBJETO na relação 1-pra-1; ler `[0]` como array foi o bug). Nenhuma caixa pode monopolizar a rodada; ciclo completo das 9 caixas fecha em ≤3 rodadas (~15min). Caixa com credencial sem rodada há >2h = violação. Esta é a camada que o INV-042 não enxerga: ele detecta "capturada e não processada"; o INV-043 detecta "**nunca capturada** — resposta parada no Gmail". 3ª camada: watchdog `checkCaixaGmailSemPoll` (health-check, e-mail ≤2h).

**Guard:** INV-043 no verify-cockpit (uso da fonte única + fatia + testes do rodízio com caso âncora + watchdog + SQL "nenhuma caixa faminta >2h").

**Cenário real:** 2026-07-23 — deploy do PR #24 (sequencial+orçamento) às 08:29 expôs a ordenação que nunca funcionou: embed objeto lido como array → empate universal → KAROLINE+JULIA comiam os 100s toda rodada → 7/9 caixas com ZERO leituras. Capturas/dia do DUILIO: 43 → 1. NF 389040: resposta do cliente ficou parada na caixa `ferramentas.construcao@` desde 10:28, invisível pra TODAS as camadas (sem RespostaClienteCapturada, INV-042 cego). Sob o v59 o paralelismo mascarava (progresso parcial com worker-kill — 69 mortes/6h, NF 1504049). Latente documentado: re-mastigação de msgs não-casadas <7d (dreno lento; fix profundo = checkpoint/history_id do PR #24).

---

## INV-044 — O app nunca é traduzível pelo navegador (lang pt-BR + notranslate)

**Regra.** `apps/cockpit-web/index.html` declara `lang="pt-BR"`, `translate="no"` e `<meta name="google" content="notranslate">`. Motivo: o Google Tradutor do Chrome reescreve os nós de texto POR FORA do React; na primeira remoção de nó (fechar modal ao aprovar, redesenhar lista) o React não encontra o filho onde o deixou → `NotFoundError: removeChild` (bug clássico React#11538). O `lang="en"` num app 100% pt-BR era o convite à auto-tradução.

**Guard:** INV-044 no verify-cockpit (grep dos 3 marcadores no index.html).

**Cenário real:** 2026-07-23 — FELIPE aprovava comandos e caía na tela do airbag com `removeChild`. A prova estava no próprio print: o texto do NOSSO airbag veio REESCRITO ("Algo quebrou nesta tela"→"ALGO CORTE NESTA TELA", "pra"→"para") = tradutor ativo mutando o DOM. Fecha também o **Bug A histórico** (tela branca NF 556392, mesmo operador): antes do airbag o crash derrubava a árvore inteira sem rastro; a 1ª captura do airbag identificou o gatilho. Pilha 100% react-dom, zero manipulação direta de DOM no código (verificado).

---

## INV-045 — Anexo não-suportado FORA da seleção (modais oc=33)

**Regra.** Arquivo que o SSW não aceita (nem imagem JPEG/PNG nem PDF) fica fora do universo de seleção dos modais de oc=33 (solo e combo 33+44): (1) a pré-seleção marca o primeiro anexo **SUPORTADO** via fonte única `primeiroAnexoSuportadoSsw` (`lib/anexos-ssw-elegiveis.ts`), nunca o primeiro da lista; (2) não-suportado é linha **informativa sem checkbox**; (3) a validação do confirmar **ignora** não-suportados (console.warn), nunca bloqueia. As três peças juntas eliminam a categoria "inválido dentro da seleção" — sem ela, não existe estado travado.

**Guard:** INV-045 no verify-cockpit (uso ≥3 + testes com âncora + zero pré-seleção cega + zero muro "Remova:").

**Cenário real:** 2026-07-23 — NF 814961 (DUILIO/O.V.D.): 1º anexo do cliente era `image001.gif` (logo de assinatura, 8 KB). Pré-seleção cega marcou; checkbox desabilitado (`disabled={!ehImg && !ehPdf}` — feito pra impedir marcar, também impedia desmarcar); confirmar bloqueava com "SSW só aceita JPEG/PNG/PDF. Remova: image001.gif". Operador preso. Padrão copiado nos 2 modais.

---

## INV-046 — oc 41/56 NUNCA lança sem o texto do operador (3 camadas)

**Regra.** 41 (informação complementar) e 56 (falta info operacional) existem POR CAUSA do texto do operador que vai direto pro SSW. (1) Front: `decidirCliqueAprovacao` roteia `lancar_ocorrencia` de `OCS_COM_INPUT_OBRIGATORIO` (41/44/55/56) pra rota `abrir-input` — o ⭐ RECOMENDADA ABRE o painel expandido existente (que valida obrigatoriedade), nunca aprova direto. (2) Backend fail-closed: `camposObrigatoriosAusentes` (`_shared/descricao-ssw.ts`) exige `extras.texto_descricao` pra 41/56 — front atropelado vira erro visível no executor, nunca lançamento mudo. (3) SQL vivo: nenhuma aprovação de 41/56 sem texto em 24h. 3ª regressão da classe aprovação-às-cegas (INV-041 fechou e-mail; esta fecha input).

**Guard:** INV-046 no verify-cockpit. **Cenário real:** 2026-07-23 — NF 62566 (LARISSA/MEDH): ⭐ RECOMENDADA aprovou a 56 com `extras: null` (provado no AprovacaoOperador) → oc saiu pro SSW com a descrição genérica da proposta, sem o texto dela.

---

## INV-047 — Extravio parcial com trilha de indenização destaca 59; par 59+email sempre no cardápio

**Regra.** (1) `decidirOc49` caso extravio_parcial consulta `temContextoIndenizacao` (`_shared/contexto-indenizacao.ts`): oc 59 no histórico (sinal forte) ou instrução com ROMANEIO (explícito) → destaca 59 via template `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` (já no set `TEMPLATES_INDENIZACAO_59` — fonte única do destaque). "VALOR"/"DESCRIÇÃO" sozinhos não contam (anti-falso-positivo). (2) As regras da família tratativa (49/26/23/43) têm SEMPRE o par completo da 59 (com e sem e-mail) — a operadora decide mesmo quando o agente destacar outra.

(3) Re-análise que **muda o trilho** (54↔59) converte o todo clicável COMPLETO — `repatcharTemplateEmail54Existente` troca codigo_ssw + acao_key + template (não só template; senão destaque :59 aponta pra todo :54 = "ação não está mais pendente"). (4) **FORÇAR ATUALIZAÇÃO re-dispara o agente** pras ocs cobertas ({10,11,19,35,49}) — a decisão do banner nunca fica em cache. (5) **Invalidação automática por VERSÃO de regra** (`VERSAO_REGRAS_ANALISE` — BUMP obrigatório a cada mudança na lógica de decisão): o cron invalida análises `concluida` de cards com banner VIVO (AVH/AGUARDANDO_AGENTE/AGUARDANDO_CLIENTE) cuja versão carimbada difere → re-análise automática pós-deploy, **sem o operador clicar em nada** (regra do Caio 23/07: "sem esse trabalho manual"). TRANSFERIDO fica fora (banner morto — 425 cards, custo de IA sem valor). (6) **REGRA DAS 4 OPÇÕES (Caio 23/07)**: card com oc 49 tem SEMPRE `54±email` e `59±email` ativas — o agente sugere, a OPERADORA decide, e a escolha alimenta o loop de aprendizado. Consequências estruturais: `aplicarOverrideCodigoCliente` APOSENTADA (identidade — converter 54→59 comia a opção 54+email) e o repatch mira o todo do trilho destacado trocando SÓ o template (nunca converte; ausente → proporAutoAcao cria pelo par nativo). (7) **Relançamento 59 SEM e-mail**: histórico no formato `49←[46...]←59` (indenização recobrando o que JÁ foi pedido — o e-mail foi junto da 59 anterior) → caso `relancamento_indenizacao`, destaque `lancar_ocorrencia:59` (template nulo), banner "Relançar oc=59 (sem e-mail) — cliente já cobrado". Detector puro `ehRelancamento59SemEmail` (cadeia quebrada por qualquer outra oc → fluxo normal 59+email).

**Guard:** INV-047 no verify-cockpit (6 checks). **Cenário real:** 2026-07-23 — NF 1100040 (LARISSA/UNIAO QUIMICA): histórico 59 ("aguardando romaneio + descrição/valor") → 46 → 49 "AG DESCRICAO E VALOR"; agente destacou 54+EXTRAVIO_PARCIAL e o cardápio só tinha o gêmeo sem-email da 59. 2ª rodada no MESMO dia: fix deployado mas "não pegou" na tela — FORÇAR não re-rodava o agente (cache) e, re-rodado por trás, o repatch só trocou o template (todo :54 com destaque :59). Lição: retroativo de cards pré-existentes é PARTE do fix.

---

## INV-049 — O front TEM typecheck real no caminho até produção

**Regra.** (1) O script `build` do `apps/cockpit-web` roda `npm run typecheck && vite build` — a Vercel FALHA o deploy em erro de tipo (falha segura: a versão anterior continua servindo, em vez de crashar na mão do operador). (2) O script `typecheck` aponta pro config REAL: `tsc --noEmit -p tsconfig.app.json`. **Armadilha nomeada:** o `tsconfig.json` raiz é solution-style (`"files": []` + references) — `npx tsc --noEmit` SEM `-p` checa zero arquivos e sempre sai 0. NUNCA aceitar esse comando como evidência de "tsc OK". (3) Estado (useState/useRef) e o JSX que o consome moram no MESMO componente — o typecheck (TS2304) é a trava mecânica disso.

**Guard:** INV-049 no verify-cockpit (gate no build + config real + tsc rodando de fato). **Cenário real:** 2026-07-24 — commit `a37100f` (F4 popup de divergência) renderizou `DivergenciaMotivoDialog` dentro de `ValidacaoHumanaList` usando `divergInfo`/`divergResolver` que vivem no `ProposedActions` → `ReferenceError: divergInfo is not defined` em TODA abertura de card, TODOS os operadores travados na primeira manhã pós-deploy. O erro era um TS2304 trivial que atravessou merge + build + deploy porque nenhuma etapa checava tipos — e os "tsc OK" históricos eram o comando vazio.

---

## INV-050 — ⭐ RECOMENDADA roteia pra janela da ação; popup F4 diverge só da sugestão VIGENTE

**Regra.** (1) `decidirCliqueAprovacao` tem rota pra TODA ação com janela própria — incl. `modal-oc33-solo` e `modal-combo-3344` (modal de anexos com conversão PDF→JPEG) — e o roteador ⭐ mapeia cada destino pro setter do modal correspondente. Ação com janela NUNCA cai em `aprovar-direto`. (2) Quando a recomendada exige input (41/44/55/56) e está expandida (rota `abrir-input`), o ramo ⭐ cai no render normal com o painel aberto — o clique sempre tem efeito visível. (3) `detectarDivergencia` só acusa divergência quando NENHUMA sugestão viva do card endossa a ação aprovada: todo `recomendada=true`, todo nascido do fluxo pós-resposta (`meta.origem = 'vinculador_pos_resposta_cliente'` — camada mais nova por definição, cobre cards com `ia_sugestao_oc_resposta` nulo), interpretador (`ia_sugestao_oc_resposta`: `oc_sugerida`/`sugere_oc33_solo`/`sugere_combo_33_44`/`sugere_combo_44_59`), ou mesmo código em variante ±email (regra das 4 opções — prerrogativa da operadora). Gêmeo sem-email do MENU comum (meta `modo='sem_email'`, sem origem pós-resposta) segue divergindo — é o aprendizado legítimo. Aprovar a ⭐ que a própria UI mostra NUNCA abre popup.

**Guard:** INV-050 no verify-cockpit (rota + handler + painel + endosso + testes-âncora). **Cenário real:** 2026-07-24 — NF 158084 (DUILIO): ⭐ "Lançar 33" aprovou às cegas (`anexos_ids=[]`) → executor reverteu por completude; e o popup F4 disparou contra o banner VELHO (59+email de antes da resposta do cliente) — motivo digitado pelo operador: "Sugeriu 33 eu aprovei lançar 33 e apareceu o pop up - errado" (23 popups/22 cards no dia). NF 1094294 (LARISSA): ⭐ 56 clicada → rota `abrir-input` setava `expandidoId`, mas o ramo ⭐ fazia early-return sem painel → clique morto, aprovação nunca chegou ao banco.

---

## INV-052 — Onda 1 da auditoria 25/07: resposta nunca engolida + oc33 sem loop + fila drenada

**Regra.** (1) **Regra da oc no acionamento** (Caio 25/07, verbatim no código): quem define "está no cockpit" é a OCORRÊNCIA — estado terminal + oc de relacionamento/cliente (`ocPertenceAoCockpit`) → resposta ACIONA (terminal transitório do confirmador não engole resposta); oc fora do escopo → anexa sem mover (tratado de verdade, ex. 158084 oc=46). (2) **Relançamento pós-resposta é isento do auto-cancel** (`ehPropostaPosRespostaMesmaOc`): a proposta mira a MESMA oc por construção — "lançada por fora" nunca vale pra ela. (3) **Romaneio coberto por FILENAME** (`anexosCobremRomaneio`, _shared + espelho front): anexo do operador SÓ pula o bloco do romaneio se for o próprio arquivo ou páginas convertidas `<base>_pN.jpg`; assinatura PNG não vale; modais barram confirmação sem o romaneio exigido pelo dossiê nomeando o arquivo. (4) **Modais oc33 só oferecem anexo vivo** (`.is('deletado_em', null)`). (5) **Scan idempotente + dreno**: card terminal ou sinal já decidido/tratativa escolhida → skip (nunca clobbera decisão nem re-adota); consumo em loop com RUN_BUDGET_MS.

**Guard:** INV-052 no verify-cockpit (5 greps + teste-âncora + SQL vivo "resposta muda em card ativo = 0"). **Cenário real:** 24-25/07 — NFs 150431/174438 (+4) com resposta engolida por TRANSFERIDO transitório; 158084 2× aprovar→reverter (romaneio) e 134/134 relançamentos comidos pelo sync; NF 2549 com a mesma thread re-importada 44× (loop VIVO durante a auditoria); fila scan com 94k/27 dias. Retroativos executados: 7 cards destravados (RetroativoRespostaDestravada) + 27 relançamentos restaurados (RetroativoTodoRestaurado).

---

## INV-053 — Onda 2 da auditoria 25/07: conversão JBIG2 ligada + aprovação nunca às cegas em NENHUMA superfície

**Regra.** (1) `convertPdfBlobToJpegFiles` passa `wasmUrl` (assets em `public/pdfjs-wasm/`, nomes sem hash, espelho byte-a-byte do pdfjs-dist instalado — teste `pdfjs-wasm-sync`); o guard NF-135724 é rede de segurança, não muro. (2) Popup F4 só COLETA o motivo; o registro roda DEPOIS do `aprovar_e_executar` OK (NF 1094098: 4 motivos órfãos pra 1 aprovação); sugestão cuja acao_key não existe no cardápio pendente não popa (NF 1122403). (3) Gêmeo sem-email SEMPRE renderiza pelo ramo próprio (confirm deliberado + rótulo honesto com a oc real), mesmo destacado. (4) `ProposalCard` (cards fora de AVH) e `SugestaoIATopBox` roteiam pela fonte única `decidirCliqueAprovacao` — ação com janela nunca aprova direto dessas superfícies. (5) Botão confirmar do painel expandido usa lock GLOBAL (`aprovacaoEmVoo`). (6) gmail-poll não memoiza falha transitória como "sem NF".

**Guard:** INV-053 no verify-cockpit (7 checks). **Cenário real:** 24-25/07 — PDF JBIG2 da 158084 (contorno manual desnecessário: o decoder já estava instalado, só desligado); TopBox morto em 14/15 cards; 634 todos oc33/combo expostos a aprovação às cegas fora de AVH; NFs 101182/343285 com ⭐ mentindo "com email".

---

## INV-057 — Thread pré-existente é importada UMA vez por card

**Regra.** `processarAdocaoJob` decide por `decidirAdocaoThread` (fonte única, `_shared/adocao-thread.ts`) ANTES de tocar o Gmail: pula quando o card já tem ESSA thread como `tratativa_email_escolhida` (sinal gravado pela própria adoção — idempotência natural), quando o card está em estado terminal, ou quando faltam card/thread. Thread DIFERENTE segue adotando (o operador pode trocar a tratativa). Como job repetido passa a custar 1 leitura, o laço drena os repetidos em série (`ADOCAO_DRENO_MS`) enquanto a adoção real (Gmail + anexos + IA) permanece 1 por ciclo.

**Guard:** INV-057 no verify-cockpit (trava + dreno + teste-âncora + SQL vivo "nenhuma thread importada 2x no mesmo card em 24h"). **Cenário real:** 2026-07-26 — fila de adoção com **15.052 jobs para 59 cards** (campeão 2.504); NF 166229 re-importada **105x em um dia** (105 movimentações do card, 105 recriações de proposta, 111 chamadas de IA); custo de IA do dia 6x o normal; no ritmo do cron (1 job/2min) o desperdício duraria ~21 dias. Cadeia da causa: produtor enfileira 1 scan por e-mail sem dedup (raiz antiga) + o dreno do INV-052 (25/07) converteu 13 dias de backlog represado em adoções reais de uma vez (gatilho). Lição: ao destravar uma fila, medir o que ela ALIMENTA, não só o que ela acumula.

---

## INV-058 — Toda fila de trabalho tem vigia (e drenar represa exige medir a jusante)

**Regra.** `checkPgmqAcumulada` (health-check) percorre `FILAS_VIGIADAS` — lista com limite por fila — e alerta o Caio quando qualquer uma passa do limite. Fila nova de trabalho ENTRA na lista junto com o consumidor. Regra irmã, aprendida na dor: **ao destravar/drenar uma fila represada, medir o que ela ALIMENTA antes** (o dreno converte represamento em trabalho real de uma vez).

**Guard:** INV-058 no verify-cockpit. **Cenário real:** 2026-07-26 — `scan_email_pre_card` acumulou **94.084 mensagens em 13 dias** sem nenhum alerta (o vigia só olhava `agent_executor` e `respostas_envio`); o dreno do INV-052 (25/07) converteu esse backlog em **15.052 jobs de adoção** que re-importaram threads centenas de vezes (NF 166229: 105x em um dia, custo de IA 6x o normal). Diagnóstico mediu que o produtor NÃO estava mais duplicando (a memória de avaliação do gmail-poll, 23/07, já havia fechado a torneira) — por isso a correção foi vigia + trava de idempotência (INV-057), não dedup por RPC.

---

## INV-061 — Agente oc 43: 49 vs 55 pela oc anterior, lançamento só via envelope, shadow-first

**Regra.** Card em oc 43 ("manutenção perecível realizada" — Relacionamento) é automatizado por `agente-oc43-autonomo`. O agente consulta o SSW ao vivo (`listarOcorrenciasNF`, pois a oc anterior NÃO está no card — `historico_ssw=null`), acha a oc IMEDIATAMENTE anterior à 43 e decide via `decidirOc43DoHistorico`: anterior ∈ `OCS_ANTERIOR_LANCA_49` = {3,6,8,9,10,11,13,16,17,18,19,20,23,31,35} → **oc 49**; qualquer outra → **oc 55**; sem oc anterior (43 é a 1ª) → **não lança** (deixa AVH manual). **Guard pós-43 (Duílio 2026-07-31):** a decisão é pela oc ANTES da 43; se DEPOIS da 43 o SSW virou PROBLEMA (∈ whitelist) ou já FINALIZOU (entregue/baixado, `OCS_FINALIZADORAS_POS43`={1,30,32}) → não lança (`bloqueiaPos43`). **Trânsito normal depois da 43** (5=viagem/7=chegada/14=entrega iniciada/40=redespacho) **NÃO bloqueia** — lança a 55 assim mesmo e o tripé barra só os entregues no submit (perecível entrega rápido, o card nasce estále). O lançamento é SEMPRE via `auto_aprovar_e_executar` → executor → envelope `lancarSswPortal` (tripé CTRC+NF+localização + idempotência) — o agente **nunca** chama o SSW direto (convenção #2). Rollout **shadow-first**: `oc43_cockpit_enabled` (roda) separado de `oc43_agente_autonomo_enabled` (lança); em shadow só marca `agente_oc43_status='recomendado'` + `card_event`. oc 55 é responsabilidade **Operação** — o Cockpit lança oc de Operação autônomo aqui (registro deliberado de blast radius).

**Guard:** INV-061 no verify-cockpit (testes da lógica pura + whitelist + envelope + não-chamada-direta + shadow) e `_shared/oc43-regras.test.ts` (11 casos). **Cenário real:** 2026-07-29 — a oc 43 caía em AVH travado com 8 botões manuais (`REGRAS_AUTO_ACAO[43]`, que gera 55 mas NÃO gera 49); a operação lançava 49/55 na mão dependendo do que veio antes. Duílio pediu a automação. Casos-âncora: NF 467507 / 287906 (os 2 cards vivos em AVH oc 43 no dia). Backlog vivo pequeno (~3-5/dia); mig 314 (colunas `agente_oc43_*` + flags + cron 10min).

---

## INV-062 — Extravio total escalado oferece 59 no menu pós-resposta (âncora≠59)

**Regra.** Extravio TOTAL que escalou pra oc 49/54 ("PRAZO PERDAS EXPIRADO") cai no trilho TRATATIVA do menu pós-resposta (`trilhoIndenizacao = anchorOc===59` → false), que por padrão não oferece o 59 de indenização. Como o desfecho de extravio total É indenização (59, pedir romaneio), o menu **mantém/revive** o 59+email (template `EXTRAVIO_TOTAL_PEDIR_ROMANEIO`) que o override 54→59 já criou. **Sinal de "extravio total"** (durável, sobrevive à sobrescrita do agent_state na escalada): a presença de QUALQUER todo oc 59 com esse template — só o override de total cria isso, então o gate `ehExtravioTotal` é **inerte** pra qualquer card que não seja extravio total. Não revive se já houver 59+email ativo (índice único `uniq_todos_card_tool_cod_ativo`).

**Guard:** INV-062 no verify-cockpit + `oc59-extravio-total.test.ts` (helpers puros `ehExtravioTotalPorTodos59` / `escolher59IndenizacaoParaReviver`). **Cenário real:** 2026-08-05, NF 1102187 UNIAO QUIMICA (LARISSA) — banner IA recomendava "oc 59 + email" (extravio total) mas o menu (âncora 49) não oferecia 59 lançável; os 59 do override foram cancelados pela escalada + "obsoleta após resposta". Relacionado a [[INV-060]] (mesmo arquivo, mesma família da separação 54/59).

---

## INV-063 — TODO acesso SSW (leitura E lançamento) pela conta de serviço; idempotent_skip só com verdade do SSW

**Regra (Caio 2026-08-06).** (a) **Credencial única:** `readSswInternalEnv` resolve SEMPRE `SSW_LANCAMENTO_*` (conta de serviço `ai.salex`), ignorando operador; `loadSswInternalEnvForCard` não consulta mais `cards`/`operadores` (curto-circuito). A cadeia por-operador/legado (`SSW_INTERNAL_<NOME>_*` / `SSW_INTERNAL_*`) é fallback SÓ de dev/test. **NUNCA reintroduzir resolução por login pessoal de operador** — supersede a frase do INV-013 "resolução por-operador fica pra leitura". (b) **Relançamento:** no envelope `lancarSswPortal`, hit no UNIQUE com `sucesso=true` NÃO é skip cego — `decidirIdempotenciaRelancamento` consulta a última oc real do SSW: skip só se recente (<10min, duplo-clique/redelivery PGMQ), sem-verdade (conservador), ou oc pedida já no topo; senão RELANÇA (re-aprovação de todo ressuscitado após oc externa é intenção nova).

**Arquivos:** `supabase/functions/_shared/ssw-internal-client.ts` (readSswInternalEnv / loadSswInternalEnvForCard), `supabase/functions/_shared/lancar-ssw-portal.ts` (decidirIdempotenciaRelancamento).

**Como verificar:**
```bash
# (a) loadSswInternalEnvForCard não pode voltar a consultar o banco
VIOL1=$(sed -n '/export async function loadSswInternalEnvForCard/,/^}/p' supabase/functions/_shared/ssw-internal-client.ts | grep -c "\.from(" | tr -d ' ')
# (b) skip cego não pode voltar: o branch sucesso===true precisa decidir via helper
VIOL2=$(grep -c "decidirIdempotenciaRelancamento" supabase/functions/_shared/lancar-ssw-portal.ts | tr -d ' ')
{ [ "$VIOL1" -eq 0 ] && [ "$VIOL2" -ge 2 ]; } && echo "INV-063: PASS" || echo "INV-063: FAIL (loadForCard .from=$VIOL1 deve ser 0; decidir=$VIOL2 deve ser >=2)"
# Testes unitários:
# deno test supabase/functions/_shared/ssw-credencial-unica.test.ts
# deno test supabase/functions/_shared/relancamento-idempotencia.test.ts
```

**Cenário real (2 causas independentes no mesmo dia, 2026-08-06):** (a) o login pessoal `l.silva` — fallback legado de leitura pros operadores sem secret (JULIA/FELIPE/KAROLINE/LARISSA) e credencial fixa do `atualizar-card-via-portal-ssw` — parou de autenticar no SSW ~11h-12h30 BRT (200 com só cookie `remember`): 639 `AgenteOcsPadraoFalhou` em 4h30, "Edge Function returned a non-2xx status code" no Forçar Atualização (todos os cards) e no Trazer Histórico/aprovações dos 4 operadores. Quem tinha secret próprio (DUILIO/VICTOR/ISABELY) seguiu funcionando — a divisão provou a causa. Mitigação imediata: secrets legados repontados pra ai.salex. (b) NF 236391: oc=54 lançada com sucesso → oc=21 externa por cima → revert ressuscitou o todo → re-aprovação batia na linha `sucesso=true` → `idempotent_skip` afirmava sucesso sem chamar o SSW → guard de confirmação (oc real 21≠54) revertia → loop eterno (2 ciclos/min em produção).

---

## Mapa: arquivo → invariantes aplicáveis

Lookup que o hook PreToolUse usa quando dispara:

| Arquivo | Invariantes |
|---|---|
| `supabase/functions/_shared/confirmar-acao-executada-ssw.ts` | INV-002 |
| `supabase/functions/sync-bastao/index.ts` | INV-003, INV-004, INV-006, INV-007, INV-008, INV-011, INV-014, INV-019, INV-023, INV-040 |
| `supabase/functions/_shared/guard-anti-loop-criacao.ts` (guard anti-loop de fabricação) | INV-040 |
| `supabase/functions/_shared/decidir-visibilidade-ssw.ts` (por identidade, ADR 0011) | INV-023 |
| `supabase/functions/_shared/inv023-indefinido-preso.ts` (monitor indefinido preso) | INV-023 |
| `supabase/functions/_shared/lag-lancamento-54.ts`, `supabase/functions/_shared/ssw-data-hora.ts` (per-hora, ADR 0009 superseded — atrás da flag OFF) | INV-023 |
| `supabase/functions/_shared/escopo-relacionamento.ts` | INV-014 |
| `supabase/functions/_shared/operador-resolver.ts`, `migration/2026-04-29_007_operadores_seed_e_trigger.sql` + `migration/2026-07-21_305_fallback_orfao_isabely_ssw_prefix.sql` (trigger `cards_resolve_operator` + fallback), `loadSswInternalEnvForCard` em `_shared/ssw-internal-client.ts` (`ssw_secret_prefix`) | INV-038 |
| `supabase/functions/voltar-para-to-do-com-rastreio/index.ts` | INV-001, INV-005 |
| `supabase/functions/_shared/ssw-internal-client.ts` | INV-001, INV-012, INV-013, INV-063 |
| `supabase/functions/_shared/lancar-ssw-portal.ts` | INV-013, INV-063 |
| `supabase/functions/interpretador-evidencia-foto/index.ts` | INV-001, INV-012 |
| `supabase/functions/executar-sugestao-evidencia/index.ts` | INV-012 |
| `supabase/functions/foto-oc-card/index.ts`, `supabase/functions/r-evidencia/index.ts` | INV-012 (galeria — únicas autorizadas a `obterFotoDaOc`) |
| `supabase/functions/executor/index.ts` | INV-002 (escreve campos preservados pelo helper), INV-008, INV-011, INV-013, INV-034 (`gateOc33Enforce`) |
| `supabase/functions/_shared/verificar-evidencia.ts` | INV-001, INV-011 |
| `supabase/functions/revalidar-evidencia-card/index.ts` | INV-011 |
| `lib/bastao-rules.ts`, `supabase/functions/_shared/bastao-rules.ts` | INV-010, INV-008 |
| `supabase/functions/_shared/regras-auto-acao.ts` | INV-004, INV-008, INV-034 |
| `supabase/functions/_shared/extravio-parcial-dossie.ts` (dossiê + gate, fonte única), `supabase/functions/interpretador-resposta-cliente/index.ts` (popula dossiê), `supabase/functions/_shared/propostas-pos-resposta-cliente.ts` (gate) | INV-034 |
| `supabase/functions/_shared/transicao-aguardando-cliente.ts` | INV-006, INV-008 |
| `supabase/functions/_shared/limite-anexos.ts`, `supabase/functions/upload-anexo-email/index.ts` | INV-015 |
| `supabase/functions/_shared/oc43-regras.ts`, `supabase/functions/agente-oc43-autonomo/index.ts` | INV-061 |
| `supabase/functions/_shared/gmail-reader.ts` (`extrairAnexos`/`selecionarAnexosParaSalvar`), `supabase/functions/gmail-poll-inbox/index.ts`, `supabase/functions/reprocessar-anexos-mensagem/index.ts` | INV-025 |
| `supabase/functions/_shared/propostas-pos-resposta-cliente.ts` (fonte única) | INV-016 |
| `supabase/functions/scan-email-pre-card/index.ts`, `supabase/functions/cron-ia-resposta-pendentes/index.ts`, `supabase/functions/reprocessar-dlq/index.ts` | INV-016 |
| `supabase/functions/vinculador/index.ts` | INV-011, INV-016 |
| `supabase/functions/_shared/extravio-routing.ts`, `supabase/functions/_shared/reconciliar-extravios-bastao.ts`, `supabase/functions/sync-extravios-bastao/index.ts`, `supabase/functions/_shared/bastao-client.ts` | INV-017 |
| `supabase/functions/sync-bastao/index.ts` (Pass A `aguardandoClienteVirouOutraRelacionamento` + sweep `selfHealAguardandoClienteOcRelacionamento`), `supabase/functions/health-check/index.ts` (watchdog `checkAguardandoClienteOcRelacionamento`) | INV-019 |
| `supabase/config.toml` | INV-009 |
| `apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx` (botão ⭐ RECOMENDADA) | INV-041 |
| `apps/cockpit-web/src/components/cards/EditarEmailModal.tsx`, `apps/cockpit-web/src/components/cards/BannerInline54Composer.tsx` (aval skip_evidencia ocs 10/11/35) | INV-041 |
| `apps/cockpit-web/src/main.tsx`, `apps/cockpit-web/src/components/ErrorBoundary.tsx` (airbag) | INV-041 |
| `apps/cockpit-web/index.html` (lang pt-BR + notranslate) | INV-044 |
| `apps/cockpit-web/src/lib/anexos-ssw-elegiveis.ts` (fonte única), `apps/cockpit-web/src/components/cards/ProposedActions.tsx` (2 modais oc=33) | INV-045 |
| `apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts` (rota abrir-input), `supabase/functions/_shared/descricao-ssw.ts` (texto obrigatório 41/56) | INV-046 |
| `apps/cockpit-web/package.json` (gate typecheck no build), `apps/cockpit-web/tsconfig.app.json`, `apps/cockpit-web/src/lib/types.ts` (tipos espelham o banco) | INV-049 |
| `apps/cockpit-web/src/components/cards/ProposedActions.tsx` (DivergenciaMotivoDialog mora no dono do estado divergInfo) | INV-049 |
| `apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts` (rotas modal-oc33-solo/modal-combo-3344), `apps/cockpit-web/src/lib/divergencia.ts` (endosso da sugestão vigente) | INV-050 |
| `apps/cockpit-web/src/pages/Aprendizado.tsx` (confirmação no Rejeitar + trilha de revisadas), `apps/cockpit-web/src/lib/melhorias.ts` (podeReabrir/nasceuDaMinhaResposta), `migration/2026-07-25_312_reabrir_learning_log_e_retroativo.sql` (RPC reabrir) | INV-051 |
| `supabase/functions/_shared/anthropic-client.ts` (retry com teto dobrado + `repararJsonTruncado`), `supabase/functions/_shared/interpretador-degradacao.ts` (breaker + sugestão determinística), `supabase/functions/interpretador-resposta-cliente/index.ts` (maxTokens compatível com o schema) | INV-055 |
| `supabase/functions/_shared/contexto-indenizacao.ts`, `supabase/functions/agente-sugere-ocs-padrao/index.ts` (caso parcial), `supabase/functions/_shared/regras-auto-acao.ts` (par 59 nas regras 49/26/23/43) | INV-047 |
| `supabase/functions/_shared/acionamento-resposta-cliente.ts` (fonte única), `supabase/functions/vinculador/index.ts` (2 caminhos), `supabase/functions/health-check/index.ts` (`checkRespostaClienteEngolida`) | INV-042 |
| `supabase/functions/_shared/gmail-poll-batch.ts` (rodízio: `lastPollAtDoEmbed`/`ordenarPorDefasagem`), `supabase/functions/gmail-poll-inbox/index.ts` (fatia por caixa), `supabase/functions/health-check/index.ts` (`checkCaixaGmailSemPoll`) | INV-043 |

## INV-141 — A inversão "ilegível = parcial" vive SÓ dentro da whitelist (REGRA INVIOLÁVEL)

**Regra (Caio 2026-09-03, ADR 0025):** `analisarExtravio` trata instrução ilegível como **extravio TOTAL** (conservador) e isso vale para **todos os clientes**. A inversão pedida no briefing da oc 55 automática — ausência de sinal de total = parcial — existe **exclusivamente** dentro de `seguir-parcial-auto.ts`, atrás do gate de CNPJ. Inverter o default global mudaria template de e-mail, escolha 54×59 e dossiê de 651 clientes de uma vez.

**Além disso:** "sinal de extravio total" são **duas** condições em OU — (1) a palavra TOTAL/PERDA TOTAL/FALTA TOTAL, **ou** (2) quantidade lida ≥ volumes da NF. Só a (1), como diz o briefing ao pé da letra, classificaria errado 4 de 23 cards de oc 06 medidos (17%): a unidade escreve só o número. Âncora: **NF 29642, instrução `9`, NF de 9 volumes** — extravio total que receberia uma 55 mandando entregar carga inexistente.

**E mais (2026-09-03, achado auditando a 3a cópia do parser):** a leitura da quantidade tem de passar pela limpeza **FORTE** (`removerMarcadoresSswmobile`) antes do parser. O repo tem dois níveis de limpeza e eles **não** são equivalentes: `limparInstrucao` (dentro de `extravio-qtd-volumes`) tira só `(SSWMOBILE)`/`GPS`; `removerMarcadoresSswmobile` chama `sanitizarTextoSsw` (que remove **comentários e tags HTML** — caso de produção NF 1494821, o portal devolve `<!--...--><a href=# onclick=showMapaVeic(...)><u>GPS</u></a>`) e ainda limpa `Protocolo: N`, `SEFAZ-XX` e `cte.fazenda.gov.br`. `agente-sugere-ocs-padrao` já usava a forte; este módulo usava a fraca. Isso é inofensivo em `analisarExtravio` (lá `qtd` nulo vira TOTAL, conservador) e **perigoso aqui**, porque o D3 inverte o default: nulo vira parcial e lança 55. Medido: `9 <!--x--><u>GPS</u>` devolve `null` na fraca e `{qtd:9}` na forte — numa NF de 9 volumes, a fraca lançaria 55 num extravio TOTAL. A limpeza forte **não** rouba os casos legítimos do D3 (`1 V`, `F1 (SSWMOBILE)`, `1 PROVAVELMENTE ERRO...`): esses continuam ilegíveis e seguem parciais. `limparInstrucao` **não** foi alterado — ele serve `analisarExtravio`, que roda para todos os clientes.

**Arquivos:** `_shared/seguir-parcial-auto.ts` (decisão pura + gate), `_shared/extravio-qtd-volumes.ts` (parser extraído, fonte única), `_shared/extravio-enrichment.ts` (default TOTAL preservado + re-export).

**Como verificar:**
```bash
grep -c 'const isTotal = !qtd ||' supabase/functions/_shared/extravio-enrichment.ts   # >= 1 (default global intacto)
grep -c 'cnpj_fora_da_whitelist' supabase/functions/_shared/seguir-parcial-auto.ts    # >= 1 (gate existe)
grep -c 'removerMarcadoresSswmobile' supabase/functions/_shared/seguir-parcial-auto.ts # >= 2 (limpeza FORTE)
grep -cE 'extrairQtdVolumes\(instrucao' supabase/functions/_shared/seguir-parcial-auto.ts # == 0 (nunca a leitura crua)
deno test --no-check --allow-net --allow-env supabase/functions/_shared/seguir-parcial-auto.test.ts
deno test supabase/functions/_shared/extravio-qtd-volumes.test.ts
```

---

## INV-142 — Nada da oc 55 automática nasce LIGADO, e falha nunca abre o portão

**Regra (ADR 0025):** três estados iniciais são obrigatórios e o smoke test das migrations os trava: flag mestra `seguir_parcial_auto_enabled` **OFF** (mig 379), modo sombra `seguir_parcial_auto_sombra` **ON** (mig 380 — sombra ON = decide e registra, **não lança**), e as 4 linhas do seed com `ativo=false`. O loader `seguir-parcial-carregar.ts` **nunca lança**: erro de flag, tabela ausente, RLS ou exceção crua devolvem `CONTEXTO_INERTE`. A sombra é fail-safe ao contrário das demais — ausência ou erro significam sombra **ON**; só sai dela com a linha existindo e `enabled=false` explícito.

**Por quê:** o loader é chamado de dentro de caminhos que rodam pra TODOS os clientes (`agente-sugere-ocs-padrao`, `interpretador-resposta-cliente`). Uma exceção ali derrubaria a análise de cards que não têm nada a ver com o projeto. E ocorrência lançada no SSW não tem desfazer.

**Arquivos:** `migration/2026-09-03_377_*.sql`, `migration/2026-09-03_378_*.sql`, `_shared/seguir-parcial-carregar.ts`, `agente-seguir-parcial-auto/index.ts`.

**Como verificar:**
```bash
grep -c "false, 'Caio (briefing 03/09)'" migration/2026-09-03_379_cliente_config_seguir_parcial_auto.sql  # >= 4
grep -c "porKey.get(FLAG_SEGUIR_PARCIAL_SOMBRA) !== false" supabase/functions/_shared/seguir-parcial-carregar.ts  # >= 1
grep -c "return CONTEXTO_INERTE" supabase/functions/_shared/seguir-parcial-carregar.ts  # >= 3
deno test --no-check --allow-net --allow-env supabase/functions/_shared/seguir-parcial-carregar.test.ts
```

**Como verificar (SQL produção, read-only):**
```sql
-- Nenhum CNPJ ativo sem que alguém tenha ligado de propósito.
SELECT cnpj_pagador, nome_cliente, ativo FROM cliente_config_seguir_parcial_auto ORDER BY 1;
-- Sombra ON enquanto não houver conferência das decisões simuladas.
SELECT key, enabled FROM feature_flags WHERE key LIKE 'seguir_parcial_auto%';
```

---

## INV-143 — A oc 55 conta como "cliente ciente" apenas sob opt-in explícito (ADR 0025 D6)

**Regra:** `OCS_NOTIFICOU_APOS_EXTRAVIO` continua `{20, 49, 54, 59}` para todos os callers. A oc 55 só entra na conta quando o caller passa `clienteAutorizaSeguirParcial: true` — e só passa quando o CNPJ está na whitelist ativa. Espelho: a R3 (`decidirParcialSemAutorizacao`) só se cala com `autorizacaoPermanenteDoCliente: true`.

**Por quê:** depois da 55 automática o cliente ressalva na entrega e volta 19/10/35. O único sinal no histórico é a 55 — sem o opt-in, `recusaOriginadaDeExtravioNaoNotificada` concluiria "não avisamos" e mostraria ao operador o banner **falso** "cliente ainda não notificado do extravio". E sem o espelho da R3, o Cockpit lançaria a 55 de um lado enquanto mandava e-mail perguntando "posso seguir parcial?" do outro — duas vozes contraditórias na mesma NF.

Fecha também uma incoerência **pré-existente**: `extravio-parcial-regra.ts` (`houve55AposExtravio`) já tratava 55-pós-extravio como autorização, enquanto `recusa-por-extravio.ts` a ignorava.

**Arquivos:** `_shared/recusa-por-extravio.ts`, `_shared/extravio-parcial-regra.ts`, `agente-sugere-ocs-padrao/index.ts` (2 call sites), `interpretador-resposta-cliente/index.ts` (1 call site).

**Como verificar:**
```bash
grep -c 'OCS_NOTIFICOU_APOS_EXTRAVIO = new Set<number>(\[20, 54, 59, 49\])' supabase/functions/_shared/recusa-por-extravio.ts  # >= 1
grep -c 'clienteAutorizaSeguirParcial' supabase/functions/agente-sugere-ocs-padrao/index.ts       # >= 2
grep -c 'autorizacaoPermanenteDoCliente' supabase/functions/interpretador-resposta-cliente/index.ts  # >= 1
deno test --no-check --allow-net --allow-env supabase/functions/_shared/recusa-por-extravio.test.ts supabase/functions/_shared/extravio-parcial-regra.test.ts
```


---

## INV-144 — O trilho sobrevive a saída não-ASCII em console cp1252 (Windows)

> Numerado **INV-140 até 03/09/2026**. Renumerado porque a mig 377 do Caio usou o 140 no mesmo dia; o dele ficou com o número original. Nenhum outro arquivo referenciava o 140, então a troca é local ao `/verify-cockpit`.

**Regra (Carlos 2026-09-02, ADR 0019):** `scripts/dbq.py` e `scripts/deploy_pendente.py` têm de imprimir acento e emoji sem estourar em console cp1252. O helper `forcar_saida_utf8()` é obrigatório e tem de ser **chamado**, não só existir.

**Por quê:** no `dbq.py` o print vem **depois** do SQL rodar. Um `UnicodeEncodeError` ali sai com exit 1 **com a migration já aplicada** — o operador lê traceback, conclui "falhou" e reaplica.

**Arquivos:** `scripts/dbq.py`, `scripts/deploy_pendente.py`.

**Como verificar:** o check é de **comportamento** (força cp1252 e imprime fora da tabela), não de texto — grep de nome de função passaria com a função vazia.
```bash
PYTHONIOENCODING=cp1252 python3 -c "import sys; sys.path.insert(0,'scripts')
from dbq import forcar_saida_utf8
forcar_saida_utf8()
print('Devolucao — acao ✅')"
```

**Lacuna conhecida:** `.claude/hooks/cockpit-deploy-gate.py` tem a **mesma** classe de defeito (a mensagem de bloqueio sai com mojibake em cp1252) e **não** está coberto por este invariante. Só cosmético — o exit code está certo — mas é dívida aberta.

---

## INV-147 — Pouca tinta não reprova conversão de PDF; o operador confere a página

**Regra (Carlos 2026-09-08, ADR 0026):** no front, página convertida com pouca tinta **não** pode ser reprovada sozinha. Só há bloqueio duro quando (a) o pdf.js avisou que desistiu de desenhar a imagem (`dependent image isn't ready`), ou (b) a folha está praticamente sem tinta (`< PISO_PAGINA_SEM_TINTA`, 0,5%). Na faixa 0,5%–2% o modal mostra a **prévia** e o operador decide. E **uma** página reprovada nunca derruba o PDF inteiro.

**Por quê:** o piso de 2% tratava "pouca tinta" como "conversão perdida". Medido em 08/09 com PDFium (motor que decodifica JBIG2), nos arquivos reais de produção:

| Arquivo | Página | Tinta | Realidade (inspecionada) |
|---|---|---|---|
| `10803714.pdf` (União Química / Larissa) | 1 | 6,41% | ok |
| `10803714.pdf` | 2 | **1,37%** | **legível** — Documento de Transporte, placa manuscrita SEM-7B68, código de barras |
| `Scanned_from_a_Lexmark….pdf` (AGV / Maria) | 4 | **1,23%** | **legível** — ficha de agendamento, placa e motorista à mão |
| `minuta assinada.pdf` (quebra CALADA no pdf.js: 0,38%) | 1 | 2,53% | ok com decodificador bom |
| `NF 135724.pdf` (âncora da ADR 0014) | 1 | 6,16% | ok |

**Contraprova no motor real do front (pdf.js, 08/09)** — harness replicando o `convertPdfBlobToJpegFiles` (legacy + `wasmUrl` + canvas 2.5 + mesmo predicado): pág. 1 do `10803714` = **6,34%** (passa), pág. 2 = **1,35%** (confirma), Lexmark pág. 4 = **1,22%** (confirma), `minuta assinada` = **2,48%** (passa), `NF 135724` = **6,03%** (passa). Os dois motores concordam dentro de **0,15 pp**, e o resultado reproduz o print da produção (pág. 1 passa, pág. 2 reprova).

O piso de 2% **não** foi mexido; mudou a consequência dele. O corte de 0,5% separa "barrar" de "perguntar pro humano", não de "aceitar calado" — e está calibrado em duas classes MEDIDAS com o pdf.js: **decodificador desligado** (rodando sem o wasm, `Jbig2Error: JBig2 failed to initialize`) dá 0,42% e 0,10%; **conteúdo legítimo** dá 1,22% e 1,35%. O piso fica entre 0,42% e 1,22%.

**Premissa corrigida:** o `minuta assinada.pdf` que a ADR 0014 registrou quebrando *calado* a 0,38% **não reproduz mais** — aquela medição é de 17/07 e o `wasmUrl` entrou em 25/07, depois dela. Não usar o 0,38% como âncora viva. O cenário real que o piso protege hoje é os assets de `public/pdfjs-wasm/` deixarem de ser servidos.

**Assimetria deliberada:** `_shared/pdf-conversao-guard.ts` (servidor) mantém o piso como **bloqueio duro**, porque roda em conversão autônoma do romaneio, sem humano pra olhar a prévia. Mesmo limiar, política diferente, de propósito.

**Arquivos:** `apps/cockpit-web/src/lib/pdfConversaoGuard.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx`, `supabase/functions/_shared/pdf-conversao-guard.ts`.

**Como verificar:**
```bash
cd apps/cockpit-web && npx vitest run src/lib/pdfConversaoGuard.test.ts
deno test --no-check --allow-read supabase/functions/_shared/pdf-conversao-guard.test.ts
```

**Dívida aberta (medida, não resolvida):** o PDFium do `converter-anexo-pdf` renderiza corretamente os arquivos que o pdf.js perde. O fallback certo pro sinal (a) é mandar o arquivo pra ele — hoje impossível pelo front porque a edge é `service role only`. Enquanto isso, o contorno segue sendo print/foto.

---

## INV-148 — Na oc 13, VISIBILIDADE e AUTONOMIA são interruptores separados

**Regra (Carlos 2026-09-08, ADR 0026):** em `cliente_config_oc13`, `ativo` decide se o card **aparece** pro operador (lido pelo `sync-bastao` / `bastao-client`) e `autonomo_ativo` decide se o **agente age** (lido só pelo `agente-oc13-autonomo`, com `!== false`). Um jamais pode ser usado no lugar do outro. Cliente novo nasce visível e **sem** robô (`DEFAULT false`, mig 386).

**Por quê:** era um interruptor só. Incluir um CNPJ pra o card aparecer ligava, no mesmo ato, um agente que lança **oc 21 + cancela reentrega** por `auto_aprovar_e_executar`, sem aprovação por card — e que agenda a ação destacada numa **janela de veto de 60 min** que pode disparar e-mail pro cliente. Medido em 08/09: 962 decisões do agente (669 sugerir 54+e-mail, 141 sugerir 21+cancel, 129 sugerir 56, **23 autônomas**), **1.379** oc 21 lançadas com sucesso, flag `acao_autonoma_veto_enabled` **ligada** e a LARISSA habilitada em `acoes_autonomas_veto_operadores`.

Isso contraria a regra do negócio (Carlos, verbatim 08/09): **"o cliente sempre precisa ser notificado antes e somente com a autorização deles é possível seguir."**

**Caso âncora — NF 1037746 / CTRC PRT562381-2 (PRATI DONADUZZI, Larissa):** oc 13 lançada 28/08 15:36, nunca virou card, descoberta só porque o cliente cobrou. A pendência existia no Bastão com `responsavel_relacionamento=LARISSA`; o pagador `73856593001057` não estava na exceção. A Prati já tivera **14** cards de oc 13, todos terminando em TRANSFERIDO. Fix: entra com `ativo=true, autonomo_ativo=false` (mig 387) — aparece, mas nada age sem o cliente autorizar.

**Contra-regra:** o inverso também é bug. Se o `sync-bastao` passar a filtrar por `autonomo_ativo`, o cliente com robô desligado volta a ficar invisível — o bug original, invertido. O guard testa as duas direções.

**Arquivos:** `migration/2026-09-08_385/386/387_*.sql`, `supabase/functions/agente-oc13-autonomo/index.ts`, `supabase/functions/_shared/bastao-client.ts`, `supabase/functions/sync-bastao/index.ts`.

**Como verificar:**
```bash
deno test --no-check --allow-read supabase/functions/_shared/oc13-visibilidade-vs-autonomia.test.ts
# e no banco, depois das migrations:
python3 scripts/dbq.py -tA -c "select nome_cliente, cnpj_pagador, ativo, autonomo_ativo from cliente_config_oc13 order by 1,2;"
```

**O que NÃO fazer:** pôr a oc 13 como Relacionamento no dicionário. Mediria ~120 cards caindo de uma vez em todas as carteiras (contagem do Bastão em 08/09).

## INV-149 — O 59 sobrevive por PENDÊNCIA DE DOCUMENTO, não por "é extravio total?"

**Regra (Carlos 2026-09-09, ADR 0027):** no menu pós-resposta do trilho tratativa (âncora≠59), um to-do de oc 59 **pendente/aprovado** cujo template é um dos três `..._PEDIR_ROMANEIO` (`TEMPLATES_59_PEDIDO_DOCUMENTO`) NUNCA é cancelado como "obsoleto". O critério é **pendência de documento em aberto** — não a natureza do extravio.

**A ASSIMETRIA É A REGRA, não um detalhe:**

| Caminho | Sinal | Alcance |
|---|---|---|
| **Preservar** 59 pendente (whitelist `ehDaListaNova`) | `temPendenciaDocumento59` — 3 templates, só `pendente`/`aprovado` | largo |
| **Ressuscitar** 59 cancelado (bloco 3b) | `ehExtravioTotalPorTodos59` — só `EXTRAVIO_TOTAL_PEDIR_ROMANEIO` | estreito, inalterado |

**Por que a revivência NÃO foi alargada:** mexeria em **3307 cards abertos** de uma vez, e um 59 revivido pode ser auto-aprovado pela janela de veto — medido em 09/09: **75** to-dos de 59 com `auto_approval_rule = veto_janela:agente-sugere-ocs-padrao:lancar_oc_e_enviar_email:59`. Isso é e-mail ao cliente **sem clique do operador**. Preservar um pendente que o próprio sistema acabou de propor não tem esse risco.

**Caso âncora — NF 75249 / CTRC APO563879-8 (LEONE COMERCIO, Karol):** oc 19 (entrega com falta de volumes = **parcial**). `REGRAS_AUTO_ACAO[19]` propôs `[33, 59, 55, 56]` em 03/09 **22:01:31**; o cliente respondeu e o menu pós-resposta **cancelou o 59 às 22:07:07**, pondo "re-lançar 54" no lugar. Os 59 do card carregam `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` e `EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO` — **zero** com o template de total, então o portão antigo (`ehExtravioTotalPorTodos59`) era falso.

**Templates DE FORA de propósito** (são notificação, não pedido de documento): `EXTRAVIO_PARCIAL` (456), `RECUSA_TOTAL` (22), `RECUSA_PARCIAL` (13), `TENTATIVAS_ESGOTADAS` (2) e os 7159 sem template (gêmeos sem e-mail). Incluí-los ofereceria 59 em card sem pendência documental.

**Contra-regra:** o inverso também é bug. Se alguém trocar a whitelist de volta pro sinal estreito, o 59 de card parcial volta a ser cancelado — o guard tem um teste de **fonte** que falha nesse caso.

**Arquivos:** `supabase/functions/_shared/propostas-pos-resposta-cliente.ts`.

**Como verificar:**
```bash
deno test --no-check --allow-all supabase/functions/_shared/oc59-extravio-total.test.ts
```

**O que NÃO fazer:** colapsar `todos59Total` e `todos59PedidoDoc` numa variável só. A query traz os três templates; a partição por template é o que mantém a revivência estreita.

---

## INV-150 — A 33 bloqueada DIZ o que falta, e o espelho do dossiê não pode divergir

**Regra (Carlos 2026-09-09, ADR 0027):** quando o dossiê de extravio parcial está incompleto, a linha da oc 33 no card mostra **o que falta** (`falta romaneio de coleta assinado`, `falta descrição dos itens + valor dos itens`). O gate real **não muda** — segue no executor, e segue bloqueando. Isto é rótulo, não portão.

**Por quê:** o relato chegou como "o sistema não sugere a oc 33". A 33 **estava** sugerida — os to-dos existiam em `pendente` e apareciam na tela. O que travava era a execução, e o motivo só aparecia **depois** de abrir o modal: a linha mostrava "LANÇAR →" como se estivesse pronta. Medido nos dois cards do relato:

| NF | romaneio | descrição | valor |
|---|---|---|---|
| 350882 | **false** | true | true |
| 431734 | true | **false** | **false** |

Mesmo portão, peça faltante diferente. E **162 cards abertos de 10 operadores** estavam no mesmo estado (DUILIO 37, FELIPE 34, KAROLINE 17, MARIA 17, VICTOR 16, INGRID 13, JULIA 12, LARISSA 9, ISABELY 6, CAMILA 1) — não era da Karol.

**O bloqueio é DELIBERADO e não se toca** (ADR 0023, incidente NF 158084): sem romaneio o SSW **reverte** a 33 em loop.

**ESPELHO obrigatório:** `apps/cockpit-web/src/lib/dossie33Faltando.ts` espelha `supabase/functions/_shared/extravio-parcial-dossie.ts` (`ROTULO_EVIDENCIA`, `avaliarDossie`, `decidirGateOc33`, `classificarOc33`) — mesma disciplina do `romaneio-cobertura.ts`. O teste do front **lê o fonte do backend** e falha se os rótulos ou as três checagens `presente` mudarem lá sem mudar aqui. Sem isso o espelho vira detector descalibrado e a tela passa a mentir sobre o que falta.

**Fallback conservador:** sem `caso === "2"` comprovado, toda 33 é tratada como **completude** (exige as 3) — igual ao backend. `null` (card sem dossiê) significa "não sei" e a UI **não afirma nada**; nunca vira "está liberado".

**Arquivos:** `apps/cockpit-web/src/lib/dossie33Faltando.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx`, espelhando `supabase/functions/_shared/extravio-parcial-dossie.ts`.

**Como verificar:**
```bash
cd apps/cockpit-web && npx vitest run src/lib/dossie33Faltando.test.ts
```

**O que NÃO fazer:** transformar o rótulo em gate no front (desabilitar o botão). O operador pode ter motivo pra forçar (`extras.forcar_oc33_dossie_incompleto`), e duplicar o portão no front cria dois lugares pra divergir.

---

## Histórico

- 2026-05-14 — versão inicial com 10 INVs, motivada pelo bug NF 1075381.
- 2026-05-14 (tarde) — INV-011 adicionado pós-bug NF 20761 (evidência ausente falso por múltiplos CTRCs sem ctrcEsperado).
- 2026-06-18 — INV-012 adicionado pós-bug NF 355283 oc=49 (IA + anexo de email puxavam só a 1ª foto; raiz: `obterTodasFotosDaOc` + whitelist de `obterFotoDaOc` só pra galeria).
- 2026-06-22 — INV-013 adicionado pós-bug NF 651244 (Duilio aprovou oc=33, SSW registrou Larissa). Lançamento unificado na conta de serviço `ai.salex` via `readSswLancamentoEnv`.
- 2026-06-23 — INV-014 adicionado pós-bug NF 376924 + 53948 (oc=33 reversão lançada pelo Cockpit virou CONFLITOS). Guard `flagConflitoOcSemMover` ganhou 2º sinal (`AcaoExecutadaConfirmadaPeloSsw`, path-independent) + os 5 callers de oc=33/44 do executor migrados pro envelope `lancarSswPortal` + guard pós-lançamento no `forcaAguardandoClienteOc54`. REGRA INVIOLÁVEL: oc lançada pelo Cockpit nunca é conflito.
- 2026-06-23 — INV-015 adicionado pós-bug NF 719250 (Duilio não convertia PDF→JPEG no modal oc=33). O limite de anexos por card contava `origem='inbound'` (assinaturas/logos inline auto-capturados); card com 29 inbound bloqueava todo upload. Limite passou a contar só uploads do operador (outbound), centralizado em `_shared/limite-anexos.ts`. 18 cards destravados.
- 2026-06-23 — INV-016 adicionado pós-bug NF 761583 (Anthropic 529 derrubou o triador → 13 respostas de clientes no `dead_letter` → cards em CLIENTE RESPONDEU sem botões / nem apareciam). Criação de propostas extraída pra `_shared/propostas-pos-resposta-cliente.ts` (fonte única, determinística); scan-email-pre-card cria direto; novo `reprocessar-dlq` (cron 2min) auto-cura mensagens presas; `cron-ia-resposta-pendentes` ganhou rede de segurança de propostas; health-check alerta o Caio. REGRA INVIOLÁVEL: cliente respondeu → SEMPRE visível no Cockpit com as ações.
- 2026-06-23 (noite) — INV-014 corrigido na RAIZ: o gate de ciclo (`emCicloAtivoDoLancamento` = `acao_executada_em != null`), adicionado mais cedo no mesmo dia, desligava os 2 sinais assim que o Bastão confirmava o lançamento → re-flag em massa de cards já confirmados (NF 359849/44, 1017149/21, 3057294/56, 377696/21). Gate removido (2 sinais rodam SEMPRE); 4 falso-positivos limpos retroativo; test antigo "CASO 2 → FLAGGED" (que codificava o bug) invertido pro guard de regressão. Tradeoff: caso raro de relançamento-por-fora-em-ciclo-novo não é mais pego (decisão do Caio: zero falso-positivo).
- 2026-06-24 — INV-019 adicionado pós-bug NF 175621 (COMPROMISSO, oc=49 presa 5 dias em AGUARDANDO_CLIENTE; 52 cards no total). Raiz: o Pass E (dono da transição relacionamento→AGUARDANDO VOCÊ) foi desligado em 2026-06-22 e o ramo ficou órfão — enforcement acoplado a UM código sumiu em silêncio. Custo: 39 NFs oc=49 sem tratativa (operador não via, agentes não rodavam). Fix em 3 camadas que tornam o desligamento silencioso impossível: (1) Pass A move na hora (`aguardandoClienteVirouOutraRelacionamento`); (2) sweep auto-cura sempre-ligado e desacoplado dentro do sync-bastao (`selfHealAguardandoClienteOcRelacionamento`); (3) watchdog em PROCESSO SEPARADO no health-check (`checkAguardandoClienteOcRelacionamento`, e-mail pro Caio se algum card violar >15min). + probe de código no /verify-cockpit (falha se qualquer camada for removida) + hook de arquivo crítico exige aprovação do Caio. REGRA INVIOLÁVEL: oc de relacionamento ≠54 NUNCA fica preso em AGUARDANDO_CLIENTE.
- 2026-06-25 — INV-025 adicionado pós-bug NF 1486931 (CAMILA). A assinatura da cliente (`image001.jpg`, 138KB, image/jpeg) foi capturada como "o anexo da cliente": passou allowlist de MIME + limite de 10MB (a premissa do fix de 2026-05-29 de que logo de assinatura é "165-4KB típico" não vale — banners de assinatura passam fácil dos 100KB). Raiz: `extrairAnexos` capturava todo part com `attachmentId`+`filename` sem distinguir imagem embutida no corpo de anexo real. Fix: `extrairAnexos` agora classifica `inlineNoCorpo` (lê `Content-Disposition: inline` + `Content-ID` referenciado via `cid:` no HTML) e `selecionarAnexosParaSalvar` (fonte única, usada por `gmail-poll-inbox` E `reprocessar-anexos-mensagem`) ignora os inline **só quando coexiste um anexo real** — espelha o "N anexos" do próprio Gmail. Sem anexo real (foto colada no corpo, NF 647384) a imagem inline continua sendo salva → não regride. Bônus: dedup intra-card por `filename+size` (a mesma NF-e PDF veio 3× de mensagens da thread que a citavam). Guard: `_shared/gmail-anexos-classificacao.test.ts` (7 testes). REGRA INVIOLÁVEL: imagem de assinatura/logo embutida no corpo nunca é salva como anexo do cliente quando há anexo real.
- 2026-06-24 — INV-017 adicionado pós-bug de cards travados na aba EXTRAVIOS (NF 43973 oc 20→1 congelada 121h, 277008/21519 entregues, 650967 oc 33). A decisão de SAIR da aba estava delegada ao pull FILTRADO do Bastão; quando a NF mudava pra fora do filtro ela sumia do pull e não havia reconciliador (runPassB exclui EXTRAVIO_MONITORADO; cron dedicado aposentado na mig 219). Fix: `decidirDestinoExtravio` (fonte única via `stateFinalAposBastao`) + reconciliação pela verdade do **Bastão consultado POR NF** (`reconciliar-extravios-bastao.ts` + `fetchPendenciasByNfs`) sob **gate de frescor** (`fetchBastaoMaxUpdatedAt`) — provado que o Bastão retém a NF com a oc nova e só some ao finalizar (1/30/32 → RESOLVIDO). `sync-extravios-bastao` reescrito pra reconcile-only + cron 10min (mig 255, sem pull → sem dup). SSW só no conflito/agente. (1ª versão usou reconciliador SSW por órfão/staleness — substituída por Bastão-por-NF, mais barata e sem estampida de SSW.) REGRA INVIOLÁVEL: trocou a oc, o card some da aba.
- 2026-07-22 — INV-041 adicionado pós-bugs NF 556392 (FELIPE, tela branca ao aprovar) + NF 51712 (ISABELY, oc=11 sem aval de evidência). Raiz comum: botão ⭐ RECOMENDADA aprovava DIRETO com extras=null, pulando a janela de edição inteira (template, destinatários, aval skip_evidencia das ocs 10/11/35 → executor bloqueava sem saída). Fix: `decidirCliqueAprovacao` (função pura + 5 testes) roteia e-mail→modal / combo→modal-4459 / resto→direto; aval espelhado no `BannerInline54Composer`; `ErrorBoundary` global + `[cockpit-crash]` no console/localStorage (tela branca vira tela de erro com stack — gatilho residual será capturado na próxima ocorrência). De carona: rótulos "oc=54" hardcoded dos 3 ramos caso_oc49 e do composer agora espelham a oc destacada real (54/59). REGRA INVIOLÁVEL: ação com e-mail nunca aprova às cegas.
- 2026-07-23 — INV-042 adicionado pós-bug NF 73220 (LARISSA/LEONE — romaneio respondido MUDO 7 dias). Duas causas independentes provadas: (1) confirmador pré-59 (regressão de deploy 13-21/07, já corrigida) mandou card com oc 59 recém-lançada pra TRANSFERIDO (`state_novo` no evento); (2) buraco de design: resposta de cliente em card terminal era engolida — thread path ignorava, ramo de reabertura por NF suspenso em 12/05, e o fallback "sync reabre" morre no guard de identidade ADR 0011 quando a última oc é nossa (83 supressões em 7 dias). Fix: fonte única `decidirAcionamentoPorRespostaCliente` + reabertura nos 2 caminhos do vinculador + evento `CardReabertoPorRespostaCliente` + watchdog `checkRespostaClienteEngolida` + retroativo em `audits/`. REGRA INVIOLÁVEL: resposta real de cliente nunca é muda — card terminal reabre.
- 2026-07-23 (tarde) — INV-042 REFINADO pelo Caio no mesmo dia (premissa final): reabrir terminal ressuscitava tratativa TRATADA — regra vira (1) card ATIVO se move sempre; (2) terminal anexa sem mover, roteando pra card ativo da NF quando existir (lookup por NF também prefere ativo); (3) card novo entra na premissa 1. Retroativo re-escopado na mesma tarde: 232 reaberturas de terminais REVERTIDAS cirurgicamente (evento `RetroativoRevertidoPorEscopo` por card), 5 mantidas (origem AGUARDANDO_CLIENTE, incl. a 73220 → proposta oc 33). Lições permanentes: detecção por EVENTO (nunca por carimbo — executor zera), dedupe por NF antes de reabrir (uniq_cards_nf_active), 1 mensagem = 1 decisão.
- 2026-07-24 — INV-049 adicionado pós-incidente `divergInfo` (TODOS os operadores travados na abertura de card). Raiz dupla: (1) commit `a37100f` (F4 popup de divergência, 23/07) renderizou `DivergenciaMotivoDialog` dentro de `ValidacaoHumanaList` com estado que vive no `ProposedActions` → `ReferenceError` em toda renderização; (2) ZERO typecheck no caminho até produção — `tsc --noEmit` sem `-p` checa nada (tsconfig raiz solution-style `files:[]`, todos os "tsc OK" históricos eram vácuos) e `vite build` não checa tipos. Fix: dialog movido pro dono do estado + gate `typecheck` no script build (Vercel falha o deploy em erro de tipo — falha segura) + 3 tipos mentirosos do `types.ts` corrigidos contra o banco (CardState sem EXTRAVIO_MONITORADO/212 cards, caso_oc49 sem relancamento_indenizacao e recusa_parcial_precede_extravio, proposta_destacada sem 59). Saldo positivo: airbag do INV-041 transformou tela branca em stack legível — diagnóstico em minutos. REGRA INVIOLÁVEL: nada chega ao build de produção sem typecheck real.
- 2026-07-24 (tarde) — INV-050 adicionado pós-bugs NF 158084 (DUILIO) + NF 1094294 (LARISSA), primeira manhã real de 3 estreias (popup F4 funcional + piloto ligado 23/07 20:33 + rota abrir-input). Três causas independentes provadas: (a) `decidirCliqueAprovacao` sem rota pra oc33-solo/combo-33+44 → ⭐ aprovou às cegas com `anexos_ids=[]` e o executor reverteu (fail-closed segurou — nada errado no SSW); (b) ramo ⭐ com early-return incondicional → rota `abrir-input` setava `expandidoId` que ninguém renderizava (clique morto na 56 recomendada — era a contraprova pendente da NF 62566, que chegou e REPROVOU); (c) `detectarDivergencia` sem arbitragem de recência → popup falso contra banner velho (23 popups/22 cards, motivo do próprio operador: "Sugeriu 33 eu aprovei lançar 33 e apareceu o pop up - errado"). Fix: rotas+handlers novos, ⭐ cai no render normal quando input expandido, divergência só sem endosso de NENHUMA camada viva. REGRA INVIOLÁVEL: aprovar a ⭐ que a UI mostra nunca abre popup nem aprova às cegas. Expurgo (ordem do Caio, mesmo dia): 3 `divergencia_motivos` deletados pelo critério mecânico do detector novo (nunca por texto); 22 mantidos como aprendizado legítimo. O expurgo expôs o gap `meta.origem='vinculador_pos_resposta_cliente'` com interp nulo (2 dos 3 falso-positivos) → regra de endosso por origem adicionada + contra-caso do gêmeo sem-email do menu preservado como divergência real.
- 2026-07-25 — INV-051 adicionado pós-incidente da fila de melhorias F6 (24/07): a Isadora rejeitou SEM QUERER a proposta "Melhorar o leitor de respostas do cliente" (regra do comprovante legível, NFs 893551/1828915) 21s depois de responder a pergunta — e não conseguiu corrigir. Raiz (3 fragilidades somadas): (a) card rotulado "aguardando SUA aprovação" mostrado ao próprio autor da resposta segundos depois de responder; (b) Aprovar/Rejeitar 1-clique, adjacentes, sem confirmação; (c) sem undo em NENHUMA camada — a fila só mostra `status='aberto'` (o card some no clique) e `revisar_learning_log` (mig 197) só permite aberto→final. Consequência: as revisões da Isadora ficaram invisíveis pro Caio, que só viu as 2 propostas "Alinhar o TIME" restantes. Fix: Rejeitar em 2 passos + rótulo neutro + aviso anti-eco quando a proposta nasceu da resposta do gestor logado + trilha "propostas já revisadas" (quem decidiu o quê, quando) com botão Reabrir via RPC `reabrir_learning_log` (mig 312, gestor-only, restrita a `ajuste_sugerido` aprovado/rejeitado — terminais aplicado/revertido intocáveis) + retroativo reabrindo o ajuste 1683efd9. REGRA INVIOLÁVEL: decisão humana na fila F6 é sempre confirmada, visível e reversível.
- 2026-09-03 (tarde) — **INV-141 reforçado + INV-140 do Carlos renumerado para INV-144.** Ao auditar a TERCEIRA cópia do parser (a dívida registrada de manhã) para decidir se dava pra consolidar, descobriu-se que ela **não** é equivalente: `agente-sugere-ocs-padrao` limpa com `removerMarcadoresSswmobile` (que remove comentários/tags HTML via `sanitizarTextoSsw`, mais `Protocolo:`/`SEFAZ`), enquanto `seguir-parcial-auto` usava só o `limparInstrucao` fraco. Medido: `9 <!--x--><u>GPS</u>` → fraco devolve `null`, forte devolve `{qtd:9}`. Numa NF de 9 volumes o fraco lançaria 55 num extravio TOTAL — exatamente o modo de falha que o D2 existe pra impedir. A fraqueza é inofensiva em `analisarExtravio` (nulo→TOTAL, conservador) e perigosa aqui porque o D3 inverte o default. Fix: `lerQtdDaInstrucao()` aplica a limpeza forte **só dentro do módulo** — `limparInstrucao` NÃO foi tocado, porque serve `analisarExtravio` de todos os 651 clientes. Consolidar as três cópias segue **descartado**: trocar o forte pelo fraco (ou vice-versa) em `agente-sugere-ocs-padrao` mudaria classificação para todos. Também adicionados guards de deploy (`.claude/deploy-guards.json`) para os 3 arquivos da 55 automática, que não tinham nenhum.
- 2026-09-03 — INV-141/142/143 adicionados junto com o ADR 0025 (oc 55 automática pra clientes com autorização permanente de seguir parcial: 4 CNPJs, 1 do DUILIO e 3 do FELIPE). NÃO nasceram de bug em produção — nasceram de uma medição feita ANTES de codar. A regra do briefing ("se a mensagem não disser 'extravio total', é parcial") foi confrontada com 180 dias de instruções reais desses clientes e classificaria errado 4 de 23 cards de oc 06 (17%): a unidade escreve SÓ O NÚMERO de volumes faltantes, sem a palavra TOTAL, e quando esse número é igual ao total de volumes da NF o extravio é total. Âncora NF 29642 (instrução `9`, NF de 9 volumes) receberia uma 55 mandando a operação entregar carga que não existe mais. Daí o INV-141 (a inversão vive só dentro da whitelist; sinal de total = palavra OU qtd>=volumes). A investigação achou de quebra: (a) `OCS_NOTIFICOU_APOS_EXTRAVIO` sem a 55, que faria o card de volta (19/10/35) exibir banner falso "cliente não notificado" — INV-143, que fecha uma divergência pré-existente com `houve55AposExtravio`; (b) `extravio-enrichment` arrastando `bastao-rules`, que faz query em TOP-LEVEL AWAIT, impedindo teste puro — parser extraído pra `extravio-qtd-volumes.ts` (que desde o ADR 0012 nunca tivera teste, apesar de decidir total×parcial); (c) uma TERCEIRA cópia do mesmo parser em `agente-sugere-ocs-padrao` (dívida registrada). INV-142 trava o estado inicial: flag OFF, sombra ON, seed inativo, loader fail-closed — porque ocorrência no SSW não tem desfazer. REGRA INVIOLÁVEL: extravio total nunca vira 55, e cliente fora da whitelist nunca muda de comportamento.
- 2026-07-26 — INV-055 adicionado pós-incidente de custo (domingo sem operação: $39,34 vs $8/dia, 4x). Causa raiz ÚNICA em cadeia, provada no `anthropic_usage_log` + `card_events`: `maxTokens: 700` no interpretador era MENOR que a resposta legítima do próprio schema (3 `trecho_verbatim` de evidência + motivo + motivo_combo) → 289 respostas bateram exatamente em 700 = cortadas no meio → JSON inválido → `completeJson` repetia com o MESMO teto (retry condenado, cortava igual) → 268 `InterpretadorRespostaClienteFalhou` (0 em todos os dias anteriores) → o card não recebia `ia_sugestao_oc_resposta` → `cron-ia-resposta-pendentes` seleciona exatamente "respondeu mas sem sugestão" e o devolvia a cada 5 min, sem limite de tentativas → 899 chamadas Anthropic sobre 11 mensagens (82 por mensagem; NF 164346 sozinha: 326 chamadas, 137 falhas, das 07:03 às 17:11). Amplificador: a onda 3 de 25/07 passou o `scan-email-pre-card` a drenar a fila em loop de 45s (backlog de 94k), realimentando as mesmas mensagens. Fix em 4 camadas: (1) teto 1800 + limites de tamanho explícitos no prompt; (2) retry que DOBRA o teto quando `stop_reason=max_tokens` (remove a causa em vez de repeti-la); (3) `repararJsonTruncado` salva o maior prefixo válido — os campos de decisão vêm primeiro no schema — entrando com confiança ≤0,5 e pendência visível; (4) breaker `MAX_FALHAS_LLM` por (card, mensagem): esgotado, aplica sugestão DETERMINÍSTICA conservadora (mantém 54/59 do trilho, zero ação automática em SSW) pela MESMA estrutura do fluxo normal, então o card segue com banner, propostas e to-dos, marcado `leitura_degradada`. REGRA INVIOLÁVEL: card com resposta de cliente nunca fica sem interpretação e sem ações — e falha de leitura nunca vira loop infinito de custo. Regra do Caio (verbatim): "Não podemos deixar o card sem interpretar, sem ações, e sem nada. (…) Não adianta só jogar para o operador fazer."
- 2026-09-08 — **INV-147 e INV-148 adicionados junto com o ADR 0026** (correção 08.09, dois bugs da operadora LARISSA). Nenhum dos dois foi diagnosticado por leitura de código: os dois foram MEDIDOS. (a) O bloqueio do PDF no 33+44 não era falha de conversão — renderizei as páginas com PDFium e OLHEI: as páginas reprovadas a 1,37% e 1,23% estavam legíveis (documento de transporte com placa manuscrita; ficha de agendamento). O piso de 2% de tinta estava reprovando conversão boa, e uma página reprovada derrubava o PDF inteiro — a página 1, a 6,41%, ia pro lixo junto. De quebra descobriu-se que a telemetria `ConversaoPdfBloqueadaGuard` do front NUNCA gravou: o `actor_id` era a string `"front-conversao-pdf"` e a RLS `card_events_insert_operator` exige `actor_id = current_operador_id()`, então todo insert era recusado e engolido pelo `catch`. Os 2 únicos eventos do banco vinham do servidor. A ADR 0014 mandava contar bloqueios por 2–4 semanas pra decidir o conversor server-side, e o contador estava cego desde o começo — por isso o bug chegou por reclamação de operadora, não por métrica. (b) A NF 1037746 não entrou nas pendências porque a oc 13 está fora do escopo e o pagador não estava na exceção: o sistema seguiu a regra, a regra é que estava errada pro cliente. Ao preparar o fix apareceu a armadilha que virou o INV-148: a tabela da exceção era um interruptor só pra "aparecer" e pra "robô agir", então corrigir a visibilidade ligaria um agente que lança oc 21 e cancela reentrega sem autorização do cliente — o oposto da regra do negócio. REGRA INVIOLÁVEL: sinal fraco de qualidade (pouca tinta) pede olho humano, nunca reprova sozinho; e visibilidade nunca liga autonomia.
- 2026-09-09 — **INV-149 e INV-150 adicionados junto com o ADR 0027** (correção 09.09, dois casos da operadora KAROL). A hipótese do relato — "a existência de uma 33 anterior bloqueou a nova sugestão" — foi MEDIDA e **descartada**: a dedup usa `STATUS_ATIVOS = {pendente, aprovado}` e nunca consulta o histórico do SSW; `executando`/`cancelado` não ocupam o código (liberado de propósito desde a NF 2148226); o índice único de to-dos cobre só pendente/aprovado; e a idempotência do SSW é `(card_id, codigo_oc, ctrc, **todo_id**)`, então to-do novo não bate nela. Mais: **a 33 estava sendo sugerida nos dois cards** — aparece nas telas do relato e o banco confirma (350882 com 2 to-dos de 33 `pendente` desde 19/08; 431734 com 9 `pendente` desde 03/09). Eram dois bugs de causas independentes, e nenhuma era a do relato. (a) O 59 da NF 75249 nasceu correto pela regra da oc 19 e foi **cancelado 6 minutos depois** pelo menu pós-resposta, porque o portão só perdoava extravio TOTAL — num card parcial (template `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`) o sinal era falso e o 59 virava "obsoleto". (b) A 33 aparecia mas o executor a barrava por dossiê incompleto, com o motivo escondido atrás do modal. Erro de medição corrigido no caminho, que vale registrar: a primeira sonda buscou o template em `args.template_email` e devolveu 0 pra tudo — o campo real é `args.template_id`, o mesmo que o código consulta; o "0" era artefato da sonda, não evidência. REGRA INVIOLÁVEL: ocorrência que existe por pendência de documento sobrevive enquanto a pendência existir; e ação bloqueada sempre diz por quê na própria linha, sem obrigar o operador a abrir o modal pra descobrir.

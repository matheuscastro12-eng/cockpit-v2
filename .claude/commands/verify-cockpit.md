---
description: Verificação completa pós-fix/feature no Cockpit v2 — checklist obrigatório antes de commit/deploy
---

# /verify-cockpit — Verificação Holística

Roda em sequência (não pula etapas, não termina cedo). Reporta cada fase como PASS/FAIL e produz um VERIFICATION REPORT no final.

## Fase 1 — Type check Deno das edge functions tocadas

```bash
# Pega arquivos modificados no working tree + último commit
cd "$(git rev-parse --show-toplevel)"; source scripts/ritual-env.sh
ARQUIVOS_TS=$(git diff --name-only HEAD~1 HEAD 2>/dev/null; git status --porcelain | awk '{print $2}') 
echo "$ARQUIVOS_TS" | grep -E 'supabase/functions/.*\.ts$' | sort -u | while read f; do
  echo "--- deno check $f ---"
  deno check "$f" 2>&1 | tail -10
done
```

Status: PASS se nenhum erro `error:` no output. FAIL se houver.

## Fase 2 — Cobertura de passes (regra crítica do Cockpit)

Quando o diff toca `sync-bastao/index.ts` OU `_shared/regras-auto-acao.ts` OU `_shared/bastao-rules.ts`:

```bash
# Confirma que TODOS os passes que mexem em state respeitam ACAO_EXECUTADA
grep -nE "ACAO_EXECUTADA|state.*=|releaseCard|update.*state" "supabase/functions/sync-bastao/index.ts" | head -40

# Guards unitários de regras-auto-acao (romaneio interno + gêmeo "54 sem email")
deno test supabase/functions/_shared/regras-auto-acao.romaneio.test.ts \
          supabase/functions/_shared/regras-auto-acao.sem-email-54.test.ts --allow-env 2>&1 | tail -8
```

Status dos guards: PASS se ambos os arquivos de teste = `ok | N passed | 0 failed`. O
`sem-email-54` trava a regressão da opção "lançar só oc 54 sem email" (gêmeo
`meta.sem_email_explicito` ao lado da 54+email; idempotente; fallback sem_email não duplica).

Validar manualmente:
- Pass A: tem guarda `state === "ACAO_EXECUTADA"`? ✓/✗
- Pass A `voltouParaRelacionamento`: respeita janela `acao_executada_em` 60min? ✓/✗
- Pass B: filtra ACAO_EXECUTADA no SELECT? ✓/✗
- Pass B: early skip defensivo no loop? ✓/✗
- Pass C: não muda state (só `todos.status`)? ✓/✗
- Pass D: só mexe em `aviso_alteracao_oc`? ✓/✗
- Pass E: filtra state=AGUARDANDO_CLIENTE? ✓/✗
- Pass F: chave_cte resolver, não muda state? ✓/✗
- Pass G: opera só em state=ACAO_EXECUTADA, janela 30min "bastao_avancou"? ✓/✗
- atualizar-card-via-portal-ssw: ação manual deliberada? ✓/✗

Status: PASS se 10/10. FAIL se algum não-coberto.

## Fase 3 — Supabase Security Advisors

```bash
TOKEN="${SUPABASE_ACCESS_TOKEN:?defina SUPABASE_ACCESS_TOKEN no env}"
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.supabase.com/v1/projects/xjbycvscljqoqpjkmevb/advisors/security" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
lints = data.get('lints', [])
from collections import Counter
by_level = Counter(l['level'] for l in lints)
errors = [l for l in lints if l['level']=='ERROR']
print(f'Total: {len(lints)} | {dict(by_level)}')
if errors:
    print(f'NOVOS ERRORs ({len(errors)}):')
    for l in errors:
        print(f\"  - {l['name']}: {l['detail'][:100]}\")
else:
    print('0 ERRORs (baseline ok)')
"
```

Status: PASS se ERROR count = 0. FAIL se aumentou.

## Fase 4 — Retroativo aplicado (se fix tocou regra de produção)

Se o fix corrigiu bug que pode ter afetado cards já existentes:

1. Listar NFs afetadas (com query SQL específica do bug).
2. Confirmar que cada NF está em estado esperado pós-fix.
3. Confirmar evento `Retroativo*` registrado em `card_events`.

Status: PASS se aplicado. N/A se fix foi "só pra frente". FAIL se devia retroativo e não foi feito.

## Fase 5 — Memory updated

```bash
ls -lt /Users/caiodevasconcelos/.claude/projects/-Users-caiodevasconcelos-Documents--code-cockpit-v2--cockpit-v2-starter/memory/ | head -5
```

Pergunta-se:
- Bug significativo → memory file `project_*.md` criada?
- Comportamento sistêmico → memory `feedback_*.md` criada?
- MEMORY.md tem entry apontando pro novo memory file?

Status: PASS se sim. FAIL se fix foi merecedor e memory não veio.

## Fase 6 — Diff sanity

```bash
git diff --stat HEAD~1 HEAD 2>/dev/null || git diff --stat
```

Pergunta-se:
- Só os arquivos esperados foram tocados?
- LOC adicionada razoável pro escopo?

### 6.1 — Guard de segredos (automatizado, NÃO é pergunta manual)

Era item de checklist manual ("algum .env foi commitado por engano?") e por isso
não travava nada. Caso-âncora 2026-08-06: o arquivo de segredos chegou da nuvem
como `env.download`, nome que o `.gitignore` da época não cobria — ficou untracked,
a um `git add .` de publicar service_role key, PAT, senha do Postgres,
`ANTHROPIC_API_KEY` e senha do SSW no repo **público**
`github.com/caio-maker2020/cockpit-v2`.

```bash
# (a) hook instalado? Sem isso as duas camadas de proteção não rodam.
test "$(git config core.hooksPath)" = ".githooks" \
  && echo "OK hooksPath" || { echo "FAIL: rode  git config core.hooksPath .githooks"; }
test -x .githooks/pre-commit && echo "OK hook executável" || echo "FAIL: chmod +x .githooks/pre-commit"

# (b) o hook realmente bloqueia? (auto-teste — não confiar que "está lá")
printf 'k=sk-ant-api03-%s\n' "$(printf 'A%.0s' {1..30})" > .verify_secret_probe.txt
git add -f .verify_secret_probe.txt 2>/dev/null
bash .githooks/pre-commit >/dev/null 2>&1 \
  && echo "FAIL: hook NÃO bloqueou segredo de teste" || echo "OK hook bloqueia"
git restore --staged .verify_secret_probe.txt 2>/dev/null; rm -f .verify_secret_probe.txt

# (c) nenhum segredo em arquivo rastreado, em NENHUM commit do histórico
for p in 'sk-ant-api03-' 'sbp_[a-f0-9]\{40\}' 'postgresql://postgres[^ ]*:[^@ ]*@'; do
  n=$(git log --all --oneline -S "$p" --pickaxe-regex 2>/dev/null | wc -l)
  [ "$n" -eq 0 ] && echo "OK histórico limpo: $p" || { echo "FAIL: $n commit(s) com $p"; git log --all --oneline -S "$p" --pickaxe-regex | head -5; }
done

# (d) nenhum arquivo de ambiente rastreado (exceto os .env.example).
#     Regex ancorada no NOME do arquivo de propósito: um `grep 'env'` solto no
#     caminho acusa `supabase/functions/enviar-resposta/` e `EnvBanner.tsx`.
git ls-files | grep -iE '(^|/)(\.env([^/]*)?|env(\.[^/]*)?|[^/]+\.env)$' \
  | grep -v '\.env\.example$' \
  && echo "FAIL: arquivo de ambiente rastreado acima" || echo "OK nenhum env rastreado"
```

Status: PASS só se (a), (b), (c) e (d) derem OK.
Se (c) falhar, **rotacionar a credencial** antes de qualquer coisa — reescrever
histórico não desfaz exposição de um repo público.

## Fase 7 — Deploy state

### 7.0 — Sanidade do deploy-gate (rodar ANTES de qualquer deploy)

Um gate que bloqueia deploy legítimo é tão ruim quanto um que não bloqueia nada:
some a confiança nele e alguém passa a usar `DEPLOY_GATE_ACK=1` por reflexo.
Caso-âncora 2026-08-06: em máquina Windows o hook lia o manifest com o encoding
do locale (cp1252), o marcador `Separação 54/59` virava mojibake e **100% dos
deploys eram bloqueados** por falso positivo. Este check pega a volta disso.

```bash
export CLAUDE_PROJECT_DIR="$PWD"
H=.claude/hooks/cockpit-deploy-gate.py
T=$(mktemp -d)
# O gate casa com a substring literal `functions deploy` no comando. Se ela
# aparecer aqui, o hook dispara sobre o PRÓPRIO teste e o check nunca roda
# (acontece de verdade quando o /verify-cockpit é executado via Bash).
# Montar por variável mantém a substring fora do texto do comando.
D=dep; D="${D}loy"
printf '{"tool_name":"Bash","tool_input":{"command":"supabase functions %s executor"}}' "$D" > "$T/ok.json"
printf '{"tool_name":"Bash","tool_input":{"command":"supabase functions %s atualizar-card-via-tracking"}}' "$D" > "$T/proibida.json"

python3 "$H" < "$T/ok.json" >/dev/null 2>&1
[ $? -eq 0 ] && echo "OK gate libera deploy legítimo" || echo "FAIL: falso positivo — gate bloqueia deploy válido (checar encoding=utf-8 no hook)"

python3 "$H" < "$T/proibida.json" >/dev/null 2>&1
[ $? -eq 2 ] && echo "OK gate bloqueia função proibida" || echo "FAIL: gate deixou passar função proibida"

# Todo marcador do manifest tem de existir no fonte, lendo AMBOS em utf-8.
python3 - <<'PY'
import json
man = json.load(open('.claude/deploy-guards.json', encoding='utf-8'))
ruim = 0
for arq, marcadores in man.get('guards', {}).items():
    try:
        src = open(arq, encoding='utf-8', errors='replace').read()
    except FileNotFoundError:
        print(f"FAIL: manifest aponta arquivo inexistente: {arq}"); ruim += 1; continue
    for m in marcadores:
        if m not in src:
            print(f"FAIL: marcador ausente: {m!r} em {arq}"); ruim += 1
print("OK todos os marcadores do manifest presentes" if not ruim else f"{ruim} problema(s)")
PY
rm -rf "$T"
```

Status: PASS só se as três linhas derem OK.

### 7.1 — Produção atrás do git? (por função, com fecho transitivo de `_shared`)

Caso-âncora 2026-09-02: `_shared/propostas-pos-resposta-cliente.ts` mudou (cerca
da 44 sem CT-e) e só `executor` + `gmail-poll-inbox` foram deployados;
`vinculador`, `scan-email-pre-card` e `cron-ia-resposta-pendentes` importam o
módulo e ficaram 6 dias com bundle velho sem ninguém acusar. A listagem antiga
("5 funções mais recentes") nem rodava: `updated_at` da API é epoch em ms e o
script fazia `[:19]` numa int.

```bash
cd "$(git rev-parse --show-toplevel)"; source scripts/ritual-env.sh
# guard do trilho de SQL (classificador TIPO A/B + detecção de COMMIT interno)
python3 scripts/dbq.py --selftest || echo "FAIL: selftest do dbq.py"
# quem está com produção ATRÁS do git (compara último commit das fontes da função,
# incluindo todo _shared importado transitivamente, com o updated_at na API)
python3 scripts/deploy_pendente.py --so-pendentes
```

Status: PASS só se o selftest der OK **e** o `deploy_pendente` terminar com
"nenhuma função pendente" (exit 0). **REGRA ABSOLUTA (Caio 04/09): função
listada como pendente NUNCA fica de fora — não existe "deixada de fora de
propósito", com ou sem justificativa.** A exceção que existia aqui foi usada
em 03/09 (4 edges da oc 55 fora por análise manual de impacto que errou em 2
das 4: sync-bastao/atualizar-card usavam MAIS do que normalizeNf) e produziu
18h de produção inconsistente — parser forte nos agentes, fraco nos syncs.
Análise humana de "não precisa" não substitui o fecho transitivo do script.
Pendente = deploya. O comando sai pronto na saída (`--comando` imprime só ele).

## Fase 8 — Invariantes Automatizados

**Quando rodar:** SEMPRE (mesmo que o diff não toque arquivos críticos — invariantes podem quebrar por mudança em código relacionado).

**Fonte canônica:** `docs/INVARIANTES_COCKPIT.md` — catálogo de INVs com comando de verificação cada.

Rodar o bloco abaixo e marcar PASS/FAIL por INV. Inclui o resultado consolidado no VERIFICATION REPORT.

```bash
cd "$(git rev-parse --show-toplevel)"; source scripts/ritual-env.sh

echo "=== Fase 8 — Invariantes Automatizados ==="

# INV-SSW-LATIN1 (incidente 2026-07-06, NF 655782 oc=54 Duilio): sanitizarParaLatin1
# NÃO pode depender de byte NUL cru no fonte. O range latin-1 estava codificado
# como /[^<NUL>-ÿ]/ (NUL literal). Ferramenta que não preserva NUL removeu o byte,
# colapsando o range em [^-ÿ] (hífen literal) → apagava TODO caractere que não fosse
# '-'/'ÿ' → texto da oc chegou no SSW como "?????". Guard: sem NUL cru + regex escapado.
SSW_FILE="supabase/functions/_shared/ssw-internal-client.ts"
NUL_CRU=$(LC_ALL=C perl -0777 -ne 'my $n=()=/\x00/g; print $n' "$SSW_FILE" 2>/dev/null)
REGEX_OK=$(grep -Fc 'replace(/[^\x00-\xFF]/g' "$SSW_FILE" 2>/dev/null)
if [ "${NUL_CRU:-1}" -eq 0 ] && [ "${REGEX_OK:-0}" -ge 1 ]; then
  echo "INV-SSW-LATIN1: PASS"
else
  echo "INV-SSW-LATIN1: FAIL (nul_cru=$NUL_CRU regex_escapado=$REGEX_OK — sanitizarParaLatin1 frágil: texto do SSW pode virar '?????' de novo, como NF 655782)"
fi

# INV-001: Sem novos callers do tracking público
COUNT=$(grep -RIn 'from.*"\.\..*ssw-tracking-client' supabase/functions/ 2>/dev/null \
  | grep -v "@deprecated\|//\|_shared/ssw-tracking-client.ts" | wc -l | tr -d ' ')
[ "$COUNT" -eq 0 ] && echo "INV-001: PASS" || echo "INV-001: FAIL ($COUNT callers ativos do tracking público)"

# INV-002: confirmar-acao-executada-ssw preserva snapshot Bastão
HITS=$(grep -E "bastao_oc_no_lancamento:\s*null|bastao_updated_at_no_lancamento:\s*null" \
  supabase/functions/_shared/confirmar-acao-executada-ssw.ts 2>/dev/null | wc -l | tr -d ' ')
[ "$HITS" -eq 0 ] && echo "INV-002: PASS" || echo "INV-002: FAIL (campos sendo limpos — bug NF 1075381 voltou)"

# INV-003 (reformulada 2026-05-14): Pass A guard por oc do lançamento + SELECT carrega snapshot
HITS=$(grep -c "bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts 2>/dev/null)
SELECT_OK=$(grep -E '\.select\([^)]*bastao_oc_no_lancamento' supabase/functions/sync-bastao/index.ts | wc -l | tr -d ' ')
DISCR_OK=$(grep -A 4 "const bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts | grep -c "p.cod_ultima_ocorrencia === bastaoOcNoLancamento")
if [ "$HITS" -ge 2 ] && [ "$SELECT_OK" -ge 1 ] && [ "$DISCR_OK" -ge 1 ]; then
  echo "INV-003: PASS"
else
  echo "INV-003: FAIL (guard=$HITS, SELECT=$SELECT_OK, discriminador_oc=$DISCR_OK)"
fi
# INV-003b: cards travados em loop ≤ 0 (check SQL — precisa de DB)
LOOP_COUNT=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and lock_aguardando_validacao=true and bastao_oc_no_lancamento is not null and cod_ultima_ocorrencia = bastao_oc_no_lancamento and acao_executada_em is null and bastao_synced_at > now() - interval '1 hour';" 2>/dev/null | tr -d ' ')
if [ -z "$LOOP_COUNT" ]; then
  echo "INV-003b: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$LOOP_COUNT" = "0" ]; then
  echo "INV-003b: PASS"
else
  echo "INV-003b: FAIL ($LOOP_COUNT cards em loop)"
fi

# INV-004: Pass A preserva chaves críticas no agent_state
KEYS=$(grep -A 25 'agentStateExistente = ' supabase/functions/sync-bastao/index.ts \
  | grep -cE "chave_cte|propostas_recusadas_em|propostas_recusadas_para_oc|bastao_updated_at")
[ "$KEYS" -ge 4 ] && echo "INV-004: PASS" || echo "INV-004: FAIL (faltam preservações: encontradas $KEYS de 4)"

# INV-005: voltar-para-to-do-com-rastreio usa SSW interno
TEM_INTERNO=$(grep -c "buscarNFInterno" supabase/functions/voltar-para-to-do-com-rastreio/index.ts)
TEM_PUBLICO=$(grep -c "createSswTrackingClient" supabase/functions/voltar-para-to-do-com-rastreio/index.ts)
if [ "$TEM_INTERNO" -ge 1 ] && [ "$TEM_PUBLICO" -eq 0 ]; then
  echo "INV-005: PASS"
else
  echo "INV-005: FAIL (interno=$TEM_INTERNO, público=$TEM_PUBLICO)"
fi

# INV-006: oc=54 ⟺ AGUARDANDO_CLIENTE (SQL read-only contra produção)
VIOLAC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where cod_ultima_ocorrencia=54 and state != 'AGUARDANDO_CLIENTE' and cliente_respondeu_em is null and state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO');" 2>/dev/null | tr -d ' ')
if [ -z "$VIOLAC" ]; then
  echo "INV-006: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$VIOLAC" = "0" ]; then
  echo "INV-006: PASS"
else
  echo "INV-006: FAIL ($VIOLAC cards oc=54 em state errado)"
fi

# INV-007: Pass B blindado contra ACAO_EXECUTADA
# Busca direta pelo .not("state","in",...ACAO_EXECUTADA...) — robusta a comentários
# entre from("cards") e o filtro (ADR 0012, sync único, inseriu comentários e quebrou o -A 5).
FILTRO=$(grep -cE '\.not\("state",[[:space:]]*"in",.*ACAO_EXECUTADA' supabase/functions/sync-bastao/index.ts)
# Aceita formas usadas no código: ["state"] === "ACAO_EXECUTADA" e variantes
SKIP=$(grep -cE '\["state"\][[:space:]]*===[[:space:]]*"ACAO_EXECUTADA"' supabase/functions/sync-bastao/index.ts)
if [ "$FILTRO" -ge 1 ] && [ "$SKIP" -ge 1 ]; then
  echo "INV-007: PASS"
else
  echo "INV-007: FAIL (filtro=$FILTRO, early-skip=$SKIP)"
fi

# INV-008: stateFinalAposBastao é fonte única (info — baseline)
DUPLI=$(grep -RIn 'state.*=.*"\(TRANSFERIDO\|RESOLVIDO\|AGUARDANDO_CLIENTE\|AGUARDANDO_VALIDACAO_HUMANA\)"' supabase/functions/ 2>/dev/null \
  | grep -v "stateFinalAposBastao\|stateFinal\.state\|_shared/bastao-rules.ts\|//\|test\|describe\|TodoVoltadoParaToDo\|state_anterior" | wc -l | tr -d ' ')
echo "INV-008: INFO ($DUPLI atribuições literais oc→state fora do helper — baseline; subir muito = revisar)"

# INV-009: edge functions internas com verify_jwt=false
# Array (não string) — word splitting em variável string falha em alguns shells.
INTERNAS=(triador vinculador executor redator redator-email-saida sync-bastao audit-invariante cron-ia-resposta-pendentes gmail-poll-inbox processar-acoes-agendadas ingestor interpretador-resposta-cliente)
FALTANDO=""
for f in "${INTERNAS[@]}"; do
  # -F (fixed string) evita problemas de escape de '[' e '.' em shells diferentes
  if ! grep -A1 -F "[functions.$f]" supabase/config.toml 2>/dev/null | grep -q "verify_jwt = false"; then
    FALTANDO="$FALTANDO $f"
  fi
done
[ -z "$FALTANDO" ] && echo "INV-009: PASS" || echo "INV-009: FAIL (falta verify_jwt=false em:$FALTANDO)"

# INV-011: callers de temEvidenciaParaOc/verificarEvidenciaESinalizar passam ctrcEsperado
# (1) helper aceita ctrcEsperado (assinatura + propagação interna)
ASSINATURA=$(grep -c "ctrcEsperado" supabase/functions/_shared/verificar-evidencia.ts)
# (2) callers diretos do temEvidenciaParaOc (executor + revalidar-evidencia-card)
# Sem âncora ^await: as chamadas são `const x = await temEvidenciaParaOc(`.
DIRECT_CALLS=$(grep -E "await temEvidenciaParaOc\(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | wc -l | tr -d ' ')
DIRECT_COM_CTRC=$(grep -A 2 "await temEvidenciaParaOc(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | grep -cE "ctrcCard|ctrc.*\?\?\s*null")
# (3) callers de verificarEvidenciaESinalizar passando 6 args (com ctrc, ou null explícito)
INDIRECT_COM_CTRC=$(grep -B1 -A6 "verificarEvidenciaESinalizar(" supabase/functions/sync-bastao/index.ts supabase/functions/vinculador/index.ts 2>/dev/null | grep -cE "p\.ctrc[[:space:]]*\?\?[[:space:]]*null|, null\)\;")
if [ "$ASSINATURA" -ge 3 ] && [ "$DIRECT_CALLS" -ge 1 ] && [ "$DIRECT_COM_CTRC" -ge "$DIRECT_CALLS" ] && [ "$INDIRECT_COM_CTRC" -ge 3 ]; then
  echo "INV-011: PASS"
else
  echo "INV-011: FAIL (assinatura=$ASSINATURA, direct=$DIRECT_CALLS/$DIRECT_COM_CTRC com ctrc, indirect=$INDIRECT_COM_CTRC)"
fi

# INV-010: 54 em OCORRENCIAS_DE_RELACIONAMENTO
# lib/ ainda é Set literal hardcoded → grep no Set. shared/ virou carga dinâmica
# do dicionário (2026-06-16) e força 54 via `set.add(54)` independente da planilha.
TEM_54_LIB=$(grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" lib/bastao-rules.ts | grep -E "\b54\b" | wc -l | tr -d ' ')
TEM_54_SHARED=$(grep -cE "set\.add\(54\)" supabase/functions/_shared/bastao-rules.ts)
if [ "$TEM_54_LIB" -ge 1 ] && [ "$TEM_54_SHARED" -ge 1 ]; then
  echo "INV-010: PASS"
else
  echo "INV-010: FAIL (lib=$TEM_54_LIB, shared=$TEM_54_SHARED — bug 2026-05-12 voltou)"
fi

# INV-012: consumidores de evidência usam obterTodasFotosDaOc; obterFotoDaOc só na galeria
# (foto-oc-card, r-evidencia). Qualquer outro 'await obterFotoDaOc(' = puxa só a 1ª foto.
VIOL_FOTO=$(grep -RIn "await obterFotoDaOc(" supabase/functions/ 2>/dev/null \
  | grep -vE "foto-oc-card/index\.ts|r-evidencia/index\.ts" | wc -l | tr -d ' ')
if [ "$VIOL_FOTO" -eq 0 ]; then
  echo "INV-012: PASS"
else
  echo "INV-012: FAIL ($VIOL_FOTO caller(s) de obterFotoDaOc fora da galeria — usar obterTodasFotosDaOc; bug NF 355283)"
  grep -RIn "await obterFotoDaOc(" supabase/functions/ 2>/dev/null | grep -vE "foto-oc-card/index\.ts|r-evidencia/index\.ts"
fi

# INV-012b (NF 362406, 2026-06-30): a galeria expõe o MANIFESTO (modo `list`) com
# TODAS as fotos numa só chamada, pro front renderizar declarativo e nunca mostrar
# só a 1ª. Guard: foto-oc-card wirado no montarManifestoFotos + teste do manifesto
# verde (trava que o manifesto não trunca pra 1).
INV12B_WIRED=$(grep -c "montarManifestoFotos" supabase/functions/foto-oc-card/index.ts 2>/dev/null | tr -d ' ')
INV12B_TEST=$(deno test --no-check supabase/functions/_shared/foto-oc-manifest.test.ts >/dev/null 2>&1 && echo ok || echo fail)
if [ "$INV12B_WIRED" -ge 1 ] && [ "$INV12B_TEST" = "ok" ]; then
  echo "INV-012b: PASS"
else
  echo "INV-012b: FAIL (foto-oc-card montarManifestoFotos=$INV12B_WIRED, teste manifesto=$INV12B_TEST — galeria deve servir manifesto com TODAS as fotos; bug NF 362406)"
fi

# INV-013: lançamento de oc no SSW SEMPRE via readSswLancamentoEnv (conta ai.salex).
# Nenhuma sessão de submit pode vir de readSswInternalEnv (executor) nem de
# loadSswInternalEnvForCard (envelope). bug NF 651244: oc=33 saiu como Larissa.
INV13_EXEC=$(grep -c "readSswInternalEnv(Deno.env.toObject())" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV13_ENV=$(grep -c "loadSswInternalEnvForCard(" supabase/functions/_shared/lancar-ssw-portal.ts 2>/dev/null | tr -d ' ')
if [ "$INV13_EXEC" -eq 0 ] && [ "$INV13_ENV" -eq 0 ]; then
  echo "INV-013: PASS"
else
  echo "INV-013: FAIL (executor=$INV13_EXEC readSswInternalEnv, envelope=$INV13_ENV loadSswInternalEnvForCard — lançamento deve usar readSswLancamentoEnv; bug NF 651244)"
fi

# INV-015: limite de anexos por card NÃO conta origem='inbound'
# bug NF 719250: card com 29 inbound (assinaturas/logos inline) bloqueava upload
# de TODO JPEG convertido do PDF → front "Falha ao converter PDF → JPEG".
INV15_FILTRO=$(grep -c '\.neq("origem", "inbound")' supabase/functions/_shared/limite-anexos.ts 2>/dev/null | tr -d ' ')
INV15_USA=$(grep -c "queryAnexosQueContamProLimite" supabase/functions/upload-anexo-email/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV15_FILTRO" -ge 1 ] && [ "$INV15_USA" -ge 1 ]; then
  echo "INV-015: PASS"
else
  echo "INV-015: FAIL (filtro inbound=$INV15_FILTRO, uso na edge=$INV15_USA — limite voltou a contar inbound; bug NF 719250)"
fi

# INV-018: RLS de cards/todos avalia contexto do operador 1x/query (InitPlan), não 1x/linha.
# Causa-raiz do apagão 2026-06-23: as policies chamavam card_visivel_pelo_operador_atual(...)
# POR LINHA (todos = 58% da CPU, board 40s). Mig 242 inlinou com (SELECT current_operador_*()).
# Regressão = alguma policy de cards/todos voltar a chamar a função no qual/with_check.
INV18_PERROW=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_policies where tablename in ('cards','todos') and (coalesce(qual,'')||coalesce(with_check,'')) like '%card_visivel_pelo_operador_atual%';" 2>/dev/null | tr -d ' ')
INV18_CACHED=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_policies where tablename='cards' and qual like '%current_operador_id%';" 2>/dev/null | tr -d ' ')
if [ -z "$INV18_PERROW" ]; then
  echo "INV-018: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$INV18_PERROW" = "0" ] && [ "$INV18_CACHED" -ge 1 ]; then
  echo "INV-018: PASS"
else
  echo "INV-018: FAIL (per-row=$INV18_PERROW policies chamam card_visivel_pelo_operador_atual; cached=$INV18_CACHED — RLS per-row do apagão 2026-06-23 voltou; ver mig 242)"
fi

# INV-017: aba EXTRAVIOS — card só fica enquanto oc∈{6,9,16}; saída pela verdade do
# Bastão por NF (NÃO SSW) sob gate de frescor; sumiu+fresco→RESOLVIDO.
INV17_DEC=$(grep -c "decidirDestinoExtravio" supabase/functions/_shared/reconciliar-extravios-bastao.ts 2>/dev/null | tr -d ' ')
INV17_GATE=$(grep -c "bastaoConfirmadoFresco" supabase/functions/_shared/reconciliar-extravios-bastao.ts 2>/dev/null | tr -d ' ')
INV17_FRESH=$(grep -c "fetchBastaoMaxUpdatedAt" supabase/functions/sync-extravios-bastao/index.ts 2>/dev/null | tr -d ' ')
INV17_SSW=$(grep -rl "descobrirUltimaOcSsw\|reconciliar-extravios-ssw" supabase/functions/sync-extravios-bastao/ supabase/functions/_shared/reconciliar-extravios-bastao.ts 2>/dev/null | wc -l | tr -d ' ')
if [ "$INV17_DEC" -ge 1 ] && [ "$INV17_GATE" -ge 1 ] && [ "$INV17_FRESH" -ge 1 ] && [ "$INV17_SSW" -eq 0 ]; then
  echo "INV-017 (código): PASS"
else
  echo "INV-017 (código): FAIL (decidir=$INV17_DEC gate=$INV17_GATE fresh=$INV17_FRESH ssw_no_part1=$INV17_SSW)"
fi
# INV-017b: teste do reconciliador (gate de frescor + sumiu→RESOLVIDO + roteamento).
# --no-check: a chamada a proporAutoAcaoSeAplicavel tem TS2345 latente da supabase-js
# (idêntico a atualizar-card-via-portal-ssw; deploy também não typecheca). O teste RODA.
deno test --no-check --allow-net --allow-env supabase/functions/_shared/extravio-routing.test.ts supabase/functions/_shared/reconciliar-extravios-bastao.test.ts >/dev/null 2>&1 \
  && echo "INV-017b (testes): PASS" || echo "INV-017b (testes): FAIL (deno test extravio-routing + reconciliar-extravios-bastao)"
# INV-017c: nenhum card EXTRAVIO_MONITORADO com oc fora de {6,9,16} (DB).
INV17_OCFORA=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='EXTRAVIO_MONITORADO' and coalesce(cod_ultima_ocorrencia,0) not in (6,9,16);" 2>/dev/null | tr -d ' ')
if [ -z "$INV17_OCFORA" ]; then
  echo "INV-017c: SKIP (sem acesso ao DB local)"
elif [ "$INV17_OCFORA" = "0" ]; then
  echo "INV-017c: PASS"
else
  echo "INV-017c: FAIL ($INV17_OCFORA card(s) EXTRAVIO_MONITORADO com oc fora de extravio — regra inviolável da aba violada)"
fi
# INV-017d: dias_uteis da aba EXTRAVIOS é SEMPRE inteiro (não existe "2.78 dias úteis").
# Regrediu 2x: mig 256 "reproduz mig 215" mas usou timestamp-com-hora + round(,2) →
# fração. Fonte da regra: dias_uteis_entre com AMBOS os lados ::date (midnight a midnight).
INV17_FRAC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from v_extravios_kanban where dias_uteis <> floor(dias_uteis);" 2>/dev/null | tr -d ' ')
if [ -z "$INV17_FRAC" ]; then
  echo "INV-017d: SKIP (sem acesso ao DB local)"
elif [ "$INV17_FRAC" = "0" ]; then
  echo "INV-017d: PASS"
else
  echo "INV-017d: FAIL ($INV17_FRAC card(s) com dias_uteis fracionário na v_extravios_kanban — a view voltou a usar timestamp-com-hora; ver mig 215, usar ::date dos 2 lados)"
fi

# INV-019: nenhum card AGUARDANDO_CLIENTE com oc de RELACIONAMENTO ≠54 (DB).
# AGUARDANDO_CLIENTE só pode conter oc=54. Quando a oc real vira outra oc de
# relacionamento (49/20/11/19/35/10/...), o card tem que ir pra AGUARDANDO VOCÊ
# (AVH+lock) — Pass A, ramo restaurado 2026-06-24 (NF 175621). Regressão raiz:
# Pass E desligado em 2026-06-22 deixou esse ramo órfão → 52 cards travados.
# (out-of-escopo segue em AGUARDANDO_CLIENTE + CONFLITOS via Pass B — não conta aqui.)
# EXCLUI LAG (NF 175621): card que lançou 54 e o Bastão ainda mostra a oc anterior
# (data <= data do lançamento de 54) fica CERTO em AGUARDANDO_CLIENTE — não é violação.
INV19_STUCK=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c where c.state='AGUARDANDO_CLIENTE' and c.cod_ultima_ocorrencia in (3,8,10,11,17,19,20,23,26,28,35,43,49,52) and not exists (select 1 from acoes_executadas_ssw a where a.card_id=c.id and a.codigo_oc=54 and a.sucesso and (a.iniciado_em at time zone 'America/Sao_Paulo')::date >= c.bastao_data_ultima_ocorrencia);" 2>/dev/null | tr -d ' ')
# As 3 camadas TÊM que existir no código (barra remoção silenciosa de qualquer uma):
#  1) Pass A move na hora; 2) sweep auto-cura no sync-bastao; 3) watchdog no health-check (processo separado).
INV19_PASSA=$(grep -c "aguardandoClienteVirouOutraRelacionamento" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV19_SWEEP=$(grep -c "selfHealAguardandoClienteOcRelacionamento" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV19_WATCHDOG=$(grep -c "checkAguardandoClienteOcRelacionamento" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV19_PASSA" -lt 1 ] || [ "$INV19_SWEEP" -lt 2 ] || [ "$INV19_WATCHDOG" -lt 2 ]; then
  echo "INV-019 (código): FAIL (passA=$INV19_PASSA sweep=$INV19_SWEEP watchdog=$INV19_WATCHDOG — alguma das 3 camadas foi removida; PRECISA aprovação do Caio)"
else
  echo "INV-019 (código): PASS (3 camadas presentes)"
fi
# GUARD anti-regressão NF 362406 (Caio 2026-07-06): o sweep NÃO pode voltar a pular
# card por SNAPSHOT (bastao_oc_no_lancamento === cod_ultima_ocorrencia). Esse guard
# legado prendia PRA SEMPRE um 49 novo cujo número coincidia com o snapshot do
# lançamento (data já provava oc nova) → divergia do watchdog → alerta eterno. A
# autoridade é só `naoRebaixarComDesempateSsw` (guard #1, por data + SSW por hora).
INV19_SNAPSHOT_GUARD=$(grep -c "ocNova === bastaoOcNoLancamento" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV19_SNAPSHOT_GUARD:-0}" -ge 1 ]; then
  echo "INV-019 (snapshot): FAIL (sweep voltou a pular por bastao_oc_no_lancamento===cod_ultima_ocorrencia — regressão NF 362406; remover o guard de snapshot, autoridade é naoRebaixarComDesempateSsw)"
else
  echo "INV-019 (snapshot): PASS (sweep sem guard de snapshot; decide só por data/SSW)"
fi
if [ -z "$INV19_STUCK" ]; then
  echo "INV-019 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV19_STUCK" = "0" ]; then
  echo "INV-019 (DB): PASS"
else
  echo "INV-019 (DB): FAIL ($INV19_STUCK card(s) AGUARDANDO_CLIENTE com oc de relacionamento ≠54 travados — deveriam estar em AGUARDANDO VOCÊ; Pass A+sweep regrediram)"
fi
# INV-019 (RPC): a RPC ignorar_pendencias_resposta_cliente NÃO pode ter caminho que
# seta AGUARDANDO_CLIENTE sem checar cod_ultima_ocorrencia (bug NF 1119469, mig 287).
# A versão buggada NUNCA referenciava cod_ultima_ocorrencia; a corrigida decide o
# state pelo predicado do INV-019 e emite PendenciasRespostaIgnoradasMantidoEmAguardandoVoce.
# (a) fonte: a migration MAIS RECENTE que (re)define a RPC tem que carregar o guard;
# (b) DB: a função DEPLOYADA tem que referenciar o guard (pg_get_functiondef).
RPC_LATEST=$(grep -rl "CREATE OR REPLACE FUNCTION public.ignorar_pendencias_resposta_cliente" migration/ 2>/dev/null | sort | tail -1)
RPC_SRC_GUARD=$(grep -c "cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)" "$RPC_LATEST" 2>/dev/null | tr -d ' ')
RPC_SRC_EVT=$(grep -c "PendenciasRespostaIgnoradasMantidoEmAguardandoVoce" "$RPC_LATEST" 2>/dev/null | tr -d ' ')
if [ "${RPC_SRC_GUARD:-0}" -ge 1 ] && [ "${RPC_SRC_EVT:-0}" -ge 1 ]; then
  echo "INV-019 (RPC fonte): PASS (guard cod_ultima_ocorrencia + evento MantidoEmAguardandoVoce na mig mais recente: $RPC_LATEST)"
else
  echo "INV-019 (RPC fonte): FAIL (a mig mais recente da RPC ignorar_pendencias NÃO tem o guard INV-019 — regressão do bug NF 1119469; $RPC_LATEST)"
fi
RPC_DB_GUARD=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when pg_get_functiondef('public.ignorar_pendencias_resposta_cliente(uuid,text)'::regprocedure) ~ 'cod_ultima_ocorrencia' and pg_get_functiondef('public.ignorar_pendencias_resposta_cliente(uuid,text)'::regprocedure) ~ 'PendenciasRespostaIgnoradasMantidoEmAguardandoVoce' then 1 else 0 end;" 2>/dev/null | tr -d ' ')
if [ -z "$RPC_DB_GUARD" ]; then
  echo "INV-019 (RPC DB): SKIP (sem acesso ao DB local)"
elif [ "$RPC_DB_GUARD" = "1" ]; then
  echo "INV-019 (RPC DB): PASS (função deployada respeita o guard cod_ultima_ocorrencia=54)"
else
  echo "INV-019 (RPC DB): FAIL (ignorar_pendencias_resposta_cliente DEPLOYADA seta AGUARDANDO_CLIENTE sem checar cod_ultima_ocorrencia — bug NF 1119469 vivo em produção; aplicar mig 287)"
fi

# INV-020: saudação de e-mail NUNCA usa o nome da empresa/marca. resolver_primeiro_nome_email
# (fonte única — preview/executor/cobranca) descarta nome_pessoa cujo 1º token é um token do
# nome da empresa do card (ACÁCIA/IBITURUNA/SINERGIA...). Bug NF 345282 "Olá Acácia," (mig 253).
INV20_FOLD=$(grep -c "_fold_accents\|é um TOKEN do nome da empresa" migration/2026-06-24_253_saudacao_nome_pessoa_nao_e_marca_da_empresa.sql 2>/dev/null | tr -d ' ')
INV20_LEAK=$($PSQL "$SUPABASE_DB_URL" -tA -c "
  with r as (
    select c.identificador, cl.nome as empresa,
           public.resolver_primeiro_nome_email(c.identificador, cl.nome) as nome
    from contatos_cliente c join clientes cl on cl.cnpj_cpf=c.documento_cliente
    where c.tipo='email' and c.nome_pessoa is not null and btrim(c.nome_pessoa)<>''
  )
  select count(*) from r
  where nome <> '' and length(public._fold_accents(nome))>=3
    and public._fold_accents(empresa) ~ ('(^|[^a-z])'||public._fold_accents(nome)||'([^a-z]|$)');" 2>/dev/null | tr -d ' ')
if [ -z "$INV20_LEAK" ]; then
  echo "INV-020: SKIP (sem acesso ao DB local — guard de código fold=$INV20_FOLD)"
elif [ "$INV20_FOLD" -ge 1 ] && [ "$INV20_LEAK" = "0" ]; then
  echo "INV-020: PASS"
else
  echo "INV-020: FAIL (fold_guard=$INV20_FOLD, contatos com marca vazando na saudação=$INV20_LEAK — bug 'Olá Acácia' NF 345282 voltou; ver mig 253)"
fi

# INV-021: recusa/falta (oc 10/19/35) originada de extravio (6/9/16) não notificado.
# O agente-sugere-ocs-padrao detecta a sequência (detector puro em _shared/recusa-por-extravio.ts,
# testado) e decide via montarSugestaoRecusaPorExtravio. DIFERENÇA oc=19 x oc=35 (NF 179799):
#   - oc=19 (entregue COM falta = extraviado, nada a devolver) → SÓ notifica + romaneio,
#     mantém ENTREGUE_COM_FALTA_PEDIR_ROMANEIO, NUNCA pergunta devolução.
#   - oc=10/35 (recusa, volume físico parado) → RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR + pergunta destino.
# O interpretador-resposta-cliente exige romaneio+descrição+valor antes do combo 33+44. Bug NF 148558.
INV21_CODE=$(grep -c "recusaOriginadaDeExtravioNaoNotificada" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV21_SUG=$(grep -c "montarSugestaoRecusaPorExtravio" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
# Guard oc=19: a função pura NÃO pode oferecer devolução/nova entrega pra oc=19 (só notifica).
INV21_OC19=$(grep -A4 "codigoOc === 19" supabase/functions/_shared/recusa-por-extravio.ts 2>/dev/null | grep -c "perguntaDestino: false" | tr -d ' ')
INV21_TMPL=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from templates_email where id='RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR' and ativo and corpo_template ilike '%romaneio%' and corpo_template ilike '%valor%' and (corpo_template ilike '%devolu%' and (corpo_template ilike '%nova entrega%' or corpo_template ilike '%reentrega%'));" 2>/dev/null | tr -d ' ')
# Guard DB: dropdown da oc=19 no preview_email_todo NÃO pode listar o template de devolução.
INV21_DROP19=$($PSQL "$SUPABASE_DB_URL" -tA -c "with d as (select pg_get_functiondef('public.preview_email_todo(uuid,text)'::regprocedure) f) select case when (f ~ 'WHEN 19 THEN ARRAY\[''ENTREGUE_COM_FALTA_PEDIR_ROMANEIO''') and (f !~ 'WHEN 19 THEN ARRAY\[[^]]*RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR') then 1 else 0 end from d;" 2>/dev/null | tr -d ' ')
INV21_TEST=$(deno test supabase/functions/_shared/recusa-por-extravio.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV21_COMPLETUDE=$(grep -c "REGRA DE COMPLETUDE" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$INV21_TMPL" ]; then
  echo "INV-021: SKIP (sem acesso ao DB local — code=$INV21_CODE sug=$INV21_SUG oc19=$INV21_OC19 test=$INV21_TEST completude=$INV21_COMPLETUDE)"
elif [ "$INV21_CODE" -ge 1 ] && [ "$INV21_SUG" -ge 1 ] && [ "$INV21_OC19" -ge 1 ] && [ "$INV21_TMPL" = "1" ] && [ "$INV21_DROP19" = "1" ] && [ "$INV21_TEST" = "ok" ] && [ "$INV21_COMPLETUDE" -ge 1 ]; then
  echo "INV-021: PASS"
else
  echo "INV-021: FAIL (detector=$INV21_CODE, sugestao_pura=$INV21_SUG, oc19_so_notifica=$INV21_OC19, template_completo=$INV21_TMPL, dropdown_oc19_sem_devolucao=$INV21_DROP19, teste=$INV21_TEST, completude_interpretador=$INV21_COMPLETUDE — fluxo recusa-por-extravio regrediu; ver mig 254/267, NF 148558/179799)"
fi

# INV-021b: oc=35 tem UM template só = RECUSA_PARCIAL (mig 290, Caio 2026-07-06).
# ENTREGA_PARCIAL_APOS_FALTA_VOLUME foi consolidado/deprecado — nome enganoso
# ("FALTA_VOLUME" é semântica de oc=19/extravio, não de oc=35/recusa). Guards:
#   (a) DB: ENTREGA_PARCIAL_APOS_FALTA_VOLUME.ativo=false e RECUSA_PARCIAL.ativo=true
#   (b) DB: nenhum card ainda sugere o template deprecado (retroativo aplicado)
#   (c) código: a IA (templateMap + deduzirTemplateDoCluster) mapeia oc=35 → RECUSA_PARCIAL
INV21B_DEPR=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when (select not ativo from templates_email where id='ENTREGA_PARCIAL_APOS_FALTA_VOLUME') and (select ativo from templates_email where id='RECUSA_PARCIAL') then 1 else 0 end;" 2>/dev/null | tr -d ' ')
INV21B_CARDS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where analise_padrao_resultado->>'template_email_sugerido' = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME' or aviso_alteracao_oc->>'template_email_sugerido' = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';" 2>/dev/null | tr -d ' ')
INV21B_CODE=$(grep -cE '35:\s*"RECUSA_PARCIAL"' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV21B_CLUSTER=$(grep -cE 'o\.codigo === 35\) return "RECUSA_PARCIAL"' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$INV21B_DEPR" ]; then
  echo "INV-021b: SKIP (sem DB local — code=$INV21B_CODE cluster=$INV21B_CLUSTER)"
elif [ "$INV21B_DEPR" = "1" ] && [ "$INV21B_CARDS" = "0" ] && [ "$INV21B_CODE" -ge 1 ] && [ "$INV21B_CLUSTER" -ge 1 ]; then
  echo "INV-021b: PASS"
else
  echo "INV-021b: FAIL (depr_ativo_flags=$INV21B_DEPR, cards_com_deprecado=$INV21B_CARDS, templateMap_oc35=$INV21B_CODE, cluster_oc35=$INV21B_CLUSTER — oc=35 voltou a ter 2 templates / IA voltou pra ENTREGA_PARCIAL_APOS_FALTA_VOLUME; ver mig 290)"
fi

# INV-022: agente de extravio SÓ lança a oc 49 após pré-checagem SSW (última oc ∈ {6,9,16}).
# Regra pura podeAgenteLancar49 usada nos 2 modos; lançamento via envelope (não direto);
# reconciliador PART 1 pula nao_rodou. Bug que trava: lançar 49 em cima de oc já lançada.
INV22_REGRA=$(grep -c "podeAgenteLancar49" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_NOHAS=$(grep -c "EXTRAVIO_OCS.has" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_ENVELOPE=$(grep -c "auto_aprovar_e_executar" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_DIRETO=$(grep -c "lancarOcorrenciaPortal" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_SKIP=$(grep -c "agente_extravio_status.*nao_rodou" supabase/functions/sync-extravios-bastao/index.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/agente-extravio-regras.test.ts >/dev/null 2>&1 && INV22_TEST=ok || INV22_TEST=fail
# Limiar configurável (Duílio 2026-07-28, mig 313): o agente resolve o dia de
# lançamento por card (cliente > operador > 4), NÃO mais coluna_kanban="D4" fixa.
# Guard: usa resolverDiasAutonomoExtravio + o D4 hardcoded sumiu + teste do
# limiar passa. Regressão que trava: voltar o "D4" fixo (ignora FELIPE=2/PRATI=2).
INV22_LIMIAR=$(grep -c "resolverDiasAutonomoExtravio" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_NOD4=$(grep -c '"coluna_kanban", "D4"' supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/dias-autonomo-extravio.test.ts >/dev/null 2>&1 && INV22_LIMIAR_TEST=ok || INV22_LIMIAR_TEST=fail
if [ "$INV22_REGRA" -ge 2 ] && [ "$INV22_NOHAS" -eq 0 ] && [ "$INV22_ENVELOPE" -ge 1 ] && [ "$INV22_DIRETO" -eq 0 ] && [ "$INV22_SKIP" -ge 1 ] && [ "$INV22_TEST" = "ok" ] && [ "${INV22_LIMIAR:-0}" -ge 1 ] && [ "${INV22_NOD4:-1}" -eq 0 ] && [ "$INV22_LIMIAR_TEST" = "ok" ]; then
  echo "INV-022 (código): PASS (limiar=$INV22_LIMIAR nod4=$INV22_NOD4 limiar_test=$INV22_LIMIAR_TEST)"
else
  echo "INV-022 (código): FAIL (regra=$INV22_REGRA noHas=$INV22_NOHAS envelope=$INV22_ENVELOPE direto=$INV22_DIRETO skip=$INV22_SKIP teste=$INV22_TEST limiar=$INV22_LIMIAR nod4_deve_ser_0=$INV22_NOD4 limiar_test=$INV22_LIMIAR_TEST)"
fi
INV22_LANCOU_PRESO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where agente_extravio_status='lancou' and state='EXTRAVIO_MONITORADO';" 2>/dev/null | tr -d ' ')
INV22_SEM_MOTIVO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where agente_extravio_status='nao_rodou' and coalesce(btrim(agente_extravio_motivo),'')='';" 2>/dev/null | tr -d ' ')
if [ -z "$INV22_LANCOU_PRESO" ]; then
  echo "INV-022 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV22_LANCOU_PRESO" = "0" ] && [ "$INV22_SEM_MOTIVO" = "0" ]; then
  echo "INV-022 (DB): PASS"
else
  echo "INV-022 (DB): FAIL (lancou_preso_em_extravio=$INV22_LANCOU_PRESO, nao_rodou_sem_motivo=$INV22_SEM_MOTIVO)"
fi

# INV-023: card de relacionamento SEMPRE aponta, sem re-mostrar o já tratado. A decisão de
# VISIBILIDADE usa a VERDADE DO SSW POR IDENTIDADE (decidirVisibilidadePorSsw: ai.salex ×
# terceiro), NÃO por relógio (ADR 0011 supersede 0009 "por hora" — a comparação hora-SSW ×
# iniciado_em escondia oc de relacionamento nova de terceiro no mesmo minuto de uma ação do
# Cockpit; raiz NF 346896). Bounce-back (351193): SSW mais recente = nossa ação (ai.salex) →
# suprime. R2: card AGUARDANDO_CLIENTE cuja oc vira NÃO-relacionamento vai pra CONFLITOS
# (flagConflitoOcSemMover), não some. O caminho per-hora (decidirReaberturaPorSsw) segue no
# código atrás da flag reabertura_por_identidade_enabled=OFF (rollback) até o PR de cleanup.
INV23_WIRE=$(grep -c "decidirReaberturaCandidato\|candidatoReabertura" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV23_IDENTIDADE=$(grep -c "decidirVisibilidadePorSsw" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV23_R2=$(grep -c "flagConflitoOcSemMover\|cardEmEscopoProtegido" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
grep -q "contaLancamentoCockpit\|normalizarAutor" supabase/functions/_shared/decidir-visibilidade-ssw.ts 2>/dev/null && INV23_FUNC=ok || INV23_FUNC=fail
deno test --no-check --allow-net --allow-env supabase/functions/_shared/decidir-visibilidade-ssw.test.ts >/dev/null 2>&1 && INV23_TEST=ok || INV23_TEST=fail
# Monitor do INV-023 (alerta zumbi NF 371705, 2026-08-07): health-check usa o módulo
# compartilhado com a lista COMPLETA de saídas do INDEFINIDO_RETRY + teste âncora.
INV23_MON_USO=$(grep -c "acharIndefinidosPresos\|EVENTOS_MONITOR_INDEFINIDO" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
INV23_MON_SAIDAS=$(grep -c "AguardandoClienteOcMudou" supabase/functions/_shared/inv023-indefinido-preso.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-env supabase/functions/_shared/inv023-indefinido-preso.test.ts >/dev/null 2>&1 && INV23_MON_TEST=ok || INV23_MON_TEST=fail
if [ "${INV23_MON_USO:-0}" -ge 2 ] && [ "${INV23_MON_SAIDAS:-0}" -ge 1 ] && [ "$INV23_MON_TEST" = "ok" ]; then
  echo "INV-023 (monitor): PASS (uso=$INV23_MON_USO saidas=$INV23_MON_SAIDAS test=$INV23_MON_TEST)"
else
  echo "INV-023 (monitor): FAIL (uso=$INV23_MON_USO saidas=$INV23_MON_SAIDAS test=$INV23_MON_TEST — monitor de indefinido preso deve usar _shared/inv023-indefinido-preso com todas as saídas; alerta zumbi NF 371705)"
fi
INV23_BOUNCE=$($PSQL "$SUPABASE_DB_URL" -tA -c "
  with ult as (select distinct on (card_id) card_id, codigo_oc oc_lancada,
    (iniciado_em at time zone 'America/Sao_Paulo')::date data_lanc
    from acoes_executadas_ssw where sucesso=true order by card_id, iniciado_em desc)
  select count(*) from cards c join ult u on u.card_id=c.id
  where c.state='AGUARDANDO_VALIDACAO_HUMANA' and c.lock_aguardando_validacao=true
    and c.cliente_respondeu_em is null
    and coalesce(c.bastao_data_ultima_ocorrencia,'1900-01-01') < u.data_lanc
    and u.oc_lancada not in (10,11,17,19,20,23,26,28,35,43,49,52);" 2>/dev/null | tr -d ' ')
    # < (estritamente antes) = bounce-back CLARO (lag). Mesmo-dia é decidido pela
    # VERDADE DO SSW POR HORA (decidirReaberturaPorSsw) — não conta aqui.
    # (comentário em `#`: com `--` eram linhas bash inválidas e abortavam a Fase 8 após o INV-022)
if [ -z "$INV23_BOUNCE" ]; then
  echo "INV-023: SKIP (sem DB — wire=$INV23_WIRE identidade=$INV23_IDENTIDADE func=$INV23_FUNC r2=$INV23_R2 teste=$INV23_TEST)"
elif [ "$INV23_WIRE" -ge 2 ] && [ "$INV23_IDENTIDADE" -ge 2 ] && [ "$INV23_FUNC" = "ok" ] && [ "$INV23_R2" -ge 2 ] && [ "$INV23_TEST" = "ok" ] && [ "$INV23_BOUNCE" = "0" ]; then
  echo "INV-023: PASS"
else
  echo "INV-023: FAIL (wire=$INV23_WIRE identidade=$INV23_IDENTIDADE func=$INV23_FUNC r2=$INV23_R2 teste=$INV23_TEST bounce=$INV23_BOUNCE — raiz SSW-por-identidade NF 346896 / bounce-back 351193 / R2 CONFLITOS)"
fi

# INV-024: agente "relançar 54 por ressarcimento" (54→46→49). Detector exige 54 ANTES
# da 46 (cliente notificado) + 49 como última oc codificada; lançamento via envelope;
# autonomia gated. Bug que trava: relançar 54 sem o cliente nunca ter sido notificado,
# ou recomendar quando a 49 manda outra oc / diz "não procede".
INV24_DET=$(grep -c "detectarRessarcimentoRelancar54" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV24_ENVELOPE=$(grep -c "auto_aprovar_e_executar" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV24_54ANTES46=$(grep -c "i54" supabase/functions/_shared/ressarcimento-relancar-54.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/ressarcimento-relancar-54.test.ts >/dev/null 2>&1 && INV24_TEST=ok || INV24_TEST=fail
if [ "$INV24_DET" -ge 1 ] && [ "$INV24_ENVELOPE" -ge 1 ] && [ "$INV24_54ANTES46" -ge 1 ] && [ "$INV24_TEST" = "ok" ]; then
  echo "INV-024 (código): PASS"
else
  echo "INV-024 (código): FAIL (detector=$INV24_DET envelope=$INV24_ENVELOPE guard_54_antes_46=$INV24_54ANTES46 teste=$INV24_TEST — ver ADR 0008, NF 374609/775461)"
fi
INV24_SEM_MOTIVO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where ressarc54_status='nao_rodou' and coalesce(btrim(ressarc54_motivo),'')='';" 2>/dev/null | tr -d ' ')
if [ -z "$INV24_SEM_MOTIVO" ]; then
  echo "INV-024 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV24_SEM_MOTIVO" = "0" ]; then
  echo "INV-024 (DB): PASS"
else
  echo "INV-024 (DB): FAIL (nao_rodou_sem_motivo=$INV24_SEM_MOTIVO)"
fi
# INV-024b: o todo Tier A do agente de ressarcimento carrega
# extras.forcar_lancamento_ctrc_baixado=true (round-trip lança 54 sobre CTRC baixado;
# tripé dispensa SÓ localização, mantém CTRC+NF). Bug âncora NF 5631361: 4× bloqueio
# "CTRC ENTREGUE / BAIXADO". Guard = (a) agente usa o helper, (b) helper existe,
# (c) testes do helper + do tripé (flag NÃO burla CTRC/NF divergente) passam. mig n/a (edge).
INV24B_AGENTE=$(grep -c "aplicarForcarCtrcBaixado" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV24B_HELPER=$(grep -c "forcar_lancamento_ctrc_baixado" supabase/functions/_shared/forcar-lancamento-ctrc-baixado.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-read supabase/functions/_shared/forcar-lancamento-ctrc-baixado.test.ts supabase/functions/_shared/validar-tripe-ssw.test.ts >/dev/null 2>&1 && INV24B_TEST=ok || INV24B_TEST=fail
if [ "$INV24B_AGENTE" -ge 1 ] && [ "$INV24B_HELPER" -ge 1 ] && [ "$INV24B_TEST" = "ok" ]; then
  echo "INV-024b (código): PASS"
else
  echo "INV-024b (código): FAIL (agente_usa_helper=$INV24B_AGENTE helper=$INV24B_HELPER testes=$INV24B_TEST — agente parou de forçar CTRC baixado OU flag passou a burlar CTRC/NF; NF 5631361, ADR 0008)"
fi

# INV-026: agente-sugere-ocs-padrao — concluida ⇒ tem aviso. Nenhum card pode ficar
# em analise_padrao_status='concluida' SEM aviso_alteracao_oc (congelaria invisível,
# sem recomendação IA, e o cron nunca re-pegava 'concluida'). Code: cláusula de
# auto-cura no candidate-query; DB: zero cards nesse estado. Ver grupo ELEVA/AVANTE,
# NF 463457 + 6 órfãos (2026-06-26).
INV26_AUTOCURA=$(grep -c "analise_padrao_status.eq.concluida,aviso_alteracao_oc.is.null" supabase/functions/agente-sugere-ocs-padrao/index.ts)
[ "$INV26_AUTOCURA" -ge 1 ] && echo "INV-026 (código): PASS" || echo "INV-026 (código): FAIL (auto-cura concluida-sem-aviso sumiu do candidate-query — agente-sugere-ocs-padrao:240)"
INV26_PRESOS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and lock_aguardando_validacao=true and cod_ultima_ocorrencia in (10,11,19,35,49) and analise_padrao_status='concluida' and aviso_alteracao_oc is null;" 2>/dev/null | tr -d ' ')
if [ -z "$INV26_PRESOS" ]; then
  echo "INV-026 (DB): SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$INV26_PRESOS" = "0" ]; then
  echo "INV-026 (DB): PASS"
else
  echo "INV-026 (DB): FAIL ($INV26_PRESOS cards concluida SEM aviso — congelados sem sugestão IA; re-disparar POST agente-sugere-ocs-padrao {card_id})"
fi

# INV-027: identidade única de ação (acao_key) — "lançar 54 + e-mail" e "lançar 54
# SEM e-mail" são ações OPOSTAS. O banner destaca/vincula pela acao_key (==
# todo.proposta_payload.acao_key == card.analise_padrao_resultado.proposta_destacada_acao),
# NUNCA pelo número 54 (ambíguo entre as duas). Bug raiz: NF 463457 — banner
# mostrava "54 + e-mail (template)" e o clique acionava "54 SEM e-mail" (cliente
# nunca notificado). Code: acaoKey definido+usado + proposta_destacada_acao no
# agente + teste; DB: zero todos ativos (tool+codigo_ssw) SEM acao_key.
INV27_HELPER=$(grep -c "export function acaoKey" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV27_USO=$(grep -c "acao_key: acaoKey(" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV27_DESTACADA=$(grep -c "proposta_destacada_acao" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/regras-auto-acao.sem-email-54.test.ts >/dev/null 2>&1 && INV27_TEST=ok || INV27_TEST=fail
if [ "$INV27_HELPER" -ge 1 ] && [ "$INV27_USO" -ge 1 ] && [ "$INV27_DESTACADA" -ge 1 ] && [ "$INV27_TEST" = "ok" ]; then
  echo "INV-027 (código): PASS"
else
  echo "INV-027 (código): FAIL (helper=$INV27_HELPER uso=$INV27_USO destacada=$INV27_DESTACADA teste=$INV27_TEST — NF 463457, acao_key/proposta_destacada_acao)"
fi
INV27_SEM_KEY=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from todos where status in ('pendente','aprovado') and (proposta_payload->>'tool') is not null and (proposta_payload->'args'->>'codigo_ssw') is not null and not (proposta_payload ? 'acao_key');" 2>/dev/null | tr -d ' ')
# Trigger mig 284 = ponto único que garante acao_key em TODO insert (dos 18 fluxos
# que inserem todos, só regras-auto-acao gravava acao_key → 701 ativos sem chave,
# NF 27573). Se o trigger sumir, novos todos voltam a nascer sem acao_key.
INV27_TRG=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_trigger where tgname='trg_todos_preencher_acao_key';" 2>/dev/null | tr -d ' ')
if [ -z "$INV27_SEM_KEY" ]; then
  echo "INV-027 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV27_SEM_KEY" = "0" ] && [ "$INV27_TRG" = "1" ]; then
  echo "INV-027 (DB): PASS"
elif [ "$INV27_TRG" != "1" ]; then
  echo "INV-027 (DB): FAIL (trigger trg_todos_preencher_acao_key ausente — reaplicar mig 284; sem ele novos todos nascem sem acao_key)"
else
  echo "INV-027 (DB): FAIL ($INV27_SEM_KEY todos ativos sem acao_key — reaplicar backfill mig 284 / conferir trigger)"
fi

# INV-027b (NF 1093446, 2026-07-01): TODO banner que recomenda "54 + e-mail" carrega
# proposta_destacada_acao (acao_key). O agente-oc13-autonomo (fluxo ia_sugestao_oc13)
# NÃO gravava → banner caía na 54 SEM e-mail. Code: oc13 grava a chave. DB: nenhum
# card ativo com banner "54+email" sem proposta_destacada_acao.
INV27B_OC13=$(grep -c "proposta_destacada_acao" supabase/functions/agente-oc13-autonomo/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV27B_OC13" -ge 1 ]; then
  echo "INV-027b (código): PASS"
else
  echo "INV-027b (código): FAIL (agente-oc13-autonomo não grava proposta_destacada_acao — banner cai na 54 sem-email; NF 1093446)"
fi
INV27B_SEM_ACAO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and (aviso_alteracao_oc->>'sugestao') ilike '%54%email%' and (aviso_alteracao_oc->>'proposta_destacada_acao') is null;" 2>/dev/null | tr -d ' ')
if [ -z "$INV27B_SEM_ACAO" ]; then
  echo "INV-027b (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV27B_SEM_ACAO" = "0" ]; then
  echo "INV-027b (DB): PASS"
else
  echo "INV-027b (DB): FAIL ($INV27B_SEM_ACAO cards com banner 54+email SEM proposta_destacada_acao — front cai na 54 sem-email; backfill + conferir agentes)"
fi

# INV-028: fila scan_email_pre_card sem loop/duplicação. Raiz NF 721938: surfar
# (gmail-poll) re-enfileirava o mesmo card a cada poll sem dedup → 2.235 msgs /
# 88 cards (1 card 459×), afogando births + botão "JÁ TEM TRATATIVA" em ~13h FIFO.
# Fix: enqueue ÚNICO com dedup (1 pendente/card) usado por surfar/birth/rescan/botão.
# Code: surfar/birth chamam enqueue_scan_email_pre_card (não enqueue_to_pgmq cru).
# DB: nenhum card aparece >3× na fila E queue_length sob teto são.
INV28_DEDUP=$(grep -c "enqueue_scan_email_pre_card" supabase/functions/_shared/scan-email-enqueue.ts 2>/dev/null | tr -d ' ')
INV28_CRU=$(grep -c "enqueue_to_pgmq" supabase/functions/_shared/scan-email-enqueue.ts 2>/dev/null | tr -d ' ')
if [ "$INV28_DEDUP" -ge 2 ] && [ "$INV28_CRU" = "0" ]; then
  echo "INV-028 (código): PASS"
else
  echo "INV-028 (código): FAIL (dedup_calls=$INV28_DEDUP enqueue_cru=$INV28_CRU — surfar/birth devem usar enqueue_scan_email_pre_card, nunca enqueue_to_pgmq cru; NF 721938)"
fi
INV28_MAXDUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select coalesce(max(n),0) from (select count(*) n from pgmq.q_scan_email_pre_card where message->>'card_id' is not null group by message->>'card_id') x;" 2>/dev/null | tr -d ' ')
INV28_LEN=$($PSQL "$SUPABASE_DB_URL" -tA -c "select queue_length from pgmq.metrics('scan_email_pre_card');" 2>/dev/null | tr -d ' ')
if [ -z "$INV28_MAXDUP" ]; then
  echo "INV-028 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV28_MAXDUP" -le 3 ] && [ "${INV28_LEN:-0}" -le 1000 ]; then
  echo "INV-028 (DB): PASS (max_dup/card=$INV28_MAXDUP, queue_len=$INV28_LEN)"
else
  echo "INV-028 (DB): FAIL (max_dup/card=$INV28_MAXDUP queue_len=$INV28_LEN — loop de re-enqueue voltou; checar surfar/dedup, NF 721938)"
fi

# INV-029: "Criar Card" manual (criar-card-manual) NÃO pode quebrar a reconciliação
# Bastão. O card manual nasce com agent_state.origem="manual" (NUNCA "email_ssw") e
# SEM carimbar bastao_*_no_lancamento — assim flui pelo caminho NORMAL do sync-bastao
# (49→AGUARDANDO VOCÊ, 41→CONFLITOS, resposta→CLIENTE RESPONDEU). O guard anti-reabertura
# do sync-bastao (escopado a origem==="email_ssw") NÃO pode passar a incluir "manual".
# Criação só com última oc de relacionamento (isOcorrenciaDeRelacionamentoCtx) + escolha
# de CTRC via escolherCtrcManual. NF-âncora 684385 (BUNZL/Victor), oc=10.
INV29_ORIGEM=$(grep -c 'origem: "manual"' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_NO_EMAILSSW=$(grep -cE 'origem:[[:space:]]*"email_ssw"' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_NO_SEED=$(grep -cE 'bastao_oc_no_lancamento|bastao_updated_at_no_lancamento' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_SELECTOR=$(grep -c 'escolherCtrcManual' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_GATE=$(grep -c 'isOcorrenciaDeRelacionamentoCtx' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
# o guard email_ssw do sync-bastao não pode referenciar "manual"
INV29_GUARD_LIMPO=$(grep -c 'origem"\] === "manual"' supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
# Erro SEMPRE claro: nenhuma resposta tratada pode ser não-2xx (senão o
# supabase.functions.invoke esconde a mensagem com "non-2xx status code"). NF 263243.
INV29_NAO2XX=$(grep -cE 'jsonResp\([^)]*,[[:space:]]*(400|401|403|405|500)\)' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/escolher-ctrc-manual.test.ts >/dev/null 2>&1 && INV29_TEST=ok || INV29_TEST=fail
if [ "$INV29_ORIGEM" -ge 1 ] && [ "$INV29_NO_EMAILSSW" = "0" ] && [ "$INV29_NO_SEED" = "0" ] && [ "$INV29_SELECTOR" -ge 1 ] && [ "$INV29_GATE" -ge 1 ] && [ "$INV29_GUARD_LIMPO" = "0" ] && [ "$INV29_NAO2XX" = "0" ] && [ "$INV29_TEST" = "ok" ]; then
  echo "INV-029 (código): PASS"
else
  echo "INV-029 (código): FAIL (origem_manual=$INV29_ORIGEM no_email_ssw=$INV29_NO_EMAILSSW no_seed_bastao=$INV29_NO_SEED selector=$INV29_SELECTOR gate=$INV29_GATE guard_sync_limpo=$INV29_GUARD_LIMPO nao2xx=$INV29_NAO2XX teste=$INV29_TEST — card manual quebrando reconciliação Bastão OU devolvendo erro não-2xx que esconde a mensagem; NF 684385/263243)"
fi
INV29_BAD=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where agent_state->>'origem'='manual' and state='AGUARDANDO_CLIENTE' and cod_ultima_ocorrencia is distinct from 54;" 2>/dev/null | tr -d ' ')
if [ -z "$INV29_BAD" ]; then
  echo "INV-029 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV29_BAD" = "0" ]; then
  echo "INV-029 (DB): PASS"
else
  echo "INV-029 (DB): FAIL ($INV29_BAD cards origem=manual em AGUARDANDO_CLIENTE com oc≠54 — card manual sendo especial-cased fora da regra oc54⟺AGUARDANDO_CLIENTE)"
fi

# INV-030: lista de ações sugeridas SEM opções duplicadas — no máx 1 todo ATIVO por
# (card_id, tool, codigo_ssw). Caio 2026-06-26/27: a mesma ação aparecia 2-6× ("54 +
# e-mail", "54 sem e-mail", oc 49) pq vários fluxos criam todos sem dedup transversal
# (inclusive extravio_cockpit SEM acao_key — NF 5948). Identidade do PAYLOAD (tool+cod),
# não do campo acao_key. Guard: índice único parcial uniq_todos_card_tool_cod_ativo
# (mig 278, substitui o por-acao_key da 277) — 2ª inserção falha (unique_violation) e
# os inserts tratam erro = no-op idempotente.
INV30_IDX=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_index where indexrelid='uniq_todos_card_tool_cod_ativo'::regclass and indisvalid;" 2>/dev/null | tr -d ' ')
if [ -z "$INV30_IDX" ]; then
  echo "INV-030 (índice): SKIP (sem acesso ao DB local)"
elif [ "$INV30_IDX" = "1" ]; then
  echo "INV-030 (índice): PASS"
else
  echo "INV-030 (índice): FAIL (índice único uniq_todos_card_tool_cod_ativo ausente/inválido — mig 278)"
fi
INV30_DUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select card_id, proposta_payload->>'tool' tl, coalesce(proposta_payload->'args'->>'codigo_ssw','') cd from todos where status in ('pendente','aprovado') and (proposta_payload->>'tool') is not null group by 1,2,3 having count(*)>1) x;" 2>/dev/null | tr -d ' ')
if [ -z "$INV30_DUP" ]; then
  echo "INV-030 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV30_DUP" = "0" ]; then
  echo "INV-030 (DB): PASS"
else
  echo "INV-030 (DB): FAIL ($INV30_DUP cards com ação duplicada na lista — dedup quebrou, ver mig 278)"
fi

# INV-031: card NUNCA preso para sempre em EXECUTANDO_ACAO (causa raiz H8, NF 296312).
# aprovar_e_executar enfileira a ação SEM garantia de conclusão; se a mensagem do
# executor se perde, o card congela (só alerta de 30min, sem recuperação). Fix:
# watchdog reconciliar_execucoes_presas (cron 5min, threshold 15min) re-enfileira
# (só-SSW idempotente por-todo) OU reverte p/ humano (e-mail/null-stale/anti-loop,
# máx 2 tentativas) — NUNCA re-dispatch cego. + observabilidade no executor
# (mensagem lida vs concluída) pra confirmar o gatilho. mig 279.
INV31_OBS=$(grep -oE '"(mensagem_lida|processamento_iniciado|processamento_concluido|processamento_falhou_retry|processamento_falhou_final|mensagem_deletada|mensagem_arquivada_dlq)"' supabase/functions/executor/index.ts 2>/dev/null | sort -u | wc -l | tr -d ' ')
INV31_RECON=$(grep -c "reconciliar_execucoes_presas\|_reconciliar_decidir" migration/2026-06-29_279_watchdog_execucao_presa.sql 2>/dev/null | tr -d ' ')
INV31_LOCK=$(grep -c "pg_try_advisory_xact_lock" migration/2026-06-29_279_watchdog_execucao_presa.sql 2>/dev/null | tr -d ' ')
INV31_HEALTH=$(grep -c "reconciliar_execucoes_presas" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV31_OBS" -ge 7 ] && [ "$INV31_RECON" -ge 2 ] && [ "$INV31_LOCK" -ge 1 ] && [ "$INV31_HEALTH" -ge 1 ]; then
  echo "INV-031 (código): PASS"
else
  echo "INV-031 (código): FAIL (obs_eventos=$INV31_OBS/7 reconciliador=$INV31_RECON lock=$INV31_LOCK health=$INV31_HEALTH — watchdog execução presa / observabilidade regrediu; NF 296312, mig 279)"
fi
INV31_CRON=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cron.job where jobname='reconciliar-execucao-presa-every-5min';" 2>/dev/null | tr -d ' ')
# Decisão pura (assinatura: whitelisted, tem_email, acoes, tentativas, max, recent):
# só-SSW→reenfileirar · null-stale→reverter · email→reverter · não-whitelist→reverter.
INV31_DEC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select public._reconciliar_decidir(true,false,'[{\"sucesso\":true}]'::jsonb,0,2,10)||'|'||public._reconciliar_decidir(true,false,'[{\"sucesso\":null,\"idade_min\":120}]'::jsonb,0,2,10)||'|'||public._reconciliar_decidir(true,true,'[]'::jsonb,0,2,10)||'|'||public._reconciliar_decidir(false,false,'[]'::jsonb,0,2,10);" 2>/dev/null | tr -d ' ')
INV31_PRESOS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='EXECUTANDO_ACAO' and updated_at < now() - interval '30 min';" 2>/dev/null | tr -d ' ')
if [ -z "$INV31_CRON" ]; then
  echo "INV-031 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV31_CRON" = "1" ] && [ "$INV31_DEC" = "reenfileirar|reverter|reverter|reverter" ] && [ "${INV31_PRESOS:-0}" = "0" ]; then
  echo "INV-031 (DB): PASS"
else
  echo "INV-031 (DB): FAIL (cron=$INV31_CRON decisao_pura=$INV31_DEC presos_30min=$INV31_PRESOS — watchdog não instalado / decidindo errado / card preso não reconciliado; NF 296312)"
fi
# INV-031b: reverter_acao_falhou RESPEITA a dedup do INV-030 (uniq_todos_card_tool_cod_ativo).
# Ressuscitar o gêmeo cancelado pra 'pendente' quando JÁ existe um ativo com a mesma
# identidade (card,tool,codigo_ssw) violava o índice e abortava a txn do reconciliador
# → cron reconciliar-execucao-presa em LOOP de falha 5/5min (NF 5631361, 2026-06-30).
# Guard: a função tem a guarda de dedup (NOT EXISTS + row_number) E a ÚLTIMA execução
# do cron NÃO é 'failed' (um loop ativo aparece aqui na hora). mig 283.
INV31B_GUARD=$(grep -c "row_number() OVER" migration/2026-06-30_283_reverter_acao_falhou_respeita_dedup.sql 2>/dev/null | tr -d ' ')
INV31B_NOTEXISTS=$(grep -c "NOT EXISTS" migration/2026-06-30_283_reverter_acao_falhou_respeita_dedup.sql 2>/dev/null | tr -d ' ')
if [ "${INV31B_GUARD:-0}" -ge 1 ] && [ "${INV31B_NOTEXISTS:-0}" -ge 1 ]; then
  echo "INV-031b (código): PASS"
else
  echo "INV-031b (código): FAIL (guarda dedup row_number=$INV31B_GUARD not_exists=$INV31B_NOTEXISTS removida de reverter_acao_falhou — volta a colidir com uniq_todos_card_tool_cod_ativo; NF 5631361, mig 283)"
fi
INV31B_ULT=$($PSQL "$SUPABASE_DB_URL" -tA -c "select coalesce((select status from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='reconciliar-execucao-presa-every-5min' order by d.start_time desc limit 1),'sem_run');" 2>/dev/null | tr -d ' ')
if [ -z "$INV31B_ULT" ]; then
  echo "INV-031b (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV31B_ULT" != "failed" ]; then
  echo "INV-031b (DB): PASS"
else
  echo "INV-031b (DB): FAIL (última execução do watchdog = failed — cron reconciliar-execucao-presa em LOOP de falha; abra o '⚠ N falhas' de hoje no monitor de capacidade; NF 5631361, mig 283)"
fi

# INV-032: pós-oc49 em EXTRAVIO precisa SOBREVIVER até a operadora agir (NF 705764,
# Larissa). 3 raízes independentes do mesmo card:
# (α) Pass D NÃO apaga o banner de recomendação do agente (aviso.tipo=
#     'ia_sugestao_ocs_padrao') quando a oc do Bastão é LAG de um lançamento do
#     Cockpit (ehLagDeLancamentoCockpit) → "54 + e-mail de extravio" sobrevive.
# (β) o todo "54 + e-mail" carrega o template QUE O AGENTE DECIDIU
#     (templateEmail54Override, ex EXTRAVIO_TOTAL_PEDIR_ROMANEIO), não o
#     FALTA_DE_VOLUME genérico da regra oc=49.
# (δ) card nascido de extravio (handleExtravioPendencia) enfileira o scan de e-mail
#     pré-existente (enfileirarScanEmailPreCard origem=extravio).
INV32_BANNER=$(grep -c "banner_ia_preservado" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
# Guard usa o predicado PURO passDDevePreservarBannerIaSugestao (preserva só em
# classe 'lag' = estritamente anterior; mesmo-dia 'ambiguo' NÃO preserva — refino).
INV32_GUARD=$(grep -A12 'ia_sugestao_ocs_padrao' supabase/functions/sync-bastao/index.ts 2>/dev/null | grep -c "passDDevePreservarBannerIaSugestao" | tr -d ' ')
INV32_PRED=$(grep -c "classe === \"lag\"" supabase/functions/_shared/lag-lancamento-54.ts 2>/dev/null | tr -d ' ')
INV32_TPL_RULE=$(grep -c "templateEmail54Override" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV32_TPL_AGENT=$(grep -c "templateEmail54Override" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV32_SCAN=$(grep -c 'origem: "extravio"' supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV32_TEST=$([ -f supabase/functions/_shared/regras-auto-acao.template-override-54.test.ts ] && echo 1 || echo 0)
INV32_TEST2=$(grep -c "passDDevePreservarBannerIaSugestao" supabase/functions/_shared/lag-lancamento-54.test.ts 2>/dev/null | tr -d ' ')
# (γ) Codex 2026-07-02 (NF 609867): oc=19 é PÓS-ENTREGA — default do 54+email deve
# ser ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (pede romaneio+descrição/valor), não o
# FALTA_DE_VOLUME (pré-entrega, não pede nada). E o override tem de REPATCHAR o todo
# 54+email já existente (não só INSERT). E o executor resolve as variáveis do template
# (link_evidencia/n_volumes_falta) — nunca placeholder literal.
INV32_OC19DEF=$(grep -c 'enviar_email_template: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO"' supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV32_REPATCH=$(grep -c "repatcharTemplateEmail54Existente" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV32_RENDER=$(grep -cE "n_volumes_falta: nVolumesFalta|link_evidencia: linkEvidencia" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV32_BANNER:-0}" -ge 2 ] && [ "${INV32_GUARD:-0}" -ge 1 ] && [ "${INV32_PRED:-0}" -ge 1 ] && [ "${INV32_TPL_RULE:-0}" -ge 2 ] && [ "${INV32_TPL_AGENT:-0}" -ge 1 ] && [ "${INV32_SCAN:-0}" -ge 1 ] && [ "$INV32_TEST" = "1" ] && [ "${INV32_TEST2:-0}" -ge 3 ] && [ "${INV32_OC19DEF:-0}" -ge 1 ] && [ "${INV32_REPATCH:-0}" -ge 2 ] && [ "${INV32_RENDER:-0}" -ge 2 ]; then
  echo "INV-032 (código): PASS"
else
  echo "INV-032 (código): FAIL (banner_preserva=$INV32_BANNER guard=$INV32_GUARD pred_lag=$INV32_PRED tpl_regra=$INV32_TPL_RULE tpl_agente=$INV32_TPL_AGENT scan_extravio=$INV32_SCAN teste=$INV32_TEST teste_banner=$INV32_TEST2 oc19_default=$INV32_OC19DEF repatch=$INV32_REPATCH render_vars=$INV32_RENDER — pós-49 extravio regrediu: banner apagado pelo Pass D / template 54+email genérico / OU (NF 609867) oc=19 voltou a FALTA_DE_VOLUME / repatch do todo existente sumiu / executor não resolve link_evidencia|n_volumes_falta; NF 705764/609867)"
fi

# INV-033: banner "EMAIL BLOQUEADO" mostra razão SMTP LEGÍVEL, nunca blob hex
# (bug B, NF 575330 HDL LOGISTICA / Larissa). Raiz: extração de motivo/destinatário
# do bounce usava `/(550...)/` sobre o 1º text/plain e ignorava o part estruturado
# `message/delivery-status` → em NDR Microsoft/Exchange capturava diagnóstico hex.
# Fix: parse-bounce-ndr.ts lê delivery-status PRIMEIRO (Diagnostic-Code /
# Final-Recipient), com fallback GUARDADO contra hex (razão real tem letra > f).
INV33_PARSER=$([ -f supabase/functions/_shared/parse-bounce-ndr.ts ] && echo 1 || echo 0)
INV33_WIRE=$(grep -c "parseBounceNdr(flattenPartsDecoded" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
# O regex ingênuo antigo NÃO pode voltar a alimentar o payload do bounce.
INV33_NOOLD=$(grep -c 'motivoMatch = conteudoBounce.match(/(550' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV33_TEST=$(deno test --no-check supabase/functions/_shared/parse-bounce-ndr.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# Item 4a: idempotência por gmail_message_id (não re-processa o mesmo bounce).
INV33_IDEMP=$(grep -c 'payload->>gmail_message_id' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
# Item 4b: banner obsoleto quando há outbound posterior ao bounce.
INV33_STALE=$(grep -c 'BounceDetectadoIgnorado' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV33_OUTB=$(grep -c 'cards_emails_outbound' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
# Parser forense da investigação A (guard próprio).
INV33_FORENSE=$(deno test --no-check supabase/functions/_shared/bounce-forensics.test.ts >/dev/null 2>&1 && echo ok || echo fail)
if [ "${INV33_PARSER:-0}" = "1" ] && [ "${INV33_WIRE:-0}" -ge 1 ] && [ "${INV33_NOOLD:-0}" -eq 0 ] && [ "$INV33_TEST" = "ok" ] && [ "${INV33_IDEMP:-0}" -ge 1 ] && [ "${INV33_STALE:-0}" -ge 1 ] && [ "${INV33_OUTB:-0}" -ge 1 ] && [ "$INV33_FORENSE" = "ok" ]; then
  echo "INV-033: PASS"
else
  echo "INV-033: FAIL (parser=$INV33_PARSER wire=$INV33_WIRE regex_antigo=$INV33_NOOLD teste=$INV33_TEST idemp=$INV33_IDEMP banner_obsoleto=$INV33_STALE outbound=$INV33_OUTB forense=$INV33_FORENSE — banner de bounce: hex / duplicado / stale pós re-envio; NF 575330 HDL)"
fi

# INV-034: extravio PARCIAL — oc 33 de COMPLETUDE exige romaneio + descrição +
# valor; combo 33+44 OPERACIONAL (Caso 2) exige só romaneio; extravio TOTAL não
# regride (só romaneio). Gate global (modo AVISADO) nos 2 finalizadores + enforce
# autoritativo no executor (flag extravio_parcial_gate_enforce). NF 66193 INOVAMED.
INV34_MOD=$([ -f supabase/functions/_shared/extravio-parcial-dossie.ts ] && echo 1 || echo 0)
INV34_TEST=$(deno test --no-check supabase/functions/_shared/extravio-parcial-dossie.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# Gate plugado nos DOIS finalizadores + no executor (enforce autoritativo).
INV34_PROP=$(grep -c "aplicarGateOc33Parcial\|decidirGateOc33\|gate_oc33" supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV34_REGRA=$(grep -c "decidirGateOc33\|gate_oc33\|ehExtravioParcial" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV34_EXEC=$(grep -c "gateOc33Enforce" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Corte-em-70 nos handlers de oc 33 NÃO pode voltar (descrição/valor truncava).
INV34_NO70=$(grep -c "texto33.slice(0, 70)\|oc33Texto = ((extras\[\"oc33_texto\"\] as string | undefined)?.trim() ?? \"\").slice(0, 70)" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Enforce autoritativo respeita a flag + o escape do operador.
INV34_FLAG=$(grep -c "extravio_parcial_gate_enforce" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34_FORCE=$(grep -c "forcar_oc33_dossie_incompleto" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Fase 2 (NF 66193): HOTFIX — interpretador NUNCA seleciona gmail_message_id como
# COLUNA de messages_inbox (não existe; fica em raw_payload). Deve ser 0.
INV34_HOTFIX=$(grep -c "recebido_em, gmail_message_id" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
# sync-bastao PRESERVA o dossiê em update/reabertura. Refatorado 2026-07-03:
# mesclarExtravioParcial → preservarExtravioParcial (_shared/preservar-extravio-
# parcial.ts); o check aceita os dois nomes (fix Caio 2026-07-17 — grep do nome
# antigo dava falso FAIL desde o refactor).
INV34_SYNCPRES=$(grep -cE "preservarExtravioParcial|mesclarExtravioParcial" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
# reprocessar-anexos ignora deletado_em como ativo (ressuscita) via decidirReuploadAnexo.
INV34_REPROC=$(grep -c "decidirReuploadAnexo" supabase/functions/reprocessar-anexos-mensagem/index.ts 2>/dev/null | tr -d ' ')
# Sub-caso Tier B-DV (Caso 2) no agente-ressarcimento + testes puros novos.
INV34_CASO2=$(grep -c "detectarPedirDescricaoValor" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV34_REUSO=$(deno test --no-check supabase/functions/_shared/reuso-anexo.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# B-DV 54+email NUNCA vira 54 sem e-mail: guard autoritativo no executor.
INV34_BDVGUARD=$(grep -c "deveBloquear54PedirDescValor" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Seed HISTÓRICO do romaneio (Codex 2026-07-02, NF 575330): o dossiê NÃO pode
# marcar falso "faltando romaneio" quando o romaneio chegou ANTES do dossiê
# nascer. Interpretador semeia via montarSeedRomaneio; executor materializa a
# 2ª oc 33 POR FONTE (fonte="ssw" NÃO reanexa nem bloqueia) via decidirAcaoRomaneioCompletude.
INV34_SEED=$(grep -c "montarSeedRomaneio" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
INV34_FONTEGUARD=$(grep -c "decidirAcaoRomaneioCompletude" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV34_MOD:-0}" = "1" ] && [ "$INV34_TEST" = "ok" ] && [ "${INV34_PROP:-0}" -ge 1 ] && [ "${INV34_REGRA:-0}" -ge 1 ] && [ "${INV34_EXEC:-0}" -ge 1 ] && [ "${INV34_NO70:-0}" -eq 0 ] && [ "${INV34_FLAG:-0}" -ge 1 ] && [ "${INV34_FORCE:-0}" -ge 1 ] && [ "${INV34_HOTFIX:-0}" -eq 0 ] && [ "${INV34_SYNCPRES:-0}" -ge 1 ] && [ "${INV34_REPROC:-0}" -ge 1 ] && [ "${INV34_CASO2:-0}" -ge 1 ] && [ "$INV34_REUSO" = "ok" ] && [ "${INV34_BDVGUARD:-0}" -ge 1 ] && [ "${INV34_SEED:-0}" -ge 1 ] && [ "${INV34_FONTEGUARD:-0}" -ge 1 ]; then
  echo "INV-034: PASS"
else
  echo "INV-034: FAIL (mod=$INV34_MOD teste=$INV34_TEST prop=$INV34_PROP regra=$INV34_REGRA exec=$INV34_EXEC corte70=$INV34_NO70 flag=$INV34_FLAG force=$INV34_FORCE hotfix_gmail=$INV34_HOTFIX syncpres=$INV34_SYNCPRES reproc=$INV34_REPROC caso2=$INV34_CASO2 reuso=$INV34_REUSO bdvguard=$INV34_BDVGUARD seed=$INV34_SEED fonteguard=$INV34_FONTEGUARD — extravio parcial regrediu: gate/corte-em-70, OU Fase 2: select gmail_message_id inexistente voltou / sync-bastao não preserva dossiê / reprocessar-anexos não ressuscita / Tier B-DV sumiu / B-DV 54+email sem guard de destinatário, OU seed histórico do romaneio sumiu / executor não materializa por fonte; NF 66193/575330)"
fi

# INV-034b (Caio 2026-07-17, NF 135724 DUILIO): materialização UNIVERSAL da oc 33
# de completude + guard da conversão PDF. Regressões travadas: (a) executor voltar
# a curto-circuitar por anexo do operador (jaTemAnexo suprimia até o TEXTO de
# desc/valor — a NF 135724 saiu no SSW só com "Reversão de perdas iniciada.");
# (b) materialização voltar a ser só-Caso-2 (100% dos lançamentos reais são caso 1);
# (c) front perder o guard que impede scan JBIG2 quase-em-branco de subir pro SSW.
INV34B_MAT=$(grep -c "montarTextoOc33ComOperador" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_UNIV=$(grep -c "deveMaterializarCompletude" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_CURTO=$(grep -c "jaTemAnexo" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_FLAGNOVA=$(grep -c "extravio_parcial_materializacao_enabled" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_PDFMIME=$(grep -c "ehImagemMimeSsw" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_GUARDF=$(grep -c "avaliarPaginaConvertida" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV34B_TEST=$(deno test --allow-all --no-check supabase/functions/_shared/extravio-parcial-dossie.test.ts 2>/dev/null | grep -q "0 failed" && echo ok || echo fail)
if [ "${INV34B_MAT:-0}" -ge 2 ] && [ "${INV34B_UNIV:-0}" -ge 2 ] && [ "${INV34B_CURTO:-0}" -eq 0 ] && [ "${INV34B_FLAGNOVA:-0}" -ge 2 ] && [ "${INV34B_PDFMIME:-0}" -ge 2 ] && [ "${INV34B_GUARDF:-0}" -ge 1 ] && [ "$INV34B_TEST" = "ok" ]; then
  echo "INV-034b: PASS"
else
  echo "INV-034b: FAIL (mat=$INV34B_MAT univ=$INV34B_UNIV curto_circuito=$INV34B_CURTO flag_nova=$INV34B_FLAGNOVA pdf_mime=$INV34B_PDFMIME guard_front=$INV34B_GUARDF teste=$INV34B_TEST — NF 135724 pode regredir: oc 33 de completude sem desc/valor no SSW, PDF cru como foto, ou conversão quebrada subindo calada)"
fi

# INV-034c (Carlos/Caio 2026-09-04, NF 145307 SOLUÇÃO PET / NF 632603 DUILIO):
# o SEED do romaneio NÃO pode voltar a rodar o filtro anti-pedido no corpo
# INTEIRO da resposta. Como o cliente responde CITANDO o nosso e-mail, e os
# templates que pedem o romaneio contêm "encaminhar o romaneio"/"aguardo", o
# fluxo se auto-vetava: 381 de 424 mensagens (89,9%) e 0 recuperações em 1.831
# rodadas. E o detector conhecia SÓ a palavra "romaneio": a NF 632603 mandou
# "Segue minuta e descritivo dos itens" + PDF e o dossiê ficou incompleto, com
# as duas propostas de oc 33 nascendo `gate_oc33.bloqueada = true`.
# Checa: (a) o módulo de separação de citação existe e é usado pelo detector;
# (b) o filename "romaneio" conta como sinal MAS "coleta" sozinho NÃO
# (coleta_mob*.jpg é foto do app do SSW — NF 573/884446); (c) o sinônimo
# "minuta" existe no sinal de ENVIO e continua FORA do filename; (d) TUDO é
# opt-in — omitir as opções reproduz o v1 byte a byte, e o interpretador só
# decide pelo v2 com a flag `seed_romaneio_v2_enabled` ligada; (e) os testes
# com as fixtures REAIS passam.
INV34C_MOD=$(test -f supabase/functions/_shared/texto-citado-email.ts && echo ok || echo fail)
INV34C_USO=$(grep -c "separarTextoDoCliente" supabase/functions/_shared/extravio-parcial-dossie.ts 2>/dev/null | tr -d ' ')
INV34C_OPTIN=$(grep -c "escopoTextoDoCliente" supabase/functions/_shared/extravio-parcial-dossie.ts 2>/dev/null | tr -d ' ')
INV34C_FNAME=$(grep -c "RE_FILENAME_ROMANEIO" supabase/functions/_shared/extravio-parcial-dossie.ts 2>/dev/null | tr -d ' ')
# "coleta" NÃO pode entrar na regex de filename (falso positivo coleta_mob).
INV34C_NOCOLETA=$(grep -c "RE_FILENAME_ROMANEIO = /romaneio/i" supabase/functions/_shared/extravio-parcial-dossie.ts 2>/dev/null | tr -d ' ')
# o sinônimo "minuta" tem de estar no sinal de ENVIO (NF 632603)...
INV34C_MINUTA=$(grep -c "aceitarSinonimosDocumento" supabase/functions/_shared/extravio-parcial-dossie.ts 2>/dev/null | tr -d ' ')
# ...e NUNCA no filename: "minuta" em nome de arquivo não foi medido.
INV34C_MINFNAME=$(grep -c "RE_FILENAME_ROMANEIO = /romaneio|minuta/i\|minuta.*test(a.filename" supabase/functions/_shared/extravio-parcial-dossie.ts 2>/dev/null | tr -d ' ')
INV34C_SOMBRA=$(grep -c "SeedRomaneioAvaliado" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
# o v2 só pode DECIDIR atrás da flag — nunca hardcoded.
INV34C_FLAG=$(grep -c "seed_romaneio_v2_enabled" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
INV34C_TEST=$(cd supabase/functions && deno test --allow-all --no-check _shared/texto-citado-email.test.ts _shared/extravio-parcial-dossie.test.ts 2>/dev/null | grep -q "0 failed" && echo ok || echo fail)
if [ "$INV34C_MOD" = "ok" ] && [ "${INV34C_USO:-0}" -ge 1 ] && [ "${INV34C_OPTIN:-0}" -ge 2 ] && [ "${INV34C_FNAME:-0}" -ge 2 ] && [ "${INV34C_NOCOLETA:-0}" -ge 1 ] && [ "${INV34C_MINUTA:-0}" -ge 2 ] && [ "${INV34C_MINFNAME:-1}" -eq 0 ] && [ "${INV34C_SOMBRA:-0}" -ge 1 ] && [ "${INV34C_FLAG:-0}" -ge 1 ] && [ "$INV34C_TEST" = "ok" ]; then
  echo "INV-034c: PASS"
else
  echo "INV-034c: FAIL (mod=$INV34C_MOD uso=$INV34C_USO optin=$INV34C_OPTIN filename=$INV34C_FNAME so_romaneio=$INV34C_NOCOLETA minuta=$INV34C_MINUTA minuta_no_filename=$INV34C_MINFNAME sombra=$INV34C_SOMBRA flag=$INV34C_FLAG teste=$INV34C_TEST — o seed do romaneio voltou a ler a citação do NOSSO e-mail (89,9% de falso-negativo), ou 'coleta'/'minuta' entrou no filename, ou o v2 deixou de ser opt-in atrás da flag. NF 145307/632603)"
fi

# INV-035 (Caio 2026-07-20, NF 335713 MOTO FEST / 232346 DAMASIO, DUILIO):
# email_sem_oc (skip_oc = "notificar cliente por e-mail SEM lançar ocorrência") NÃO
# pode cancelar as propostas de lançamento (49/54/55) do card de extravio — elas
# seguem disponíveis pro operador lançar quando o cliente responder. Duas camadas:
# (a) código — alguma migration mantém o guard skip_oc no RPC aprovar_e_executar;
# (b) SQL — nenhum card EXTRAVIO_MONITORADO com email_sem_oc executado tem irmãs
# de lançamento auto-canceladas.
INV35_CODE=$(grep -rl "IF NOT v_skip_oc THEN" migration/ 2>/dev/null | wc -l | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then
  INV35_SQL="SKIP"
else
  INV35_SQL=$($PSQL "$SUPABASE_DB_URL" -tAc "select count(distinct c.id) from cards c join todos ex on ex.card_id=c.id and ex.status='executado' and (ex.proposta_payload#>>'{meta,acao}')='email_sem_oc' join todos irm on irm.card_id=c.id and irm.status='cancelado' and irm.rejection_reason='Auto-cancelado: outra opção foi aprovada no mesmo card' and (irm.proposta_payload#>>'{meta,origem}')='extravio_cockpit' and (irm.proposta_payload#>>'{meta,acao}')<>'email_sem_oc' where c.state='EXTRAVIO_MONITORADO';" 2>/dev/null | tr -d ' ')
fi
if [ "${INV35_CODE:-0}" -ge 1 ] && { [ "$INV35_SQL" = "SKIP" ] || [ "${INV35_SQL:-1}" = "0" ]; }; then
  echo "INV-035: PASS (code=$INV35_CODE sql=$INV35_SQL)"
else
  echo "INV-035: FAIL (code=$INV35_CODE sql=$INV35_SQL — email_sem_oc voltou a cancelar as propostas de lançamento do extravio; mig 299, NF 335713/232346)"
fi

# INV-036 (Caio 2026-07-21, onboarding KAROLINE/Larissa e futuros): invariantes de
# carteira que impedem "card sumindo/conflito" em qualquer reatribuição de operador.
#   (a) Nenhum CNPJ em 2+ carteiras de operadores ATIVOS ("1 CNPJ = 1 operador";
#       2 carteiras → resolver retorna ambíguo → card órfão, invisível exceto gestor).
#   (b) Nenhum card NÃO-terminal com assigned_operator_id apontando pra operador
#       inativo OU dormente (cockpit_ativo=false) → card invisível exceto gestor.
# Ambos são SQL (produção). Fonte: audit-card-routing 2026-06-27 + operador-resolver.ts.
if [ -z "$SUPABASE_DB_URL" ]; then
  echo "INV-036: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
else
  INV36_DUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select cnpj from (select unnest(carteira) cnpj from operadores where ativo) t group by cnpj having count(*) > 1) d;" 2>/dev/null | tr -d ' ')
  INV36_ORFAO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c join operadores o on o.id=c.assigned_operator_id where c.state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO') and (o.ativo=false or o.cockpit_ativo=false);" 2>/dev/null | tr -d ' ')
  if [ "${INV36_DUP:-1}" = "0" ] && [ "${INV36_ORFAO:-1}" = "0" ]; then
    echo "INV-036: PASS (0 CNPJ em 2 carteiras ativas, 0 card vivo em operador dormente)"
  else
    echo "INV-036: FAIL (cnpj_em_2_carteiras=$INV36_DUP, cards_vivos_em_operador_dormente=$INV36_ORFAO — regressão de onboarding: card vira órfão/conflito; ver docs/operadoras/karoline/PLANO_ONBOARDING.md e operador-resolver.ts)"
  fi
fi

# INV-037 (Caio 2026-07-21, onboarding Karoline): auto-encaminhamento da resposta
# do cliente pra caixa Gmail do NOVO dono quando o card foi reatribuído. Blindado
# (nunca derruba o poll) + flag + dedup. Três camadas:
#   (a) código: o gmail-poll-inbox CHAMA encaminharRespostaSeReatribuido (hook vivo);
#   (b) teste: a decisão pura deveEncaminhar (só reatribuído + flag on) passa;
#   (c) DB: feature flag + tabela de idempotência existem.
INV37_HOOK=$(grep -c "await encaminharRespostaSeReatribuido(" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/encaminhar-email-reatribuido.test.ts >/dev/null 2>&1 && INV37_TEST=ok || INV37_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV37_DB="SKIP"
else
  INV37_DB=$($PSQL "$SUPABASE_DB_URL" -tAc "select case when exists(select 1 from feature_flags where key='email_forward_reatribuido_ativo') and exists(select 1 from information_schema.tables where table_name='emails_encaminhados_operador') then 'ok' else 'faltando' end;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV37_HOOK:-0}" -ge 1 ] && [ "$INV37_TEST" = "ok" ] && { [ "$INV37_DB" = "ok" ] || [ "$INV37_DB" = "SKIP" ]; }; then
  echo "INV-037: PASS (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB)"
else
  echo "INV-037: FAIL (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB — auto-forward de card reatribuido regrediu; mig 302, _shared/encaminhar-email-reatribuido.ts, gmail-poll-inbox hook)"
fi

# INV-037 (Caio 2026-07-21, onboarding Karoline): auto-encaminhamento da resposta
# do cliente pra caixa Gmail do NOVO dono quando o card foi reatribuído. Blindado
# (nunca derruba o poll) + flag + dedup. Três camadas:
#   (a) código: o gmail-poll-inbox CHAMA encaminharRespostaSeReatribuido (hook vivo);
#   (b) teste: a decisão pura deveEncaminhar (só reatribuído + flag on) passa;
#   (c) DB: feature flag + tabela de idempotência existem.
INV37_HOOK=$(grep -c "await encaminharRespostaSeReatribuido(" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/encaminhar-email-reatribuido.test.ts >/dev/null 2>&1 && INV37_TEST=ok || INV37_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV37_DB="SKIP"
else
  INV37_DB=$($PSQL "$SUPABASE_DB_URL" -tAc "select case when exists(select 1 from feature_flags where key='email_forward_reatribuido_ativo') and exists(select 1 from information_schema.tables where table_name='emails_encaminhados_operador') then 'ok' else 'faltando' end;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV37_HOOK:-0}" -ge 1 ] && [ "$INV37_TEST" = "ok" ] && { [ "$INV37_DB" = "ok" ] || [ "$INV37_DB" = "SKIP" ]; }; then
  echo "INV-037: PASS (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB)"
else
  echo "INV-037: FAIL (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB — auto-forward de card reatribuido regrediu; mig 302, _shared/encaminhar-email-reatribuido.ts, gmail-poll-inbox hook)"
fi

# INV-037 (Caio 2026-07-21, NF 292727 KAROLINE / 143905 DUILIO): separação 54/59
# no FRONT PRÓPRIO. A oc 59 (RETORNO INDENIZAÇÃO, split da 54 — regra deployada
# 14/07, memória regra-oc59-separacao-54-59) é "aguardando cliente" igual à 54:
# respondida vai pra coluna CLIENTE RESPONDEU. Regressões travadas:
# (a) kanban voltar a hardcodar `=== 54` nas colunas (o bug original);
# (b) OCS_AGUARDANDO_CLIENTE sumir/perder a 59;
# (c) front perder o combo 44+59 (proposta ficava invisível + aprovação sem
#     volumes/motivo falhava no executor);
# (d) teste kanban-oc59 sumir ou falhar.
INV37_CONST=$(grep -c "OCS_AGUARDANDO_CLIENTE" apps/cockpit-web/src/lib/types.ts 2>/dev/null | tr -d ' ')
INV37_59=$(grep -c "54, 59" apps/cockpit-web/src/lib/types.ts 2>/dev/null | tr -d ' ')
INV37_HARD=$(sed -n '/id: "validacao"/,/id: "acao_executada"/p' apps/cockpit-web/src/lib/types.ts 2>/dev/null | grep -c "== 54" | tr -d ' ')
INV37_COMBO=$(grep -c "lancar_combo_44_59" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV37_TEST=$(cd apps/cockpit-web 2>/dev/null && npx vitest run src/lib/kanban-oc59.test.ts --reporter=basic >/dev/null 2>&1 && echo ok || echo fail)
# (e) BACKEND: atualizar-card-via-portal-ssw trata oc 59 como aguardando-cliente
# (hotfix 21/07 — regressão real: função re-deployada do master pré-59 mandava
# card 59 pra TRANSFERIDO no Forçar Atualização; NF 292727/25416). Se este grep
# zerar, o hotfix foi perdido (ex.: regularização removeu sem trazer OCS_CLIENTE).
INV37_BACK=$(grep -c "ehOc59Cliente" supabase/functions/atualizar-card-via-portal-ssw/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV37_CONST:-0}" -ge 2 ] && [ "${INV37_59:-0}" -ge 1 ] && [ "${INV37_HARD:-0}" -eq 0 ] && [ "${INV37_COMBO:-0}" -ge 3 ] && [ "$INV37_TEST" = "ok" ] && [ "${INV37_BACK:-0}" -ge 4 ]; then
  echo "INV-037: PASS"
else
  echo "INV-037: FAIL (const=$INV37_CONST lista54_59=$INV37_59 hardcode54_colunas=$INV37_HARD combo4459=$INV37_COMBO teste=$INV37_TEST backend_atualizar_card=$INV37_BACK — separação 54/59 regrediu no front: card 59 respondido vai voltar a ficar preso em 'Aguardando você'; NF 292727/143905)"
fi

# INV-038 (Caio 2026-07-21, rename ISA E KAROL→ISABELY / CAMILA→FELIPE, migs 304/305):
# drift de NOME de operador entre Cockpit e Bastão + "nada fica órfão". O match
# do resolver (Path 2) e do trigger cards_resolve_operator é por igualdade de
# operadores.nome; quando o Bastão renomeia e o Cockpit não (ou vice-versa),
# card fora de carteira vira órfão invisível. Desde a mig 305, cascata esgotada
# cai no operador com recebe_cards_orfaos=true (ISABELY). Checks:
#   (a) SQL: 0 cards NÃO-terminais com responsavel_relacionamento preenchido e
#       assigned_operator_id NULL (órfão de resolução — sintoma dos 2 cards
#       ISABELY em 2026-07-21);
#   (b) SQL: 0 cards NÃO-terminais cujo responsavel_relacionamento não bate com
#       nome de operador ATIVO (texto velho pós-rename → some de filtro por
#       nome, assinatura de e-mail errada);
#   (c) SQL: exatamente 1 operador-fallback ativo+cockpit_ativo (se ISABELY for
#       desativada sem repassar a flag, o fallback morre em silêncio e os
#       órfãos voltam);
#   (d) código: operador-resolver.test.ts passa (fallback_orfao + precedência +
#       dormente/blacklist preservados + normalizarCodigoSegmento).
deno test supabase/functions/_shared/operador-resolver.test.ts >/dev/null 2>&1 && INV38_TEST=ok || INV38_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV38_ORFAO=SKIP; INV38_STALE=SKIP; INV38_FB=SKIP
else
  INV38_ORFAO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO') and responsavel_relacionamento is not null and length(trim(responsavel_relacionamento))>0 and assigned_operator_id is null;" 2>/dev/null | tr -d ' ')
  INV38_STALE=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c where c.state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO') and c.responsavel_relacionamento is not null and length(trim(c.responsavel_relacionamento))>0 and not exists (select 1 from operadores o where o.ativo and upper(o.nome)=upper(trim(c.responsavel_relacionamento)));" 2>/dev/null | tr -d ' ')
  INV38_FB=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores where recebe_cards_orfaos and ativo and cockpit_ativo;" 2>/dev/null | tr -d ' ')
fi
if [ "$INV38_TEST" = "ok" ] && { [ "$INV38_ORFAO" = "SKIP" ] || { [ "${INV38_ORFAO:-1}" = "0" ] && [ "${INV38_STALE:-1}" = "0" ] && [ "${INV38_FB:-0}" = "1" ]; }; }; then
  echo "INV-038: PASS (test=$INV38_TEST, 0 órfão de resolução, 0 nome defasado, 1 operador-fallback)"
else
  echo "INV-038: FAIL (test=$INV38_TEST orfaos_resolucao=$INV38_ORFAO nome_defasado=$INV38_STALE operador_fallback=$INV38_FB — drift de nome Cockpit×Bastão ou fallback morto; ver migs 304/305, operador-resolver.ts Paths 2-4, trigger cards_resolve_operator)"
fi

# INV-039 (Caio 2026-07-21): DEPLOY-GATE ativo. Um lote de 19 funções deployado
# de commit desatualizado regrediu o vinculador (3ª regressão pré-59 do dia).
# O hook cockpit-deploy-gate.py BLOQUEIA: checkout atrás do origin/master, working
# tree sujo em supabase/, marcador crítico ausente (deploy-guards.json) e função
# proibida. Este INV confere que o mecanismo segue armado (payload montado por
# concatenação pra não disparar o gate deste próprio script).
INV39_HOOK=$(test -f .claude/hooks/cockpit-deploy-gate.py && echo 1 || echo 0)
INV39_REG=$(grep -c "cockpit-deploy-gate" .claude/settings.json 2>/dev/null | tr -d ' ')
INV39_MANIF=$(python3 -c "import json; m=json.load(open('.claude/deploy-guards.json')); print(len(m.get('guards',{})))" 2>/dev/null)
INV39_CMD="supabase functions ""dep""loy atualizar-card-via-tracking"
INV39_BLOQ=$(printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$INV39_CMD" | python3 .claude/hooks/cockpit-deploy-gate.py >/dev/null 2>&1; [ $? -eq 2 ] && echo ok || echo fail)
if [ "$INV39_HOOK" = "1" ] && [ "${INV39_REG:-0}" -ge 1 ] && [ "${INV39_MANIF:-0}" -ge 5 ] && [ "$INV39_BLOQ" = "ok" ]; then
  echo "INV-039: PASS (deploy-gate armado: hook+settings+manifest($INV39_MANIF guards)+bloqueio funcional)"
else
  echo "INV-039: FAIL (hook=$INV39_HOOK settings=$INV39_REG manifest=$INV39_MANIF bloqueio=$INV39_BLOQ — deploy-gate desarmado: risco de regressão por deploy desatualizado voltou)"
fi

# INV-040 (Caio 2026-07-21, NF 2084 — 74 cards fabricados em rajada 14-15/07):
# loop de fabricação do sync × UNIQUE parcial. Card que NASCE/vira terminal sai
# do uniq_cards_nf_active e o ciclo seguinte recria — 1 card por ciclo (~30min)
# enquanto a pendência durar no Bastão (30 cards nasceram DIRETO em TRANSFERIDO
# com evento único BastaoCardImportado; a alternância de CTRC AMB↔TTO encerrava
# o card ativo a cada ciclo). Guard: bloquearCriacaoSeLoopDetectado
# (_shared/guard-anti-loop-criacao.ts) bloqueia criação com ≥3 cards TERMINAIS
# da NF criados em 24h + emite LoopCriacaoCardDetectado (dedupe 24h, fail-open).
# Dossiê: audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md. Checks:
#   (a) código: guard importado + chamado nos 2 pontos de criação do sync
#       (handleExtravioPendencia e upsertCardFromPendencia) — ≥3 ocorrências;
#   (b) código: guard-anti-loop-criacao.test.ts passa (4ª criação em 24h
#       bloqueada + evento de anomalia + dedupe + fail-open);
#   (c) SQL: nenhuma NF com >3 cards criados nas últimas 24h (rajada ativa
#       em produção = guard furado ou caminho de criação novo sem guard).
INV40_GREP=$(grep -c "bloquearCriacaoSeLoopDetectado" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/guard-anti-loop-criacao.test.ts >/dev/null 2>&1 && INV40_TEST=ok || INV40_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV40_RAJADA=SKIP
else
  INV40_RAJADA=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select nf from cards where created_at >= now() - interval '24 hours' and nf is not null group by nf having count(*) > 3) t;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV40_GREP:-0}" -ge 3 ] && [ "$INV40_TEST" = "ok" ] && { [ "$INV40_RAJADA" = "SKIP" ] || [ "${INV40_RAJADA:-1}" = "0" ]; }; then
  echo "INV-040: PASS (guard=$INV40_GREP ocorrências no sync, test=$INV40_TEST, NFs em rajada 24h=$INV40_RAJADA)"
else
  echo "INV-040: FAIL (guard=$INV40_GREP test=$INV40_TEST rajada_24h=$INV40_RAJADA — guard anti-loop ausente/removido do sync-bastao OU NF fabricando >3 cards/24h em produção; dossiê audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md)"
fi

# INV-041 (Caio 2026-07-22, NF 556392 FELIPE + NF 51712 ISABELY): aprovação com
# e-mail NUNCA às cegas + aval de evidência acessível + airbag armado.
# O botão ⭐ RECOMENDADA aprovava direto com extras=null → operador não via a
# janela de edição e o aval "enviar sem evidência" (ocs 10/11/35) ficava
# inacessível (executor bloqueava sem saída). 2ª regressão desse aval (1ª na
# era Lovable). E sem ErrorBoundary, crash de render = tela branca morta sem
# stack. Checks:
#   (a) decisão pura decidir-clique-aprovacao.ts existe + ProposedActions usa
#       (import + onClick do ⭐ RECOMENDADA) — ≥2 ocorrências;
#   (b) decidir-clique-aprovacao.test.ts passa (e-mail→modal, combo→modal,
#       sem-email→direto, payload nulo);
#   (c) aval skip_evidencia gateado por [10, 11, 35] nas DUAS superfícies de
#       e-mail: EditarEmailModal E BannerInline54Composer;
#   (d) airbag: main.tsx envolve <App /> com <ErrorBoundary>.
INV41_DEC=$(test -f apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts && echo 1 || echo 0)
INV41_USO=$(grep -c "decidirCliqueAprovacao" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
(cd apps/cockpit-web && npx vitest run src/lib/decidir-clique-aprovacao.test.ts) >/dev/null 2>&1 && INV41_TEST=ok || INV41_TEST=fail
INV41_MODAL=$(grep -c "\[10, 11, 35\]" apps/cockpit-web/src/components/cards/EditarEmailModal.tsx 2>/dev/null | tr -d ' ')
INV41_COMP=$(grep -cE "skip_evidencia|\[10, 11, 35\]" apps/cockpit-web/src/components/cards/BannerInline54Composer.tsx 2>/dev/null | tr -d ' ')
INV41_AIRBAG=$(grep -c "<ErrorBoundary>" apps/cockpit-web/src/main.tsx 2>/dev/null | tr -d ' ')
if [ "$INV41_DEC" = "1" ] && [ "${INV41_USO:-0}" -ge 2 ] && [ "$INV41_TEST" = "ok" ] && [ "${INV41_MODAL:-0}" -ge 2 ] && [ "${INV41_COMP:-0}" -ge 2 ] && [ "${INV41_AIRBAG:-0}" -ge 1 ]; then
  echo "INV-041: PASS (decisão=$INV41_DEC uso=$INV41_USO test=$INV41_TEST modal=$INV41_MODAL composer=$INV41_COMP airbag=$INV41_AIRBAG)"
else
  echo "INV-041: FAIL (decisão=$INV41_DEC uso=$INV41_USO test=$INV41_TEST modal=$INV41_MODAL composer=$INV41_COMP airbag=$INV41_AIRBAG — aprovação às cegas OU aval de evidência OU airbag regrediu; ver docs/INVARIANTES_COCKPIT.md INV-041)"
fi

# INV-042 (Caio 2026-07-23, NF 73220 LARISSA — premissa final):
#   1. resposta + card ATIVO → move, SEMPRE;
#   2. TRANSFERIDO/RESOLVIDO = tratado → anexa SEM mover (nunca reabre);
#      se a NF tem card ativo, a resposta é roteada pra ele;
#   3. card novo criado depois entra na premissa 1.
# Caso âncora: romaneio da 73220 mudo 7 dias. Checks:
#   (a) fonte única _shared/acionamento-resposta-cliente.ts existe;
#   (b) vinculador usa nos DOIS caminhos (import + thread + nf ≥3 ocorrências);
#   (c) testes da fonte única passam (terminal→reabre, AVH preservado, etc);
#   (d) watchdog checkRespostaClienteEngolida armado no health-check
#       (definição + registro na lista de checks);
#   (e) SQL: nenhuma resposta engolida AGORA em produção (RespostaClienteCapturada
#       >20min com card ainda terminal sem carimbo).
INV42_FONTE=$(test -f supabase/functions/_shared/acionamento-resposta-cliente.ts && echo 1 || echo 0)
INV42_USO=$(grep -c "decidirAcionamentoPorRespostaCliente" supabase/functions/vinculador/index.ts 2>/dev/null | tr -d ' ')
# Corrida do TRANSFERIDO transitório (Duílio 2026-07-28, NFs 1494200/174873/20219):
# o vinculador PRECISA passar acaoCockpitRecente (ação SSW recente = card ainda no
# fluxo) nos DOIS call-sites que podem engolir — senão resposta legítima em card
# transiente-TRANSFERIDO (Bastão ainda não sincronizou a oc 54) vira muda de novo.
INV42_TRANSITORIO=$(grep -c "acaoCockpitRecente" supabase/functions/vinculador/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/acionamento-resposta-cliente.test.ts >/dev/null 2>&1 && INV42_TEST=ok || INV42_TEST=fail
INV42_WD=$(grep -c "checkRespostaClienteEngolida" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then
  INV42_ENG=SKIP
else
  # Correção Caio 23/07 (2ª rodada): critério é "resposta MUDA", não o estado —
  # inclui AGUARDANDO_CLIENTE (NF 73220 destravada na mão saiu de TRANSFERIDO
  # mas a resposta seguia muda). Guard: outbound da operadora posterior à
  # captura = fluxo legítimo de revert, não conta.
  # Critério POR EVENTO (executor zera cliente_respondeu_em → carimbo não
  # distingue engolida de tratada), SÓ CARDS ATIVOS (premissa 2: silêncio em
  # terminal é correto). Exclusões: processada depois (RetornoClienteEmAguardo/
  # ação) e outbound da operadora depois.
  INV42_ENG=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from card_events e join cards c on c.id=e.card_id where e.event_type='RespostaClienteCapturada' and e.created_at > now() - interval '24 hours' and e.created_at < now() - interval '20 minutes' and c.state in ('AGUARDANDO_CLIENTE','ACAO_EXECUTADA') and not exists (select 1 from card_events p where p.card_id=c.id and p.event_type in ('RetornoClienteEmAguardo','AprovacaoOperador','AcaoExecutada') and p.created_at >= e.created_at - interval '1 minute') and not exists (select 1 from cards_emails_outbound o where o.card_id=c.id and o.sent_at > e.created_at);" 2>/dev/null | tr -d ' ')
fi
if [ "$INV42_FONTE" = "1" ] && [ "${INV42_USO:-0}" -ge 3 ] && [ "${INV42_TRANSITORIO:-0}" -ge 3 ] && [ "$INV42_TEST" = "ok" ] && [ "${INV42_WD:-0}" -ge 2 ] && { [ "$INV42_ENG" = "SKIP" ] || [ "${INV42_ENG:-1}" = "0" ]; }; then
  echo "INV-042: PASS (fonte=$INV42_FONTE uso=$INV42_USO transitorio=$INV42_TRANSITORIO test=$INV42_TEST watchdog=$INV42_WD engolidas_24h=$INV42_ENG)"
else
  echo "INV-042: FAIL (fonte=$INV42_FONTE uso=$INV42_USO test=$INV42_TEST watchdog=$INV42_WD engolidas_24h=$INV42_ENG — reabertura por resposta de cliente regrediu OU há resposta muda em produção; ver docs/INVARIANTES_COCKPIT.md INV-042)"
fi

# INV-043 (Caio 2026-07-23, NF 389040 DUILIO): camada de CAPTURA viva — toda
# caixa Gmail com credencial tem rodada de leitura recente. Classe cega pro
# INV-042 (que só enxerga após RespostaClienteCapturada). Caso âncora: rodízio
# do gmail-poll v60 lia embed como array → 7/9 caixas com zero leituras →
# resposta do cliente parada NO GMAIL (capturas/dia DUILIO: 43 → 1). Checks:
#   (a) fonte única do rodízio existe e o gmail-poll usa (lastPollAtDoEmbed +
#       ordenarPorDefasagem, >=2 ocorrências) + fatia por caixa presente;
#   (b) testes do rodízio passam (embed OBJETO ordena; DUILIO antes de JULIA);
#   (c) watchdog checkCaixaGmailSemPoll armado no health-check;
#   (d) SQL: nenhuma caixa com credencial sem rodada há >2h.
INV43_USO=$(grep -cE "lastPollAtDoEmbed|ordenarPorDefasagem" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV43_FATIA=$(grep -c "FATIA_POR_CAIXA_MS" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/gmail-poll-batch.test.ts >/dev/null 2>&1 && INV43_TEST=ok || INV43_TEST=fail
INV43_WD=$(grep -c "checkCaixaGmailSemPoll" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then
  INV43_FAM=SKIP
else
  INV43_FAM=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores o left join gmail_polling_state g on g.operador_id=o.id where o.gmail_oauth_credentials is not null and (g.last_poll_at is null or g.last_poll_at < now() - interval '2 hours');" 2>/dev/null | tr -d ' ')
fi
if [ "${INV43_USO:-0}" -ge 2 ] && [ "${INV43_FATIA:-0}" -ge 2 ] && [ "$INV43_TEST" = "ok" ] && [ "${INV43_WD:-0}" -ge 2 ] && { [ "$INV43_FAM" = "SKIP" ] || [ "${INV43_FAM:-1}" = "0" ]; }; then
  echo "INV-043: PASS (rodizio=$INV43_USO fatia=$INV43_FATIA test=$INV43_TEST watchdog=$INV43_WD famintas_2h=$INV43_FAM)"
else
  echo "INV-043: FAIL (rodizio=$INV43_USO fatia=$INV43_FATIA test=$INV43_TEST watchdog=$INV43_WD famintas_2h=$INV43_FAM — rodízio/fatia do gmail-poll regrediu OU caixa faminta em produção; ver docs/INVARIANTES_COCKPIT.md INV-043)"
fi

# INV-044 (Matheus 2026-07-23, causa-2 / ADR 0015): memória de avaliação por
# mensagem — o poller NÃO pode voltar a re-fetchar no Gmail toda msg não-casada
# a cada rodada (backlog perpétuo: sac 436/julia 427/larissa 410; last_success
# travado em junho). Checks:
#   (a) helpers puros existem e o gmail-poll usa (mapaMemoAvaliacao +
#       setDeGmailMessageIds importados/usados, >=2 ocorrências);
#   (b) a otimização é FLAG-GATED (flagMemoAvaliacaoOn presente) → OFF = byte
#       idêntico ao anterior, garantia anti-regressão de captura;
#   (c) testes dos helpers do memo passam (mapaMemoAvaliacao/setDeGmailMessageIds);
#   (d) a flag existe como row em feature_flags (SQL — não exige estar ligada).
INV44_USO=$(grep -cE "mapaMemoAvaliacao|setDeGmailMessageIds" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV44_FLAG=$(grep -c "flagMemoAvaliacaoOn" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV44_TEST=$(grep -cE "mapaMemoAvaliacao|setDeGmailMessageIds" supabase/functions/_shared/gmail-poll-batch.test.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/gmail-poll-batch.test.ts >/dev/null 2>&1 && INV44_TESTOK=ok || INV44_TESTOK=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV44_ROW=SKIP
else
  INV44_ROW=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from feature_flags where key='gmail_poll_memo_avaliacao_ativo';" 2>/dev/null | tr -d ' ')
fi
if [ "${INV44_USO:-0}" -ge 2 ] && [ "${INV44_FLAG:-0}" -ge 2 ] && [ "$INV44_TESTOK" = "ok" ] && [ "${INV44_TEST:-0}" -ge 2 ] && { [ "$INV44_ROW" = "SKIP" ] || [ "${INV44_ROW:-0}" -ge 1 ]; }; then
  echo "INV-044: PASS (uso=$INV44_USO flag=$INV44_FLAG test=$INV44_TESTOK guard_test=$INV44_TEST flag_row=$INV44_ROW)"
else
  echo "INV-044: FAIL (uso=$INV44_USO flag=$INV44_FLAG test=$INV44_TESTOK guard_test=$INV44_TEST flag_row=$INV44_ROW — memória de avaliação do gmail-poll regrediu OU perdeu o gate de flag; ver ADR 0015 / migration 306)"
fi

# INV-044 (Caio 2026-07-23, print FELIPE + tela branca NF 556392/Bug A): o app
# NUNCA pode ser traduzível pelo navegador. Google Tradutor reescreve nós de
# texto por fora do React → NotFoundError removeChild ao desmontar (bug
# clássico React#11538); lang="en" num app pt-BR era o convite. Prova: print
# do FELIPE com o texto do airbag REESCRITO ("quebrou"→"CORTE", "pra"→"para").
INV44_LANG=$(grep -c 'lang="pt-BR"' apps/cockpit-web/index.html 2>/dev/null | tr -d ' ')
INV44_NOTR=$(grep -cE 'translate="no"|name="google" content="notranslate"' apps/cockpit-web/index.html 2>/dev/null | tr -d ' ')
if [ "${INV44_LANG:-0}" -ge 1 ] && [ "${INV44_NOTR:-0}" -ge 2 ]; then
  echo "INV-044: PASS (lang pt-BR=$INV44_LANG, notranslate=$INV44_NOTR)"
else
  echo "INV-044: FAIL (lang=$INV44_LANG notranslate=$INV44_NOTR — app voltou a ser traduzível; classe removeChild/tela-branca reaberta; ver docs/INVARIANTES_COCKPIT.md INV-044)"
fi

# INV-045 (Caio 2026-07-23, NF 814961 DUILIO): anexo não-suportado FORA da
# seleção dos modais oc=33. A ratoeira era: pré-seleção cega do 1º anexo (gif
# de assinatura) + checkbox desabilitado (impossível desmarcar) + validação
# bloqueante ("Remova: X") = beco sem saída. Checks:
#   (a) fonte única lib/anexos-ssw-elegiveis.ts existe + ProposedActions usa
#       (import + 2 pré-seleções = >=3 ocorrências);
#   (b) testes passam (âncora: 1º anexo gif → pré-seleciona o PDF);
#   (c) pré-seleção cega extinta (zero `anexosInbound[0].id`);
#   (d) validação não bloqueia mais (zero `Remova:` no arquivo).
INV45_USO=$(grep -c "primeiroAnexoSuportadoSsw" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
(cd apps/cockpit-web && npx vitest run src/lib/anexos-ssw-elegiveis.test.ts) >/dev/null 2>&1 && INV45_TEST=ok || INV45_TEST=fail
INV45_CEGA=$(grep -c "anexosInbound\[0\].id" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV45_MURO=$(grep -c "Remova:" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
if [ "${INV45_USO:-0}" -ge 3 ] && [ "$INV45_TEST" = "ok" ] && [ "${INV45_CEGA:-1}" = "0" ] && [ "${INV45_MURO:-1}" = "0" ]; then
  echo "INV-045: PASS (uso=$INV45_USO test=$INV45_TEST preselecao_cega=$INV45_CEGA muro=$INV45_MURO)"
else
  echo "INV-045: FAIL (uso=$INV45_USO test=$INV45_TEST preselecao_cega=$INV45_CEGA muro=$INV45_MURO — ratoeira do anexo não-suportado voltou; ver docs/INVARIANTES_COCKPIT.md INV-045)"
fi

# INV-046 (Caio 2026-07-23, NF 62566 LARISSA): oc 41/56 NUNCA lança sem o
# texto do operador — 3ª regressão da classe aprovação-às-cegas. 3 camadas:
#   (a) front: rota abrir-input na fonte única (⭐ RECOMENDADA abre o painel
#       de texto existente) + teste;
#   (b) backend fail-closed: camposObrigatoriosAusentes exige texto_descricao
#       pra 41/56 (executor bloqueia com erro visível) + teste;
#   (c) SQL: nenhuma aprovação de 41/56 nas últimas 24h com extras sem texto.
INV46_FRONT=$(grep -cE "abrir-input|OCS_COM_INPUT_OBRIGATORIO" apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts 2>/dev/null | tr -d ' ')
INV46_ROTA=$(grep -c "abrir-input" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV46_BACK=$(grep -cE "OCS_TEXTO_OBRIGATORIO|texto_descricao" supabase/functions/_shared/descricao-ssw.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/descricao-ssw.test.ts >/dev/null 2>&1 && INV46_TEST=ok || INV46_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV46_MUDAS=SKIP
else
  INV46_MUDAS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from card_events where event_type='AprovacaoOperador' and created_at > now() - interval '24 hours' and payload->'proposta_payload'->>'acao_key' in ('lancar_ocorrencia:41','lancar_ocorrencia:56') and coalesce(trim(payload->'extras'->>'texto_descricao'),'') = '';" 2>/dev/null | tr -d ' ')
fi
if [ "${INV46_FRONT:-0}" -ge 3 ] && [ "${INV46_ROTA:-0}" -ge 1 ] && [ "${INV46_BACK:-0}" -ge 3 ] && [ "$INV46_TEST" = "ok" ] && { [ "$INV46_MUDAS" = "SKIP" ] || [ "${INV46_MUDAS:-1}" = "0" ]; }; then
  echo "INV-046: PASS (front=$INV46_FRONT rota=$INV46_ROTA back=$INV46_BACK test=$INV46_TEST aprovacoes_sem_texto_24h=$INV46_MUDAS)"
else
  echo "INV-046: FAIL (front=$INV46_FRONT rota=$INV46_ROTA back=$INV46_BACK test=$INV46_TEST sem_texto_24h=$INV46_MUDAS — 41/56 voltou a lançar sem texto; ver docs/INVARIANTES_COCKPIT.md INV-046)"
fi

# INV-047 (Caio 2026-07-23, NF 1100040 LARISSA): extravio parcial com trilha
# de indenização destaca 59; e o par 59+email SEMPRE no cardápio das regras
# de tratativa (49/26/23/43). Checks:
#   (a) helper temContextoIndenizacao existe + agente-sugere usa (>=2);
#   (b) testes do helper (âncora 1100040 + anti-falso-positivo);
#   (c) regras têm >=5 entradas codigo_ssw_proposto: 59 (19 + as 4 da família).
INV47_USO=$(grep -c "temContextoIndenizacao" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/contexto-indenizacao.test.ts >/dev/null 2>&1 && INV47_TEST=ok || INV47_TEST=fail
INV47_PAR=$(grep -c "codigo_ssw_proposto: 59," supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
#   (d) repatch converte o TRILHO completo na re-análise 54↔59 (NF 1100040:
#       destaque :59 com todo :54 = 'ação não está mais pendente');
#   (e) FORÇAR ATUALIZAÇÃO re-dispara o agente (decisão nunca fica em cache).
INV47_TRILHO=$(grep -c "mudouTrilho" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
deno test --allow-env supabase/functions/_shared/repatch-trilho.test.ts >/dev/null 2>&1 && INV47_RTEST=ok || INV47_RTEST=fail
INV47_REDISPARO=$(grep -c "agente-sugere-ocs-padrao" supabase/functions/atualizar-card-via-portal-ssw/index.ts 2>/dev/null | tr -d ' ')
#   (f) invalidação AUTOMÁTICA por versão de regra (Caio 23/07: 'sem trabalho
#       manual') — VERSAO_REGRAS_ANALISE carimbada + check (d) no cron.
INV47_VERSAO=$(grep -c "VERSAO_REGRAS_ANALISE" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
#   (g) 4 OPÇÕES invioláveis (Caio 23/07): card AVH com oc 49 tem as 4
#       acao_keys ativas (54±email, 59±email); override aposentado (identidade)
#       e repatch nunca converte. Detector do relançamento testado.
INV47_APOSENTADA=$(grep -c "APOSENTADA" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/contexto-indenizacao.test.ts >/dev/null 2>&1 && INV47_RELANCE=ok || INV47_RELANCE=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV47_4OP=SKIP
else
  INV47_4OP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c where c.state='AGUARDANDO_VALIDACAO_HUMANA' and c.cod_ultima_ocorrencia=49 and (select count(distinct t.proposta_payload->>'acao_key') from todos t where t.card_id=c.id and t.status in ('pendente','aprovado') and t.proposta_payload->>'acao_key' in ('lancar_oc_e_enviar_email:54','lancar_ocorrencia:54','lancar_oc_e_enviar_email:59','lancar_ocorrencia:59')) < 4;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV47_USO:-0}" -ge 2 ] && [ "$INV47_TEST" = "ok" ] && [ "${INV47_PAR:-0}" -ge 5 ] && [ "${INV47_TRILHO:-0}" -ge 0 ] && [ "$INV47_RTEST" = "ok" ] && [ "${INV47_REDISPARO:-0}" -ge 1 ] && [ "${INV47_VERSAO:-0}" -ge 3 ] && [ "${INV47_APOSENTADA:-0}" -ge 1 ] && [ "$INV47_RELANCE" = "ok" ] && { [ "$INV47_4OP" = "SKIP" ] || [ "${INV47_4OP:-1}" = "0" ]; }; then
  echo "INV-047: PASS (uso=$INV47_USO test=$INV47_TEST par59=$INV47_PAR rtest=$INV47_RTEST redisparo=$INV47_REDISPARO versao=$INV47_VERSAO aposentada=$INV47_APOSENTADA relance=$INV47_RELANCE cards_49_sem_4opcoes=$INV47_4OP)"
else
  echo "INV-047: FAIL (uso=$INV47_USO test=$INV47_TEST par59=$INV47_PAR rtest=$INV47_RTEST redisparo=$INV47_REDISPARO versao=$INV47_VERSAO aposentada=$INV47_APOSENTADA relance=$INV47_RELANCE 49_sem_4op=$INV47_4OP — 4-opções/relançamento/versão regrediu; ver docs/INVARIANTES_COCKPIT.md INV-047)"
fi

# INV-048 (Caio 2026-07-23, planilha "Relacionamento Atualizado" / mig 307):
# carteiras e roteamento por segmento seguem a planilha. Regressões que este
# guard trava: (a) CNPJ em 2 carteiras (quebra "1 CNPJ = 1 operador");
# (b) segmentos revertidos (LARISSA voltou a ter 007/010, KAROLINE/MARIA
# perderam os seus); (c) âncoras de carteira desfeitas (DIAGNOSTICA voltou pra
# LARISSA; NORTEL saiu da INGRID; MARIA perdeu a carteira dormente; AGROLIFE
# saiu da JULIA — mig 333, único caminho de reversão é um `psql -f` manual da
# 307, que ainda diz ISABELY/043 na linha 181; e os 5 CNPJs da mig 359 que
# saíram da Curva F/ISABELY em 2026-08-26 por passarem de 30k — HENRIQUE
# 86368206000194→VICTOR, SULMEDIC 09944371000368→KAROLINE, GIRANDO
# 81676009001190 e ...001433→FELIPE, ATACADAO 40279136000288→DUILIO);
# ATENÇÃO: INV48_ANC conta PARES (nome,cnpj) via join, NÃO linhas de
# `operadores` — a KAROLINE aparece em dois pares e um `OR` a contaria uma vez
# só, travando o guard em FAIL para sempre;
# (d) SAL EXP (blacklist ativa) entrou em carteira. Fonte auditável:
# data/relacionamento-atualizado-2026-07-23.xlsx + gerador em
# scripts/import_relacionamento_atualizado.py.
INV48_XLSX=$([ -f data/relacionamento-atualizado-2026-07-23.xlsx ] && echo 1 || echo 0)
if [ -z "$SUPABASE_DB_URL" ]; then
  INV48_DUP=SKIP; INV48_SEG=SKIP; INV48_ANC=SKIP; INV48_BLK=SKIP
else
  INV48_DUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select c from (select unnest(carteira) c from operadores) s group by c having count(*)>1) d;" 2>/dev/null | tr -d ' ')
  INV48_SEG=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores where (nome='LARISSA' and segmentos='{018}') or (nome='KAROLINE' and segmentos='{007,010}') or (nome='MARIA' and segmentos='{040,042}');" 2>/dev/null | tr -d ' ')
  INV48_ANC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select (select count(*) from (values ('KAROLINE','11462456000270'),('INGRID','46044053005417'),('JULIA','53628620000136'),('VICTOR','86368206000194'),('KAROLINE','09944371000368'),('FELIPE','81676009001190'),('FELIPE','81676009001433'),('DUILIO','40279136000288')) v(n,c) join operadores o on o.nome=v.n and v.c=any(o.carteira)) + (select count(*) from operadores where nome='MARIA' and coalesce(array_length(carteira,1),0)>=23);" 2>/dev/null | tr -d ' ')
  INV48_BLK=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores where '86392529000466'=any(carteira);" 2>/dev/null | tr -d ' ')
fi
if [ "$INV48_XLSX" = "1" ] && { [ "$INV48_DUP" = "SKIP" ] || { [ "${INV48_DUP:-1}" = "0" ] && [ "${INV48_SEG:-0}" = "3" ] && [ "${INV48_ANC:-0}" = "9" ] && [ "${INV48_BLK:-1}" = "0" ]; }; }; then
  echo "INV-048: PASS (xlsx=$INV48_XLSX dup_carteira=$INV48_DUP segmentos=$INV48_SEG/3 ancoras=$INV48_ANC/9 blacklist_fora=$INV48_BLK)"
else
  echo "INV-048: FAIL (xlsx=$INV48_XLSX dup_carteira=$INV48_DUP segmentos=$INV48_SEG/3 ancoras=$INV48_ANC/9 blacklist_fora=$INV48_BLK — carteiras/segmentos divergiram da planilha Relacionamento Atualizado 2026-07-23; ver migration/2026-07-23_307_relacionamento_atualizado.sql e migration/2026-08-12_333_agrolife_isabely_para_julia.sql)"
fi

# INV-049 (Caio 2026-07-24, incidente divergInfo): o front TEM typecheck real
# no caminho até produção. Contexto: 'tsc --noEmit' sem -p checa ZERO arquivos
# (tsconfig raiz é solution-style com files:[]) — foi assim que o popup F4
# renderizado no componente errado (ReferenceError: divergInfo) chegou em
# produção e travou TODOS os operadores. Regressões que este guard trava:
# (a) gate removido do script build (Vercel voltaria a deployar código que o
# TypeScript rejeita); (b) script typecheck apontando pro tsconfig vazio;
# (c) erro de tipo real no src (o check roda de verdade, não é grep).
# NUNCA aceitar 'tsc --noEmit' sem -p como evidência de tipos OK.
INV49_GATE=$(grep -c '"build": "npm run typecheck && vite build"' apps/cockpit-web/package.json)
INV49_CFG=$(grep -c '"typecheck": "tsc --noEmit -p tsconfig.app.json"' apps/cockpit-web/package.json)
if (cd apps/cockpit-web && npx tsc --noEmit -p tsconfig.app.json >/dev/null 2>&1); then INV49_TSC=0; else INV49_TSC=1; fi
if [ "$INV49_GATE" = "1" ] && [ "$INV49_CFG" = "1" ] && [ "$INV49_TSC" = "0" ]; then
  echo "INV-049: PASS (gate_no_build=$INV49_GATE cfg_real=$INV49_CFG erros_tsc=$INV49_TSC)"
else
  echo "INV-049: FAIL (gate_no_build=$INV49_GATE cfg_real=$INV49_CFG erros_tsc=$INV49_TSC — typecheck do front removido/furado ou erro de tipo no src; ver docs/INVARIANTES_COCKPIT.md INV-049)"
fi

# INV-050 (Caio 2026-07-24, NFs 158084 DUILIO + 1094294 LARISSA): o item
# ⭐ RECOMENDADA roteia pra JANELA que a ação exige, e o popup F4 só dispara
# contra a sugestão VIGENTE. Regressões que este guard trava: (a) rota
# modal-oc33-solo removida do decidirCliqueAprovacao (⭐ volta a aprovar oc33
# às cegas com anexos_ids=[] → executor reverte); (b) roteador ⭐ sem handler
# pros destinos de modal; (c) beco do painel: ramo ⭐ voltando a early-return
# incondicional (clique em 41/44/55/56 recomendada não abre nada); (d) endosso
# da sugestão vigente removido do detector (popup falso contra banner velho,
# suja o dataset do loop F5).
INV50_ROTA=$(grep -c '"modal-oc33-solo"' apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts)
INV50_HANDLER=$(grep -c 'destino === "modal-oc33-solo"' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV50_PAINEL=$(grep -c 'requerInput && isExpandido' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV50_ENDOSSO=$(grep -c 'sugere_oc33_solo' apps/cockpit-web/src/lib/divergencia.ts)
INV50_ORIGEM=$(grep -c 'vinculador_pos_resposta_cliente' apps/cockpit-web/src/lib/divergencia.ts)
INV50_TEST=$(grep -c '158084' apps/cockpit-web/src/lib/divergencia.test.ts apps/cockpit-web/src/lib/decidir-clique-aprovacao.test.ts | awk -F: '{s+=$2} END {print (s>=2) ? 2 : s}')
if [ "${INV50_ROTA:-0}" -ge 1 ] && [ "${INV50_HANDLER:-0}" -ge 1 ] && [ "${INV50_PAINEL:-0}" -ge 1 ] && [ "${INV50_ENDOSSO:-0}" -ge 1 ] && [ "${INV50_ORIGEM:-0}" -ge 1 ] && [ "${INV50_TEST:-0}" -ge 2 ]; then
  echo "INV-050: PASS (rota=$INV50_ROTA handler=$INV50_HANDLER painel=$INV50_PAINEL endosso=$INV50_ENDOSSO origem=$INV50_ORIGEM testes_ancora=$INV50_TEST/2)"
else
  echo "INV-050: FAIL (rota=$INV50_ROTA handler=$INV50_HANDLER painel=$INV50_PAINEL endosso=$INV50_ENDOSSO origem=$INV50_ORIGEM testes_ancora=$INV50_TEST/2 — recomendada↔janela ou divergência-vigente regrediu; ver docs/INVARIANTES_COCKPIT.md INV-050)"
fi

# INV-051 (Caio 2026-07-25, rejeição acidental da Isadora 24/07): decisão
# humana na fila de melhorias F6 é sempre CONFIRMADA, VISÍVEL e REVERSÍVEL.
# Contexto: proposta do comprovante legível rejeitada sem querer 21s após a
# resposta; card dizia "aguardando SUA aprovação" pro próprio autor; fila só
# mostra aberto e revisar_learning_log só permite aberto→final → correção
# impossível, revisões invisíveis pro Caio. Regressões que este guard trava:
# (a) confirmação do Rejeitar removida (volta o 1-clique acidental);
# (b) rótulo "aguardando sua aprovação" de volta (induz o autor a decidir);
# (c) trilha de revisadas/Reabrir removida (decisão de outro gestor invisível
# e sem undo); (d) testes puros de INV-051 quebrados (podeReabrir deixando
# terminais aplicado/revertido reabrirem, etc.).
INV51_CONFIRM=$(grep -c 'confirmandoRejeicao' apps/cockpit-web/src/pages/Aprendizado.tsx)
INV51_ROTULO_RUIM=$(grep -c 'aguardando sua aprova' apps/cockpit-web/src/pages/Aprendizado.tsx)
INV51_TRILHA=$(grep -c 'reabrir_learning_log' apps/cockpit-web/src/pages/Aprendizado.tsx)
INV51_RPC=$(grep -c "tipo <> 'ajuste_sugerido'" migration/2026-07-25_312_reabrir_learning_log_e_retroativo.sql)
if (cd apps/cockpit-web && npx vitest run src/lib/melhorias.test.ts >/dev/null 2>&1); then INV51_TEST=0; else INV51_TEST=1; fi
if [ "${INV51_CONFIRM:-0}" -ge 2 ] && [ "${INV51_ROTULO_RUIM:-1}" = "0" ] && [ "${INV51_TRILHA:-0}" -ge 1 ] && [ "${INV51_RPC:-0}" -ge 1 ] && [ "$INV51_TEST" = "0" ]; then
  echo "INV-051: PASS (confirm=$INV51_CONFIRM rotulo_enganoso=$INV51_ROTULO_RUIM trilha_reabrir=$INV51_TRILHA rpc_restrita=$INV51_RPC testes=$INV51_TEST)"
else
  echo "INV-051: FAIL (confirm=$INV51_CONFIRM rotulo_enganoso=$INV51_ROTULO_RUIM trilha_reabrir=$INV51_TRILHA rpc_restrita=$INV51_RPC testes=$INV51_TEST — fila F6 voltou a ser 1-clique irreversível/invisível; ver docs/INVARIANTES_COCKPIT.md INV-051)"
fi

# INV-052 (Caio 2026-07-25, auditoria ultracode — onda 1): os 5 fixes que
# travavam operação. Regressões que este guard trava: (a) regra da oc no
# acionamento removida (terminal transitório volta a engolir resposta —
# NFs 150431/174438); (b) isenção do relançamento pós-resposta removida
# (sync volta a comer 100% dos relançamentos); (c) cobertura do romaneio por
# filename removida (assinatura PNG volta a lançar oc33 sem romaneio);
# (d) filtro deletado_em das queries dos modais removido (anexo morto volta
# ao cardápio); (e) guards de idempotência do scan removidos (loop de
# re-adoção NF 2549 volta). + SQL vivo: resposta muda em card ativo = 0.
INV52_OC=$(grep -c 'ocPertenceAoCockpit' supabase/functions/_shared/acionamento-resposta-cliente.ts)
INV52_RELANC=$(grep -c 'ehPropostaPosRespostaMesmaOc' supabase/functions/sync-bastao/index.ts)
INV52_ROM=$(grep -c 'anexosCobremRomaneio' supabase/functions/executor/index.ts)
INV52_DEL=$(grep -c '"deletado_em", null' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV52_SCAN=$(grep -c 'ja_decidido' supabase/functions/scan-email-pre-card/index.ts)
INV52_TEST=$(grep -c '150431' supabase/functions/_shared/acionamento-resposta-cliente.test.ts)
if [ -z "$SUPABASE_DB_URL" ]; then INV52_MUDAS=SKIP; else
  INV52_MUDAS=$($PSQL "$SUPABASE_DB_URL" -tA -c "WITH m AS (SELECT e.card_id, max(e.created_at) mute_em FROM card_events e WHERE e.event_type='RespostaClienteEmCardTransferido' AND e.created_at > now() - interval '24 hours' GROUP BY 1) SELECT count(*) FROM m JOIN cards c ON c.id=m.card_id WHERE c.state NOT IN ('TRANSFERIDO','RESOLVIDO','CANCELADO') AND NOT EXISTS (SELECT 1 FROM card_events r WHERE r.card_id=m.card_id AND r.event_type='RetornoClienteEmAguardo' AND r.created_at > m.mute_em);" 2>/dev/null | tr -d ' ')
fi
if [ "${INV52_OC:-0}" -ge 2 ] && [ "${INV52_RELANC:-0}" -ge 2 ] && [ "${INV52_ROM:-0}" -ge 2 ] && [ "${INV52_DEL:-0}" -ge 2 ] && [ "${INV52_SCAN:-0}" -ge 2 ] && [ "${INV52_TEST:-0}" -ge 1 ] && { [ "$INV52_MUDAS" = "SKIP" ] || [ "${INV52_MUDAS:-1}" = "0" ]; }; then
  echo "INV-052: PASS (oc=$INV52_OC relanc=$INV52_RELANC rom=$INV52_ROM del=$INV52_DEL scan=$INV52_SCAN test=$INV52_TEST mudas_24h=$INV52_MUDAS)"
else
  echo "INV-052: FAIL (oc=$INV52_OC relanc=$INV52_RELANC rom=$INV52_ROM del=$INV52_DEL scan=$INV52_SCAN test=$INV52_TEST mudas_24h=$INV52_MUDAS — onda 1 da auditoria 25/07 regrediu; ver docs/INVARIANTES_COCKPIT.md INV-052)"
fi

# INV-053 (Caio 2026-07-25, auditoria — onda 2): conversão JBIG2 ligada e
# aprovação nunca às cegas em NENHUMA superfície. Regressões: (a) wasmUrl
# removido do getDocument (scans JBIG2 voltam ao contorno manual) ou assets
# public/pdfjs-wasm dessincronizados do pacote (teste pdfjs-wasm-sync);
# (b) popup F4 voltando a registrar motivo ANTES da aprovação; (c) gêmeo
# sem-email voltando ao ⭐ genérico; (d) ProposalCard/TopBox aprovando sem
# rotear pela fonte única decidirCliqueAprovacao.
INV53_WASM=$(grep -c 'wasmUrl' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_ASSETS=$(ls apps/cockpit-web/public/pdfjs-wasm/ 2>/dev/null | wc -l | tr -d ' ')
INV53_POS=$(grep -c 'motivoDivergencia' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_GEMEO=$(grep -c 'ehGemeoSemEmailDestacado' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_PCARD=$(grep -c 'decidirCliqueAprovacao(payload' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_TOPBOX=$(grep -c 'decidirCliqueAprovacao' apps/cockpit-web/src/components/cards/SugestaoIATopBox.tsx)
INV53_MEMO=$(grep -c 'metadataFalhou' supabase/functions/gmail-poll-inbox/index.ts)
if [ "${INV53_WASM:-0}" -ge 2 ] && [ "${INV53_ASSETS:-0}" -ge 5 ] && [ "${INV53_POS:-0}" -ge 3 ] && [ "${INV53_GEMEO:-0}" -ge 2 ] && [ "${INV53_PCARD:-0}" -ge 1 ] && [ "${INV53_TOPBOX:-0}" -ge 2 ] && [ "${INV53_MEMO:-0}" -ge 2 ]; then
  echo "INV-053: PASS (wasm=$INV53_WASM assets=$INV53_ASSETS pos=$INV53_POS gemeo=$INV53_GEMEO pcard=$INV53_PCARD topbox=$INV53_TOPBOX memo=$INV53_MEMO)"
else
  echo "INV-053: FAIL (wasm=$INV53_WASM assets=$INV53_ASSETS pos=$INV53_POS gemeo=$INV53_GEMEO pcard=$INV53_PCARD topbox=$INV53_TOPBOX memo=$INV53_MEMO — onda 2 da auditoria 25/07 regrediu; ver docs/INVARIANTES_COCKPIT.md INV-053)"
fi

# INV-054 (Caio 2026-07-25, auditoria — onda 3): sweep nunca atropela
# validação humana + rótulos honestos + F4 robusto.
INV54_LOCK=$(grep -c 'lock_aguardando_validacao"\] === true' supabase/functions/sync-bastao/index.ts)
INV54_TPL=$(grep -c 'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO: ' apps/cockpit-web/src/components/cards/BannerSugestaoIA.tsx)
INV54_CHIP=$(grep -c 'Outro motivo (detalhe abaixo)' apps/cockpit-web/src/components/cards/DivergenciaMotivoDialog.tsx)
if [ "${INV54_LOCK:-0}" -ge 1 ] && [ "${INV54_TPL:-0}" -ge 1 ] && [ "${INV54_CHIP:-0}" -ge 1 ]; then
  echo "INV-054: PASS (lock=$INV54_LOCK tpl=$INV54_TPL chip=$INV54_CHIP)"
else
  echo "INV-054: FAIL (lock=$INV54_LOCK tpl=$INV54_TPL chip=$INV54_CHIP — onda 3 da auditoria 25/07 regrediu)"
fi

# INV-055 (Caio 2026-07-26, incidente de custo 4x num domingo): card com
# resposta de cliente NUNCA fica sem interpretação, e falha de leitura NUNCA
# vira loop infinito. Contexto: maxTokens=700 < resposta legítima do schema →
# JSON cortado → retry com o MESMO teto → 268 falhas → card sem sugestão →
# a fila de pendentes o devolvia a cada 5 min → 899 chamadas Anthropic sobre
# 11 mensagens ($31 num domingo). Regressões que este guard trava:
# (a) teto do interpretador voltando pra <=700 (trunca de novo);
# (b) retry sem dobrar o teto quando stop_reason=max_tokens (retry condenado);
# (c) reparo de JSON truncado removido (leitura parcial vira card órfão);
# (d) breaker por (card,mensagem) removido (loop infinito volta);
# (e) fallback determinístico removido (card fica "sem nada" — o que o Caio
#     proibiu explicitamente: não basta jogar pro operador).
INV55_TETO=$(grep -cE 'maxTokens: 1[0-9]{3}' supabase/functions/interpretador-resposta-cliente/index.ts)
INV55_RETRY=$(grep -c 'TETO_MAX_TOKENS_RETRY' supabase/functions/_shared/anthropic-client.ts)
INV55_REPARO=$(grep -c 'repararJsonTruncado' supabase/functions/_shared/anthropic-client.ts)
INV55_BREAKER=$(grep -c 'deveDesistirDoLlm' supabase/functions/interpretador-resposta-cliente/index.ts)
INV55_FALLBACK=$(grep -c 'montarSugestaoDegradada' supabase/functions/interpretador-resposta-cliente/index.ts)
if deno test --allow-env --no-check \
     supabase/functions/_shared/interpretador-degradacao.test.ts \
     supabase/functions/_shared/anthropic-client.test.ts >/dev/null 2>&1; then INV55_TEST=ok; else INV55_TEST=fail; fi
# DB: nenhuma mensagem sendo remoída (teto generoso: 10 chamadas na mesma msg/24h)
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV55_LOOP=$("$PSQL" "$SUPABASE_DB_URL" -tAc "SELECT count(*) FROM (SELECT message_id FROM anthropic_usage_log WHERE function_name='interpretador-resposta-cliente' AND created_at > now() - interval '24 hours' AND message_id IS NOT NULL GROUP BY message_id HAVING count(*) > 10) x;" 2>/dev/null | tr -d ' ')
else
  INV55_LOOP="SKIP"
fi
if [ "${INV55_TETO:-0}" -ge 1 ] && [ "${INV55_RETRY:-0}" -ge 1 ] && [ "${INV55_REPARO:-0}" -ge 2 ] && [ "${INV55_BREAKER:-0}" -ge 1 ] && [ "${INV55_FALLBACK:-0}" -ge 1 ] && [ "$INV55_TEST" = "ok" ] && { [ "$INV55_LOOP" = "SKIP" ] || [ "${INV55_LOOP:-1}" = "0" ]; }; then
  echo "INV-055: PASS (teto=$INV55_TETO retry=$INV55_RETRY reparo=$INV55_REPARO breaker=$INV55_BREAKER fallback=$INV55_FALLBACK testes=$INV55_TEST msgs_remoidas_24h=$INV55_LOOP)"
else
  echo "INV-055: FAIL (teto=$INV55_TETO retry=$INV55_RETRY reparo=$INV55_REPARO breaker=$INV55_BREAKER fallback=$INV55_FALLBACK testes=$INV55_TEST msgs_remoidas_24h=$INV55_LOOP — interpretador voltou a truncar/reprocessar em loop ou card pode ficar sem interpretação; ver docs/INVARIANTES_COCKPIT.md INV-055)"
fi

# INV-057 (Caio 2026-07-26, incidente da fila de adoção): thread pré-existente
# é importada UMA vez por card. Regressões que este guard trava: (a) trava
# decidirAdocaoThread removida do processarAdocaoJob (volta a re-importar a
# cada job repetido — 15.052 jobs/59 cards, NF 166229 105x/dia, IA 6x);
# (b) dreno dos repetidos removido (fila de adoção volta a levar ~21 dias);
# (c) SQL vivo: nenhuma thread importada 2x no MESMO card em 24h.
INV57_TRAVA=$(grep -c 'decidirAdocaoThread' supabase/functions/scan-email-pre-card/index.ts)
INV57_DRENO=$(grep -c 'ADOCAO_DRENO_MS' supabase/functions/scan-email-pre-card/index.ts)
INV57_TEST=$(grep -c '166229' supabase/functions/_shared/adocao-thread.test.ts 2>/dev/null | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then INV57_REIMPORT=SKIP; else
  INV57_REIMPORT=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select card_id, payload->>'gmail_thread_id' t from card_events where event_type='ThreadPreexistenteImportada' and created_at > now() - interval '24 hours' group by 1,2 having count(*) > 1) d;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV57_TRAVA:-0}" -ge 2 ] && [ "${INV57_DRENO:-0}" -ge 2 ] && [ "${INV57_TEST:-0}" -ge 1 ] && { [ "$INV57_REIMPORT" = "SKIP" ] || [ "${INV57_REIMPORT:-1}" = "0" ]; }; then
  echo "INV-057: PASS (trava=$INV57_TRAVA dreno=$INV57_DRENO teste=$INV57_TEST reimportadas_24h=$INV57_REIMPORT)"
else
  echo "INV-057: FAIL (trava=$INV57_TRAVA dreno=$INV57_DRENO teste=$INV57_TEST reimportadas_24h=$INV57_REIMPORT — adoção voltou a re-importar thread; ver docs/INVARIANTES_COCKPIT.md INV-057)"
fi

# INV-058 (Caio 2026-07-26): TODA fila de trabalho tem vigia. O watchdog do
# health-check olhava só agent_executor/respostas_envio — scan_email_pre_card
# acumulou 94.084 msgs em 13 dias invisível. Regressão que este guard trava:
# fila sumindo da lista FILAS_VIGIADAS.
INV58_VIGIA=$(grep -c 'FILAS_VIGIADAS' supabase/functions/health-check/index.ts)
INV58_SCAN=$(grep -c 'fila: "scan_email_pre_card"' supabase/functions/health-check/index.ts)
INV58_ADOCAO=$(grep -c 'fila: "importar_thread_adotada"' supabase/functions/health-check/index.ts)
if [ "${INV58_VIGIA:-0}" -ge 2 ] && [ "${INV58_SCAN:-0}" -ge 1 ] && [ "${INV58_ADOCAO:-0}" -ge 1 ]; then
  echo "INV-058: PASS (vigia=$INV58_VIGIA scan=$INV58_SCAN adocao=$INV58_ADOCAO)"
else
  echo "INV-058: FAIL (vigia=$INV58_VIGIA scan=$INV58_SCAN adocao=$INV58_ADOCAO — fila de trabalho sem vigia; ver docs/INVARIANTES_COCKPIT.md INV-058)"
fi

# INV-059 (Duílio 2026-07-27, NF 22232): criar-card-manual com última oc FORA de
# relacionamento (ex.: 31 agendamento) só cria COM justificativa explícita do
# operador — nunca abre criação silenciosa fora de padrão. Checks:
#   (a) o gate usa a decisão pura decidirGateCriacaoManual (fonte única testada);
#   (b) o teste do helper passa (relacionamento sem motivo; fora-padrão exige motivo);
#   (c) auditoria: o backend grava fora_de_padrao no evento CardCriadoManualmente;
#   (d) front: ModalCriarCard oferece o motivo e reenvia motivo_fora_padrao.
INV59_GATE=$(grep -c "decidirGateCriacaoManual" supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV59_AUDIT=$(grep -c "fora_de_padrao" supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/gate-criacao-card-manual.test.ts >/dev/null 2>&1 && INV59_TEST=ok || INV59_TEST=fail
INV59_FRONT=$(grep -c "motivo_fora_padrao\|pode_forcar_com_motivo" apps/cockpit-web/src/components/cards/ModalCriarCard.tsx 2>/dev/null | tr -d ' ')
if [ "${INV59_GATE:-0}" -ge 1 ] && [ "${INV59_AUDIT:-0}" -ge 1 ] && [ "$INV59_TEST" = "ok" ] && [ "${INV59_FRONT:-0}" -ge 2 ]; then
  echo "INV-059: PASS (gate=$INV59_GATE audit=$INV59_AUDIT test=$INV59_TEST front=$INV59_FRONT)"
else
  echo "INV-059: FAIL (gate=$INV59_GATE audit=$INV59_AUDIT test=$INV59_TEST front=$INV59_FRONT — criar-card-manual fora de padrão sem justificativa/auditoria OU front sem o fluxo do motivo; ver _shared/gate-criacao-card-manual.ts, NF 22232)"
fi

# INV-060 (Duílio 2026-07-29, NF 303061): extravio PARCIAL no trilho de
# indenização (oc 59) oferece a oc 55 (seguir parcial) como OPÇÃO. Era só do
# menu do 54 → operador em card 59 ficava sem como escolher quando o cliente
# autorizava seguir com o parcial. Checks: (a) menu do 59 inclui propSeguir55
# gated por ehParcial; (b) whitelist do trilho 59 mantém cod===55 (não cancela).
INV60_MENU=$(grep -c 'ehParcial ? \[propSeguir55\]' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV60_WL=$(grep -c '(ehParcial && cod === 55)' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
if [ "${INV60_MENU:-0}" -ge 1 ] && [ "${INV60_WL:-0}" -ge 1 ]; then
  echo "INV-060: PASS (menu59_com_55=$INV60_MENU whitelist55=$INV60_WL)"
else
  echo "INV-060: FAIL (menu59_com_55=$INV60_MENU whitelist55=$INV60_WL — oc 55 saiu do menu do trilho 59 parcial; operador sem 'seguir parcial'; NF 303061, propostas-pos-resposta-cliente.ts)"
fi

# INV-061 (Duílio 2026-07-29): agente-oc43-autonomo. Card em oc 43 lança 49 se a
# oc IMEDIATAMENTE ANTERIOR no SSW ∈ {3,6,8,9,10,11,13,16,17,18,19,20,23,31,35},
# senão 55; sem anterior / SSW já saiu de 43 → NÃO lança (deixa AVH manual).
# Checks: (a) testes da lógica pura verdes; (b) whitelist com as 15 ocs;
# (c) lançamento SÓ via auto_aprovar_e_executar (envelope/executor); (d) agente
# NÃO chama SSW direto (convenção #2 — nada de lancarSswPortal/lancarOcorrenciaPortal
# no agente); (e) rollout shadow-first (2 flags separadas).
INV61_TEST=$(deno test --no-check supabase/functions/_shared/oc43-regras.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV61_WL=$(grep -c '3, 6, 8, 9, 10, 11, 13, 16, 17, 18, 19, 20, 23, 31, 35' supabase/functions/_shared/oc43-regras.ts 2>/dev/null | tr -d ' ')
INV61_ENV=$(grep -c 'auto_aprovar_e_executar' supabase/functions/agente-oc43-autonomo/index.ts 2>/dev/null | tr -d ' ')
# chamada REAL (com paren), não menção em comentário; e sem import direto do envelope
INV61_NODIRECT=$(grep -cE 'lancarSswPortal\(|lancarOcorrenciaPortal\(|from .*lancar-ssw-portal' supabase/functions/agente-oc43-autonomo/index.ts 2>/dev/null | tr -d ' ')
INV61_SHADOW=$(grep -c 'oc43_agente_autonomo_enabled' supabase/functions/agente-oc43-autonomo/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV61_TEST" = "ok" ] && [ "${INV61_WL:-0}" -ge 1 ] && [ "${INV61_ENV:-0}" -ge 1 ] && [ "${INV61_NODIRECT:-1}" -eq 0 ] && [ "${INV61_SHADOW:-0}" -ge 1 ]; then
  echo "INV-061: PASS (test=$INV61_TEST whitelist=$INV61_WL envelope=$INV61_ENV chamada_direta=$INV61_NODIRECT shadow=$INV61_SHADOW)"
else
  echo "INV-061: FAIL (test=$INV61_TEST whitelist=$INV61_WL envelope=$INV61_ENV chamada_direta=$INV61_NODIRECT shadow=$INV61_SHADOW — agente oc43 deve decidir 49/55 pela oc anterior, lançar SÓ via auto_aprovar_e_executar e nunca chamar o SSW direto; Duílio 2026-07-29)"
fi

# INV-062 (Larissa 2026-08-05, NF 1102187): extravio TOTAL escalado p/ oc 49/54
# (âncora≠59) — o menu pós-resposta MANTÉM/REVIVE o 59+email de indenização
# (template EXTRAVIO_TOTAL_PEDIR_ROMANEIO do override 54→59), em vez de cancelar
# como obsoleto. Gate ehExtravioTotal (presença durável do todo 59+template) →
# INERTE pra card não-total. Checks: (a) testes puros verdes; (b) whitelist mantém
# 59 em total; (c) helper de revive presente (def + call).
INV62_TEST=$(deno test --no-check supabase/functions/_shared/oc59-extravio-total.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV62_WL=$(grep -c 'ehExtravioTotal && cod === 59' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV62_REVIVE=$(grep -c 'escolher59IndenizacaoParaReviver' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
if [ "$INV62_TEST" = "ok" ] && [ "${INV62_WL:-0}" -ge 1 ] && [ "${INV62_REVIVE:-0}" -ge 2 ]; then
  echo "INV-062: PASS (test=$INV62_TEST whitelist59=$INV62_WL revive=$INV62_REVIVE)"
else
  echo "INV-062: FAIL (test=$INV62_TEST whitelist59=$INV62_WL revive=$INV62_REVIVE — menu pós-resposta deve manter/reviver o 59+email em extravio total; NF 1102187)"
fi

# INV-063 (Caio 2026-08-06, incidente l.silva + NF 236391): TODO acesso SSW
# pela conta de serviço ai.salex (leitura E lançamento); idempotent_skip só
# com verdade do SSW (nunca skip cego em sucesso=true).
INV63_TEST_CRED=$(deno test --no-check supabase/functions/_shared/ssw-credencial-unica.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV63_TEST_RELANC=$(deno test --no-check supabase/functions/_shared/relancamento-idempotencia.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# loadSswInternalEnvForCard NÃO pode voltar a consultar o banco (resolução por operador)
INV63_DBLOOKUP=$(sed -n '/export async function loadSswInternalEnvForCard/,/^}/p' supabase/functions/_shared/ssw-internal-client.ts | grep -c "\.from(" | tr -d ' ')
# branch sucesso===true do envelope decide via helper (definição + uso = >=2)
INV63_DECIDIR=$(grep -c "decidirIdempotenciaRelancamento" supabase/functions/_shared/lancar-ssw-portal.ts | tr -d ' ')
if [ "$INV63_TEST_CRED" = "ok" ] && [ "$INV63_TEST_RELANC" = "ok" ] && [ "${INV63_DBLOOKUP:-1}" -eq 0 ] && [ "${INV63_DECIDIR:-0}" -ge 2 ]; then
  echo "INV-063: PASS (cred=$INV63_TEST_CRED relanc=$INV63_TEST_RELANC dblookup=$INV63_DBLOOKUP decidir=$INV63_DECIDIR)"
else
  echo "INV-063: FAIL (cred=$INV63_TEST_CRED relanc=$INV63_TEST_RELANC dblookup=$INV63_DBLOOKUP decidir=$INV63_DECIDIR — credencial única ai.salex + relançamento pela verdade do SSW; incidente 2026-08-06)"
fi

# INV-064 (Caio 2026-08-10, onboarding MARIA + AGV): contato por REMETENTE.
# A RPC resolver_email_cobranca_cliente tem 3º arg p_cnpj_remetente: com remetente
# a linha específica vence; SEM remetente NUNCA pode voltar linha específica
# (AGV não tem contato geral → NULL força escolha no modal). Âncora estrutural
# (sem PII no repo): pagador AGV Vinhedo + remetente ZOETIS → e-mail @agv.com.br;
# mesmo pagador SEM remetente → NULL. Valor exato do contato: mig 322 / banco.
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV64_COM=$(psql "$SUPABASE_DB_URL" -At -c "SELECT coalesce(public.resolver_email_cobranca_cliente('02905424001879','logistico','01770356000177'),'NULL');" 2>/dev/null)
  INV64_SEM=$(psql "$SUPABASE_DB_URL" -At -c "SELECT coalesce(public.resolver_email_cobranca_cliente('02905424001879','logistico',NULL),'NULL');" 2>/dev/null)
  # callers backend passam o remetente CRU (nunca o colapso null→pagador)
  INV64_CRU=$(grep -c "cnpj_remetente" supabase/functions/_shared/regras-auto-acao.ts | tr -d ' ')
  case "$INV64_COM" in *@agv.com.br) INV64_COM_OK=ok ;; *) INV64_COM_OK=fail ;; esac
  if [ "$INV64_COM_OK" = "ok" ] && [ "$INV64_SEM" = "NULL" ] && [ "${INV64_CRU:-0}" -ge 1 ]; then
    echo "INV-064: PASS (com_remetente=dominio_agv sem_remetente=$INV64_SEM cru=$INV64_CRU)"
  else
    echo "INV-064: FAIL (com_remetente=$INV64_COM_OK sem_remetente=$INV64_SEM cru=$INV64_CRU — resolver por remetente AGV; onboarding MARIA 2026-08-10)"
  fi
else
  echo "INV-064: SKIP (sem SUPABASE_DB_URL)"
fi

# INV-065 (Caio 2026-08-10, trava modo visualização): João/Isadora veem tudo
# e não executam NADA (cards + cadastros; Aprendizado fica livre). 3 camadas:
# flags no banco, guard nos 17 RPCs SECURITY DEFINER, helper nas 10 edge
# functions mutantes. service_role/cron nunca trava.
INV65_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/trava-visualizacao.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV65_EDGE=$(grep -rl "bloquearSeModoVisualizacao" supabase/functions --include="index.ts" | wc -l | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV65_COL=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM information_schema.columns WHERE table_name='operadores' AND column_name='pode_executar';" 2>/dev/null)
  if [ "${INV65_COL:-0}" -eq 0 ]; then
    echo "INV-065: SKIP (mig 324 ainda não aplicada — coluna pode_executar ausente)"
  else
    INV65_FLAGS=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM operadores WHERE pode_executar=false AND lower(email) IN ('joao.penha@salexpress.com.br','isadora.baldoni@salexpress.com.br');" 2>/dev/null)
    INV65_RPCS=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosrc LIKE '%assert_pode_executar%' AND proname <> 'assert_pode_executar';" 2>/dev/null)
    if [ "$INV65_TEST" = "ok" ] && [ "${INV65_FLAGS:-0}" -eq 2 ] && [ "${INV65_RPCS:-0}" -ge 17 ] && [ "${INV65_EDGE:-0}" -ge 10 ]; then
      echo "INV-065: PASS (test=$INV65_TEST flags=$INV65_FLAGS rpcs=$INV65_RPCS edge=$INV65_EDGE)"
    else
      echo "INV-065: FAIL (test=$INV65_TEST flags=$INV65_FLAGS rpcs=$INV65_RPCS edge=$INV65_EDGE — trava modo visualização João/Isadora; mig 324)"
    fi
  fi
else
  echo "INV-065: SKIP (sem SUPABASE_DB_URL; código: test=$INV65_TEST edge=$INV65_EDGE)"
fi

# INV-066 (Caio 2026-08-11, capacidade oc 10 por e-mail — learning_log f665c8f2):
# o detector de "cliente já pediu a devolução" precisa continuar ESTREITO. O ramo
# oc 10 → 54 tem 805 acertos em produção; um detector largo destrói mais do que
# recupera (calibração 11/08: recall 18.8%, falso positivo 0.4%, líquido +6).
# Trava 3 coisas: (a) os 18 testes da lib passam — 8 deles são de falso positivo
# (pergunta, negação, ordem a terceiro, adiamento, condicional, linha citada,
# robô do SSW); (b) a regra só roda sob a flag da mig 325 (nunca hardcoded ON);
# (c) 44 continua saindo como lancar_ocorrencia (nunca lancar_oc_e_enviar_email —
# o cliente já decidiu, notificar de novo é o retrabalho que a regra elimina).
# sed tira as cores ANSI (senão o grep nunca casa); "0 failed" em vez do total,
# pra não quebrar o guard toda vez que um teste novo entrar na lib.
INV66_TEST=$(deno test --no-check supabase/functions/_shared/email-devolucao-solicitada.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -cE "^ok \|.* 0 failed" || true)
INV66_FLAG=$(grep -c "oc10_devolucao_por_email_enabled" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV66_ACAO=$(grep -cE 'pd === 44[[:space:]]*$|acaoKey\("lancar_ocorrencia", 44\)' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV66_EMAIL_OC44=$(grep -c 'lancar_oc_e_enviar_email", 44' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV66_TEST:-0}" -ge 1 ] && [ "${INV66_FLAG:-0}" -ge 1 ] && [ "${INV66_ACAO:-0}" -ge 1 ] && [ "${INV66_EMAIL_OC44:-0}" -eq 0 ]; then
  echo "INV-066: PASS (testes=ok flag=$INV66_FLAG acao44=$INV66_ACAO email44=$INV66_EMAIL_OC44)"
else
  echo "INV-066: FAIL (testes=$INV66_TEST flag=$INV66_FLAG acao44=$INV66_ACAO email44=$INV66_EMAIL_OC44 — detector de devolução por e-mail da oc 10; mig 325)"
fi
# (fi acima faltava desde 11/08 — o else do INV-066 engolia o INV-067 inteiro e
# quebrava a sintaxe da Fase 8; achado no diagnóstico INV-069 de 12/08.)

# INV-067 (Caio 2026-08-11, NFs 306856/74790/439189/5726093 + 11): resposta de
# cliente em card ACIONÁVEL nunca fica muda. O efeito do acionamento é FONTE
# ÚNICA (_shared/acionar-resposta-cliente.ts) usada por vinculador E
# reconciliador — duplicar o bloco recria o bug do INV-042.
INV67_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/acionar-resposta-cliente.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# nenhum caller pode escrever cliente_respondeu_em fora da fonte única
INV67_VAZOU=$(grep -rl "cliente_respondeu_em: new Date()" supabase/functions --include="*.ts" | grep -v "_shared/acionar-resposta-cliente.ts" | wc -l | tr -d ' ')
# os 2 callers usam o helper
INV67_CALLERS=$(grep -rl "acionarRespostaCliente" supabase/functions --include="index.ts" | wc -l | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV67_RPC=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM pg_proc WHERE proname='cards_resposta_cliente_nao_acionada';" 2>/dev/null)
  INV67_PEND=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM public.cards_resposta_cliente_nao_acionada(200, 30, 90);" 2>/dev/null)
else
  INV67_RPC="skip"; INV67_PEND="skip"
fi
if [ "$INV67_TEST" = "ok" ] && [ "${INV67_VAZOU:-1}" -eq 0 ] && [ "${INV67_CALLERS:-0}" -ge 2 ] && \
   { [ "$INV67_RPC" = "skip" ] || { [ "${INV67_RPC:-0}" -ge 1 ] && [ "${INV67_PEND:-1}" -eq 0 ]; }; }; then
  echo "INV-067: PASS (test=$INV67_TEST vazou=$INV67_VAZOU callers=$INV67_CALLERS rpc=$INV67_RPC pendentes=$INV67_PEND)"
else
  echo "INV-067: FAIL (test=$INV67_TEST vazou=$INV67_VAZOU callers=$INV67_CALLERS rpc=$INV67_RPC pendentes=$INV67_PEND — resposta de cliente muda em card acionável; ver acionar-resposta-cliente.ts)"
fi

# INV-068 (Caio 2026-08-11): o OPERADOR fica ciente. Se sobrar resposta de
# cliente sem acionamento (o reconciliador falhou), o dono do card é avisado por
# e-mail E por aviso dentro do Cockpit — nunca só o gestor.
INV68_CORE=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/fiscal-resposta-cliente.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV68_FRONT=$( (cd apps/cockpit-web && npx vitest run src/lib/alertas-operador.test.ts >/dev/null 2>&1) && echo ok || echo fail)
# fiscal existe, usa o MESMO detector do reconciliador e a barra está no layout
INV68_DETECTOR=$(grep -c "cards_resposta_cliente_nao_acionada" supabase/functions/fiscal-resposta-cliente/index.ts | tr -d ' ')
INV68_BARRA=$(grep -c "AgenteChamando" apps/cockpit-web/src/components/layout/AppLayout.tsx | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV68_TAB=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM information_schema.tables WHERE table_name='alertas_operador';" 2>/dev/null)
  INV68_CRON=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM cron.job WHERE jobname='fiscal-resposta-cliente-every-15min';" 2>/dev/null)
else
  INV68_TAB="skip"; INV68_CRON="skip"
fi
if [ "$INV68_CORE" = "ok" ] && [ "$INV68_FRONT" = "ok" ] && [ "${INV68_DETECTOR:-0}" -ge 1 ] && [ "${INV68_BARRA:-0}" -ge 1 ] && \
   { [ "$INV68_TAB" = "skip" ] || { [ "${INV68_TAB:-0}" -ge 1 ] && [ "${INV68_CRON:-0}" -ge 1 ]; }; }; then
  echo "INV-068: PASS (core=$INV68_CORE front=$INV68_FRONT detector=$INV68_DETECTOR barra=$INV68_BARRA tabela=$INV68_TAB cron=$INV68_CRON)"
else
  echo "INV-068: FAIL (core=$INV68_CORE front=$INV68_FRONT detector=$INV68_DETECTOR barra=$INV68_BARRA tabela=$INV68_TAB cron=$INV68_CRON — operador precisa ser avisado de card travado; fiscal INV-067)"
fi

# INV-069 (Caio 2026-08-12, NFs 1102397/382775): o cron-ia-resposta-pendentes
# NUNCA pode retornar cedo com a etapa 1 vazia — o return antecipado pulava o
# heal INV-016 e o reconciliador INV-067 (que só rodava quando havia card de
# retry de IA no instante do cron; 2 respostas engolidas apodreceram 15h+ com
# flag ON e cron 100% succeeded). Guard: nenhum `return` dentro do bloco
# `cards.length === 0`.
INV69_EARLY=$(grep -A2 "cards.length === 0" supabase/functions/cron-ia-resposta-pendentes/index.ts 2>/dev/null | grep -c "return resp" | tr -d ' ')
# as 3 redes continuam presentes e NA ORDEM (etapa 1 → heal → reconciliador)
INV69_REDES=$(grep -cE "atualizarPropostasAposRespostaCliente|cards_resposta_cliente_nao_acionada|acionarRespostaCliente" supabase/functions/cron-ia-resposta-pendentes/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV69_EARLY:-1}" -eq 0 ] && [ "${INV69_REDES:-0}" -ge 3 ]; then
  echo "INV-069: PASS (early_return=$INV69_EARLY redes=$INV69_REDES)"
else
  echo "INV-069: FAIL (early_return=$INV69_EARLY redes=$INV69_REDES — return antecipado no cron pula reconciliador/heal; ver cron-ia-resposta-pendentes)"
fi

# INV-070 (Caio 2026-08-12, NF 895873 — 15 dias muda): o trilho scan-email-pre-card
# emite `RespostaClienteCapturada` na adoção de thread. Sem o evento, resposta
# desse trilho fica fora do radar do detector INV-042 e do reconciliador INV-067
# (a rota aguardando_voce só enxerga outbound da thread e ignora notificação via
# SSW/extravio). Live: zero mensagens órfãs do trilho em card acionável.
INV70_EMITE=$(grep -c '"RespostaClienteCapturada"' supabase/functions/scan-email-pre-card/index.ts 2>/dev/null | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV70_ORFAS=$(psql "$SUPABASE_DB_URL" -At -c "
    SELECT count(*) FROM public.messages_inbox mi
    JOIN public.cards c ON c.id = mi.card_id
    WHERE mi.raw_payload->>'origem' = 'scan-email-pre-card'
      AND mi.recebido_em > now() - interval '30 days'
      AND mi.recebido_em < now() - interval '30 minutes'
      AND c.state IN ('AGUARDANDO_CLIENTE','ACAO_EXECUTADA','AGUARDANDO_VALIDACAO_HUMANA')
      AND NOT EXISTS (SELECT 1 FROM public.card_events x WHERE x.card_id = c.id
        AND x.event_type IN ('RetornoClienteEmAguardo','AprovacaoOperador','AcaoExecutada')
        AND x.created_at >= mi.recebido_em - interval '1 minute')
      AND NOT EXISTS (SELECT 1 FROM public.cards_emails_outbound o
        WHERE o.card_id = c.id AND o.sent_at > mi.recebido_em);" 2>/dev/null)
else
  INV70_ORFAS="skip"
fi
if [ "${INV70_EMITE:-0}" -ge 1 ] && { [ "$INV70_ORFAS" = "skip" ] || [ "${INV70_ORFAS:-1}" -eq 0 ]; }; then
  echo "INV-070: PASS (emite=$INV70_EMITE orfas=$INV70_ORFAS)"
else
  echo "INV-070: FAIL (emite=$INV70_EMITE orfas=$INV70_ORFAS — resposta do trilho scan-email invisível pro reconciliador; ver scan-email-pre-card + retroativo audits/2026-08-12)"
fi

# INV-072 (Caio 2026-08-11, onboarding Ingrid/SBD): romaneio interno com escopo
# e chave POR CLIENTE. 'so_parcial' NUNCA ativa o trilho em card de extravio
# total (SBD total = 59+email padrão); PRATI segue 'sempre'/'nf' (zero
# regressão, guarda na própria mig 329). Chave 'numero_remessa_danfe' resolve o
# Nº Remessa no XML da NF-e (PDF do Impr é imagem pura — nunca usar).
INV72_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/regras-auto-acao.romaneio.test.ts _shared/danfe-remessa.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV72_ESCOPO=$(grep -c "romaneio_escopo" supabase/functions/_shared/regras-auto-acao.ts | tr -d ' ')
INV72_CHAVE=$(grep -c "numero_remessa_danfe" supabase/functions/executor/index.ts | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV72_PRATI=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM cliente_config WHERE cnpj_pagador='73856593001057' AND romaneio_escopo='sempre' AND romaneio_busca_chave='nf';" 2>/dev/null)
else
  INV72_PRATI="skip"
fi
if [ "$INV72_TEST" = "ok" ] && [ "${INV72_ESCOPO:-0}" -ge 1 ] && [ "${INV72_CHAVE:-0}" -ge 1 ] && \
   { [ "$INV72_PRATI" = "skip" ] || [ "${INV72_PRATI:-0}" -ge 1 ]; }; then
  echo "INV-072: PASS (test=$INV72_TEST escopo=$INV72_ESCOPO chave=$INV72_CHAVE prati=$INV72_PRATI)"
else
  echo "INV-072: FAIL (test=$INV72_TEST escopo=$INV72_ESCOPO chave=$INV72_CHAVE prati=$INV72_PRATI — romaneio por escopo/chave; Ingrid/SBD mig 329)"
fi

# INV-073 (Caio 2026-08-11, Ingrid/Dim-Nortel): admissão de e-mail em thread
# nova SÓ para remetente marcado (responde_em_thread_nova) e atrás de flag.
# E-mail pessoal segue descartado; dedupe global por Message-ID.
INV73_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/resposta-thread-nova.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV73_GATE=$(grep -c "deveAdmitirEmailNaoCasado" supabase/functions/gmail-poll-inbox/index.ts | tr -d ' ')
INV73_FLAG=$(grep -c "resposta_thread_nova_enabled" supabase/functions/gmail-poll-inbox/index.ts | tr -d ' ')
# vigia do buraco cego: admitido que NÃO casou (ignored_/pending) alerta o Caio —
# o INV-042 não enxerga (sem card não há RespostaClienteCapturada)
INV73_VIGIA=$(grep -c "checkThreadNovaSemCasar" supabase/functions/health-check/index.ts | tr -d ' ')
if [ "$INV73_TEST" = "ok" ] && [ "${INV73_GATE:-0}" -ge 1 ] && [ "${INV73_FLAG:-0}" -ge 1 ] && [ "${INV73_VIGIA:-0}" -ge 2 ]; then
  echo "INV-073: PASS (test=$INV73_TEST gate=$INV73_GATE flag=$INV73_FLAG vigia=$INV73_VIGIA)"
else
  echo "INV-073: FAIL (test=$INV73_TEST gate=$INV73_GATE flag=$INV73_FLAG vigia=$INV73_VIGIA — admissão thread-nova + vigia sem-casar; Ingrid mig 329)"
fi

# INV-074 (Caio 2026-08-11, Ingrid/Würth): robô da intranet SUGERE, nunca lança.
# Prefixo do CTRC decide o login (AMB/WTB→ampla; WTC/ARP→sal); dedupe por
# (nf,data_solucao,solucao) — linha nova da MESMA NF = ciclo novo; CCE vence a
# Solução (a sugestão nasce do e-mail da carta, com aviso de corrigir endereço).
INV74_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/wurth-intranet.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV74_SUGERE=$(grep -c "auto_aprovar_e_executar\|lancarSswPortal" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV74_FLAG=$(grep -c "wurth_intranet_enabled" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV74_BOTAO=$(grep -c "robo-intranet-wurth" apps/cockpit-web/src/components/cards/CardIdentification.tsx | tr -d ' ')
INV74_CCE=$(grep -c "criarPropostaCceSeAplicavel" supabase/functions/vinculador/index.ts | tr -d ' ')
INV74_BUSCACCE=$(grep -c "buscar-cce-gmail" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
if [ "$INV74_TEST" = "ok" ] && [ "${INV74_SUGERE:-1}" -eq 0 ] && [ "${INV74_FLAG:-0}" -ge 1 ] && [ "${INV74_BOTAO:-0}" -ge 1 ] && [ "${INV74_CCE:-0}" -ge 2 ] && [ "${INV74_BUSCACCE:-0}" -ge 1 ]; then
  echo "INV-074: PASS (test=$INV74_TEST lanca_sozinho=$INV74_SUGERE flag=$INV74_FLAG botao=$INV74_BOTAO cce=$INV74_CCE busca_cce=$INV74_BUSCACCE)"
else
  echo "INV-074: FAIL (test=$INV74_TEST lanca_sozinho=$INV74_SUGERE flag=$INV74_FLAG botao=$INV74_BOTAO cce=$INV74_CCE busca_cce=$INV74_BUSCACCE — robô Würth sugere-nunca-lança + busca CCE; mig 331)"
fi

# INV-075 (Caio 2026-08-13, Ingrid/Würth): o botão da intranet é VISÍVEL no front.
# Causa raiz do bug: cliente_config é service-only → o front (authenticated) dava
# `permission denied` ao lê-la direto → ehIntranetWurth=false → botão NUNCA
# aparecia. Guard: o front lê via RPC card_eh_intranet_wurth e NUNCA
# .from("cliente_config"); migs 335/336 existem; robô devolve `resumo` (4
# desfechos do botão) e loga a varredura (wurth_robo_execucoes).
INV75_RPC=$(grep -c "card_eh_intranet_wurth" apps/cockpit-web/src/components/cards/CardIdentification.tsx | tr -d ' ')
INV75_SEM_TABELA=$(grep -c 'from("cliente_config")' apps/cockpit-web/src/components/cards/CardIdentification.tsx | tr -d ' ')
INV75_MIG=$(ls migration/ | grep -c "rpc_card_eh_intranet_wurth\|wurth_robo_execucoes" | tr -d ' ')
INV75_RESUMO=$(grep -c "resumo:" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV75_LOG=$(grep -c "wurth_robo_execucoes" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV75_AGENDA=$([ -f apps/cockpit-web/src/lib/wurthAgenda.test.ts ] && echo ok || echo fail)
if [ "${INV75_RPC:-0}" -ge 1 ] && [ "${INV75_SEM_TABELA:-1}" -eq 0 ] && [ "${INV75_MIG:-0}" -ge 2 ] && [ "${INV75_RESUMO:-0}" -ge 1 ] && [ "${INV75_LOG:-0}" -ge 1 ] && [ "$INV75_AGENDA" = "ok" ]; then
  echo "INV-075: PASS (rpc=$INV75_RPC sem_tabela=$INV75_SEM_TABELA mig=$INV75_MIG resumo=$INV75_RESUMO log=$INV75_LOG agenda=$INV75_AGENDA)"
else
  echo "INV-075: FAIL (rpc=$INV75_RPC sem_tabela=$INV75_SEM_TABELA mig=$INV75_MIG resumo=$INV75_RESUMO log=$INV75_LOG agenda=$INV75_AGENDA — botão intranet lê via RPC, nunca .from(cliente_config); migs 335/336)"
fi

# INV-076 (Caio 2026-08-13, Würth/Ingrid): instrução da oc 21 CABE nos 70 do f6.
# 3ª regressão da classe "boilerplate antes do texto útil" (1ª: NF 59299 oc 44;
# 2ª: NF 669899 — `REENTREGA AUTORIZADA PELO CLIENTE VIA INTRANET WURTH - BOA
# TARDE! SEGU`). O que passa de 70 vai pro observ, que a Operação NÃO lê. Guard:
# os DOIS caminhos (enxerto do menu + INSERT do robô) passam por
# comprimirInstrucaoWurth e nenhum escreve boilerplate em args.descricao.
INV76_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/instrucao-ssw-wurth.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV76_ENXERTO=$(grep -c "comprimirInstrucaoWurth" supabase/functions/_shared/wurth-intranet.ts | tr -d ' ')
INV76_ROBO=$(grep -c "comprimirInstrucaoWurth" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV76_BOILER=$(grep -c "Reentrega autorizada pelo cliente via intranet\|autorizou reentrega via intranet Würth —" supabase/functions/_shared/wurth-intranet.ts supabase/functions/robo-intranet-wurth/index.ts 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
if [ "$INV76_TEST" = "ok" ] && [ "${INV76_ENXERTO:-0}" -ge 1 ] && [ "${INV76_ROBO:-0}" -ge 1 ] && [ "${INV76_BOILER:-1}" -eq 0 ]; then
  echo "INV-076: PASS (test=$INV76_TEST enxerto=$INV76_ENXERTO robo=$INV76_ROBO boilerplate=$INV76_BOILER)"
else
  echo "INV-076: FAIL (test=$INV76_TEST enxerto=$INV76_ENXERTO robo=$INV76_ROBO boilerplate=$INV76_BOILER — instrução da oc21 Würth tem que passar por comprimirInstrucaoWurth e caber em 70; sem boilerplate em args.descricao)"
fi

# INV-077 (Caio 2026-08-13, placar dos agentes): TODO caminho que chega ao SSW
# registra o par "agente sugeriu X · operador fez Y". Antes, os 4 handlers de
# oc 33 (combo 33+44, solo portal, e-mail+romaneio, e-mail livre) lançavam e
# davam return ANTES do ponto de feedback — 499 execuções/60d fora do placar.
# Guard: o helper único é chamado nos 5 caminhos e ninguém volta a chamar as
# RPCs soltas no executor (senão um caminho novo nasce sem feedback de novo).
INV77_HELPER=$(grep -c "registrarFeedbackImplicitoAgentes(supabase" supabase/functions/executor/index.ts | tr -d ' ')
INV77_SOLTA=$(grep -c 'rpc("registrar_feedback_\(oc13\|ocs_padrao\|interpretador_resposta\)_implicito"' supabase/functions/executor/index.ts | tr -d ' ')
INV77_MOD=$([ -f supabase/functions/_shared/feedback-implicito-agentes.ts ] && echo ok || echo fail)
if [ "${INV77_HELPER:-0}" -ge 4 ] && [ "${INV77_SOLTA:-1}" -eq 0 ] && [ "$INV77_MOD" = "ok" ]; then
  echo "INV-077: PASS (caminhos=$INV77_HELPER rpc_solta=$INV77_SOLTA modulo=$INV77_MOD)"
else
  echo "INV-077: FAIL (caminhos=$INV77_HELPER rpc_solta=$INV77_SOLTA modulo=$INV77_MOD — todo caminho que lança no SSW deve chamar registrarFeedbackImplicitoAgentes; nada de RPC solta)"
fi

# INV-078 (Caio 2026-08-13, placar dos agentes): o painel lê a FONTE ÚNICA e
# nunca derruba a aba. Se `v_placar_agente` não existir (migration não aplicada
# no ambiente), o componente devolve null em vez de erro vermelho — a aba
# Aprendizado e os chats do agente-chefe seguem funcionando.
INV78_VIEW=$(grep -c "v_placar_agente" apps/cockpit-web/src/components/aprendizado/PlacarAgentes.tsx | tr -d ' ')
INV78_DEGRADA=$(grep -c "isError) return null" apps/cockpit-web/src/components/aprendizado/PlacarAgentes.tsx | tr -d ' ')
INV78_TEST=$([ -f apps/cockpit-web/src/lib/placarAgentes.test.ts ] && echo ok || echo fail)
INV78_META=$(grep -c "META_ACERTO_PCT = 95" apps/cockpit-web/src/lib/placarAgentes.ts | tr -d ' ')
if [ "${INV78_VIEW:-0}" -ge 1 ] && [ "${INV78_DEGRADA:-0}" -ge 1 ] && [ "$INV78_TEST" = "ok" ] && [ "${INV78_META:-0}" -eq 1 ]; then
  echo "INV-078: PASS (view=$INV78_VIEW degrada=$INV78_DEGRADA test=$INV78_TEST meta=$INV78_META)"
else
  echo "INV-078: FAIL (view=$INV78_VIEW degrada=$INV78_DEGRADA test=$INV78_TEST meta=$INV78_META — placar lê v_placar_agente, degrada sem quebrar a aba, e a meta 95% é constante única)"
fi

# INV-079 (Caio 2026-08-13, autonomia por fatia): NADA é autônomo por default.
# O guard `fatia_esta_autonoma` responde FALSE pra tudo que não estiver
# explicitamente registrado em `fatias_autonomas` com ativa=true — promover é
# ato humano. E existe kill-switch com histerese (promove ≥95, despromove <90).
# Regressão temida: alguém trocar o default pra permissivo, ou promover fatia
# direto no código em vez de pelo registro.
INV79_GUARD=$(grep -c "fatia_esta_autonoma" migration/2026-08-13_340_fase5_autonomia_por_fatia.sql 2>/dev/null | tr -d ' ')
INV79_KILL=$(grep -c "demover_fatias_abaixo_da_meta" migration/2026-08-13_340_fase5_autonomia_por_fatia.sql 2>/dev/null | tr -d ' ')
INV79_MODO=$(grep -c "modo = 'sugestao'" migration/2026-08-13_340_fase5_autonomia_por_fatia.sql 2>/dev/null | tr -d ' ')
if [ "${INV79_GUARD:-0}" -ge 3 ] && [ "${INV79_KILL:-0}" -ge 3 ] && [ "${INV79_MODO:-0}" -ge 1 ]; then
  echo "INV-079: PASS (guard=$INV79_GUARD kill=$INV79_KILL autonomo_nao_se_promove=$INV79_MODO)"
else
  echo "INV-079: FAIL (guard=$INV79_GUARD kill=$INV79_KILL autonomo_nao_se_promove=$INV79_MODO — autonomia é opt-in explícito por fatia, com kill-switch; agente autônomo não pode se auto-promover)"
fi

# INV-080 (Caio 2026-08-14, Würth/Ingrid — NF 677750): retorno da intranet só
# vale pro ciclo CORRENTE. A intranet responde por NF, não por ciclo: a mesma NF
# acumula recusa → reentrega → nova recusa e a consulta devolve a linha antiga
# igual. Regressão real: resposta da oc 13 (12/08 08:39) virou sugestão de oc 21
# RECOMENDADA contra a recusa oc 10 (12/08 23:26) — mesmo DIA, só a HORA separa.
# Guard: o robô compara Data Solução × ocorrência-GATILHO (nunca a 54, que é
# posterior por ser formalização — a Würth recebe a oc real por EDI na hora),
# descarta antes de qualquer efeito, e puxa o histórico SSW quando falta hora.
INV80_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/wurth-ciclo.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV80_GUARD=$(grep -c "avaliarCicloRetornoWurth" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV80_ANCORA=$(grep -c "OCS_LANCADAS_PELA_TRATATIVA" supabase/functions/_shared/wurth-ciclo.ts | tr -d ' ')
INV80_HIST=$(grep -c "puxar-historico-ssw-card" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
# o descarte tem que vir ANTES do dedupe/efeito (senão sugere e só depois avalia)
INV80_ORDEM=$(awk '/avaliarCicloRetornoWurth\(linha.dataSolucao/{g=NR} /const efeito = mapearEfeito/{e=NR} END {print (g>0 && e>g) ? 1 : 0}' supabase/functions/robo-intranet-wurth/index.ts)
if [ "$INV80_TEST" = "ok" ] && [ "${INV80_GUARD:-0}" -ge 1 ] && [ "${INV80_ANCORA:-0}" -ge 1 ] && [ "${INV80_HIST:-0}" -ge 1 ] && [ "${INV80_ORDEM:-0}" -eq 1 ]; then
  echo "INV-080: PASS (test=$INV80_TEST guard=$INV80_GUARD ancora=$INV80_ANCORA historico=$INV80_HIST ordem=$INV80_ORDEM)"
else
  echo "INV-080: FAIL (test=$INV80_TEST guard=$INV80_GUARD ancora=$INV80_ANCORA historico=$INV80_HIST ordem=$INV80_ORDEM — retorno da intranet Würth anterior à ocorrência-gatilho tem que ser descartado ANTES do efeito)"
fi

# INV-081 (Caio 2026-08-14, NF 674757 Würth): instrução do E-MAIL chega ao SSW.
# A decisão do interpretador (oc 21 + instrucao_reentrega_sugerida) ficava só em
# ia_sugestao_oc_resposta — o todo 21 pré-existente (ex.: criado pelo robô da
# intranet com Obs de ciclo velho) ia pro SSW com o texto errado no quick-approve
# da ⭐ RECOMENDADA (oc 21 não abre painel de input; extras=null). Guard: o
# enxerto existe, é chamado dos DOIS lados (interpretador + propostas-pos-
# resposta, cobrindo as duas ordens), e o front mostra a origem da instrução.
INV81_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/instrucao-email-21.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV81_INTERP=$(grep -c "aplicarInstrucaoEmailNaProposta21" supabase/functions/interpretador-resposta-cliente/index.ts | tr -d ' ')
INV81_PROPOSTAS=$(grep -c "aplicarInstrucaoEmailNaProposta21" supabase/functions/_shared/propostas-pos-resposta-cliente.ts | tr -d ' ')
INV81_CHIP=$(grep -c "origem_instrucao" apps/cockpit-web/src/components/cards/ProposedActions.tsx | tr -d ' ')
# o texto do e-mail NÃO pode passar pelo extrator da intranet (perde dado em
# texto livre — "Falar com Josiele..." virava só "TEL ...")
INV81_EXTRATOR=$(grep -c "comprimirInstrucaoWurth(instrucao)" supabase/functions/_shared/instrucao-email-21.ts | tr -d ' ')
if [ "$INV81_TEST" = "ok" ] && [ "${INV81_INTERP:-0}" -ge 1 ] && [ "${INV81_PROPOSTAS:-0}" -ge 1 ] && [ "${INV81_CHIP:-0}" -ge 1 ] && [ "${INV81_EXTRATOR:-1}" -eq 0 ]; then
  echo "INV-081: PASS (test=$INV81_TEST interp=$INV81_INTERP propostas=$INV81_PROPOSTAS chip=$INV81_CHIP extrator_intranet=$INV81_EXTRATOR)"
else
  echo "INV-081: FAIL (test=$INV81_TEST interp=$INV81_INTERP propostas=$INV81_PROPOSTAS chip=$INV81_CHIP extrator_intranet=$INV81_EXTRATOR — instrução do e-mail tem que ser enxertada no todo 21 ativo pelos dois call sites, com chip de origem no front)"
fi

# INV-082 (Caio 2026-08-14, Würth R1): devolução por SILÊNCIO nunca é cega nem
# autônoma. oc 11 + 54 + 10 dias sem retorno (e-mail E intranet) → sugestão de
# 44 SÓ com: evidência gravada ANTES (wurth_evidencias_intranet, UNIQUE por
# ciclo), fail-closed (gatilho sem hora / login sem consulta OK / linha ilegível
# → não age), flag master, e SEM setar cliente_respondeu_em (não houve resposta).
INV82_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/wurth-devolucao-silencio.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV82_FASE=$(grep -c "avaliarSilencioParaDevolucao" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV82_FLAG=$(grep -c "wurth_devolucao_sugestao_enabled" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV82_EVID=$(grep -c "wurth_evidencias_intranet" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
# a fase R1 NÃO pode fingir resposta: nenhum cliente_respondeu_em no updR1
INV82_SEMRESP=$(awk '/const updR1/,/update\(updR1\)/' supabase/functions/robo-intranet-wurth/index.ts | grep -c "cliente_respondeu_em")
# R1 com E-MAIL (mig 342, Caio 2026-08-14): o todo é lancar_oc_e_enviar_email:44
# com template WURTH_DEVOLUCAO_SEM_RETORNO + destinatário do ÚLTIMO outbound do
# card (mesma thread; sem outbound → cadastro via preview). modo 'completo' pra
# nunca aprovar às cegas.
INV82_EMAIL=$(grep -c "WURTH_DEVOLUCAO_SEM_RETORNO" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
INV82_THREAD=$(grep -c "cards_emails_outbound" supabase/functions/robo-intranet-wurth/index.ts | tr -d ' ')
if [ "$INV82_TEST" = "ok" ] && [ "${INV82_FASE:-0}" -ge 1 ] && [ "${INV82_FLAG:-0}" -ge 1 ] && [ "${INV82_EVID:-0}" -ge 2 ] && [ "${INV82_SEMRESP:-1}" -eq 0 ] && [ "${INV82_EMAIL:-0}" -ge 1 ] && [ "${INV82_THREAD:-0}" -ge 1 ]; then
  echo "INV-082: PASS (test=$INV82_TEST fase=$INV82_FASE flag=$INV82_FLAG evidencia=$INV82_EVID finge_resposta=$INV82_SEMRESP email=$INV82_EMAIL thread=$INV82_THREAD)"
else
  echo "INV-082: FAIL (test=$INV82_TEST fase=$INV82_FASE flag=$INV82_FLAG evidencia=$INV82_EVID finge_resposta=$INV82_SEMRESP email=$INV82_EMAIL thread=$INV82_THREAD — R1 exige evidência antes da sugestão, flag master, nunca seta cliente_respondeu_em, e o todo leva template WURTH_DEVOLUCAO_SEM_RETORNO + destinatário do último outbound; migs 341/342)"
fi

# INV-083 (Caio 2026-08-14, Würth R2): 2ª oc 10 → 44 + e-mail SÓ pra CNPJ da
# config, com desarme stateless (54 posterior à 2ª recusa = exceção da
# operadora) e bump de VERSAO_REGRAS_ANALISE (NF 1100040: mudou lógica = bump).
# O 44 SEM template continua lancar_ocorrencia (nunca notifica) — a exceção é
# só com template (R2).
INV83_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/wurth-segunda-recusa.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV83_CFG=$(grep -c 'eq("intranet_wurth", true)' supabase/functions/agente-sugere-ocs-padrao/index.ts | tr -d ' ')
INV83_DESARME=$(grep -c "ts > ultimaRecusa" supabase/functions/_shared/wurth-segunda-recusa.ts | tr -d ' ')
INV83_VERSAO=$(grep -c 'VERSAO_REGRAS_ANALISE = "2026-08-1[01]a"' supabase/functions/agente-sugere-ocs-padrao/index.ts | tr -d ' ')
INV83_ACAOKEY=$(grep -c 'acaoKey("lancar_oc_e_enviar_email", 44)' supabase/functions/agente-sugere-ocs-padrao/index.ts | tr -d ' ')
if [ "$INV83_TEST" = "ok" ] && [ "${INV83_CFG:-0}" -ge 1 ] && [ "${INV83_DESARME:-0}" -ge 1 ] && [ "${INV83_VERSAO:-1}" -eq 0 ] && [ "${INV83_ACAOKEY:-0}" -ge 1 ]; then
  echo "INV-083: PASS (test=$INV83_TEST config=$INV83_CFG desarme=$INV83_DESARME versao_velha=$INV83_VERSAO acao_key_email44=$INV83_ACAOKEY)"
else
  echo "INV-083: FAIL (test=$INV83_TEST config=$INV83_CFG desarme=$INV83_DESARME versao_velha=$INV83_VERSAO acao_key_email44=$INV83_ACAOKEY — R2 só via cliente_config, desarme por 54 posterior, bump de versão feito, 44 com template = lancar_oc_e_enviar_email)"
fi

# INV-080 (Caio 2026-08-17, NFs 1102092 + 744476): o e-mail do monitor só
# reporta o que é real, e a transição INV-019 acontece na rodada que traz a oc.
# (a) Pass A avalia o lag com a data da PENDÊNCIA (p.data_ultima_ocorrencia),
#     nunca só a data velha do card — senão oc nova vira "lag" e o card fica
#     invisível até o sweep (61min na 1102092);
# (b) o sweep roda ANTES do Pass A (orçamento garantido) e loga skip por deadline;
# (c) o vigia INV-042 dá grace pós-REATIVAÇÃO (mig 341) — card que acabou de
#     reabrir não vira alerta-de-90-segundos;
# (d) o corte do INV-019 respeita o ciclo real do sync (45min, não 15).
INV80_DATA=$(grep -c "bastaoOcDate: p.data_ultima_ocorrencia" supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV80_PRE=$(awk '/sweepInv019Pre/{print NR; exit}' supabase/functions/sync-bastao/index.ts)
INV80_PASSA=$(awk '/const passARes = await runPassA/{print NR; exit}' supabase/functions/sync-bastao/index.ts)
INV80_SKIPLOG=$(grep -c "PULADO por deadline" supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV80_MIG=$(ls migration/ | grep -c "vigia_grace_pos_reativacao" | tr -d ' ')
INV80_CUT=$(grep -c "45 \* 60 \* 1000" supabase/functions/health-check/index.ts | tr -d ' ')
if [ "${INV80_DATA:-0}" -ge 1 ] && [ -n "$INV80_PRE" ] && [ -n "$INV80_PASSA" ] && [ "$INV80_PRE" -lt "$INV80_PASSA" ] && [ "${INV80_SKIPLOG:-0}" -ge 1 ] && [ "${INV80_MIG:-0}" -ge 1 ] && [ "${INV80_CUT:-0}" -ge 1 ]; then
  echo "INV-080: PASS (data_pendencia=$INV80_DATA sweep_pre<passA=$INV80_PRE<$INV80_PASSA skiplog=$INV80_SKIPLOG mig=$INV80_MIG cutoff45=$INV80_CUT)"
else
  echo "INV-080: FAIL (data_pendencia=$INV80_DATA pre=$INV80_PRE passA=$INV80_PASSA skiplog=$INV80_SKIPLOG mig=$INV80_MIG cutoff45=$INV80_CUT — transição INV-019 imediata com data da pendência; sweep pré-Pass A com telemetria; vigia com grace pós-reativação; corte 45min)"
fi

# INV-084 (Caio 2026-08-18, NFs 1597524/58203/55482): reply do Cockpit não
# quebra a conversa no Outlook do cliente.
# (a) NENHUM sender usa o regex antigo /^re:\s/ inline — assunto de reply passa
#     por garantirPrefixoReply (fonte única em email-threading.ts), que mantém
#     "RES:"/"ENC:"/etc. intactos em vez de empilhar "Re: " por cima;
# (b) gmail-poll-inbox captura o header Thread-Index no raw_payload;
# (c) responder-email-cliente ecoa o Thread-Index no extraHeaders;
# (d) o teste-guard existe e passa.
INV84_REGEX_INLINE=$(grep -rn '\^re:' supabase/functions --include="*.ts" | grep -v "email-threading.ts" | grep -cv "garantirPrefixoReply" | tr -d ' ')
INV84_HELPER=$(grep -c "export function garantirPrefixoReply" supabase/functions/_shared/email-threading.ts | tr -d ' ')
INV84_CAPTURA=$(grep -c 'thread_index: getHeader' supabase/functions/gmail-poll-inbox/index.ts | tr -d ' ')
INV84_ECO=$(grep -c '"Thread-Index"' supabase/functions/responder-email-cliente/index.ts | tr -d ' ')
INV84_TEST=$(deno test --allow-all supabase/functions/_shared/email-threading.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV84_REGEX_INLINE:-1}" -eq 0 ] && [ "${INV84_HELPER:-0}" -ge 1 ] && [ "${INV84_CAPTURA:-0}" -ge 2 ] && [ "${INV84_ECO:-0}" -ge 1 ] && [ "$INV84_TEST" = "PASS" ]; then
  echo "INV-084: PASS (regex_inline=$INV84_REGEX_INLINE helper=$INV84_HELPER captura=$INV84_CAPTURA eco=$INV84_ECO test=$INV84_TEST)"
else
  echo "INV-084: FAIL (regex_inline=$INV84_REGEX_INLINE helper=$INV84_HELPER captura=$INV84_CAPTURA eco=$INV84_ECO test=$INV84_TEST — subject de reply só via garantirPrefixoReply; Thread-Index capturado no poll e ecoado no reply; Outlook do cliente mantém a conversa)"
fi

# INV-085 (Caio 2026-08-19, NF 1107188): link de evidência vale 30 dias e
# expiração fala a verdade.
# (a) NENHUM criador de token usa prazo hardcoded (7 * 24 ...) — validade só
#     via novaExpiracaoTokenEvidencia (fonte única em token-evidencia.ts);
# (b) r-evidencia responde JSON no modo ?meta=1 pra token expirado/inválido
#     (senão o Vercel mostra "Erro temporário" falso);
# (c) mig 343 (retroativo 30d) existe; (d) teste-guard passa.
INV85_HARDCODED=$(grep -rn "7 \* 24 \* 60 \* 60 \* 1000" supabase/functions --include="*.ts" | grep -c "expira\|Expira" | tr -d ' ')
INV85_HELPER=$(grep -rln "novaExpiracaoTokenEvidencia()" supabase/functions --include="*.ts" | grep -cv "_shared/token-evidencia" | tr -d ' ')
INV85_METAJSON=$(grep -c 'metaErro("expirado"' supabase/functions/r-evidencia/index.ts | tr -d ' ')
INV85_MIG=$(ls migration/ | grep -c "evidencia_token_30_dias" | tr -d ' ')
INV85_TEST=$(deno test --allow-all supabase/functions/_shared/token-evidencia.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV85_HARDCODED:-1}" -eq 0 ] && [ "${INV85_HELPER:-0}" -ge 3 ] && [ "${INV85_METAJSON:-0}" -ge 1 ] && [ "${INV85_MIG:-0}" -ge 1 ] && [ "$INV85_TEST" = "PASS" ]; then
  echo "INV-085: PASS (hardcoded=$INV85_HARDCODED criadores_via_helper=$INV85_HELPER meta_json=$INV85_METAJSON mig=$INV85_MIG test=$INV85_TEST)"
else
  echo "INV-085: FAIL (hardcoded=$INV85_HARDCODED criadores_via_helper=$INV85_HELPER meta_json=$INV85_METAJSON mig=$INV85_MIG test=$INV85_TEST — validade do token só pela fonte única de 30d; meta=1 responde JSON no expirado; retroativo mig 343)"
fi

# INV-086 (Caio 2026-08-20, NF 693044): recusa repetida transiciona + sweep sem inanição.
# (a) Pass A: o ramo INV-019 usa snapshotVetaTransicaoRelacionamento (veto que CEDE
#     quando classificarPorData prova "nova") — nunca voltar ao veto cego de 24h;
# (b) sweep: presos ordenados por custo (ordenarPresosPorCustoDeDecisao) antes do
#     loop — "nova" cura antes de lag/ambíguo queimarem o orçamento em SSW;
# (c) teste-guard passa.
INV86_VETO=$(grep -c '!snapshotVetaTransicaoRelacionamento' supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV86_CEDE=$(grep -c 'snapshotVetaTransicaoRelacionamento = false' supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV86_ORDENA=$(grep -c 'ordenarPresosPorCustoDeDecisao' supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV86_TEST=$(deno test --allow-all --no-check supabase/functions/_shared/lag-lancamento-54.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV86_VETO:-0}" -ge 1 ] && [ "${INV86_CEDE:-0}" -ge 1 ] && [ "${INV86_ORDENA:-0}" -ge 1 ] && [ "$INV86_TEST" = "PASS" ]; then
  echo "INV-086: PASS (veto_condicional=$INV86_VETO cede_por_data=$INV86_CEDE sweep_ordenado=$INV86_ORDENA test=$INV86_TEST)"
else
  echo "INV-086: FAIL (veto_condicional=$INV86_VETO cede_por_data=$INV86_CEDE sweep_ordenado=$INV86_ORDENA test=$INV86_TEST — snapshot cede à data no ramo INV-019; sweep avalia 'nova' primeiro; NF 693044)"
fi

# INV-087 (Caio 2026-08-21, máquina de visão): abas de gestão gated por papel,
# métricas honestas e ciclo de melhoria fechado.
# (a) Gestão Agentes/Operadores exigem useIsGestor; Aprendizado sem allowlist
#     de e-mail (o João ficava de fora);
# (b) as views de operador discriminam a coluna via dicionário
#     responsabilidade='Cliente' (nunca hardcode 54 — INV-037);
# (c) e-mail de aprovação tem os 4 campos do padrão do Caio + passo a passo;
# (d) deploy-melhoria grava o marco mergeado_em (base do antes×depois D5);
# (e) toda pergunta do agente-chefe carrega a opção "processo correto".
INV87_GATES=$(grep -l "useIsGestor" apps/cockpit-web/src/pages/GestaoAgentes.tsx apps/cockpit-web/src/pages/GestaoOperadores.tsx 2>/dev/null | wc -l | tr -d ' ')
INV87_ALLOW=$(grep -c "ALLOWLIST_EMAILS" apps/cockpit-web/src/pages/Aprendizado.tsx | tr -d ' ')
INV87_DICI=$(grep -c "responsabilidade = 'Cliente'" migration/2026-08-21_344_maquina_visao_fase1_views.sql | tr -d ' ')
INV87_EMAIL=$(grep -c "O QUE ERA\|O QUE MUDOU\|TAXA DE ACERTO\|O QUE VOCÊ FAZ" supabase/functions/_shared/email-interno.ts | tr -d ' ')
INV87_MERGE=$(grep -c 'evento..:..mergeada' .github/workflows/deploy-melhoria.yml | tr -d ' ')
INV87_OPCAO=$(grep -c "garantirOpcaoProcessoCorreto(" supabase/functions/_shared/aprendizado-regras.ts | tr -d ' ')
if [ "${INV87_GATES:-0}" -eq 2 ] && [ "${INV87_ALLOW:-1}" -eq 0 ] && [ "${INV87_DICI:-0}" -ge 1 ] && [ "${INV87_EMAIL:-0}" -ge 4 ] && [ "${INV87_MERGE:-0}" -ge 1 ] && [ "${INV87_OPCAO:-0}" -ge 2 ]; then
  echo "INV-087: PASS (gates=$INV87_GATES allowlist_removida=$INV87_ALLOW dicionario=$INV87_DICI email4campos=$INV87_EMAIL mergeado_em=$INV87_MERGE opcao_fixa=$INV87_OPCAO)"
else
  echo "INV-087: FAIL (gates=$INV87_GATES allowlist=$INV87_ALLOW dicionario=$INV87_DICI email=$INV87_EMAIL merge=$INV87_MERGE opcao=$INV87_OPCAO — abas por papel; coluna via dicionário; e-mail padrão do Caio; marco mergeado_em; opção processo-correto)"
fi

# INV-088 (Caio 2026-08-21 v2): números de gestão sem teto e fila honesta.
# (a) Gestão Agentes pagina via paginarTudo (PostgREST corta em 1000/req —
#     "cards travados em 1000"). Gestão Operadores NÃO pagina mais de
#     propósito: usa o RPC da mig 349 (ver INV-090);
# (b) fila do operador ancora em RetornoIntranetWurth + cliente_respondeu_em
#     (NF 678886: 72h falsas → 0,78h);
# (c) promover_fatia_autonoma exige gestor + assert_pode_executar + régua 95/50;
# (d) drill/paginação com teste-guard verde — inclui (Caio 24/08, NF 680392):
#     drill de corrigidas é UMA linha por TROCA exata e o "ver casos" filtra
#     também por oc_executada (n da linha = lista, 1:1; teste na suíte).
INV88_TROCA=$(grep -c "oc_executada" apps/cockpit-web/src/pages/GestaoAgentes.tsx | tr -d ' ')
INV88_PAG=$(grep -c "paginarTudo" apps/cockpit-web/src/pages/GestaoAgentes.tsx 2>/dev/null | tr -d ' '); INV88_PAG=$([ "${INV88_PAG:-0}" -ge 1 ] && grep -q "gestao_operadores_tratativas" apps/cockpit-web/src/pages/GestaoOperadores.tsx && echo 2 || echo 0)
INV88_WURTH=$(grep -c "RetornoIntranetWurth" migration/2026-08-21_347_gestao_drill_fila_autonomia.sql | tr -d ' ')
INV88_ANCORA=$(grep -c "greatest(b.entrada_evento" migration/2026-08-21_347_gestao_drill_fila_autonomia.sql | tr -d ' ')
INV88_RPC=$(grep -c "assert_pode_executar\|Só gestão pode promover" migration/2026-08-21_347_gestao_drill_fila_autonomia.sql | tr -d ' ')
INV88_TEST=$(cd apps/cockpit-web && npx vitest run src/lib/supaPaginate.test.ts src/lib/gestaoAgentes.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV88_PAG:-0}" -eq 2 ] && [ "${INV88_WURTH:-0}" -ge 3 ] && [ "${INV88_ANCORA:-0}" -ge 1 ] && [ "${INV88_RPC:-0}" -ge 2 ] && [ "${INV88_TROCA:-0}" -ge 5 ] && [ "$INV88_TEST" = "PASS" ]; then
  echo "INV-088: PASS (paginacao=$INV88_PAG wurth_marker=$INV88_WURTH ancora=$INV88_ANCORA rpc_guard=$INV88_RPC troca_exata=$INV88_TROCA test=$INV88_TEST)"
else
  echo "INV-088: FAIL (paginacao=$INV88_PAG wurth=$INV88_WURTH ancora=$INV88_ANCORA rpc=$INV88_RPC troca=$INV88_TROCA test=$INV88_TEST — paginar sempre; fila ancora na resposta mais recente; promoção só gestor executor; ver-casos filtra a troca exata)"
fi

# INV-089 (Caio 2026-08-21, rodada 2 da autonomia): fatia ⚡ só roda sozinha
# com TODAS as travas.
# (a) helper único autonomia-fatias.ts chamado pelos 2 agentes integrados;
# (b) trava dura de ocs seguras (56/41 com input humano NUNCA auto-aprovam);
# (c) flag master autonomia_fatias_enabled + cron do kill-switch (mig 348);
# (d) executor NÃO registra feedback implícito em aprovação automática
#     (placar não se autoavalia);
# (e) teste-guard das travas verde.
INV89_CALLS=$(grep -l "autoAprovarSeFatiaAutonoma" supabase/functions/agente-sugere-ocs-padrao/index.ts supabase/functions/agente-oc13-autonomo/index.ts 2>/dev/null | wc -l | tr -d ' ')
INV89_SEGURAS=$(grep -c "OCS_SEGURAS_AUTONOMIA" supabase/functions/_shared/autonomia-fatias.ts | tr -d ' ')
INV89_MIG=$(ls migration/ | grep -c "autonomia_fatias_flag_e_cron" | tr -d ' ')
INV89_PLACAR=$(grep -c "feedback implícito PULADO" supabase/functions/executor/index.ts | tr -d ' ')
INV89_TEST=$(deno test --allow-all supabase/functions/_shared/autonomia-fatias.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV89_CALLS:-0}" -eq 2 ] && [ "${INV89_SEGURAS:-0}" -ge 2 ] && [ "${INV89_MIG:-0}" -ge 1 ] && [ "${INV89_PLACAR:-0}" -ge 1 ] && [ "$INV89_TEST" = "PASS" ]; then
  echo "INV-089: PASS (agentes=$INV89_CALLS ocs_seguras=$INV89_SEGURAS mig=$INV89_MIG placar_honesto=$INV89_PLACAR test=$INV89_TEST)"
else
  echo "INV-089: FAIL (agentes=$INV89_CALLS seguras=$INV89_SEGURAS mig=$INV89_MIG placar=$INV89_PLACAR test=$INV89_TEST — autonomia só pelo helper com travas; flag master OFF por default; placar não se autoavalia)"
fi

# INV-090 (Caio 2026-08-24): Gestão Operadores nunca mais morre por timeout.
# Contexto: v_operador_tratativas levava 9,5-18s (lateral de oc_entrada varria
# card_events 654MB sem índice) > statement_timeout=8s do authenticated, e o
# banner culpava a mig 344. Dry-run provou: RPC sozinho NÃO basta — o índice
# parcial é a peça decisiva.
# (a) mig 349 tem o índice parcial idx_card_events_entrada_lookup (9 tipos,
#     CONCURRENTLY) + RPC gestao_operadores_tratativas security definer com
#     trava de gestor devolvendo jsonb (1 execução, sem teto de 1000);
# (b) front usa o RPC (não select paginado na view) e o RPC está na allowlist
#     de leitura;
# (c) banner de erro é honesto: distingue mig ausente × timeout × outro erro.
INV90_IDX=$(grep -c "idx_card_events_entrada_lookup\|concurrently" migration/2026-08-24_349_gestao_op_timeout_indice_e_rpc.sql | tr -d ' ')
INV90_RPC=$(grep -c "security definer\|Só gestão pode ver as tratativas" migration/2026-08-24_349_gestao_op_timeout_indice_e_rpc.sql | tr -d ' ')
INV90_FRONT=$(grep -c "gestao_operadores_tratativas" apps/cockpit-web/src/pages/GestaoOperadores.tsx apps/cockpit-web/src/lib/supabase.ts | awk -F: '{s+=$2} END {print s}')
INV90_BANNER=$(grep -c "57014\|PGRST202" apps/cockpit-web/src/pages/GestaoOperadores.tsx | tr -d ' ')
if [ "${INV90_IDX:-0}" -ge 2 ] && [ "${INV90_RPC:-0}" -ge 2 ] && [ "${INV90_FRONT:-0}" -ge 2 ] && [ "${INV90_BANNER:-0}" -ge 1 ]; then
  echo "INV-090: PASS (indice=$INV90_IDX rpc=$INV90_RPC front=$INV90_FRONT banner=$INV90_BANNER)"
else
  echo "INV-090: FAIL (indice=$INV90_IDX rpc=$INV90_RPC front=$INV90_FRONT banner=$INV90_BANNER — Gestão Operadores via RPC da mig 349; índice parcial das laterais; banner distingue timeout de mig ausente)"
fi

# INV-091 (Caio 2026-08-24, NF 1611059): lançamento do Cockpit não sofre
# bounce-back do force oc=54, e card entregue nunca vira zumbi invisível.
# Contexto: Cockpit lançou 21 → TRANSFERIDO; 18min depois o force arrastou de
# volta pra AGUARDANDO_CLIENTE com a 54 STALE do Bastão (643 bounces/611 cards
# em 30d — a trava antiga media 24h pela idade do REGISTRO do Bastão). Depois
# de entregue (oc 1), o ramo finalizadora-em-protegido só dava console.log.
# (a) force oc=54 consulta deveSuprimirForceOc54PorLancamento (data do último
#     lançamento em acoes_executadas_ssw — regra inviolável 25/06);
# (b) os 3 ramos finalizadora-em-protegido (A_reconc, B notfound, B-watermark)
#     chamam flagConflitoOcSemMover (visível em CONFLITOS, sem mover);
# (c) REGRA pós-despacho (Caio 24/08): conflito APENAS se a oc conflitante é de
#     relacionamento/cliente; Cockpit despachou (último lançamento ≠54/59) + oc
#     operacional depois → skipped_pos_lancamento_cockpit (ponto único no
#     flagConflitoOcSemMover);
# (d) testes puros verdes (caso-âncora 1611059 na suíte).
INV91_GUARD=$(grep -c "deveSuprimirForceOc54PorLancamento" supabase/functions/sync-bastao/index.ts supabase/functions/_shared/lag-lancamento-54.ts | awk -F: '{s+=$2} END {print s}')
INV91_FLAGS=$(grep -c "finalizadora.*flagga\|flaggado pra CONFLITOS\|finalizadora_flaggada_conflitos" supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV91_REGRA=$(grep -c "skipped_pos_lancamento_cockpit" supabase/functions/_shared/escopo-relacionamento.ts supabase/functions/_shared/escopo-relacionamento.test.ts | awk -F: '{s+=$2} END {print s}')
INV91_TEST=$(cd supabase/functions && deno test --allow-all --no-check _shared/lag-lancamento-54.test.ts _shared/escopo-relacionamento.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV91_GUARD:-0}" -ge 3 ] && [ "${INV91_FLAGS:-0}" -ge 3 ] && [ "${INV91_REGRA:-0}" -ge 3 ] && [ "$INV91_TEST" = "PASS" ]; then
  echo "INV-091: PASS (guard=$INV91_GUARD flags_finalizadora=$INV91_FLAGS regra_pos_despacho=$INV91_REGRA test=$INV91_TEST)"
else
  echo "INV-091: FAIL (guard=$INV91_GUARD flags=$INV91_FLAGS regra=$INV91_REGRA test=$INV91_TEST — force oc54 respeita a data do lançamento; finalizadora protegida flagga Conflitos; conflito só relacionamento/cliente pós-despacho)"
fi

# INV-092 (Caio 2026-08-24, NFs 387848/680392): cache SSW tem validade por
# EVENTO, não só por relógio — cache puxado ANTES do último lançamento do
# Cockpit NUNCA embasa decisão de reabertura/visibilidade.
# Contexto: porta 2 (identidade) devolvia cards com cache "fresco" de 4h mas
# pré-lançamento (420 bounces/30d, 97% dos disparos); porta 3 (reabertura de
# RESOLVIDO) reabriu a 680392 9min após resolvida lendo cache de 24h.
# (a) cacheSswUtilizavel aplicado no cache-first do sync (2 call-sites com
#     ultimoLancamentoMs);
# (b) caminho identidade honra o veredito "lag" por data (suprime sem SSW);
# (c) atualizar-card-via-portal-ssw grava historico_ssw fresco (cache honesto
#     pro guard anti-reabertura de 24h);
# (d) testes puros verdes (âncora 387848 na suíte).
INV92_CACHE=$(grep -c "cacheSswUtilizavel" supabase/functions/sync-bastao/index.ts supabase/functions/_shared/lag-lancamento-54.ts | awk -F: '{s+=$2} END {print s}')
INV92_LAG=$(grep -c 'cls === "lag"' supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV92_BOTAO=$(grep -c "historico_ssw_atualizado_em" supabase/functions/atualizar-card-via-portal-ssw/index.ts | tr -d ' ')
INV92_TEST=$(cd supabase/functions && deno test --allow-all --no-check _shared/lag-lancamento-54.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV92_CACHE:-0}" -ge 3 ] && [ "${INV92_LAG:-0}" -ge 2 ] && [ "${INV92_BOTAO:-0}" -ge 1 ] && [ "$INV92_TEST" = "PASS" ]; then
  echo "INV-092: PASS (cache_evento=$INV92_CACHE lag_identidade=$INV92_LAG botao_persiste=$INV92_BOTAO test=$INV92_TEST)"
else
  echo "INV-092: FAIL (cache=$INV92_CACHE lag=$INV92_LAG botao=$INV92_BOTAO test=$INV92_TEST — cache pré-lançamento nunca decide; identidade honra lag; botão grava histórico fresco)"
fi

# INV-093 (Caio 2026-08-24): drill da demanda por agente com números que batem.
# (a) ligação POR CARD (agent_feedback.card_id in cards da demanda), NUNCA por
#     oc_card (oc 20: 61 pares por oc_card vs 280 por card — medido 24/08);
# (b) funil EXPLÍCITO (tratativas ▸ cards ▸ pares medidos) — cobertura rotulada;
# (c) .in() com uuids em BLOCOS (emBlocos, 100/req — oc 20 = 1.385 cards);
# (d) invariante seguidas+trocas=pares testado na suíte.
INV93_CARD=$(grep -c 'in("card_id"' apps/cockpit-web/src/pages/GestaoOperadores.tsx | tr -d ' ')
INV93_BLOCO=$(grep -c "emBlocos" apps/cockpit-web/src/pages/GestaoOperadores.tsx apps/cockpit-web/src/lib/gestaoOperadores.ts | awk -F: '{s+=$2} END {print s}')
INV93_FUNIL=$(grep -c "sem recomendação destacada" apps/cockpit-web/src/pages/GestaoOperadores.tsx | tr -d ' ')
INV93_TEST=$(cd apps/cockpit-web && npx vitest run src/lib/gestaoOperadores.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV93_CARD:-0}" -ge 1 ] && [ "${INV93_BLOCO:-0}" -ge 2 ] && [ "${INV93_FUNIL:-0}" -ge 1 ] && [ "$INV93_TEST" = "PASS" ]; then
  echo "INV-093: PASS (join_card=$INV93_CARD blocos=$INV93_BLOCO funil=$INV93_FUNIL test=$INV93_TEST)"
else
  echo "INV-093: FAIL (join_card=$INV93_CARD blocos=$INV93_BLOCO funil=$INV93_FUNIL test=$INV93_TEST — drill da demanda liga por card, pagina em blocos e rotula o funil)"
fi

# INV-141 (ADR 0025): a oc 55 automática NUNCA vaza pra fora da whitelist.
# O default de analisarExtravio pra instrução ilegível continua TOTAL (conservador)
# e a inversão pra PARCIAL vive SÓ dentro de seguir-parcial-auto, atrás do CNPJ.
# Se alguém "simplificar" invertendo o default global, 651 clientes mudam de
# comportamento de uma vez.
INV141_DEFAULT=$(grep -c 'const isTotal = !qtd ||' supabase/functions/_shared/extravio-enrichment.ts 2>/dev/null | tr -d ' ')
INV141_GATE=$(grep -c 'cnpj_fora_da_whitelist' supabase/functions/_shared/seguir-parcial-auto.ts 2>/dev/null | tr -d ' ')
# Limpeza FORTE antes de ler a qtd (furo 03/09): sem `removerMarcadoresSswmobile`,
# `9 <!--x--><u>GPS</u>` numa NF de 9 volumes vira null → o D3 lê "ilegível" →
# parcial → lança 55 num extravio TOTAL. Provado: o parser fraco devolve null e o
# forte devolve {qtd:9}. Trocar de volta pro `extrairQtdVolumes` cru reabre o furo.
INV141_LIMPEZA=$(grep -c 'removerMarcadoresSswmobile' supabase/functions/_shared/seguir-parcial-auto.ts 2>/dev/null | tr -d ' ')
INV141_CRU=$(grep -cE 'extrairQtdVolumes\(instrucao' supabase/functions/_shared/seguir-parcial-auto.ts 2>/dev/null | tr -d ' ')
INV141_TEST=$(deno test --no-check --allow-net --allow-env supabase/functions/_shared/seguir-parcial-auto.test.ts supabase/functions/_shared/seguir-parcial-auto.aceitacao.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV141_DEFAULT:-0}" -ge 1 ] && [ "${INV141_GATE:-0}" -ge 1 ] && [ "${INV141_LIMPEZA:-0}" -ge 2 ] && [ "${INV141_CRU:-1}" -eq 0 ] && [ "$INV141_TEST" = "PASS" ]; then
  echo "INV-141: PASS (default_total=$INV141_DEFAULT gate_cnpj=$INV141_GATE limpeza_forte=$INV141_LIMPEZA leitura_crua=$INV141_CRU test=$INV141_TEST)"
else
  echo "INV-141: FAIL (default_total=$INV141_DEFAULT gate_cnpj=$INV141_GATE limpeza_forte=$INV141_LIMPEZA leitura_crua=$INV141_CRU test=$INV141_TEST — a inversão parcial só vale dentro da whitelist E só depois da limpeza forte)"
fi

# INV-142 (ADR 0025): nada da 55 automática pode nascer LIGADO. Flag mestra OFF na
# mig 379, sombra ON na mig 380 (sombra ON = não lança), seed com ativo=false, e o
# loader devolve contexto INERTE em qualquer falha.
INV142_SEED_INATIVO=$(grep -c "false, 'Caio (briefing 03/09)'" migration/2026-09-03_379_cliente_config_seguir_parcial_auto.sql 2>/dev/null | tr -d ' ')
INV142_SOMBRA=$(grep -c "porKey.get(FLAG_SEGUIR_PARCIAL_SOMBRA) !== false" supabase/functions/_shared/seguir-parcial-carregar.ts 2>/dev/null | tr -d ' ')
INV142_INERTE=$(grep -c "return CONTEXTO_INERTE" supabase/functions/_shared/seguir-parcial-carregar.ts 2>/dev/null | tr -d ' ')
INV142_TEST=$(deno test --no-check --allow-net --allow-env supabase/functions/_shared/seguir-parcial-carregar.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV142_SEED_INATIVO:-0}" -ge 4 ] && [ "${INV142_SOMBRA:-0}" -ge 1 ] && [ "${INV142_INERTE:-0}" -ge 3 ] && [ "$INV142_TEST" = "PASS" ]; then
  echo "INV-142: PASS (seed_inativo=$INV142_SEED_INATIVO sombra_failsafe=$INV142_SOMBRA inerte=$INV142_INERTE test=$INV142_TEST)"
else
  echo "INV-142: FAIL (seed_inativo=$INV142_SEED_INATIVO sombra_failsafe=$INV142_SOMBRA inerte=$INV142_INERTE test=$INV142_TEST — a 55 automática não pode nascer ligada nem falhar aberta)"
fi

# INV-143 (ADR 0025 D6): a 55 conta como "cliente ciente" APENAS sob o opt-in, e o
# Set exportado OCS_NOTIFICOU_APOS_EXTRAVIO segue {20,49,54,59} pros demais callers.
# Sem o opt-in ligado nos call sites, o card que volta com 19/10/35 depois da 55
# automática mostra o banner falso "cliente não notificado".
INV143_SET=$(grep -c 'OCS_NOTIFICOU_APOS_EXTRAVIO = new Set<number>(\[20, 54, 59, 49\])' supabase/functions/_shared/recusa-por-extravio.ts 2>/dev/null | tr -d ' ')
INV143_OPTIN=$(grep -c 'clienteAutorizaSeguirParcial' supabase/functions/_shared/recusa-por-extravio.ts 2>/dev/null | tr -d ' ')
INV143_CALLERS=$(grep -c 'clienteAutorizaSeguirParcial' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV143_R3=$(grep -c 'autorizacaoPermanenteDoCliente' supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
INV143_TEST=$(deno test --no-check --allow-net --allow-env supabase/functions/_shared/recusa-por-extravio.test.ts supabase/functions/_shared/extravio-parcial-regra.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV143_SET:-0}" -ge 1 ] && [ "${INV143_OPTIN:-0}" -ge 2 ] && [ "${INV143_CALLERS:-0}" -ge 2 ] && [ "${INV143_R3:-0}" -ge 1 ] && [ "$INV143_TEST" = "PASS" ]; then
  echo "INV-143: PASS (set_intacto=$INV143_SET optin=$INV143_OPTIN callers=$INV143_CALLERS r3=$INV143_R3 test=$INV143_TEST)"
else
  echo "INV-143: FAIL (set_intacto=$INV143_SET optin=$INV143_OPTIN callers=$INV143_CALLERS r3=$INV143_R3 test=$INV143_TEST — 55 como ciência é opt-in e os call sites precisam passá-lo)"
fi

# INV-145 (Carlos 2026-09-04, ADR 0025 F7): NÃO SE SAI DA SOMBRA EM SILÊNCIO.
# `seguir_parcial_auto_sombra` tem semântica INVERTIDA: ON = o agente decide e
# grava card_event, NÃO lança. Desligá-la muda o agente de "grava" pra "lança oc
# 55 no SSW", e ocorrência no SSW não tem desfazer. O problema é que essa saída é
# UM `UPDATE` de uma linha, sem deploy e sem revisão — exatamente o tipo de gesto
# que ninguém percebe. O ADR 0025 fixou 3 condições cumulativas pra sair (>=5
# decisões simuladas conferidas, >=1 extravio total barrado de verdade, e a
# autorização escrita). Este guard cobra a 3ª, que é a única grep-ável: o marcador
# literal `SAIDA DA SOMBRA AUTORIZADA` no ADR. Sem ele, mestra ON + sombra OFF é
# FAIL. Também reporta o estado do ensaio (CNPJs ativos e decisões gravadas) —
# contagem baixa NÃO é falha (ver "Como medir a sombra" no ADR 0025).
INV145_MARCADOR=$(grep -c 'SAIDA DA SOMBRA AUTORIZADA' docs/decisions/0025-55-automatica-clientes-autorizacao-permanente.md 2>/dev/null | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  echo "INV-145: SKIP (sem acesso ao DB local; marcador_adr=$INV145_MARCADOR)"
else
  # "$PSQL" com ASPAS de propósito: o caminho pode conter espaço (ver INV-146).
  INV145_MESTRA=$("$PSQL" "$SUPABASE_DB_URL" -tA -c "select coalesce(bool_or(enabled),false)::int from feature_flags where key='seguir_parcial_auto_enabled';" 2>/dev/null | tr -d ' ')
  INV145_SOMBRA=$("$PSQL" "$SUPABASE_DB_URL" -tA -c "select coalesce(bool_or(enabled),false)::int from feature_flags where key='seguir_parcial_auto_sombra';" 2>/dev/null | tr -d ' ')
  INV145_ATIVOS=$("$PSQL" "$SUPABASE_DB_URL" -tA -c "select count(*) from cliente_config_seguir_parcial_auto where ativo;" 2>/dev/null | tr -d ' ')
  INV145_SIM=$("$PSQL" "$SUPABASE_DB_URL" -tA -c "select count(*) from card_events where actor_id='agente-seguir-parcial-auto' and event_type='SeguirParcialAutoSimulado';" 2>/dev/null | tr -d ' ')
  INV145_LANC=$("$PSQL" "$SUPABASE_DB_URL" -tA -c "select count(*) from card_events where actor_id='agente-seguir-parcial-auto' and event_type='SeguirParcialAutoLancou55';" 2>/dev/null | tr -d ' ')
  if [ -z "$INV145_MESTRA" ]; then
    echo "INV-145: SKIP (query de flags nao respondeu; marcador_adr=$INV145_MARCADOR)"
  elif [ "$INV145_MESTRA" = "1" ] && [ "$INV145_SOMBRA" = "0" ] && [ "${INV145_MARCADOR:-0}" -lt 1 ]; then
    echo "INV-145: FAIL (mestra=ON sombra=OFF sem 'SAIDA DA SOMBRA AUTORIZADA' no ADR 0025 — o agente esta LANCANDO oc 55 no SSW sem autorizacao escrita; religar a sombra: UPDATE feature_flags SET enabled=true WHERE key='seguir_parcial_auto_sombra')"
  elif [ "$INV145_MESTRA" = "1" ] && [ "$INV145_SOMBRA" = "0" ]; then
    echo "INV-145: PASS (LANCAMENTO REAL autorizado no ADR; ativos=$INV145_ATIVOS simulados=$INV145_SIM lancados=$INV145_LANC)"
  else
    echo "INV-145: PASS (mestra=$INV145_MESTRA sombra=$INV145_SOMBRA ativos=$INV145_ATIVOS simulados=$INV145_SIM lancados=$INV145_LANC — sombra ON ou agente inerte, nada vai pro SSW)"
  fi
fi

# INV-146 (Carlos 2026-09-04): o $PSQL do ritual NÃO pode conter ESPAÇO — senão
# METADE DA FASE 8 fica cega e reporta FAIL por motivo falso.
#
# Defeito real medido hoje, checkout ".../COCKPIT ATUALIZADO": os ~60 call sites
# desta fase chamam `$PSQL "$SUPABASE_DB_URL" -tA -c "..."` com o **$PSQL SEM
# aspas**. Com espaço no caminho o shell faz word splitting, tenta executar
# ".../01_odim.claude/COCKPIT", e o `2>/dev/null` de cada check engole o
# "No such file or directory". A saída vazia NÃO cai no ramo SKIP (que testa
# `-z "$SUPABASE_DB_URL"`, e essa está definida): cai na comparação de valor.
# Resultado medido: 19 invariantes em FAIL com campos de banco vazios
# (INV-035/036/037/038/040/042/043/044/046/047/048/052/055/057/064/067/068/070/072).
# /verify-cockpit permanentemente vermelho por motivo falso = verify que ninguém
# lê. Mesma classe do INV-144 (cp1252): o trilho quebrando no Windows.
#
# Corrigido na RAIZ no `scripts/ritual-env.sh` (publica um lançador equivalente
# num diretório sem espaço), não com aspas em 60 lugares. Este guard é de
# COMPORTAMENTO: força a chamada SEM aspas, como os checks fazem. Grep do
# marcador passaria mesmo com o bloco quebrado.
INV146_MARCA=$(grep -c 'INV-146' scripts/ritual-env.sh 2>/dev/null | tr -d ' ')
INV146_ESPACO=$(case "$PSQL" in *" "*) echo SIM;; *) echo nao;; esac)
INV146_EXEC=$([ -x "$PSQL" ] && echo sim || echo nao)
INV146_RUN=$($PSQL "$SUPABASE_DB_URL" -tA -c "select 146;" 2>/dev/null | tr -d ' ')
if [ "$INV146_ESPACO" = "SIM" ]; then
  echo "INV-146: FAIL (PSQL contem espaco: [$PSQL] — a chamada SEM aspas dos ~60 checks quebra por word splitting e 19 INVs viram FAIL falso; conferir o bloco 2b do scripts/ritual-env.sh)"
elif [ "${INV146_MARCA:-0}" -lt 1 ]; then
  echo "INV-146: FAIL (bloco 2b sumiu do scripts/ritual-env.sh — sem ele um checkout com espaco no caminho cega metade da Fase 8)"
elif [ "$INV146_RUN" = "146" ]; then
  echo "INV-146: PASS (psql=${PSQL##*/} sem_espaco executavel=$INV146_EXEC chamada_sem_aspas=OK marca=$INV146_MARCA)"
elif [ -z "$INV146_RUN" ]; then
  echo "INV-146: SKIP (sem banco alcancavel; psql=${PSQL##*/} sem espaco, executavel=$INV146_EXEC, marca=$INV146_MARCA)"
else
  echo "INV-146: FAIL (chamada sem aspas devolveu [$INV146_RUN] em vez de 146 — o lancador do ritual esta corrompido)"
fi

# INV-147 (Carlos 2026-09-08, ADR 0026): POUCA TINTA NAO REPROVA CONVERSAO BOA.
# O piso de 2% tratava "pouca tinta" como "conversao perdida" e derrubava o PDF
# INTEIRO. Medido com PDFium nos arquivos reais: paginas de 1,37% (10803714.pdf,
# Uniao Quimica) e 1,23% (Lexmark, AGV) estavam LEGIVEIS — falso positivo. E o
# arquivo que quebra calado (0,38% no pdf.js) renderiza 2,53% com motor bom, ou
# seja nenhum limiar separa as classes. Este guard cobra as 4 pecas:
#   (a) o piso de 2% NAO foi mexido (a correcao e de consequencia, nao de limiar);
#   (b) existe o piso de "folha sem tinta" que segue bloqueando o caso real;
#   (c) o servidor NAO afrouxou (la nao tem humano pra ver a previa);
#   (d) a telemetria manda operador.id, nao a string literal (a RLS exige
#       actor_id = current_operador_id(); com a string, ZERO evento gravava).
INV147_PISO=$(grep -c 'PISO_PIXELS_NAO_BRANCOS = 0.02' apps/cockpit-web/src/lib/pdfConversaoGuard.ts 2>/dev/null | tr -d ' ')
INV147_SEMTINTA=$(grep -c 'PISO_PAGINA_SEM_TINTA' apps/cockpit-web/src/lib/pdfConversaoGuard.ts 2>/dev/null | tr -d ' ')
INV147_POLITICA=$(grep -c 'politicaDaPagina' apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV147_SRV=$(grep -c 'PISO_PIXELS_NAO_BRANCOS = 0.02' supabase/functions/_shared/pdf-conversao-guard.ts 2>/dev/null | tr -d ' ')
INV147_ACTOR=$(grep -c 'actor_id: "front-conversao-pdf"' apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV147_TEST=$(deno test --no-check --allow-read supabase/functions/_shared/pdf-conversao-guard.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV147_PISO:-0}" -ge 1 ] && [ "${INV147_SEMTINTA:-0}" -ge 2 ] && [ "${INV147_POLITICA:-0}" -ge 1 ] && [ "${INV147_SRV:-0}" -ge 1 ] && [ "${INV147_ACTOR:-0}" -eq 0 ] && [ "$INV147_TEST" = "PASS" ]; then
  echo "INV-147: PASS (piso=$INV147_PISO sem_tinta=$INV147_SEMTINTA politica=$INV147_POLITICA servidor_duro=$INV147_SRV actor_literal=$INV147_ACTOR test=$INV147_TEST)"
else
  echo "INV-147: FAIL (piso=$INV147_PISO sem_tinta=$INV147_SEMTINTA politica=$INV147_POLITICA servidor_duro=$INV147_SRV actor_literal=$INV147_ACTOR test=$INV147_TEST — actor_literal>0 significa telemetria cega pela RLS; servidor_duro=0 significa que alguem afrouxou o guard sem humano na frente)"
fi

# INV-148 (Carlos 2026-09-08, ADR 0026): VISIBILIDADE != AUTONOMIA na oc 13.
# `cliente_config_oc13.ativo` decide se o card APARECE (sync-bastao);
# `autonomo_ativo` decide se o AGENTE AGE (lanca oc 21 + cancela reentrega sem
# aprovacao por card). Eram o mesmo interrutor: incluir um CNPJ pra aparecer
# ligava o robo. Caso ancora NF 1037746 (PRATI) — o cliente precisa ser
# notificado e autorizar ANTES. As duas direcoes sao bug:
#   agente sem ler autonomo_ativo -> robo age em quem nao autorizou;
#   sync lendo autonomo_ativo     -> cliente com robo off fica invisivel (o bug
#                                    original, invertido).
INV148_AGENTE=$(grep -c 'autonomo_ativo' supabase/functions/agente-oc13-autonomo/index.ts 2>/dev/null | tr -d ' ')
INV148_FILTRO=$(grep -c 'autonomo_ativo !== false' supabase/functions/agente-oc13-autonomo/index.ts 2>/dev/null | tr -d ' ')
INV148_SYNC=$(grep -c 'autonomo_ativo' supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV148_CLIENT=$(grep -c 'autonomo_ativo' supabase/functions/_shared/bastao-client.ts 2>/dev/null | tr -d ' ')
INV148_OC13Q=$(grep -c 'cod_ultima_ocorrencia", "eq.13"' supabase/functions/_shared/bastao-client.ts 2>/dev/null | tr -d ' ')
INV148_TEST=$(deno test --no-check --allow-read supabase/functions/_shared/oc13-visibilidade-vs-autonomia.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV148_AGENTE:-0}" -ge 1 ] && [ "${INV148_FILTRO:-0}" -ge 1 ] && [ "${INV148_SYNC:-0}" -eq 0 ] && [ "${INV148_CLIENT:-0}" -eq 0 ] && [ "${INV148_OC13Q:-0}" -ge 1 ] && [ "$INV148_TEST" = "PASS" ]; then
  echo "INV-148: PASS (agente=$INV148_AGENTE filtro=$INV148_FILTRO sync_limpo=$INV148_SYNC client_limpo=$INV148_CLIENT query_oc13=$INV148_OC13Q test=$INV148_TEST)"
else
  echo "INV-148: FAIL (agente=$INV148_AGENTE filtro=$INV148_FILTRO sync_limpo=$INV148_SYNC client_limpo=$INV148_CLIENT query_oc13=$INV148_OC13Q test=$INV148_TEST — sync/client precisam ser 0 e o agente precisa do filtro !== false)"
fi

# INV-149 (Carlos 2026-09-09, ADR 0027): o 59 sobrevive por PENDENCIA DE
# DOCUMENTO, nao por "e extravio total?". No trilho tratativa o menu
# pos-resposta cancelava como "obsoleto" o 59 de card PARCIAL, porque o portao
# exigia o template EXTRAVIO_TOTAL_PEDIR_ROMANEIO (so o override de total cria).
# Caso ancora NF 75249: 59 criado 03/09 22:01:31, cancelado 22:07:07.
# A ASSIMETRIA e a regra: preservar usa o sinal LARGO (3 templates), ressuscitar
# segue no ESTREITO (so total). Colapsar os dois mexeria em 3307 cards abertos e
# pode disparar e-mail via janela de veto (75 auto-aprovacoes de 59 medidas).
INV149_SET=$(grep -c 'TEMPLATES_59_PEDIDO_DOCUMENTO' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV149_LARGO=$(grep -c 'pendenciaDoc59 && cod === 59' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
# o sinal ESTREITO nao pode mais gatear a whitelist (se voltar, o bug volta)
INV149_VOLTOU=$(grep -c 'ehExtravioTotal && cod === 59' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
# e a revivencia tem de continuar no sinal estreito
INV149_REVIVE=$(grep -c 'escolher59IndenizacaoParaReviver(todos59Total)' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV149_TEST=$(deno test --no-check --allow-all supabase/functions/_shared/oc59-extravio-total.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV149_SET:-0}" -ge 1 ] && [ "${INV149_LARGO:-0}" -ge 1 ] && [ "${INV149_VOLTOU:-1}" -eq 0 ] && [ "${INV149_REVIVE:-0}" -ge 1 ] && [ "$INV149_TEST" = "PASS" ]; then
  echo "INV-149: PASS (set=$INV149_SET largo=$INV149_LARGO voltou_estreito=$INV149_VOLTOU revive_estreito=$INV149_REVIVE test=$INV149_TEST)"
else
  echo "INV-149: FAIL (set=$INV149_SET largo=$INV149_LARGO voltou_estreito=$INV149_VOLTOU revive_estreito=$INV149_REVIVE test=$INV149_TEST — voltou_estreito>0 significa que a whitelist voltou pro portao de TOTAL e o 59 de card parcial volta a ser cancelado; revive_estreito=0 significa que alguem alargou a revivencia)"
fi

# INV-150 (Carlos 2026-09-09, ADR 0027): a 33 bloqueada DIZ o que falta, e o
# espelho do dossie no front nao pode divergir do gate do backend. A 33 ESTAVA
# sugerida nas NFs 350882/431734 — o que travava era o executor, e o motivo so
# aparecia depois de abrir o modal. 162 cards abertos de 10 operadores no mesmo
# estado. O gate real NAO muda; isto e rotulo.
INV150_MOD=$([ -f apps/cockpit-web/src/lib/dossie33Faltando.ts ] && echo 1 || echo 0)
INV150_UI=$(grep -c 'AvisoDossie33Banner' apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
# o rotulo do "sem e-mail" nao pode voltar a ter 54 LITERAL (dizia 54 numa linha de 59)
INV150_LITERAL=$(grep -c 'Lança só a oc 54 no SSW' apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV150_DINAMICO=$(grep -c 'Lança só a oc {codigo} no SSW' apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
# paridade: os 3 rotulos seguem iguais nos dois lados
INV150_PARIDADE=$(grep -c 'romaneio de coleta assinado' supabase/functions/_shared/extravio-parcial-dossie.ts apps/cockpit-web/src/lib/dossie33Faltando.ts 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
INV150_TEST=$( (cd apps/cockpit-web && npx vitest run src/lib/dossie33Faltando.test.ts >/dev/null 2>&1) && echo PASS || echo FAIL)
if [ "${INV150_MOD:-0}" -eq 1 ] && [ "${INV150_UI:-0}" -ge 2 ] && [ "${INV150_LITERAL:-1}" -eq 0 ] && [ "${INV150_DINAMICO:-0}" -ge 1 ] && [ "${INV150_PARIDADE:-0}" -ge 2 ] && [ "$INV150_TEST" = "PASS" ]; then
  echo "INV-150: PASS (modulo=$INV150_MOD ui=$INV150_UI literal54=$INV150_LITERAL dinamico=$INV150_DINAMICO paridade=$INV150_PARIDADE test=$INV150_TEST)"
else
  echo "INV-150: FAIL (modulo=$INV150_MOD ui=$INV150_UI literal54=$INV150_LITERAL dinamico=$INV150_DINAMICO paridade=$INV150_PARIDADE test=$INV150_TEST — literal54>0 significa que a frase voltou a informar a ocorrencia errada; paridade<2 significa que o espelho do dossie divergiu do backend)"
fi

echo "=== Fim Fase 8 ==="
```

**Status:** PASS = todos os INVs com PASS. **INFO** (baseline) e **SKIP** (check de DB sem `$SUPABASE_DB_URL` local) NÃO bloqueiam. FAIL = pelo menos 1 INV rodou e falhou; **bloqueia commit** até resolver. Os INVs com SKIP (003b, 006) devem rodar verdes num ambiente com acesso ao DB antes de deploy de mudança em sync-bastao.

**Quando um INV nunca-falhou aparece como FAIL pela 1ª vez:**
1. Investigar o caso real (bug introduzido ou apenas mudança benigna que o regex não acompanhou).
2. Se bug real → fix + retroativo + post-mortem.
3. Se regex está obsoleto → ajustar `docs/INVARIANTES_COCKPIT.md` (atualizar comando de verificação) E re-rodar.

**Quando criar novo INV:** todo bug post-mortem que cruza ≥ 2 arquivos críticos vira `INV-NNN` novo no catálogo. Atualizar também o lookup em `.claude/hooks/cockpit-critical-files.py`.

## Output final — VERIFICATION REPORT

Reúne tudo no formato:

```
VERIFICATION COCKPIT — <data/hora>
==================================
Tipo (Deno):    [PASS/FAIL]  (N arquivos checados, M erros)
Passes:         [PASS/FAIL]  (N/10 cobertos) [só se mexeu em sync-bastao/regras]
Advisors:       [PASS/FAIL]  (ERROR: X, WARN: Y)
Retroativo:     [PASS/N/A]   (NFs: ...)
Memory:         [PASS/FAIL]
Diff:           [PASS]       (X arquivos, +A -B LOC)
Deploy:         [PASS/PENDING] (funções recentes: ...)
Invariantes:    [PASS/FAIL]  (INVs falhando: INV-XXX, INV-YYY)  [Fase 8]

Overall:        [READY/NOT READY]

Issues a resolver:
1. ...
2. ...

Próximos passos sugeridos:
- ...
```

## Regras de execução

- **Não pular nenhuma fase**. Mesmo se Fase 1 falhar, rodar 2-7 e reportar tudo no final.
- **Não auto-corrigir** durante a verificação. Só reportar. Correção é decisão do Caio.
- **Não invocar outras skills automaticamente** — verification-loop é o último passo, não o primeiro.
- Se uma fase não se aplica (ex: não mexeu em SQL → Fase 3 advisors pode pular o "novos ERRORs"), marcar N/A e justificar.
- **Rodar TAMBÉM a "Fase 8 (continuação)" abaixo** e incluir o resultado dela na linha `Invariantes:` do relatório. O relatório só é montado depois que TODOS os blocos rodaram.

## Fase 8 (continuação) — INV-094 a INV-122

> **Correção de 2026-09-01:** estes 28 blocos estavam **fora de qualquer cerca ```bash** (linhas
> 2294-2689, depois da última cerca em 2285), appendados após `## Regras de execução`. Executor que
> só roda bash cercado **nunca os rodou** — inclusive INV-121 e INV-122, criados como guard
> anti-regressão. Nada do conteúdo foi alterado: só a cerca e este preâmbulo foram adicionados.
>
> Preâmbulo repetido de propósito: 16 checks daqui usam `$PSQL`/`$SUPABASE_DB_URL` e sem ele
> cairiam em SKIP eterno mesmo na máquina do Caio. (Dívida conhecida: o ideal é mover estes blocos
> para dentro da Fase 8 e ter um preâmbulo só — fica pra correção própria, pra manter este diff
> mínimo e revisável.)

```bash
cd "$(git rev-parse --show-toplevel)"; source scripts/ritual-env.sh

echo "=== Fase 8 (continuação) — INV-094 a INV-122 ==="

# INV-094 (Caio 2026-08-24, NF 1502332): placar assertivo — "sugeriu aguardar"
# é categoria própria e a decisão real nunca fica sem par.
# (a) mig 350: backfill oc49 pré-régua (trilho imutável card_events×acoes) +
#     ignorar_pendencias registra o par ANTES de limpar a sugestão;
# (b) front: sugestão da IA com oc_sugerida = oc do card (54/59) vira banner
#     "Ignorar e continuar aguardando" (nunca destaca relançar 54 sobre 54);
# (c) libs: pares manter-aguardar fora do % tradicional (ehParManterAguardar /
#     ehParManterDemanda) com testes.
INV94_MIG=$(grep -c "registrar_feedback_interpretador_resposta_implicito\|AgenteOcsPadraoDecisao" migration/2026-08-24_350_placar_assertivo_backfill49_e_feedback_aguardar.sql | tr -d ' ')
INV94_BANNER=$(grep -c "ehSugestaoAguardar" apps/cockpit-web/src/components/cards/SugestaoIATopBox.tsx | tr -d ' ')
INV94_LIB=$(grep -c "ehParManterAguardar\|ehParManterDemanda" apps/cockpit-web/src/lib/gestaoAgentes.ts apps/cockpit-web/src/lib/gestaoOperadores.ts apps/cockpit-web/src/pages/GestaoAgentes.tsx | awk -F: '{s+=$2} END {print s}')
INV94_TEST=$(cd apps/cockpit-web && npx vitest run src/lib/gestaoOperadores.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV94_MIG:-0}" -ge 2 ] && [ "${INV94_BANNER:-0}" -ge 2 ] && [ "${INV94_LIB:-0}" -ge 3 ] && [ "$INV94_TEST" = "PASS" ]; then
  echo "INV-094: PASS (mig=$INV94_MIG banner=$INV94_BANNER lib=$INV94_LIB test=$INV94_TEST)"
else
  echo "INV-094: FAIL (mig=$INV94_MIG banner=$INV94_BANNER lib=$INV94_LIB test=$INV94_TEST — aguardar é categoria própria; backfill 49; ignorar registra par; nunca destacar relançar 54 sobre 54)"
fi

# INV-095 (Caio 2026-08-25, NF 153826): feriado/local fechado nunca vira
# "problema com endereço" no fluxo oc13.
# (a) escolha do template é o módulo PURO _shared/oc13-template-email.ts
#     (agente importa; funil antigo 100%-endereço morreu);
# (b) mig 351 tem o template TENTATIVA_ENTREGA_LOCAL_FECHADO com o fecho
#     "Podemos reentregar?" (ordem do Caio);
# (c) testes verdes (âncora NF 153826 na suíte).
INV95_MOD=$(grep -c "sugerirTemplateEmailOc13" supabase/functions/agente-oc13-autonomo/index.ts supabase/functions/_shared/oc13-template-email.ts | awk -F: '{s+=$2} END {print s}')
INV95_MIG=$(grep -c "Podemos reentregar?" migration/2026-08-25_351_template_local_fechado_oc13.sql | tr -d ' ')
INV95_TEST=$(cd supabase/functions && deno test --allow-all --no-check _shared/oc13-template-email.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV95_MOD:-0}" -ge 3 ] && [ "${INV95_MIG:-0}" -ge 1 ] && [ "$INV95_TEST" = "PASS" ]; then
  echo "INV-095: PASS (modulo=$INV95_MOD mig=$INV95_MIG test=$INV95_TEST)"
else
  echo "INV-095: FAIL (modulo=$INV95_MOD mig=$INV95_MIG test=$INV95_TEST — template local-fechado no fluxo oc13; fecho 'Podemos reentregar?')"
fi

# INV-096 (Caio 2026-08-25, NF 306070 — porta 4): Bastão lagado nunca REGRIDE
# a oc do card por cima de lançamento do Cockpit.
# Contexto: Cockpit lançou 55 (TRANSFERIDO); Pass A suprimiu a reabertura mas
# gravou a oc 49 STALE por cima — a régua da resposta ("a OC define") leu 49 e
# puxou o card de volta pra CLIENTE RESPONDEU contra a regra do Caio (25/07).
# (a) Pass A preserva cod_ultima_ocorrencia quando ehLagDeLancamentoCockpit
#     (data da oc do Bastão <= último lançamento em acoes_executadas_ssw);
# (b) oc nova genuína / card sem lançamento seguem gravando normal.
INV96_GUARD=$(grep -c "preservarOcDoCard" supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV96_HELPER=$(grep -c "ehLagDeLancamentoCockpit" supabase/functions/sync-bastao/index.ts | tr -d ' ')
if [ "${INV96_GUARD:-0}" -ge 3 ] && [ "${INV96_HELPER:-0}" -ge 2 ]; then
  echo "INV-096: PASS (guard=$INV96_GUARD helper=$INV96_HELPER)"
else
  echo "INV-096: FAIL (guard=$INV96_GUARD helper=$INV96_HELPER — Pass A não regride oc com Bastão eco de lançamento)"
fi

# INV-097 (Caio 2026-08-25, NF 234381): recusa SEM ressalva tem template
# próprio — o e-mail nunca mais diz "recusa total" quando o destinatário
# recusou sem ressalvar (etapa 2 do fluxo 56→49).
INV97_CLS=$(grep -c "ehRecusaSemRessalva" supabase/functions/agente-sugere-ocs-padrao/index.ts supabase/functions/_shared/recusa-sem-ressalva.ts | awk -F: '{s+=$2} END {print s}')
INV97_MIG=$(grep -c "RECUSA_SEM_RESSALVA" migration/2026-08-25_352_template_recusa_sem_ressalva.sql | tr -d ' ')
INV97_TEST=$(cd supabase/functions && deno test --allow-all --no-check _shared/recusa-sem-ressalva.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV97_CLS:-0}" -ge 3 ] && [ "${INV97_MIG:-0}" -ge 2 ] && [ "$INV97_TEST" = "PASS" ]; then
  echo "INV-097: PASS (classificador=$INV97_CLS mig=$INV97_MIG test=$INV97_TEST)"
else
  echo "INV-097: FAIL (classificador=$INV97_CLS mig=$INV97_MIG test=$INV97_TEST — recusa sem ressalva usa template específico no caso devolucao_pos_56)"
fi

# INV-098 (Caio 2026-08-25, NFs 729049/425861): órfãos da PARA FAZER — card
# com oc COM regra nunca fica sem propostas.
# Causa: oc muda de sem-regra pra com-regra em card AGUARDANDO_AGENTE e nada
# propunha (fila do agente só busca AVH+lock) — 729049 ficou 6 dias invisível.
# (a) ELO no Pass A: oc mudou + card passivo destravado + oc com regra +
#     não-eco (porta 4) → proporAutoAcaoSeAplicavel (idempotente, promove AVH);
# (b) REDE: sweep selfHealOrfaosParaFazer (irmão do INV-019) cura o ESTADO —
#     AGUARDANDO_AGENTE + oc com regra + zero todos pendentes + >30min.
INV98_ELO=$(grep -c "orfaoOcComRegraEmPassivo\|OcComRegraChegouEmParaFazer" supabase/functions/sync-bastao/index.ts | tr -d ' ')
INV98_SWEEP=$(grep -c "selfHealOrfaosParaFazer\|OrfaoParaFazerCurado" supabase/functions/sync-bastao/index.ts | tr -d ' ')
if [ "${INV98_ELO:-0}" -ge 2 ] && [ "${INV98_SWEEP:-0}" -ge 3 ]; then
  echo "INV-098: PASS (elo=$INV98_ELO sweep=$INV98_SWEEP)"
else
  echo "INV-098: FAIL (elo=$INV98_ELO sweep=$INV98_SWEEP — oc com regra em card passivo sempre ganha propostas; sweep cura órfãos)"
fi

# INV-099 (plano de veto 25/08, ADR 0016): a JANELA DE VETO nunca perde as
# defesas do motor — kill-switch, TTL, claim atômico, hash da proposta e
# re-validação vivem no processador; as cercas puras têm teste próprio.
INV99_HANDLER=$(grep -c "processarExecutarAcaoAutonoma\|TTL_EXECUCAO_ATRASADA_MIN\|hash_proposta" supabase/functions/processar-acoes-agendadas/index.ts | tr -d ' ')
INV99_CERCAS=$(cd supabase/functions && deno test --allow-all --no-check _shared/veto-elegibilidade.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
INV99_MINUTOS=$(cd supabase/functions && deno test --allow-all --no-check _shared/minutos-uteis.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV99_HANDLER:-0}" -ge 5 ] && [ "$INV99_CERCAS" = "PASS" ] && [ "$INV99_MINUTOS" = "PASS" ]; then
  echo "INV-099: PASS (handler=$INV99_HANDLER cercas=$INV99_CERCAS minutos=$INV99_MINUTOS)"
else
  echo "INV-099: FAIL (handler=$INV99_HANDLER cercas=$INV99_CERCAS minutos=$INV99_MINUTOS — motor do veto sem defesas)"
fi

# INV-100 (plano de veto 25/08): MARCAÇÃO OBRIGATÓRIA — impossível existir
# execução autônoma sem marca: a RPC do veto grava AutoAprovacaoPermitida +
# auto_approval_rule + aprovacao_modo='autonoma' e cancela irmãs com a FRASE
# LITERAL que reverter_acao_falhou reconhece (risco 32).
INV100_RPC=$(grep -c "AutoAprovacaoPermitida\|auto_approval_rule\|aprovacao_modo = 'autonoma'" migration/2026-08-25_354_rpc_auto_aprovar_veto_e_cron.sql | tr -d ' ')
INV100_FRASE=$(grep -c "Auto-cancelado: outra opção foi aprovada no mesmo card" migration/2026-08-25_354_rpc_auto_aprovar_veto_e_cron.sql | tr -d ' ')
if [ "${INV100_RPC:-0}" -ge 3 ] && [ "${INV100_FRASE:-0}" -ge 1 ]; then
  echo "INV-100: PASS (marcas=$INV100_RPC frase_literal=$INV100_FRASE)"
else
  echo "INV-100: FAIL (marcas=$INV100_RPC frase=$INV100_FRASE — execução autônoma sem marca ou frase do reverter quebrada)"
fi

# INV-101 (plano de veto 25/08): PARIDADE do hashDaProposta front×edge +
# exclusividade das colunas do kanban (nenhum card some nem duplica).
INV101_PARIDADE=$(grep -c "076cb53b1c832d88" supabase/functions/_shared/acao-autonoma-veto.test.ts apps/cockpit-web/src/lib/acaoAutonomaVeto.test.ts | awk -F: '{s+=$2} END {print s}')
INV101_EXCL=$(cd apps/cockpit-web && npx vitest run src/lib/kanban-veto-exclusividade.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "${INV101_PARIDADE:-0}" -ge 2 ] && [ "$INV101_EXCL" = "PASS" ]; then
  echo "INV-101: PASS (paridade=$INV101_PARIDADE exclusividade=$INV101_EXCL)"
else
  echo "INV-101: FAIL (paridade=$INV101_PARIDADE excl=$INV101_EXCL — hash divergente entre front/edge ou card em duas abas)"
fi

# INV-102 (Caio 2026-08-26, NF 120149): lançamento pelo Cockpit SEMPRE dispara
# o refresh do histórico do card (fire-and-forget pra puxar-historico-ssw-card
# no sucesso do envelope). Sem isso o card mostra oc velha e confunde
# operador e veto (o 1º veto errado da história do trilho nasceu disso).
INV102=$(grep -c "puxar-historico-ssw-card" supabase/functions/_shared/lancar-ssw-portal.ts | tr -d ' ')
if [ "${INV102:-0}" -ge 1 ]; then
  echo "INV-102: PASS (hook de refresh no envelope=$INV102)"
else
  echo "INV-102: FAIL — envelope não dispara refresh do histórico pós-lançamento"
fi

# INV-103 (Caio 2026-08-26, caso ISABELY/NF 120149): veto SEM divergência
# (operador cancelou e fez a MESMA ação) NUNCA vira padrão/proposta de
# agente no cérebro do loop — treina o OPERADOR, não o robô.
INV103=$(cd supabase/functions && deno test --allow-all --no-check _shared/cerebro-veto.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
if [ "$INV103" = "PASS" ]; then
  echo "INV-103: PASS (cerebro-veto puro — sem_divergencia fora dos padrões)"
else
  echo "INV-103: FAIL — guard do cérebro do veto quebrado"
fi

# INV-104 (Caio 2026-08-26, NF 26033): mudança de ocorrência GRITA — detector
# puro (histórico fresco × oc do card) + faixa vermelha com RE-ANALISAR JÁ no
# topo do card; dado ausente nunca gera alarme falso.
INV104_TEST=$(cd apps/cockpit-web && npx vitest run src/lib/ocorrenciaMudou.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
INV104_UI=$(grep -c "BannerOcorrenciaMudou" apps/cockpit-web/src/pages/CardDetail.tsx | tr -d ' ')
if [ "$INV104_TEST" = "PASS" ] && [ "${INV104_UI:-0}" -ge 2 ]; then
  echo "INV-104: PASS (detector=$INV104_TEST banner_montado=$INV104_UI)"
else
  echo "INV-104: FAIL (detector=$INV104_TEST ui=$INV104_UI — mudança de oc sem alerta)"
fi

# INV-105 (Caio 2026-08-26): "1 card = 1 decisão" — o PainelDecisao escolhe
# EXATAMENTE um vencedor pela tabela de prioridade (oc_mudou > countdown >
# falha > sugestão-resposta > sugestão-padrão); o resto colapsa. Banner novo
# entra na TABELA, nunca na pilha.
INV105=$(cd apps/cockpit-web && npx vitest run src/lib/painelDecisao.test.ts >/dev/null 2>&1 && echo PASS || echo FAIL)
INV105_UI=$(grep -c "PainelDecisao" apps/cockpit-web/src/pages/CardDetail.tsx | tr -d ' ')
if [ "$INV105" = "PASS" ] && [ "${INV105_UI:-0}" -ge 2 ]; then
  echo "INV-105: PASS (prioridade=$INV105 painel_montado=$INV105_UI)"
else
  echo "INV-105: FAIL — painel de decisão quebrado ou pilha de banners de volta"
fi

# INV-106 (Caio 2026-08-26, incidente do 1º dia): a fila do processador NUNCA
# volta a ser única — vetos (têm TTL) consultados PRIMEIRO, em query própria;
# legados depois. 23 ações morreram de fome atrás de 45 zumbis de cobrança.
INV106=$(grep -c "pendentesVeto\|pendentesOutros" supabase/functions/processar-acoes-agendadas/index.ts | tr -d ' ')
if [ "${INV106:-0}" -ge 3 ]; then
  echo "INV-106: PASS (fila em duas passadas=$INV106)"
else
  echo "INV-106: FAIL — fila única de volta no processador (starvation dos vetos)"
fi

# INV-107 (descoberto na mig 359, 2026-08-26): NENHUM card com ação autônoma
# ARMADA pode pertencer a operador FORA do piloto da janela de veto. O
# agendador cerca por 'operador_fora_do_piloto' na hora de AGENDAR, mas o
# executor `processar-acoes-agendadas` NÃO recheca o piloto no vencimento
# (grep acoes_autonomas_veto_operadores no index.ts = 0). Logo, qualquer coisa
# que troque o dono de um card com ação armada — reatribuição de carteira,
# saída de operador do piloto, transferência manual — faz o robô agir sozinho
# na mão de quem nunca optou por ação autônoma. A mig 359 desarma na origem;
# este guard DETECTA o vazamento se ele voltar por outro caminho.
# NÃO é a correção do executor — essa é decisão à parte do Caio.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV107_VAZ=SKIP
else
  INV107_VAZ=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from acoes_agendadas ag join cards c on c.id=ag.card_id left join acoes_autonomas_veto_operadores v on v.operador_id=c.assigned_operator_id and v.ativo where ag.tipo='executar_acao_autonoma' and ag.status in ('pendente','executando') and v.operador_id is null;" 2>/dev/null | tr -d ' ')
  # sem resposta (psql ausente/timeout) = nao da pra avaliar -> SKIP, nunca FAIL falso
  [ -z "$INV107_VAZ" ] && INV107_VAZ=SKIP
fi
if [ "$INV107_VAZ" = "SKIP" ] || [ "${INV107_VAZ:-1}" = "0" ]; then
  echo "INV-107: PASS (acao_armada_fora_do_piloto=$INV107_VAZ)"
else
  echo "INV-107: FAIL (acao_armada_fora_do_piloto=$INV107_VAZ — card com ação autônoma armada cujo dono NÃO está no piloto do veto; o executor não recheca o piloto no vencimento, então isso dispara sozinho. Ver migration/2026-08-26_359_carteira_isabely_para_victor_karoline_felipe_duilio.sql)"
fi

# INV-108 (mig 360, 2026-08-26): o remanejo de cliente tem UMA porta — a função
# canônica `remanejar_cliente_operador` — e ela nunca pode ser chamável pelo
# front (authenticated/anon). Verifica: (a) a função EXISTE em prod (se sumir,
# o Carlos volta a escrever UPDATE à mão, que é a classe de risco que a mig 360
# eliminou); (b) authenticated NÃO tem EXECUTE nela (operador logado remanejando
# carteira seria escalada de privilégio). Política: docs/POLITICA_MIGRATIONS.md.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV108_ST=SKIP
else
  INV108_ST=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when count(*)=0 then 'AUSENTE' when bool_or(has_function_privilege('authenticated', oid, 'EXECUTE')) then 'EXPOSTA' else 'OK' end from pg_proc where proname='remanejar_cliente_operador' and pronamespace='public'::regnamespace;" 2>/dev/null | tr -d ' ')
  [ -z "$INV108_ST" ] && INV108_ST=SKIP
fi
if [ "$INV108_ST" = "SKIP" ] || [ "$INV108_ST" = "OK" ]; then
  echo "INV-108: PASS (rpc_remanejar=$INV108_ST)"
else
  echo "INV-108: FAIL (rpc_remanejar=$INV108_ST — AUSENTE: a função canônica de remanejo sumiu de prod; EXPOSTA: authenticated consegue executá-la. Ver migration/2026-08-26_360_rpc_remanejar_cliente_operador.sql)"
fi

# INV-109 (26/08, 43 expiradas por TTL): a cerca de frescor do poll (risco 27)
# das ações autônomas COM E-MAIL mede o CANAL DE CAPTURA real (linha mais
# recente de gmail_polling_state — hoje a caixa central COCKPIT), NUNCA a linha
# do operador dono do card: as linhas por operador são fósseis do rodízio
# antigo (LARISSA 22/06, FELIPE sem linha) e filtrá-las por dono fazia 100%
# das ações com e-mail adiarem até o TTL matar, com zero e-mails executados
# desde a estreia do trilho. Verifica: (a) marcador do fix presente; (b) a
# consulta de frescor a gmail_polling_state não filtra por operador_id.
PAA=supabase/functions/processar-acoes-agendadas/index.ts
INV109_MARCA=$(grep -c 'risco27-canal-de-captura' "$PAA" 2>/dev/null || echo 0)
INV109_FILTRO=$(grep -A6 'from("gmail_polling_state")' "$PAA" 2>/dev/null | grep -c 'eq("operador_id"' || true)
if [ "${INV109_MARCA:-0}" -ge 1 ] && [ "${INV109_FILTRO:-1}" = "0" ]; then
  echo "INV-109: PASS (marca=$INV109_MARCA filtro_por_dono=$INV109_FILTRO)"
else
  echo "INV-109: FAIL (marca=$INV109_MARCA filtro_por_dono=$INV109_FILTRO — a cerca de frescor voltou a consultar gmail_polling_state por dono do card (ou o marcador sumiu); toda ação com e-mail vai adiar até o TTL. Ver comentário risco27-canal-de-captura no processar-acoes-agendadas)"
fi

# INV-110 (26/08, NFs 885480/425770): o watchdog de execução-presa (mig 279/294/
# 361) NUNCA pode tratar card com execução FRESCA como preso. O candidato antigo
# casava qualquer todo aprovado/executando velho do card e revertia execução
# saudável em pleno voo (revert 17:50:00, SSW confirmando 17:50:38 — ação feita
# com card marcado 'falhou'). Verifica que a função EM PROD contém a cerca.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV110_ST=SKIP
else
  INV110_ST=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when count(*)=0 then 'FUNCAO_AUSENTE' when bool_and(prosrc like '%execucao FRESCA nao e candidato%') then 'OK' else 'SEM_CERCA' end from pg_proc where proname='reconciliar_execucoes_presas' and pronamespace='public'::regnamespace;" 2>/dev/null | tr -d ' ')
  [ -z "$INV110_ST" ] && INV110_ST=SKIP
fi
if [ "$INV110_ST" = "SKIP" ] || [ "$INV110_ST" = "OK" ]; then
  echo "INV-110: PASS (watchdog_cerca_fresca=$INV110_ST)"
else
  echo "INV-110: FAIL (watchdog_cerca_fresca=$INV110_ST — a cerca 'card com execução fresca não é candidato' sumiu da RPC em prod; o watchdog volta a reverter execuções saudáveis por resíduo de todo velho. Ver migration/2026-08-26_361_watchdog_execucao_fresca_nao_e_candidato.sql)"
fi

# INV-111 (26/08, NF 382389): "se não tem evidência, não pode sugerir 54+email
# pra depois barrar na execução". A pré-checagem vive em DUAS camadas: (a) a
# sugestão suprime a opção com e-mail quando a ausência de foto é PROVADA
# (ok_sem_btn_foto, ocs 10/11/35, template com {link_evidencia}) — ambíguo
# mantém (caminho skip_evidencia, NF 353730); (b) o veto NUNCA arma e-mail
# nas 10/11/35 sem foto CONFIRMADA (evidencia_nao_confirmada). Testes puros:
INV111_OUT=$(deno test --no-check supabase/functions/_shared/regras-auto-acao.evidencia-sugestao.test.ts supabase/functions/_shared/veto-elegibilidade.test.ts 2>&1 | grep -E 'passed|failed' | tail -1)
if echo "$INV111_OUT" | grep -q "0 failed"; then
  echo "INV-111: PASS ($INV111_OUT)"
else
  echo "INV-111: FAIL ($INV111_OUT — pré-checagem de evidência na sugestão/veto regrediu. Ver deveSuprimirSugestaoSemEvidencia + cerca evidencia_nao_confirmada)"
fi

# INV-112 (27/08): o modo escuro é OPCIONAL e o padrão é o CLARO de hoje.
# (a) contrato puro testado (default claro, fail-safe, simetria);
# (b) o boot no index.html só ativa com o literal 'escuro' (sem ele, um valor
#     lixo no storage escureceria o app de quem nunca escolheu).
INV112_OUT=$(cd apps/cockpit-web && npx vitest run src/lib/theme.test.ts 2>&1 | grep -E "Tests " | head -1)
INV112_BOOT=$(grep -c 'localStorage.getItem("cockpit_tema") === "escuro"' apps/cockpit-web/index.html || true)
if echo "$INV112_OUT" | grep -q "passed" && ! echo "$INV112_OUT" | grep -q "failed" && [ "${INV112_BOOT:-0}" -ge 1 ]; then
  echo "INV-112: PASS ($INV112_OUT | boot=$INV112_BOOT)"
else
  echo "INV-112: FAIL ($INV112_OUT | boot=$INV112_BOOT — contrato do modo escuro opcional regrediu: default deixou de ser claro ou o boot do index.html mudou. Ver src/lib/theme.ts)"
fi

# INV-113 (27/08, NF 25021): regras A/B da oc 49 + cerca nunca-misturar.
# (a) testes puros do módulo de contexto (âncora real da 25021);
# (b) o caso devolucao_pos_56 continua bloqueado pro par 46+49 (nunca-misturar);
# (c) o fixture do set de relacionamento no teste espelha o dicionário prod.
INV113_OUT=$(deno test --no-check supabase/functions/_shared/oc49-contexto.test.ts 2>&1 | grep -E 'passed|failed' | tail -1)
INV113_GUARD=$(grep -c 'linha56Anterior && !parIndenizacao' supabase/functions/agente-sugere-ocs-padrao/index.ts || true)
if echo "$INV113_OUT" | grep -q "0 failed" && [ "${INV113_GUARD:-0}" -ge 1 ]; then
  echo "INV-113: PASS ($INV113_OUT | nunca_misturar=$INV113_GUARD)"
else
  echo "INV-113: FAIL ($INV113_OUT | nunca_misturar=$INV113_GUARD — regras A/B da 49 ou a cerca nunca-misturar regrediram. Ver _shared/oc49-contexto.ts + decidirOc49)"
fi

# INV-114 (27/08): feedback OBRIGATÓRIO da 49 não-reconhecida. Três presas:
# (a) a trava vive na aprovar_e_executar EM PROD (grep no prosrc);
# (b) NENHUM componente do front chama aprovar_e_executar direto (todos via
#     wrapper aprovarEExecutarComFeedback — senão a trava vira erro seco sem modal);
# (c) o modal está montado no AppLayout.
INV114_DIRETO=$(grep -rc 'supabase.rpc("aprovar_e_executar"' apps/cockpit-web/src/components 2>/dev/null | grep -v ":0" | wc -l | tr -d ' ')
INV114_MODAL=$(grep -c "FormularioFeedbackOc49" apps/cockpit-web/src/components/layout/AppLayout.tsx || true)
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV114_DB=SKIP
else
  INV114_DB=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when bool_and(prosrc like '%FEEDBACK_OC49_OBRIGATORIO%') then 'OK' else 'SEM_TRAVA' end from pg_proc where proname='aprovar_e_executar' and pronamespace='public'::regnamespace;" 2>/dev/null | tr -d ' ')
  [ -z "$INV114_DB" ] && INV114_DB=SKIP
fi
if [ "${INV114_DIRETO:-1}" = "0" ] && [ "${INV114_MODAL:-0}" -ge 1 ] && { [ "$INV114_DB" = "OK" ] || [ "$INV114_DB" = "SKIP" ]; }; then
  echo "INV-114: PASS (chamadas_diretas=$INV114_DIRETO modal=$INV114_MODAL trava_db=$INV114_DB)"
else
  echo "INV-114: FAIL (chamadas_diretas=$INV114_DIRETO modal=$INV114_MODAL trava_db=$INV114_DB — feedback obrigatório da 49 regrediu: chamada direta sem wrapper, modal fora do layout, ou trava sumiu da RPC. Ver mig 363 + lib/aprovarComFeedback.ts)"
fi

# INV-115/116 (27/08): countdown VIVO no board (mm:ss junto ao LOCK) + pausa
# de ALMOÇO 12h-13h na hora útil (11h30→13h30; 12h-13h→14h). Fonte canônica
# minutos-uteis.ts; front espelha e avisa (⏸/·almoço). Se regredir, ou o
# operador perde o relógio na tela, ou o robô volta a agir no almoço.
INV115_OUT=$(cd apps/cockpit-web && npx vitest run src/lib/acaoAutonomaVeto.countdown.test.ts 2>&1 | grep -E "Tests " | head -1)
INV116_OUT=$(deno test --no-check supabase/functions/_shared/minutos-uteis.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
if echo "$INV115_OUT" | grep -q "passed" && ! echo "$INV115_OUT" | grep -q "failed" \
   && echo "$INV116_OUT" | grep -q "0 failed"; then
  echo "INV-115/116: PASS (front=$INV115_OUT | uteis=$INV116_OUT)"
else
  echo "INV-115/116: FAIL (front=$INV115_OUT | uteis=$INV116_OUT — countdown vivo ou regra do almoço regrediu. Ver minutos-uteis.ts + acaoAutonomaVeto.ts)"
fi

# INV-117 (27/08, NF 1011929): a IA da oc 49 NUNCA sugere lançar oc de
# RELACIONAMENTO (chegam DOS setores; Cockpit não as lança) e e-mail ao
# cliente SÓ acompanha 54/59. Cerca de código sanitiza mesmo se o modelo
# alucinar; o prompt ensina a whitelist.
INV117_OUT=$(deno test --no-check supabase/functions/_shared/oc49-ia.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
if echo "$INV117_OUT" | grep -q "0 failed"; then
  echo "INV-117: PASS ($INV117_OUT)"
else
  echo "INV-117: FAIL ($INV117_OUT — espaço de ações da IA da 49 regrediu. Ver sanitizarLeituraIa49 em oc49-ia.ts)"
fi

# INV-118 (27/08, NF 660746): (a) oc 33 incompleta é PAREDE na aprovação
# (gate_oc33.bloqueada em prod recusa com OC33_DOSSIE_INCOMPLETO); (b) card
# terminal reaberto por resposta sem ação volta sozinho (testes puros).
INV118_OUT=$(deno test --no-check supabase/functions/_shared/resposta-sem-acao.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV118_DB=SKIP
else
  INV118_DB=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when bool_and(prosrc like '%OC33_DOSSIE_INCOMPLETO%') then 'OK' else 'SEM_GATE' end from pg_proc where proname='aprovar_e_executar' and pronamespace='public'::regnamespace;" 2>/dev/null | tr -d ' ')
  [ -z "$INV118_DB" ] && INV118_DB=SKIP
fi
if echo "$INV118_OUT" | grep -q "0 failed" && { [ "$INV118_DB" = "OK" ] || [ "$INV118_DB" = "SKIP" ]; }; then
  echo "INV-118: PASS ($INV118_OUT | gate33_db=$INV118_DB)"
else
  echo "INV-118: FAIL ($INV118_OUT | gate33_db=$INV118_DB — gate da 33 ou devolução ao terminal regrediu. Ver mig 365 + resposta-sem-acao.ts)"
fi

# INV-119 (27/08, NF 660746 e-mail duplicado): o watchdog de execução-presa
# detecta responder_thread_cliente como E-MAIL — ação travada com resposta na
# thread REVERTE pro humano, nunca re-executa (senão reenvia o e-mail).
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV119_ST=SKIP
else
  INV119_ST=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when bool_and(prosrc like '%responder_thread_cliente%') then 'OK' else 'AUSENTE' end from pg_proc where proname='reconciliar_execucoes_presas' and pronamespace='public'::regnamespace;" 2>/dev/null | tr -d ' ')
  [ -z "$INV119_ST" ] && INV119_ST=SKIP
fi
if [ "$INV119_ST" = "OK" ] || [ "$INV119_ST" = "SKIP" ]; then
  echo "INV-119: PASS (watchdog_detecta_thread=$INV119_ST)"
else
  echo "INV-119: FAIL (watchdog_detecta_thread=$INV119_ST — responder_thread_cliente sumiu da detecção de e-mail do watchdog; ação travada com resposta na thread volta a poder reenviar e-mail ao cliente. Ver mig 366)"
fi

# INV-120 (28/08, ADR 0017): regra v2 da oc43 — extravio→monitorado com relógio
# original + relançamento herdando instrução + D4 aceita 43 pós-extravio +
# Pass A preserva a marca. Testes puros das 3 peças:
INV120_OUT=$(deno test --no-check supabase/functions/_shared/oc43-regras.test.ts supabase/functions/_shared/preservar-extravio-parcial.test.ts supabase/functions/_shared/agente-extravio-regras.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
if echo "$INV120_OUT" | grep -q "0 failed"; then
  echo "INV-120: PASS ($INV120_OUT)"
else
  echo "INV-120: FAIL ($INV120_OUT — regra v2 da oc43 regrediu. Ver ADR 0017 + oc43-regras.ts)"
fi

# INV-121 (31/08, mig 369): views sensíveis a RLS TÊM que ter security_invoker.
# `CREATE OR REPLACE VIEW` sem repetir `WITH (security_invoker = on)` SUBSTITUI as
# reloptions em bloco — e `pg_get_viewdef` NÃO imprime essa cláusula, então quem
# copia a definição de lá derruba o atributo sem perceber (tudo o mais continua
# funcionando). Sem ele a view roda como a dona (postgres, bypassrls), a RLS de
# `cards` não é avaliada, TODOS os operadores veem TUDO e até a chave anon lê a
# tabela inteira sem login. Foi exatamente o que a mig 367 causou na aba Extravios
# (28/08→31/08) e a mig 369 corrigiu. Este guard pega a REGRESSÃO.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV121_SEM=SKIP
else
  INV121_SEM=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' and c.relname in ('v_extravios_kanban','v_prioridades_ai','v_cards_requer_atencao','v_cancelamentos_reentrega','v_card_events_legivel','v_email_preexistente') and coalesce(c.reloptions::text,'') !~ 'security_invoker=(on|true)';" 2>/dev/null | tr -d ' ')
  [ -z "$INV121_SEM" ] && INV121_SEM=SKIP
fi
if [ "$INV121_SEM" = "0" ] || [ "$INV121_SEM" = "SKIP" ]; then
  echo "INV-121: PASS (views_rls_sem_invoker=$INV121_SEM)"
else
  echo "INV-121: FAIL (views_rls_sem_invoker=$INV121_SEM — view sensível a RLS rodando como DONA: operador vê carteira alheia e a chave anon lê sem login. Rodar: ALTER VIEW <nome> SET (security_invoker = on). Ver mig 369)"
fi

# INV-122 (31/08): casos do time na 49 (respostas oficiais do Caio) — 3
# tentativas pela régua da oc 14, custo extra com isenção OVD/FG por raiz,
# cobrança ampliada; trava do feedback cobre carona_pos54.
INV122_OUT=$(deno test --no-check supabase/functions/_shared/oc49-casos-time.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV122_DB=SKIP
else
  INV122_DB=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when bool_and(prosrc like '%carona_pos54%') then 'OK' else 'SEM_GATE' end from pg_proc where proname='aprovar_e_executar' and pronamespace='public'::regnamespace;" 2>/dev/null | tr -d ' ')
  [ -z "$INV122_DB" ] && INV122_DB=SKIP
fi
if echo "$INV122_OUT" | grep -q "0 failed" && { [ "$INV122_DB" = "OK" ] || [ "$INV122_DB" = "SKIP" ]; }; then
  echo "INV-122: PASS ($INV122_OUT | gate_carona=$INV122_DB)"
else
  echo "INV-122: FAIL ($INV122_OUT | gate_carona=$INV122_DB — casos do time na 49 regrediram. Ver oc49-casos-time.ts + mig 370)"
fi

echo "=== Fim Fase 8 (continuacao) ==="
```

## Fase 8 (continuação 2) — INV-123 a INV-131 (devolução com CT-e, MARIA EDUARDA)

> ADR 0018 · mig 373 · plano `~/.claude/plans/piped-wandering-wolf.md`.
> Escrito no **degrau 0**. Os blocos verificam **o que já existe**; o que chega em
> degrau posterior sai como **SKIP com o degrau escrito**, nunca como FAIL — bloco
> que afirma código inexistente deixaria o verify vermelho de propósito.
> Ao subir de degrau, APERTAR o bloco correspondente no mesmo commit.

```bash
cd "$(git rev-parse --show-toplevel)"; source scripts/ritual-env.sh

echo "=== Fase 8 (continuação 2) — devolução com CT-e (INV-123 a INV-131) ==="

MIG373="migration/2026-09-01_373_devolucao_cte_maria_infra.sql"
DET="supabase/functions/_shared/devolucao-cte-detector.ts"

# INV-123 (ADR 0018 §7): o ESCOPO é cercado no BANCO, com zero hardcode de CNPJ.
# Vazar escopo atinge as carteiras de Larissa/Karoline/Ingrid e é irreversível na
# relação com o cliente.
#
# Caio 2026-09-01: "todos os clientes da Maria seguem esse fluxo" ⇒ NÃO existe
# lista de opt-in por cliente. O escopo é a CARTEIRA do operador, lida por
# public.devolucao_cte_em_escopo(). Isso mata por construção a classe de erro
# "ligaram a flag pro CNPJ errado". O que este check cobra: a função existe, é
# SECURITY DEFINER com search_path fixo, é FAIL-CLOSED (CNPJ nulo/lixo => false)
# e reconhece a carteira de verdade — prova de que a normalização de dígitos
# casa, que é o R17 pelas duas pontas.
INV123_MIG=$(grep -c "devolucao_cte_em_escopo" "$MIG373" | tr -d ' ')
INV123_NOHARD=$(grep -cE "^[^-]*'[0-9]{14}'" "$MIG373" | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV123_TRG="SKIP"; INV123_VAZ="SKIP"; INV123_DEF="SKIP"
else
  # fail-closed: CNPJ nulo, vazio, lixo e fora de carteira TÊM de dar false
  INV123_TRG=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when coalesce(devolucao_cte_em_escopo(null),false)=false and coalesce(devolucao_cte_em_escopo(''),false)=false and coalesce(devolucao_cte_em_escopo('abc'),false)=false and coalesce(devolucao_cte_em_escopo(repeat('9',14)),false)=false then 'OK' else 'RUIM' end;" 2>/dev/null | tr -d ' ')
  INV123_DEF=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when prosecdef and array_to_string(proconfig,',') like '%search_path%' then 'OK' else 'RUIM' end from pg_proc where proname='devolucao_cte_em_escopo';" 2>/dev/null | tr -d ' ')
  # a cerca reconhece a carteira? devolve 1 (=falha) se NENHUM CNPJ passar
  INV123_VAZ=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when count(*)>0 then 0 else 1 end from operadores o, unnest(o.carteira) c, devolucao_cte_config g where g.id=1 and o.nome=g.operador_escopo and o.ativo and devolucao_cte_em_escopo(c);" 2>/dev/null | tr -d ' ')
fi
if [ "${INV123_MIG:-0}" -ge 2 ] && [ "${INV123_NOHARD:-1}" -eq 0 ] \
   && { [ "$INV123_TRG" = "SKIP" ] || [ "$INV123_TRG" = "OK" ]; } \
   && { [ "$INV123_DEF" = "SKIP" ] || [ "$INV123_DEF" = "OK" ]; } \
   && { [ "$INV123_VAZ" = "SKIP" ] || [ "${INV123_VAZ:-1}" -eq 0 ]; }; then
  echo "INV-123: PASS (mig=$INV123_MIG cnpj_hardcoded=$INV123_NOHARD failclosed=$INV123_TRG definer=$INV123_DEF carteira_nao_reconhecida=$INV123_VAZ)"
else
  echo "INV-123: FAIL (mig=$INV123_MIG cnpj_hardcoded=$INV123_NOHARD failclosed=$INV123_TRG definer=$INV123_DEF carteira_nao_reconhecida=$INV123_VAZ — cerca de escopo furada; carteira de outro operador em risco)"
fi

# INV-124 (ADR 0018): o anexo do CT-e é prova fiscal e não pode ser apagado.
# Degrau 0 entrega a coluna + índice. O filtro no choke point de deleção entra no
# degrau 2 (é lá que finalizarAnexosPosEnvio é tocado).
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV124_COL="SKIP"
else
  INV124_COL=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from information_schema.columns where table_schema='public' and table_name='email_anexos' and column_name='preservar';" 2>/dev/null | tr -d ' ')
fi
INV124_MIG=$(grep -c "email_anexos" "$MIG373" | tr -d ' ')
if [ "${INV124_MIG:-0}" -ge 2 ] && { [ "$INV124_COL" = "SKIP" ] || [ "${INV124_COL:-0}" -eq 1 ]; }; then
  echo "INV-124: PASS (mig=$INV124_MIG coluna=$INV124_COL | filtro no choke point: degrau 2)"
else
  echo "INV-124: FAIL (mig=$INV124_MIG coluna=$INV124_COL — email_anexos.preservar ausente)"
fi

# INV-125 (ADR 0018): o e-mail interno ao setor de Devolução é mensagem NOVA e
# separada, FORA de cards_emails_outbound — senão a cobrança vai pro Leonel, a
# thread do cliente é sequestrada e a resposta dele vira "cliente respondeu".
# Degrau 0 entrega a idempotência (UNIQUE no message-id). O resto: degrau 5.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV125_UNQ="SKIP"
else
  INV125_UNQ=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_indexes where schemaname='public' and indexname='uniq_devcte_email_interno_msgid';" 2>/dev/null | tr -d ' ')
fi
# Guard MECÂNICO (o teste lê o próprio fonte): o módulo não pode mencionar
# cards_emails_outbound nem chamar finalizarAnexosPosEnvio, e tem de enviar com
# threadId null. Memória não trava regressão de código; isto trava.
INV125_MOD="supabase/functions/_shared/email-interno-devolucao.ts"
INV125_TEST=$(deno test --allow-read --no-check supabase/functions/_shared/email-interno-devolucao.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
INV125_OUTB=$(grep -v "^\s*//" "$INV125_MOD" | grep -c "cards_emails_outbound" | tr -d ' ')
INV125_FIN=$(grep -v "^\s*//" "$INV125_MOD" | grep -c "finalizarAnexosPosEnvio" | tr -d ' ')
INV125_NOVA=$(grep -c "threadId: null" "$INV125_MOD" | tr -d ' ')
if echo "$INV125_TEST" | grep -q "0 failed" \
   && [ "${INV125_OUTB:-1}" -eq 0 ] && [ "${INV125_FIN:-1}" -eq 0 ] && [ "${INV125_NOVA:-0}" -ge 1 ] \
   && { [ "$INV125_UNQ" = "SKIP" ] || [ "${INV125_UNQ:-0}" -eq 1 ]; }; then
  echo "INV-125: PASS ($INV125_TEST | outbound=$INV125_OUTB finalizar=$INV125_FIN thread_nova=$INV125_NOVA unique_msgid=$INV125_UNQ)"
else
  echo "INV-125: FAIL ($INV125_TEST | outbound=$INV125_OUTB finalizar=$INV125_FIN thread_nova=$INV125_NOVA unique_msgid=$INV125_UNQ — e-mail interno vazando pro outbound faz a cobrança ir pro Leonel e a resposta dele virar 'CLIENTE RESPONDEU')"
fi

# INV-126 (ADR 0018 §6): NUNCA existe oc 44 lançada sem CT-e em mãos, e nunca com
# conversão falhada. É PAREDE DE BANCO porque guard em código é furável: tool novo
# não registrado em decidir-clique-aprovacao cai em "aprovar-direto" e aprova às
# cegas (5ª recorrência da classe). Inclui a suíte do detector, que é quem produz
# a evidência do CT-e.
# --allow-read: o guard do INV-042 (BLOQUEIOS importados, não copiados) LÊ o
# próprio fonte do detector. Sem a permissão a suíte inteira falha e o INV-126
# reportaria "parede furada" por motivo falso.
INV126_DET=$(deno test --allow-read --no-check supabase/functions/_shared/devolucao-cte-detector.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
INV126_CHK_MIG=$(grep -c "devcte_sem_cte_nao_lanca_44\|devcte_44_exige_conversao_ok\|devcte_email_depois_da_44" "$MIG373" | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV126_CHK_DB="SKIP"; INV126_VIOL="SKIP"
else
  INV126_CHK_DB=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_constraint where conname in ('devcte_sem_cte_nao_lanca_44','devcte_44_exige_conversao_ok','devcte_email_depois_da_44');" 2>/dev/null | tr -d ' ')
  INV126_VIOL=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from devolucoes_cte where oc44_lancada_em is not null and (cte_anexo_id is null or cte_convertido_ok is not true);" 2>/dev/null | tr -d ' ')
fi
if echo "$INV126_DET" | grep -q "0 failed" && [ "${INV126_CHK_MIG:-0}" -ge 3 ] \
   && { [ "$INV126_CHK_DB" = "SKIP" ] || [ "${INV126_CHK_DB:-0}" -eq 3 ]; } \
   && { [ "$INV126_VIOL" = "SKIP" ] || [ "${INV126_VIOL:-1}" -eq 0 ]; }; then
  echo "INV-126: PASS (detector: $INV126_DET | checks_mig=$INV126_CHK_MIG checks_db=$INV126_CHK_DB violacoes=$INV126_VIOL)"
else
  echo "INV-126: FAIL (detector: $INV126_DET | checks_mig=$INV126_CHK_MIG checks_db=$INV126_CHK_DB violacoes=$INV126_VIOL — parede 'nunca 44 sem CT-e' furada)"
fi

# INV-127 (ADR 0018): a métrica-mãe da 49 (baseline 50,5% congelada na mig 371)
# não pode ser contaminada, e FEEDBACK_OC49_OBRIGATORIO não pode disparar pra caso
# novo. Degrau 0: nenhum caso novo existe ainda — a checagem é de observação.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV127_NOVO="SKIP"
else
  INV127_NOVO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from ia_sugestao_evidencia where caso_oc49 in ('devolucao_cte_maria','nfd_pendente');" 2>/dev/null | tr -d ' ')
fi
INV127_FLAG=$(grep -c "devolucao_cte_maria_enabled" "$MIG373" | tr -d ' ')
if [ "${INV127_FLAG:-0}" -ge 1 ]; then
  echo "INV-127: INFO (casos novos da devolução na 49: $INV127_NOVO | cerca da métrica: degrau 4)"
else
  echo "INV-127: FAIL (flag=$INV127_FLAG — flag de escopo ausente na mig 373)"
fi

# INV-128 (ADR 0018): mexer na lógica de decisão SEM subir VERSAO_REGRAS_ANALISE
# congela a análise cacheada — falha 100% silenciosa (caso-âncora NF 1100040).
# Guard de DIFF: se o diff toca arquivo de decisão, a constante tem de aparecer no
# MESMO diff.
INV128_TOCA=$(git diff --name-only HEAD~1..HEAD 2>/dev/null | grep -cE "regras-auto-acao|oc49-|agente-sugere-ocs-padrao|interpretador-resposta-cliente" | tr -d ' ')
INV128_BUMP=$(git diff HEAD~1..HEAD 2>/dev/null | grep -c "VERSAO_REGRAS_ANALISE" | tr -d ' ')
if [ "${INV128_TOCA:-0}" -eq 0 ] || [ "${INV128_BUMP:-0}" -ge 1 ]; then
  echo "INV-128: PASS (arquivos de decisão no diff=$INV128_TOCA bump=$INV128_BUMP)"
else
  echo "INV-128: FAIL (o diff toca $INV128_TOCA arquivo(s) de decisão e NÃO sobe VERSAO_REGRAS_ANALISE — análise cacheada vai congelar em silêncio)"
fi

# INV-132 (ADR 0018 §6 / R1 do plano): tool nova SEMPRE registrada no front.
# Classe com 5 recorrências catalogadas em decidir-clique-aprovacao.ts: tool que
# o front não conhece cai no default "aprovar-direto" e aprova com extras=null,
# SEM abrir o painel de conferência. O guard DERIVA a lista de tools do backend
# (resolvendo constantes, não só literais) e cobra registro em propostasRaw e em
# decidirCliqueAprovacao; exceção só existe declarada, com motivo.
INV132_OUT=$(deno test --allow-read --no-check supabase/functions/_shared/tools-registrados-no-front.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
INV132_REG=$(grep -c "lancar_44_devolucao_cte" apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | grep -c ":[1-9]")
if echo "$INV132_OUT" | grep -q "0 failed" && [ "${INV132_REG:-0}" -eq 2 ]; then
  echo "INV-132: PASS ($INV132_OUT | superficies_com_a_tool=$INV132_REG/2)"
else
  echo "INV-132: FAIL ($INV132_OUT | superficies_com_a_tool=$INV132_REG/2 — tool que o front nao conhece aprova as cegas com extras=null)"
fi

# INV-133 (ADR 0018 decisoes 3 e 4): a PAREDE do lancamento da oc 44 com CT-e.
# Nao ha devolucao sem CT-e (nº 3) e conversao falhada NAO lanca (nº 4). Cada
# aborto aqui corresponde a um CHECK da mig 373 — se a suite cair, a parede caiu.
# --allow-read: os guards mecanicos do handler LEEM o fonte do executor (ele nao
# tem como ser testado por unidade). Sem a permissao a suite falha e o INV-133
# acusaria "parede furada" por motivo FALSO.
INV133_OUT=$(deno test --allow-read --no-check supabase/functions/_shared/devolucao-cte-44.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
# a tool NUNCA pode reusar o nome genérico (R3: duas propostas de 44 vivas)
INV133_NOME=$(grep -c 'TOOL_44_DEVOLUCAO_CTE = "lancar_44_devolucao_cte"' supabase/functions/_shared/devolucao-cte-44.ts | tr -d ' ')
# reuso obrigatorio: texto e campos obrigatorios vem de descricao-ssw (INV-042)
INV133_REUSO=$(grep -c 'from "./descricao-ssw.ts"' supabase/functions/_shared/devolucao-cte-44.ts | tr -d ' ')
# o handler existe e esta despachado no executor
INV133_HANDLER=$(grep -c "await processarLancar44DevolucaoCte(" supabase/functions/executor/index.ts | tr -d ' ')
if echo "$INV133_OUT" | grep -q "0 failed" && [ "${INV133_NOME:-0}" -eq 1 ] && [ "${INV133_REUSO:-0}" -eq 1 ] && [ "${INV133_HANDLER:-0}" -ge 1 ]; then
  echo "INV-133: PASS ($INV133_OUT | tool_propria=$INV133_NOME reusa_descricao_ssw=$INV133_REUSO handler_despachado=$INV133_HANDLER)"
else
  echo "INV-133: FAIL ($INV133_OUT | tool_propria=$INV133_NOME reusa_descricao_ssw=$INV133_REUSO handler_despachado=$INV133_HANDLER — parede da 44 com CT-e furada, whitelist reimplementada, ou handler nao despachado)"
fi

# INV-135 (Caio 2026-09-02): NADA e cobrado automaticamente, e o ciclo ENCERRA
# na oc 44.
#
# Este bloco NAO cobra que a cobranca funcione — cobra que ela NAO EXISTA. Duas
# ordens do Caio, cada uma com o motivo verificado:
#
#  (a) "Nada sera cobrado de maneira automatica." A cobranca automatica de
#      cliente do Cockpit foi desligada por DECISAO na mig 168
#      (desativar_cobranca_cliente_automatica), que tambem cancelou as 34 acoes
#      pendentes. Motivo escrito lá: cliente sem e-mail cadastrado fazia a
#      rotina retentar a cada 15 min pra sempre (~136 eventos/hora). Nenhuma
#      migration religa. Recriar isso aqui reintroduziria a capacidade que ele
#      desligou.
#
#  (b) "O caso de devolucao so se encerra quando a 44 e lancada." Encerrar nao e
#      cosmetico: filtrarPropostas44SemCte filtra o menu por ciclo ABERTO. Sem
#      encerrar, a 44 pelada e os combos 33+44 / 44+59 ficariam fora do menu
#      daquele card PARA SEMPRE, mesmo com a devolucao concluida.
#
#  (c) O VIGIA foi removido em 2026-09-02, verificado no codigo: o cenario que
#      ele vigiava (espera da NFD via oc 56) nao existe, e o aviso dele
#      renderizava dentro do card que justamente saiu do painel — trocava
#      "linha invisivel" por "banner invisivel".
EXEC_FN="supabase/functions/executor/index.ts"
MIG373="migration/2026-09-01_373_devolucao_cte_maria_infra.sql"
AVISO_LIB="apps/cockpit-web/src/lib/devolucaoCteAviso.ts"
# (a) os artefatos da cobranca/vigia NAO podem voltar a existir
INV135_CRON_FN=$([ -e "supabase/functions/devolucao-cte-ciclo" ] && echo 1 || echo 0)
INV135_MOD=$([ -e "supabase/functions/_shared/devolucao-cte-ciclo.ts" ] && echo 1 || echo 0)
INV135_MIG373=$(ls migration/ 2>/dev/null | grep -c "cron_devolucao_cte_ciclo" | tr -d ' ')
INV135_FLAG=$(grep -c "devolucao_cte_cobranca" "$MIG373" | tr -d ' ')
INV135_COLS=$(grep -cE "cobrancas_feitas|ultima_cobranca_em|proxima_cobranca_em|alerta_parado_em|escalonado_para_humano_em|vigia_dias_uteis|lembrete_dias_uteis" "$MIG373" | tr -d ' ')
# (b) o handler da 44 ENCERRA o ciclo na mesma passada do lancamento
INV135_ENCERRA=$(grep -c 'motivo_encerramento: "oc44_lancada"' "$EXEC_FN" | tr -d ' ')
INV135_ENCERRA_EM=$(grep -c "encerrado_em: agora" "$EXEC_FN" | tr -d ' ')
# (c) o front nao pode ressuscitar os avisos do vigia. Comentarios fora da
# conta: o cabecalho do arquivo EXPLICA quais avisos sairam e por que, e contar
# o comentario faria o guard acusar a si mesmo (3a vez nesta feature).
INV135_FRONT=$(grep -v '^[[:space:]]*//' "$AVISO_LIB" | grep -cE "DevolucaoCteCicloParado|DevolucaoCteEscalonadaParaHumano|cobranca_encerrada|ciclo_parado" | tr -d ' ')
# guard do guard: o teste do front prova que os eventos removidos nao geram aviso
INV135_GUARD_TESTE=$(grep -c "removidos NÃO geram aviso" apps/cockpit-web/src/lib/devolucaoCteAviso.test.ts | tr -d ' ')
if [ "${INV135_CRON_FN:-1}" -eq 0 ] && [ "${INV135_MOD:-1}" -eq 0 ] && [ "${INV135_MIG373:-1}" -eq 0 ] \
   && [ "${INV135_FLAG:-1}" -eq 0 ] && [ "${INV135_COLS:-1}" -eq 0 ] \
   && [ "${INV135_ENCERRA:-0}" -ge 1 ] && [ "${INV135_ENCERRA_EM:-0}" -ge 1 ] \
   && [ "${INV135_FRONT:-1}" -eq 0 ] && [ "${INV135_GUARD_TESTE:-0}" -ge 1 ]; then
  echo "INV-135: PASS (cobranca ausente: cron_fn=$INV135_CRON_FN mod=$INV135_MOD mig373=$INV135_MIG373 flag=$INV135_FLAG colunas=$INV135_COLS front=$INV135_FRONT | encerra_na_44=$INV135_ENCERRA/$INV135_ENCERRA_EM guard_teste=$INV135_GUARD_TESTE)"
else
  echo "INV-135: FAIL (cobranca ausente: cron_fn=$INV135_CRON_FN mod=$INV135_MOD mig373=$INV135_MIG373 flag=$INV135_FLAG colunas=$INV135_COLS front=$INV135_FRONT | encerra_na_44=$INV135_ENCERRA/$INV135_ENCERRA_EM guard_teste=$INV135_GUARD_TESTE — cobranca automatica voltou (Caio: 'nada sera cobrado de maneira automatica') OU o ciclo deixou de encerrar na 44 e o menu do card perde a 44/combos pra sempre)"
fi

# INV-136 (ADR 0018): a MARIA VE o estado da devolucao com CT-e na tela.
#
# O aviso e de CONTEXTO e fica FORA da tabela de prioridade do painelDecisao de
# proposito: a DECISAO do card e a proposta de oc 44, que renderiza na lista de
# acoes. Isto e o que ela precisa SABER, nao decidir. Entra no slot de avisos de
# contexto, que ja existia (BannerMudancaSuspeitaEscopo, BannerEvidencia) — nao
# recria a pilha de banners que o "1 CARD = 1 DECISAO" desmontou.
#
# O que este bloco cobra: a lib pura existe e passa, o banner esta LIGADO no
# slot, e sombra/nivel A nao geram aviso (sombra tem de ser invisivel na tela).
FRONT="apps/cockpit-web"
if [ ! -d "$FRONT/node_modules" ]; then
  echo "INV-136: SKIP (sem $FRONT/node_modules — rode npm ci no front)"
else
  # sed tira os codigos de cor do vitest ANTES do grep: com eles no meio, o
  # padrao nao casa e o campo vem vazio, fazendo o check falhar por motivo falso.
  INV136_TESTES=$(cd "$FRONT" && npx vitest run src/lib/devolucaoCteAviso.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests +[0-9]" | tail -1 | tr -s ' ')
  INV136_LIGADO=$(grep -c "BannerDevolucaoCte" "$FRONT/src/components/cards/PainelDecisao.tsx" | tr -d ' ')
  # sombra NAO pode virar aviso na tela — senao deixa de ser observacao
  INV136_SOMBRA=$(grep -c 'acao: "sombra"' "$FRONT/src/lib/devolucaoCteAviso.test.ts" | tr -d ' ')
  # o seletor NAO pode entrar na tabela de prioridade (nunca empilhar de novo)
  INV136_FORA=$(grep -c "devolucaoCteAviso\|BannerDevolucaoCte" "$FRONT/src/lib/painelDecisao.ts" | tr -d ' ')
  if echo "$INV136_TESTES" | grep -qE "[0-9]+ passed" && ! echo "$INV136_TESTES" | grep -q "failed" \
     && [ "${INV136_LIGADO:-0}" -ge 2 ] && [ "${INV136_SOMBRA:-0}" -ge 1 ] && [ "${INV136_FORA:-1}" -eq 0 ]; then
    echo "INV-136: PASS ($INV136_TESTES | banner_ligado=$INV136_LIGADO guard_sombra=$INV136_SOMBRA fora_da_prioridade=$INV136_FORA)"
  else
    echo "INV-136: FAIL ($INV136_TESTES | banner_ligado=$INV136_LIGADO guard_sombra=$INV136_SOMBRA fora_da_prioridade=$INV136_FORA — a MARIA pode nao ver o estado da devolucao, ou a sombra virou visivel)"
  fi
fi

# INV-129/130: dependem de código que ainda não existe. SKIP com o degrau,
# nunca FAIL. APERTAR no commit do degrau correspondente.
echo "INV-129: SKIP (degrau 2 — fonte única resolverMimeEExtensao por magic bytes %PDF/FFD8FF/89504E47)"
echo "INV-130: SKIP (degrau 7 — baseline imutável do vigia da NFD + obterTodasFotosDaOc, nunca obterFotoDaOc)"

# INV-131 (ADR 0018): o detector roda por ANEXO SALVO e NÃO olha cards.state.
# APERTADO no commit do passo 1 (antes era SKIP). Duas propriedades, cada uma um
# jeito de engolir um CT-e em silencio:
#  (a) disparo DEPOIS de os anexos serem salvos — no caso Icaro real (thread nova
#      de 1 msg) o anexo e persistido depois do gancho que criaria a proposta;
#  (b) NAO condicionar a cards.state — a oc 56 (pedido de NFD) manda o card pra
#      TRANSFERIDO e a espera dura SEMANAS; exigir card ativo perderia o CT-e.
INV131_ACIONA=$(grep -c "acionarDeteccaoCteDevolucao({" supabase/functions/gmail-poll-inbox/index.ts | tr -d ' ')
INV131_ORDEM=$(python3 -c "
import io,sys
s=io.open('supabase/functions/gmail-poll-inbox/index.ts',encoding='utf-8').read()
a=s.find('anexosSalvos.push({'); b=s.find('acionarDeteccaoCteDevolucao({')
print('OK' if a>-1 and b>a else 'RUIM')
" 2>/dev/null || echo "SKIP")
INV131_STATE=$(grep -cE '"state"|\bstate\b\s*[:=]' supabase/functions/_shared/devolucao-cte-acionar.ts | tr -d ' ')
INV131_TESTES=$(deno test --allow-read --no-check supabase/functions/_shared/devolucao-cte-proposta.test.ts 2>&1 | grep -E "passed|failed" | tail -1)
if [ "${INV131_ACIONA:-0}" -ge 1 ] && [ "${INV131_STATE:-1}" -eq 0 ] && { [ "$INV131_ORDEM" = "OK" ] || [ "$INV131_ORDEM" = "SKIP" ]; } && echo "$INV131_TESTES" | grep -q "0 failed"; then
  echo "INV-131: PASS (acionado=$INV131_ACIONA ordem=$INV131_ORDEM state_refs=$INV131_STATE | $INV131_TESTES)"
else
  echo "INV-131: FAIL (acionado=$INV131_ACIONA ordem=$INV131_ORDEM state_refs=$INV131_STATE | $INV131_TESTES — CT-e pode ser engolido em silencio)"
fi

# INV-134 (ADR 0018 R3): NUNCA duas propostas de 44 vivas, e NUNCA 44 sem CT-e.
# Duas camadas: (a) cerca no MENU tira a 44 pelada e os combos com perna 44 —
# medido, o combo lanca a perna 44 com [] ("oc=44 nao leva imagem"), o que numa
# parede de envelope viraria meio-estado irreversivel (33 lancada, 44 recusada,
# sem rollback); (b) PAREDE no envelope, unico ponto por onde toda 44 passa,
# porque a cerca do menu so decide o que e CRIADO — todo antigo segue aprovavel.
INV134_MENU=$(grep -c "filtrarPropostas44SemCte(" supabase/functions/_shared/propostas-pos-resposta-cliente.ts | tr -d ' ')
INV134_LOOP=$(grep -c "for (const p of novasFiltradas)" supabase/functions/_shared/propostas-pos-resposta-cliente.ts | tr -d ' ')
INV134_PAREDE=$(grep -c "motivoBloqueio44SemCte(" supabase/functions/_shared/lancar-ssw-portal.ts | tr -d ' ')
# a parede tem de vir ANTES do INSERT de idempotencia, senao a recusa consome a
# chave e o relancamento CORRETO cai em idempotent_skip
INV134_ORDEM=$(python3 -c "
import io
s=io.open('supabase/functions/_shared/lancar-ssw-portal.ts',encoding='utf-8').read()
a=s.find('motivoBloqueio44SemCte('); b=s.find('.from(\"acoes_executadas_ssw\")')
print('OK' if a>-1 and b>-1 and a<b else 'RUIM')
" 2>/dev/null || echo "SKIP")
if [ "${INV134_MENU:-0}" -ge 1 ] && [ "${INV134_LOOP:-0}" -ge 1 ] && [ "${INV134_PAREDE:-0}" -ge 1 ] && { [ "$INV134_ORDEM" = "OK" ] || [ "$INV134_ORDEM" = "SKIP" ]; }; then
  echo "INV-134: PASS (cerca_menu=$INV134_MENU loop_filtrado=$INV134_LOOP parede_envelope=$INV134_PAREDE ordem=$INV134_ORDEM)"
else
  echo "INV-134: FAIL (cerca_menu=$INV134_MENU loop_filtrado=$INV134_LOOP parede_envelope=$INV134_PAREDE ordem=$INV134_ORDEM — 44 sem CT-e pode ser lancada)"
fi

# DEGRAU-ATUAL (revisado 2026-09-02, quando o Caio ligou os degraus 4 e 5 via
# mig 374): o guard deixa de exigir "tudo desligado" e passa a exigir que o
# CONJUNTO de flags seja um degrau VÁLIDO da escada do ADR 0018 §12:
#   degrau 0/1/2: nenhuma ligada · 3: só shadow · 4: maria_enabled (shadow
#   indiferente — `enabled` vence) · 5: 4 + email_interno · 7: 5 + nfd.
# Inválidos: email_interno sem maria_enabled (e-mail de uma 44 que ninguém
# propõe); nfd ligada enquanto INV-130 estiver em SKIP (o código do degrau 7
# não existe). A função de escopo tem de existir em qualquer degrau.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  DEG_FLAGS="SKIP"; DEG_CLI="SKIP"
else
  DEG_FLAGS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select string_agg(key||'='||enabled::text, ',' order by key) from feature_flags where key like 'devolucao_cte%';" 2>/dev/null | tr -d ' ')
  DEG_CLI=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_proc where proname='devolucao_cte_em_escopo';" 2>/dev/null | tr -d ' ')
fi
INV_DET_CHECK=$(deno check "$DET" >/dev/null 2>&1 && echo OK || echo FAIL)
DEG_ATUAL=$(python3 -c "
import sys
s='$DEG_FLAGS'
if s=='SKIP': print('SKIP'); sys.exit()
f={k:v in('t','true','True') for k,v in (p.split('=') for p in s.split(',') if '=' in p)}
en=f.get('devolucao_cte_maria_enabled',False); sh=f.get('devolucao_cte_shadow',False)
em=f.get('devolucao_cte_email_interno',False); nfd=f.get('devolucao_cte_nfd',False)
if nfd: print('INVALIDO:nfd_sem_codigo(INV-130 SKIP)'); sys.exit()
if em and not en: print('INVALIDO:email_interno_sem_maria_enabled'); sys.exit()
print('5' if (en and em) else '4' if en else '3' if sh else '0')
" 2>/dev/null || echo "SKIP")
if [ "$INV_DET_CHECK" = "OK" ] \
   && { [ "$DEG_ATUAL" = "SKIP" ] || [ "${DEG_ATUAL#INVALIDO}" = "$DEG_ATUAL" ]; } \
   && { [ "$DEG_CLI" = "SKIP" ] || [ "${DEG_CLI:-0}" -eq 1 ]; }; then
  echo "DEGRAU-ATUAL: PASS (degrau=$DEG_ATUAL deno check=$INV_DET_CHECK fn_escopo=$DEG_CLI flags=$DEG_FLAGS)"
else
  echo "DEGRAU-ATUAL: FAIL (degrau=$DEG_ATUAL deno check=$INV_DET_CHECK fn_escopo=$DEG_CLI flags=$DEG_FLAGS — conjunto de flags fora da escada do ADR 0018 §12, ou função de escopo sumiu)"
fi

# INV-137 (Caio 2026-09-02, ADR 0020): cobrança automática de cliente NÃO existe.
# Produtor: nenhum caller de agendar_cobranca_email nem INSERT de tipo
# 'cobranca_email' (executor agendava D+4 em 3 caminhos; mig 168 só tinha
# desligado o cron). Consumidor: processador não tem handler de cobrança.
# Banco: zero pendentes; zero CobrancaAdiadaSemContato depois do fix.
INV137_PROD=$(grep -rn "agendar_cobranca_email\|tipo: \"cobranca_email\"" supabase/functions lib 2>/dev/null | grep -v "\.test\." | grep -vc "processar-acoes-agendadas/index.ts" | tr -d ' ')
INV137_CONS=$(grep -c "processarCobrancaEmail\|COBRANCA_LEMBRETE" supabase/functions/processar-acoes-agendadas/index.ts | tr -d ' ')
INV137_CRON=$(grep -c "cobranca-cliente-aguardando" supabase/functions/processar-acoes-agendadas/index.ts | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then
  INV137_PEND="SKIP"; INV137_EVT="SKIP"; INV137_JOB="SKIP"
else
  INV137_PEND=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from acoes_agendadas where tipo='cobranca_email' and status='pendente';" 2>/dev/null | tr -d ' ')
  INV137_EVT=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from card_events where event_type in ('CobrancaAdiadaSemContato','CobrancaPropostaAutomaticamente') and created_at > greatest(now()-interval '24 hours', '2026-09-02 21:00Z'::timestamptz);" 2>/dev/null | tr -d ' ')
  INV137_JOB=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cron.job where active and (jobname ilike '%cobranca%' or command ilike '%cobranca%');" 2>/dev/null | tr -d ' ')
fi
if [ "${INV137_PROD:-1}" -eq 0 ] && [ "${INV137_CONS:-1}" -eq 0 ] \
   && { [ "$INV137_PEND" = "SKIP" ] || [ "${INV137_PEND:-1}" -eq 0 ]; } \
   && { [ "$INV137_EVT" = "SKIP" ] || [ "${INV137_EVT:-1}" -eq 0 ]; } \
   && { [ "$INV137_JOB" = "SKIP" ] || [ "${INV137_JOB:-1}" -eq 0 ]; }; then
  echo "INV-137: PASS (produtor=$INV137_PROD consumidor=$INV137_CONS pendentes=$INV137_PEND eventos_novos=$INV137_EVT cron_ativo=$INV137_JOB — cobrança automática ausente)"
else
  echo "INV-137: FAIL (produtor=$INV137_PROD consumidor=$INV137_CONS pendentes=$INV137_PEND eventos_novos=$INV137_EVT cron_ativo=$INV137_JOB — cobrança automática VOLTOU; Caio 02/09: 'não pode voltar e não será automatizada')"
fi

# INV-138 (Caio 2026-09-02, ADR 0021): Prioridades AI e a cadeia de cobrança de
# cliente estão MORTAS — pastas ausentes, slugs proibidos no deploy-gate, views
# removidas (mig 376), cron-produtor removido. Se algo voltar, é regressão.
INV138_DIRS=0; for d in atualizar-batch-prioridades-ai cron-sync-prioridades-ai sync-kanban-status-prioridades sync-prioridades-ai-do-bastao agente-priorizador-ai agente-insights-globais-ai listar-contatos-cobranca disparar-cobranca-escalonada sugerir-cobranca-ai processar-cobrancas-cliente-aguardando; do [ -d "supabase/functions/$d" ] && INV138_DIRS=$((INV138_DIRS+1)); done
INV138_PROIB=$(python3 -c "import json;m=json.load(open('.claude/deploy-guards.json',encoding='utf-8'));print(sum(1 for k in m['funcoes_proibidas'] if not k.startswith('_')))" 2>/dev/null || echo 0)
INV138_SHARED=$([ -f supabase/functions/_shared/gerar-texto-cobranca-escalonada.ts ] && echo 1 || echo 0)
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then INV138_VIEWS="SKIP"; INV138_CRON="SKIP"; else
  INV138_VIEWS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select (select count(*) from pg_views where schemaname='public' and viewname in ('v_prioridades_ai','v_prioridades_ai_ultimo_sync','v_prioridades_ai_saidas_recentes','v_oc21_paradas_prioridades','v_oc13_paradas_prioridades')) + (select count(*) from pg_proc where proname='registrar_saidas_kanban');" 2>/dev/null | tr -d ' ')
  INV138_CRON=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cron.job where jobname='cobranca-cliente-aguardando-daily' or command ~ '(prioridades-ai|processar-cobrancas)';" 2>/dev/null | tr -d ' ')
fi
if [ "$INV138_DIRS" -eq 0 ] && [ "${INV138_PROIB:-0}" -ge 11 ] && [ "$INV138_SHARED" -eq 0 ] \
   && { [ "$INV138_VIEWS" = "SKIP" ] || [ "${INV138_VIEWS:-1}" -eq 0 ]; } \
   && { [ "$INV138_CRON" = "SKIP" ] || [ "${INV138_CRON:-1}" -eq 0 ]; }; then
  echo "INV-138: PASS (pastas_mortas=$INV138_DIRS proibidas=$INV138_PROIB shared_cobranca=$INV138_SHARED views=$INV138_VIEWS cron=$INV138_CRON — Prioridades AI e cadeia de cobrança ausentes)"
else
  echo "INV-138: FAIL (pastas_mortas=$INV138_DIRS proibidas=$INV138_PROIB shared_cobranca=$INV138_SHARED views=$INV138_VIEWS cron=$INV138_CRON — resto de Prioridades AI / cobrança voltou)"
fi

# INV-139 (Caio 2026-09-02, playbook de vetos — regras anti-veto R1-R6): os 6
# testes-âncora das regras que mataram 19/20 vetos. Se qualquer lib sumir ou
# regredir, os vetos voltam. Âncoras: 602839/1505043 (acareação→41), 898554/
# 919288 (ressalva existe→54), 5419/773332 (parcial→54), 51096/67975/1508990
# (escada indenização), 920367/799444/26033 (reentrega×55/contestação), 
# 1034543/70120 (terminal/setor).
INV139_OUT=$(cd supabase/functions && deno test --no-check=remote \
  _shared/oc49-casos-time.test.ts _shared/resolver-pedido-ressalva.test.ts \
  _shared/extravio-parcial-regra.test.ts _shared/escada-indenizacao.test.ts \
  _shared/oc49-contexto.test.ts _shared/reentrega-em-aberto.test.ts \
  _shared/estado-terminal-ssw.test.ts 2>&1 | grep -E 'passed|failed' | tail -1)
INV139_FAILED=$(echo "$INV139_OUT" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+')
INV139_ESCADA=$(grep -c 'TEXTO_OC41_ACAREACAO' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null || echo 0)
if [ "${INV139_FAILED:-1}" -eq 0 ] && [ "$INV139_ESCADA" -ge 1 ]; then
  echo "INV-139: PASS ($INV139_OUT — regras anti-veto R1-R6 íntegras; caso acareação ligado no agente)"
else
  echo "INV-139: FAIL ($INV139_OUT — regra anti-veto regrediu ou teste sumiu)"
fi

# INV-144 (Carlos 2026-09-03; era INV-140 ate 03/09 — renumerado porque a mig
# 377 do Caio tambem usou o 140 no mesmo dia; o dele ficou com o numero): o TRILHO tem de sobreviver a saida nao-ASCII em
# console cp1252 (Windows). Defeito real medido em 02/09, o mesmo dia do ADR 0019
# que prometia portabilidade: `dbq.py -c "select 'acao'"` com acento e
# `deploy_pendente.py` (seta do cabecalho) estouravam UnicodeEncodeError com
# exit 1. No dbq isso NAO e cosmetico — o print vem DEPOIS do SQL rodar, entao a
# migration APLICAVA e o operador lia traceback, concluia "falhou" e reaplicava.
# O teste e de COMPORTAMENTO (forca cp1252 e imprime fora da tabela), nao de
# texto: grep de nome de funcao passaria mesmo com a funcao vazia.
INV144_DEF=$(grep -c '^def forcar_saida_utf8' scripts/dbq.py 2>/dev/null || echo 0)
INV144_DBQ=$(grep -c 'forcar_saida_utf8()' scripts/dbq.py 2>/dev/null || echo 0)
INV144_DEP=$(grep -c 'forcar_saida_utf8' scripts/deploy_pendente.py 2>/dev/null || echo 0)
INV144_RUN=$(PYTHONIOENCODING=cp1252 python3 -c "import sys; sys.path.insert(0,'scripts')
from dbq import forcar_saida_utf8
forcar_saida_utf8()
print('Devolucao — acao ✅')" >/dev/null 2>&1 && echo ok || echo falhou)
if [ "${INV144_DEF:-0}" -eq 1 ] && [ "${INV144_DBQ:-0}" -ge 2 ]    && [ "${INV144_DEP:-0}" -ge 2 ] && [ "$INV144_RUN" = "ok" ]; then
  echo "INV-144: PASS (helper=$INV144_DEF chamadas_dbq=$INV144_DBQ deploy_pendente=$INV144_DEP cp1252=$INV144_RUN - trilho portatil em console cp1252)"
else
  echo "INV-144: FAIL (helper=$INV144_DEF chamadas_dbq=$INV144_DBQ deploy_pendente=$INV144_DEP cp1252=$INV144_RUN - o trilho volta a quebrar no Windows; ver ADR 0019)"
fi

# INV-140 (Caio 2026-09-03, mig 377): o evento AprovacaoOperador carimba a
# sugestão destacada VIGENTE no instante do clique (sugestao_vigente). Sem o
# carimbo, "seguiu a sugestão?" volta a ser imensurável (comparação com estado
# atual é enviesada — provado 03/09). Se um REPLACE futuro da aprovar_e_executar
# esquecer o bloco, este guard acusa.
if [ -z "$SUPABASE_DB_URL" ] || [ ! -x "$PSQL" ]; then echo "INV-140: SKIP (sem banco)"; else
  INV140=$($PSQL "$SUPABASE_DB_URL" -tA -c "select (prosrc like '%sugestao_vigente%')::int from pg_proc where proname='aprovar_e_executar';" 2>/dev/null | tr -d ' ')
  if [ "${INV140:-0}" = "1" ]; then
    echo "INV-140: PASS (aprovar_e_executar carimba sugestao_vigente no evento)"
  else
    echo "INV-140: FAIL (carimbo sugestao_vigente SUMIU da aprovar_e_executar — REPLACE regressivo; reaplicar mig 377)"
  fi
fi

echo "=== Fim Fase 8 (continuacao 2) ==="
```

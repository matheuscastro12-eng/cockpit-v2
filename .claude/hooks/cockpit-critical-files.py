#!/usr/bin/env python3
"""
PreToolUse hook — dispara mensagem com 3 perguntas obrigatórias + lista de
invariantes aplicáveis quando Claude edita arquivo crítico do Cockpit v2.

Catálogo canônico de invariantes: docs/INVARIANTES_COCKPIT.md
Mapeamento arquivo → INVs vem da seção "Mapa" desse arquivo.

Input via stdin (formato Claude Code hooks):
  { "tool_input": { "file_path": "..." }, ... }

Output via stdout (vazio se não-crítico, ou JSON com additionalContext):
  { "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": "..." } }
"""
import json
import sys

# Lookup arquivo → lista de IDs de invariantes aplicáveis.
# Mantido em sync com docs/INVARIANTES_COCKPIT.md (seção "Mapa").
INV_POR_ARQUIVO = {
    "supabase/functions/_shared/confirmar-acao-executada-ssw.ts": ["INV-002"],
    "supabase/functions/sync-bastao/index.ts": ["INV-003", "INV-004", "INV-006", "INV-007", "INV-008", "INV-011", "INV-019", "INV-040", "INV-148"],
    "supabase/functions/_shared/guard-anti-loop-criacao.ts": ["INV-040"],
    "supabase/functions/health-check/index.ts": ["INV-019", "INV-023"],
    "supabase/functions/_shared/inv023-indefinido-preso.ts": ["INV-023"],
    "supabase/functions/voltar-para-to-do-com-rastreio/index.ts": ["INV-001", "INV-005"],
    "supabase/functions/_shared/ssw-internal-client.ts": ["INV-001", "INV-013", "INV-063"],
    "supabase/functions/_shared/lancar-ssw-portal.ts": ["INV-013", "INV-014", "INV-063"],
    "supabase/functions/interpretador-evidencia-foto/index.ts": ["INV-001"],
    "supabase/functions/executor/index.ts": ["INV-002", "INV-008", "INV-011"],
    "supabase/functions/_shared/verificar-evidencia.ts": ["INV-001", "INV-011"],
    "supabase/functions/revalidar-evidencia-card/index.ts": ["INV-011"],
    "supabase/functions/vinculador/index.ts": ["INV-011"],
    "lib/bastao-rules.ts": ["INV-010", "INV-008"],
    "supabase/functions/_shared/bastao-rules.ts": ["INV-010", "INV-008"],
    "supabase/functions/_shared/regras-auto-acao.ts": ["INV-004", "INV-008"],
    "supabase/functions/_shared/transicao-aguardando-cliente.ts": ["INV-006", "INV-008"],
    "supabase/config.toml": ["INV-009"],
    # Correção 08.09 (ADR 0026). INV-147: pouca tinta não reprova conversão boa
    # e uma página ruim não derruba o PDF inteiro. INV-148: na oc 13,
    # `ativo` (visibilidade) e `autonomo_ativo` (autonomia) são interruptores
    # separados — um nunca substitui o outro.
    "apps/cockpit-web/src/lib/pdfConversaoGuard.ts": ["INV-147"],
    "apps/cockpit-web/src/components/cards/ProposedActions.tsx": ["INV-147"],
    "supabase/functions/_shared/pdf-conversao-guard.ts": ["INV-147"],
    "supabase/functions/agente-oc13-autonomo/index.ts": ["INV-148"],
    "supabase/functions/_shared/bastao-client.ts": ["INV-148"],
}

# Resumo curto de cada invariante (1 linha) pra exibir no hook sem precisar
# abrir docs/INVARIANTES_COCKPIT.md. Detalhe completo + comando de verificação
# vive no .md.
INV_RESUMO = {
    "INV-001": "Bastão=INPUT, SSW interno=SAÍDA. Nenhum caller novo de lib/ssw-tracking-client.ts.",
    "INV-002": "confirmar-acao-executada-ssw NÃO pode limpar bastao_oc_no_lancamento nem bastao_updated_at_no_lancamento.",
    "INV-003": "Pass A voltouParaRelacionamento usa guard combinado (oc + updated_at) — bastaoEhMesmoSnapshotDoLancamento.",
    "INV-004": "Pass A preserva chave_cte + propostas_recusadas_em/para_oc + bastao_updated_at no agent_state.",
    "INV-005": "voltar-para-to-do-com-rastreio usa SSW interno (buscarNFInterno), não tracking público.",
    "INV-006": "oc=54 ⟺ AGUARDANDO_CLIENTE, exceto cliente_respondeu_em != null.",
    "INV-007": "state ACAO_EXECUTADA blindado contra Pass B (filtro SELECT + early skip).",
    "INV-008": "stateFinalAposBastao é fonte única de mapeamento oc→state. Não duplicar tabela.",
    "INV-009": "Edge functions internas têm verify_jwt=false no config.toml (triador, vinculador, executor, etc).",
    "INV-010": "OCORRENCIAS_DE_RELACIONAMENTO contém 54. NUNCA remover (49 cards movidos errado em 2026-05-12).",
    "INV-011": "Callers de temEvidenciaParaOc / verificarEvidenciaESinalizar PASSAM ctrcEsperado quando há card com ctrc (NFs com múltiplos CTRCs = reentrega/complementar).",
    "INV-019": "Card AGUARDANDO_CLIENTE com oc de relacionamento ≠54 TEM que ir pra AGUARDANDO VOCÊ. NUNCA pode ficar preso (operador não vê = sem tratativa). 3 camadas: Pass A move na hora + sweep selfHealAguardandoClienteOcRelacionamento (sync-bastao) + watchdog checkAguardandoClienteOcRelacionamento (health-check, processo separado). NÃO remover nenhuma das 3 sem aprovação explícita do Caio. Regressão 2026-06-22 (Pass E desligado) travou 52 cards 5 dias.",
    "INV-040": "Sync NUNCA fabrica cards em loop: bloquearCriacaoSeLoopDetectado nos 2 pontos de criação (extravio + bastão) — ≥3 terminais da NF criados em 24h bloqueia criação + LoopCriacaoCardDetectado. NF 2084: 74 cards em rajada 14-15/07 (uniq parcial não segura card que nasce terminal). Caminho de criação novo = chamar o guard.",
}


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("{}")
        return

    file_path = (data.get("tool_input") or {}).get("file_path") or ""

    # Normaliza pra match relativo
    rel = next((k for k in INV_POR_ARQUIVO if file_path.endswith(k)), None)
    if not rel:
        print("{}")
        return

    invs = INV_POR_ARQUIVO[rel]
    invs_detalhe = "\n".join(f"   {iid} — {INV_RESUMO.get(iid, '?')}" for iid in invs)

    msg = f"""ARQUIVO CRITICO COCKPIT V2 - REGRA OBRIGATORIA antes de editar:

Voce esta mexendo em codigo que controla regras fundamentais. Mudancas aqui ja causaram bugs graves em producao (ex: 2026-05-12 remocao de oc=54 moveu 49 cards de AGUARDANDO_CLIENTE pra TRANSFERIDO; 2026-05-14 NF 1075381 reabriu indevidamente apos ssw confirmar oc=56).

INVARIANTES APLICAVEIS A ESTE ARQUIVO ({rel}):
{invs_detalhe}

Catalogo completo + comando de verificacao por INV: docs/INVARIANTES_COCKPIT.md

ANTES DE EDITAR, responda explicitamente as 3 perguntas no chat (sem essas 3 respostas, NAO PROSSIGA):

1. Qual regra fundamental esta sendo alterada? (cite a constante/funcao especifica + qual INV mapeia)

2. Lista TODAS as funcoes/passes que consultam essa regra DIRETAMENTE - use grep para verificar, nao confie em memoria. Cubra: Pass A (upsertCardFromPendencia), Pass B (releaseCard, releaseCardViaTracking), Pass C/D/E/F/G/H, vinculador, executor, regras-auto-acao, confirmar-acao-executada-ssw.

3. Se a regra for relaxada/removida, quais cenarios quebram? Mapeie pelo menos 2 casos reais (consulte cenario_real de cada INV citado).

APOS COMMIT/DEPLOY: rodar `/verify-cockpit` (Fase 8 = invariantes automatizados) pra confirmar que nenhum INV foi violado.

Invoque tambem skill supabase-postgres-best-practices se mexer em SQL/migration."""

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": msg,
        }
    }))


if __name__ == "__main__":
    main()

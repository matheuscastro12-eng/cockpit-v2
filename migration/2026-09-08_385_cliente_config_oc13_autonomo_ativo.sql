-- =============================================================================
-- 2026-09-08_385 — cliente_config_oc13: separa VISIBILIDADE de AUTONOMIA
-- =============================================================================
-- Correção 08.09 (Carlos, caso NF 1037746 / PRATI DONADUZZI). ADR 0026.
--
-- PROBLEMA: `cliente_config_oc13` é UM interruptor só pra DUAS coisas
-- diferentes:
--   (1) VISIBILIDADE — o sync-bastao puxa a pendência de oc 13 desse CNPJ e o
--       card nasce na fila do operador (2ª query do fetchPendenciasDoCockpit +
--       override de state no Pass A);
--   (2) AUTONOMIA — o `agente-oc13-autonomo` (cron 5min) passa a agir sobre
--       esses cards: lança oc 21 + cancela reentrega via
--       auto_aprovar_e_executar (SEM aprovação por card), ou agenda a ação
--       destacada na janela de veto de 60min (que pode ser oc 54 + e-mail pro
--       cliente).
--
-- Medido em 08/09 no banco: 962 decisões do agente até hoje (669 sugerir 54 +
-- e-mail, 141 sugerir 21+cancel, 129 sugerir 56, **23 autônomas**) e 1.379
-- lançamentos de oc 21 com sucesso. A flag `acao_autonoma_veto_enabled` está
-- LIGADA e a LARISSA está habilitada em `acoes_autonomas_veto_operadores`.
--
-- Ou seja: hoje, incluir um CNPJ na lista pra "o card aparecer" liga junto um
-- robô que age sem autorização do cliente. Regra do negócio (Carlos, 08/09):
-- **o cliente sempre precisa ser notificado antes, e só com autorização dele é
-- possível seguir.** Logo os dois interruptores TÊM que ser separados.
--
-- -----------------------------------------------------------------------------
-- TIPO A (política de migrations, docs/POLITICA_MIGRATIONS.md): aditiva e
-- reversível. Um único ADD COLUMN, nada mais.
--   - sem UPDATE/DELETE/TRUNCATE;
--   - sem ALTER COLUMN (é o que o classificador do dbq.py trata como TIPO B);
--   - sem DROP, sem GRANT, sem CREATE OR REPLACE de objeto existente;
--   - sem INSERT em tabela operacional;
--   - não é "flag nascendo ligada" em feature_flags.
-- Reversível: ALTER TABLE ... DROP COLUMN autonomo_ativo.
--
-- ⚠ Blast radius ao aplicar: **ZERO**. A coluna nasce NULA nas 15 linhas
--   existentes, e NULL foi definido como "comporta-se como antes" — o
--   `agente-oc13-autonomo` filtra por `autonomo_ativo IS NOT FALSE`. Nenhum
--   cliente de hoje perde nem ganha autonomia ao rodar isto.
--
-- ⚠ Por que NULL-como-ligado, e não DEFAULT false: `ADD COLUMN ... DEFAULT
--   false` PREENCHERIA as 15 linhas existentes com false e DESLIGARIA a
--   autonomia de O.V.D., Ferramentas Gerais, União Química, Black & Decker,
--   F E F e Fortpel de uma vez — regressão silenciosa em 4 carteiras. E
--   corrigir isso exigiria UPDATE (TIPO B) dentro desta migration. O default
--   seguro pra linhas NOVAS entra na mig 386, que já é TIPO B por causa do
--   INSERT e portanto já passa por autorização explícita.
--
-- ⚠ SEM BEGIN/COMMIT interno (política 13/08): o scripts/dbq.py já envolve o
--   arquivo na transação dele. COMMIT aqui encerraria a transação externa e
--   transformaria o --dry-run em no-op.
--
-- skill `supabase-postgres-best-practices`: NÃO está instalada nesta sessão
-- (mesma situação registrada na ADR 0025). Regras aplicadas manualmente a
-- partir dos precedentes do repo: idempotente (IF NOT EXISTS),
-- schema-qualified, sem SECURITY DEFINER novo, sem view (logo sem risco de
-- perder security_invoker), sem índice novo (a tabela tem 15 linhas — índice
-- em coluna booleana aqui só custaria escrita), RLS da tabela intocada.
-- =============================================================================

ALTER TABLE public.cliente_config_oc13
  ADD COLUMN IF NOT EXISTS autonomo_ativo boolean;

COMMENT ON COLUMN public.cliente_config_oc13.autonomo_ativo IS
  'Correção 08.09 (ADR 0026). Separa AUTONOMIA de VISIBILIDADE. '
  'NULL = comporta-se como antes da mig 385 (agente-oc13-autonomo AGE). '
  'true = agente age. false = card aparece pro operador mas o agente NÃO age '
  '— use false quando o cliente exigir ser notificado e autorizar antes '
  '(regra Carlos 08/09). Quem lê: agente-oc13-autonomo (filtro '
  '"autonomo_ativo IS NOT FALSE"). Quem NÃO lê: sync-bastao — visibilidade '
  'continua sendo só a coluna "ativo".';

-- Conferência (não muda nada): as 15 linhas de hoje seguem NULL = como antes.
--   select nome_cliente, cnpj_pagador, ativo, autonomo_ativo
--     from public.cliente_config_oc13 order by nome_cliente;

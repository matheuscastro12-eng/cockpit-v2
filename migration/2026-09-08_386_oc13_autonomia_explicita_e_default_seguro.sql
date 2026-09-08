-- =============================================================================
-- 2026-09-08_386 — oc 13: autonomia EXPLÍCITA nos 15 atuais + default seguro
-- =============================================================================
-- Correção 08.09 (Carlos). ADR 0026. Roda DEPOIS da mig 385.
--
-- ## ORDEM E AUTORIZACAO
--
-- Carlos, 08/09, literal no chat: "entendi, siga com as tres etapas,
-- autorizado. no final, se estiver tudo 100%, autorizado a apagar a brench
-- criada." Autorizacao dada apos explicacao previa, no mesmo chat, do que cada
-- uma das 3 etapas faz e do blast radius de cada uma.
-- Autonomia: docs/POLITICA_MIGRATIONS.md, TIPO B, revisao 02/09 = "o Caio ou o
-- Carlos" autorizam, com a autorizacao DECLARADA aqui, no --autorizado-por e
-- no commit.
--
-- O que faz, e só isso:
--   1. Carimba autonomo_ativo = true nas linhas que estão NULL (as 15 de hoje).
--      NULL já era lido como "agente age" pelo agente-oc13-autonomo, então isto
--      NÃO muda comportamento — apenas torna explícito o que estava implícito.
--   2. Passa o DEFAULT da coluna pra false. Assim toda linha NOVA nasce com o
--      robô DESLIGADO: cliente novo entra pra APARECER na fila do operador, e
--      ligar o robô pra ele passa a ser um ato separado e deliberado.
--   3. NOT NULL, pra não voltar a existir estado "indefinido" na coluna.
--
-- Regra de negócio que motiva o default false (Carlos, 08/09):
--   "O cliente sempre precisa ser notificado antes e somente com a autorização
--    dele é possível seguir."
-- Um robô que lança oc 21 e cancela reentrega sozinho contraria isso. Então o
-- padrão do sistema passa a ser: aparece pro humano, não age sozinho.
--
-- -----------------------------------------------------------------------------
-- TIPO B (docs/POLITICA_MIGRATIONS.md) — exige --autorizado-por. Motivos que o
-- classificador do scripts/dbq.py acusa, todos verdadeiros:
--   • "UPDATE em dado de produção" (o carimbo do passo 1);
--   • "ALTER TABLE ... ALTER COLUMN (tipo/default/null)" (passos 2 e 3).
--
-- ⚠ Blast radius: **nenhuma mudança de comportamento**.
--   - Os 15 CNPJs de hoje (O.V.D. ×5, Ferramentas Gerais ×4, União Química ×2,
--     Black & Decker ×2, F E F ×1, Fortpel ×1) continuam com o agente agindo,
--     agora com true escrito em vez de NULL.
--   - O default só afeta INSERT futuro.
--   - Nenhum card muda de estado; nenhuma ação SSW é disparada por esta
--     migration.
--
-- ⚠ ORDEM OBRIGATÓRIA DE DEPLOY (a mig 385 tem que estar aplicada):
--     385 (coluna)  →  386 (este arquivo)  →  deploy do agente-oc13-autonomo
--   O agente tolera a coluna ausente (faz fallback com aviso no log, mantendo
--   o comportamento antigo), então inverter a ordem não derruba nada — mas
--   também não entrega a proteção. Aplicar 385 e 386 ANTES do deploy.
--
-- ⚠ SEM BEGIN/COMMIT interno (política 13/08) — o dbq.py já abre a transação.
--
-- Reversível:
--   ALTER TABLE public.cliente_config_oc13 ALTER COLUMN autonomo_ativo DROP NOT NULL;
--   ALTER TABLE public.cliente_config_oc13 ALTER COLUMN autonomo_ativo SET DEFAULT NULL;
--   -- (e, se for pra voltar ao estado anterior de verdade: mig 385 DROP COLUMN)
--
-- skill `supabase-postgres-best-practices`: não instalada nesta sessão (ADR
-- 0025 registra a mesma situação). Regras aplicadas manualmente: idempotente
-- (o UPDATE tem WHERE IS NULL; os ALTERs são convergentes), schema-qualified,
-- tabela de 15 linhas (UPDATE sem risco de lock longo), RLS intocada, sem
-- SECURITY DEFINER, sem view.
-- =============================================================================

-- 1. Explicita o que já valia (NULL era lido como "agente age").
UPDATE public.cliente_config_oc13
   SET autonomo_ativo = true
 WHERE autonomo_ativo IS NULL;

-- 2. Cliente NOVO nasce com o robô desligado.
ALTER TABLE public.cliente_config_oc13
  ALTER COLUMN autonomo_ativo SET DEFAULT false;

-- 3. Sem estado indefinido daqui pra frente.
ALTER TABLE public.cliente_config_oc13
  ALTER COLUMN autonomo_ativo SET NOT NULL;

-- Conferência esperada: 15 linhas, todas ativo=t e autonomo_ativo=t.
--   select count(*) filter (where ativo) as visiveis,
--          count(*) filter (where autonomo_ativo) as com_robo,
--          count(*) as total
--     from public.cliente_config_oc13;

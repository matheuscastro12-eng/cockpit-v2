-- =============================================================================
-- 2026-09-08_388 — TRAVA temporaria: PRATI invisivel ate o deploy do agente
-- =============================================================================
-- Correcao 08.09 (Carlos). ADR 0026. Roda DEPOIS da mig 387.
--
-- ## ORDEM E AUTORIZACAO
--
-- Carlos, 08/09, literal no chat: "entendi, siga com as tres etapas,
-- autorizado." Esta migration NAO e uma 4a etapa nova: e a trava de seguranca
-- que a propria etapa 3 exige enquanto o deploy nao acontece. Eu havia
-- declarado a dependencia no mesmo chat, antes da autorizacao: "O deploy tem
-- que vir DEPOIS das migrations — o agente ja tolera a coluna ausente, mas o
-- inverso deixaria a Prati visivel sem a trava de autonomia."
-- Autonomia: docs/POLITICA_MIGRATIONS.md, TIPO B, revisao 02/09.
--
-- ## POR QUE ELA EXISTE (risco MEDIDO em 08/09, apos aplicar 385/386/387)
--
-- A ordem correta de implantacao e: migrations -> deploy do agente -> ligar a
-- visibilidade. As migrations foram aplicadas; o DEPLOY NAO ACONTECEU (a CLI
-- do Supabase nao esta instalada nesta maquina; deploy e do Caio).
--
-- Estado real no momento em que esta migration foi escrita:
--   * cron.job 23 `agente-oc13-autonomo` = schedule "3-59/5 * * * *", active=true;
--   * a versao EM PRODUCAO do agente NAO conhece `autonomo_ativo` — ela
--     seleciona `cnpj_pagador from cliente_config_oc13 where ativo = true`;
--   * logo, com a PRATI em ativo=true, o agente deployado a trata como
--     elegivel e pode lancar oc 21 + cancelar reentrega via
--     auto_aprovar_e_executar, SEM aprovacao por card;
--   * `sync-bastao` (que le SO a coluna `ativo`, INV-148) ja esta liberado a
--     criar o card de oc 13 da Prati no proximo ciclo.
--
-- Ocorrencia lancada no SSW NAO TEM DESFAZER (mesma advertencia da mig 383).
-- E a regra do negocio (Carlos, 08/09) e absoluta: "o cliente sempre precisa
-- ser notificado antes e somente com a autorizacao dele e possivel seguir."
--
-- ## O QUE ELA FAZ, E SO ISSO
--
-- Poe ativo=false nas 2 linhas da PRATI. Isso devolve, PARA A PRATI, exatamente
-- o estado anterior a mig 387: invisivel pro sync-bastao e invisivel pro
-- agente. `autonomo_ativo=false` fica preservado, entao o desfazer e so voltar
-- ativo=true.
--
-- ⚠ NAO e regressao: a Prati esta invisivel desde 28/08 (e por isso que a NF
--   1037746 nunca chegou na Larissa). Esta migration NAO piora nada — ela so
--   ADIA o ganho por algumas horas, em troca de nao ligar um robo que age sem
--   o cliente.
--
-- ⚠ Blast radius: 2 linhas, as duas da PRATI. As outras 15 nao sao tocadas
--   (WHERE por cnpj_pagador explicito). Nenhuma carteira perde autonomia.
--
-- ⚠ NAO mexer no cron 23 como alternativa: desligar o cron pararia a autonomia
--   das 15 carteiras legitimas (regressao ampla) e religar varre backlog
--   acumulado. A trava escopada nos 2 CNPJs e a acao minima.
--
-- ## COMO DESFAZER (a mig 389, DEPOIS do deploy)
--
--   1. `supabase functions deploy agente-oc13-autonomo` (le autonomo_ativo);
--   2. conferir no log que o agente NAO cai no fallback da coluna ausente;
--   3. UPDATE ... SET ativo = true WHERE cnpj_pagador in ('73856593001057',
--      '73856593000166');  -- autonomo_ativo JA e false, o robo segue quieto
--   4. conferir que o card da oc 13 da Prati aparece pra Larissa e que
--      agente_oc13_feedback NAO registra decisao autonoma pra esses CNPJs.
--
-- ⚠ SEM BEGIN/COMMIT interno (regra 13/08): o dbq.py envolve na transacao dele.
-- =============================================================================

UPDATE public.cliente_config_oc13
   SET ativo = false,
       observacao = observacao ||
         ' [TRAVA mig 388 (08/09): ativo=false TEMPORARIO ate o deploy do '
         'agente-oc13-autonomo que le autonomo_ativo. A versao em producao '
         'filtra so por ativo=true e agiria sem autorizacao do cliente. '
         'Reverter com a mig 389 DEPOIS do deploy.]'
 WHERE cnpj_pagador IN ('73856593001057', '73856593000166');

-- Conferencia:
--   select nome_cliente, cnpj_pagador, ativo, autonomo_ativo
--     from public.cliente_config_oc13 order by ativo, nome_cliente;

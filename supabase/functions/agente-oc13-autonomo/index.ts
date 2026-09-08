// =============================================================================
// agente-oc13-autonomo — orquestrador IA pra cards oc=13 de clientes exceção
// (cliente_config_oc13). Cron 5min. Caio 2026-05-22.
//
// Correção 08.09 (migs 385/386, ADR 0026, INV-148): este agente é governado por
// `cliente_config_oc13.autonomo_ativo`, NÃO por `ativo`. `ativo` só decide se o
// card APARECE pro operador (isso é do sync-bastao). Cliente pode estar visível
// e com o robô desligado — é o padrão pra quem exige ser notificado e autorizar
// antes de qualquer ação (regra Carlos 08/09, caso PRATI DONADUZZI).
//
// Árvore de decisão:
// 1. Fora 8h-18h BRT seg-sex + instrução "LOCAL FECHADO" → autônomo oc=21 + cancel
// 2. Sem foto → autônomo oc=21 + cancel
// 3. Tem foto → chama interpretador-evidencia-foto pra classificar
// 4. Motivo consolidado (instrução do motorista OU ressalva na foto) null/genérico
//    → autônomo oc=21 + cancel + reportar erro (EVIDÊNCIA INCOMPLETA)
// 5. Foto OK + motivo OK → sugestão pro operador (oc=54+email com template)
//
// Casos âncora:
//   NF 132682: local fechado + 18h03 → autônomo "FORA HORÁRIO COMERCIAL"
//   NF 111809: foto destinatário + sem instrução → autônomo "SEM MOTIVO ESCRITO"
// =============================================================================
//
// INV-001: usa SSW interno (via interpretador-evidencia-foto e puxar-historico-ssw-card),
// nunca tracking público.
// INV-009: verify_jwt=false (memory feedback_interpretador_verify_jwt_false)
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sugerirTemplateEmailOc13 } from "../_shared/oc13-template-email.ts";
import { isHorarioComercialBRT } from "../_shared/horario-comercial.ts";
import { agendarAcaoAutonomaSeElegivel } from "../_shared/veto-agendamento.ts";
import { sanitizarTextoSsw, ehMotivoSswGenerico, ehMotivoAcionavelParaCliente, removerMarcadoresSswmobile } from "../_shared/sanitizar-texto-ssw.ts";
import { categorizarErroSsw, ehCategoriaTransiente, resetarFalhasTransientesSeHorarioOk } from "../_shared/categorizar-erro-ssw.ts";
import { startAgentRun, finishAgentRun, classifyStatus } from "../_shared/agent-runs-logger.ts";
// Caio 2026-07-01 (NF 1093446, INV-027): banner do oc13 precisa carregar o
// acao_key da ação recomendada — sem ele o front casa o botão por NÚMERO e cai
// na 54 SEM e-mail (gêmea oposta). acaoKey monta "tool:codigo_ssw".
import { acaoKey } from "../_shared/regras-auto-acao.ts";
import { gerarTextoSsw56, OC13_SUBTIPO_LACUNA } from "../_shared/texto-ssw-56.ts";
// isHorarioComercialBRT já importado acima via horario-comercial.ts

const BATCH_LIMIT = 20;
const MAX_TENTATIVAS = 3;
const RETRY_INTERVAL_MIN = 10;
// Janela ampla pra cobrir backlog — MAX_TENTATIVAS controla custo
const CRIADO_HA_NO_MAX_HORAS = 24 * 30;

// "Motivos genéricos" do motorista que NÃO contam como motivo escrito válido
const MOTIVOS_GENERICOS_DEFAULT = [
  ".", "-", "x", "ok", "n/a", "na", "sem info", "sem informacao", "sem informação",
];

interface OcorrenciaHistorico {
  codigo: number | null;
  descricao: string | null;
  instrucao: string | null;
  data: string | null;
  filial: string | null;
  usuario: string | null;
  tem_foto: boolean;
}

interface DecisaoOrquestrador {
  decisao: "autonoma" | "sugerir_54_email" | "sugerir_56" | "sugerir_21_cancel";
  subtipo: string;
  motivo_extraido?: string | null;
  motivo_cancelamento?: string;
  texto_descricao?: string;
  foto_classificacao?: string;
  confianca?: number;
  template_email?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false, error: "POST/GET esperado" }, 405);
  }

  const env = Deno.env.toObject();
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Self-healing: cards travados em falhou por categoria transiente
  // voltam pra pendente quando entra horário comercial BRT.
  // Caio 2026-05-24.
  const resetados = await resetarFalhasTransientesSeHorarioOk(supabase, isHorarioComercialBRT, {
    statusCol: "analise_oc13_status",
    tentativasCol: "analise_oc13_tentativas",
    resultadoCol: "analise_oc13_resultado",
    atualizadoEmCol: "analise_oc13_atualizado_em",
    avisoTipoAguardando: "ia_oc13_aguardando",
  });

  // 1. SELECT cards elegíveis
  const limiteCriacao = new Date(Date.now() - CRIADO_HA_NO_MAX_HORAS * 60 * 60 * 1000).toISOString();
  const limiteRetry = new Date(Date.now() - RETRY_INTERVAL_MIN * 60 * 1000).toISOString();

  // CNPJs exceção da oc 13.
  //
  // Correção 08.09 (migs 385/386, ADR 0026): `cliente_config_oc13` deixou de
  // ser UM interruptor pra duas coisas. Agora:
  //   `ativo`          = VISIBILIDADE — o sync-bastao puxa a pendência e o card
  //                      nasce na fila do operador. NÃO é lido aqui.
  //   `autonomo_ativo` = AUTONOMIA  — se ESTE agente pode agir (lançar oc 21 +
  //                      cancelar reentrega via auto_aprovar_e_executar, ou
  //                      agendar a ação destacada na janela de veto).
  //
  // Este agente é a AUTONOMIA. Cliente com ativo=true e autonomo_ativo=false
  // aparece pro operador e NÃO é tocado aqui — caso da PRATI DONADUZZI, onde a
  // regra do negócio é que o cliente precisa ser notificado e autorizar antes
  // (Carlos, 08/09).
  let excecaoRows: Array<{ cnpj_pagador: string; autonomo_ativo?: boolean | null }>;
  {
    const q = await supabase
      .from("cliente_config_oc13")
      .select("cnpj_pagador, autonomo_ativo")
      .eq("ativo", true);
    if (q.error) {
      // Tolerância de ORDEM DE DEPLOY: se esta versão subir antes da mig 385,
      // a coluna não existe (PostgREST 42703). Cai pro comportamento ANTERIOR
      // com aviso gritado no log, em vez de derrubar o agente e deixar os
      // clientes de hoje sem tratativa. Some sozinho quando a 385 é aplicada.
      if (!/autonomo_ativo/i.test(q.error.message)) {
        return json({ ok: false, error: `cliente_config_oc13: ${q.error.message}` }, 500);
      }
      console.warn(
        "[agente-oc13] ⚠ coluna autonomo_ativo AUSENTE — migs 385/386 não aplicadas. " +
          "Rodando no comportamento antigo (todo CNPJ ativo é autônomo). Aplicar as migrations.",
      );
      const fb = await supabase
        .from("cliente_config_oc13")
        .select("cnpj_pagador")
        .eq("ativo", true);
      if (fb.error) return json({ ok: false, error: `cliente_config_oc13: ${fb.error.message}` }, 500);
      excecaoRows = (fb.data ?? []) as Array<{ cnpj_pagador: string }>;
    } else {
      excecaoRows = (q.data ?? []) as Array<{ cnpj_pagador: string; autonomo_ativo?: boolean | null }>;
    }
  }

  // NULL = como era antes da mig 385 (age). Só `false` proíbe — e proíbe de
  // verdade: sem entrar neste Set, o card não é nem lido por este agente.
  const cnpjsExcecao = new Set(
    excecaoRows.filter((r) => r.autonomo_ativo !== false).map((r) => r.cnpj_pagador),
  );

  if (cnpjsExcecao.size === 0) {
    return json(
      { ok: true, processados: 0, motivo: "nenhum CNPJ com autonomia da oc 13 ligada" },
      200,
    );
  }

  const { data: candidatos, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, ctrc, base_destino, responsavel_relacionamento, agent_state, " +
            "assigned_operator_id, pagador, segmento_codigo, analise_oc13_status, " +
            "analise_oc13_tentativas, analise_oc13_atualizado_em, historico_ssw, created_at, " +
            "state, lock_aguardando_validacao, cod_ultima_ocorrencia")
    .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
    .eq("lock_aguardando_validacao", true)
    .eq("cod_ultima_ocorrencia", 13)
    .gt("created_at", limiteCriacao)
    .lt("analise_oc13_tentativas", MAX_TENTATIVAS)
    .or(`analise_oc13_status.is.null,analise_oc13_status.in.(pendente,falhou),analise_oc13_status.eq.analisando,and(analise_oc13_atualizado_em.lt.${limiteRetry})`)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT * 3); // sobre-fetch pra filtrar CNPJ depois
  if (selErr) return json({ ok: false, error: `SELECT cards: ${selErr.message}` }, 500);

  // Filtro de CNPJ exceção (não dá pra fazer no Postgres porque cnpj_pagador vem do jsonb agent_state)
  const elegiveis = (candidatos ?? []).filter((c) => {
    const cnpj = ((c.agent_state as Record<string, unknown>)?.["cnpj_pagador"] as string | undefined);
    if (!cnpj) return false;
    if (!cnpjsExcecao.has(cnpj)) return false;
    // Skip se analisando recente (lock)
    if (c.analise_oc13_status === "analisando" && c.analise_oc13_atualizado_em) {
      if (new Date(c.analise_oc13_atualizado_em).getTime() > Date.now() - RETRY_INTERVAL_MIN * 60 * 1000) {
        return false;
      }
    }
    return true;
  }).slice(0, BATCH_LIMIT);

  const stats = { processados: 0, autonomos: 0, sugestoes_manuais: 0, falhas: 0, skipped_op_antecipou: 0 };
  const motivosGenericos = (env["OC13_MOTIVOS_GENERICOS"] ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  const motivosGenericosFinais = motivosGenericos.length > 0 ? motivosGenericos : MOTIVOS_GENERICOS_DEFAULT;

  for (const card of elegiveis) {
    stats.processados++;
    const cardId = card.id as string;

    // Marca analisando + incrementa tentativa
    const novaTent = (card.analise_oc13_tentativas as number ?? 0) + 1;
    await supabase
      .from("cards")
      .update({
        analise_oc13_status: "analisando",
        analise_oc13_tentativas: novaTent,
        analise_oc13_atualizado_em: new Date().toISOString(),
      })
      .eq("id", cardId);

    const runHandle = startAgentRun({
      agentName: "agente-oc13-autonomo",
      stepName: `tent=${novaTent}`,
      cardId,
      input: { tentativa: novaTent, max_tentativas: MAX_TENTATIVAS },
    });

    try {
      // 2. Puxa histórico SSW (chama edge interna)
      const histRes = await fetch(`${env["SUPABASE_URL"]}/functions/v1/puxar-historico-ssw-card`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
          apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_id: cardId }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!histRes.ok) {
        const errBody = await histRes.text();
        const cat = categorizarErroSsw("puxar-historico", histRes.status, errBody);
        throw new ClassifiedError(cat.categoria, `puxar-historico-ssw-card ${histRes.status}: ${errBody.slice(0, 200)}`, cat.mensagem_operador);
      }
      const histJson = await histRes.json() as { ocorrencias?: OcorrenciaHistorico[] };
      const ocorrencias = histJson.ocorrencias ?? [];

      // Encontra linha oc=13 mais recente
      const oc13Linhas = ocorrencias.filter((o) => o.codigo === 13);
      if (oc13Linhas.length === 0) {
        throw new ClassifiedError("historico_sem_oc13", "histórico SSW não tem oc=13");
      }
      const linha13 = oc13Linhas[0]!; // já ordenado mais recente primeiro

      const temFoto = linha13.tem_foto === true;
      // Caio 2026-05-23 (NF 1494821): instrução SSW pode vir com HTML
      // (<!--...-->, <a href=GPS...>) — sanitizar antes de usar em motivos
      // e corpos de email pro cliente.
      const instrucao = sanitizarTextoSsw(linha13.instrucao);
      const dataEventoIso = parseDataSsw(linha13.data);

      // 3. Árvore de decisão
      let decisao: DecisaoOrquestrador | null = null;

      // Regra: fora horário comercial + LOCAL FECHADO
      const foraHorario = dataEventoIso ? !isHorarioComercialBRT(dataEventoIso) : false;
      const ehLocalFechado = /local\s*fechado/i.test(instrucao);
      if (foraHorario && ehLocalFechado) {
        decisao = {
          decisao: "autonoma",
          subtipo: "fora_horario_comercial",
          motivo_extraido: instrucao,
          motivo_cancelamento: "FORA DO HORARIO COMERCIAL",
          texto_descricao: `Reentrega cancelada — oc=13 lançada em ${linha13.data} (LOCAL FECHADO) fora do horário comercial seg-sex 8h-18h.`,
        };
      } else if (!temFoto) {
        decisao = {
          decisao: "autonoma",
          subtipo: "sem_foto",
          motivo_extraido: null,
          motivo_cancelamento: "EVIDENCIA INCOMPLETA SEM FOTO",
          texto_descricao: "Reentrega cancelada — oc=13 lançada sem foto anexada (evidência incompleta).",
        };
      } else {
        // 4. Tem foto → chama interpretador
        const interpRes = await fetch(`${env["SUPABASE_URL"]}/functions/v1/interpretador-evidencia-foto`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
            apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ card_id: cardId, codigo_oc: 13 }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!interpRes.ok) {
          const errText = (await interpRes.text()).slice(0, 300);
          if (interpRes.status === 502 && /Anthropic/i.test(errText)) {
            throw new ClassifiedError("timeout_anthropic", errText);
          }
          if (/oc_sem_foto|oc_nao_encontrada/i.test(errText)) {
            throw new ClassifiedError("foto_corrompida", errText);
          }
          const cat = categorizarErroSsw("interpretador", interpRes.status, errText);
          throw new ClassifiedError(cat.categoria, `interpretador ${interpRes.status}: ${errText}`, cat.mensagem_operador);
        }
        const interpJson = await interpRes.json() as { ok?: boolean; analise?: Record<string, unknown> };
        if (!interpJson.ok || !interpJson.analise) {
          throw new ClassifiedError("json_invalido", `interpretador retornou ok=false`);
        }
        const an = interpJson.analise;
        const fotoClass = (an["foto_classificacao"] as string | undefined) ?? "aleatoria";
        const temRessalva = an["tem_ressalva_na_foto"] === true;
        const ressalvaTexto = ((an["ressalva_texto"] as string | null | undefined) ?? "").trim();
        const confianca = typeof an["confianca"] === "number" ? an["confianca"] as number : 0;

        // 5. Árvore de decisão final (Caio 2026-05-23 — regra conservadora):
        //
        //   Dimensões:
        //     FOTO: AUSENTE | PORCA (aleatoria/ilegivel) | OK (destinatario/local_fechado)
        //     DESC: AUSENTE | PORCA (SSWMOBILE/vaga) | ACIONAVEL (recusa/endereço/etc)
        //
        //   Matriz:
        //                | desc AUSENTE  | desc PORCA           | desc ACIONAVEL  |
        //   foto AUSENTE | AUTÔNOMO      | SUGERE 56            | SUGERE 56       |
        //   foto PORCA   | AUTÔNOMO      | SUGERE 21+cancel     | SUGERE 56       |
        //   foto OK      | SUGERE 56     | SUGERE 56            | SUGERE 54+email |
        //
        //   AUTÔNOMO (oc=21+cancel sem validação) APENAS quando NÃO há descrição
        //   E foto é ausente OU porca. Qualquer descrição (mesmo vaga) exige
        //   validação humana.

        const textoTrivial = (s: string) => {
          const t = s.trim().toLowerCase();
          return !t || t.length < 3 || [".", "-", "x", "ok", "n/a"].includes(t);
        };
        const instrucaoExiste = !textoTrivial(instrucao);
        const ressalvaExiste = temRessalva && !textoTrivial(ressalvaTexto);
        // Limpa marcadores SSWMOBILE/GPS/SEFAZ antes de salvar/enviar pro cliente
        // (Caio 2026-05-23 NF 2299043) — não polui motivo_extraido nem corpo do email.
        const motivoRaw: string | null = instrucaoExiste
          ? instrucao
          : (ressalvaExiste ? ressalvaTexto : null);
        const motivoConsolidado: string | null = motivoRaw ? removerMarcadoresSswmobile(motivoRaw) || null : null;

        // Status dimensão DESC
        type DescStatus = "AUSENTE" | "PORCA" | "ACIONAVEL";
        let descStatus: DescStatus;
        if (!motivoConsolidado) {
          descStatus = "AUSENTE";
        } else if (
          ehMotivoSswGenerico(motivoConsolidado, motivosGenericosFinais) ||
          !ehMotivoAcionavelParaCliente(motivoConsolidado)
        ) {
          descStatus = "PORCA";
        } else {
          descStatus = "ACIONAVEL";
        }

        // Status dimensão FOTO
        type FotoStatus = "AUSENTE" | "PORCA" | "OK";
        let fotoStatus: FotoStatus;
        if (!temFoto || fotoClass === "sem_foto") {
          fotoStatus = "AUSENTE";
        } else if (fotoClass === "aleatoria" || fotoClass === "ilegivel") {
          fotoStatus = "PORCA";
        } else {
          fotoStatus = "OK"; // destinatario | local_fechado | destinatario_com_ressalva
        }

        // Aplica matriz
        if (descStatus === "AUSENTE" && (fotoStatus === "AUSENTE" || fotoStatus === "PORCA")) {
          // AUTÔNOMO — sem descrição + (sem foto ou foto porca)
          const subtipo = fotoStatus === "AUSENTE" ? "sem_foto_sem_descricao" : "foto_porca_sem_descricao";
          const motivoCancel = fotoStatus === "AUSENTE"
            ? "EVIDENCIA INCOMPLETA - SEM FOTO E SEM DESCRICAO"
            : "EVIDENCIA INCOMPLETA - FOTO PORCA E SEM DESCRICAO";
          decisao = {
            decisao: "autonoma",
            subtipo,
            motivo_extraido: null,
            motivo_cancelamento: motivoCancel,
            texto_descricao: `Reentrega cancelada — oc=13 sem evidência real (${subtipo.replace(/_/g, " ")}).`,
            foto_classificacao: fotoClass,
            confianca,
          };
        } else if (descStatus === "PORCA" && fotoStatus === "PORCA") {
          // SUGERE oc=21+cancel (operador valida) — evidência ruim total
          decisao = {
            decisao: "sugerir_21_cancel",
            subtipo: "foto_porca_e_descricao_porca",
            motivo_extraido: motivoConsolidado,
            motivo_cancelamento: "EVIDENCIA RUIM - FOTO PORCA E DESCRICAO PORCA (revisar antes de cancelar)",
            foto_classificacao: fotoClass,
            confianca,
          };
        } else if (fotoStatus === "OK" && (descStatus === "PORCA" || descStatus === "AUSENTE")) {
          // Caio 2026-05-28 (NF 143567 OVD oc=13 local_fechado + "MOTIVO DO
          // FECHANENTO LUITO ."): foto VALIDA (mostra local fechado /
          // destinatário) + texto digitado pelo motorista é porco ou ausente.
          // Operação fez a tentativa real; pedir oc=56 (operação re-evidenciar)
          // gera atraso e desgaste com cliente pra nada — o melhor caminho é
          // formalizar oc=21 + cancelar reentrega já. Operador aprova.
          const subtipo = descStatus === "AUSENTE"
            ? "foto_ok_sem_descricao"
            : "foto_ok_descricao_porca";
          const motivoCancel = descStatus === "AUSENTE"
            ? "EVIDENCIA OK - SEM DESCRICAO DO MOTORISTA, NAO VALE NOTIFICAR CLIENTE"
            : "EVIDENCIA OK - DESCRICAO DO MOTORISTA INSUFICIENTE, NAO VALE NOTIFICAR CLIENTE";
          decisao = {
            decisao: "sugerir_21_cancel",
            subtipo,
            motivo_extraido: motivoConsolidado,
            motivo_cancelamento: motivoCancel,
            foto_classificacao: fotoClass,
            confianca,
          };
        } else if (descStatus === "ACIONAVEL" && fotoStatus === "OK") {
          // SUGERE oc=54+email — caso ideal
          decisao = {
            decisao: "sugerir_54_email",
            subtipo: "evidencia_completa",
            motivo_extraido: motivoConsolidado,
            foto_classificacao: fotoClass,
            confianca,
            template_email: sugerirTemplateEmail(motivoConsolidado!, fotoClass),
          };
        } else {
          // Demais casos → SUGERE oc=56 (operação revisa antes de cliente)
          let subtipo: string;
          if (descStatus === "AUSENTE") {
            subtipo = "foto_ok_sem_descricao"; // foto OK + sem texto pra justificar cliente
          } else if (fotoStatus === "AUSENTE") {
            subtipo = "sem_foto_com_descricao";
          } else if (descStatus === "PORCA") {
            subtipo = "foto_ok_descricao_porca";
          } else {
            subtipo = "foto_porca_descricao_acionavel"; // foto não bate mas texto pode
          }
          decisao = {
            decisao: "sugerir_56",
            subtipo,
            motivo_extraido: motivoConsolidado,
            foto_classificacao: fotoClass,
            confianca,
          };
        }
      }

      // 6. Executa decisão
      if (decisao.decisao === "autonoma") {
        const okExec = await executarAutonomo(supabase, env, card, linha13, decisao);
        if (okExec === "operador_antecipou") {
          stats.skipped_op_antecipou++;
        } else {
          stats.autonomos++;
        }
      } else {
        await aplicarSugestaoManual(supabase, cardId, decisao);
        stats.sugestoes_manuais++;
      }

      // 7. Marca concluída
      await supabase
        .from("cards")
        .update({
          analise_oc13_status: "concluida",
          analise_oc13_atualizado_em: new Date().toISOString(),
        })
        .eq("id", cardId);

      await finishAgentRun(supabase, runHandle, {
        status: "success",
        output: {
          decisao: decisao.decisao,
          subtipo: decisao.subtipo ?? null,
          template_email: decisao.template_email ?? null,
        },
      });
    } catch (err) {
      const categoria = err instanceof ClassifiedError ? err.categoria : "erro_desconhecido";
      const mensagemOperador = err instanceof ClassifiedError
        ? (err.mensagemOperador ?? "Falha inesperada na análise IA — tentando novamente.")
        : "Falha inesperada na análise IA — tentando novamente.";
      const msg = err instanceof Error ? err.message : String(err);
      stats.falhas++;

      // Transiente (fora horário, login flake, SSW offline, timeout) → não vira
      // falhou definitivo. Rollback do contador pra cron tentar de novo.
      const transiente = ehCategoriaTransiente(categoria);
      const statusFinal = transiente ? "pendente" : "falhou";
      const tentativaFinal = transiente ? Math.max(0, novaTent - 1) : novaTent;

      await supabase
        .from("cards")
        .update({
          analise_oc13_status: statusFinal,
          analise_oc13_tentativas: tentativaFinal,
          analise_oc13_resultado: {
            erro_msg: msg.slice(0, 500),
            categoria,
            mensagem_operador: mensagemOperador,
            transiente,
            tentativa: novaTent,
            max_tentativas: MAX_TENTATIVAS,
          },
          aviso_alteracao_oc: {
            tipo: transiente ? "ia_oc13_aguardando" : "ia_oc13_falhou",
            categoria,
            mensagem_operador: mensagemOperador,
            erro_msg: msg.slice(0, 300),
            tentativa: novaTent,
            max_tentativas: MAX_TENTATIVAS,
            atualizado_em: new Date().toISOString(),
          },
          analise_oc13_atualizado_em: new Date().toISOString(),
        })
        .eq("id", cardId);

      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "AgenteOc13Falhou",
        actor_type: "agent",
        actor_id: "agente-oc13-autonomo",
        payload: { categoria, erro: msg.slice(0, 500), tentativa: novaTent },
      });

      await finishAgentRun(supabase, runHandle, {
        status: classifyStatus(err),
        errorMessage: `[${categoria}] ${msg.slice(0, 500)}`,
        output: { categoria, transiente, tentativa: novaTent, max_tentativas: MAX_TENTATIVAS },
      });
    }
  }

  return json({ ok: true, ...stats, elegiveis: elegiveis.length, total_candidatos: (candidatos ?? []).length, resetados_horario_comercial: resetados }, 200);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ClassifiedError extends Error {
  categoria: string;
  mensagemOperador: string | null;
  constructor(categoria: string, msg: string, mensagemOperador: string | null = null) {
    super(msg);
    this.categoria = categoria;
    this.mensagemOperador = mensagemOperador;
  }
}

function parseDataSsw(d: string | null | undefined): string | null {
  // Formato SSW: "DD/MM/AA HH:MM"
  if (!d) return null;
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const dd = m[1]!.padStart(2, "0");
  const mm = m[2]!.padStart(2, "0");
  const aa = m[3]!;
  const hh = m[4]!.padStart(2, "0");
  const mi = m[5]!;
  // BRT -03:00 fixo (sem DST conforme convenção projeto)
  return `20${aa}-${mm}-${dd}T${hh}:${mi}:00-03:00`;
}

// ehMotivoGenerico foi substituído por ehMotivoSswGenerico em _shared/
// sanitizar-texto-ssw.ts (Caio 2026-05-23, NF 1494821) — agora detecta
// padrões automáticos SSWMOBILE/SEFAZ/GPS.

// Caio 2026-08-25 (NF 153826): escolha do template extraída pra módulo PURO
// _shared/oc13-template-email.ts (testável) — feriado/local fechado ganhou
// template próprio ("Podemos reentregar?"); o funil antigo mandava 100% pro
// PROBLEMAS_COM_ENDERECO.
const sugerirTemplateEmail = sugerirTemplateEmailOc13;

async function executarAutonomo(
  supabase: ReturnType<typeof createClient>,
  env: Record<string, string>,
  card: Record<string, unknown>,
  linha13: OcorrenciaHistorico,
  decisao: DecisaoOrquestrador,
): Promise<"ok" | "operador_antecipou"> {
  const cardId = card.id as string;
  const cnpjPagador = ((card.agent_state as Record<string, unknown>)?.["cnpj_pagador"] as string | null) ?? null;
  // Caio 2026-06-08: chaveCte removida — executor agora lança via portal
  // interno (lancarSswPortal) que resolve o seq_ctrc via card.ctrc + NF.
  const cnpjRemetente = ((card.agent_state as Record<string, unknown>)?.["cnpj_remetente"] as string | null) ?? null;

  // 1. Cria todo proposta oc=21 com extras
  const actionId = crypto.randomUUID();
  const { data: insertedTodo, error: todoErr } = await supabase
    .from("todos")
    .insert({
      card_id: cardId,
      action_id: actionId,
      descricao: "Lançar oc=21 (autônomo) — evidência incompleta / fora horário",
      status: "pendente",
      proposta_payload: {
        tool: "lancar_ocorrencia",
        args: {
          codigo_ssw: 21,
          nf: card.nf,
          cnpj_remetente: cnpjRemetente,
          descricao: decisao.texto_descricao ?? "Reentrega solicitada (autônomo)",
          extras: {
            texto_descricao: decisao.texto_descricao,
            cancelar_reentrega_24h: true,
            motivo_cancelamento: decisao.motivo_cancelamento ?? "EVIDENCIA INCOMPLETA",
            origem: "agente-oc13-autonomo",
            subtipo_autonomo: decisao.subtipo,
          },
        },
        rationale: `Decisão autônoma agente-oc13-autonomo: ${decisao.subtipo}. ` +
                   `Motivo cancelamento: ${decisao.motivo_cancelamento}.`,
        texto: null,
      },
    })
    .select("id")
    .single();
  if (todoErr || !insertedTodo) {
    throw new Error(`INSERT todo: ${todoErr?.message ?? "todo nulo"}`);
  }
  const todoId = insertedTodo.id as string;

  // 2. auto_aprovar_e_executar
  const { error: autoErr } = await supabase.rpc("auto_aprovar_e_executar", {
    p_todo_id: todoId,
    p_regra: `oc13_autonomo_${decisao.subtipo}`,
  });
  if (autoErr) {
    // Card pode ter saído de AVH (operador antecipou). Trata graciosamente.
    if (/EXECUTANDO_ACAO|state|approval/i.test(autoErr.message)) {
      await supabase.from("todos").delete().eq("id", todoId);
      await supabase
        .from("cards")
        .update({
          analise_oc13_resultado: {
            decisao: "operador_antecipou",
            motivo: "card já estava executando ou state inesperado",
            auto_aprovar_erro: autoErr.message,
          },
        })
        .eq("id", cardId);
      return "operador_antecipou";
    }
    throw new Error(`auto_aprovar_e_executar: ${autoErr.message}`);
  }

  // 3. Reporta erro no indicador (categoria EVIDENCIA_INCOMPLETA)
  const motivoErro = (() => {
    if (decisao.subtipo === "fora_horario_comercial") {
      return `oc=13 lançada em ${linha13.data} fora do horário comercial seg-sex 8h-18h (descrição: LOCAL FECHADO)`;
    }
    if (decisao.subtipo === "sem_foto") {
      return "oc=13 lançada sem qualquer foto anexada";
    }
    return `oc=13 com foto classificada como '${decisao.foto_classificacao}' e sem motivo escrito do motorista`;
  })();

  const { error: errReport } = await supabase.rpc("reportar_erro_lancamento_via_agente", {
    p_card_id: cardId,
    p_codigo_oc_errada: 13,
    p_codigo_oc_correta: 13, // mesma — categoria EVIDENCIA_INCOMPLETA
    p_descricao_oc_errada: linha13.descricao,
    p_data_oc_errada: linha13.data,
    p_base_responsavel: linha13.filial,
    p_usuario_responsavel: linha13.usuario,
    p_motivo: motivoErro,
    p_motivo_categoria: "EVIDENCIA_INCOMPLETA",
    p_agente_nome: "agente-oc13-autonomo",
  });
  if (errReport) {
    console.warn(`reportar_erro_via_agente falhou (card=${cardId}): ${errReport.message}`);
    // Não throw — ação principal já executou; só perde indicador
  }

  // 4. Snapshot em cards_auditoria
  await snapshotAuditoria(supabase, cardId, `oc13_autonoma_${decisao.subtipo}`, decisao);

  // 5. Grava resultado + banner
  await supabase
    .from("cards")
    .update({
      analise_oc13_resultado: {
        decisao: "autonoma",
        subtipo: decisao.subtipo,
        motivo_cancelamento: decisao.motivo_cancelamento,
        texto_descricao: decisao.texto_descricao,
        foto_classificacao: decisao.foto_classificacao,
        confianca: decisao.confianca,
        motivo_extraido: decisao.motivo_extraido,
        todo_id: todoId,
      },
      aviso_alteracao_oc: {
        tipo: "ia_oc13_autonoma",
        subtipo: decisao.subtipo,
        motivo_cancelamento: decisao.motivo_cancelamento,
        atualizado_em: new Date().toISOString(),
      },
    })
    .eq("id", cardId);

  // 6. Audit event
  // JANELA DE VETO (plano 25/08 — substitui a via instantânea por fatia,
  // risco 25). Ação destacada → agendamento de 60min úteis com cercas; a
  // operadora vê o countdown e pode editar/cancelar. Fail-safe: inelegível →
  // fluxo humano de hoje. oc do card aqui é sempre 13. ADR 0016.
  await agendarAcaoAutonomaSeElegivel(supabase, {
    cardId,
    agentName: "agente-oc13-autonomo",
    ocCard: 13,
    ocSugerida: (() => {
      const n = Number((propostaDestacadaAcao ?? "").split(":")[1]);
      return Number.isFinite(n) ? n : null;
    })(),
    acaoKey: propostaDestacadaAcao,
    confianca: decisao.confianca ?? null,
  });

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AgenteOc13Decisao",
    actor_type: "agent",
    actor_id: "agente-oc13-autonomo",
    payload: {
      decisao: "autonoma",
      subtipo: decisao.subtipo,
      motivo_cancelamento: decisao.motivo_cancelamento,
      foto_classificacao: decisao.foto_classificacao,
      confianca: decisao.confianca,
      todo_id: todoId,
      cnpj_pagador: cnpjPagador,
    },
  });

  return "ok";
}

async function aplicarSugestaoManual(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  decisao: DecisaoOrquestrador,
): Promise<void> {
  const ehSugestao56 = decisao.decisao === "sugerir_56";
  const ehSugestao21Cancel = decisao.decisao === "sugerir_21_cancel";
  const temTemplate = decisao.decisao === "sugerir_54_email";

  let sugestaoLabel: string;
  let tipoAviso: string;
  let observacao: string | null = null;
  if (ehSugestao21Cancel) {
    sugestaoLabel = "oc=21 + cancelar reentrega";
    tipoAviso = "ia_sugestao_oc13_21_cancel";
    // Caio 2026-05-28: observação varia conforme subtipo. Pra foto_ok_* a
    // racional é "evidência boa mas texto motorista ruim/ausente — pedir
    // re-evidência atrasa e desgasta cliente; melhor cancelar reentrega".
    // Pra foto_porca_e_descricao_porca a racional é "evidência ruim total".
    if (decisao.subtipo === "foto_ok_descricao_porca" || decisao.subtipo === "foto_ok_sem_descricao") {
      observacao =
        "Foto da evidência é válida, mas o texto do motorista não dá pra notificar cliente. " +
        "Pedir re-evidência atrasa a tratativa sem ganho — recomendo cancelar reentrega.";
    } else {
      observacao = "Evidência ruim (foto porca + descrição porca) — recomendado cancelar reentrega, mas valide antes";
    }
  } else if (ehSugestao56) {
    sugestaoLabel = "oc=56";
    tipoAviso = "ia_sugestao_oc13_revisar";
    observacao = "Operação revisar antes de cliente";
  } else {
    sugestaoLabel = "oc=54+email";
    tipoAviso = "ia_sugestao_oc13";
  }

  // Caio 2026-07-08: instrução operacional da 56 pré-preenchida (o que falta).
  // Vai pro campo Instrução do SSW (via prefill do textarea, editável). Mapeia o
  // subtipo do oc=13 → lacuna via OC13_SUBTIPO_LACUNA (fonte única, compartilhada
  // com o backfill); fallback genérico cobre subtipo novo.
  const textoSsw56: string | null = ehSugestao56
    ? gerarTextoSsw56(OC13_SUBTIPO_LACUNA[decisao.subtipo ?? ""] ?? "generico", {
      codigoOc: 13,
      motivoInterpretador: decisao.motivo_extraido ?? null,
    })
    : null;

  // Caio 2026-07-01 (NF 1093446, INV-027): identidade PRECISA da ação destacada.
  // O front casa o banner por acao_key (== todo.proposta_payload.acao_key), NUNCA
  // pelo número — "54" sozinho é ambíguo entre "+ e-mail" (notifica) e "sem e-mail"
  // (não notifica), e a sem-email costuma vir primeiro na lista. sugerir_54_email
  // ⇒ a ação recomendada É a que ENVIA e-mail. 56 sem twin; 21_cancel casa por
  // número (sem gêmea de e-mail) → null, igual ao agente-sugere-ocs-padrao.
  const propostaDestacadaAcao: string | null = temTemplate
    ? acaoKey("lancar_oc_e_enviar_email", 54)
    : ehSugestao56
      ? acaoKey("lancar_ocorrencia", 56)
      : null;

  await supabase
    .from("cards")
    .update({
      analise_oc13_resultado: {
        decisao: decisao.decisao,
        subtipo: decisao.subtipo,
        motivo_extraido: decisao.motivo_extraido,
        template_email_sugerido: temTemplate ? decisao.template_email : null,
        motivo_cancelamento_sugerido: ehSugestao21Cancel ? decisao.motivo_cancelamento : null,
        foto_classificacao: decisao.foto_classificacao,
        confianca: decisao.confianca,
        proposta_destacada_acao: propostaDestacadaAcao,
        texto_ssw_sugerido: textoSsw56,
      },
      aviso_alteracao_oc: {
        tipo: tipoAviso,
        sugestao: sugestaoLabel,
        proposta_destacada_acao: propostaDestacadaAcao,
        template: temTemplate ? decisao.template_email : null,
        motivo_extraido: decisao.motivo_extraido,
        motivo_cancelamento: ehSugestao21Cancel ? decisao.motivo_cancelamento : null,
        foto_classificacao: decisao.foto_classificacao,
        confianca: decisao.confianca,
        observacao,
        texto_ssw_sugerido: textoSsw56,
        atualizado_em: new Date().toISOString(),
      },
    })
    .eq("id", cardId);

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AgenteOc13Decisao",
    actor_type: "agent",
    actor_id: "agente-oc13-autonomo",
    payload: {
      decisao: decisao.decisao,
      subtipo: decisao.subtipo,
      motivo_extraido: decisao.motivo_extraido,
      template_email_sugerido: temTemplate ? decisao.template_email : null,
      motivo_cancelamento_sugerido: ehSugestao21Cancel ? decisao.motivo_cancelamento : null,
      foto_classificacao: decisao.foto_classificacao,
      confianca: decisao.confianca,
    },
  });
}

async function snapshotAuditoria(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  motivo: string,
  decisao: DecisaoOrquestrador,
): Promise<void> {
  // Idempotência: se já tem snapshot por esse motivo, skip
  const { data: existente } = await supabase
    .from("cards_auditoria")
    .select("id")
    .eq("card_id_original", cardId)
    .eq("motivo", motivo)
    .maybeSingle();
  if (existente) return;

  const { data: cardFull } = await supabase
    .from("cards")
    .select("*")
    .eq("id", cardId)
    .maybeSingle();
  if (!cardFull) return;

  const { data: todos } = await supabase
    .from("todos")
    .select("*")
    .eq("card_id", cardId);

  const { data: events } = await supabase
    .from("card_events")
    .select("*")
    .eq("card_id", cardId)
    .order("created_at", { ascending: true });

  await supabase.from("cards_auditoria").insert({
    card_id_original: cardId,
    motivo,
    nf: cardFull.nf,
    ctrc: cardFull.ctrc,
    empresa_cliente: cardFull.pagador,
    cod_ultima_ocorrencia: cardFull.cod_ultima_ocorrencia,
    state_no_snapshot: cardFull.state,
    cnpj_pagador: (cardFull.agent_state as Record<string, unknown> | null)?.["cnpj_pagador"] ?? null,
    card_snapshot: { ...cardFull, _decisao_ia: decisao },
    todos_snapshot: todos ?? [],
    events_snapshot: events ?? [],
  });

  await supabase
    .from("cards")
    .update({
      em_auditoria: true,
      auditoria_motivo: motivo,
      auditoria_added_at: new Date().toISOString(),
    })
    .eq("id", cardId);
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

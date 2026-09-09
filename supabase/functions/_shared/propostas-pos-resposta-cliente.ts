// =============================================================================
// propostas-pos-resposta-cliente — fonte ÚNICA das propostas que o operador vê
// quando o cliente responde uma tratativa (oc=54 → CLIENTE RESPONDEU).
//
// Caio 2026-06-23 (NF 761583, INV-016): extraído do vinculador/index.ts pra
// virar módulo compartilhado. ANTES a criação de propostas vivia SÓ dentro do
// vinculador, que fica ATRÁS do triador (classificação via LLM). Quando a
// Anthropic estourou 529, o triador jogou a mensagem do cliente no dead_letter
// → vinculador nunca rodou → 0 propostas. O scan-email-pre-card já tinha setado
// `cliente_respondeu_em` + o cron `cron-ia-resposta-pendentes` já tinha gravado
// `ia_sugestao_oc_resposta` → card ficou "cliente respondeu, IA sugeriu oc 44,
// ZERO botões pra aprovar". Regra inviolável violada: cliente respondeu e o
// operador não viu a ação no Cockpit.
//
// Agora a criação de propostas é DETERMINÍSTICA (sem LLM) e chamada por:
//   - vinculador (caminho normal, pós-classificação)
//   - scan-email-pre-card (adoção de thread pré-existente — DIRETO, sem depender
//     do re-enqueue→triador)
//   - cron-ia-resposta-pendentes (rede de segurança: garante propostas pra
//     qualquer card com cliente_respondeu_em != null e 0 todos pendentes)
//
// Idempotente: rodar N vezes não duplica (whitelist por codigo_ssw + tipo_acao).
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  classificarOc33,
  decidirGateOc33,
  dossieVazio,
  lerExtravioParcial,
} from "./extravio-parcial-dossie.ts";
import { aplicarPacoteOc11PosResposta } from "./oc11-pos-resposta.ts";
import { aplicarInstrucaoEmailNaProposta21 } from "./instrucao-email-21.ts";
import { gravarDestaqueRespostaCliente } from "./destaque-resposta-cliente.ts";
import { aplicarTexto56NaProposta } from "./texto-56-sugerido.ts";
import { aplicarAnexosSugeridos33 } from "./anexos-33-sugeridos.ts";
import { agendarAcaoAutonomaSeElegivel } from "./veto-agendamento.ts";

// Aceita qualquer instanciação de client (vinculador, scan-email-pre-card,
// cron-ia-resposta-pendentes passam clients com generics diferentes). <any> evita
// o erro "Type 'public' is not assignable to type 'never'" do schema tipado.
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

// R3 da devolução com CT-e (ADR 0018): num card com ciclo de CT-e ABERTO, a 44
// "pelada" e os combos com perna 44 lançariam a ocorrência SEM o documento —
// contra a decisão nº 3. A cerca é uma função pura, testada.
import { filtrarPropostas44SemCte } from "./devolucao-cte-44.ts";

export interface PropostasInfo {
  cancelados: number;
  criados: Array<{ codigo_ssw: number; tipo_acao?: string; todoId: string }>;
  ja_existentes: number[];
  /** Caio 2026-05-12: tipos especiais (relancamento_54, combo_33_44) que
   * idempotência detecta separado do codigo_ssw. Sem isso, combo_33_44 (que
   * tem codigo_ssw=33 igual ao 33-solo) duplica. */
  ja_existentes_tipos: string[];
}

/** Template do e-mail de indenização por extravio total (pedir romaneio). */
export const TEMPLATE_INDENIZACAO_TOTAL = "EXTRAVIO_TOTAL_PEDIR_ROMANEIO";

/**
 * Extravio TOTAL escalado (Larissa 2026-08-05, NF 1102187): o card virou oc 49/54
 * ("PRAZO PERDAS EXPIRADO") e o menu pós-resposta (trilho tratativa, âncora≠59)
 * não oferecia o 59 de indenização — o override 54→59 já tinha criado o 59+email
 * (template EXTRAVIO_TOTAL_PEDIR_ROMANEIO) mas a escalada/menu cancelavam.
 *
 * SINAL de extravio total (durável, sobrevive à sobrescrita do agent_state): a
 * presença de QUALQUER todo 59 com esse template no card. Só o override de total
 * cria isso → gate seguro (não pega tratativa normal). Funções puras testáveis.
 */
export function ehExtravioTotalPorTodos59(
  todos59Total: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  return todos59Total.length > 0;
}

/**
 * Qual 59+email de indenização reviver: o mais recente CANCELADO, e só se não
 * houver nenhum já ativo (pendente/aprovado) — senão viola o índice único
 * `uniq_todos_card_tool_cod_ativo`. Devolve null quando nada a fazer.
 */
export function escolher59IndenizacaoParaReviver(
  todos59Total: ReadonlyArray<{ id: string; status: string }>,
): string | null {
  if (todos59Total.length === 0) return null;
  if (todos59Total.some((t) => t.status === "pendente" || t.status === "aprovado")) return null;
  return todos59Total.find((t) => t.status === "cancelado")?.id ?? null;
}

/**
 * Templates de oc 59 que representam PEDIDO DE DOCUMENTO ao cliente — os três
 * `..._PEDIR_ROMANEIO`. Medido no banco em 2026-09-09 (todos os to-dos de oc 59):
 *   EXTRAVIO_TOTAL_PEDIR_ROMANEIO            5682   (total)
 *   ENTREGUE_COM_FALTA_PEDIR_ROMANEIO        5279   (parcial, oc 19)
 *   EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO  552   (parcial, devolver)
 *
 * DE FORA de propósito (são notificação, NÃO pedido de documento — incluí-los
 * ofereceria 59 onde não há pendência documental):
 *   EXTRAVIO_PARCIAL 456, RECUSA_TOTAL 22, RECUSA_PARCIAL 13,
 *   TENTATIVAS_ESGOTADAS 2, e os 7159 sem template (gêmeos sem e-mail).
 */
export const TEMPLATES_59_PEDIDO_DOCUMENTO = [
  TEMPLATE_INDENIZACAO_TOTAL,
  "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
  "EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO",
] as const;

/**
 * PENDÊNCIA DE DOCUMENTO em aberto (Karol 2026-09-09, NF 75249).
 *
 * BUG: no trilho tratativa (âncora≠59) o 59 só sobrevivia ao menu pós-resposta
 * se o card fosse extravio TOTAL — `ehExtravioTotalPorTodos59` exige o template
 * EXTRAVIO_TOTAL_PEDIR_ROMANEIO, que só o override de total cria. Num card
 * PARCIAL (oc 19 = entrega com falta de volumes, template
 * ENTREGUE_COM_FALTA_PEDIR_ROMANEIO) a regra da oc 19 propunha o 59 e o menu
 * pós-resposta o cancelava como "obsoleto" minutos depois. Caso âncora medido:
 * NF 75249, 59 criado 03/09 22:01:31, cancelado 22:07:07 pelo menu.
 *
 * Regra do Carlos (09/09): "a existência de uma ocorrência anterior não deve
 * bloquear uma nova sugestão quando a condição que exige essa ocorrência
 * continuar ou voltar a existir". O critério certo é PENDÊNCIA DE DOCUMENTO em
 * aberto — não "é total?".
 *
 * ⚠ ESTE SINAL SÓ PRESERVA, NUNCA RESSUSCITA. A revivência de 59 cancelado
 * segue gated por `ehExtravioTotalPorTodos59` (total), de propósito: alargar a
 * revivência mexeria em 3307 cards abertos de uma vez e o 59 revivido pode ser
 * auto-aprovado pela janela de veto (medido: 75 to-dos de 59 com
 * auto_approval_rule `veto_janela:...:lancar_oc_e_enviar_email:59`) — ou seja,
 * e-mail ao cliente sem clique do operador. Preservar um pendente que o próprio
 * sistema acabou de propor não tem esse risco.
 */
export function temPendenciaDocumento59(
  todos59PedidoDoc: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  return todos59PedidoDoc.some((t) => t.status === "pendente" || t.status === "aprovado");
}

/**
 * Quando cliente responde em card AGUARDANDO_CLIENTE, atualiza o conjunto
 * de propostas pendentes pra: [21, 44, 55, 56, 54-relançar, 33-combo, 33-solo].
 *
 * - Mantém 21 que já existe (regra oc=54 cria 21+55)
 * - Mantém 55 (Caio 2026-06-03 NF 66193 LARISSA INOVAMED: cliente respondeu
 *   autorizando entrega parcial; IA sugeriu 55 mas proposta não existia).
 *   Faz sentido pra TODO card pós-resposta cliente: cliente pode autorizar
 *   seguir parcial após notificação inicial via oc=54.
 * - Cria 44 (retorno carga → Devolução), 56 (falta info → Operação),
 *   54-relançar (re-aguardar cliente, sem email), combo 33+44, oc=33 solo
 *
 * Idempotente: se rodar 2x, não duplica.
 */
export async function atualizarPropostasAposRespostaCliente(
  supabase: SupabaseClient,
  cardId: string,
): Promise<PropostasInfo> {
  const info: PropostasInfo = { cancelados: 0, criados: [], ja_existentes: [], ja_existentes_tipos: [] };

  // 1. Carrega card (nf, ctrc, agent_state pra chave_cte/cnpj)
  // Caio 2026-05-11: ctrc preferencial pro lookup_chave_cte priorizar CT-e normal
  const { data: card } = await supabase
    .from("cards")
    .select("nf, ctrc, agent_state, cod_ultima_ocorrencia")
    .eq("id", cardId)
    .single();
  if (!card) return info;

  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  // Caio 2026-07-13 (separação 54/59): a oc-âncora do card decide o TRILHO do menu
  // pós-resposta. 59 (RETORNO INDENIZAÇÃO) → menu focado (33-solo / combo 33+44 /
  // re-aguardar 59). 54 (RETORNO TRATATIVA) → menu completo (21/44/55/56 + re-aguardar
  // 54 + 33/combo). Decisão de transição: o 54 MANTÉM 33/combo pra não quebrar cards
  // que ainda estão em 54 mas são indenização (resíduo "sem certeza" + janela pré-Fase 5).
  const anchorOc = (card.cod_ultima_ocorrencia as number | null) ?? null;
  const trilhoIndenizacao = anchorOc === 59;
  const ocReaguardar = anchorOc === 59 ? 59 : 54;
  // Gate da oc 33 no extravio parcial (Caio 2026-07-01, NF 66193): anota cada
  // proposta de oc 33 com a natureza (operacional/completude) + se está
  // bloqueada pelo dossiê incompleto. NÃO remove a proposta (modo AVISADO — o
  // front desabilita e mostra "faltam X"). Card não-parcial → ehParcial=false →
  // nada muda (extravio total intacto). Enforce real fica no executor.
  const estadoParcial = lerExtravioParcial({ agent_state: agentState });
  const ehParcial = estadoParcial !== null;
  const casoParcial = estadoParcial?.caso ?? null;
  const dossieParcial = estadoParcial?.dossie ?? dossieVazio();
  const oc33Bloqueadas: Array<{ natureza: string; faltando: string[]; tipo_acao?: string }> = [];
  const nf = card.nf as string | null;
  const ctrcCard = (card.ctrc as string | null) ?? null;
  const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ?? cnpjPagador ?? null;
  const cnpjRemetenteCru =
    (agentState["cnpj_remetente"] as string | undefined) ?? null; // mig 320: resolver de e-mail usa o CRU
  let chaveCTe = (agentState["chave_cte"] as string | undefined) ?? null;

  if (!chaveCTe && nf) {
    const { data: lookup } = await supabase.rpc("lookup_chave_cte", {
      p_nf: nf,
      p_cnpj_pagador: cnpjPagador,
      p_ctrc: ctrcCard,
    });
    const row = Array.isArray(lookup) ? lookup[0] : null;
    if (row && typeof row.chave_cte === "string") {
      chaveCTe = row.chave_cte;
    }
  }

  // Sinal de extravio TOTAL escalado: todos (qualquer status) de oc 59 com o
  // template de indenização. Só o override 54→59 de total cria isso → gate
  // seguro. Usado pra manter/reviver o 59+email no trilho tratativa (âncora≠59).
  const { data: todos59Raw } = await supabase
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", cardId)
    .eq("proposta_payload->args->>codigo_ssw", "59")
    .in("proposta_payload->args->>template_id", [...TEMPLATES_59_PEDIDO_DOCUMENTO])
    .order("created_at", { ascending: false });

  // Karol 2026-09-09 (NF 75249): a query passou a trazer os TRÊS templates de
  // pedido de romaneio, mas os dois sinais seguem SEPARADOS de propósito:
  //   • todos59Total    → só EXTRAVIO_TOTAL_PEDIR_ROMANEIO. Alimenta a
  //     REVIVÊNCIA (3b), cujo comportamento fica IDÊNTICO ao de antes.
  //   • todos59PedidoDoc → os três. Alimenta só a PRESERVAÇÃO do 59 pendente
  //     na whitelist (`ehDaListaNova`), que é o bug do Caso 1.
  // Se alguém colapsar os dois numa variável só, a revivência passa a mexer em
  // 3307 cards abertos e pode disparar e-mail via janela de veto. Ver o
  // docblock de `temPendenciaDocumento59`.
  const todos59PedidoDoc = (todos59Raw ?? []) as Array<
    { id: string; status: string; proposta_payload: Record<string, unknown> | null }
  >;
  const templateDoTodo = (t: { proposta_payload: Record<string, unknown> | null }): string | null => {
    const args = t.proposta_payload?.["args"] as Record<string, unknown> | undefined;
    const tpl = args?.["template_id"];
    return typeof tpl === "string" ? tpl : null;
  };
  const todos59Total = todos59PedidoDoc
    .filter((t) => templateDoTodo(t) === TEMPLATE_INDENIZACAO_TOTAL)
    .map((t) => ({ id: t.id, status: t.status }));
  const ehExtravioTotal = ehExtravioTotalPorTodos59(todos59Total);
  const pendenciaDoc59 = temPendenciaDocumento59(todos59PedidoDoc);

  // 2. Carrega todos pendentes existentes
  const { data: pendentes } = await supabase
    .from("todos")
    .select("id, proposta_payload")
    .eq("card_id", cardId)
    .eq("status", "pendente");

  // Whitelist de propostas que devem permanecer (codigo_ssw, isRelancamento54)
  // 21 (reentrega), 44 (retorno carga), 56 (falta info), 54-relançar
  const idsObsoletos: string[] = [];
  for (const t of (pendentes ?? []) as Array<Record<string, unknown>>) {
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const tArgs = payload?.["args"] as Record<string, unknown> | undefined;
    const meta = payload?.["meta"] as Record<string, unknown> | undefined;
    const cod = tArgs?.["codigo_ssw"] as number | undefined;
    // Caio 2026-06-12 (NF 2043438): `tipo` vem de meta.tipo_acao, MAS geradores
    // diferentes (regras-auto-acao) criam 33-solo/combo SEM meta.tipo_acao.
    // Sem derivar do `tool`, a whitelist não reconhecia o 33-solo do
    // regras-auto-acao → cancelava como obsoleta → operador sem botão p/ oc=33
    // em extravio total. Fallback pelo tool fecha a dessincronia entre geradores.
    const toolDoTodo = payload?.["tool"] as string | undefined;
    const tipo = (meta?.["tipo_acao"] as string | undefined)
      ?? (toolDoTodo === "lancar_oc33_solo_portal" ? "oc33_solo"
        : toolDoTodo === "lancar_combo_33_44" ? "combo_33_44"
        : toolDoTodo === "lancar_combo_44_59" ? "combo_44_59"
        : undefined);

    // Caio 2026-07-13 (separação 54/59): re-aguardar relança a oc-ÂNCORA do card
    // (ocReaguardar = 54 ou 59). Casar pela âncora (não por "54 ou 59" solto): assim,
    // se a âncora trocou 54↔59 fora do fluxo de aprovação, um re-aguardar com codigo_ssw
    // divergente é tratado como OBSOLETO (cancelado) e um novo pro trilho certo é criado.
    // Caso normal (54 em card 54, 59 em card 59) deduplica igual. O trilho 33/combo
    // permanece na whitelist pros DOIS trilhos (59 = foco indenização; 54 = superset).
    const ehRelancarCliente = cod === ocReaguardar && tipo === "relancamento_54";
    const ehIndenizacao33 = cod === 33 && (tipo === "combo_33_44" || tipo === "oc33_solo");
    // Caio 2026-07-13 (Bloco 5): combo 44+59 (extravio parcial → devolver) é ação
    // do trilho TRATATIVA (54). Identificada pelo tipo_acao (codigo_ssw=59 no todo).
    const ehCombo4459 = tipo === "combo_44_59";
    const ehTratativa =
      cod === 21 ||
      cod === 44 ||
      // Caio 2026-06-03 (NF 66193 LARISSA INOVAMED): 55 (autorizar entrega
      // parcial) é resposta legítima a oc=54 — cliente pode autorizar seguir
      // com o parcial após notificação. Antes era cancelada como "obsoleta".
      cod === 55 ||
      cod === 56;
    const ehDaListaNova = trilhoIndenizacao
      // card 59: indenização + re-aguardar; e 55 (seguir parcial) SÓ em extravio
      // PARCIAL — cliente pode autorizar seguir com o parcial mesmo já no trilho
      // de indenização (Duílio 2026-07-29, NF 303061). Antes o 55 era cancelado.
      ? (ehIndenizacao33 || ehRelancarCliente || (ehParcial && cod === 55))
      // card 54/tratativa: menu completo + 59 de indenização SÓ em extravio TOTAL
      // (Larissa 2026-08-05, NF 1102187): mantém o 59+email do override em vez de
      // cancelar como obsoleto. Gate ehExtravioTotal → inerte fora de total.
      // Karol 2026-09-09 (NF 75249): era `ehExtravioTotal` aqui — o 59 de card
      // PARCIAL com pedido de romaneio em aberto era cancelado como obsoleto.
      // `pendenciaDoc59` cobre os três templates de PEDIR_ROMANEIO e é
      // verdadeiro só quando existe 59 pendente/aprovado (ou seja: só preserva
      // o que já está lá, nunca cria nem ressuscita).
      : (ehTratativa || ehRelancarCliente || ehIndenizacao33 || ehCombo4459 ||
        (pendenciaDoc59 && cod === 59 && !ehCombo4459));

    if (ehDaListaNova) {
      if (typeof cod === "number") info.ja_existentes.push(cod);
      if (tipo) info.ja_existentes_tipos.push(tipo);
    } else {
      idsObsoletos.push(t["id"] as string);
    }
  }

  // 3. Cancela obsoletos
  if (idsObsoletos.length > 0) {
    const { error } = await supabase
      .from("todos")
      .update({
        status: "cancelado",
        rejection_reason: "proposta obsoleta após resposta do cliente",
      })
      .in("id", idsObsoletos);
    if (!error) info.cancelados = idsObsoletos.length;
  }

  // 3b. Extravio TOTAL: garante um 59+email de indenização LANÇÁVEL. Se o override
  // já criou e foi cancelado (escalada/menu) e não há nenhum ativo, revive o mais
  // recente (e-mail já resolvido no payload). Gate ehExtravioTotal → inerte fora
  // de total. Idempotente: não faz nada se já houver um 59+email ativo.
  if (ehExtravioTotal) {
    const idReviver = escolher59IndenizacaoParaReviver(todos59Total);
    if (idReviver) {
      const { error: revErr } = await supabase
        .from("todos")
        .update({ status: "pendente", rejection_reason: null })
        .eq("id", idReviver);
      if (!revErr) info.criados.push({ codigo_ssw: 59, todoId: idReviver });
    }
  }

  // 4. Cria os que faltam
  // Caio 2026-06-12 (NF 2043438): NÃO exigir chave_cte aqui. A migração
  // portal-101 (2026-06-09) eliminou chave_cte — o lançamento usa card.ctrc.
  // O guard antigo `!chaveCTe` fazia a função CANCELAR as obsoletas e retornar
  // sem recriar nada (chave_cte é null pra todo card agora) → propostas como
  // oc=33 solo sumiam e nunca voltavam. chave_cte segue indo nos args (null),
  // inofensivo — o executor portal-101 ignora.
  if (!nf) {
    return info;
  }

  type NovaProposta = {
    codigo_ssw: number;
    descricao_todo: string;
    descricao_acao: string;
    tipo_acao?: "relancamento_54" | "combo_33_44" | "oc33_solo" | "combo_44_59";
    tool?: "lancar_ocorrencia" | "lancar_combo_33_44" | "lancar_oc33_solo_portal" | "lancar_combo_44_59";
    // Caio 2026-07-13 (combo 44+59): proposta que leva e-mail editável (template
    // pedindo romaneio). Diferente das operacionais (sem_email): o todo nasce com
    // tinha_intencao_email=true + template_id + destinatário resolvido, pro front
    // abrir o editor de e-mail. Os campos da oc 44 (volumes/motivo/filial) vêm do
    // modal no approve (extras.combo_44).
    comEmail?: { template_id: string };
  };

  // Caio 2026-07-13 (combo 44+59): resolve o e-mail do cliente SÓ quando a proposta
  // combo 44+59 vai existir (extravio parcial no trilho tratativa). Mesma RPC das
  // propostas de extravio (resolver_email_cobranca_cliente / logistico). Se null,
  // o front exige o e-mail no modal (o executor bloqueia a 44 sem destinatário).
  let emailComboDestino: string | null = null;
  if (ehParcial && !trilhoIndenizacao && cnpjPagador) {
    const { data: emailData } = await supabase.rpc("resolver_email_cobranca_cliente", {
      p_documento_cliente: cnpjPagador,
      p_tipo_uso: "logistico",
      p_cnpj_remetente: cnpjRemetenteCru,
    });
    emailComboDestino = typeof emailData === "string" ? emailData : null;
  }

  // Caio 2026-07-13 (separação 54/59): as propostas pós-resposta agora RAMIFICAM
  // pelo trilho da oc-âncora (ver `trilhoIndenizacao`). Definidas como peças nomeadas
  // e montadas por trilho no fim.
  const propReaguardar: NovaProposta = {
    codigo_ssw: ocReaguardar, // 54 ou 59 — relança a oc-âncora do card (identidade)
    descricao_todo: `Re-lançar oc ${ocReaguardar} no SSW — re-aguardar cliente (sem email)`,
    descricao_acao: "Re-aguardar cliente — resposta inconclusiva ou nova solicitação",
    tipo_acao: "relancamento_54",
  };
  // Caio 2026-05-25 (NF 574248): cliente confirmou reentrega — recria o botão 21.
  const propReentrega21: NovaProposta = {
    codigo_ssw: 21,
    descricao_todo: "Lançar oc 21 no SSW — reentrega autorizada pelo cliente",
    descricao_acao: "Reentrega solicitada pelo cliente (resposta à tratativa)",
  };
  const propDevolucao44: NovaProposta = {
    codigo_ssw: 44,
    descricao_todo: "Lançar oc 44 no SSW — retorno de carga (encaminhar p/ Devolução)",
    descricao_acao: "Cliente autorizou devolução — encaminha pro setor de Devolução",
  };
  // Caio 2026-06-03 (NF 66193 LARISSA INOVAMED): cliente autorizou seguir parcial.
  const propSeguir55: NovaProposta = {
    codigo_ssw: 55,
    descricao_todo: "Lançar oc 55 no SSW — autorizar entrega parcial (cliente liberou)",
    descricao_acao: "Cliente autorizou seguir com a entrega parcial dos volumes localizados",
  };
  const propFaltaInfo56: NovaProposta = {
    codigo_ssw: 56,
    descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
    descricao_acao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir",
  };
  // Caio 2026-05-12: combo 33+44 (ressarcimento com devolução) e oc=33 solo.
  const propCombo3344: NovaProposta = {
    codigo_ssw: 33,
    descricao_todo: "Lançar oc 33 + oc 44 (Ressarcimento) — combo sequencial",
    descricao_acao: "Reversão de perdas (33) + Retorno de carga (44). Sinaliza tratativa de indenização pro time de Perdas com romaneio anexo, e em seguida autoriza devolução.",
    tipo_acao: "combo_33_44",
    tool: "lancar_combo_33_44",
  };
  const propSolo33: NovaProposta = {
    codigo_ssw: 33,
    descricao_todo: "Lançar oc 33 no SSW — reversão de perdas (com romaneio, sem 44)",
    descricao_acao: "Reversão de perdas / início indenização. Anexa romaneio + texto. Não encadeia oc=44.",
    tipo_acao: "oc33_solo",
    tool: "lancar_oc33_solo_portal",
  };
  // Caio 2026-07-13 (separação 54/59, Bloco 5): combo 44+59 — SÓ extravio PARCIAL
  // com cliente pedindo DEVOLUÇÃO. Lança oc 44 (devolver os volumes que ficaram
  // conosco) + oc 59 (indenização) com e-mail editável pedindo romaneio dos
  // volumes extraviados. Entra só no menu do trilho tratativa (54) quando ehParcial.
  const propCombo4459: NovaProposta = {
    codigo_ssw: 59,
    descricao_todo: "Devolver (oc 44) + abrir indenização (oc 59) — pedir romaneio por e-mail",
    descricao_acao: "Extravio parcial, cliente autorizou devolução: aguardando romaneio/valor/descrição p/ indenização dos volumes extraviados.",
    tipo_acao: "combo_44_59",
    tool: "lancar_combo_44_59",
    comEmail: { template_id: "EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO" },
  };

  // Ciclo de devolução com CT-e ABERTO neste card? Se sim, as propostas que
  // lançariam 44 sem o documento saem do menu (ver filtrarPropostas44SemCte).
  //
  // FAIL-OPEN de propósito no erro de infra: se a tabela ainda não existe (a
  // mig 373 não foi aplicada) ou a consulta falha, o menu segue como sempre.
  // Fechar aqui por erro de infra tiraria a opção de devolução de TODOS os
  // operadores — blast radius muito maior que o risco que a cerca cobre.
  let cicloCteAberto = false;
  try {
    const { data: ciclos, error: ciclosErr } = await supabase
      .from("devolucoes_cte")
      .select("id")
      .eq("card_id", cardId)
      .is("encerrado_em", null)
      .limit(1);
    if (!ciclosErr && Array.isArray(ciclos) && ciclos.length > 0) cicloCteAberto = true;
  } catch { /* fail-open: ver comentário acima */ }

  const novas: NovaProposta[] = trilhoIndenizacao
    // Card 59 (RETORNO INDENIZAÇÃO): menu focado — indenização + re-aguardar (59).
    // + oc 55 (seguir parcial) SÓ em extravio PARCIAL: o cliente pode autorizar
    // seguir com os volumes localizados mesmo já no trilho de indenização — a
    // opção existia só no menu do 54 e o operador ficava sem como escolher
    // (Duílio 2026-07-29, NF 303061 COMERCIAL BH). Não muda o caminho de
    // ressarcimento (33/44/59), só ADICIONA a escolha.
    ? [propCombo3344, propSolo33, propReaguardar, ...(ehParcial ? [propSeguir55] : [])]
    // Card 54 (RETORNO TRATATIVA): menu completo. Mantém 33/combo (transição segura:
    // cards ainda-54-mas-indenização, resíduo "sem certeza" + janela pré-Fase 5).
    // O combo 44+59 só entra em extravio PARCIAL (cliente pediu devolver).
    : [
      propReentrega21, propDevolucao44, propSeguir55, propFaltaInfo56,
      propReaguardar, propCombo3344, propSolo33,
      ...(ehParcial ? [propCombo4459] : []),
    ];

  // A cerca. Sem ciclo aberto devolve a lista INTACTA — zero efeito nos demais
  // cards e operadores.
  const novasFiltradas = filtrarPropostas44SemCte(novas, cicloCteAberto);

  for (const p of novasFiltradas) {
    // Idempotência: relancamento_54 e combo_33_44 são identificados pelo
    // tipo_acao (não pelo codigo_ssw — pode haver vários todos cod=33 ou 44
    // como ações solo). Outras propostas usam codigo_ssw + tipo_acao indef.
    const jaExisteSimples =
      p.tipo_acao == null && info.ja_existentes.includes(p.codigo_ssw);
    const jaExisteTipado =
      p.tipo_acao != null && info.ja_existentes_tipos.includes(p.tipo_acao);
    if (jaExisteSimples || jaExisteTipado) continue;

    const propostaArgs: Record<string, unknown> = {
      codigo_ssw: p.codigo_ssw,
      nf,
      chave_cte: chaveCTe,
      cnpj_remetente: cnpjRemetente,
      descricao: p.descricao_acao,
    };

    const propostaMeta: Record<string, unknown> = {
      tinha_intencao_email: false,
      modo: "sem_email",
      origem: "vinculador_pos_resposta_cliente",
    };
    if (p.tipo_acao) propostaMeta["tipo_acao"] = p.tipo_acao;

    // Caio 2026-07-13 (combo 44+59): proposta com e-mail editável (pedir romaneio).
    // Semeia template_id + destinatário resolvido + tinha_intencao_email=true pro
    // front abrir o editor. Os campos da oc 44 (volumes/motivo/filial) o front
    // injeta em extras.combo_44 no approve.
    if (p.comEmail) {
      propostaArgs["template_id"] = p.comEmail.template_id;
      propostaArgs["email_destino"] = emailComboDestino;
      propostaMeta["tinha_intencao_email"] = true;
      propostaMeta["modo"] = "completo";
    }

    // Gate da oc 33 (extravio parcial): anota natureza + bloqueio pro front. O
    // executor faz o enforce autoritativo lendo o dossiê vivo na hora de lançar.
    if (ehParcial) {
      const natureza = classificarOc33({ codigo_ssw: p.codigo_ssw, tipo_acao: p.tipo_acao, tool: p.tool }, casoParcial);
      if (natureza) {
        const g = decidirGateOc33(natureza, dossieParcial);
        propostaMeta["gate_oc33"] = { natureza, bloqueada: g.bloqueada, faltando: g.faltando };
        if (g.bloqueada) oc33Bloqueadas.push({ natureza, faltando: g.faltando, tipo_acao: p.tipo_acao });
      }
    }

    const { data: newTodo, error } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: crypto.randomUUID(),
        descricao: p.descricao_todo,
        status: "pendente",
        proposta_payload: {
          tool: p.tool ?? "lancar_ocorrencia",
          args: propostaArgs,
          rationale: "Pós-resposta cliente em card AGUARDANDO_CLIENTE — opção operacional/encaminhamento.",
          texto: null,
          meta: propostaMeta,
        },
      })
      .select("id")
      .single();

    if (!error && newTodo) {
      const entry: { codigo_ssw: number; tipo_acao?: string; todoId: string } = {
        codigo_ssw: p.codigo_ssw,
        todoId: newTodo.id as string,
      };
      if (p.tipo_acao) entry.tipo_acao = p.tipo_acao;
      info.criados.push(entry);
    }
  }

  // Telemetria do gate (baseline p/ decidir ligar o enforce). Só quando há oc 33
  // bloqueada por dossiê incompleto num card de extravio parcial.
  if (oc33Bloqueadas.length > 0) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "Oc33BloqueadaDossieIncompleto",
      actor_type: "agent",
      actor_id: "propostas-pos-resposta-cliente",
      payload: { origem: "propostas_pos_resposta", bloqueadas: oc33Bloqueadas },
    });
  }

  // Etapa 2 da padronização oc 11 (Isadora 07/08): se o interpretador já
  // decidiu 21 no fluxo-endereço, garante o pacote (texto SSW + cancelamento)
  // no todo de 21 recém-criado/mantido — cobre a ordem "decisão antes das
  // propostas". Best-effort e idempotente.
  try {
    await aplicarPacoteOc11PosResposta(supabase, cardId, "propostas-pos-resposta-cliente");
  } catch (e) {
    console.warn(`pacote oc11 pós-resposta falhou (card ${cardId}): ${e instanceof Error ? e.message : e}`);
  }

  // Enxerto da instrução do E-MAIL na proposta 21 (Caio 2026-08-14, NF 674757
  // Würth): cobre a ordem "todos criados DEPOIS da decisão do interpretador" —
  // e o caso `ja_existentes: [21]`, onde o todo 21 pré-existente (ex.: criado
  // pelo robô da intranet com Obs de ciclo anterior) ficava com o texto velho
  // e o quick-approve mandava esse texto pro SSW. Best-effort e idempotente.
  try {
    await aplicarInstrucaoEmailNaProposta21(supabase, cardId, "propostas-pos-resposta-cliente");
  } catch (e) {
    console.warn(`enxerto e-mail→21 falhou (card ${cardId}): ${e instanceof Error ? e.message : e}`);
  }

  // Etapa C do plano de veto (Caio 25/08): decisão 56 já tomada + todo 56
  // recém-criado → enxerta o texto gerado pela IA. Best-effort e idempotente.
  await aplicarTexto56NaProposta(supabase, cardId, "propostas-pos-resposta-cliente");

  // Etapa C (onda 2, 25/08): pré-seleção de anexos da 33 pelos todos recém-criados.
  await aplicarAnexosSugeridos33(supabase, cardId, "propostas-pos-resposta-cliente");

  // Etapa B do plano de veto (Caio 25/08): com os todos recém-criados, resolve
  // e persiste a ação destacada exata — cobre a ordem "decisão do interpretador
  // ANTES das propostas". Best-effort (nunca lança) e idempotente.
  const destaqueVeto = await gravarDestaqueRespostaCliente(
    supabase, cardId, "propostas-pos-resposta-cliente",
  );

  // Etapa D (25/08): mesmo gancho de agendamento do interpretador — cobre a
  // ordem inversa. Agendamento idêntico já existente = no-op (índice único).
  if (destaqueVeto?.acao_key) {
    const { data: cardVeto } = await supabase
      .from("cards").select("cod_ultima_ocorrencia, ia_sugestao_oc_resposta")
      .eq("id", cardId).maybeSingle();
    const iaVeto = (cardVeto?.ia_sugestao_oc_resposta ?? null) as
      | { oc_sugerida?: number; confianca?: number; sugerido_em?: string }
      | null;
    await agendarAcaoAutonomaSeElegivel(supabase, {
      cardId,
      agentName: "interpretador-resposta-cliente",
      acaoKey: destaqueVeto.acao_key,
      ocCard: (cardVeto?.cod_ultima_ocorrencia as number | null) ?? null,
      ocSugerida: iaVeto?.oc_sugerida ?? null,
      confianca: iaVeto?.confianca ?? null,
      // este hook roda também por redes de segurança (cron-ia) sobre decisões
      // ANTIGAS — a idade real da sugestão decide (caso NF 26033)
      sugeridaEm: iaVeto?.sugerido_em ?? null,
    });
  }

  return info;
}

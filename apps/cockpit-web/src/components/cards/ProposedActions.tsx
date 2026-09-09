import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, ChevronRight, Loader2, Mail } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { aprovarEExecutarComFeedback } from "@/lib/aprovarComFeedback";
import { filtrarContatosPorRemetente, remetenteCruDoAgentState } from "@/lib/contatos";

import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useTemplatesEmail } from "@/hooks/useTemplatesEmail";
import type { CardRow, OperadorRow, TodoRow } from "@/lib/types";
import { OCS_AGUARDANDO_CLIENTE } from "@/lib/types";
import { decidirCliqueAprovacao } from "@/lib/decidir-clique-aprovacao";
import {
  anexosSugeridosDoTodo,
  preSelecaoAnexos,
  primeiroAnexoSuportadoSsw,
} from "@/lib/anexos-ssw-elegiveis";
import { anexosCobremRomaneio, romaneioExigidoDoCard } from "@/lib/romaneio-cobertura";
import { faltandoParaOc33, textoFaltandoOc33 } from "@/lib/dossie33Faltando";
import { extrasSemEmailDeliberado } from "@/lib/extras-sem-email";
import { relativeTime } from "@/lib/format";
import {
  avaliarPaginaConvertida,
  mensagemConversaoQuebrada,
  mensagemPaginaSuspeita,
  politicaDaPagina,
  RE_WARNING_PDFJS_IMG,
} from "@/lib/pdfConversaoGuard";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EditarEmailModal } from "./EditarEmailModal";
import { ModalEvidenciaIntranetWurth } from "./ModalEvidenciaIntranetWurth";
import { AnexosUploader, type AnexoUploaded } from "./AnexosUploader";
import { ResponderThreadClienteBlock, ocAceitaRespostaThread } from "./ResponderThreadClienteBlock";
import { ModalLancarEmergencial } from "./ModalLancarEmergencial";
import { AlertTriangle } from "lucide-react";
import { useCtrcOverrideStore } from "@/stores/useCtrcOverrideStore";
import { useAuth } from "@/contexts/AuthContext";
import { detectarDivergencia, type Divergencia } from "@/lib/divergencia";
import { DivergenciaMotivoDialog } from "./DivergenciaMotivoDialog";

// Trava modo visualização (mig 324): João/Isadora veem, não executam. Hook
// usado por todos os subcomponentes com botões de ação deste arquivo.
function useModoVisualizacao(): boolean {
  const { operador } = useAuth();
  return operador?.pode_executar === false;
}
import {
  useTratativasEmail,
  getResponderParaEscolhido,
} from "@/hooks/useTratativasEmail";

export function ProposedActions({ card }: { card: CardRow }) {
  const qc = useQueryClient();
  const forcarCtrcBaixado = useCtrcOverrideStore((s) => !!s.byCard[card.id]);

  // ===== Popup de divergência (F4) — piloto por operador, default OFF =====
  const { user } = useAuth();
  const modoVisualizacao = useModoVisualizacao();
  const { data: popupCfgAtivo } = useQuery({
    queryKey: ["popup-divergencia-cfg", user?.email],
    enabled: !!supabase && !!user?.email,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase!
        .from("popup_divergencia_config")
        .select("ativo")
        .eq("operador_email", (user!.email ?? "").toLowerCase())
        .maybeSingle();
      return data?.ativo === true;
    },
  });
  const popupDivergenciaAtivo = popupCfgAtivo === true;
  const divergResolver = useRef<
    ((r: "cancelado" | { reasonCode: string; texto: string }) => void) | null
  >(null);
  // P2.5 (Caio 31/08): card 49-custo-extra + operador escolhe a 55 → motivo
  // OBRIGATÓRIO ("não procede cobrança...") que vai pro SSW via texto_complementar.
  const [custoMotivoAberto, setCustoMotivoAberto] = useState(false);
  const [custoMotivoTexto, setCustoMotivoTexto] = useState("Não procede cobrança de custo extra — ");
  const custoResolver = useRef<((r: string | null) => void) | null>(null);
  const [divergInfo, setDivergInfo] = useState<{ todoId: string; d: Divergencia } | null>(
    null,
  );
  const MSG_APROVACAO_CANCELADA = "aprovacao_cancelada_pelo_operador";
  const { data: tratativasData } = useTratativasEmail(card.id);
  const travadoPorTratativa =
    !!tratativasData?.multiplas_tratativas && !tratativasData?.tratativa_escolhida;
  const responderParaEscolhido = getResponderParaEscolhido(tratativasData ?? null);

  const { data: pendentes, isLoading } = useQuery({
    queryKey: ["todos-pendentes", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("todos")
        .select("*")
        .eq("card_id", card.id)
        .eq("status", "pendente")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TodoRow[];
    },
  });

  // Eventos AcaoPropostaPeloAgente — pra resolver "proposto por agente X há Y"
  const { data: proposalEvents } = useQuery({
    queryKey: ["proposal-events", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("card_events")
        .select("actor_id,payload,created_at")
        .eq("card_id", card.id)
        .eq("event_type", "AcaoPropostaPeloAgente");
      if (error) throw error;
      return (data ?? []) as { actor_id: string | null; payload: any; created_at: string }[];
    },
  });

  useRealtimeInvalidate("todos", ["todos-pendentes", card.id], `card_id=eq.${card.id}`);
  useRealtimeInvalidate("todos", ["todos-historico", card.id], `card_id=eq.${card.id}`);
  useRealtimeInvalidate("card_events", ["proposal-events", card.id], `card_id=eq.${card.id}`);

  const proposalByTodo = new Map<string, { agent: string; at: string }>();
  (proposalEvents ?? []).forEach((e) => {
    const todoId = e.payload?.todo_id;
    if (todoId && !proposalByTodo.has(todoId)) {
      proposalByTodo.set(todoId, { agent: e.actor_id ?? "agente", at: e.created_at });
    }
  });

  const [modal44TodoId, setModal44TodoId] = useState<string | null>(null);
  const [expandidoId, setExpandidoId] = useState<string | null>(null);
  const [highlightedTodoId, setHighlightedTodoId] = useState<string | null>(null);
  const [comboModalTodo, setComboModalTodo] = useState<TodoRow | null>(null);
  // Combo 44+59 (separação 54/59, Caio 2026-07-15): devolve o que ficou conosco
  // (44) + abre indenização (59) com e-mail pedindo romaneio. Modal coleta os
  // campos obrigatórios da oc 44 — sem eles o executor rejeita o lançamento.
  const [combo4459ModalTodo, setCombo4459ModalTodo] = useState<TodoRow | null>(null);
  const [oc33SoloModalTodo, setOc33SoloModalTodo] = useState<TodoRow | null>(null);
  const [emailOc33ModalTodo, setEmailOc33ModalTodo] = useState<TodoRow | null>(null);

  function scrollAndHighlight(todoId: string) {
    setExpandidoId(todoId);
    setHighlightedTodoId(todoId);
    setTimeout(() => {
      const el = document.querySelector(`[data-todo-id="${todoId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    setTimeout(() => setHighlightedTodoId((cur) => (cur === todoId ? null : cur)), 2200);
  }

  // Pedido vindo de ConversationTabs (botão EXECUTAR SUGESTÃO IA): destacar o todo IA
  const pendingHighlightRef = useRef(false);
  useEffect(() => {
    function onReq(e: Event) {
      const detail = (e as CustomEvent).detail as { cardId?: string } | undefined;
      if (detail?.cardId && detail.cardId !== card.id) return;
      pendingHighlightRef.current = true;
      tryHighlightIa();
    }
    window.addEventListener("highlight-ia-evidencia-todo", onReq);
    return () => window.removeEventListener("highlight-ia-evidencia-todo", onReq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  // Pedido vindo do BannerSugestaoIA (botão "Aprovar oc=X"): localiza todo
  // PRIMEIRO por acao_key (string exata) e só então cai pra codigo_ssw.
  // Nunca casa por número quando o banner passa acao_key — "54 + e-mail" e
  // "54 SEM e-mail" são ações OPOSTAS.
  useEffect(() => {
    function onAprovar(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { codigoSsw?: number; acaoKey?: string; template?: string | null; motivo?: string | null }
        | undefined;
      if (!detail) return;
      const list = pendentes ?? [];
      let match: TodoRow | undefined;
      if (detail.acaoKey) {
        match = list.find((t) => {
          const pl = (t.proposta_payload ?? {}) as any;
          return pl?.acao_key === detail.acaoKey;
        });
      }
      if (!match && detail.codigoSsw) {
        match = list.find((t) => {
          const pl = (t.proposta_payload ?? {}) as any;
          return Number(pl?.args?.codigo_ssw) === detail.codigoSsw;
        });
      }
      if (!match) {
        toast.warning(
          detail.acaoKey
            ? `Ação "${detail.acaoKey}" não está nas opções pendentes`
            : `Proposta oc=${detail.codigoSsw} não está nas opções pendentes`,
        );
        scrollToList();
        return;
      }
      scrollAndHighlight(match.id);
    }
    window.addEventListener("aprovar-sugestao-ia", onAprovar);
    return () => window.removeEventListener("aprovar-sugestao-ia", onAprovar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendentes]);


  function tryHighlightIa() {
    const list = pendentes ?? [];
    const iaTodo = list.find((t) => {
      const pl = (t.proposta_payload ?? {}) as any;
      return pl?.meta?.origem === "executar_sugestao_evidencia";
    });
    if (iaTodo) {
      pendingHighlightRef.current = false;
      scrollAndHighlight(iaTodo.id);
    }
  }

  // Tenta destacar quando a lista de pendentes muda (após invalidate do botão IA)
  useEffect(() => {
    if (pendingHighlightRef.current) tryHighlightIa();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendentes]);

  function scrollToList() {
    const el = document.querySelector("[data-acoes-sugeridas]");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const approve = useMutation({
    mutationFn: async (vars: { todo: TodoRow; extras?: Record<string, unknown> }) => {
      if (!supabase) throw new Error("Sem conexão");
      if (travadoPorTratativa) {
        throw new Error("Escolha qual tratativa responder primeiro");
      }
      // Guard combo 44+59: a oc 44 exige volumes/motivo (o executor rejeita sem
      // eles). Qualquer caminho de aprovação que não passe pelo modal cai aqui.
      {
        const plGuard = (vars.todo.proposta_payload ?? {}) as any;
        const ehCombo4459Guard =
          plGuard?.tool === "lancar_combo_44_59" ||
          plGuard?.meta?.tipo_acao === "combo_44_59";
        if (ehCombo4459Guard && !(vars.extras as any)?.combo_44) {
          throw new Error(
            "Combo 44+59 precisa dos dados da devolução (volumes/motivo/filial) — use o botão da proposta pra abrir o formulário.",
          );
        }
      }
      // Popup de divergência (F4): aprovou diferente da destacada → pede o
      // motivo ANTES de seguir. Registro é best-effort; cancelar aborta.
      let motivoDivergencia: { reasonCode: string; texto: string; d: Divergencia } | null = null;
      if (popupDivergenciaAtivo) {
        const d = detectarDivergencia(card, vars.todo.proposta_payload);
        // Auditoria 25/07 (NF 1122403): sugestão DEFASADA — a acao_key
        // sugerida nem existe mais no cardápio de todos pendentes (nenhuma ⭐
        // visível) → não é divergência do operador, é lixo de camada antiga.
        const sugeridaNoCardapio =
          !d.acaoKeySugerida ||
          (pendentes ?? []).some(
            (t) => ((t.proposta_payload ?? {}) as any)?.acao_key === d.acaoKeySugerida,
          );
        if (d.divergente && sugeridaNoCardapio) {
          const r = await new Promise<"cancelado" | { reasonCode: string; texto: string }>(
            (resolve) => {
              divergResolver.current = resolve;
              setDivergInfo({ todoId: vars.todo.id, d });
            },
          );
          setDivergInfo(null);
          divergResolver.current = null;
          if (r === "cancelado") throw new Error(MSG_APROVACAO_CANCELADA);
          motivoDivergencia = { ...r, d };
        }
      }
      const params: Record<string, unknown> = { p_todo_id: vars.todo.id };
      const extras: Record<string, unknown> = { ...(vars.extras ?? {}) };
      // P2.5 (Caio 31/08): 49 de custo extra + 55 escolhida = "não procede
      // cobrança" — motivo obrigatório, vai pro SSW (texto_complementar).
      const casoOc49 = (card as unknown as { analise_padrao_resultado?: { caso_oc49?: string } | null })
        ?.analise_padrao_resultado?.caso_oc49;
      const codigoTodo55 = Number(((vars.todo.proposta_payload ?? {}) as { args?: { codigo_ssw?: number } })?.args?.codigo_ssw);
      if (casoOc49 === "custo_dedicado" && codigoTodo55 === 55) {
        const motivo = await new Promise<string | null>((resolve) => {
          custoResolver.current = resolve;
          setCustoMotivoAberto(true);
        });
        setCustoMotivoAberto(false);
        custoResolver.current = null;
        if (!motivo) throw new Error(MSG_APROVACAO_CANCELADA);
        extras.texto_complementar = motivo.slice(0, 400);
      }
      if (forcarCtrcBaixado) extras.forcar_lancamento_ctrc_baixado = true;
      // Roteia a resposta pra tratativa escolhida (quando houver), garantindo que
      // o backend envie o e-mail pro contato certo da thread selecionada.
      if (responderParaEscolhido) {
        const atuais = (extras.email_destinatarios as string[] | undefined) ?? [];
        if (!atuais.length) {
          extras.email_destinatarios = [responderParaEscolhido];
        } else if (atuais[0] !== responderParaEscolhido) {
          extras.email_destinatarios = [
            responderParaEscolhido,
            ...atuais.filter((e) => e !== responderParaEscolhido),
          ];
        }
      }
      if (Object.keys(extras).length > 0) params.p_extras = extras;
      const { data, error } = await aprovarEExecutarComFeedback(params as any);
      if (error) throw error;
      // Auditoria 25/07 (NF 1094098: 4 motivos pra 1 aprovação): o motivo é
      // registrado DEPOIS da aprovação confirmar — falha pós-popup não deixa
      // registro órfão nem acumula lixo a cada retry. Best-effort: falha do
      // registro NUNCA desfaz a aprovação.
      if (motivoDivergencia) {
        try {
          await supabase.rpc("registrar_motivo_divergencia", {
            p_card_id: card.id,
            p_todo_id: vars.todo.id,
            p_acao_key_sugerida:
              motivoDivergencia.d.acaoKeySugerida ??
              (motivoDivergencia.d.ocSugerida != null
                ? `oc:${motivoDivergencia.d.ocSugerida}`
                : null),
            p_acao_key_aprovada: motivoDivergencia.d.acaoKeyAprovada ?? null,
            p_reason_code: motivoDivergencia.reasonCode,
            p_reason_text: motivoDivergencia.texto || null,
          });
        } catch (e) {
          console.warn("[divergencia] registro falhou (aprovação já OK):", e);
        }
      }
      return data as { ok: boolean; todo_id: string; card_id: string; pgmq_msg_id?: number };
    },
    onSuccess: (_data, vars) => {
      const pl = (vars.todo.proposta_payload ?? {}) as any;
      const isCombo =
        pl?.tool === "lancar_combo_33_44" || pl?.meta?.tipo_acao === "combo_33_44";
      const isCombo4459 =
        pl?.tool === "lancar_combo_44_59" || pl?.meta?.tipo_acao === "combo_44_59";
      const isOc33Solo =
        pl?.tool === "lancar_oc33_solo_portal" || pl?.meta?.tipo_acao === "oc33_solo";
      const isEmailOc33 =
        pl?.tool === "enviar_email_livre_e_lancar_oc33_portal";
      if (isCombo4459) {
        toast.success(
          "✓ Combo 44+59 iniciado: oc=44 (devolução) lançada; oc=59 + e-mail pedindo romaneio em seguida",
        );
      } else if (isCombo) {
        toast.success("✓ Combo iniciado: oc=33 lançada, aguarde oc=44 (~30s)");
      } else if (isEmailOc33) {
        toast.success('✓ Email enviado e oc=33 lançada no SSW. Card foi pra "AÇÃO EXECUTADA".');
      } else if (isOc33Solo) {
        toast.success('✓ oc=33 lançada no SSW (portal). Card foi pra "AÇÃO EXECUTADA".');
      } else {
        toast.success("Ação aprovada — em execução");
      }
      qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
      qc.invalidateQueries({ queryKey: ["todos-historico", card.id] });
      qc.invalidateQueries({ queryKey: ["card-events", card.id] });
      qc.invalidateQueries({ queryKey: ["cards"] });
    },
    onError: (err: any) => {
      if (err?.message === MSG_APROVACAO_CANCELADA) {
        toast.info("Aprovação cancelada — nada foi lançado.");
        return;
      }
      toast.error("Erro ao aprovar", { description: err?.message ?? "Tente novamente" });
    },
  });

  // Dedup defensivo: no máximo 1 todo POR acao_key (NUNCA por codigo_ssw).
  // "lancar_oc_e_enviar_email:54" e "lancar_ocorrencia:54" são acao_keys
  // DIFERENTES e SEMPRE coexistem na lista — uma notifica o cliente, a outra
  // não. NÃO removemos a ação destacada/recomendada daqui: ela aparece em
  // destaque E na lista (a recomendação não pode "sumir" do painel).
  // Empate por acao_key: preferir aprovado; depois mais recente;
  // como tiebreaker final, preferir a versão que NOTIFICA o cliente
  // (meta.modo === 'completo') — nunca preferir a sem_email_explicito.
  const destaqueAcaoKey: string | null =
    ((card as any).aviso_alteracao_oc?.tipo === "ia_sugestao_ocs_padrao"
      ? ((card as any).aviso_alteracao_oc?.proposta_destacada_acao as string | undefined)
      : undefined) ??
    ((card as any).analise_padrao_resultado?.proposta_destacada_acao as string | undefined) ??
    null;

  const pendentesDedup = useMemo(() => {
    const list = pendentes ?? [];
    const byKey = new Map<string, TodoRow>();
    const semKey: TodoRow[] = [];
    for (const t of list) {
      const pl = (t.proposta_payload ?? {}) as any;
      const key: string | undefined = pl?.acao_key;
      if (!key) {
        semKey.push(t);
        continue;
      }
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, t);
        continue;
      }
      const plExisting = (existing.proposta_payload ?? {}) as any;
      const tEhCompleto = pl?.meta?.modo === "completo";
      const existingEhCompleto = plExisting?.meta?.modo === "completo";
      const pickNew =
        (t.status === "aprovado" && existing.status !== "aprovado") ||
        (t.status === existing.status &&
          new Date(t.created_at ?? 0).getTime() > new Date(existing.created_at ?? 0).getTime()) ||
        (tEhCompleto && !existingEhCompleto);
      if (pickNew) byKey.set(key, t);
    }
    return [...byKey.values(), ...semKey];
  }, [pendentes, destaqueAcaoKey]);

  const count = pendentesDedup.length;
  const isAguardandoCliente = card.state === "AGUARDANDO_CLIENTE";
  const isValidacaoHumana = card.state === "AGUARDANDO_VALIDACAO_HUMANA";

  const avisoRaw = isValidacaoHumana ? card.aviso_alteracao_oc : null;
  const aviso = avisoRaw?.tipo === "alteracao_oc_durante_lock" ? avisoRaw : null;

  return (
    <div className="flex flex-col gap-3 p-5">
      {aviso && (
        <div className="border border-warn bg-warn/15 px-3 py-2 text-ink">
          <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest">
            ⚠️ Atenção: ocorrência foi alterada
          </div>
          <div className="font-display text-[12px] leading-snug">
            A última ocorrência mudou de{" "}
            <strong>oc {aviso.oc_anterior ?? "—"}</strong> para{" "}
            <strong>oc {aviso.oc_atual ?? "—"}</strong> em{" "}
            {new Date(aviso.alterada_em).toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
            . As propostas abaixo podem estar desatualizadas — revise antes de aprovar.
          </div>
        </div>
      )}

      {isValidacaoHumana && (card.ia_sugestao_oc_resposta?.pendencias_resposta_cliente?.length ?? 0) > 0 && (
        <BannerPendenciasIa card={card} />
      )}

      {/* BannerSugestaoIa moved to top of card (SugestaoIATopBox).
          Keep BannerPendenciasIa above; the purple "Sugestão da IA" box is
          rendered full-width at the top of CardDetail. */}


      {travadoPorTratativa && (
        <div
          className="flex items-start gap-2 border-2 border-yellow-500 bg-yellow-100 px-3 py-2 text-yellow-900"
          title="Escolha qual tratativa responder primeiro"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-widest">
              Aprovação travada — escolha uma tratativa
            </div>
            <div className="mt-0.5 font-display text-[12px] leading-snug">
              Essa NF tem mais de uma tratativa por e-mail. Vá na aba <strong>Mensagens</strong>{" "}
              e selecione qual você vai responder.
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-b-2 border-ink pb-2">
        <h3 className="font-display text-[16px] font-semibold text-ink">Ações propostas</h3>
        <span
          className={cn(
            "tabular border-2 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest",
            count > 0
              ? "border-sal bg-sal text-paper"
              : "border-rule-strong bg-paper text-ink-soft",
          )}
        >
          {count.toString().padStart(2, "0")} pendente{count === 1 ? "" : "s"}
        </span>
      </div>

      {isAguardandoCliente && <CobrancaAgendadaInfo cardId={card.id} />}

      {card.state === "EXTRAVIO_MONITORADO" && <AvisoEmailExtravioEnviado cardId={card.id} />}

      {isLoading ? (
        <div className="font-display text-[12px] italic text-ink-soft">Carregando…</div>
      ) : count === 0 ? (
        <>
          <div className="border-2 border-dashed border-rule-strong p-6 text-center">
            <span className="font-display text-[24px] text-ink-soft">○</span>
            <p className="mt-1 font-display text-[12px] italic text-ink-soft">
              Nenhuma ação aguardando validação.
            </p>
          </div>
          {card.state === "AGUARDANDO_AGENTE" && (
            <BotaoEmergencialSemPropostas card={card} />
          )}
        </>
      ) : isValidacaoHumana ? (
        <>
          <ValidacaoHumanaList
            card={card}
            todos={pendentesDedup}
            onApprove={(todo, extras) => approve.mutate({ todo, extras })}
            approving={approve.isPending || travadoPorTratativa}
            approvingTodoId={approve.isPending ? (approve.variables as any)?.todo?.id ?? null : null}
            expandidoId={expandidoId}
            setExpandidoId={setExpandidoId}
            highlightedTodoId={highlightedTodoId}
            comboModalTodo={comboModalTodo}
            setComboModalTodo={setComboModalTodo}
            combo4459ModalTodo={combo4459ModalTodo}
            setCombo4459ModalTodo={setCombo4459ModalTodo}
            oc33SoloModalTodo={oc33SoloModalTodo}
            setOc33SoloModalTodo={setOc33SoloModalTodo}
            emailOc33ModalTodo={emailOc33ModalTodo}
            setEmailOc33ModalTodo={setEmailOc33ModalTodo}
          />
          {card.cod_ultima_ocorrencia === 20 && (
            <BotaoRecusarFlowSugerido card={card} />
          )}
        </>
      ) : (
        <ul className="space-y-3">
          {pendentesDedup.map((t) => (
            <ProposalCard
              key={t.id}
              todo={t}
              card={card}
              proposal={proposalByTodo.get(t.id)}
              onApprove={(extras) => approve.mutate({ todo: t, extras })}
              approving={approve.isPending || travadoPorTratativa}
              hideUniversalActions={isAguardandoCliente}
            />
          ))}
        </ul>
      )}

      <HistorySection card={card} />

      {/* F4 loop-aprendizado: este dialog PRECISA morar aqui — divergInfo/
          divergResolver vivem no ProposedActions (mutation de aprovação).
          Renderizá-lo num componente filho referencia variável de outro escopo
          e derruba o app inteiro (ReferenceError, incidente 24/07). */}
      <DivergenciaMotivoDialog
        aberta={!!divergInfo}
        div={divergInfo?.d ?? null}
        onConfirmar={(reasonCode, texto) => {
          // Registro acontece na mutation, DEPOIS do aprovar_e_executar OK
          // (auditoria 25/07, NF 1094098 — motivo órfão a cada retry).
          divergResolver.current?.({ reasonCode, texto });
        }}
        onCancelar={() => divergResolver.current?.("cancelado")}
      />
      {custoMotivoAberto && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-rule bg-paper p-5 shadow-xl">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-sal">Custo extra · decisão de não cobrar</p>
            <h3 className="mt-1 text-[14px] font-semibold text-ink">Você escolheu a 55 num caso de custo extra</h3>
            <p className="mt-0.5 text-[11.5px] text-ink-soft">Explique por que a cobrança não procede — o motivo vai no texto da 55 pro SSW (obrigatório).</p>
            <textarea value={custoMotivoTexto} onChange={(e) => setCustoMotivoTexto(e.target.value)} rows={3}
              className="mt-3 w-full rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px] text-ink" />
            <div className="mt-4 flex justify-between">
              <button type="button" className="px-3 py-1.5 text-[12px] text-ink-mute hover:text-ink"
                onClick={() => custoResolver.current?.(null)}>Cancelar</button>
              <button type="button" disabled={custoMotivoTexto.trim().length < 15}
                className="rounded-md bg-ink px-4 py-1.5 text-[12.5px] font-semibold text-paper disabled:opacity-40"
                onClick={() => custoResolver.current?.(custoMotivoTexto.trim())}>Confirmar e lançar 55</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------- Aviso: cliente já notificado por e-mail (extravio, sem oc) -------- */
// Caio 2026-07-20 (mig 299): quando o operador escolhe "notificar cliente por
// e-mail sem lançar ocorrência" (email_sem_oc / skip_oc), as opções de lançar
// (49/54/55) SEGUEM disponíveis — o RPC não cancela mais as irmãs. Aqui só
// mostramos QUANDO o e-mail foi enviado, pra dar contexto (sem botão).
function AvisoEmailExtravioEnviado({ cardId }: { cardId: string }) {
  const { data: enviadoEm } = useQuery({
    queryKey: ["extravio-email-enviado", cardId],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("card_events")
        .select("created_at")
        .eq("card_id", cardId)
        .eq("event_type", "ExtravioClienteNotificadoSemOc")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as { created_at?: string } | null)?.created_at ?? null;
    },
  });
  if (!enviadoEm) return null;
  return (
    <div className="flex items-start gap-2 border border-sky-300 bg-sky-50 px-3 py-2 text-sky-900">
      <Mail className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="font-display text-[12px] leading-snug">
        Cliente já notificado por e-mail em{" "}
        <strong>{format(new Date(enviadoEm), "dd/MM 'às' HH:mm", { locale: ptBR })}</strong>{" "}
        (sem lançar ocorrência). As opções de lançamento seguem disponíveis abaixo.
      </div>
    </div>
  );
}

/* ---------------- Botão emergencial (sem propostas) ---------------- */

function BotaoEmergencialSemPropostas({ card }: { card: CardRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-2 border-yellow-500 bg-yellow-50 px-3 py-3">
      <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-yellow-900">
        ⚠ Sem propostas configuradas
      </div>
      <p className="mb-2 font-display text-[12px] leading-snug text-ink">
        Esta ocorrência (oc {card.cod_ultima_ocorrencia ?? "?"}) ainda não tem propostas
        configuradas no sistema. Lance manualmente enquanto a regra é cadastrada.
      </p>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-yellow-800 underline-offset-2 hover:underline"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        + Lançar oc manualmente
      </button>
      <ModalLancarEmergencial
        cardId={card.id}
        nf={card.nf}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

/* ---------------- Botão recusar flow sugerido (oc=20) ---------------- */

function BotaoRecusarFlowSugerido({ card }: { card: CardRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-2 border-yellow-500 bg-yellow-50 px-3 py-3">
      <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-yellow-900">
        🛠 Recusar flow sugerido
      </div>
      <p className="mb-2 font-display text-[12px] leading-snug text-ink">
        Operação lançou oc=20 indevidamente? Use pra reverter — lança qualquer
        oc do catálogo (texto + anexo opcionais).
      </p>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-yellow-800 underline-offset-2 hover:underline"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        🛠 RECUSAR FLOW SUGERIDO
      </button>
      <ModalLancarEmergencial
        cardId={card.id}
        nf={card.nf}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

/* ---------------- Banner sugestão da IA ---------------- */

// Separação 54/59: gates de e-mail/composer valem pros DOIS trilhos de "aguardando
// cliente" (54 tratativa, 59 indenização). Nunca voltar a hardcodar === 54 aqui.
const ehOcCliente = (codigo: number): boolean => OCS_AGUARDANDO_CLIENTE.includes(codigo);

const OC_LABELS_BANNER: Record<number, string> = {
  21: "Reentrega solicitada",
  44: "Devolução / retorno de carga",
  54: "Re-lançar 54 (cliente respondeu inconclusivo)",
  59: "Re-lançar 59 (indenização — cliente respondeu inconclusivo)",
  55: "Autorizar entrega parcial",
  56: "Falta info operacional",
};

function BannerSugestaoIa({
  card,
  todos,
  onAprovarSugestao,
  onAprovarCombo,
  onAprovarOc33Solo,
  onVerOutras,
}: {
  card: CardRow;
  todos: TodoRow[];
  onAprovarSugestao: (todoId: string) => void;
  onAprovarCombo: (todo: TodoRow) => void;
  onAprovarOc33Solo: (todo: TodoRow) => void;
  onVerOutras: () => void;
}) {
  const modoVisualizacao = useModoVisualizacao();
  const sug = card.ia_sugestao_oc_resposta;
  if (!sug) return null;

  const ehComboSugerido = sug.sugere_combo_33_44 === true;
  const ehOc33SoloSugerido = !ehComboSugerido && sug.sugere_oc33_solo === true;

  const conf = Number(sug.confianca ?? 0);
  const pct = Math.round(conf * 100);
  const badge =
    conf >= 0.8
      ? { label: `alta (${pct}%) ✓`, cls: "border-good/40 bg-good/15 text-good" }
      : conf >= 0.5
        ? { label: `média (${pct}%)`, cls: "border-warn/50 bg-warn/15 text-ink" }
        : {
            label: `⚠️ baixa (${pct}%) — confirme leitura do email`,
            cls: "border-orange-400 bg-orange-100 text-orange-900",
          };

  // Combo sugerido: encontra o todo do combo
  const comboTodo = todos.find((t) => {
    const pl = (t.proposta_payload ?? {}) as any;
    return pl?.tool === "lancar_combo_33_44" || pl?.meta?.tipo_acao === "combo_33_44";
  });

  // Oc33 solo: encontra o todo do oc33 solo
  const oc33SoloTodo = todos.find((t) => {
    const pl = (t.proposta_payload ?? {}) as any;
    return pl?.tool === "lancar_oc33_solo_portal" || pl?.meta?.tipo_acao === "oc33_solo";
  });

  // OC simples: encontra o todo da oc sugerida
  const ocLabel = OC_LABELS_BANNER[sug.oc_sugerida] ?? `oc ${sug.oc_sugerida}`;
  const todoMatch = todos.find((t) => {
    const pl = (t.proposta_payload ?? {}) as any;
    return Number(pl?.args?.codigo_ssw) === sug.oc_sugerida;
  });

  const titulo = ehComboSugerido
    ? "Lançar 33 + Lançar 44 — Ressarcimento"
    : ehOc33SoloSugerido
      ? "Lançar oc 33 — Reversão de Perdas (extravio total)"
      : `Lançar oc ${sug.oc_sugerida} — ${ocLabel}`;
  const motivoTexto = ehComboSugerido
    ? sug.motivo_combo
    : ehOc33SoloSugerido
      ? (sug.motivo_combo ?? sug.motivo)
      : sug.motivo;
  const botaoLabel = ehComboSugerido
    ? "aprovar combo 33+44"
    : ehOc33SoloSugerido
      ? "aprovar oc 33 (sem 44)"
      : `aprovar oc ${sug.oc_sugerida}`;
  const botaoDisabled = ehComboSugerido
    ? !comboTodo
    : ehOc33SoloSugerido
      ? !oc33SoloTodo
      : !todoMatch;
  const botaoOnClick = () => {
    if (ehComboSugerido) {
      if (comboTodo) onAprovarCombo(comboTodo);
    } else if (ehOc33SoloSugerido) {
      if (oc33SoloTodo) onAprovarOc33Solo(oc33SoloTodo);
    } else {
      if (todoMatch) onAprovarSugestao(todoMatch.id);
    }
  };
  const tooltipIndisponivel = ehComboSugerido
    ? "combo 33+44 não disponível nas propostas atuais"
    : ehOc33SoloSugerido
      ? "oc 33 solo não disponível nas propostas atuais"
      : "oc não disponível nas propostas atuais";

  const ehCobrouAntes = (sug as any)?.contexto === "cobrou_antes_notificacao";

  return (
    <div className="border-2 border-indigo-400 bg-indigo-50 px-4 py-3 text-indigo-950">
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-700">
        <span>{ehCobrouAntes ? "📨" : "🤖"}</span>
        {ehCobrouAntes
          ? "Cliente cobrou antes da notificação — sugiro notificar"
          : "sugestão da IA"}
      </div>
      <div className="font-display text-[15px] font-semibold leading-tight text-ink">
        {(ehComboSugerido || ehOc33SoloSugerido) && <span className="mr-1">⭐</span>}
        {titulo}
      </div>
      <div className="mt-1.5">
        <span
          className={cn(
            "inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            badge.cls,
          )}
        >
          confiança: {badge.label}
        </span>
      </div>
      {motivoTexto && (
        <blockquote className="mt-2 border-l-2 border-indigo-400/60 pl-2 font-display text-[12px] italic leading-snug text-ink/80">
          "{motivoTexto}"
        </blockquote>
      )}
      {conf < 0.5 && (
        <div className="mt-2 border border-orange-400 bg-orange-50 px-2 py-1.5 font-mono text-[10px] leading-snug text-orange-900">
          ⚠️ Baixa confiança — a resposta do cliente pode ser ambígua. Confirme
          lendo o texto original na timeline antes de aprovar.
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <button
                  onClick={botaoOnClick}
                  disabled={botaoDisabled || modoVisualizacao}
                  className="bg-indigo-600 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {botaoLabel}
                </button>
              </span>
            </TooltipTrigger>
            {botaoDisabled && (
              <TooltipContent>{tooltipIndisponivel}</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        <button
          onClick={onVerOutras}
          className="font-mono text-[10px] uppercase tracking-wider text-indigo-700 transition-colors hover:text-indigo-900"
        >
          ver outras opções →
        </button>
      </div>
    </div>
  );
}

/* ---------------- Banner pendências da resposta cliente ---------------- */

function BannerPendenciasIa({ card }: { card: CardRow }) {
  const modoVisualizacao = useModoVisualizacao();
  const qc = useQueryClient();
  const [ignorando, setIgnorando] = useState(false);
  const pendencias = card.ia_sugestao_oc_resposta?.pendencias_resposta_cliente ?? [];
  if (!pendencias.length) return null;

  function handleResponder() {
    document
      .querySelectorAll('[role="tab"]')
      .forEach((b) => {
        if (b.textContent?.toLowerCase().includes("resposta")) (b as HTMLButtonElement).click();
      });
  }

  async function handleIgnorar() {
    if (!supabase) return;
    const ok = window.confirm(
      "Ignorar as pendências dessa resposta? Se a última ocorrência for 54, o card volta pra AGUARDANDO CLIENTE. Caso contrário (oc de relacionamento ≠54), o card continua em AGUARDANDO VOCÊ até você lançar a ocorrência.",
    );

    if (!ok) return;
    setIgnorando(true);
    const { data, error } = await supabase.rpc("ignorar_pendencias_resposta_cliente", {
      p_card_id: card.id,
      p_motivo: null,
    } as any);
    setIgnorando(false);
    if (error) {
      toast.error("Falha ao ignorar pendências: " + error.message);
      return;
    }
    const r = (data ?? {}) as { permaneceu_em_aguardando_voce?: boolean; cod_ultima_ocorrencia?: number };
    if (r.permaneceu_em_aguardando_voce) {
      toast.warning(
        `Pendências ignoradas. O card continua em AGUARDANDO VOCÊ porque a ocorrência ${r.cod_ultima_ocorrencia ?? "?"} ainda precisa ser lançada no SSW. Ignorar a resposta do cliente não trata a ocorrência — escolha uma das propostas do card para lançá-la.`,
        { duration: 12000 },
      );
    } else {
      toast.success("Card voltou pra AGUARDANDO_CLIENTE. Próxima resposta re-aciona.");
    }
    qc.invalidateQueries({ queryKey: ["card", card.id] });
    qc.invalidateQueries({ queryKey: ["cards"] });

  }

  return (
    <div
      className="border-2 px-4 py-3"
      style={{ background: "#FFF4E0", borderColor: "#F59F00" }}
    >
      <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-orange-900">
        ⚠ IA detectou pendências na resposta do cliente
      </div>
      <ul className="my-1.5 ml-4 list-disc font-display text-[12px] leading-snug text-ink/85">
        {pendencias.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
      <p className="mt-1 font-display text-[11px] italic leading-snug text-ink/70">
        Considere responder ao cliente cobrando essas informações antes de aprovar uma ocorrência.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={handleResponder}
          className="bg-orange-600 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-orange-800"
        >
          ✉ Responder cliente
        </button>
        <button
          onClick={handleIgnorar}
          disabled={ignorando || modoVisualizacao}
          className="font-mono text-[10px] uppercase tracking-wider text-orange-900 underline-offset-2 transition-colors hover:underline disabled:opacity-50"
        >
          {ignorando ? "..." : "Ignorar e seguir"}
        </button>
      </div>
    </div>
  );
}

function CobrancaAgendadaInfo({ cardId }: { cardId: string }) {
  const { data: acao } = useQuery({
    queryKey: ["acao-agendada", cardId],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("acoes_agendadas")
        .select("executar_em")
        .eq("card_id", cardId)
        .eq("status", "pendente")
        .order("executar_em", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as { executar_em: string } | null;
    },
  });

  if (!acao?.executar_em) return null;

  const diff = new Date(acao.executar_em).getTime() - Date.now();
  const dias = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));

  return (
    <div className="border border-warn bg-warn/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink">
      ✦ Cobrança automática em {dias} dia{dias !== 1 ? "s" : ""}
    </div>
  );
}

/* ---------------- Lista compacta de validação humana ---------------- */

const OC_LABELS: Record<number, string> = {
  21: "Reentrega solicitada pelo cliente",
  54: "Aguardando retorno do cliente (com email)",
  59: "Aguardando retorno — indenização (com email)",
  55: "Autorizar seguir entrega",
  44: "Retorno de carga — encaminhar Devolução",
  56: "Falta info operacional — encaminhar Operação",
  41: "Informação complementar (texto livre)",
};

type AprovarExtras = {
  quantidade_volumes?: string;
  motivo?: string;
  filial?: string;
  texto_descricao?: string;
  // 54 — composer manual de email
  skip_email?: boolean;
  texto_email_customizado?: string;
  email_destinatarios?: string[];
  assunto_override?: string;
  template_id_override?: string;
  _template_original_id?: string;
  validar_evidencia?: boolean;
  skip_evidencia?: boolean;
  nao_seguir_thread?: boolean;
  anexos?: AnexoUploaded[];

  // 21 — reentrega: single anexo pra SSW
  anexo_id?: string | null;
  anexo_filename?: string | null;
  anexo_size?: number | null;
  _instrucao_prefill_aplicado?: boolean;
  // 21 — cancelar reentrega 24h via SSW opção 450
  cancelar_reentrega_24h?: boolean;
  motivo_cancelamento?: string;
  _cancel_prefill_aplicado?: boolean;
  // 21/44/55 — responder thread Gmail do cliente após lançar oc
  responder_thread_enviar?: boolean;
  responder_thread_corpo?: string;
  _resp_thread_prefill_aplicado?: boolean;
};

function precisaInputInline(codigo: number): boolean {
  // 55 entra aqui pra ABRIR o painel com a textarea, mas o texto dela é
  // OPCIONAL (diferente de 41/56, obrigatórios — ver validar()).
  return codigo === 41 || codigo === 56 || codigo === 44 || codigo === 55;
}

function ValidacaoHumanaList({
  card,
  todos,
  onApprove,
  approving,
  approvingTodoId,
  expandidoId,
  setExpandidoId,
  highlightedTodoId,
  comboModalTodo,
  setComboModalTodo,
  combo4459ModalTodo,
  setCombo4459ModalTodo,
  oc33SoloModalTodo,
  setOc33SoloModalTodo,
  emailOc33ModalTodo,
  setEmailOc33ModalTodo,
}: {
  card: CardRow;
  todos: TodoRow[];
  onApprove: (todo: TodoRow, extras?: Record<string, unknown>) => void;
  approving: boolean;
  approvingTodoId: string | null;
  expandidoId: string | null;
  setExpandidoId: (id: string | null) => void;
  highlightedTodoId: string | null;
  comboModalTodo: TodoRow | null;
  setComboModalTodo: (t: TodoRow | null) => void;
  combo4459ModalTodo: TodoRow | null;
  setCombo4459ModalTodo: (t: TodoRow | null) => void;
  oc33SoloModalTodo: TodoRow | null;
  setOc33SoloModalTodo: (t: TodoRow | null) => void;
  emailOc33ModalTodo: TodoRow | null;
  setEmailOc33ModalTodo: (t: TodoRow | null) => void;
}) {
  const modoVisualizacao = useModoVisualizacao();
  const qc = useQueryClient();
  const [extrasMap, setExtrasMap] = useState<Record<string, AprovarExtras>>({});
  const [voltarLoading, setVoltarLoading] = useState(false);
  const [uploadingAnexo, setUploadingAnexo] = useState(false);
  const [emailExtravioModalTodo, setEmailExtravioModalTodo] = useState<TodoRow | null>(null);
  // Caio 2026-07-22: ação com e-mail NUNCA aprova às cegas — o item ⭐ RECOMENDADA
  // abre a janela de edição (template/destinatários/aval de evidência). NF 556392/51712.
  const [emailAprovacaoModalTodo, setEmailAprovacaoModalTodo] = useState<TodoRow | null>(null);
  // VER EVIDÊNCIA da R1 Würth (Caio 2026-08-14): sugestão de 44 por 10 dias de
  // silêncio carrega meta.evidencia_id — o modal prova o "sem retorno".
  const [evidenciaWurthId, setEvidenciaWurthId] = useState<string | null>(null);

  const propostasRaw = todos.filter((t) => {
    const pl = (t.proposta_payload ?? {}) as any;
    return (
      pl?.tool === "lancar_ocorrencia" ||
      pl?.tool === "lancar_oc_e_enviar_email" ||
      pl?.tool === "lancar_combo_33_44" ||
      pl?.meta?.tipo_acao === "combo_33_44" ||
      pl?.tool === "lancar_combo_44_59" ||
      pl?.meta?.tipo_acao === "combo_44_59" ||
      pl?.tool === "lancar_oc33_solo_portal" ||
      pl?.meta?.tipo_acao === "oc33_solo" ||
      pl?.tool === "enviar_email_livre_e_lancar_oc33_portal" ||
      pl?.tool === "enviar_email_e_lancar_33_romaneio_interno" ||
      // Devolução com CT-e obrigatório da MARIA (ADR 0018). Sem esta linha a
      // proposta EXISTE no banco e NÃO APARECE na tela — o operador não tem como
      // aprovar, e o CT-e fica parado sem ninguém saber por quê.
      pl?.tool === "lancar_44_devolucao_cte"
    );
  });
  // Destaque vindo da IA padrão (aviso_alteracao_oc.proposta_destacada_acao).
  // Casa SEMPRE por acao_key — "54" sozinho é ambíguo entre "+ e-mail" e "sem e-mail".
  const destaqueAcaoKeyLocal: string | null =
    ((card as any).aviso_alteracao_oc?.tipo === "ia_sugestao_ocs_padrao"
      ? ((card as any).aviso_alteracao_oc?.proposta_destacada_acao as string | undefined)
      : undefined) ??
    ((card as any).analise_padrao_resultado?.proposta_destacada_acao as string | undefined) ??
    null;
  // Sobe RECOMENDADAS pro topo: destacada pela IA padrão > recomendada do backend (ex: PRATI)
  const propostas = [...propostasRaw].sort((a, b) => {
    const pa = (a.proposta_payload as any) ?? {};
    const pb = (b.proposta_payload as any) ?? {};
    const ra =
      (destaqueAcaoKeyLocal && pa?.acao_key === destaqueAcaoKeyLocal ? 2 : 0) +
      (pa?.recomendada ? 1 : 0);
    const rb =
      (destaqueAcaoKeyLocal && pb?.acao_key === destaqueAcaoKeyLocal ? 2 : 0) +
      (pb?.recomendada ? 1 : 0);
    return rb - ra;
  });
  const outras = todos.filter((t) => !propostasRaw.includes(t));

  function getExtras(id: string): AprovarExtras {
    return extrasMap[id] ?? {};
  }
  function setExtra(id: string, key: keyof AprovarExtras, value: any) {
    setExtrasMap((m) => ({ ...m, [id]: { ...(m[id] ?? {}), [key]: value } }));
  }

  /**
   * Extras da oc 44 PRÉ-PREENCHIDOS pela proposta (R13 do plano da devolução com
   * CT-e). As ocs 41/56/55 já tinham esse fallback; a 44 NÃO tinha — o campo
   * abria vazio mesmo quando a proposta trazia volumes/motivo/filial lidos do
   * CT-e, e a operadora redigitava, SOBRESCREVENDO o valor do documento.
   *
   * Inerte pro que já existia: nenhuma proposta de 44 do repo hoje carrega estes
   * campos em `args.extras` (verificado — só oc 11 fora-do-raio e oc 43 usam
   * `args.extras`, com outras chaves). Local sempre vence o prefill: o que a
   * operadora digitou é a verdade.
   */
  function getExtras44ComPrefill(todo: TodoRow): AprovarExtras {
    const local = getExtras(todo.id);
    const pre = (((todo.proposta_payload ?? {}) as any)?.args?.extras ?? {}) as Record<
      string,
      unknown
    >;
    const doPrefill = (k: "quantidade_volumes" | "motivo" | "filial") => {
      const atual = local[k];
      if (atual != null && String(atual).trim() !== "") return atual;
      const p = pre[k];
      return p == null || String(p).trim() === "" ? undefined : String(p);
    };
    return {
      ...local,
      quantidade_volumes: doPrefill("quantidade_volumes") as string | undefined,
      motivo: doPrefill("motivo") as string | undefined,
      filial: doPrefill("filial") as string | undefined,
    };
  }

  function validar(codigo: number, e: AprovarExtras): string | null {
    if (codigo === 41 || codigo === 56) {
      if (!(e.texto_descricao ?? "").trim()) return "Texto descritivo obrigatório";
    }
    if (codigo === 44) {
      if (!e.quantidade_volumes?.trim()) return "Quantidade de volumes obrigatória";
      if (!e.motivo?.trim()) return "Motivo obrigatório";
      if (!e.filial?.trim()) return "Filial obrigatória";
    }
    if (ehOcCliente(codigo) && e.skip_email === false) {
      if (!(e.texto_email_customizado ?? "").trim()) {
        return 'Texto do email obrigatório (ou desmarque "enviar email")';
      }
      if (!(e.assunto_override ?? "").trim()) {
        return 'Assunto obrigatório (ou desmarque "enviar email")';
      }
      if (!(e.email_destinatarios ?? []).length) {
        return 'Selecione ao menos um destinatário (ou desmarque "enviar email")';
      }
    }
    return null;
  }

  function handleConfirmar(todo: TodoRow) {
    const pl = (todo.proposta_payload ?? {}) as any;
    const codigo = Number(pl?.args?.codigo_ssw);
    // R13: a 44 lê o prefill da proposta (volumes/motivo/filial vindos do CT-e).
    // Sem isso `validar(44)` barrava com "obrigatória" um campo que a operadora
    // ESTAVA VENDO preenchido na tela — e ela redigitava, sobrescrevendo o CT-e.
    const extras = codigo === 44
      ? { ...getExtras44ComPrefill(todo) }
      : { ...getExtras(todo.id) };
    // Onda 2 do veto (25/08): a 56 pode nascer com texto GERADO pela IA em
    // args.extras.texto_descricao (texto-56-sugerido.ts). Mesma regra da 55:
    // o que a operadora VÊ na textarea é o que sobe — se ela não tocou, vale
    // o prefill. (41 entra de carona: hoje sem gerador, prefill vazio.)
    if (codigo === 41 || codigo === 56) {
      const prefillInput = (pl?.args?.extras?.texto_descricao as string | undefined) ?? "";
      if (!(extras.texto_descricao ?? "").trim() && prefillInput.trim()) {
        extras.texto_descricao = prefillInput;
      }
    }
    const erro = validar(codigo, extras);
    if (erro) {
      toast.error(erro);
      return;
    }
    const payload: Record<string, unknown> = {};
    if (codigo === 44) {
      payload.quantidade_volumes = extras.quantidade_volumes!.trim();
      payload.motivo = extras.motivo!.trim();
      payload.filial = extras.filial!.trim();
    }
    if ((codigo === 41 || codigo === 56) && extras.texto_descricao) {
      payload.texto_descricao = extras.texto_descricao.trim();
    }
    if (codigo === 55) {
      // Opcional. Se a operadora não tocou na textarea, vale o prefill que o
      // backend mandou em args.extras.texto_descricao (o que ela VÊ é o que sobe).
      const prefill55 = (pl?.args?.extras?.texto_descricao as string | undefined) ?? "";
      const t = (extras.texto_descricao ?? prefill55).trim();
      if (t) payload.texto_descricao = t.slice(0, 70);
    }
    if (codigo === 21) {
      const t = (extras.texto_descricao ?? "").trim();
      if (t) payload.texto_descricao = t;
      if (extras.anexo_id) payload.anexo_id = extras.anexo_id;
      if (extras.cancelar_reentrega_24h) {
        payload.cancelar_reentrega_24h = true;
        const motivo = (extras.motivo_cancelamento ?? "").trim();
        if (motivo) payload.motivo_cancelamento = motivo;
      }
    }
    const propostaEnviaEmail = pl?.tool === "lancar_oc_e_enviar_email";
    if (ehOcCliente(codigo) || propostaEnviaEmail) {
      // SEMPRE propaga a decisão do checkbox pro back. Se skip_email não foi
      // definido, assume a intenção da proposta original (lancar_oc_e_enviar_email
      // → enviar; lancar_ocorrencia simples → não enviar).
      const enviarEmail =
        extras.skip_email === undefined
          ? propostaEnviaEmail
          : extras.skip_email === false;
      payload.enviar_email = enviarEmail;
      payload.skip_email = !enviarEmail; // retrocompat com executor antigo
      if (ehOcCliente(codigo) && enviarEmail) {
        payload.texto_email_customizado = (extras.texto_email_customizado ?? "").trim();
        payload.assunto_override = (extras.assunto_override ?? "").trim();
        payload.email_destinatarios = extras.email_destinatarios ?? [];
        if (
          extras.template_id_override &&
          extras.template_id_override !== extras._template_original_id
        ) {
          payload.template_id_override = extras.template_id_override;
        }
        if (extras.nao_seguir_thread) {
          payload.nao_seguir_thread = true;
        }
      }
    }

    if (![10, 11, 35].includes(card.cod_ultima_ocorrencia ?? -1)) {
      payload.validar_evidencia = !!extras.validar_evidencia;
    }
    if (
      [10, 11, 35].includes(card.cod_ultima_ocorrencia ?? -1) &&
      extras.skip_evidencia === true
    ) {
      payload.skip_evidencia = true;
    }
    if ((extras.anexos ?? []).length > 0) {
      payload.anexos_ids = (extras.anexos ?? []).map((a) => a.anexo_id);
    }
    if (
      ocAceitaRespostaThread(codigo) &&
      !!card.cliente_respondeu_em
    ) {
      const enviar = extras.responder_thread_enviar ?? true;
      const corpo = (extras.responder_thread_corpo ?? "").trim();
      payload.responder_thread_cliente = enviar && corpo
        ? { enviar: true, corpo }
        : { enviar: false };
    }
    if (ehOcCliente(codigo) || pl?.tool === "lancar_oc_e_enviar_email") {
      const enviarEmail = payload.enviar_email === true;
      toast.info(
        enviarEmail
          ? `Lançando oc ${codigo} + enviando email…`
          : `Lançando oc ${codigo} (sem email).`,
      );
    }
    onApprove(todo, Object.keys(payload).length > 0 ? payload : undefined);
  }

  async function handleVoltarToDo() {
    if (propostas.length === 0) {
      toast.error("Sem propostas pendentes pra voltar");
      return;
    }
    const motivo = window.prompt("Motivo (opcional):") ?? "";
    setVoltarLoading(true);
    const { data, error } = await supabase!.functions.invoke(
      "voltar-para-to-do-com-rastreio",
      { body: { todo_id: propostas[0].id, motivo: motivo || null } },
    );
    setVoltarLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if ((data as any)?.rastreio?.mudou) {
      toast.success(
        `Voltou pra "Para Fazer". Rastreio detectou oc=${(data as any).rastreio.oc_real}.`,
      );
    } else {
      toast.success('Voltou pra "Para Fazer".');
    }
    qc.invalidateQueries({ queryKey: ["cards"] });
    qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
    qc.invalidateQueries({ queryKey: ["card-events", card.id] });
  }

  return (
    <div className="space-y-3">
      <div data-acoes-sugeridas className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
        <span className="inline-block h-1.5 w-1.5 bg-sal" />
        ações sugeridas
        <span className="text-ink/30">
          — {propostas.length} {propostas.length === 1 ? "opção" : "opções"}
        </span>
      </div>

      <div className="divide-y divide-ink/10 border border-ink/20 bg-paper">
        {propostas.map((todo) => {
          const pl = (todo.proposta_payload ?? {}) as any;
          const isCombo =
            pl?.tool === "lancar_combo_33_44" || pl?.meta?.tipo_acao === "combo_33_44";
          const isCombo4459 =
            pl?.tool === "lancar_combo_44_59" || pl?.meta?.tipo_acao === "combo_44_59";
          const ehOc33Solo =
            pl?.tool === "lancar_oc33_solo_portal" || pl?.meta?.tipo_acao === "oc33_solo";
          const ehEmailOc33 = pl?.tool === "enviar_email_livre_e_lancar_oc33_portal";
          const ehRomaneioInterno =
            pl?.tool === "enviar_email_e_lancar_33_romaneio_interno";
          const ehDestacadaIA =
            !!destaqueAcaoKeyLocal && pl?.acao_key === destaqueAcaoKeyLocal;
          const recomendada = pl?.recomendada === true || ehDestacadaIA;
          const motivoRecomendacao =
            typeof pl?.motivo_recomendacao === "string"
              ? pl.motivo_recomendacao
              : ehDestacadaIA
                ? ((card as any).aviso_alteracao_oc?.observacao_orquestrador ?? null)
                : null;
          const avisoRomaneio =
            typeof pl?.aviso_romaneio_interno === "string"
              ? pl.aviso_romaneio_interno
              : null;
          const codigo = Number(pl?.args?.codigo_ssw);
          const isExpandido = expandidoId === todo.id;
          const isLoading = approving && approvingTodoId === todo.id;
          // `isLoading` é por-todo e serve só pro RÓTULO ("aprovando...").
          // O `disabled` precisa ser GLOBAL: enquanto QUALQUER aprovação deste
          // card está em voo, os botões das propostas IRMÃS ficam travados.
          // Sem isso, aprovar a proposta A e clicar na B durante o request
          // enfileira DUAS ocorrências distintas no SSW (dois CT-e, dois e-mails).
          // A idempotência do backend não pega: UNIQUE(card_id,codigo_oc,ctrc,todo_id)
          // só barra a MESMA oc do MESMO todo, e aqui oc e todo são diferentes.
          const aprovacaoEmVoo = approving;
          const requerInput = !isCombo && !isCombo4459 && !ehOc33Solo && !ehEmailOc33 && !ehRomaneioInterno && precisaInputInline(codigo);
          const label = isCombo
            ? "Lançar 33 + Lançar 44 (Ressarcimento)"
            : isCombo4459
            ? "Lançar 44 + Lançar 59 (devolver o que ficou + pedir romaneio)"
            : ehRomaneioInterno
              ? (pl?.label_humano ?? "Email + Lançar oc 33 — Extravio Total (romaneio interno)")
              : ehEmailOc33
                ? "Email + Lançar oc 33 (notificar cliente + reversão)"
                : ehOc33Solo
                  ? "Lançar 33 (sem 44)"
                  : OC_LABELS[codigo] ?? todo.descricao ?? `Lançar oc ${codigo}`;
          const rationale = typeof pl?.rationale === "string" ? pl.rationale : null;

          const ehSugerida =
            !isCombo && !isCombo4459 && card.ia_sugestao_oc_resposta?.oc_sugerida === codigo;
          const sugereCombo =
            isCombo && card.ia_sugestao_oc_resposta?.sugere_combo_33_44 === true;
          const sugereCombo4459 =
            isCombo4459 && card.ia_sugestao_oc_resposta?.sugere_combo_44_59 === true;
          const sugereOc33Solo =
            ehOc33Solo && card.ia_sugestao_oc_resposta?.sugere_oc33_solo === true;
          const motivoCombo = card.ia_sugestao_oc_resposta?.motivo_combo ?? "";
          const isHighlighted = highlightedTodoId === todo.id;

          // Origem da instrução da oc 21 (Caio 2026-08-14, NF 674757 Würth):
          // a operadora precisa VER se o texto que vai pro SSW veio do E-MAIL
          // do cliente ou da intranet Würth — a 674757 foi aprovada às cegas
          // com a Obs de um ciclo anterior da intranet enquanto o e-mail com
          // os dados novos já estava no card. meta.origem_instrucao é gravado
          // pelo enxerto (instrucao-email-21.ts); meta.origem pelo robô.
          const origemInstrucao21 =
            codigo === 21
              ? pl?.meta?.origem_instrucao === "email_cliente"
                ? ("email" as const)
                : pl?.meta?.origem === "robo-intranet-wurth"
                  ? ("intranet" as const)
                  : null
              : null;
          // R1 Würth: botão VER EVIDÊNCIA quando a proposta carrega a prova do
          // silêncio (meta.evidencia_id gravado pelo robô junto com a sugestão).
          const evidenciaWurth =
            typeof pl?.meta?.evidencia_id === "string" ? (pl.meta.evidencia_id as string) : null;
          const botaoVerEvidenciaWurth = evidenciaWurth ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setEvidenciaWurthId(evidenciaWurth);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  setEvidenciaWurthId(evidenciaWurth);
                }
              }}
              className="inline-block shrink-0 cursor-pointer border border-warning bg-warning/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-warning hover:bg-warning/20"
              title="Abre a prova de que não havia retorno da Würth na intranet na data da consulta"
            >
              🔍 ver evidência
            </span>
          ) : null;

          const chipOrigemInstrucao21 = origemInstrucao21 ? (
            <span
              className={cn(
                "inline-block shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider",
                origemInstrucao21 === "email"
                  ? "border-sky-500 bg-sky-50 text-sky-800"
                  : "border-violet-500 bg-violet-50 text-violet-800",
              )}
              title={
                origemInstrucao21 === "email"
                  ? `Instrução extraída do e-mail do cliente: "${pl?.meta?.instrucao_email_original ?? pl?.args?.descricao ?? ""}"`
                  : `Instrução vinda da intranet Würth: "${pl?.meta?.obs_intranet_original ?? pl?.args?.descricao ?? ""}"`
              }
            >
              {origemInstrucao21 === "email"
                ? "✉️ instrução veio do e-mail do cliente"
                : "🌐 instrução veio da intranet Würth"}
            </span>
          ) : null;

          // Karol 2026-09-09 (NFs 350882/431734): a 33 APARECE e o operador clica
          // achando que está pronta — mas o executor barra quando o dossiê de
          // extravio parcial está incompleto, e o motivo só aparecia DEPOIS de
          // abrir o modal. Aqui a própria linha diz o que falta.
          // Não é gate: é rótulo. O bloqueio real segue no executor (deliberado —
          // sem romaneio o SSW reverte a 33). `null` = sem dossiê ⇒ não afirma nada.
          const ehQualquerOc33 =
            isCombo || ehOc33Solo || ehEmailOc33 || ehRomaneioInterno || codigo === 33;
          const faltaDossie33 = ehQualquerOc33 && !isCombo4459
            ? faltandoParaOc33(card, { ehCombo: isCombo })
            : null;
          const textoFalta33 = textoFaltandoOc33(faltaDossie33);
          const AvisoDossie33Banner = textoFalta33 ? (
            <div className="ml-12 mt-1 flex items-start gap-1.5 border border-rose-400 bg-rose-50 px-2 py-1 font-mono text-[10px] leading-snug text-rose-900">
              <span className="shrink-0">📋</span>
              <span>
                {textoFalta33} — o SSW reverte a 33 sem isso. Cobre o cliente ou anexe ao dossiê antes de lançar.
              </span>
            </div>
          ) : null;

          // Banner ⚠️ pra alertar quando a opção lança oc 33 SEM rodar o fluxo
          // de romaneio interno (carimbado pelo backend só em cards de cliente
          // romaneio-interno, ex. PRATI).
          const AvisoRomaneioBanner = avisoRomaneio ? (
            <div className="ml-12 mt-1 flex items-start gap-1.5 border border-amber-400 bg-amber-50 px-2 py-1 font-mono text-[10px] leading-snug text-amber-900">
              <span className="shrink-0">⚠️</span>
              <span>{avisoRomaneio}</span>
            </div>
          ) : null;

          // Branch RECOMENDADA — render destacado, ordenado pro topo.
          // EXCETO quando exige input e o operador acabou de clicar em aprovar
          // (rota abrir-input → isExpandido): este bloco NÃO renderiza o painel
          // expandido, então precisa cair no render normal — senão o clique é
          // beco sem saída (NF 1094294 LARISSA 24/07: ⭐ 56 clicada, expandidoId
          // setado e NADA visível acontecia; aprovação nunca chegava ao banco).
          // Gêmeo sem-email destacado (auditoria 25/07, NFs 101182/343285):
          // o ⭐ genérico aprovava às cegas com rótulo do OC_LABELS ("com
          // email") — gêmeo SEMPRE renderiza pelo ramo próprio (confirm
          // deliberado + extras do guard + rótulo honesto), mesmo destacado.
          const ehGemeoSemEmailDestacado =
            ehOcCliente(codigo) &&
            (pl?.meta?.sem_email_explicito === true ||
              (pl?.tool === "lancar_ocorrencia" &&
                !pl?.args?.template_id &&
                pl?.meta?.modo !== "completo"));
          if (
            (ehRomaneioInterno || recomendada) &&
            !(requerInput && isExpandido) &&
            !ehGemeoSemEmailDestacado
          ) {
            return (
              <div key={todo.id} data-todo-id={todo.id} className="m-2 overflow-hidden rounded-[14px] border-[1.5px] border-[#37B24D] bg-surface">
                <div className="px-3 py-3">
                  <div className="mb-1 inline-block rounded-[6px] bg-[#EBF9EE] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[#2B9A40]">
                    ★ Recomendada
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="w-9 shrink-0 pt-0.5 text-center font-mono text-[13px] font-bold text-emerald-800">
                      🗂️
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-ink">{label}</div>
                      {(chipOrigemInstrucao21 || botaoVerEvidenciaWurth) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {chipOrigemInstrucao21}
                          {botaoVerEvidenciaWurth}
                        </div>
                      )}
                      {motivoRecomendacao && (
                        <div className="mt-0.5 font-display text-[11px] leading-snug text-ink/70">
                          {motivoRecomendacao}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        const destino = decidirCliqueAprovacao(pl);
                        if (destino === "modal-combo-4459") setCombo4459ModalTodo(todo);
                        // Caio 2026-07-24 (NF 158084): oc33 solo / combo 33+44
                        // abrem o MESMO modal de anexos do item não-recomendado
                        // — nunca aprovar às cegas (anexos_ids=[] → revert).
                        else if (destino === "modal-oc33-solo") setOc33SoloModalTodo(todo);
                        else if (destino === "modal-combo-3344") setComboModalTodo(todo);
                        else if (destino === "modal-email") setEmailAprovacaoModalTodo(todo);
                        else if (destino === "modal-email-livre-oc33") setEmailOc33ModalTodo(todo);
                        // Caio 2026-07-23 (NF 62566): 41/56/44/55 têm input do
                        // operador — ABRE o painel expandido (fluxo existente,
                        // com o texto pro SSW), nunca lança às cegas.
                        else if (destino === "abrir-input") setExpandidoId(todo.id);
                        else onApprove(todo);
                      }}
                      disabled={aprovacaoEmVoo || modoVisualizacao}
                      className="shrink-0 rounded-[8px] bg-[#2B9A40] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#238636] disabled:opacity-40"
                    >
                      {isLoading ? "aprovando..." : "aprovar ação →"}
                    </button>
                  </div>
                </div>
              </div>
            );
          }


          if (isCombo4459) {
            return (
              <div key={todo.id} data-todo-id={todo.id}>
                <button
                  onClick={() => setCombo4459ModalTodo(todo)}
                  disabled={aprovacaoEmVoo || modoVisualizacao}
                  className={cn(
                    "flex w-full flex-col items-stretch gap-1 px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.02] disabled:opacity-60",
                    sugereCombo4459 && "border-2 border-purple-500 bg-purple-50/40",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-9 text-center font-mono text-[13px] font-bold text-ink">
                      44+59
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-ink">{label}</span>
                        {sugereCombo4459 && (
                          <span className="bg-purple-600 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-paper">
                            ⭐ IA sugere
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-display text-[11px] leading-snug text-ink/70">
                        Lança oc 44 (devolução dos volumes que permaneceram conosco) e
                        depois oc 59 + e-mail pedindo romaneio/descrição/valor dos extraviados.
                      </div>
                      {sugereCombo4459 && motivoCombo && (
                        <div className="mt-0.5 font-display text-[11px] italic leading-snug text-purple-900/80">
                          💡 {motivoCombo}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                      preencher →
                    </span>
                  </div>
                </button>
              </div>
            );
          }

          if (isCombo) {
            return (
              <div key={todo.id} data-todo-id={todo.id}>
                <button
                  onClick={() => setComboModalTodo(todo)}
                  disabled={aprovacaoEmVoo || modoVisualizacao}
                  className={cn(
                    "flex w-full flex-col items-stretch gap-1 px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.02] disabled:opacity-60",
                    sugereCombo && "border-2 border-indigo-500 bg-indigo-50/40",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-9 text-center font-mono text-[13px] font-bold text-ink">
                      {sugereCombo ? "⭐" : "33+44"}
                    </span>
                    <span className="flex-1 text-[12px] font-semibold text-ink">{label}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink/60">
                      lançar →
                    </span>
                  </div>
                  {sugereCombo && motivoCombo && (
                    <div className="ml-12 font-mono text-[10px] leading-snug text-ink/60">
                      💡 IA sugere: {motivoCombo.slice(0, 200)}
                      {motivoCombo.length > 200 ? "…" : ""}
                    </div>
                  )}
                </button>
                {AvisoRomaneioBanner}
                {AvisoDossie33Banner}
              </div>
            );
          }

          if (ehOc33Solo) {
            return (
              <div key={todo.id} data-todo-id={todo.id}>
                <button
                  onClick={() => setOc33SoloModalTodo(todo)}
                  disabled={aprovacaoEmVoo || modoVisualizacao}
                  className={cn(
                    "flex w-full flex-col items-stretch gap-1 px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.02] disabled:opacity-60",
                    sugereOc33Solo && "border-2 border-indigo-500 bg-indigo-50/40",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-9 text-center font-mono text-[12px] font-bold text-ink">
                      {sugereOc33Solo ? "⭐" : "33"}
                    </span>
                    <span className="flex-1 text-[12px] font-semibold text-ink">
                      {label}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink/60">
                      lançar →
                    </span>
                  </div>
                  {sugereOc33Solo && motivoCombo && (
                    <div className="ml-12 font-mono text-[10px] leading-snug text-ink/60">
                      💡 IA sugere: {motivoCombo.slice(0, 200)}
                      {motivoCombo.length > 200 ? "…" : ""}
                    </div>
                  )}
                </button>
                {AvisoRomaneioBanner}
                {AvisoDossie33Banner}
              </div>
            );
          }

          if (ehEmailOc33) {
            return (
              <div key={todo.id} data-todo-id={todo.id}>
                <button
                  onClick={() => setEmailOc33ModalTodo(todo)}
                  disabled={aprovacaoEmVoo || modoVisualizacao}
                  className="flex w-full flex-col items-stretch gap-1 px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.02] disabled:opacity-60"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-9 text-center font-mono text-[12px] font-bold text-ink">
                      ✉+33
                    </span>
                    <span className="flex-1 text-[12px] font-semibold text-ink">
                      {label}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink/60">
                      abrir →
                    </span>
                  </div>
                  {rationale && (
                    <div className="ml-12 font-mono text-[10px] leading-snug text-ink/60">
                      {rationale.slice(0, 200)}
                      {rationale.length > 200 ? "…" : ""}
                    </div>
                  )}
                </button>
                {AvisoRomaneioBanner}
                {AvisoDossie33Banner}
              </div>
            );
          }

          // "54 SEM e-mail" — variante pontual que lança a oc 54 direto, SEM abrir composer.
          // Backend cria o todo com tool=lancar_ocorrencia + meta.sem_email_explicito=true,
          // ao lado do "54 + e-mail" (lancar_oc_e_enviar_email).
          const ehSemEmail54 =
            ehOcCliente(codigo) &&
            (pl?.meta?.sem_email_explicito === true ||
              (pl?.tool === "lancar_ocorrencia" &&
                !pl?.args?.template_id &&
                pl?.meta?.modo !== "completo"));

          if (ehSemEmail54) {
            return (
              <div key={todo.id} data-todo-id={todo.id}>
                <button
                  onClick={() => {
                    const ok = window.confirm(
                      `Esta ação lança a oc ${codigo} no SSW mas NÃO envia e-mail. O cliente NÃO será notificado. Confirmar?`,
                    );
                    if (!ok) return;
                    // Este confirm É a confirmação deliberada que o guard
                    // backend exige pro gêmeo sem-email (NF 1090092).
                    onApprove(todo, extrasSemEmailDeliberado());
                  }}
                  disabled={aprovacaoEmVoo || modoVisualizacao}
                  className={cn(
                    "flex w-full flex-col items-stretch gap-1 px-3 py-2.5 text-left transition-colors hover:bg-amber-50/50 disabled:opacity-60",
                    isHighlighted && "animate-pulse ring-4 ring-inset ring-indigo-500",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-9 text-center font-mono text-[13px] font-bold text-ink">
                      {codigo}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[12px] font-semibold text-ink">
                          {todo.descricao ?? `Lançar oc ${codigo} — SEM e-mail`}
                        </span>
                        <span className="shrink-0 border-2 border-amber-600 bg-amber-100 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-900">
                          🚫 sem e-mail — cliente NÃO será notificado
                        </span>
                      </span>
                      {/* Karol 2026-09-09: o "54" era LITERAL aqui enquanto o título
                          logo acima já usava {codigo}. Numa linha de 59 a tela dizia
                          "59" no rótulo e "lança só a oc 54" na explicação — informava
                          ao operador uma ocorrência que não era a que ia ser lançada.
                          Visto na NF 350882 (linha 59 com texto de 54). */}
                      <span className="mt-0.5 block font-mono text-[10px] leading-snug text-ink/55">
                        Lança só a oc {codigo} no SSW (não envia e-mail). Use quando o cliente já foi avisado por outro canal.
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink/60">
                      {isLoading ? "lançando..." : "lançar →"}
                    </span>
                  </div>
                </button>
                {AvisoRomaneioBanner}
                {AvisoDossie33Banner}
              </div>
            );
          }



          const isIaEvidencia = pl?.meta?.origem === "executar_sugestao_evidencia";
          const ocAnalisada = pl?.meta?.codigo_oc_analisada ?? pl?.meta?.oc_analisada;
          // Selo de e-mail DEVE ser decidido só por meta.modo / meta.sem_email_explicito.
          // NUNCA pelo tool — extravio usa lancar_oc_e_enviar_email mesmo em ações
          // sem e-mail (ex.: oc 49 com meta.modo='sem_email').
          const ehModoCompleto = pl?.meta?.modo === "completo";
          const ehSemEmailExplicito = pl?.meta?.sem_email_explicito === true;

          if (ehModoCompleto) {
            return (
              <div key={todo.id} data-todo-id={todo.id}>
                <button
                  onClick={() => setEmailExtravioModalTodo(todo)}
                  disabled={aprovacaoEmVoo || modoVisualizacao}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.02] disabled:opacity-60",
                    isHighlighted && "animate-pulse ring-4 ring-inset ring-indigo-500",
                  )}
                >
                  <span className="w-9 text-center font-mono text-[13px] font-bold text-ink">
                    {Number.isFinite(codigo) ? codigo : "—"}
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] text-ink/85">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold text-ink">{label}</span>
                      <span
                        className="shrink-0 border-2 border-emerald-600 bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-800"
                        title="Esta ação lança a oc e envia e-mail ao cliente"
                      >
                        ✉ + e-mail ao cliente
                      </span>
                    </span>
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink/60">
                    abrir editor →
                  </span>
                </button>
              </div>
            );
          }

          return (
            <div key={todo.id} data-todo-id={todo.id}>
              <button
                onClick={() => setExpandidoId(isExpandido ? null : todo.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  isExpandido ? "bg-ink/[0.04]" : "hover:bg-ink/[0.02]",
                  ehSugerida && "ring-2 ring-inset ring-indigo-300 bg-indigo-50/40",
                  isIaEvidencia && "bg-sky-50 ring-2 ring-inset ring-sky-300",
                  isHighlighted && "animate-pulse ring-4 ring-inset ring-indigo-500",
                )}
              >
                <span className="w-9 text-center font-mono text-[13px] font-bold text-ink">
                  {isIaEvidencia ? "✨" : Number.isFinite(codigo) ? codigo : "—"}
                </span>
                <span className="flex-1 text-[12px] text-ink/85">
                  {label}
                  {isIaEvidencia && (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-sky-700">
                      (sugestão IA{ocAnalisada ? `, evidência oc=${ocAnalisada}` : ""})
                    </span>
                  )}
                  {chipOrigemInstrucao21 && <span className="ml-2">{chipOrigemInstrucao21}</span>}
                  {botaoVerEvidenciaWurth && <span className="ml-2">{botaoVerEvidenciaWurth}</span>}
                </span>
                {ehSemEmailExplicito && (
                  <span
                    className="shrink-0 border-2 border-amber-600 bg-amber-100 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-900"
                    title="Esta ação lança a oc mas NÃO envia e-mail ao cliente"
                  >
                    🚫 sem e-mail — cliente NÃO será notificado
                  </span>
                )}
                {requerInput && !isExpandido && (
                  <span className="border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber-800">
                    {codigo === 55 ? "texto opcional" : "requer input"}
                  </span>
                )}

                <span className="font-mono text-[10px] uppercase tracking-wider text-ink/60">
                  {isExpandido ? "↑ fechar" : "lançar →"}
                </span>
              </button>

              {AvisoRomaneioBanner}
                {AvisoDossie33Banner}


              {isExpandido && (
                <div className="space-y-3 border-t border-ink/10 bg-ink/[0.02] px-4 py-3">
                  {avisoRomaneio && (
                    <div className="flex items-start gap-1.5 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 font-mono text-[11px] leading-snug text-amber-900">
                      <span className="shrink-0">⚠️</span>
                      <span>{avisoRomaneio}</span>
                    </div>
                  )}
                  {(codigo === 41 || codigo === 56) && (
                    <div>
                      <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                        texto descritivo (vai como descrição da oc no ssw)
                        <span className="ml-1 text-red-600">*</span>
                        {(pl?.meta?.origem_instrucao === "interpretador_texto_56" ||
                          !!(pl?.args?.extras?.texto_descricao as string | undefined)) && (
                          <span className="ml-2 normal-case tracking-normal text-indigo-700">
                            · texto sugerido pela IA — revise e ajuste se precisar
                          </span>
                        )}
                      </label>
                      <textarea
                        autoFocus
                        value={
                          getExtras(todo.id).texto_descricao ??
                          ((pl?.args?.extras?.texto_descricao as string | undefined) ?? "")
                        }
                        onChange={(e) => setExtra(todo.id, "texto_descricao", e.target.value)}
                        rows={3}
                        maxLength={500}
                        placeholder={
                          codigo === 41
                            ? "Ex: Cliente solicitou via telefone aguardar posicionamento sobre nota fiscal divergente. Retorno previsto 06/05."
                            : "Ex: Aguardando operação validar evidência de entrega — foto não está clara. Solicitada nova imagem."
                        }
                        className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
                      />
                      <div className="mt-0.5 flex justify-between text-[9px] text-ink/40">
                        <span>obrigatório • máx 500 caracteres</span>
                        <span>
                          {(
                            getExtras(todo.id).texto_descricao ??
                            ((pl?.args?.extras?.texto_descricao as string | undefined) ?? "")
                          ).length}
                          /500
                        </span>
                      </div>
                    </div>
                  )}

                  {codigo === 55 && (
                    <div>
                      <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                        Texto pra o SSW (opcional) — até 70 caracteres
                      </label>
                      <textarea
                        autoFocus
                        value={
                          getExtras(todo.id).texto_descricao ??
                          ((pl?.args?.extras?.texto_descricao as string | undefined) ?? "")
                        }
                        onChange={(e) => setExtra(todo.id, "texto_descricao", e.target.value)}
                        rows={2}
                        maxLength={70}
                        placeholder="Ex: Autorizado seguir com entrega parcial conforme retorno do cliente."
                        className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
                      />
                      <div className="mt-0.5 flex justify-between text-[9px] text-ink/40">
                        <span>opcional • o setor no SSW lê só os primeiros 70 caracteres</span>
                        <span>
                          {(
                            getExtras(todo.id).texto_descricao ??
                            ((pl?.args?.extras?.texto_descricao as string | undefined) ?? "")
                          ).length}
                          /70
                        </span>
                      </div>
                    </div>
                  )}

                  {codigo === 44 && (
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                          volumes <span className="text-red-600">*</span>
                        </label>
                        <input
                          autoFocus
                          type="number"
                          value={getExtras44ComPrefill(todo).quantidade_volumes ?? ""}
                          onChange={(e) => setExtra(todo.id, "quantidade_volumes", e.target.value)}
                          className="w-full border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                          motivo <span className="text-red-600">*</span>
                        </label>
                        <input
                          type="text"
                          value={getExtras44ComPrefill(todo).motivo ?? ""}
                          onChange={(e) => setExtra(todo.id, "motivo", e.target.value)}
                          className="w-full border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                          filial <span className="text-red-600">*</span>
                        </label>
                        <input
                          type="text"
                          value={getExtras44ComPrefill(todo).filial ?? ""}
                          onChange={(e) => setExtra(todo.id, "filial", e.target.value)}
                          className="w-full border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
                        />
                      </div>
                    </div>
                  )}

                  {codigo === 21 && (
                    <ReentregaInputs21
                      cardId={card.id}
                      iaSugestao={card.ia_sugestao_oc_resposta as any}
                      extras={getExtras(todo.id)}
                      onChange={(patch) =>
                        setExtrasMap((m) => ({
                          ...m,
                          [todo.id]: { ...(m[todo.id] ?? {}), ...patch },
                        }))
                      }
                      uploading={uploadingAnexo}
                      setUploading={setUploadingAnexo}
                      disabled={aprovacaoEmVoo || modoVisualizacao}
                    />
                  )}

                  {ehOcCliente(codigo) && (
                    <ComposerEmail54
                      todoId={todo.id}
                      cardId={card.id}
                      cardCodOc={card.cod_ultima_ocorrencia ?? null}
                      propostaCodigoSsw={codigo}
                      propostaOriginalEnviaEmail={pl?.tool === "lancar_oc_e_enviar_email"}
                      templateSugeridoIA={
                        (card as any).analise_padrao_resultado
                          ?.template_email_sugerido ?? null
                      }
                      extras={getExtras(todo.id)}
                      onChangeExtras={(patch) =>
                        setExtrasMap((m) => ({
                          ...m,
                          [todo.id]: { ...(m[todo.id] ?? {}), ...patch },
                        }))
                      }
                    />
                  )}

                  {ehOcCliente(codigo) && getExtras(todo.id).skip_email !== true && (
                    <AnexosUploader
                      cardId={card.id}
                      todoId={todo.id}
                      anexos={getExtras(todo.id).anexos ?? []}
                      onChange={(next) => setExtra(todo.id, "anexos", next)}
                      uploading={uploadingAnexo}
                      setUploading={setUploadingAnexo}
                      disabled={aprovacaoEmVoo || modoVisualizacao}
                    />
                  )}

                  {ocAceitaRespostaThread(codigo) && !!card.cliente_respondeu_em && (
                    <ResponderThreadClienteBlock
                      codigo={codigo}
                      nf={card.nf ?? null}
                      enviar={getExtras(todo.id).responder_thread_enviar ?? true}
                      corpo={getExtras(todo.id).responder_thread_corpo ?? ""}
                      prefillAplicado={!!getExtras(todo.id)._resp_thread_prefill_aplicado}
                      onChange={(patch) =>
                        setExtrasMap((m) => ({
                          ...m,
                          [todo.id]: { ...(m[todo.id] ?? {}), ...patch },
                        }))
                      }
                      disabled={aprovacaoEmVoo || modoVisualizacao}
                    />
                  )}


                  {![10, 11, 35].includes(card.cod_ultima_ocorrencia ?? -1) && (
                    <label className="flex cursor-pointer items-start gap-2 border border-ink/15 bg-paper p-2.5">
                      <input
                        type="checkbox"
                        checked={!!getExtras(todo.id).validar_evidencia}
                        onChange={(e) => setExtra(todo.id, "validar_evidencia", e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 accent-sal"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[10px] uppercase tracking-wider text-ink">
                          validar evidência antes de enviar
                        </div>
                        <div className="mt-0.5 font-mono text-[9px] leading-snug text-ink/50">
                          Aplica regra de bloqueio se SSW não tiver foto anexada na ocorrência atual do card. Marque só quando o motivo exige evidência (ex: contestar recusa).
                        </div>
                      </div>
                    </label>
                  )}

                  {(() => {
                    const cardOc = card.cod_ultima_ocorrencia ?? -1;
                    if (![10, 11, 35].includes(cardOc)) return null;
                    if (pl?.tool !== "lancar_oc_e_enviar_email") return null;
                    const extrasAtuais = getExtras(todo.id);
                    if (ehOcCliente(codigo) && extrasAtuais.skip_email === true) return null;
                    const corpoTemplate =
                      (extrasAtuais.texto_email_customizado ?? "") +
                      " " +
                      (extrasAtuais.assunto_override ?? "");
                    const corpoProposta = JSON.stringify(pl?.args ?? {});
                    const temLinkEvidencia =
                      corpoTemplate.includes("{link_evidencia}") ||
                      corpoProposta.includes("{link_evidencia}") ||
                      // Quando ainda não carregou template, assumir presença pra propostas com email
                      (ehOcCliente(codigo) && !extrasAtuais.texto_email_customizado);
                    if (!temLinkEvidencia) return null;
                    const evStatus = (card as any).evidencia_status as string | null;
                    const evDiag = (card as any).evidencia_diagnostico as string | null;
                    if (evStatus === "ok_com_foto_correlacionada") return null;
                    const ausente = evStatus && evStatus !== "ok_com_foto_correlacionada";
                    const marcado = !!extrasAtuais.skip_evidencia;
                    return (
                      <div className="space-y-2">
                        {ausente && (
                          <div className="border border-yellow-500 bg-yellow-50 px-2.5 py-2 font-mono text-[10px] leading-snug text-yellow-900">
                            ⚠ Detectado: evidência ausente pra oc={cardOc} do card
                            {evDiag ? ` (${evDiag})` : ""}
                          </div>
                        )}
                        <label className="flex cursor-pointer items-start gap-2 border border-ink/15 bg-paper p-2.5">
                          <input
                            type="checkbox"
                            checked={marcado}
                            onChange={(e) => setExtra(todo.id, "skip_evidencia", e.target.checked)}
                            className="mt-0.5 h-3.5 w-3.5 accent-sal"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[10px] uppercase tracking-wider text-ink">
                              lançar mesmo assim sem verificar evidência
                            </div>
                            <div className="mt-0.5 font-mono text-[9px] leading-snug text-ink/50">
                              vou anexar a foto manualmente no SSW
                            </div>
                          </div>
                        </label>
                        {marcado && (
                          <div className="border border-orange-400 bg-orange-50 px-2.5 py-1.5 font-mono text-[10px] text-orange-900">
                            ⚠ Lembre de anexar a evidência manualmente no SSW.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="truncate font-mono text-[10px] text-ink/50">
                      {rationale?.slice(0, 90) ?? ""}
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setExpandidoId(null)}
                        disabled={aprovacaoEmVoo || modoVisualizacao}
                        className="font-mono text-[10px] uppercase tracking-wider text-ink-soft transition-colors hover:text-ink disabled:opacity-40"
                      >
                        cancelar
                      </button>
                      <button
                        onClick={() => handleConfirmar(todo)}
                        disabled={aprovacaoEmVoo || uploadingAnexo}
                        className="bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
                      >
                        {isLoading ? "lançando..." : "confirmar lançamento →"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {outras.length > 0 && (
        <ul className="space-y-3">
          {outras.map((t) => (
            <ProposalCard
              key={t.id}
              todo={t}
              card={card}
              onApprove={(extras) => onApprove(t, extras)}
              approving={approving && approvingTodoId === t.id}
              hideUniversalActions
            />
          ))}
        </ul>
      )}

      <div className="flex justify-end border-t border-ink/15 pt-3">
        <button
          onClick={handleVoltarToDo}
          disabled={voltarLoading}
          className="font-mono text-[10px] uppercase tracking-wider text-ink-soft transition-colors hover:text-ink disabled:opacity-40"
          title="Devolve o card pra to-do (cancela todos pendentes, sincroniza oc real do SSW)"
        >
          {voltarLoading ? "..." : "↶ voltar pra to-do"}
        </button>
      </div>

      {evidenciaWurthId && (
        <ModalEvidenciaIntranetWurth
          evidenciaId={evidenciaWurthId}
          open
          onClose={() => setEvidenciaWurthId(null)}
        />
      )}
      {emailAprovacaoModalTodo && (
        <EditarEmailModal
          todoId={emailAprovacaoModalTodo.id}
          templateSugeridoIA={
            ((emailAprovacaoModalTodo.proposta_payload as { args?: { template_id?: string } } | null)?.args?.template_id) ?? null
          }
          permitirAprovarSemPreview={
            ((emailAprovacaoModalTodo.proposta_payload as { tool?: string } | null)?.tool) ===
              "enviar_email_e_lancar_33_romaneio_interno"
          }
          onClose={() => setEmailAprovacaoModalTodo(null)}
          onConfirm={(extras) => {
            onApprove(emailAprovacaoModalTodo, extras);
            setEmailAprovacaoModalTodo(null);
          }}
          submitting={approving}
        />
      )}
      {combo4459ModalTodo && (
        <ModalCombo4459
          card={card}
          todo={combo4459ModalTodo}
          submitting={approving && approvingTodoId === combo4459ModalTodo.id}
          onClose={() => setCombo4459ModalTodo(null)}
          onConfirm={(extras) => {
            onApprove(combo4459ModalTodo, extras);
            setCombo4459ModalTodo(null);
          }}
        />
      )}
      {comboModalTodo && (
        <ModalCombo3344
          card={card}
          todo={comboModalTodo}
          submitting={approving && approvingTodoId === comboModalTodo.id}
          onClose={() => setComboModalTodo(null)}
          onConfirm={(extras) => {
            onApprove(comboModalTodo, extras);
            setComboModalTodo(null);
          }}
        />
      )}

      {oc33SoloModalTodo && (
        <ModalOc33Solo
          card={card}
          todo={oc33SoloModalTodo}
          submitting={approving && approvingTodoId === oc33SoloModalTodo.id}
          onClose={() => setOc33SoloModalTodo(null)}
          onConfirm={(extras) => {
            onApprove(oc33SoloModalTodo, extras);
            setOc33SoloModalTodo(null);
          }}
        />
      )}

      {emailOc33ModalTodo && (
        <ModalEmailEOc33
          card={card}
          todo={emailOc33ModalTodo}
          submitting={approving && approvingTodoId === emailOc33ModalTodo.id}
          onClose={() => setEmailOc33ModalTodo(null)}
          onConfirm={(extras) => {
            onApprove(emailOc33ModalTodo, extras);
            setEmailOc33ModalTodo(null);
          }}
        />
      )}

      {emailExtravioModalTodo && (
        <EditarEmailModal
          todoId={emailExtravioModalTodo.id}
          origemExtravio
          submitting={approving && approvingTodoId === emailExtravioModalTodo.id}
          onClose={() => setEmailExtravioModalTodo(null)}
          onConfirm={(extras) => {
            const t = emailExtravioModalTodo;
            setEmailExtravioModalTodo(null);
            onApprove(t, extras);
          }}
        />
      )}
    </div>
  );
}

/* ---------------- Composer manual de email para oc=54 ---------------- */

function ComposerEmail54({
  todoId,
  cardId,
  cardCodOc,
  propostaCodigoSsw,
  propostaOriginalEnviaEmail,
  templateSugeridoIA,
  extras,
  onChangeExtras,
}: {
  todoId: string;
  cardId: string;
  cardCodOc: number | null;
  propostaCodigoSsw: number;
  propostaOriginalEnviaEmail: boolean;
  templateSugeridoIA: string | null;
  extras: AprovarExtras;
  onChangeExtras: (patch: Partial<AprovarExtras>) => void;
}) {
  // Default do checkbox segue intenção da proposta original.
  // `lancar_oc_e_enviar_email` → MARCADO (skip_email=false).
  // `lancar_ocorrencia` (sem email) → DESMARCADO (skip_email=true).
  useEffect(() => {
    if (extras.skip_email === undefined) {
      onChangeExtras({ skip_email: !propostaOriginalEnviaEmail });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enviar = extras.skip_email === false;

  const { data: templatesAtivos = [] } = useTemplatesEmail();

  const { data: cardCtx, isLoading: loadingCard } = useQuery({
    queryKey: ["composer54-card-ctx", cardId],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("cards")
        .select("nf, agent_state")
        .eq("id", cardId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const cnpjPagador =
    (cardCtx?.agent_state as Record<string, unknown> | null)?.cnpj_pagador as
      | string
      | undefined;
  const cnpjLimpo = cnpjPagador?.replace(/\D/g, "") ?? null;
  const remetenteCru = remetenteCruDoAgentState(cardCtx?.agent_state);

  const { data: contatos, isLoading: loadingContatos } = useQuery({
    queryKey: ["contatos-email", cnpjLimpo, remetenteCru],

    enabled: !!cnpjLimpo && !!supabase,
    queryFn: async () => {
      if (!cnpjLimpo) return [];
      const { data, error } = await supabase!
        .from("contatos_cliente")
        .select("identificador, nome_pessoa, cargo, ordem, cnpj_remetente")
        .eq("documento_cliente", cnpjLimpo)
        .eq("tipo", "email")
        .eq("ativo", true)
        .order("cnpj_remetente", { ascending: false, nullsFirst: false })
        .order("ordem", { nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as {
        identificador: string;
        nome_pessoa: string | null;
        cargo: string | null;
        ordem: number | null;
        cnpj_remetente: string | null;
      }[];
    },
  });

  // Preview de template — popula assunto+corpo (e templates disponíveis)
  const [preview, setPreview] = useState<{
    template_atual: {
      id: string;
      nome: string;
      descricao: string;
      assunto_renderizado: string;
      corpo_renderizado: string;
    };
    templates_disponiveis: Array<{ id: string; nome: string; descricao: string }>;
    email_destino: string | null;
  } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const editouRef = useRef({ assunto: "", corpo: "" });

  async function carregarPreview(overrideId?: string) {
    if (!supabase) return null;
    setLoadingPreview(true);
    const { data, error } = await supabase.rpc("preview_email_todo", {
      p_todo_id: todoId,
      p_template_id_override: overrideId ?? null,
    });
    setLoadingPreview(false);
    if (error) {
      toast.error("Erro carregando template", { description: error.message });
      return null;
    }
    return data as any;
  }

  // Carrega preview quando o composer é aberto pela primeira vez (enviar=true)
  useEffect(() => {
    if (!enviar || preview) return;
    (async () => {
      // Se IA sugeriu template, já carrega o preview com ele aplicado
      const data = await carregarPreview(templateSugeridoIA ?? undefined);
      if (!data) return;
      setPreview(data);
      const patch: Partial<AprovarExtras> = {
        _template_original_id: data.template_atual.id,
        template_id_override: data.template_atual.id,
      };
      if (!extras.assunto_override) {
        patch.assunto_override = data.template_atual.assunto_renderizado;
      }
      if (!extras.texto_email_customizado) {
        patch.texto_email_customizado = data.template_atual.corpo_renderizado;
      }
      if (!extras.email_destinatarios && data.email_destino) {
        patch.email_destinatarios = [data.email_destino];
      }
      editouRef.current = {
        assunto: patch.assunto_override ?? extras.assunto_override ?? "",
        corpo: patch.texto_email_customizado ?? extras.texto_email_customizado ?? "",
      };
      onChangeExtras(patch);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enviar]);

  async function handleTrocarTemplate(novoId: string) {
    if (!preview) return;
    if (novoId === extras.template_id_override) return;
    const editou =
      (extras.assunto_override ?? "") !== editouRef.current.assunto ||
      (extras.texto_email_customizado ?? "") !== editouRef.current.corpo;
    if (editou) {
      const ok = window.confirm(
        "Trocar de template descarta as edições atuais. Continuar?",
      );
      if (!ok) return;
    }
    const data = await carregarPreview(novoId);
    if (!data) return;
    setPreview(data);
    const patch: Partial<AprovarExtras> = {
      template_id_override: novoId,
      assunto_override: data.template_atual.assunto_renderizado,
      texto_email_customizado: data.template_atual.corpo_renderizado,
    };
    editouRef.current = {
      assunto: data.template_atual.assunto_renderizado,
      corpo: data.template_atual.corpo_renderizado,
    };
    onChangeExtras(patch);
  }

  function toggleEnviar(novo: boolean) {
    onChangeExtras({
      skip_email: novo ? false : true,
      texto_email_customizado: novo ? extras.texto_email_customizado : undefined,
      email_destinatarios: novo ? extras.email_destinatarios : undefined,
      assunto_override: novo ? extras.assunto_override : undefined,
      template_id_override: novo ? extras.template_id_override : undefined,
    });
  }

  function toggleDestinatario(email: string) {
    const atual = extras.email_destinatarios ?? [];
    const novo = atual.includes(email)
      ? atual.filter((e) => e !== email)
      : [...atual, email];
    onChangeExtras({ email_destinatarios: novo });
  }

  const destSel = extras.email_destinatarios ?? [];

  return (
    <div className="space-y-2 border border-ink/15 bg-paper p-2.5">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={enviar}
          onChange={(e) => toggleEnviar(e.target.checked)}
          className="h-3.5 w-3.5 accent-sal"
        />
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink">
          enviar email pro cliente junto com o lançamento
        </span>
        {!enviar && (
          <span className="font-mono text-[9px] text-ink/40">
            (oc=54 sem email manual — opcional)
          </span>
        )}
      </label>

      {!enviar && propostaOriginalEnviaEmail && (
        <div className="border-l-2 border-orange-500 bg-orange-50 px-2 py-1.5 font-mono text-[10px] leading-snug text-orange-800">
          ⚠ Email NÃO será enviado. Vou apenas lançar a oc 54 no SSW.
        </div>
      )}

      {enviar && (
        <div className="space-y-2.5 border-t border-ink/10 pt-2.5">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                destinatários <span className="text-red-600">*</span>
              </span>
              <span className="font-mono text-[9px] text-ink/40">
                (1º = TO, demais = CC)
              </span>
            </div>
            {loadingCard || loadingContatos ? (
              <div className="font-mono text-[10px] text-ink/50">
                carregando contatos…
              </div>
            ) : !cnpjLimpo ? (
              <div className="border border-amber-300 bg-amber-50 px-2 py-1.5 font-mono text-[10px] text-amber-900">
                Sem CNPJ pagador no card — não dá pra carregar contatos.
              </div>
            ) : (contatos ?? []).length === 0 ? (
              <div className="border border-amber-300 bg-amber-50 px-2 py-1.5 font-mono text-[10px] text-amber-900">
                Nenhum email cadastrado pra esse cliente em contatos_cliente
                (CNPJ {cnpjLimpo}). Cadastre primeiro pra poder enviar.
              </div>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto border border-ink/15 bg-paper-deep/30 p-1.5">
                {(contatos ?? []).map((c) => {
                  const checked = destSel.includes(c.identificador);
                  return (
                    <label
                      key={c.identificador}
                      className="flex cursor-pointer items-start gap-2 px-1 py-0.5 hover:bg-ink/[0.04]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDestinatario(c.identificador)}
                        className="mt-0.5 h-3.5 w-3.5 accent-sal"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[11px] text-ink">
                          {c.identificador}
                        </div>
                        {(c.nome_pessoa || c.cargo || c.cnpj_remetente) && (
                          <div className="truncate font-mono text-[9px] text-ink/50">
                            {[c.cnpj_remetente ? "📌 contato deste remetente" : null, c.nome_pessoa, c.cargo].filter(Boolean).join(" • ")}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            {destSel.length > 0 && (
              <div className="mt-1 font-mono text-[9px] text-ink/50">
                {destSel.length} selecionado(s)
              </div>
            )}
          </div>

          {/* Template selector */}
          <div>
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              template <span className="text-red-600">*</span>
            </label>
            {loadingPreview && !preview ? (
              <div className="font-mono text-[10px] text-ink/50">carregando templates…</div>
            ) : preview ? (
              (() => {
                // Universal: TODOS os templates ativos em QUALQUER oc.
                // IA pode sugerir 1 (marcado com ⭐); operador escolhe livremente.
                const opcoes =
                  templatesAtivos.length > 0
                    ? templatesAtivos
                    : preview.templates_disponiveis;
                const valorAtual =
                  extras.template_id_override ?? preview.template_atual.id;
                const desabilitado = loadingPreview || opcoes.length <= 1;
                const sugeridoSet = new Set(
                  templateSugeridoIA ? [templateSugeridoIA] : [],
                );
                const opcoesOrdenadas = [
                  ...opcoes.filter((t) => sugeridoSet.has(t.id)),
                  ...opcoes.filter((t) => !sugeridoSet.has(t.id)),
                ];
                return (
                  <>
                    <select
                      value={valorAtual}
                      onChange={(e) => handleTrocarTemplate(e.target.value)}
                      disabled={desabilitado}
                      className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink disabled:opacity-60"
                    >
                      {opcoesOrdenadas.map((t) => (
                        <option key={t.id} value={t.id} title={t.descricao ?? ""}>
                          {sugeridoSet.has(t.id) ? "⭐ " : ""}
                          {t.nome} {sugeridoSet.has(t.id) ? "(sugerido pela IA)" : ""}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const t = opcoesOrdenadas.find((x) => x.id === valorAtual);
                      return t?.descricao ? (
                        <div className="mt-1 font-mono text-[10px] text-ink/50">{t.descricao}</div>
                      ) : null;
                    })()}
                  </>
                );
              })()
            ) : null}
          </div>

          {/* Assunto */}
          <div>
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              assunto <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              value={extras.assunto_override ?? ""}
              onChange={(e) => onChangeExtras({ assunto_override: e.target.value })}
              className="w-full border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-ink"
            />
          </div>

          {/* Nova thread (não seguir histórico) */}
          <label className="flex cursor-pointer items-start gap-2 border border-ink/15 bg-paper-deep/30 px-2 py-1.5">
            <input
              type="checkbox"
              checked={!!extras.nao_seguir_thread}
              onChange={(e) => onChangeExtras({ nao_seguir_thread: e.target.checked })}
              className="mt-0.5 h-3.5 w-3.5 accent-sal"
            />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[11px] text-ink">
                Enviar como novo e-mail (não seguir o histórico anterior da tratativa)
              </div>
              <div className="font-mono text-[9px] leading-snug text-ink/50">
                Por padrão, este e-mail continua a conversa anterior com o cliente sobre esta NF.
                Marque aqui só se for um assunto novo que deve começar um e-mail separado.
              </div>
            </div>
          </label>



          <div>
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              texto do email <span className="text-red-600">*</span>
              <span className="ml-1 normal-case text-ink/40">
                (use {"{link_evidencia}"} pra inserir link automático)
              </span>
            </label>
            <textarea
              value={extras.texto_email_customizado ?? ""}
              onChange={(e) =>
                onChangeExtras({ texto_email_customizado: e.target.value })
              }
              rows={12}
              maxLength={4000}
              className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-ink"
            />
            <div className="mt-0.5 flex justify-between font-mono text-[9px] text-ink/40">
              <span>obrigatório</span>
              <span>{(extras.texto_email_customizado ?? "").length}/4000</span>
            </div>
          </div>

          <div className="border-l-2 border-ink/30 bg-ink/[0.02] px-2 py-1.5 font-mono text-[10px] leading-snug text-ink/60">
            <strong className="text-ink/80">Como funciona:</strong> ao
            confirmar, lança a oc=54 no SSW e dispara o email pelo seu Gmail
            (mesma thread). O placeholder <code>{"{link_evidencia}"}</code>{" "}
            vira link Vercel automaticamente — não precisa colar nada manual.
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Cartão de proposta ---------------- */


function ProposalCard({
  todo,
  card,
  proposal,
  onApprove,
  approving,
  hideUniversalActions,
}: {
  todo: TodoRow;
  card: CardRow;
  proposal?: { agent: string; at: string };
  onApprove: (extras?: Record<string, unknown>) => void;
  approving: boolean;
  hideUniversalActions?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [showModal44, setShowModal44] = useState(false);
  const [showModalEmail, setShowModalEmail] = useState(false);
  const [showModalEmailOc33, setShowModalEmailOc33] = useState(false);
  // Auditoria 25/07: cards FORA de AVH (ex. AGUARDANDO_CLIENTE, 634 todos
  // oc33/combo pendentes) renderizam via ProposalCard, que não tinha as
  // janelas de anexos — aprovava às cegas e o executor revertia em loop.
  const [showModalOc33Solo, setShowModalOc33Solo] = useState(false);
  const [showModalCombo3344, setShowModalCombo3344] = useState(false);
  const [showModalCombo4459, setShowModalCombo4459] = useState(false);
  const qc = useQueryClient();

  const voltar = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error("Sem conexão");
      const { data, error } = await supabase.functions.invoke(
        "voltar-para-to-do-com-rastreio",
        { body: { todo_id: todo.id, motivo: null } },
      );
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Erro ao voltar pra to-do");
      return data as { ok: boolean; rastreio?: { mudou?: boolean; oc_real?: number }; new_state?: string };
    },
    onSuccess: (data) => {
      if (data?.rastreio?.mudou) {
        toast.success(
          `Voltou pra "Para Fazer". Rastreio detectou oc=${data.rastreio.oc_real} no SSW — card movido pra ${data.new_state}.`,
        );
      } else {
        toast.success('Voltou pra "Para Fazer".');
      }
      qc.invalidateQueries({ queryKey: ["cards"] });
      qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
      qc.invalidateQueries({ queryKey: ["card-events", card.id] });
    },
    onError: (err: any) =>
      toast.error("Não foi possível voltar", {
        description: err?.message ?? "Tente novamente",
      }),
  });

  const voltarCliente = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error("Sem conexão");
      const { error } = await supabase.rpc("marcar_retorno_inconclusivo", {
        p_card_id: card.id,
        p_motivo: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Voltou pra "Aguardando Cliente". Cobrança automática em 4 dias.');
      qc.invalidateQueries({ queryKey: ["cards"] });
      qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
      qc.invalidateQueries({ queryKey: ["card-events", card.id] });
      qc.invalidateQueries({ queryKey: ["acao-agendada", card.id] });
    },
    onError: (err: any) =>
      toast.error("Não foi possível voltar pro cliente", {
        description: err?.message ?? "Tente novamente",
      }),
  });

  const payload = (todo.proposta_payload ?? {}) as Record<string, unknown>;
  const args =
    payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : null;
  const tool = typeof payload.tool === "string" ? (payload.tool as string) : null;
  const texto = typeof payload.texto === "string" ? (payload.texto as string) : null;
  const rationale =
    typeof payload.rationale === "string" ? (payload.rationale as string) : null;

  const codigoSsw = args && typeof args.codigo_ssw !== "undefined" ? String(args.codigo_ssw) : null;
  const templateId = args && typeof args.template_id !== "undefined" ? String(args.template_id) : null;
  const propostaMeta = (payload as any)?.meta as Record<string, unknown> | undefined;
  const tinhaIntencaoEmail = propostaMeta?.tinha_intencao_email;
  const origemExtravio = propostaMeta?.origem === "extravio_cockpit";
  const propostaTemEmail =
    tinhaIntencaoEmail === false
      ? false
      : tinhaIntencaoEmail === true
        ? true
        : tool === "lancar_oc_e_enviar_email" || !!templateId;
  const acaoResumo = codigoSsw ? `Lançar oc ${codigoSsw} no SSW` : todo.descricao;
  const aprovarLabel = codigoSsw ? `Aprovar e lançar ${codigoSsw} →` : "Aprovar →";

  const veioDeAguardandoCliente =
    !hideUniversalActions &&
    card.state === "AGUARDANDO_VALIDACAO_HUMANA" &&
    card.cod_ultima_ocorrencia === 54;

  const busy = approving || voltar.isPending || voltarCliente.isPending;

  return (
    <li className="border border-ink/15 bg-paper p-4 transition-colors hover:border-ink/40">
      <div className="mb-3 flex items-baseline gap-2 truncate font-mono text-[10px] uppercase tracking-wider text-ink-soft">
        <span className="font-semibold text-ink">NF {card.nf ?? "—"}</span>
        <span className="text-ink/30">·</span>
        <span className="truncate">{card.empresa_cliente ?? "—"}</span>
        <span className="text-ink/30">·</span>
        <span>oc {card.cod_ultima_ocorrencia ?? "—"}</span>
      </div>

      {/* TODO_REMOVER_QUANDO_VALIDADO — badge IA recomendou oc=54+email */}
      {card.cod_ultima_ocorrencia === 13 &&
        (card as any).analise_oc13_resultado?.decisao === "sugerir_54_email" &&
        codigoSsw === "54" &&
        propostaTemEmail && (
          <div className="mb-2 inline-flex items-center gap-1 border border-emerald-400 bg-emerald-50 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-800">
            ⭐ Recomendado IA
          </div>
        )}

      {/* TODO_REMOVER_QUANDO_VALIDADO — badge IA ocs padrão (10/11/19/35) */}
      {[10, 11, 19, 35].includes(card.cod_ultima_ocorrencia ?? 0) &&
        (card as any).analise_padrao_resultado?.proposta_destacada != null &&
        ((((card as any).analise_padrao_resultado.proposta_destacada === 54 &&
          codigoSsw === "54" &&
          propostaTemEmail) ||
          ((card as any).analise_padrao_resultado.proposta_destacada === 56 &&
            codigoSsw === "56"))) && (
          <div className="mb-2 inline-flex items-center gap-1 border border-emerald-400 bg-emerald-50 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-800">
            ⭐ Recomendado IA
          </div>
        )}


      <div className="mb-4 font-display text-base leading-tight text-ink">
        {acaoResumo}
      </div>

      {texto && (
        <div className="mb-4 border-l-2 border-info bg-info/10 p-2">
          <div className="mb-1 font-mono text-[9px] font-bold uppercase tracking-widest text-info">
            Mensagem proposta
          </div>
          <div className="whitespace-pre-wrap font-display text-[13px] leading-relaxed text-ink">
            {texto}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => {
            // Fonte única de rotas (INV-050/053): toda ação com janela
            // própria abre a janela TAMBÉM aqui — nunca aprovar às cegas.
            const destino = decidirCliqueAprovacao(payload as Record<string, unknown>);
            if (destino === "modal-email-livre-oc33") setShowModalEmailOc33(true);
            else if (destino === "modal-oc33-solo") setShowModalOc33Solo(true);
            else if (destino === "modal-combo-3344") setShowModalCombo3344(true);
            else if (destino === "modal-combo-4459") setShowModalCombo4459(true);
            else if (codigoSsw === "44") setShowModal44(true);
            else if (propostaTemEmail) setShowModalEmail(true);
            else onApprove();
          }}
          disabled={busy}
          title={todo.descricao ?? "Executa a ação proposta"}
          className="bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
        >
          {approving ? "..." : aprovarLabel}
        </button>

        {!hideUniversalActions && (
          <button
            onClick={() => voltar.mutate()}
            disabled={busy}
            title="Destrava o card e volta pra aba PARA FAZER. Mantém as propostas disponíveis pra aprovação posterior."
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            {voltar.isPending ? "..." : "← Voltar p/ To-Do"}
          </button>
        )}

        {veioDeAguardandoCliente && (
          <button
            onClick={() => voltarCliente.mutate()}
            disabled={busy}
            title="Resposta do cliente foi inconclusiva. Reinicia ciclo de cobrança em 4 dias."
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            {voltarCliente.isPending ? "..." : "← Voltar p/ Aguardando Cliente"}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        className="mt-3 font-mono text-[9px] uppercase tracking-wider text-ink/40 transition-colors hover:text-ink"
      >
        {showDetails ? "▾ ocultar detalhes" : "▸ detalhes técnicos"}
      </button>

      {showDetails && (
        <div className="mt-2 space-y-1 border-t border-ink/10 pt-2 font-mono text-[10px] text-ink-soft">
          <div>
            <span className="text-ink/40">proposto por:</span>{" "}
            {proposal?.agent ?? todo.action_id} · {relativeTime(proposal?.at ?? todo.created_at)}
          </div>
          {tool && (
            <div>
              <span className="text-ink/40">tool:</span> {tool}
            </div>
          )}
          {rationale && (
            <div>
              <span className="text-ink/40">motivo:</span>{" "}
              <span className="italic">{rationale}</span>
            </div>
          )}
          {args &&
            Object.entries(args).map(([k, v]) => (
              <div key={k} className="break-all">
                <span className="text-ink/40">{k}:</span>{" "}
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </div>
            ))}
          <div className="pt-1">
            <pre className="whitespace-pre-wrap break-all border border-ink/10 bg-paper-deep p-2 text-[10px] text-ink">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {showModal44 && (
        <ModalAprovarOc44
          onClose={() => setShowModal44(false)}
          onConfirm={(extras) => {
            setShowModal44(false);
            onApprove(extras);
          }}
          submitting={approving}
        />
      )}

      {showModalOc33Solo && (
        <ModalOc33Solo
          card={card}
          todo={todo}
          submitting={approving}
          onClose={() => setShowModalOc33Solo(false)}
          onConfirm={(extras) => {
            setShowModalOc33Solo(false);
            onApprove(extras);
          }}
        />
      )}

      {showModalCombo3344 && (
        <ModalCombo3344
          card={card}
          todo={todo}
          submitting={approving}
          onClose={() => setShowModalCombo3344(false)}
          onConfirm={(extras) => {
            setShowModalCombo3344(false);
            onApprove(extras);
          }}
        />
      )}

      {showModalCombo4459 && (
        <ModalCombo4459
          card={card}
          todo={todo}
          submitting={approving}
          onClose={() => setShowModalCombo4459(false)}
          onConfirm={(extras) => {
            setShowModalCombo4459(false);
            onApprove(extras);
          }}
        />
      )}

      {showModalEmail && tool === "lancar_oc_e_enviar_email" ? (
        <EditarEmailModal
          todoId={todo.id}
          iaCorpoSugerido={
            [10, 11, 19, 35].includes(card.cod_ultima_ocorrencia ?? 0) &&
            (card as any).analise_padrao_resultado?.proposta_destacada === 54
              ? (card as any).analise_padrao_resultado?.corpo_email_sugerido ?? null
              : null
          }
          templateSugeridoIA={
            (card as any).analise_padrao_resultado?.template_email_sugerido ?? null
          }
          origemExtravio={origemExtravio}
          onClose={() => setShowModalEmail(false)}
          onConfirm={(extras) => {
            setShowModalEmail(false);
            onApprove(extras);
          }}
          submitting={approving}
        />

      ) : (
        showModalEmail && codigoSsw && (
          <ModalAprovarComEmail
            cardId={card.id}
            codigoSsw={Number(codigoSsw)}
            templateId={templateId ?? undefined}
            onClose={() => setShowModalEmail(false)}
            onConfirm={(extras) => {
              setShowModalEmail(false);
              onApprove(extras);
            }}
            submitting={approving}
          />
        )
      )}

      {showModalEmailOc33 && (
        <ModalEmailEOc33
          card={card}
          todo={todo}
          submitting={approving}
          onClose={() => setShowModalEmailOc33(false)}
          onConfirm={(extras) => {
            setShowModalEmailOc33(false);
            onApprove(extras);
          }}
        />
      )}
    </li>
  );
}

/* ---------------- Modal pré-aprovação oc=44 ---------------- */

export function ModalAprovarOc44({
  onClose,
  onConfirm,
  submitting,
  titulo,
}: {
  onClose: () => void;
  onConfirm: (extras: Record<string, unknown>) => void;
  submitting: boolean;
  titulo?: string;
}) {
  const [volumes, setVolumes] = useState("");
  const [motivo, setMotivo] = useState("");
  const [filial, setFilial] = useState("");

  // Backend exige volumes + motivo. Filial é opcional.
  const podeConfirmar = volumes.trim() !== "" && motivo.trim() !== "";


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
      <div className="w-full max-w-md border border-ink/20 bg-paper p-5">
        <div className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          📦 {titulo ?? "Aprovar e lançar oc 44 — retorno de carga"}
        </div>

        <p className="mb-4 text-sm text-ink/70">
          Preencha as informações abaixo. Vão junto na descrição da ocorrência
          no SSW pro setor de Devolução acessar.
        </p>

        <label className="mb-3 block">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            Quantidade de volumes
          </span>
          <input
            type="text"
            value={volumes}
            onChange={(e) => setVolumes(e.target.value)}
            placeholder="Ex: 5"
            autoFocus
            className="mt-1 w-full border border-ink/30 bg-paper px-3 py-2 text-ink outline-none focus:border-ink"
          />
        </label>

        <label className="mb-3 block">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            Motivo da devolução
          </span>
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ex: Cliente recusou — produto avariado"
            className="mt-1 w-full border border-ink/30 bg-paper px-3 py-2 text-ink outline-none focus:border-ink"
          />
        </label>

        <label className="mb-4 block">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            Filial onde está o volume <span className="normal-case text-ink-soft/70">(opcional)</span>
          </span>

          <input
            type="text"
            value={filial}
            onChange={(e) => setFilial(e.target.value)}
            placeholder="Ex: SAA, Pouso Alegre, Belo Horizonte..."
            className="mt-1 w-full border border-ink/30 bg-paper px-3 py-2 text-ink outline-none focus:border-ink"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              const extras: Record<string, unknown> = {
                quantidade_volumes: volumes.trim(),
                motivo: motivo.trim(),
              };
              if (filial.trim()) extras.filial = filial.trim();
              onConfirm(extras);
            }}

            disabled={!podeConfirmar || submitting}
            className="bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
          >
            {submitting ? "..." : "Confirmar e lançar 44 →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Modal pré-aprovação com email ---------------- */

function ModalAprovarComEmail({
  cardId,
  codigoSsw,
  templateId,
  onClose,
  onConfirm,
  submitting,
}: {
  cardId: string;
  codigoSsw: number;
  templateId?: string;
  onClose: () => void;
  onConfirm: (extras: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const [texto, setTexto] = useState("");
  const [assuntoSugerido, setAssuntoSugerido] = useState("");
  const [gerando, setGerando] = useState(false);

  async function handleGerarComIA() {
    if (!supabase) return;
    setGerando(true);
    const { data, error } = await supabase.functions.invoke("redator-email-saida", {
      body: { card_id: cardId, codigo_ssw_proposto: codigoSsw, template_id: templateId },
    });
    setGerando(false);
    if (error) {
      toast.error(error.message ?? "Erro ao gerar texto");
      return;
    }
    setTexto((data as any)?.texto ?? "");
    setAssuntoSugerido((data as any)?.assunto ?? "");
    toast.success("Texto gerado pela IA — edite à vontade.");
  }

  function handleConfirmarEnviar() {
    if (!texto.trim()) {
      toast.error("Texto vazio. Gera com IA ou escreve.");
      return;
    }
    onConfirm({ texto_email_customizado: texto.trim() });
  }

  function handleJaEnviadoManual() {
    if (
      !confirm(
        `Marcar email como já enviado manualmente? Sistema vai lançar oc ${codigoSsw} SEM disparar email.`,
      )
    )
      return;
    onConfirm({ skip_email: true });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto border border-ink/20 bg-paper p-5">
        <div className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          ✉️ Aprovar e lançar oc {codigoSsw} — com email pro cliente
          {templateId && <span className="ml-2 text-ink/40">template: {templateId}</span>}
        </div>
        <p className="mb-4 text-sm text-ink/70">
          Edite o texto abaixo e clique em <strong>Confirmar e enviar</strong>. Ou, se você já mandou
          o email manualmente pelo Gmail, clique em <strong>Email já enviado manual</strong> —
          sistema só lança a oc.
        </p>

        <div className="mb-3">
          <button
            onClick={handleGerarComIA}
            disabled={gerando || submitting}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            {gerando ? "Gerando..." : "✦ Gerar com IA"}
          </button>
          {assuntoSugerido && (
            <span className="ml-3 text-[11px] text-ink/50">
              Assunto sugerido: <em>{assuntoSugerido}</em>
            </span>
          )}
        </div>

        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={14}
          placeholder="Texto do email — clique 'Gerar com IA' pra preencher automaticamente, ou escreva direto."
          className="mb-4 w-full resize-y border border-ink/30 bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-ink"
        />

        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleJaEnviadoManual}
            disabled={submitting}
            title="Lança a oc sem enviar email automático (você já mandou pelo Gmail)"
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            ✓ Email já enviado manual
          </button>
          <button
            onClick={handleConfirmarEnviar}
            disabled={submitting || !texto.trim()}
            className="bg-sal px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
          >
            {submitting ? "..." : "📧 Confirmar e enviar email →"}
          </button>
        </div>
      </div>
    </div>
  );
          }

function HistorySection({ card }: { card: CardRow }) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["todos-historico", card.id],
    enabled: !!supabase && open,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("todos")
        .select("*")
        .eq("card_id", card.id)
        .neq("status", "pendente")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const todos = (data ?? []) as TodoRow[];
      const operatorIds = Array.from(
        new Set(todos.map((t) => t.approved_by).filter((v): v is string => !!v)),
      );
      const ops = operatorIds.length
        ? await supabase!
            .from("operadores")
            .select("id,nome")
            .in("id", operatorIds)
        : { data: [] as Pick<OperadorRow, "id" | "nome">[] };
      const map = new Map<string, string>();
      (ops.data ?? []).forEach((o: any) => map.set(o.id, o.nome));
      return { todos, names: map };
    },
  });

  // Realtime: status do todo move sozinho de aprovado → executando → executado
  useRealtimeInvalidate(
    "todos",
    ["todos-historico", card.id],
    `card_id=eq.${card.id}`,
  );

  return (
    <div className="border rounded-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-medium hover:bg-muted/40"
      >
        <span>Histórico de ações</span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="border-t">
          {!data || data.todos.length === 0 ? (
            <div className="p-3 text-[12px] text-muted-foreground">Nenhuma ação anterior.</div>
          ) : (
            <ul className="divide-y">
              {data.todos.map((t) => {
                const operatorName = t.approved_by
                  ? data.names.get(t.approved_by) ?? t.approved_by.slice(0, 8)
                  : null;
                return (
                  <li key={t.id} className="p-2.5 text-[12px]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex-1">{t.descricao}</span>
                      <StatusPill status={t.status} reason={t.rejection_reason} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      <StatusLine todo={t} operatorName={operatorName} />
                    </div>
                    {t.auto_approval_rule && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-800">
                        🤖 Regra: <span className="font-mono">{t.auto_approval_rule}</span>
                      </div>
                    )}
                    {t.rejection_reason && t.status === "rejeitado" && (
                      <div className="mt-1 text-[11px] italic text-muted-foreground">
                        Motivo: {t.rejection_reason}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function StatusLine({
  todo,
  operatorName,
}: {
  todo: TodoRow;
  operatorName: string | null;
}) {
  const when = todo.approved_at ?? todo.created_at;
  const fmt = (iso: string) =>
    format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR });

  switch (todo.status) {
    case "aprovado":
      return todo.auto_approval_rule ? (
        <>Aprovado automaticamente · {relativeTime(when)} · esperando executor</>
      ) : (
        <>
          Aprovado {operatorName ? `por ${operatorName}` : ""} · {relativeTime(when)} · esperando executor
        </>
      );
    case "executando":
      return <>Em execução no SSW · iniciado {relativeTime(when)}</>;
    case "executado":
      return <>✓ Confirmado via Bastão em {fmt(when)}</>;
    case "falhou":
      return <>Falhou · {relativeTime(when)}</>;
    case "rejeitado":
      return (
        <>
          Rejeitado {operatorName ? `por ${operatorName}` : ""} · {relativeTime(when)}
        </>
      );
    case "expirado":
      return <>Expirado · {relativeTime(when)}</>;
    default:
      return <>{relativeTime(when)}</>;
  }
}

function StatusPill({ status, reason }: { status: string; reason?: string | null }) {
  const map: Record<string, { cls: string; label: string; icon?: "spin" }> = {
    aprovado: {
      cls: "bg-blue-100 text-blue-700 border-blue-300",
      label: "Aprovado",
    },
    executando: {
      cls: "bg-blue-100 text-blue-800 border-blue-400",
      label: "Executando",
      icon: "spin",
    },
    executado: {
      cls: "bg-status-ok-soft text-status-ok border-status-ok/30",
      label: "✓ Executado",
    },
    falhou: {
      cls: "bg-status-block-soft text-status-block border-status-block/30",
      label: "Erro",
    },
    rejeitado: {
      cls: "bg-muted text-muted-foreground border-border",
      label: "Rejeitado",
    },
    expirado: {
      cls: "bg-muted text-muted-foreground border-border",
      label: "Expirado",
    },
  };
  const cfg = map[status] ?? {
    cls: "bg-muted text-muted-foreground border-border",
    label: status,
  };

  const pill = (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        cfg.cls,
      )}
    >
      {cfg.icon === "spin" && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {cfg.label}
    </span>
  );

  if (status === "falhou" && reason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{pill}</TooltipTrigger>
          <TooltipContent className="max-w-xs text-[11px]">{reason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return pill;
}

function ReentregaInputs21({
  cardId,
  iaSugestao,
  extras,
  onChange,
  uploading,
  setUploading,
  disabled,
}: {
  cardId: string;
  iaSugestao: {
    oc_sugerida?: number;
    instrucao_reentrega_sugerida?: string;
    cliente_autorizou_reentrega_sem_pagar?: boolean;
    motivo_cliente_recusa_pagar?: string;
  } | null;
  extras: AprovarExtras;
  onChange: (patch: Partial<AprovarExtras>) => void;
  uploading: boolean;
  setUploading: (v: boolean) => void;
  disabled?: boolean;
}) {
  const sugestaoIA =
    iaSugestao?.oc_sugerida === 21 && typeof iaSugestao?.instrucao_reentrega_sugerida === "string"
      ? iaSugestao.instrucao_reentrega_sugerida
      : "";
  const iaSugereCancelar = iaSugestao?.cliente_autorizou_reentrega_sem_pagar === true;
  const motivoIA = (iaSugestao?.motivo_cliente_recusa_pagar ?? "").trim();
  const [erro, setErro] = useState<string | null>(null);

  // Pré-preencher textarea com sugestão IA uma única vez
  useEffect(() => {
    if (extras._instrucao_prefill_aplicado) return;
    if (sugestaoIA && (extras.texto_descricao ?? "") === "") {
      onChange({ texto_descricao: sugestaoIA, _instrucao_prefill_aplicado: true });
    } else if (!extras._instrucao_prefill_aplicado) {
      onChange({ _instrucao_prefill_aplicado: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pré-marcar checkbox de cancelamento conforme sugestão IA (uma única vez)
  useEffect(() => {
    if (extras._cancel_prefill_aplicado) return;
    const patch: Partial<AprovarExtras> = { _cancel_prefill_aplicado: true };
    if (iaSugereCancelar) {
      patch.cancelar_reentrega_24h = true;
      if (motivoIA && !(extras.motivo_cancelamento ?? "").trim()) {
        patch.motivo_cancelamento = motivoIA;
      }
    }
    onChange(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  async function selecionarArquivo(file: File) {
    setErro(null);
    const mimesAceitos = ["image/jpeg", "image/jpg", "image/pjpeg", "application/pdf"];
    if (!mimesAceitos.includes(file.type)) {
      setErro("Apenas JPEG ou PDF são aceitos pelo SSW.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErro("Arquivo maior que 10MB.");
      return;
    }
    if (!supabase) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("card_id", cardId);
      const { data, error } = await supabase.functions.invoke("upload-anexo-email", {
        body: form,
      });
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error || "Falha no upload");
      onChange({
        anexo_id: data.anexo_id,
        anexo_filename: data.filename ?? file.name,
        anexo_size: data.size_bytes ?? file.size,
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function removerAnexo() {
    onChange({ anexo_id: null, anexo_filename: null, anexo_size: null });
  }

  const texto = extras.texto_descricao ?? "";
  const mostrarHintIA = !!sugestaoIA;

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
          instrução pra operação (opcional)
        </label>
        <textarea
          value={texto}
          onChange={(e) => onChange({ texto_descricao: e.target.value.slice(0, 250) })}
          rows={3}
          maxLength={250}
          placeholder="Ex: novo endereço, contato, melhor horário..."
          className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
        />
        <div className="mt-0.5 flex justify-between text-[9px] text-ink/40">
          <span className="italic">
            {mostrarHintIA ? "Sugerido pela IA. Edite ou apague se necessário." : "opcional • máx 250 caracteres"}
          </span>
          <span>{texto.length}/250</span>
        </div>
      </div>

      <div>
        <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
          imagem anexa (opcional) — vai SÓ pro SSW
        </label>
        <div className="border border-ink/20 bg-paper p-2 font-mono text-[11px]">
          {!extras.anexo_id ? (
            <label className="inline-flex cursor-pointer items-center gap-2 text-blue-700 hover:underline">
              <span>📎 {uploading ? "Enviando..." : "Adicionar imagem"}</span>
              <input
                type="file"
                accept="image/jpeg,image/jpg,application/pdf"
                className="hidden"
                disabled={uploading || disabled}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) selecionarArquivo(f);
                  e.target.value = "";
                }}
              />
            </label>
          ) : (
            <div className="flex items-center gap-2">
              <span>📎 {extras.anexo_filename}</span>
              {extras.anexo_size != null && (
                <span className="text-ink/50">({Math.round((extras.anexo_size ?? 0) / 1024)} KB)</span>
              )}
              <button
                type="button"
                onClick={removerAnexo}
                disabled={disabled}
                className="ml-2 text-red-600 hover:text-red-800 disabled:opacity-40"
              >
                ✕ remover
              </button>
            </div>
          )}
          <p className="mt-1 text-[9px] text-ink/40">JPEG ou PDF, máx 10MB.</p>
        </div>
        {erro && (
          <div className="mt-1 border border-red-300 bg-red-50 px-2 py-1 text-[10px] text-red-900">
            {erro}
          </div>
        )}
      </div>

      {/* ---- Cancelar reentrega 24h (SSW opção 450) ---- */}
      <div className="border-t border-ink/10 pt-3">
        {iaSugereCancelar && (
          <div className="mb-2 border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-[11px] text-indigo-900">
            <div className="font-mono text-[9px] uppercase tracking-wider text-indigo-700">
              💡 Sugestão IA
            </div>
            <div className="mt-0.5">Cliente autorizou reentrega mas se nega a pagar.</div>
            {motivoIA && (
              <div className="mt-0.5 italic text-indigo-800">"{motivoIA}"</div>
            )}
          </div>
        )}

        <label className="flex cursor-pointer items-start gap-2 font-mono text-[11px] text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={!!extras.cancelar_reentrega_24h}
            disabled={disabled}
            onChange={(e) => onChange({ cancelar_reentrega_24h: e.target.checked })}
          />
          <span>
            Cancelar reentrega automaticamente em 24h <span className="text-ink/50">(SSW opção 450)</span>
          </span>
        </label>
        <p className="mt-1 pl-6 text-[9px] text-ink/50">
          ℹ️ O sistema vai cancelar o CT-e de reentrega complementar que o SSW emitir em ~24h,
          usando seu login. Evita custo pra Sal quando o cliente não vai pagar a nova viagem.
        </p>

        {extras.cancelar_reentrega_24h && (
          <div className="mt-2 pl-6">
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              motivo (editável · max 65 chars · SSW limita)
            </label>
            <textarea
              value={extras.motivo_cancelamento ?? ""}
              onChange={(e) => onChange({ motivo_cancelamento: e.target.value.slice(0, 65) })}
              rows={3}
              maxLength={65}
              placeholder="PARA FINS DE ROMANEIO"
              disabled={disabled}
              className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
            />
            <div className="mt-0.5 text-right font-mono text-[9px] text-ink/40">
              {(extras.motivo_cancelamento ?? "").length}/65
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Modal Combo 33+44 (Ressarcimento) ---------------- */

interface InboundAnexoOpt {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string;
}

const TEXTO_MAX = 70;

function isImageMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png";
}
function isPdfMime(mime: string | null | undefined): boolean {
  return mime === "application/pdf";
}

/**
 * Uma página já convertida em JPEG (correção 08.09).
 *
 * `suspeita` = o guard reprovou por POUCA TINTA na faixa que pede olho humano
 * (0,5%–2%). A página vem junto, com prévia, pro operador decidir — antes a
 * conversão inteira era abortada e até as páginas boas iam pro lixo.
 */
interface PaginaConvertida {
  pdfFilename: string;
  pagina: number;
  file: File;
  suspeita: boolean;
  fracaoNaoBranca: number;
  /** dataURL da miniatura — só nas páginas suspeitas (as boas não precisam). */
  previewUrl: string | null;
}

/** Chave estável da decisão do operador sobre uma página. */
function chavePagina(p: { pdfFilename: string; pagina: number }): string {
  return `${p.pdfFilename}#${p.pagina}`;
}

async function convertPdfBlobToJpegFiles(
  pdfBlob: Blob,
  baseName: string,
  cardId?: string,
  operadorId?: string | null,
): Promise<PaginaConvertida[]> {
  // Use legacy build — modern build uses Uint8Array.prototype.toHex() (ES Stage 3),
  // unavailable in Chrome <140 / Safari <18.4 / Firefox <139. Legacy ships a polyfill.
  const pdfjsLib: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // @ts-ignore
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  const arrayBuf = await pdfBlob.arrayBuffer();
  // Auditoria 25/07 (NF 158084): o pdf.js 5.x decodifica JBIG2 via WASM e
  // exige wasmUrl — sem ele o decoder não inicializa ("Ensure that the
  // wasmUrl API parameter is provided") e a página sai em branco, disparando
  // o guard NF-135724 e forçando contorno manual. Assets em public/pdfjs-wasm/
  // (nomes SEM hash — o pdf.js busca `${wasmUrl}jbig2.wasm` literal); teste
  // pdfjs-wasm-sync garante espelho byte-a-byte com o pacote instalado.
  const wasmUrl = new URL("/pdfjs-wasm/", window.location.origin).href;
  const pdf = await pdfjsLib.getDocument({ data: arrayBuf, wasmUrl }).promise;
  const out: PaginaConvertida[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Guard (Caio 2026-07-17, NF 135724): pdf.js não decodifica a camada JBIG2
    // de PDFs escaneados e resolve o render como SUCESSO com página quase em
    // branco — foi assim que o romaneio da NF 135724 subiu quebrado pro SSW.
    // Hook no console.warn captura o sinal durante o render (sinal 1); o piso
    // de pixels pega o modo que falha calado (sinal 2). Ver pdfConversaoGuard.
    let warningPdfjs = false;
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (args.some((a) => typeof a === "string" && RE_WARNING_PDFJS_IMG.test(a))) {
        warningPdfjs = true;
      }
      origWarn.apply(console, args as Parameters<typeof console.warn>);
    };
    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
    } finally {
      console.warn = origWarn;
    }
    const veredito = avaliarPaginaConvertida(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      warningPdfjs,
    );
    const politica = veredito.quebrada && veredito.motivo
      ? politicaDaPagina(veredito.motivo, veredito.fracaoNaoBranca)
      : null;

    if (veredito.quebrada && veredito.motivo) {
      // Telemetria best-effort. Correção 08.09: o actor_id era a string
      // "front-conversao-pdf", mas a política RLS card_events_insert_operator
      // exige actor_id = current_operador_id() — TODO insert do front era
      // recusado e engolido pelo catch. Resultado: 2 eventos no banco, os dois
      // do servidor, ZERO do front. A ADR 0014 mandava contar bloqueios pra
      // decidir o conversor server-side e o contador nunca funcionou.
      if (cardId && operadorId) {
        try {
          await supabase.from("card_events").insert({
            card_id: cardId,
            event_type: "ConversaoPdfBloqueadaGuard",
            actor_type: "operator",
            actor_id: operadorId,
            payload: {
              origem: "front-conversao-pdf",
              filename: baseName,
              pagina: i,
              motivo: veredito.motivo,
              politica,
              fracao_nao_branca: Number(veredito.fracaoNaoBranca.toFixed(4)),
            },
          });
        } catch { /* telemetria nunca bloqueia */ }
      }
    }

    // Bloqueio duro: decodificador desistiu, ou folha praticamente sem tinta.
    // Só aqui a conversão do arquivo falha inteira — como antes.
    if (politica === "bloquear") {
      throw new Error(
        mensagemConversaoQuebrada(baseName, i, veredito.motivo!, veredito.fracaoNaoBranca),
      );
    }

    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.92),
    );
    const safeBase = baseName.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_");
    out.push({
      pdfFilename: baseName,
      pagina: i,
      file: new File([blob], `${safeBase}_p${i}.jpg`, { type: "image/jpeg" }),
      suspeita: politica === "confirmar",
      fracaoNaoBranca: veredito.fracaoNaoBranca,
      // Miniatura só da página que o operador precisa olhar (0,4 de qualidade
      // e meia escala: é pra bater o olho, não pra arquivar).
      previewUrl: politica === "confirmar" ? miniaturaDoCanvas(canvas) : null,
    });
  }
  return out;
}

type ResultadoConversaoPdfs =
  | { tipo: "erro" }
  | { tipo: "revisar"; pendentes: PaginaConvertida[] }
  | { tipo: "ok"; aprovadas: PaginaConvertida[] };

/**
 * Baixa e converte TODOS os PDFs selecionados ANTES de subir qualquer página
 * (correção 08.09). A ordem importa: se a pausa pra perguntar acontecesse no
 * meio do upload, as páginas do PDF anterior já teriam subido e o reenvio
 * duplicaria anexo no card. Aqui nada sobe até toda página ter decisão.
 *
 * `decisoes` é o que o operador já respondeu no painel de revisão
 * (chavePagina → incluir?). Página suspeita sem resposta volta em `pendentes`.
 *
 * `cache` evita reconverter no segundo clique (o do painel): a conversão é
 * determinística e client-side, então reaproveitar é seguro e poupa o
 * re-download do storage.
 */
async function converterPdfsSelecionados(args: {
  pdfs: InboundAnexoOpt[];
  cardId: string;
  operadorId: string | null;
  decisoes: Record<string, boolean>;
  cache: Map<string, PaginaConvertida[]>;
  setStatus: (s: string) => void;
}): Promise<ResultadoConversaoPdfs> {
  const { pdfs, cardId, operadorId, decisoes, cache, setStatus } = args;
  const todas: PaginaConvertida[] = [];

  for (const pdf of pdfs) {
    const doCache = cache.get(pdf.id);
    if (doCache) {
      todas.push(...doCache);
      continue;
    }

    // (a) baixar
    let blob: Blob;
    try {
      setStatus(`Baixando ${pdf.filename}...`);
      const { data: signed, error: signErr } = await supabase!.storage
        .from("email_anexos")
        .createSignedUrl(pdf.storage_path, 60);
      if (signErr || !signed?.signedUrl) {
        throw new Error(signErr?.message ?? "url inválida");
      }
      const resp = await fetch(signed.signedUrl);
      blob = await resp.blob();
    } catch (err) {
      toast.error(`Não consegui baixar "${pdf.filename}"`, {
        description: err instanceof Error ? err.message : String(err),
      });
      return { tipo: "erro" };
    }

    // (b) converter (pdf.js no browser)
    try {
      setStatus(`Convertendo ${pdf.filename} em JPEGs...`);
      const paginas = await convertPdfBlobToJpegFiles(blob, pdf.filename, cardId, operadorId);
      cache.set(pdf.id, paginas);
      todas.push(...paginas);
    } catch (err) {
      toast.error(`Falha ao converter "${pdf.filename}" em imagem`, {
        description: err instanceof Error ? err.message : String(err),
      });
      return { tipo: "erro" };
    }
  }

  const pendentes = todas.filter(
    (p) => p.suspeita && decisoes[chavePagina(p)] === undefined,
  );
  if (pendentes.length > 0) return { tipo: "revisar", pendentes };

  // Suspeita que o operador desmarcou não sobe; o resto vai.
  const aprovadas = todas.filter((p) => !p.suspeita || decisoes[chavePagina(p)] === true);
  return { tipo: "ok", aprovadas };
}

/**
 * Painel de revisão das páginas com pouca tinta (correção 08.09, INV-147).
 * O operador VÊ a página e decide — em vez de o sistema reprovar sozinho e
 * mandar "tire um print", que era o comportamento antigo mesmo quando o
 * documento estava perfeitamente legível.
 */
function PainelPaginasSuspeitas({
  pendentes,
  decisoes,
  onToggle,
  onCancelar,
  onContinuar,
  ocupado,
}: {
  pendentes: PaginaConvertida[];
  decisoes: Record<string, boolean>;
  onToggle: (chave: string) => void;
  onCancelar: () => void;
  onContinuar: () => void;
  ocupado: boolean;
}) {
  const marcadas = pendentes.filter((p) => decisoes[chavePagina(p)] === true).length;
  return (
    <div className="mb-4 border-2 border-sal bg-sal/5 p-3">
      <div className="mb-1 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-sal" />
        <h3 className="font-display text-[14px] font-semibold text-ink">
          Confira {pendentes.length === 1 ? "esta página" : "estas páginas"} antes de anexar
        </h3>
      </div>
      <p className="mb-3 font-mono text-[11px] leading-snug text-ink/70">
        Saíram com pouca tinta na conversão. Isso é comum em romaneio e minuta
        deitados — e quase sempre está tudo certo. Desmarque só o que estiver
        ilegível ou em branco.
      </p>
      <ul className="space-y-2">
        {pendentes.map((p) => {
          const chave = chavePagina(p);
          const incluir = decisoes[chave] === true;
          return (
            <li key={chave} className="flex gap-3 border border-ink/20 bg-paper p-2">
              {p.previewUrl ? (
                <a href={p.previewUrl} target="_blank" rel="noreferrer" className="shrink-0">
                  <img
                    src={p.previewUrl}
                    alt={`Prévia da página ${p.pagina} de ${p.pdfFilename}`}
                    className="h-28 w-auto border border-ink/20 bg-white object-contain"
                  />
                </a>
              ) : (
                <div className="flex h-28 w-20 shrink-0 items-center justify-center border border-ink/20 font-mono text-[10px] text-ink/50">
                  sem prévia
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] font-semibold text-ink">
                  {p.pdfFilename}
                </p>
                <p className="mt-0.5 font-mono text-[10px] leading-snug text-ink/60">
                  {mensagemPaginaSuspeita(p.pagina, p.fracaoNaoBranca)}
                </p>
                {p.previewUrl && (
                  <p className="mt-0.5 font-mono text-[10px] text-ink/40">
                    Clique na miniatura pra abrir em tamanho real.
                  </p>
                )}
                <label className="mt-1.5 flex cursor-pointer items-center gap-2 font-mono text-[11px] text-ink">
                  <input
                    type="checkbox"
                    checked={incluir}
                    onChange={() => onToggle(chave)}
                    className="h-3.5 w-3.5 accent-sal"
                  />
                  Anexar esta página
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancelar}
          disabled={ocupado}
          className="border border-ink px-3 py-1.5 font-mono text-[11px] uppercase text-ink disabled:opacity-50"
        >
          Voltar
        </button>
        <button
          type="button"
          onClick={onContinuar}
          disabled={ocupado}
          className="border-2 border-sal bg-sal px-3 py-1.5 font-mono text-[11px] font-semibold uppercase text-paper disabled:opacity-50"
        >
          {marcadas === 0
            ? "Continuar sem estas páginas"
            : `Anexar ${marcadas} e continuar`}
        </button>
      </div>
    </div>
  );
}

/** Miniatura leve pro painel de revisão — não vai pro SSW, é só pra olhar. */
function miniaturaDoCanvas(canvas: HTMLCanvasElement): string | null {
  try {
    const alvo = document.createElement("canvas");
    const escala = Math.min(1, 700 / Math.max(canvas.width, canvas.height));
    alvo.width = Math.max(1, Math.round(canvas.width * escala));
    alvo.height = Math.max(1, Math.round(canvas.height * escala));
    const ctx = alvo.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, alvo.width, alvo.height);
    ctx.drawImage(canvas, 0, 0, alvo.width, alvo.height);
    return alvo.toDataURL("image/jpeg", 0.6);
  } catch {
    return null; // sem prévia o painel ainda funciona (mostra só a medida)
  }
}

/**
 * Erro de upload com a mensagem REAL do backend (lida de error.context),
 * não a genérica "Edge Function returned a non-2xx status code" do supabase-js.
 */
class UploadAnexoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadAnexoError";
  }
}

async function uploadFileAsAnexo(
  file: File,
  cardId: string,
  todoId: string,
): Promise<AnexoUploaded> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("card_id", cardId);
  formData.append("todo_id", todoId);
  const { data, error } = await supabase!.functions.invoke("upload-anexo-email", {
    body: formData,
  });
  if (error) {
    // A causa real (ex.: "Tipo de arquivo não suportado", "Limite de N anexos...")
    // vem no corpo da resposta, não em error.message.
    let real = error.message;
    try {
      const body = await (error as any).context?.json?.();
      if (body?.error) real = body.error;
    } catch {
      /* corpo não-JSON: mantém fallback genérico */
    }
    throw new UploadAnexoError(real);
  }
  if (!data?.ok) throw new UploadAnexoError(data?.error || "Falha no upload");
  return {
    anexo_id: data.anexo_id,
    filename: data.filename,
    mime_type: data.mime_type,
    size_bytes: data.size_bytes,
  };
}

/* ---------------- Modal combo 44+59 (separação 54/59, Caio 2026-07-15) ----------------
 * Extravio parcial + cliente autorizou devolução + romaneio AINDA não veio.
 * Lança oc 44 PRIMEIRO (devolução do que permaneceu conosco — exige volumes/
 * motivo/filial, o executor rejeita sem eles) e depois oc 59 + e-mail com o
 * template EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO pedindo romaneio/descrição/
 * valor dos volumes extraviados. Diferente do 33+44: aqui NÃO há anexo de
 * romaneio (ele ainda não existe — o e-mail vai pedi-lo). */
function ModalCombo4459({
  card,
  todo,
  onClose,
  onConfirm,
  submitting,
}: {
  card: CardRow;
  todo: TodoRow;
  onClose: () => void;
  onConfirm: (extras: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const motivoCombo = card.ia_sugestao_oc_resposta?.motivo_combo ?? "";
  const emailDestino =
    ((todo.proposta_payload as any)?.args?.email_destino as string | null) ?? null;
  const [volumes, setVolumes] = useState("");
  const [motivo, setMotivo] = useState("");
  const [filial, setFilial] = useState("");
  const [emailManual, setEmailManual] = useState("");

  function handleConfirmar() {
    if (!volumes.trim() || !motivo.trim() || !filial.trim()) {
      toast.error("Preencha volumes, motivo e filial da oc=44.");
      return;
    }
    if (!emailDestino && !emailManual.trim()) {
      toast.error(
        "Cliente sem e-mail cadastrado — informe o e-mail que vai receber o pedido de romaneio.",
      );
      return;
    }
    const extras: Record<string, unknown> = {
      combo_44: {
        quantidade_volumes: volumes.trim(),
        motivo: motivo.trim(),
        filial: filial.trim(),
      },
    };
    if (!emailDestino && emailManual.trim()) {
      extras.email_destinatarios = [emailManual.trim()];
    }
    onConfirm(extras);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
      <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto border-2 border-ink bg-paper p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-display text-[18px] font-semibold text-ink">
            Lançar 44 + Lançar 59 (devolver + pedir romaneio)
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink disabled:opacity-40"
          >
            ✕ fechar
          </button>
        </div>

        {motivoCombo && (
          <div className="mb-3 border-l-2 border-purple-500 bg-purple-50/40 px-3 py-2 font-display text-[12px] italic text-ink/80">
            💡 IA sugere essa opção: {motivoCombo}
          </div>
        )}

        <div className="mb-3 border border-ink/15 bg-paper-deep/40 px-3 py-2 font-display text-[12px] leading-snug text-ink/80">
          <strong>Como funciona:</strong> primeiro a <strong>oc 44</strong> (devolução dos
          volumes que <em>permaneceram conosco</em>); em seguida a <strong>oc 59</strong> +
          e-mail ao cliente pedindo romaneio assinado, descrição e valor dos volumes{" "}
          <em>extraviados</em> (indenização). Se a oc 44 falhar, nada é lançado.
        </div>

        {/* Campos obrigatórios da oc 44 */}
        <div className="mb-3 space-y-2">
          <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            Dados da devolução (oc 44)
          </div>
          <input
            value={volumes}
            onChange={(e) => setVolumes(e.target.value)}
            disabled={submitting}
            placeholder="Quantidade de volumes a devolver (ex.: 3)"
            className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink disabled:opacity-60"
          />
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            disabled={submitting}
            placeholder="Motivo (ex.: extravio parcial — cliente autorizou devolução)"
            className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink disabled:opacity-60"
          />
          <input
            value={filial}
            onChange={(e) => setFilial(e.target.value)}
            disabled={submitting}
            placeholder="Filial (ex.: CTG)"
            className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink disabled:opacity-60"
          />
        </div>

        {/* E-mail do pedido de romaneio */}
        <div className="mb-4 space-y-1">
          <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            E-mail pedindo o romaneio (oc 59)
          </div>
          {emailDestino ? (
            <div className="font-display text-[12px] text-ink/80">
              Será enviado pra <strong>{emailDestino}</strong> com o template padrão de
              extravio parcial (pede romaneio + descrição + valor).
            </div>
          ) : (
            <input
              value={emailManual}
              onChange={(e) => setEmailManual(e.target.value)}
              disabled={submitting}
              placeholder="Cliente sem e-mail cadastrado — digite o e-mail do destinatário"
              className="w-full border border-orange-400 bg-orange-50/40 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink disabled:opacity-60"
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={submitting}
            className="bg-sal px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
          >
            {submitting ? "Lançando..." : "Aprovar e lançar 44 + 59 →"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalCombo3344({
  card,
  todo,
  onClose,
  onConfirm,
  submitting,
}: {
  card: CardRow;
  todo: TodoRow;
  onClose: () => void;
  onConfirm: (extras: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const motivoCombo = card.ia_sugestao_oc_resposta?.motivo_combo ?? "";
  const [texto33, setTexto33] = useState<string>(motivoCombo.slice(0, TEXTO_MAX));
  const [inboundSel, setInboundSel] = useState<Set<string>>(new Set());
  const [uploadAnexos, setUploadAnexos] = useState<AnexoUploaded[]>([]);
  const [uploading, setUploading] = useState(false);
  const [convertendo, setConvertendo] = useState(false);
  const [statusConv, setStatusConv] = useState<string>("");

  const [volumes, setVolumes] = useState("");
  const [motivo, setMotivo] = useState("");
  const [filial, setFilial] = useState("");

  // Revisão de páginas com pouca tinta (correção 08.09, INV-147).
  const { operador } = useAuth();
  const [paginasEmRevisao, setPaginasEmRevisao] = useState<PaginaConvertida[] | null>(null);
  const [decisoesPaginas, setDecisoesPaginas] = useState<Record<string, boolean>>({});
  const cacheConversaoRef = useRef(new Map<string, PaginaConvertida[]>());

  // Carregar anexos inbound do card
  const { data: anexosInbound = [] } = useQuery({
    queryKey: ["anexos-inbound-combo", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data: msgs } = await supabase!
        .from("messages_inbox")
        .select("id")
        .eq("card_id", card.id);
      const ids = (msgs ?? []).map((m: any) => m.id);
      if (!ids.length) return [] as InboundAnexoOpt[];
      const { data } = await supabase!
        .from("email_anexos")
        .select("id, filename, mime_type, size_bytes, storage_path")
        .in("message_inbox_id", ids)
        .eq("origem", "inbound")
        // Auditoria 25/07: anexo já ENVIADO é apagado do bucket
        // (finalizarAnexosPosEnvio marca deletado_em) — pré-selecionar um
        // deletado fazia aprovar→reverter em loop. Só oferece os vivos.
        .is("deletado_em", null);
      return (data ?? []) as InboundAnexoOpt[];
    },
  });

  // Pre-seleciona anexos: sugestão do AGENTE primeiro (onda 2 do veto, 25/08),
  // senão primeiro suportado (INV-045 — gif de assinatura nunca entra).
  useEffect(() => {
    if (anexosInbound.length > 0 && inboundSel.size === 0) {
      const ids = preSelecaoAnexos(anexosInbound, anexosSugeridosDoTodo(todo.proposta_payload));
      if (ids.length > 0) setInboundSel(new Set(ids));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anexosInbound]);

  function toggleInbound(id: string) {
    setInboundSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirmar() {
    if (!volumes.trim() || !motivo.trim() || !filial.trim()) {
      toast.error("Preencha volumes, motivo e filial da oc=44.");
      return;
    }

    const selecionados = anexosInbound.filter((a) => inboundSel.has(a.id));
    const finalIds: string[] = [];

    // 1) anexos inbound JPEG/PNG: usa direto
    const finalNomes: string[] = [];
    for (const a of selecionados) {
      if (isImageMime(a.mime_type)) { finalIds.push(a.id); finalNomes.push(a.filename); }
    }

    // 2) anexos inbound PDF: precisa converter pra JPEG via pdf.js + upload
    const pdfsParaConverter = selecionados.filter((a) => isPdfMime(a.mime_type));
    // 3) anexos não suportados (nem imagem nem PDF) → erro
    const naoSuportados = selecionados.filter(
      (a) => !isImageMime(a.mime_type) && !isPdfMime(a.mime_type),
    );
    if (naoSuportados.length > 0) {
      // INV-045 (NF 814961): não-suportado é IGNORADO, não muro — ele nem
      // entra mais na seleção; este filtro é cinto de segurança residual.
      console.warn(
        `[oc33] anexos não-suportados ignorados: ${naoSuportados.map((a) => a.filename).join(", ")}`,
      );
    }

    // 4) uploads manuais (já são imagens — AnexosUploader aceita vários tipos, mas pra SSW só vale imagem)
    for (const a of uploadAnexos) {
      if (!isImageMime(a.mime_type)) {
        toast.error(
          `Upload "${a.filename}" não é JPEG/PNG. SSW só aceita imagem.`,
        );
        return;
      }
      finalIds.push(a.anexo_id);
    }

    // Conversão dos PDFs (correção 08.09): converte TODOS antes de subir
    // qualquer página. Página com pouca tinta pausa o fluxo aqui e vai pro
    // painel de revisão — nada sobe até toda página ter decisão, e é por isso
    // que reenviar depois de revisar não duplica anexo no card.
    if (pdfsParaConverter.length > 0) {
      setConvertendo(true);
      const res = await converterPdfsSelecionados({
        pdfs: pdfsParaConverter,
        cardId: card.id,
        operadorId: operador?.id ?? null,
        decisoes: decisoesPaginas,
        cache: cacheConversaoRef.current,
        setStatus: setStatusConv,
      });
      if (res.tipo === "erro") {
        setConvertendo(false);
        setStatusConv("");
        return;
      }
      if (res.tipo === "revisar") {
        setConvertendo(false);
        setStatusConv("");
        // Pré-marca INCLUIR: falso positivo é a regra, não a exceção (2 de 2
        // bloqueios registrados eram página legível). O operador desmarca o
        // que de fato não serve.
        setDecisoesPaginas((prev) => {
          const next = { ...prev };
          for (const p of res.pendentes) {
            if (next[chavePagina(p)] === undefined) next[chavePagina(p)] = true;
          }
          return next;
        });
        setPaginasEmRevisao(res.pendentes);
        return;
      }
      setPaginasEmRevisao(null);

      // Upload só das páginas aprovadas (mensagem REAL do backend no erro)
      for (let i = 0; i < res.aprovadas.length; i++) {
        const pg = res.aprovadas[i]!;
        try {
          setStatusConv(`Subindo ${pg.file.name} (${i + 1}/${res.aprovadas.length})...`);
          const up = await uploadFileAsAnexo(pg.file, card.id, todo.id);
          finalIds.push(up.anexo_id);
          finalNomes.push(pg.file.name);
        } catch (err) {
          toast.error(`Não foi possível anexar "${pg.file.name}"`, {
            description: err instanceof Error ? err.message : String(err),
          });
          setConvertendo(false);
          setStatusConv("");
          return;
        }
      }
      setConvertendo(false);
      setStatusConv("");
    }

    // Guard do dossiê (auditoria 25/07, NF 158084): a oc 33 de completude
    // exige o ROMANEIO anexado — sem ele o executor reverte em loop
    // aprovar→reverter. Barra AQUI, nomeando o arquivo exigido.
    const romaneioExigido = romaneioExigidoDoCard(card);
    if (romaneioExigido && !anexosCobremRomaneio(finalNomes, romaneioExigido.filename)) {
      toast.error(`Anexe o romaneio do dossiê: "${romaneioExigido.filename}"`, {
        description:
          "A oc 33 de completude exige o romaneio anexado. Selecione-o na lista (PDF é convertido pra JPEG automaticamente) — sem ele o SSW reverte o lançamento.",
      });
      return;
    }

    const extras: Record<string, unknown> = {
      texto_descricao: texto33.trim(),
      anexos_ids: finalIds,
      combo_44: {
        quantidade_volumes: volumes.trim(),
        motivo: motivo.trim(),
        filial: filial.trim(),
      },
    };
    onConfirm(extras);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border-2 border-ink bg-paper p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-display text-[18px] font-semibold text-ink">
            Lançar 33 + Lançar 44 (Ressarcimento)
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink disabled:opacity-40"
          >
            ✕ fechar
          </button>
        </div>

        {(() => {
          const aviso = (todo.proposta_payload as any)?.aviso_romaneio_interno;
          return aviso ? (
            <div className="mb-3 flex items-start gap-2 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 font-mono text-[11px] leading-snug text-amber-900">
              <span className="shrink-0">⚠️</span>
              <span>{aviso}</span>
            </div>
          ) : null;
        })()}


        {motivoCombo && (
          <div className="mb-3 border-l-2 border-indigo-500 bg-indigo-50/40 px-3 py-2 font-display text-[12px] italic text-ink/80">
            💡 IA sugere essa opção: {motivoCombo}
          </div>
        )}

        {/* Parte 1 — oc=33 */}
        <div className="mb-4 border-t-2 border-ink pt-3">
          <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            Parte 1 — oc=33 (Reversão de perdas / Indenização)
          </div>

          <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
            Texto pra Operação (até {TEXTO_MAX} chars — SSW limita)
          </label>
          <textarea
            value={texto33}
            onChange={(e) => setTexto33(e.target.value.slice(0, TEXTO_MAX))}
            rows={2}
            maxLength={TEXTO_MAX}
            placeholder="Ex: Romaneio anexo, cliente autorizou devolução"
            className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
          />
          <div className="mt-0.5 text-right font-mono text-[9px] text-ink/40">
            {texto33.length}/{TEXTO_MAX}
          </div>

          <div className="mt-3">
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              Imagens pro SSW (JPEG/PNG — PDFs viram JPEG automaticamente){" "}
              <span className="text-red-600">*</span>
            </label>

            {anexosInbound.length > 0 ? (
              <div className="mb-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink/50">
                  anexos do cliente
                </div>
                <div className="max-h-40 space-y-0.5 overflow-y-auto border border-ink/15 bg-paper-deep/30 p-1.5">
                  {anexosInbound.map((a) => {
                    const checked = inboundSel.has(a.id);
                    const ehImg = isImageMime(a.mime_type);
                    const ehPdf = isPdfMime(a.mime_type);
                    const tipoLabel = ehImg
                      ? "🖼️"
                      : ehPdf
                        ? "📄 PDF → JPEG"
                        : "⚠ não suportado";
                    return (
                      <label
                        key={a.id}
                        className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-ink/[0.04]"
                      >
                        {ehImg || ehPdf ? (
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleInbound(a.id)}
                            className="accent-sal"
                          />
                        ) : (
                          // INV-045: não-suportado é INFORMATIVO — sem checkbox,
                          // impossível ficar preso nele (NF 814961).
                          <span className="w-[13px] text-center font-mono text-[10px] text-ink/30">·</span>
                        )}
                        <span className="font-mono text-[10px] text-ink/60">
                          {tipoLabel}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                          {a.filename}
                          {a.size_bytes != null && (
                            <span className="ml-1 text-ink/40">
                              ({a.size_bytes < 1024 * 1024
                                ? `${Math.round(a.size_bytes / 1024)} KB`
                                : `${(a.size_bytes / 1024 / 1024).toFixed(1)} MB`})
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mb-2 font-mono text-[10px] italic text-ink/40">
                (nenhum anexo do cliente disponível)
              </div>
            )}

            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink/50">
                ou suba mais imagens
              </div>
              <AnexosUploader
                cardId={card.id}
                todoId={todo.id}
                anexos={uploadAnexos}
                onChange={setUploadAnexos}
                uploading={uploading}
                setUploading={setUploading}
                disabled={submitting || convertendo}
                compact
              />
            </div>

            {convertendo && (
              <div className="mt-2 border border-indigo-300 bg-indigo-50 px-2 py-1.5 font-mono text-[10px] text-indigo-900">
                ⏳ {statusConv || "Processando..."}
              </div>
            )}
          </div>
        </div>

        {/* Parte 2 — oc=44 */}
        <div className="mb-4 border-t-2 border-ink pt-3">
          <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            Parte 2 — oc=44 (Retorno de carga / Devolução)
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                volumes <span className="text-red-600">*</span>
              </label>
              <input
                type="number"
                value={volumes}
                onChange={(e) => setVolumes(e.target.value)}
                className="w-full border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                motivo <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                className="w-full border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                filial <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                value={filial}
                onChange={(e) => setFilial(e.target.value)}
                placeholder="VGA, BHZ..."
                className="w-full border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
              />
            </div>
          </div>
        </div>

        <div className="mb-4 border border-yellow-500 bg-yellow-50 px-2.5 py-2 font-mono text-[10px] leading-snug text-yellow-900">
          ⚠ A oc=44 só é lançada SE a oc=33 for confirmada no SSW.
        </div>

        {inboundSel.size === 0 && uploadAnexos.length === 0 && (
          <div className="mb-3 border border-yellow-500 bg-yellow-50 px-2.5 py-2 font-mono text-[10px] leading-snug text-yellow-900">
            ⚠️ Você está lançando oc=33 sem imagem anexa.
            <br />
            Confirme que o caso não exige romaneio (ex: ressarcimento sem retorno físico).
          </div>
        )}

        {paginasEmRevisao && paginasEmRevisao.length > 0 && (
          <PainelPaginasSuspeitas
            pendentes={paginasEmRevisao}
            decisoes={decisoesPaginas}
            onToggle={(chave) =>
              setDecisoesPaginas((prev) => ({ ...prev, [chave]: !prev[chave] }))
            }
            onCancelar={() => {
              // Volta pra seleção: esquece as decisões pra o operador poder
              // trocar de anexo e ser perguntado de novo.
              setPaginasEmRevisao(null);
              setDecisoesPaginas({});
            }}
            onContinuar={() => {
              setPaginasEmRevisao(null);
              void handleConfirmar();
            }}
            ocupado={submitting || uploading || convertendo}
          />
        )}

        <div className="flex justify-end gap-2 border-t border-ink/15 pt-3">
          <button
            onClick={onClose}
            disabled={submitting || convertendo}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={submitting || uploading || convertendo || !!paginasEmRevisao}
            className="bg-sal px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper hover:bg-ink disabled:opacity-40"
          >
            {submitting
              ? "lançando..."
              : convertendo
                ? "preparando..."
                : "Confirmar lançar combo →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Modal oc 33 SOLO (sem 44) ---------------- */

function ModalOc33Solo({
  card,
  todo,
  onClose,
  onConfirm,
  submitting,
}: {
  card: CardRow;
  todo: TodoRow;
  onClose: () => void;
  onConfirm: (extras: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const sugestaoTexto =
    (todo.proposta_payload as any)?.args?.texto_descricao ??
    "Reversão de perdas iniciada. Cliente notificado.";
  const [texto, setTexto] = useState<string>(
    String(sugestaoTexto).slice(0, TEXTO_MAX),
  );
  const [inboundSel, setInboundSel] = useState<Set<string>>(new Set());
  const [uploadAnexos, setUploadAnexos] = useState<AnexoUploaded[]>([]);
  const [uploading, setUploading] = useState(false);
  const [convertendo, setConvertendo] = useState(false);
  const [statusConv, setStatusConv] = useState<string>("");

  // Revisão de páginas com pouca tinta (correção 08.09, INV-147).
  const { operador } = useAuth();
  const [paginasEmRevisao, setPaginasEmRevisao] = useState<PaginaConvertida[] | null>(null);
  const [decisoesPaginas, setDecisoesPaginas] = useState<Record<string, boolean>>({});
  const cacheConversaoRef = useRef(new Map<string, PaginaConvertida[]>());

  const { data: anexosInbound = [] } = useQuery({
    queryKey: ["anexos-inbound-oc33solo", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data: msgs } = await supabase!
        .from("messages_inbox")
        .select("id")
        .eq("card_id", card.id);
      const ids = (msgs ?? []).map((m: any) => m.id);
      if (!ids.length) return [] as InboundAnexoOpt[];
      const { data } = await supabase!
        .from("email_anexos")
        .select("id, filename, mime_type, size_bytes, storage_path")
        .in("message_inbox_id", ids)
        .eq("origem", "inbound")
        // Auditoria 25/07: anexo já ENVIADO é apagado do bucket
        // (finalizarAnexosPosEnvio marca deletado_em) — pré-selecionar um
        // deletado fazia aprovar→reverter em loop. Só oferece os vivos.
        .is("deletado_em", null);
      return (data ?? []) as InboundAnexoOpt[];
    },
  });

  useEffect(() => {
    // Sugestão do AGENTE primeiro (onda 2 do veto, 25/08); senão primeiro
    // suportado (Caio 2026-07-23, NF 814961, INV-045 — gif nunca entra).
    if (anexosInbound.length > 0 && inboundSel.size === 0) {
      const ids = preSelecaoAnexos(anexosInbound, anexosSugeridosDoTodo(todo.proposta_payload));
      if (ids.length > 0) setInboundSel(new Set(ids));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anexosInbound]);

  function toggleInbound(id: string) {
    setInboundSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirmar() {
    const selecionados = anexosInbound.filter((a) => inboundSel.has(a.id));
    const finalIds: string[] = [];

    const finalNomes: string[] = [];
    for (const a of selecionados) {
      if (isImageMime(a.mime_type)) { finalIds.push(a.id); finalNomes.push(a.filename); }
    }

    const pdfsParaConverter = selecionados.filter((a) => isPdfMime(a.mime_type));
    const naoSuportados = selecionados.filter(
      (a) => !isImageMime(a.mime_type) && !isPdfMime(a.mime_type),
    );
    if (naoSuportados.length > 0) {
      // INV-045 (NF 814961): não-suportado é IGNORADO, não muro — ele nem
      // entra mais na seleção; este filtro é cinto de segurança residual.
      console.warn(
        `[oc33] anexos não-suportados ignorados: ${naoSuportados.map((a) => a.filename).join(", ")}`,
      );
    }

    for (const a of uploadAnexos) {
      if (!isImageMime(a.mime_type)) {
        toast.error(
          `Upload "${a.filename}" não é JPEG/PNG. SSW só aceita imagem.`,
        );
        return;
      }
      finalIds.push(a.anexo_id);
      finalNomes.push(a.filename);
    }

    // Correção 08.09: mesma mecânica do modal 33+44 — converte tudo antes de
    // subir qualquer coisa, e página com pouca tinta vai pro painel de revisão
    // em vez de derrubar o PDF inteiro.
    if (pdfsParaConverter.length > 0) {
      setConvertendo(true);
      const res = await converterPdfsSelecionados({
        pdfs: pdfsParaConverter,
        cardId: card.id,
        operadorId: operador?.id ?? null,
        decisoes: decisoesPaginas,
        cache: cacheConversaoRef.current,
        setStatus: setStatusConv,
      });
      if (res.tipo === "erro") {
        setConvertendo(false);
        setStatusConv("");
        return;
      }
      if (res.tipo === "revisar") {
        setConvertendo(false);
        setStatusConv("");
        setDecisoesPaginas((prev) => {
          const next = { ...prev };
          for (const p of res.pendentes) {
            if (next[chavePagina(p)] === undefined) next[chavePagina(p)] = true;
          }
          return next;
        });
        setPaginasEmRevisao(res.pendentes);
        return;
      }
      setPaginasEmRevisao(null);

      for (let i = 0; i < res.aprovadas.length; i++) {
        const pg = res.aprovadas[i]!;
        try {
          setStatusConv(`Subindo ${pg.file.name} (${i + 1}/${res.aprovadas.length})...`);
          const up = await uploadFileAsAnexo(pg.file, card.id, todo.id);
          finalIds.push(up.anexo_id);
          finalNomes.push(pg.file.name);
        } catch (err) {
          toast.error(`Não foi possível anexar "${pg.file.name}"`, {
            description: err instanceof Error ? err.message : String(err),
          });
          setConvertendo(false);
          setStatusConv("");
          return;
        }
      }
      setConvertendo(false);
      setStatusConv("");
    }

    // Guard do dossiê (auditoria 25/07, NF 158084): a oc 33 de completude
    // exige o ROMANEIO anexado — sem ele o executor reverte em loop
    // aprovar→reverter. Barra AQUI, nomeando o arquivo exigido.
    const romaneioExigido = romaneioExigidoDoCard(card);
    if (romaneioExigido && !anexosCobremRomaneio(finalNomes, romaneioExigido.filename)) {
      toast.error(`Anexe o romaneio do dossiê: "${romaneioExigido.filename}"`, {
        description:
          "A oc 33 de completude exige o romaneio anexado. Selecione-o na lista (PDF é convertido pra JPEG automaticamente) — sem ele o SSW reverte o lançamento.",
      });
      return;
    }

    onConfirm({
      texto_descricao: texto.trim(),
      anexos_ids: finalIds,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border-2 border-ink bg-paper p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-display text-[18px] font-semibold text-ink">
            Lançar oc 33 — Reversão de Perdas (sem 44)
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink disabled:opacity-40"
          >
            ✕ fechar
          </button>
        </div>

        {(() => {
          const aviso = (todo.proposta_payload as any)?.aviso_romaneio_interno;
          return aviso ? (
            <div className="mb-3 flex items-start gap-2 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 font-mono text-[11px] leading-snug text-amber-900">
              <span className="shrink-0">⚠️</span>
              <span>{aviso}</span>
            </div>
          ) : null;
        })()}


        <div className="mb-3 border-l-2 border-ink/30 bg-ink/[0.03] px-3 py-2 font-mono text-[10px] leading-snug text-ink/70">
          Inicia processo de indenização sem encadear devolução (oc=44).
          Use quando o cliente NÃO autorizou devolução ou o volume será
          tratado por outro fluxo.
        </div>

        <div className="mb-4 border-t-2 border-ink pt-3">
          <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
            Texto pra Operação (até {TEXTO_MAX} chars — SSW limita)
          </label>
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value.slice(0, TEXTO_MAX))}
            rows={2}
            maxLength={TEXTO_MAX}
            placeholder="Ex: Reversão de perdas iniciada. Cliente notificado."
            className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
          />
          <div className="mt-0.5 text-right font-mono text-[9px] text-ink/40">
            {texto.length}/{TEXTO_MAX}
          </div>

          <div className="mt-3">
            <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              Imagens pro SSW (JPEG/PNG — PDFs viram JPEG automaticamente){" "}
              <span className="text-red-600">*</span>
            </label>

            {anexosInbound.length > 0 ? (
              <div className="mb-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink/50">
                  anexos do cliente
                </div>
                <div className="max-h-40 space-y-0.5 overflow-y-auto border border-ink/15 bg-paper-deep/30 p-1.5">
                  {anexosInbound.map((a) => {
                    const checked = inboundSel.has(a.id);
                    const ehImg = isImageMime(a.mime_type);
                    const ehPdf = isPdfMime(a.mime_type);
                    const tipoLabel = ehImg
                      ? "🖼️"
                      : ehPdf
                        ? "📄 PDF → JPEG"
                        : "⚠ não suportado";
                    return (
                      <label
                        key={a.id}
                        className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-ink/[0.04]"
                      >
                        {ehImg || ehPdf ? (
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleInbound(a.id)}
                            className="accent-sal"
                          />
                        ) : (
                          // INV-045: não-suportado é INFORMATIVO — sem checkbox,
                          // impossível ficar preso nele (NF 814961).
                          <span className="w-[13px] text-center font-mono text-[10px] text-ink/30">·</span>
                        )}
                        <span className="font-mono text-[10px] text-ink/60">
                          {tipoLabel}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                          {a.filename}
                          {a.size_bytes != null && (
                            <span className="ml-1 text-ink/40">
                              ({a.size_bytes < 1024 * 1024
                                ? `${Math.round(a.size_bytes / 1024)} KB`
                                : `${(a.size_bytes / 1024 / 1024).toFixed(1)} MB`})
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mb-2 font-mono text-[10px] italic text-ink/40">
                (nenhum anexo do cliente disponível)
              </div>
            )}

            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink/50">
                ou suba mais imagens
              </div>
              <AnexosUploader
                cardId={card.id}
                todoId={todo.id}
                anexos={uploadAnexos}
                onChange={setUploadAnexos}
                uploading={uploading}
                setUploading={setUploading}
                disabled={submitting || convertendo}
                compact
              />
            </div>

            {convertendo && (
              <div className="mt-2 border border-indigo-300 bg-indigo-50 px-2 py-1.5 font-mono text-[10px] text-indigo-900">
                ⏳ {statusConv || "Processando..."}
              </div>
            )}
          </div>
        </div>

        {inboundSel.size === 0 && uploadAnexos.length === 0 && (
          <div className="mb-3 border border-yellow-500 bg-yellow-50 px-2.5 py-2 font-mono text-[10px] leading-snug text-yellow-900">
            ⚠️ Você está lançando oc=33 sem imagem anexa.
            <br />
            Confirme que o caso não exige romaneio (ex: ressarcimento sem retorno físico).
          </div>
        )}

        {paginasEmRevisao && paginasEmRevisao.length > 0 && (
          <PainelPaginasSuspeitas
            pendentes={paginasEmRevisao}
            decisoes={decisoesPaginas}
            onToggle={(chave) =>
              setDecisoesPaginas((prev) => ({ ...prev, [chave]: !prev[chave] }))
            }
            onCancelar={() => {
              setPaginasEmRevisao(null);
              setDecisoesPaginas({});
            }}
            onContinuar={() => {
              setPaginasEmRevisao(null);
              void handleConfirmar();
            }}
            ocupado={submitting || uploading || convertendo}
          />
        )}

        <div className="flex justify-end gap-2 border-t border-ink/15 pt-3">
          <button
            onClick={onClose}
            disabled={submitting || convertendo}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={submitting || uploading || convertendo || !!paginasEmRevisao}
            className="bg-sal px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper hover:bg-ink disabled:opacity-40"
          >
            {submitting
              ? "lançando..."
              : convertendo
                ? "preparando..."
                : "Confirmar lançar oc 33 →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Modal Email + oc 33 (notificação ao cliente + reversão de perdas) ---------------- */

function ModalEmailEOc33({
  card,
  todo,
  onClose,
  onConfirm,
  submitting,
}: {
  card: CardRow;
  todo: TodoRow;
  onClose: () => void;
  onConfirm: (extras: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const pl = (todo.proposta_payload ?? {}) as any;
  const sugestaoAssunto: string =
    pl?.args?.email_subject ??
    `Notificação - NF ${card.nf ?? ""} - Reversão de perdas`;
  const sugestaoCorpo: string = pl?.args?.email_corpo ?? "";
  const sugestaoTexto33: string = pl?.args?.oc33_texto ?? "";

  // SEÇÃO 1 — EMAIL
  const [destinatariosTo, setDestinatariosTo] = useState<string[]>([]);
  const [destinatarioManual, setDestinatarioManual] = useState("");
  const [cc, setCc] = useState<string[]>([]);
  const [ccManual, setCcManual] = useState("");
  const [assunto, setAssunto] = useState(sugestaoAssunto);
  const [corpo, setCorpo] = useState(sugestaoCorpo);
  const [anexosEmail, setAnexosEmail] = useState<AnexoUploaded[]>([]);
  const [uploadingEmail, setUploadingEmail] = useState(false);
  const [naoSeguirThread, setNaoSeguirThread] = useState(false);


  // SEÇÃO 2 — oc 33
  const [texto33, setTexto33] = useState<string>(
    String(sugestaoTexto33).slice(0, TEXTO_MAX),
  );
  const [anexos33, setAnexos33] = useState<AnexoUploaded[]>([]);
  const [uploading33, setUploading33] = useState(false);

  const [secao1Aberta, setSecao1Aberta] = useState(true);
  const [secao2Aberta, setSecao2Aberta] = useState(true);

  // CNPJ pra buscar contatos
  const cnpjLimpo = useMemo(() => {
    const cnpj = (card.agent_state as Record<string, unknown> | null)
      ?.cnpj_pagador as string | undefined;
    return cnpj?.replace(/\D/g, "") ?? null;
  }, [card.agent_state]);
  const remetenteCru = remetenteCruDoAgentState(card.agent_state);

  const { data: contatos } = useQuery({
    queryKey: ["email-oc33-contatos", cnpjLimpo, remetenteCru],
    enabled: !!cnpjLimpo && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("contatos_cliente")
        .select("identificador, nome_pessoa, cargo, ordem, cnpj_remetente")
        .eq("documento_cliente", cnpjLimpo!)
        .eq("tipo", "email")
        .eq("ativo", true)
        .order("cnpj_remetente", { ascending: false, nullsFirst: false })
        .order("ordem", { nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as {
        identificador: string;
        nome_pessoa: string | null;
        cargo: string | null;
        ordem: number | null;
        cnpj_remetente: string | null;
      }[];
    },
  });

  const contatosLista = contatos ?? [];

  function toggleTo(email: string) {
    setDestinatariosTo((atual) =>
      atual.includes(email) ? atual.filter((e) => e !== email) : [...atual, email],
    );
  }
  function toggleCc(email: string) {
    setCc((atual) =>
      atual.includes(email) ? atual.filter((e) => e !== email) : [...atual, email],
    );
  }
  function adicionarManualTo() {
    const e = destinatarioManual.trim();
    if (!e) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      toast.error("Email inválido");
      return;
    }
    if (!destinatariosTo.includes(e)) setDestinatariosTo((d) => [...d, e]);
    setDestinatarioManual("");
  }
  function adicionarManualCc() {
    const e = ccManual.trim();
    if (!e) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      toast.error("Email inválido");
      return;
    }
    if (!cc.includes(e)) setCc((d) => [...d, e]);
    setCcManual("");
  }

  const podeEnviar =
    destinatariosTo.length > 0 &&
    !!assunto.trim() &&
    !!corpo.trim() &&
    !submitting &&
    !uploadingEmail &&
    !uploading33;

  function handleEnviar() {
    if (!podeEnviar) return;
    const extras: Record<string, unknown> = {
      email_destinatario: destinatariosTo[0],
      email_cc: [...destinatariosTo.slice(1), ...cc],
      email_subject: assunto.trim(),
      email_corpo: corpo,
      email_anexos_ids: anexosEmail.map((a) => a.anexo_id),
      oc33_texto: texto33.trim().slice(0, TEXTO_MAX),
      oc33_anexos_ids: anexos33.map((a) => a.anexo_id),
    };
    if (naoSeguirThread) {
      extras.nao_seguir_thread = true;
    }
    onConfirm(extras);

  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto border-2 border-ink bg-paper p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-display text-[18px] font-semibold text-ink">
            ✉ Email + oc 33 — Notificação + Reversão de Perdas
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink disabled:opacity-40"
          >
            ✕ fechar
          </button>
        </div>

        {(() => {
          const aviso = (todo.proposta_payload as any)?.aviso_romaneio_interno;
          return aviso ? (
            <div className="mb-3 flex items-start gap-2 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 font-mono text-[11px] leading-snug text-amber-900">
              <span className="shrink-0">⚠️</span>
              <span>{aviso}</span>
            </div>
          ) : null;
        })()}


        <div className="mb-3 border-l-4 border-yellow-500 bg-yellow-50 px-3 py-2 font-mono text-[11px] leading-snug text-yellow-900">
          ⚠️ Esta ação envia email pro cliente APENAS como notificação (não
          aguarda resposta) e lança oc=33 no SSW. Card vai pra "Ação Executada"
          (sai do INBOX). Diferente de "54+email" (que aguarda cliente).
        </div>

        {/* Seção 1 — EMAIL */}
        <div className="mb-3 border border-ink/30">
          <button
            type="button"
            onClick={() => setSecao1Aberta((v) => !v)}
            className="flex w-full items-center justify-between bg-ink/5 px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-wider text-ink hover:bg-ink/10"
          >
            <span>
              {secao1Aberta ? "▾" : "▸"} 1. Email de notificação{" "}
              <span className="text-red-600">*</span>
            </span>
            <span className="font-normal text-ink/50 normal-case">
              {destinatariosTo.length > 0 && assunto.trim() && corpo.trim()
                ? "✓ pronto"
                : "preencher"}
            </span>
          </button>

          {secao1Aberta && (
            <div className="space-y-3 p-3">
              {/* Para */}
              <div>
                <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Para <span className="text-red-600">*</span>
                </div>
                {contatosLista.length > 0 && (
                  <div className="max-h-32 space-y-0.5 overflow-y-auto border border-ink/15 bg-paper-deep/30 p-1.5">
                    {contatosLista.map((c) => {
                      const checked = destinatariosTo.includes(c.identificador);
                      return (
                        <label
                          key={`to-${c.identificador}`}
                          className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-ink/[0.04]"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTo(c.identificador)}
                            className="h-3.5 w-3.5 accent-sal"
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                            {c.identificador}
                            {(c.nome_pessoa || c.cargo || c.cnpj_remetente) && (
                              <span className="ml-1 text-ink/50">
                                ({[c.cnpj_remetente ? "📌 contato deste remetente" : null, c.nome_pessoa, c.cargo].filter(Boolean).join(" • ")})
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="mt-1 flex gap-1">
                  <input
                    type="email"
                    value={destinatarioManual}
                    onChange={(e) => setDestinatarioManual(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        adicionarManualTo();
                      }
                    }}
                    placeholder="adicionar email manual…"
                    className="flex-1 border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
                  />
                  <button
                    type="button"
                    onClick={adicionarManualTo}
                    className="border border-ink/30 bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
                  >
                    +
                  </button>
                </div>
                <div className="mt-0.5 font-mono text-[9px] text-ink/50">
                  {destinatariosTo.length} selecionado(s) — primeiro = TO, demais = CC
                </div>
              </div>

              {/* Cc */}
              <div>
                <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Cc (opcional)
                </div>
                {contatosLista.length > 0 && (
                  <div className="max-h-24 space-y-0.5 overflow-y-auto border border-ink/15 bg-paper-deep/30 p-1.5">
                    {contatosLista.map((c) => {
                      const checked = cc.includes(c.identificador);
                      return (
                        <label
                          key={`cc-${c.identificador}`}
                          className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-ink/[0.04]"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCc(c.identificador)}
                            className="h-3.5 w-3.5 accent-sal"
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                            {c.identificador}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="mt-1 flex gap-1">
                  <input
                    type="email"
                    value={ccManual}
                    onChange={(e) => setCcManual(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        adicionarManualCc();
                      }
                    }}
                    placeholder="adicionar cc manual…"
                    className="flex-1 border border-ink/30 bg-paper px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-ink"
                  />
                  <button
                    type="button"
                    onClick={adicionarManualCc}
                    className="border border-ink/30 bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Assunto */}
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Assunto <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={assunto}
                  onChange={(e) => setAssunto(e.target.value)}
                  disabled={submitting}
                  className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink"
                />
              </div>

              {/* Nova thread (não seguir histórico) */}
              <label className="flex cursor-pointer items-start gap-2 border border-ink/15 bg-paper-deep/30 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={naoSeguirThread}
                  onChange={(e) => setNaoSeguirThread(e.target.checked)}
                  disabled={submitting}
                  className="mt-0.5 h-3.5 w-3.5 accent-sal"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[11px] text-ink">
                    Enviar como novo e-mail (não seguir o histórico anterior da tratativa)
                  </div>
                  <div className="font-mono text-[9px] leading-snug text-ink/50">
                    Por padrão, este e-mail continua a conversa anterior com o cliente sobre esta NF.
                    Marque aqui só se for um assunto novo que deve começar um e-mail separado.
                  </div>
                </div>
              </label>



              {/* Corpo */}
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Corpo <span className="text-red-600">*</span>
                </label>
                <textarea
                  value={corpo}
                  onChange={(e) => setCorpo(e.target.value)}
                  rows={10}
                  disabled={submitting}
                  placeholder="Escreva o texto livre da notificação ao cliente…"
                  className="w-full resize-y border border-ink/30 bg-paper px-2 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-ink"
                />
              </div>

              {/* Anexos email */}
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Anexos do email (opcional)
                </label>
                <AnexosUploader
                  cardId={card.id}
                  todoId={todo.id}
                  anexos={anexosEmail}
                  onChange={setAnexosEmail}
                  uploading={uploadingEmail}
                  setUploading={setUploadingEmail}
                  disabled={submitting}
                  compact
                />
              </div>
            </div>
          )}
        </div>

        {/* Seção 2 — oc 33 */}
        <div className="mb-3 border border-ink/30">
          <button
            type="button"
            onClick={() => setSecao2Aberta((v) => !v)}
            className="flex w-full items-center justify-between bg-ink/5 px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-wider text-ink hover:bg-ink/10"
          >
            <span>{secao2Aberta ? "▾" : "▸"} 2. oc=33 no SSW</span>
            <span className="font-normal text-ink/50 normal-case">opcional</span>
          </button>

          {secao2Aberta && (
            <div className="space-y-3 p-3">
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Texto descrição (opcional, máx {TEXTO_MAX} chars — SSW limita)
                </label>
                <input
                  type="text"
                  value={texto33}
                  onChange={(e) => setTexto33(e.target.value.slice(0, TEXTO_MAX))}
                  maxLength={TEXTO_MAX}
                  disabled={submitting}
                  placeholder="Ex: Reversão de perdas — cliente notificado por email."
                  className="w-full border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
                />
                <div className="mt-0.5 text-right font-mono text-[9px] text-ink/40">
                  {texto33.length}/{TEXTO_MAX}
                </div>
              </div>

              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                  Imagens pro SSW (opcional — JPEG/PNG)
                </label>
                <AnexosUploader
                  cardId={card.id}
                  todoId={todo.id}
                  anexos={anexos33}
                  onChange={setAnexos33}
                  uploading={uploading33}
                  setUploading={setUploading33}
                  disabled={submitting}
                  compact
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-ink/15 pt-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleEnviar}
            disabled={!podeEnviar}
            className="bg-sal px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper hover:bg-ink disabled:opacity-40"
          >
            {submitting ? "enviando..." : "Enviar email + Lançar oc 33 →"}
          </button>
        </div>
      </div>
    </div>
  );
}



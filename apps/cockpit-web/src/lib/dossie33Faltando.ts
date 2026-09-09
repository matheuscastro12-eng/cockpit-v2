// =============================================================================
// dossie33Faltando — "o que falta pra oc 33 poder ser lançada", no card.
//
// Karol 2026-09-09 (NFs 350882 e 431734): o relato chegou como "o sistema não
// sugere a oc 33". A investigação mostrou o contrário — a 33 ESTÁ sugerida (os
// to-dos existem em `pendente` e aparecem na tela). O que trava é a EXECUÇÃO: o
// executor barra a 33 quando o dossiê de extravio parcial está incompleto
// ("Combo 33+44 bloqueado: extravio parcial sem romaneio no dossiê", com a flag
// `extravio_parcial_dossie_enabled` ligada). Medido nos dois cards:
//   NF 350882 → romaneio=false, descricao=true,  valor=true
//   NF 431734 → romaneio=true,  descricao=false, valor=false
// Mesmo portão, peça faltante diferente. E 162 cards abertos de 10 operadores
// estavam no mesmo estado (Karol 17, DUILIO 37, FELIPE 34) — não é dela.
//
// O bloqueio é DELIBERADO e não se toca: sem romaneio o SSW reverte a 33. O que
// faltava era o card DIZER isso. Antes, o motivo só aparecia depois de abrir o
// modal; a linha da 33 mostrava "LANÇAR →" como se estivesse pronta.
//
// ⚠ ESPELHO de `supabase/functions/_shared/extravio-parcial-dossie.ts`
//   (`ROTULO_EVIDENCIA`, `avaliarDossie`, `decidirGateOc33`, `classificarOc33`)
//   — mudar nos dois, como já manda `romaneio-cobertura.ts`. O teste
//   `dossie33Faltando.test.ts` LÊ o arquivo do backend e falha se os rótulos ou
//   as três checagens `presente` mudarem lá sem mudar aqui, pra este espelho não
//   virar detector descalibrado.
//
// Só LEITURA de `agent_state` já gravado. Não decide nada, não bloqueia nada —
// o gate real segue sendo o do executor.
// =============================================================================

/** Espelho de ROTULO_EVIDENCIA do backend. Ordem: romaneio → descrição → valor. */
export const ROTULO_EVIDENCIA_33 = {
  romaneio: "romaneio de coleta assinado",
  descricao: "descrição dos itens",
  valor: "valor dos itens",
} as const;

export interface FaltandoOc33 {
  /** true = o executor vai barrar esta 33 agora. */
  bloqueada: boolean;
  /** Rótulos humanos do que falta, na ordem romaneio→descrição→valor. */
  faltando: string[];
  natureza: "operacional" | "completude";
}

type DossieLido = {
  romaneio?: { presente?: boolean };
  descricao?: { presente?: boolean };
  valor?: { presente?: boolean };
};

/**
 * O que falta pra oc 33 deste card, ou `null` quando não se aplica (card sem
 * dossiê de extravio parcial). `null` significa "não sei / não é o caso" — a UI
 * não deve mostrar nada, NUNCA deve assumir "está liberado".
 *
 * `ehCombo` = a proposta é o combo 33+44 (tool `lancar_combo_33_44` ou
 * meta.tipo_acao `combo_33_44`), detecção que o ProposedActions já faz.
 *
 * Naturezas (ADR 0023, espelhadas do backend):
 *   - operacional: SÓ no combo 33+44 de Caso 2 (devolução/recusa) → exige só o
 *     romaneio, pra destravar a devolução física;
 *   - completude: todo o resto → exige as 3 evidências. É o fallback
 *     CONSERVADOR, igual ao backend: sem `caso === "2"` comprovado, trata como
 *     completude (nunca dá a 33 como liberada só com romaneio por engano).
 */
export function faltandoParaOc33(
  card: { agent_state?: Record<string, unknown> | null },
  opts: { ehCombo: boolean },
): FaltandoOc33 | null {
  const ep = card.agent_state?.["extravio_parcial"] as
    | { caso?: string | null; dossie?: DossieLido }
    | undefined
    | null;
  if (!ep || !ep.dossie) return null;

  const dossie = ep.dossie;
  const natureza: "operacional" | "completude" =
    opts.ehCombo && ep.caso === "2" ? "operacional" : "completude";

  if (natureza === "operacional") {
    const temRomaneio = dossie.romaneio?.presente === true;
    return {
      natureza,
      bloqueada: !temRomaneio,
      faltando: temRomaneio ? [] : [ROTULO_EVIDENCIA_33.romaneio],
    };
  }

  const faltando: string[] = [];
  if (dossie.romaneio?.presente !== true) faltando.push(ROTULO_EVIDENCIA_33.romaneio);
  if (dossie.descricao?.presente !== true) faltando.push(ROTULO_EVIDENCIA_33.descricao);
  if (dossie.valor?.presente !== true) faltando.push(ROTULO_EVIDENCIA_33.valor);
  return { natureza, bloqueada: faltando.length > 0, faltando };
}

/** Texto curto pra linha da ação. Vazio quando não há nada a dizer. */
export function textoFaltandoOc33(f: FaltandoOc33 | null): string {
  if (!f || !f.bloqueada || f.faltando.length === 0) return "";
  return `falta ${f.faltando.join(" + ")}`;
}

// Guard: menu pós-resposta mantém/revive o 59+email de indenização em extravio
// TOTAL escalado (Larissa 2026-08-05, NF 1102187). INV-062.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ehExtravioTotalPorTodos59,
  escolher59IndenizacaoParaReviver,
  TEMPLATE_INDENIZACAO_TOTAL,
  TEMPLATES_59_PEDIDO_DOCUMENTO,
  temPendenciaDocumento59,
} from "./propostas-pos-resposta-cliente.ts";

Deno.test("ehExtravioTotal: true só quando há todo 59+template de total", () => {
  assertEquals(ehExtravioTotalPorTodos59([]), false); // card normal → inerte
  assertEquals(ehExtravioTotalPorTodos59([{ id: "a", status: "cancelado" }]), true);
  assertEquals(ehExtravioTotalPorTodos59([{ id: "a", status: "pendente" }]), true);
});

Deno.test("reviver: escolhe o cancelado mais recente quando não há ativo", () => {
  // ordem: mais recente primeiro (query .order desc)
  const id = escolher59IndenizacaoParaReviver([
    { id: "novo", status: "cancelado" },
    { id: "velho", status: "cancelado" },
  ]);
  assertEquals(id, "novo");
});

Deno.test("reviver: NÃO revive se já há pendente (evita violar índice único)", () => {
  assertEquals(
    escolher59IndenizacaoParaReviver([
      { id: "p", status: "pendente" },
      { id: "c", status: "cancelado" },
    ]),
    null,
  );
});

Deno.test("reviver: NÃO revive se já há aprovado", () => {
  assertEquals(
    escolher59IndenizacaoParaReviver([{ id: "a", status: "aprovado" }]),
    null,
  );
});

Deno.test("reviver: nada a fazer sem todos 59 de total", () => {
  assertEquals(escolher59IndenizacaoParaReviver([]), null);
});

// =============================================================================
// INV-149 (Karol 2026-09-09, NF 75249) — PENDÊNCIA DE DOCUMENTO ≠ EXTRAVIO TOTAL.
//
// O 59 de um card PARCIAL com pedido de romaneio em aberto era cancelado como
// "obsoleto" pelo menu pós-resposta, porque a whitelist só perdoava extravio
// TOTAL. Caso âncora medido: NF 75249 (oc 19), 59 criado 03/09 22:01:31 e
// cancelado 22:07:07 pelo próprio menu.
// =============================================================================

Deno.test("INV-149: os 3 templates de PEDIR_ROMANEIO entram; notificação NÃO", () => {
  const set = new Set<string>(TEMPLATES_59_PEDIDO_DOCUMENTO);
  // dentro — pedem documento ao cliente
  assertEquals(set.has(TEMPLATE_INDENIZACAO_TOTAL), true);
  assertEquals(set.has("ENTREGUE_COM_FALTA_PEDIR_ROMANEIO"), true);
  assertEquals(set.has("EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO"), true);
  // fora — são notificação, não pedido de documento. Se entrarem, o menu passa
  // a oferecer 59 em card sem pendência documental (falso positivo).
  assertEquals(set.has("EXTRAVIO_PARCIAL"), false);
  assertEquals(set.has("RECUSA_TOTAL"), false);
  assertEquals(set.has("RECUSA_PARCIAL"), false);
  assertEquals(set.has("TENTATIVAS_ESGOTADAS"), false);
  assertEquals(set.size, 3);
});

Deno.test("INV-149: pendência de documento = existe 59 pendente/aprovado", () => {
  assertEquals(temPendenciaDocumento59([]), false);
  assertEquals(temPendenciaDocumento59([{ id: "a", status: "pendente" }]), true);
  assertEquals(temPendenciaDocumento59([{ id: "a", status: "aprovado" }]), true);
});

Deno.test("INV-149: SÓ PRESERVA, nunca ressuscita — cancelado não liga o sinal", () => {
  // Esta é a diferença central com ehExtravioTotalPorTodos59, que devolve true
  // para cancelado (porque a revivência PRECISA ver o cancelado pra ressuscitar).
  assertEquals(temPendenciaDocumento59([{ id: "a", status: "cancelado" }]), false);
  assertEquals(ehExtravioTotalPorTodos59([{ id: "a", status: "cancelado" }]), true);
  // e o escolhedor de revivência segue devolvendo o cancelado quando alimentado
  // com a lista de TOTAL — comportamento inalterado por esta correção.
  assertEquals(escolher59IndenizacaoParaReviver([{ id: "a", status: "cancelado" }]), "a");
});

Deno.test("INV-149: a ASSIMETRIA está cablada no fonte (revivência ≠ preservação)", async () => {
  const src = await Deno.readTextFile(
    new URL("./propostas-pos-resposta-cliente.ts", import.meta.url),
  );
  // a revivência (bloco 3b) tem de continuar gated pelo sinal ESTREITO
  assertEquals(src.includes("if (ehExtravioTotal) {"), true);
  assertEquals(src.includes("escolher59IndenizacaoParaReviver(todos59Total)"), true);
  // e a whitelist tem de usar o sinal LARGO
  assertEquals(src.includes("(pendenciaDoc59 && cod === 59 && !ehCombo4459)"), true);
  // se alguém trocar a whitelist de volta pro sinal estreito, o bug do Caso 1 volta
  assertEquals(src.includes("(ehExtravioTotal && cod === 59 && !ehCombo4459)"), false);
  // e a lista de TOTAL tem de sair de um FILTRO por template, não da query crua
  assertEquals(src.includes("templateDoTodo(t) === TEMPLATE_INDENIZACAO_TOTAL"), true);
});

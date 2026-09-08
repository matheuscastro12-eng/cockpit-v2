// =============================================================================
// GUARD INV-148 — na oc 13, VISIBILIDADE e AUTONOMIA são interruptores
// SEPARADOS (correção 08.09, ADR 0026).
//
// A classe de bug que este guard trava: `cliente_config_oc13` era UM
// interruptor pra duas coisas. Incluir um CNPJ pra o card APARECER na fila do
// operador ligava, no mesmo ato, um robô que lança oc 21 e cancela reentrega
// sem aprovação por card (23 execuções 100% autônomas e 1.379 oc 21 lançadas
// até 08/09), além de pôr a ação destacada numa janela de veto de 60min que
// pode disparar e-mail pro cliente.
//
// Isso contraria a regra do negócio (Carlos, 08/09): "o cliente sempre precisa
// ser notificado antes e somente com a autorização dele é possível seguir".
//
// Caso âncora: NF 1037746 / PRATI DONADUZZI — precisa APARECER pra Larissa e
// NÃO pode ter robô agindo.
//
// A separação é frágil por natureza: são dois consumidores da MESMA tabela em
// arquivos distantes. Um `.eq("ativo", true)` copiado do lugar errado reabre o
// buraco sem nenhum teste quebrar. Por isso o guard é sobre o CÓDIGO-FONTE.
//
// Rodar com: deno test --allow-read
// =============================================================================
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RAIZ = new URL("../../../", import.meta.url);

async function ler(caminho: string): Promise<string> {
  return await Deno.readTextFile(new URL(caminho, RAIZ));
}

/** Corta comentários de linha, pra não casar com a prosa das explicações. */
function semComentarios(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

Deno.test("INV-148: o agente autônomo da oc 13 lê autonomo_ativo", async () => {
  const src = semComentarios(await ler("supabase/functions/agente-oc13-autonomo/index.ts"));
  assertStringIncludes(
    src,
    "autonomo_ativo",
    "o agente-oc13-autonomo precisa consultar cliente_config_oc13.autonomo_ativo — " +
      "sem isso ele volta a agir em TODO cliente visível, inclusive nos que exigem " +
      "autorização do cliente antes (PRATI). Ver ADR 0026.",
  );
});

Deno.test("INV-148: o agente só age quando autonomo_ativo NÃO é false", async () => {
  const src = semComentarios(await ler("supabase/functions/agente-oc13-autonomo/index.ts"));
  // A comparação tem que ser contra `false` explicitamente: NULL significa
  // "como era antes da mig 385" (age), e um `=== true` cru desligaria os 15
  // clientes que hoje dependem do robô enquanto a mig 386 não roda.
  const temFiltro = /autonomo_ativo\s*!==\s*false/.test(src);
  assertEquals(
    temFiltro,
    true,
    "esperado filtro `autonomo_ativo !== false` no agente-oc13-autonomo. " +
      "`=== true` quebraria os 15 CNPJs com autonomia legítima antes da mig 386; " +
      "não filtrar reabre o INV-148.",
  );
});

Deno.test("INV-148: a VISIBILIDADE (sync-bastao) NÃO depende de autonomo_ativo", async () => {
  const src = semComentarios(await ler("supabase/functions/sync-bastao/index.ts"));
  // O sync decide se o card APARECE. Se ele passar a filtrar por
  // autonomo_ativo, cliente com robô desligado deixa de receber card — que é
  // exatamente o bug da NF 1037746, invertido.
  assertEquals(
    src.includes("autonomo_ativo"),
    false,
    "sync-bastao NÃO deve olhar autonomo_ativo: visibilidade é só `ativo`. " +
      "Filtrar aqui faria o cliente com robô desligado (PRATI) voltar a ficar " +
      "invisível pro operador — o bug original da NF 1037746.",
  );
});

Deno.test("INV-148: a 2ª query do Bastão (oc 13) segue puxando pelos CNPJs da exceção", async () => {
  const src = semComentarios(await ler("supabase/functions/_shared/bastao-client.ts"));
  assertStringIncludes(
    src,
    'params.set("cod_ultima_ocorrencia", "eq.13")',
    "a query dedicada da oc 13 é a ÚNICA porta pela qual essas pendências entram " +
      "no Cockpit (a 1ª query filtra pelo dicionário, onde 13 não está). Se ela " +
      "sair, nenhum cliente da exceção recebe card de oc 13.",
  );
  assertEquals(
    src.includes("autonomo_ativo"),
    false,
    "o bastao-client puxa por VISIBILIDADE; autonomia não é assunto dele.",
  );
});

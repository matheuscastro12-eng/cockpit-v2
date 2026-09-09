// INV-150 (Karol 2026-09-09) — o card DIZ o que falta pra oc 33, e o espelho
// não pode divergir do gate do backend.
// Rodar: npx vitest run src/lib/dossie33Faltando.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  faltandoParaOc33,
  ROTULO_EVIDENCIA_33,
  textoFaltandoOc33,
} from "./dossie33Faltando";

const cardCom = (dossie: unknown, caso: string | null = "1") => ({
  agent_state: { extravio_parcial: { caso, dossie } },
});

describe("faltandoParaOc33 — casos-âncora medidos em produção", () => {
  it("NF 350882: falta só o romaneio (descrição e valor chegaram)", () => {
    const f = faltandoParaOc33(
      cardCom({
        romaneio: { presente: false },
        descricao: { presente: true },
        valor: { presente: true },
      }),
      { ehCombo: false },
    );
    expect(f?.bloqueada).toBe(true);
    expect(f?.faltando).toEqual([ROTULO_EVIDENCIA_33.romaneio]);
    expect(textoFaltandoOc33(f)).toBe("falta romaneio de coleta assinado");
  });

  it("NF 431734: romaneio veio, faltam descrição e valor", () => {
    const f = faltandoParaOc33(
      cardCom({
        romaneio: { presente: true },
        descricao: { presente: false },
        valor: { presente: false },
      }),
      { ehCombo: false },
    );
    expect(f?.bloqueada).toBe(true);
    expect(f?.faltando).toEqual([
      ROTULO_EVIDENCIA_33.descricao,
      ROTULO_EVIDENCIA_33.valor,
    ]);
    expect(textoFaltandoOc33(f)).toBe("falta descrição dos itens + valor dos itens");
  });

  it("dossiê completo: não bloqueia e não diz nada", () => {
    const f = faltandoParaOc33(
      cardCom({
        romaneio: { presente: true },
        descricao: { presente: true },
        valor: { presente: true },
      }),
      { ehCombo: false },
    );
    expect(f?.bloqueada).toBe(false);
    expect(f?.faltando).toEqual([]);
    expect(textoFaltandoOc33(f)).toBe("");
  });
});

describe("faltandoParaOc33 — o que NÃO pode acontecer", () => {
  it("card sem dossiê devolve null (a UI não deve afirmar nada)", () => {
    expect(faltandoParaOc33({ agent_state: null }, { ehCombo: false })).toBeNull();
    expect(faltandoParaOc33({ agent_state: {} }, { ehCombo: false })).toBeNull();
    expect(
      faltandoParaOc33({ agent_state: { extravio_parcial: { caso: "1" } } }, { ehCombo: false }),
    ).toBeNull();
    // null NUNCA vira "liberado" no texto
    expect(textoFaltandoOc33(null)).toBe("");
  });

  it("combo 33+44 no Caso 2 é operacional: exige SÓ romaneio", () => {
    const f = faltandoParaOc33(
      cardCom(
        { romaneio: { presente: true }, descricao: { presente: false }, valor: { presente: false } },
        "2",
      ),
      { ehCombo: true },
    );
    expect(f?.natureza).toBe("operacional");
    expect(f?.bloqueada).toBe(false); // romaneio basta pra destravar a devolução
  });

  it("fallback CONSERVADOR: combo sem caso=2 comprovado é completude", () => {
    for (const caso of ["1", null, undefined as unknown as null, "x"]) {
      const f = faltandoParaOc33(
        cardCom(
          { romaneio: { presente: true }, descricao: { presente: false }, valor: { presente: false } },
          caso,
        ),
        { ehCombo: true },
      );
      expect(f?.natureza).toBe("completude");
      expect(f?.bloqueada).toBe(true); // não libera 33 só com romaneio por engano
    }
  });

  it("presente ausente/undefined conta como FALTANDO, não como presente", () => {
    const f = faltandoParaOc33(cardCom({}), { ehCombo: false });
    expect(f?.faltando).toEqual([
      ROTULO_EVIDENCIA_33.romaneio,
      ROTULO_EVIDENCIA_33.descricao,
      ROTULO_EVIDENCIA_33.valor,
    ]);
  });
});

// ---------------------------------------------------------------------------
// PARIDADE COM O BACKEND — este espelho não pode virar detector descalibrado.
// Lê o fonte do gate real e falha se os rótulos ou as três checagens mudarem lá
// sem mudarem aqui.
// ---------------------------------------------------------------------------
describe("INV-150: paridade com extravio-parcial-dossie.ts do backend", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../../supabase/functions/_shared/extravio-parcial-dossie.ts"),
    "utf-8",
  );

  it("os 3 rótulos são idênticos aos do backend", () => {
    expect(src).toContain(`romaneio: "${ROTULO_EVIDENCIA_33.romaneio}"`);
    expect(src).toContain(`descricao: "${ROTULO_EVIDENCIA_33.descricao}"`);
    expect(src).toContain(`valor: "${ROTULO_EVIDENCIA_33.valor}"`);
  });

  it("o backend segue avaliando as MESMAS 3 evidências por `presente`", () => {
    expect(src).toContain("if (!dossie.romaneio?.presente) faltando.push(ROTULO_EVIDENCIA.romaneio)");
    expect(src).toContain("if (!dossie.descricao?.presente) faltando.push(ROTULO_EVIDENCIA.descricao)");
    expect(src).toContain("if (!dossie.valor?.presente) faltando.push(ROTULO_EVIDENCIA.valor)");
  });

  it("a natureza operacional segue exigindo só romaneio, e só no combo de Caso 2", () => {
    expect(src).toContain('const temRomaneio = dossie.romaneio?.presente === true');
    expect(src).toContain('return ehCombo && caso === "2" ? "operacional" : "completude"');
  });
});

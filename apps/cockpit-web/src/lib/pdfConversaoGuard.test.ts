// Guard anti-regressão do caso âncora NF 135724 (2026-07-17): pdf.js "converte
// com sucesso" um scan JBIG2 e entrega página quase em branco. O guard tem que
// pegar (a) o warning do pdf.js e (b) a página quase branca SEM warning — os
// dois modos reais medidos (4/5 PDFs JBIG2 quebraram; 1 deles calado).
//
// Correção 08.09 (INV-147): o sinal (b) estava REPROVANDO conversão boa e
// derrubando o PDF inteiro. Os testes abaixo travam as DUAS direções: os falsos
// positivos medidos precisam virar "confirmar", e o único caso real de quebra
// silenciosa precisa continuar "bloquear".
import { describe, expect, it } from "vitest";
import {
  avaliarPaginaConvertida,
  mensagemConversaoQuebrada,
  mensagemPaginaSuspeita,
  PISO_PAGINA_SEM_TINTA,
  PISO_PIXELS_NAO_BRANCOS,
  politicaDaPagina,
  RE_WARNING_PDFJS_IMG,
} from "./pdfConversaoGuard";

/** Monta um ImageData.data RGBA com `fracaoEscura` dos pixels pretos. */
function rgba(totalPx: number, fracaoEscura: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(totalPx * 4).fill(255);
  const escuros = Math.floor(totalPx * fracaoEscura);
  for (let p = 0; p < escuros; p++) {
    data[p * 4] = 0;
    data[p * 4 + 1] = 0;
    data[p * 4 + 2] = 0;
  }
  return data;
}

describe("avaliarPaginaConvertida", () => {
  it("página quase branca SEM warning ⇒ quebrada (caso 'minuta assinada.pdf': 0,38%, calado)", () => {
    const v = avaliarPaginaConvertida(rgba(10_000, 0.004), false);
    expect(v.quebrada).toBe(true);
    expect(v.motivo).toBe("pagina_quase_branca");
  });

  it("warning do pdf.js ⇒ quebrada MESMO com muito conteúdo (caso doc assinado: 51,7% e fragmentado)", () => {
    const v = avaliarPaginaConvertida(rgba(10_000, 0.5), true);
    expect(v.quebrada).toBe(true);
    expect(v.motivo).toBe("warning_pdfjs");
  });

  it("página normal sem warning ⇒ passa (DANFE convertido da NF 135724 era ok)", () => {
    const v = avaliarPaginaConvertida(rgba(10_000, 0.08), false);
    expect(v.quebrada).toBe(false);
    expect(v.motivo).toBeNull();
  });

  it("limiar: exatamente no piso passa; abaixo do piso quebra", () => {
    expect(avaliarPaginaConvertida(rgba(10_000, PISO_PIXELS_NAO_BRANCOS), false).quebrada).toBe(false);
    expect(avaliarPaginaConvertida(rgba(10_000, PISO_PIXELS_NAO_BRANCOS / 2), false).quebrada).toBe(true);
  });

  it("o piso NÃO foi mexido na correção 08.09 — a mudança é de consequência, não de limiar", () => {
    expect(PISO_PIXELS_NAO_BRANCOS).toBe(0.02);
  });
});

describe("politicaDaPagina — INV-147 (correção 08.09)", () => {
  it("warning do pdf.js sempre BLOQUEIA (decodificador desistiu, não há o que conferir)", () => {
    expect(politicaDaPagina("warning_pdfjs", 0.5)).toBe("bloquear");
    expect(politicaDaPagina("warning_pdfjs", 0.0001)).toBe("bloquear");
  });

  it("ÂNCORA REAL — 10803714.pdf pág 2 (União Química/Larissa) vai pra CONFIRMAÇÃO", () => {
    // Página renderizada e inspecionada: Documento de Transporte legível, com
    // placa manuscrita SEM-7B68 e código de barras. Bloquear isso é o bug.
    // Medida nos DOIS motores: pdf.js (o do front) = 1,35% · PDFium = 1,37%.
    expect(politicaDaPagina("pagina_quase_branca", 0.0135)).toBe("confirmar");
    expect(politicaDaPagina("pagina_quase_branca", 0.0137)).toBe("confirmar");
  });

  it("ÂNCORA REAL — Lexmark pág 4 (AGV/Maria) vai pra CONFIRMAÇÃO", () => {
    // "AGENDAMENTOS / Coleta na AGV", placa e motorista à mão. Também legível.
    // pdf.js = 1,22% · PDFium = 1,23%.
    expect(politicaDaPagina("pagina_quase_branca", 0.0122)).toBe("confirmar");
    expect(politicaDaPagina("pagina_quase_branca", 0.0123)).toBe("confirmar");
  });

  it("ÂNCORA REAL — pág 1 do 10803714 (6,34% no pdf.js) passa direto, sem perguntar", () => {
    // Era ela que ia pro lixo junto com a pág 2 no comportamento antigo.
    const v = avaliarPaginaConvertida(rgba(10_000, 0.0634), false);
    expect(v.quebrada).toBe(false);
  });

  it("ÂNCORA REAL — decodificador JBIG2 DESLIGADO continua BLOQUEADO (0,42% e 0,10%)", () => {
    // Medido em 08/09 rodando o PRÓPRIO pdf.js sem conseguir carregar o wasm
    // ("Jbig2Error: JBig2 failed to initialize") sobre o 10803714.pdf real:
    // pág 1 = 0,42%, pág 2 = 0,10%. É a falha que o piso existe pra barrar —
    // se os assets de public/pdfjs-wasm/ pararem de ser servidos, nenhuma
    // página em branco chega como prévia pro operador aprovar no automático.
    expect(politicaDaPagina("pagina_quase_branca", 0.0042)).toBe("bloquear");
    expect(politicaDaPagina("pagina_quase_branca", 0.001)).toBe("bloquear");
  });

  it("ÂNCORA HISTÓRICA — 0,38% (minuta assinada, era pré-wasm) segue bloqueado", () => {
    // A ADR 0014 mediu isso em 17/07. NÃO reproduz mais: com o wasmUrl (25/07)
    // o mesmo arquivo renderiza 2,48% no pdf.js e passa. Mantido só como cinto.
    expect(politicaDaPagina("pagina_quase_branca", 0.0038)).toBe("bloquear");
  });

  it("folha totalmente branca continua BLOQUEADA", () => {
    expect(politicaDaPagina("pagina_quase_branca", 0)).toBe("bloquear");
  });

  it("o piso de 'sem tinta' fica ENTRE as duas classes MEDIDAS com o pdf.js", () => {
    // decodificador off: até 0,42% · conteúdo legítimo: a partir de 1,22%.
    // Se alguém mexer no piso, esta asserção denuncia.
    expect(PISO_PAGINA_SEM_TINTA).toBeGreaterThan(0.0042);
    expect(PISO_PAGINA_SEM_TINTA).toBeLessThan(0.0122);
  });

  it("limiar do piso sem tinta: exatamente no piso já pede confirmação", () => {
    expect(politicaDaPagina("pagina_quase_branca", PISO_PAGINA_SEM_TINTA)).toBe("confirmar");
    expect(politicaDaPagina("pagina_quase_branca", PISO_PAGINA_SEM_TINTA - 0.0001)).toBe("bloquear");
  });
});

describe("RE_WARNING_PDFJS_IMG", () => {
  it("casa o warning real do pdf.js (com e sem apóstrofo)", () => {
    expect(RE_WARNING_PDFJS_IMG.test("Warning: Dependent image isn't ready yet")).toBe(true);
    expect(RE_WARNING_PDFJS_IMG.test("Dependent image isnt ready yet")).toBe(true);
    expect(RE_WARNING_PDFJS_IMG.test("TextLayer task cancelled")).toBe(false);
  });
});

describe("mensagemConversaoQuebrada", () => {
  it("menciona arquivo, página e o contorno (print/foto)", () => {
    const msg = mensagemConversaoQuebrada("NF 135724.pdf", 1, "warning_pdfjs");
    expect(msg).toContain("NF 135724.pdf");
    expect(msg).toContain("Página 1");
    expect(msg).toContain("print/foto");
  });

  it("só culpa o JBIG2 quando o sinal foi o warning do pdf.js", () => {
    expect(mensagemConversaoQuebrada("a.pdf", 1, "warning_pdfjs")).toContain("JBIG2");
    // Correção 08.09: pouca tinta não é prova de JBIG2 — não afirmar o que não
    // foi verificado (o arquivo pode nem ser scan).
    expect(mensagemConversaoQuebrada("a.pdf", 2, "pagina_quase_branca", 0.001)).not.toContain("JBIG2");
  });

  it("no bloqueio por folha vazia, mostra a medida pro operador", () => {
    const msg = mensagemConversaoQuebrada("a.pdf", 2, "pagina_quase_branca", 0.0038);
    expect(msg).toContain("0,38%");
    expect(msg).toContain("print/foto");
  });
});

describe("mensagemPaginaSuspeita", () => {
  it("diz a página, a medida e que pode ser normal", () => {
    const msg = mensagemPaginaSuspeita(2, 0.0137);
    expect(msg).toContain("Página 2");
    expect(msg).toContain("1,37%");
    expect(msg.toLowerCase()).toContain("normal");
  });
});

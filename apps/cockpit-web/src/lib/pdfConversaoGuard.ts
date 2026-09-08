// =============================================================================
// Guard da conversão PDF→JPEG (Caio 2026-07-17, NF 135724; ADR 0014).
//
// pdf.js NÃO decodifica a camada JBIG2 de PDFs escaneados em modo "alta
// compressão" (MRC: fundo JPEG fraco + máscara JBIG2 com todo o texto preto) e
// ainda assim resolve o render como SUCESSO — a página sai quase em branco, só
// com o resíduo do fundo. Foi assim que a minuta da NF 135724 chegou quebrada
// no SSW. Medição 2026-07-17: ~6% dos PDFs inbound têm JBIG2; 4 de 5 testados
// quebraram de verdade — e um deles SEM warning nenhum no console.
//
// Por isso o veredito precisa de DOIS sinais (nenhum sozinho cobre tudo):
//   1. warning "Dependent image isn't ready yet" do pdf.js durante o render
//      (pegou 4/5 dos casos reais);
//   2. piso de pixels não-brancos — página que saiu quase sem tinta.
//
// -----------------------------------------------------------------------------
// REVISÃO 2026-09-08 (Carlos — correção 08.09, NF 1102170 / 1037746). O sinal 2
// estava REPROVANDO conversão boa, e reprovar derrubava o PDF inteiro.
//
// Medição nova, com PDFium (motor que decodifica JBIG2), nos arquivos reais:
//   • 10803714.pdf (União Química, Larissa) → pág 1 = 6,41% | pág 2 = 1,37%
//     A pág 2 foi renderizada e INSPECIONADA: "DOCUMENTO DE TRANSPORTE 10803714",
//     placa manuscrita SEM-7B68, data 22/07/26, código de barras. Legível.
//   • Scanned_from_a_Lexmark…pdf (AGV, Maria) → pág 4 = 1,23%, também legível
//     ("AGENDAMENTOS / Coleta na AGV", placa e motorista à mão).
//   • minuta assinada.pdf — o caso que quebra CALADO no pdf.js (0,38% medido em
//     17/07) → renderiza a **2,53%** no PDFium.
//   • NF 135724.pdf (caso âncora da ADR 0014) → 6,16% no PDFium.
//
// Conclusão: conteúdo legítimo (1,23% / 1,37%) e conversão quebrada (0,38%)
// ocupam a MESMA faixa estreita, e o mesmo arquivo quebrado renderiza a 2,53%
// quando o decodificador funciona. **Nenhum piso separa as duas classes com
// margem confiável** — por isso o piso NÃO foi mexido (segue 2%). O que muda é
// a CONSEQUÊNCIA de cada sinal:
//
//   sinal 1 (warning_pdfjs)     → BLOQUEIA. O decodificador falhou; não existe
//                                 página pra humano conferir. Igual a hoje.
//   sinal 2, folha SEM tinta    → BLOQUEIA. Abaixo de PISO_PAGINA_SEM_TINTA
//     (< 0,5%)                    (0,5%) fica o caso real que quebra calado
//                                 (`minuta assinada.pdf`, 0,38%). Continua
//                                 barrado — nada regride aqui.
//   sinal 2, faixa 0,5%–2%      → PEDE CONFIRMAÇÃO. É onde vivem os dois falsos
//                                 positivos medidos (1,23% e 1,37%). A página
//                                 existe e provavelmente está ótima; o operador
//                                 vê a prévia e decide.
//
// Por que 0,5% é seguro escolher, mesmo com n=1 na classe "quebrada": esse
// corte NÃO separa "barrar" de "aceitar calado" — separa "barrar" de "perguntar
// pro humano". Se algum dia uma página quebrada cair na faixa 0,5–2%, ela chega
// como prévia em branco na tela do operador, que descarta. O erro é visível.
//
// Assimetria DELIBERADA com o servidor: `_shared/pdf-conversao-guard.ts` roda
// sem humano na frente (conversão autônoma do romaneio) e por isso mantém o
// piso como BLOQUEIO DURO. Mesmo limiar, política diferente — de propósito.
// =============================================================================

/** Fração mínima de pixels não-brancos pra considerar a página válida. */
export const PISO_PIXELS_NAO_BRANCOS = 0.02;

/**
 * Correção 08.09: abaixo disso a folha está praticamente sem tinta e segue
 * BLOQUEADA sem perguntar nada. Calibrado no único caso real de conversão
 * quebrada silenciosa que temos medido: `minuta assinada.pdf` = 0,38%
 * (o mesmo arquivo renderiza 2,53% no PDFium, que decodifica JBIG2).
 * Os falsos positivos medidos (1,23% e 1,37%) ficam ACIMA deste piso.
 */
export const PISO_PAGINA_SEM_TINTA = 0.005;

/** Warning que o pdf.js emite quando desiste de desenhar uma imagem dependente. */
export const RE_WARNING_PDFJS_IMG = /dependent image isn'?t ready/i;

export type MotivoConversaoQuebrada = "warning_pdfjs" | "pagina_quase_branca";

export interface VereditoConversaoPagina {
  quebrada: boolean;
  motivo: MotivoConversaoQuebrada | null;
  /** Fração (0..1) de pixels não-brancos medida no canvas. */
  fracaoNaoBranca: number;
}

/**
 * Avalia UMA página convertida. `data` é o ImageData.data (RGBA) do canvas já
 * renderizado; `warningDisparou` vem do hook de console.warn durante o render.
 * Pura — testável sem canvas real.
 */
export function avaliarPaginaConvertida(
  data: Uint8ClampedArray,
  warningDisparou: boolean,
  piso: number = PISO_PIXELS_NAO_BRANCOS,
): VereditoConversaoPagina {
  let naoBrancos = 0;
  const totalPx = Math.floor(data.length / 4);
  for (let i = 0; i + 2 < data.length; i += 4) {
    const r = data[i] ?? 255;
    const g = data[i + 1] ?? 255;
    const b = data[i + 2] ?? 255;
    if (r < 200 || g < 200 || b < 200) naoBrancos++;
  }
  const fracao = totalPx > 0 ? naoBrancos / totalPx : 0;
  if (warningDisparou) {
    return { quebrada: true, motivo: "warning_pdfjs", fracaoNaoBranca: fracao };
  }
  if (fracao < piso) {
    return { quebrada: true, motivo: "pagina_quase_branca", fracaoNaoBranca: fracao };
  }
  return { quebrada: false, motivo: null, fracaoNaoBranca: fracao };
}

/**
 * O que fazer com a página reprovada (correção 08.09).
 *
 * `bloquear`  → nem oferece; o render falhou (ou a folha está sem tinta
 *               nenhuma) e não há o que um humano possa conferir.
 * `confirmar` → mostra a prévia e deixa o operador decidir se sobe.
 *
 * Pouca tinta, por si só, NÃO é prova de conversão perdida — ver medições no
 * topo do arquivo.
 */
export function politicaDaPagina(
  motivo: MotivoConversaoQuebrada,
  fracaoNaoBranca: number,
  pisoSemTinta: number = PISO_PAGINA_SEM_TINTA,
): "bloquear" | "confirmar" {
  if (motivo === "warning_pdfjs") return "bloquear";
  return fracaoNaoBranca < pisoSemTinta ? "bloquear" : "confirmar";
}

/**
 * Mensagem do BLOQUEIO (toast). Só é usada quando `politicaDaPagina` disse
 * `bloquear` — página que vai pro painel de revisão não passa por aqui.
 */
export function mensagemConversaoQuebrada(
  filename: string,
  pagina: number,
  motivo: MotivoConversaoQuebrada,
  fracaoNaoBranca?: number,
): string {
  if (motivo === "warning_pdfjs") {
    return `Página ${pagina} de "${filename}" perdeu o conteúdo na conversão ` +
      "(o conversor não decodificou a camada de texto do scan). " +
      "Esse PDF é um scan em formato incompatível (JBIG2). " +
      "Contorno: tire um print/foto do documento e anexe como imagem JPEG.";
  }
  // Correção 08.09: aqui só chega folha praticamente sem tinta (< 0,5%). NÃO
  // culpar o JBIG2 sem prova — o que sabemos é que a página saiu vazia.
  const medida = fracaoNaoBranca == null
    ? ""
    : ` (só ${(fracaoNaoBranca * 100).toFixed(2).replace(".", ",")}% da folha tem tinta)`;
  return `Página ${pagina} de "${filename}" saiu praticamente em branco${medida}. ` +
    "A conversão se perdeu. " +
    "Contorno: tire um print/foto do documento e anexe como imagem JPEG.";
}

/**
 * Texto curto do painel de revisão, com o número medido — o operador enxerga
 * por que aquela página foi sinalizada.
 */
export function mensagemPaginaSuspeita(
  pagina: number,
  fracaoNaoBranca: number,
): string {
  const pct = (fracaoNaoBranca * 100).toFixed(2).replace(".", ",");
  return `Página ${pagina}: só ${pct}% da folha tem tinta. ` +
    "Pode ser normal (documento deitado, muito espaço em branco) ou conversão perdida.";
}

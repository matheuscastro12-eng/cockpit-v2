// Guard NF-135724 no SERVIDOR (Caio 26/08 — PDF sempre converte, mas página
// quase em branco NUNCA sobe pro SSW). Mesmo limiar do front (0.02).
// Rodar: deno test supabase/functions/_shared/pdf-conversao-guard.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { avaliarPaginaServidor, PISO_PIXELS_NAO_BRANCOS } from "./pdf-conversao-guard.ts";

function pagina(fracaoEscura: number, totalPx = 1000): Uint8Array {
  const d = new Uint8Array(totalPx * 4).fill(255);
  const escuros = Math.round(totalPx * fracaoEscura);
  for (let p = 0; p < escuros; p++) d[p * 4] = 0; // r<200 basta
  return d;
}

Deno.test("mesmo limiar do front (paridade 0.02) — mudou lá, muda cá", () => {
  assertEquals(PISO_PIXELS_NAO_BRANCOS, 0.02);
});

Deno.test("página com conteúdo real passa (DANFE Würth medido: 8,4%)", () => {
  const v = avaliarPaginaServidor(pagina(0.084));
  assertEquals(v.quebrada, false);
  assertEquals(Math.abs(v.fracaoNaoBranca - 0.084) < 0.001, true);
});

Deno.test("página quase em branco (classe NF-135724) NUNCA sobe", () => {
  const v = avaliarPaginaServidor(pagina(0.005));
  assertEquals(v.quebrada, true);
  assertEquals(v.motivo, "pagina_quase_branca");
});

// INV-147 (correção 08.09): o front passou a PERGUNTAR ao operador na faixa
// 0,5%–2%; aqui, sem humano na frente (conversão autônoma do romaneio), a
// mesma faixa continua BLOQUEIO DURO. Se este teste começar a falhar, alguém
// afrouxou o servidor "pra ficar igual ao front" e abriu caminho pra imagem
// quebrada subir sem revisão.
Deno.test("INV-147: sem humano na frente, a faixa 0,5%-2% segue BLOQUEADA no servidor", () => {
  // 1,37% = pág 2 do 10803714.pdf, que no FRONT vira pedido de confirmação.
  const v = avaliarPaginaServidor(pagina(0.0137));
  assertEquals(v.quebrada, true);
  assertEquals(v.motivo, "pagina_quase_branca");
});

Deno.test("critério é simétrico a BGRA×RGBA (só troca r↔b, ambos <200 contam)", () => {
  const totalPx = 100;
  const bgra = new Uint8Array(totalPx * 4).fill(255);
  for (let p = 0; p < 10; p++) bgra[p * 4 + 2] = 0; // canal 3 (r em BGRA)
  assertEquals(avaliarPaginaServidor(bgra).fracaoNaoBranca, 0.1);
});

#!/usr/bin/env python3
"""
dbq.py — trilho ÚNICO e PORTÁTIL pra rodar SQL no banco de produção do Cockpit.

Funciona em macOS, Linux e Windows (Git Bash / PowerShell), com ou sem `psql`
instalado, sem dependência fora da biblioteca padrão do Python 3.

Por que existe (2026-09-02): o ritual de deploy só rodava na máquina do Caio.
O `/verify-cockpit` chamava `/opt/homebrew/opt/libpq/bin/psql` num caminho
hardcoded; no Windows do Carlos não há psql, os invariantes de banco caíam em
SKIP e o Claude dele improvisava um `run_sql.py` local — fora do repo, fora de
qualquer regra de permissão, barrado pelo classificador do modo automático.
Resultado: "preciso do Caio pra liberar", quando a liberação era do próprio
Carlos e a ferramenta certa não existia.

Uso (mesma forma de chamada do psql, pra ser drop-in no $PSQL do verify):
    python3 scripts/dbq.py -c "select 1;"
    python3 scripts/dbq.py "$SUPABASE_DB_URL" -tA -c "select count(*) from cards;"
    python3 scripts/dbq.py -f migration/2026-09-01_373_x.sql --dry-run
    python3 scripts/dbq.py -f migration/2026-09-01_373_x.sql
    python3 scripts/dbq.py -f migration/x.sql --autorizado-por "Carlos, 02/09 16:00: liga degrau 4 (ordem do Caio no chat)"
    python3 scripts/dbq.py --selftest

Credenciais (nesta ordem): argumento posicional `postgres://...`, env
`SUPABASE_DB_URL`, ou `.env.local` procurado em: diretório atual, raiz do
checkout, raiz do checkout PRINCIPAL (worktrees) e o diretório pai. Nunca
imprime segredo.

Backend (nesta ordem): `psql` no PATH (ou no caminho do homebrew) → Management
API do Supabase (`SUPABASE_ACCESS_TOKEN` + `SUPABASE_URL`/`SUPABASE_PROJECT_REF`).
`DBQ_FORCE_API=1` força a Management API (pra testar aqui o caminho do Windows).

POLÍTICA DE MIGRATIONS embutida (docs/POLITICA_MIGRATIONS.md, revisão 02/09):
  - TIPO A (aditiva/reversível) roda direto.
  - TIPO B (UPDATE/DELETE/TRUNCATE/DROP/RENAME/GRANT/REVOKE/ALTER POLICY/
    CREATE OR REPLACE de objeto JÁ existente/flag nascendo ligada/INSERT em
    tabela operacional) só roda com `--autorizado-por "<quem, quando, ordem>"`,
    impresso no log. Quem pode autorizar: o Caio ou o Carlos (autonomia
    declarada pelo Caio em 2026-09-02). A exigência é DECLARAR, não pedir.
  - `--dry-run` embrulha em BEGIN...ROLLBACK e RECUSA arquivo com COMMIT
    interno (armadilha real de 13/08: o COMMIT do arquivo encerra a transação
    externa e o ROLLBACK vira no-op — tudo persiste).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PROJECT_REF = "xjbycvscljqoqpjkmevb"
HOMEBREW_PSQL = "/opt/homebrew/opt/libpq/bin/psql"

# Tabelas OPERACIONAIS: INSERT nelas é mutação de dado de produção (TIPO B).
# Seeds de configuração (feature_flags, templates_email, cliente_config...) são
# TIPO A quando idempotentes e nascendo desligados.
TABELAS_OPERACIONAIS = {
    "cards", "card_events", "todos", "acoes_executadas_ssw", "audit_log",
    "mensagens", "emails_inbound", "email_anexos", "cards_emails_outbound",
    "conversas", "operadores", "contatos_clientes", "acoes_agendadas",
}


def forcar_saida_utf8() -> None:
    """Emite UTF-8 no stdout/stderr, qualquer que seja o console.

    No Windows o stdout nasce em cp1252 e QUALQUER caractere fora dessa tabela
    estoura `UnicodeEncodeError`. Aqui isso NAO e cosmetico: o print das linhas
    acontece DEPOIS do SQL rodar, entao uma migration com `RAISE NOTICE`
    acentuado (as da devolucao com CT-e tem) aplicava e em seguida cuspia
    traceback com exit 1 — quem le conclui "falhou" e reaplica.

    Medido em 2026-09-02 na maquina do Carlos, os dois quebravam:
    `dbq.py -c "select 'acao OK'"` com acento, e `deploy_pendente.py` na seta
    `->` do cabecalho da tabela. Era o defeito que fazia o ADR 0019 nao cumprir
    a propria promessa de portabilidade.

    `errors="replace"` de proposito: console que nao renderiza o glifo mostra
    `?` em vez de derrubar o trilho. Mesmo idioma dos `read_text` e
    `subprocess` deste arquivo.
    """
    for fluxo in (sys.stdout, sys.stderr):
        try:
            fluxo.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


# ----------------------------------------------------------------------------
# credenciais
# ----------------------------------------------------------------------------
def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=10).stdout.strip()
    except Exception:
        return ""


def candidatos_env_local() -> list[Path]:
    out: list[Path] = [Path.cwd() / ".env.local"]
    top = _git("rev-parse", "--show-toplevel")
    if top:
        out.append(Path(top) / ".env.local")
        out.append(Path(top).parent / ".env.local")
    common = _git("rev-parse", "--git-common-dir")
    if common:
        p = Path(common)
        if not p.is_absolute() and top:
            p = Path(top) / p
        out.append(p.parent / ".env.local")  # raiz do checkout principal (worktree)
    out.append(Path(__file__).resolve().parent.parent / ".env.local")
    out.append(Path(__file__).resolve().parent.parent.parent / ".env.local")
    vistos: set[Path] = set()
    uniq = []
    for c in out:
        try:
            r = c.resolve()
        except Exception:
            r = c
        if r not in vistos:
            vistos.add(r)
            uniq.append(c)
    return uniq


def carregar_env_local() -> str | None:
    """Carrega chaves ausentes no ambiente a partir do primeiro .env.local achado."""
    for c in candidatos_env_local():
        if not c.is_file():
            continue
        try:
            for linha in c.read_text(encoding="utf-8", errors="replace").splitlines():
                linha = linha.strip()
                if not linha or linha.startswith("#") or "=" not in linha:
                    continue
                if linha.startswith("export "):
                    linha = linha[len("export "):]
                k, v = linha.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        except Exception:
            continue
        return str(c)
    return None


def project_ref() -> str:
    ref = os.environ.get("SUPABASE_PROJECT_REF")
    if ref:
        return ref
    url = os.environ.get("SUPABASE_URL", "")
    m = re.match(r"https?://([a-z0-9]+)\.supabase\.co", url)
    return m.group(1) if m else DEFAULT_PROJECT_REF


# ----------------------------------------------------------------------------
# classificador TIPO A / TIPO B
# ----------------------------------------------------------------------------
_RE_COMENTARIO_LINHA = re.compile(r"--[^\n]*")
_RE_COMENTARIO_BLOCO = re.compile(r"/\*.*?\*/", re.S)
_RE_DOLLAR = re.compile(r"(\$[A-Za-z_]*\$)(.*?)\1", re.S)
_RE_STRING = re.compile(r"'(?:[^']|'')*'")


def _limpar_sql(sql: str) -> str:
    """Remove comentários, corpos de CREATE FUNCTION/PROCEDURE e strings.

    DO $$ ... $$ é MANTIDO (executa na hora = pode mutar dado). O corpo de uma
    função não executa ao ser criado, então UPDATE lá dentro não é mutação.
    """
    s = _RE_COMENTARIO_BLOCO.sub(" ", sql)
    s = _RE_COMENTARIO_LINHA.sub(" ", s)

    def _sub_dollar(m: re.Match) -> str:
        inicio = m.start()
        antes = s[max(0, inicio - 4000):inicio]
        # último CREATE ... FUNCTION/PROCEDURE antes deste bloco, sem ';' no meio
        ult = None
        for cm in re.finditer(r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b", antes, re.I):
            ult = cm
        if ult is not None and ";" not in antes[ult.end():]:
            return " $$<corpo de função omitido>$$ "
        return m.group(0)

    s = _RE_DOLLAR.sub(_sub_dollar, s)
    s = _RE_STRING.sub("''", s)
    return s


_GATILHOS_B: list[tuple[str, re.Pattern]] = [
    # ⚠ o `0-9` na classe do nome da tabela NÃO é cosmético (achado 2026-09-08).
    # Sem ele, `[a-z_\".]+` para de casar no primeiro dígito: em
    # `UPDATE public.cliente_config_oc13 SET ...` ele consome até `..._oc`,
    # tropeça no `1` e o `\s+SET` não bate — o UPDATE vira TIPO A e escapa da
    # exigência de `--autorizado-por`. Aconteceu de verdade com as migs 388 e
    # 389 (correção 08.09). Vale pra qualquer tabela com dígito no nome
    # (`cliente_config_oc13`, `cards2`, ...). O selftest cobre os dois casos.
    ("UPDATE em dado de produção", re.compile(r"\bUPDATE\s+(?:ONLY\s+)?[a-z0-9_\".]+\s+SET\b", re.I)),
    ("DELETE em dado de produção", re.compile(r"\bDELETE\s+FROM\b", re.I)),
    ("TRUNCATE", re.compile(r"\bTRUNCATE\b", re.I)),
    ("DROP de objeto", re.compile(r"\bDROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TYPE|INDEX|TRIGGER|SCHEMA|POLICY|COLUMN|CONSTRAINT|ROLE|EXTENSION)\b", re.I)),
    ("ALTER ... DROP COLUMN/CONSTRAINT", re.compile(r"\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b", re.I)),
    ("RENAME", re.compile(r"\bRENAME\s+(?:TO|COLUMN)\b", re.I)),
    ("GRANT/REVOKE em objeto existente", re.compile(r"\b(?:GRANT|REVOKE)\b", re.I)),
    ("ALTER POLICY / DISABLE RLS / FORCE RLS", re.compile(r"\bALTER\s+POLICY\b|\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b|\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b", re.I)),
    ("ALTER FUNCTION/VIEW/ROLE existente", re.compile(r"\bALTER\s+(?:FUNCTION|PROCEDURE|VIEW|MATERIALIZED\s+VIEW|ROLE)\b", re.I)),
    ("ALTER TABLE ... ALTER COLUMN (tipo/default/null)", re.compile(r"\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b", re.I)),
    ("cron.unschedule / cron.alter_job", re.compile(r"\bcron\.(?:unschedule|alter_job)\b", re.I)),
    ("flag nascendo LIGADA", re.compile(r"\bINSERT\s+INTO\s+(?:public\.)?feature_flags\b[^;]*\btrue\b", re.I)),
]

_RE_CREATE_OR_REPLACE = re.compile(
    r"\bCREATE\s+OR\s+REPLACE\s+(FUNCTION|PROCEDURE|VIEW|TRIGGER|POLICY)\s+(?:IF\s+NOT\s+EXISTS\s+)?"
    r"(?:public\.)?\"?([A-Za-z_][A-Za-z0-9_]*)\"?", re.I)
_RE_INSERT = re.compile(r"\bINSERT\s+INTO\s+(?:public\.)?\"?([A-Za-z_][A-Za-z0-9_]*)\"?", re.I)
_RE_ESCRITA = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|REFRESH|CALL|DO)\b", re.I)


def classificar(sql: str, objeto_existe=None) -> tuple[str, list[str]]:
    """Retorna ('leitura' | 'A' | 'B', motivos).

    objeto_existe(tipo, nome) -> bool|None consulta o banco pra decidir se um
    CREATE OR REPLACE substitui objeto existente (TIPO B) ou cria um novo (A).
    None = não foi possível consultar → conservador: TIPO B.
    """
    s = _limpar_sql(sql)
    if not _RE_ESCRITA.search(s):
        return "leitura", []
    motivos: list[str] = []
    for rotulo, rx in _GATILHOS_B:
        if rx.search(s):
            motivos.append(rotulo)
    for m in _RE_CREATE_OR_REPLACE.finditer(s):
        tipo, nome = m.group(1).upper(), m.group(2)
        existe = objeto_existe(tipo, nome) if objeto_existe else None
        if existe is None:
            motivos.append(f"CREATE OR REPLACE {tipo} {nome} (não deu pra conferir se já existe → tratado como B)")
        elif existe:
            motivos.append(f"CREATE OR REPLACE {tipo} {nome} — objeto JÁ EXISTE (substitui comportamento)")
    for m in _RE_INSERT.finditer(s):
        if m.group(1).lower() in TABELAS_OPERACIONAIS:
            motivos.append(f"INSERT em tabela operacional `{m.group(1)}`")
    # dedup preservando ordem
    vistos: set[str] = set()
    motivos = [x for x in motivos if not (x in vistos or vistos.add(x))]
    return ("B" if motivos else "A"), motivos


def tem_commit_interno(sql: str) -> bool:
    s = _limpar_sql(sql)
    return re.search(r"(^|;)\s*(COMMIT|END)\s*;", s, re.I | re.M) is not None


# ----------------------------------------------------------------------------
# backends
# ----------------------------------------------------------------------------
def achar_psql() -> str | None:
    p = shutil.which("psql")
    if p:
        return p
    if os.path.exists(HOMEBREW_PSQL):
        return HOMEBREW_PSQL
    return None


def rodar_psql(psql: str, url: str, sql: str) -> int:
    proc = subprocess.run(
        [psql, url, "-X", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql],
        text=True, encoding="utf-8", errors="replace",
    )
    return proc.returncode


def _fmt_valor(v) -> str:
    """Mesma cara do psql -tA: NULL vazio, booleano t/f, json compacto."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "t" if v else "f"
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def rodar_mgmt(sql: str) -> int:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        sys.stderr.write(
            "dbq: sem `psql` no PATH e sem SUPABASE_ACCESS_TOKEN no ambiente/.env.local.\n"
            "     Instale o psql OU coloque SUPABASE_ACCESS_TOKEN (token da Management API,\n"
            "     https://supabase.com/dashboard/account/tokens) no .env.local.\n")
        return 4
    ref = project_ref()
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": "cockpit-dbq/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            corpo = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        try:
            msg = json.loads(msg).get("message", msg)
        except Exception:
            pass
        sys.stderr.write(f"dbq: ERRO HTTP {e.code} da Management API: {msg}\n")
        return 1
    except Exception as e:  # rede, timeout
        sys.stderr.write(f"dbq: falha ao chamar a Management API: {e}\n")
        return 1
    try:
        dados = json.loads(corpo)
    except Exception:
        sys.stdout.write(corpo + "\n")
        return 0
    if isinstance(dados, list):
        for row in dados:
            if isinstance(row, dict):
                print("|".join(_fmt_valor(v) for v in row.values()))
            else:
                print(row)
    elif dados not in (None, {}):
        print(json.dumps(dados, ensure_ascii=False))
    return 0


def consultar_escalar(psql: str | None, url: str | None, sql: str) -> str | None:
    """Leitura pequena pro classificador (existe objeto?). None se falhar."""
    try:
        if psql and url:
            proc = subprocess.run([psql, url, "-X", "-tA", "-c", sql], capture_output=True,
                                  text=True, encoding="utf-8", errors="replace", timeout=30)
            return proc.stdout.strip() if proc.returncode == 0 else None
        token = os.environ.get("SUPABASE_ACCESS_TOKEN")
        if not token:
            return None
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{project_ref()}/database/query",
            data=json.dumps({"query": sql}).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                     "User-Agent": "cockpit-dbq/1.0"},
            method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            dados = json.loads(resp.read().decode("utf-8"))
        if isinstance(dados, list) and dados and isinstance(dados[0], dict):
            return str(next(iter(dados[0].values())))
        return None
    except Exception:
        return None


def fabricar_objeto_existe(psql, url):
    def objeto_existe(tipo: str, nome: str):
        nome_sql = nome.replace("'", "''")
        if tipo in ("FUNCTION", "PROCEDURE"):
            q = f"select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='{nome_sql}';"
        elif tipo == "VIEW":
            q = f"select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='{nome_sql}' and c.relkind in ('v','m');"
        elif tipo == "TRIGGER":
            q = f"select count(*) from pg_trigger where tgname='{nome_sql}';"
        elif tipo == "POLICY":
            q = f"select count(*) from pg_policies where policyname='{nome_sql}';"
        else:
            return None
        r = consultar_escalar(psql, url, q)
        if r is None or not r.isdigit():
            return None
        return int(r) > 0
    return objeto_existe


# ----------------------------------------------------------------------------
# selftest do classificador (guard anti-regressão — chamado pelo /verify-cockpit)
# ----------------------------------------------------------------------------
def selftest() -> int:
    casos = [
        ("select count(*) from cards;", "leitura"),
        ("CREATE TABLE IF NOT EXISTS public.x (id uuid primary key);\nCREATE INDEX IF NOT EXISTS ix ON public.x(id);", "A"),
        ("ALTER TABLE public.email_anexos ADD COLUMN IF NOT EXISTS preservar boolean NOT NULL DEFAULT false;", "A"),
        ("INSERT INTO public.feature_flags (key, description, enabled) VALUES ('f','d',false) ON CONFLICT (key) DO NOTHING;", "A"),
        ("INSERT INTO public.feature_flags (key, description, enabled) VALUES ('f','d',true);", "B"),
        ("UPDATE feature_flags SET enabled = true WHERE key='x';", "B"),
        # guard do achado 2026-09-08: tabela com DÍGITO no nome também é B.
        # Antes do fix a classe `[a-z_\".]+` parava no dígito e isto dava "A",
        # deixando UPDATE passar sem --autorizado-por (migs 388/389).
        ("UPDATE public.cliente_config_oc13 SET ativo = false WHERE cnpj_pagador='1';", "B"),
        ("UPDATE public.cards2 SET x = 1 WHERE y = 2;", "B"),
        # e a forma multi-linha, que é como as migrations do repo escrevem
        ("UPDATE public.cliente_config_oc13\n   SET ativo = true\n WHERE cnpj_pagador IN ('1','2');", "B"),
        ("DELETE FROM todos WHERE id='a';", "B"),
        ("DROP VIEW IF EXISTS public.v_x;", "B"),
        ("ALTER TABLE public.cards DROP COLUMN foo;", "B"),
        ("ALTER TABLE public.cards RENAME COLUMN a TO b;", "B"),
        ("REVOKE EXECUTE ON FUNCTION f() FROM authenticated;", "B"),
        ("ALTER VIEW public.v_x SET (security_invoker = on);", "B"),
        ("INSERT INTO public.card_events (card_id, event_type) VALUES ('a','b');", "B"),
        ("ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;", "A"),
        # corpo de função com UPDATE dentro NÃO é mutação ao criar (função nova)
        ("CREATE FUNCTION public.f_nova() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE cards SET x=1; END $$;", "A"),
        # DO block com UPDATE É mutação
        ("DO $$ BEGIN UPDATE cards SET x=1 WHERE id='a'; END $$;", "B"),
        # comentário mencionando UPDATE não conta
        ("-- reverter com UPDATE feature_flags SET enabled=false\nCREATE TABLE IF NOT EXISTS public.y (id int);", "A"),
        ("SELECT 1; -- DELETE FROM cards", "leitura"),
    ]
    falhas = 0
    for sql, esperado in casos:
        tipo, motivos = classificar(sql, objeto_existe=lambda t, n: False)
        if tipo != esperado:
            falhas += 1
            print(f"FAIL: esperado {esperado}, veio {tipo} ({motivos}) em: {sql[:70]!r}")
    # CREATE OR REPLACE: existe → B; não existe → A; sem consulta → B
    t, _ = classificar("CREATE OR REPLACE FUNCTION public.f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;", objeto_existe=lambda t, n: True)
    falhas += (t != "B")
    t, _ = classificar("CREATE OR REPLACE FUNCTION public.f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;", objeto_existe=lambda t, n: False)
    falhas += (t != "A")
    t, _ = classificar("CREATE OR REPLACE FUNCTION public.f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;", objeto_existe=None)
    falhas += (t != "B")
    # commit interno
    falhas += (not tem_commit_interno("BEGIN;\nCREATE TABLE x(id int);\nCOMMIT;"))
    falhas += (tem_commit_interno("CREATE TABLE x(id int); -- COMMIT;"))
    falhas += (tem_commit_interno("CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;"))
    if falhas:
        print(f"dbq selftest: {falhas} falha(s)")
        return 1
    print("dbq selftest: OK (classificador TIPO A/B + detecção de COMMIT interno)")
    return 0


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def uso(msg: str = "") -> int:
    if msg:
        sys.stderr.write(f"dbq: {msg}\n")
    sys.stderr.write(__doc__.split("Uso", 1)[1].split("Credenciais", 1)[0].replace("(", "Uso (", 1) + "\n")
    return 2


def main(argv: list[str]) -> int:
    forcar_saida_utf8()
    args = list(argv)
    if "--selftest" in args:
        return selftest()
    url_pos = None
    sql = None
    arquivo = None
    dry_run = False
    autorizado = None
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-c", "--command"):
            i += 1
            if i >= len(args):
                return uso("-c precisa do SQL")
            sql = args[i]
        elif a in ("-f", "--file"):
            i += 1
            if i >= len(args):
                return uso("-f precisa do arquivo")
            arquivo = args[i]
        elif a == "--dry-run":
            dry_run = True
        elif a in ("--autorizado-por", "--tipo-b-autorizado-por"):
            i += 1
            if i >= len(args):
                return uso("--autorizado-por precisa de 'quem, quando, ordem'")
            autorizado = args[i].strip()
        elif a.startswith("postgres://") or a.startswith("postgresql://"):
            url_pos = a
        elif a in ("-t", "-A", "-tA", "-At", "-q", "-X", "--tuples-only", "--no-align", "--quiet"):
            pass  # sempre tuples-only + unaligned
        elif a in ("-h", "--help"):
            return uso()
        else:
            return uso(f"argumento desconhecido: {a}")
        i += 1

    if (sql is None) == (arquivo is None):
        return uso("informe exatamente um de -c ou -f")
    if arquivo is not None:
        try:
            sql = Path(arquivo).read_text(encoding="utf-8")
        except Exception as e:
            sys.stderr.write(f"dbq: não consegui ler {arquivo}: {e}\n")
            return 2
    assert sql is not None

    origem_env = carregar_env_local()
    url = url_pos or os.environ.get("SUPABASE_DB_URL")
    psql = None if os.environ.get("DBQ_FORCE_API") else achar_psql()
    if psql and not url:
        # psql sem URL não adianta; tenta a Management API
        psql = None
    if not psql and not os.environ.get("SUPABASE_ACCESS_TOKEN"):
        sys.stderr.write(
            "dbq: nenhuma credencial encontrada. Precisa de SUPABASE_DB_URL (+psql instalado)\n"
            "     OU SUPABASE_ACCESS_TOKEN (Management API), no ambiente ou num .env.local em:\n"
            + "".join(f"       - {c}\n" for c in candidatos_env_local()))
        return 4

    # --- política ---
    tipo, motivos = classificar(sql, fabricar_objeto_existe(psql, url))
    rotulo_arq = arquivo or "(-c)"
    if tipo == "B" and not dry_run:
        if not autorizado:
            sys.stderr.write(
                f"🚫 dbq: {rotulo_arq} é TIPO B (move/apaga/substitui dado ou comportamento de produção):\n"
                + "".join(f"     • {m}\n" for m in motivos)
                + "   Pela docs/POLITICA_MIGRATIONS.md, TIPO B exige autorização DECLARADA (Caio ou Carlos),\n"
                  "   registrada no log e no commit. Rode de novo com:\n"
                  "     --autorizado-por \"<quem>, <data hora>: <ordem ou motivo em uma linha>\"\n"
                  "   Sem saber quem autoriza e por quê: NÃO rode. Não existe 'é só uma linha'.\n")
            return 3
        sys.stderr.write(f"⚠️  dbq: TIPO B autorizado por: {autorizado}\n" + "".join(f"     • {m}\n" for m in motivos))
    elif tipo == "A":
        sys.stderr.write(f"dbq: {rotulo_arq} classificado como TIPO A (aditiva/reversível).\n")

    if dry_run:
        if tem_commit_interno(sql):
            sys.stderr.write(
                "🚫 dbq: --dry-run RECUSADO — o arquivo tem COMMIT/END interno. O COMMIT dele encerraria a\n"
                "   transação externa e o ROLLBACK final viraria no-op: TUDO persistiria (caso real: mig 337,\n"
                "   13/08). Tire o BEGIN/COMMIT do arquivo (a política já exige isso) e rode o dry-run de novo.\n")
            return 3
        sql = "BEGIN;\n" + sql + "\nROLLBACK;\n"
        sys.stderr.write("dbq: dry-run — embrulhado em BEGIN ... ROLLBACK (nada persiste).\n")

    sys.stderr.write(f"dbq: backend={'psql' if psql else 'management-api'}"
                     + (f" env={origem_env}" if origem_env else "") + "\n")
    if psql:
        assert url
        return rodar_psql(psql, url, sql)
    return rodar_mgmt(sql)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""다국어 소스 분석기 — Python / Java / C.

공통 결과 형식:
  static : {syntax_ok, syntax_error, lines, functions[], classes[], issues[], docstring_coverage}
  dynamic: {ok, error, kind, doctests, func_tests[], notes}
Python 은 AST+격리실행, Java 는 javac/java, C 는 gcc 가 있으면 실제 컴파일·실행하고
툴체인이 없으면 정적 분석만 수행한다(우아한 성능 저하).
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

EXT_LANG = {".py": "python", ".java": "java", ".c": "c", ".h": "c"}


def detect_language(filename: str, code: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in EXT_LANG:
        return EXT_LANG[ext]
    if re.search(r"\bpublic\s+(final\s+|abstract\s+)?class\b|\bSystem\.out\.", code):
        return "java"
    if re.search(r"#include\s*<|\bint\s+main\s*\(", code):
        return "c"
    return "python"


# ================================================================ Python
def py_static(code: str) -> dict:
    out = {"syntax_ok": True, "syntax_error": None, "lines": len(code.splitlines()),
           "functions": [], "classes": [], "issues": [], "docstring_coverage": None}
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        out["syntax_ok"] = False
        out["syntax_error"] = f"line {e.lineno}: {e.msg}"
        return out
    documented = total = 0
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            total += 1
            has_doc = bool(ast.get_docstring(node))
            documented += has_doc
            length = (node.end_lineno or node.lineno) - node.lineno + 1
            out["functions"].append({"name": node.name, "line": node.lineno, "length": length,
                                     "args": len(node.args.args), "doc": has_doc})
            if length > 50:
                out["issues"].append({"sev": "warning", "line": node.lineno,
                                      "msg": f"함수 '{node.name}' 길이 {length}줄 — 분리 권장"})
            for d in node.args.defaults:
                if isinstance(d, (ast.List, ast.Dict, ast.Set)):
                    out["issues"].append({"sev": "critical", "line": node.lineno,
                                          "msg": f"함수 '{node.name}' 가변 기본 인자 — 버그 유발 패턴"})
        elif isinstance(node, ast.ClassDef):
            total += 1
            documented += bool(ast.get_docstring(node))
            out["classes"].append({"name": node.name, "line": node.lineno})
        elif isinstance(node, ast.ExceptHandler) and node.type is None:
            out["issues"].append({"sev": "warning", "line": node.lineno, "msg": "bare except — 예외 유형 명시 필요"})
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("eval", "exec"):
            out["issues"].append({"sev": "critical", "line": node.lineno, "msg": f"{node.func.id}() 사용 — 보안 위험"})
        elif isinstance(node, ast.ImportFrom) and any(a.name == "*" for a in node.names):
            out["issues"].append({"sev": "info", "line": node.lineno, "msg": "wildcard import(*)"})
    out["docstring_coverage"] = round(documented / total, 2) if total else None
    return out


PY_RUNNER = r'''
import contextlib, doctest, importlib.util, inspect, io, json, sys
path = sys.argv[1]
res = {"ok": False, "error": None, "doctests": None, "func_tests": []}
try:
    spec = importlib.util.spec_from_file_location("target_module", path)
    mod = importlib.util.module_from_spec(spec)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        spec.loader.exec_module(mod)
    res["ok"] = True
except Exception as e:
    res["error"] = f"{type(e).__name__}: {e}"
if res["ok"]:
    try:
        dt = doctest.testmod(mod, verbose=False)
        res["doctests"] = {"attempted": dt.attempted, "failed": dt.failed}
    except Exception:
        pass
    for name, fn in inspect.getmembers(mod, inspect.isfunction):
        if getattr(fn, "__module__", "") != "target_module":
            continue
        sig = inspect.signature(fn)
        required = [p for p in sig.parameters.values()
                    if p.default is p.empty and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
        if required:
            res["func_tests"].append({"name": name + "()", "status": "skipped",
                                      "detail": f"필수 인자 {len(required)}개 - 자동 호출 생략"})
            continue
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                out = fn()
            res["func_tests"].append({"name": name + "()", "status": "pass", "detail": "반환: " + repr(out)[:80]})
        except Exception as e:
            res["func_tests"].append({"name": name + "()", "status": "fail", "detail": f"{type(e).__name__}: {e}"})
print(json.dumps(res, ensure_ascii=False))
'''


def py_dynamic(code: str) -> dict:
    with tempfile.TemporaryDirectory() as td:
        target, runner = os.path.join(td, "target.py"), os.path.join(td, "runner.py")
        open(target, "w", encoding="utf-8").write(code)
        open(runner, "w", encoding="utf-8").write(PY_RUNNER)
        try:
            p = subprocess.run([sys.executable, runner, target], capture_output=True,
                               text=True, timeout=10, encoding="utf-8")
            d = json.loads(p.stdout.strip().splitlines()[-1])
            d.update({"kind": "import+doctest+자동호출", "notes": []})
            return d
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "10초 타임아웃(무한루프 가능성)", "kind": "import",
                    "doctests": None, "func_tests": [], "notes": []}
        except Exception as e:
            return {"ok": False, "error": str(e), "kind": "import", "doctests": None,
                    "func_tests": [], "notes": []}


# ================================================================ Java
JAVA_METHOD_RE = re.compile(
    r"(public|protected|private|static)[\w\s<>\[\]]*?\s+(\w+)\s*\(([^)]*)\)\s*(?:throws [\w,\s]+)?\s*\{", re.M)


def java_static(code: str) -> dict:
    lines = code.splitlines()
    out = {"syntax_ok": True, "syntax_error": None, "lines": len(lines),
           "functions": [], "classes": [], "issues": [], "docstring_coverage": None}
    for m in re.finditer(r"\b(?:public|private|protected)?\s*(?:final|abstract)?\s*(class|interface|enum)\s+(\w+)", code):
        out["classes"].append({"name": m.group(2), "line": code[:m.start()].count("\n") + 1})
    documented = 0
    methods = []
    for m in JAVA_METHOD_RE.finditer(code):
        name = m.group(2)
        if name in ("if", "for", "while", "switch", "catch", "new"):
            continue
        line = code[:m.start()].count("\n") + 1
        args = len([a for a in m.group(3).split(",") if a.strip()])
        prefix = code[:m.start()].rstrip()
        has_doc = prefix.endswith("*/")
        documented += has_doc
        methods.append({"name": name, "line": line, "length": 0, "args": args, "doc": has_doc})
    out["functions"] = methods
    out["docstring_coverage"] = round(documented / len(methods), 2) if methods else None

    def add(sev, pat, msg):
        for m in re.finditer(pat, code):
            out["issues"].append({"sev": sev, "line": code[:m.start()].count("\n") + 1, "msg": msg})
    add("warning", r"catch\s*\([^)]*\)\s*\{\s*\}", "빈 catch 블록 — 예외 무시(silent failure)")
    add("warning", r"\.printStackTrace\(\)", "printStackTrace — 로깅 프레임워크 사용 권장")
    add("info", r"System\.out\.print", "System.out 출력 — 운영 코드는 로거 사용 권장")
    add("critical", r'==\s*"', '문자열 == 비교 — equals() 를 사용해야 함')
    add("critical", r"Runtime\.getRuntime\(\)\.exec", "Runtime.exec — 명령 주입 위험 검토 필요")
    return out


def java_dynamic(code: str) -> dict:
    res = {"ok": False, "error": None, "kind": "javac 컴파일+실행", "doctests": None,
           "func_tests": [], "notes": []}
    javac = shutil.which("javac")
    if not javac:
        res["notes"].append("JDK(javac) 미설치 — 컴파일/실행 단계 생략, 정적 분석만 수행")
        res["kind"] = "정적 분석만"
        res["ok"] = True  # 툴체인 부재는 코드 결함이 아님
        return res
    m = re.search(r"public\s+(?:final\s+)?class\s+(\w+)", code) or re.search(r"class\s+(\w+)", code)
    cls = m.group(1) if m else "Main"
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, f"{cls}.java")
        open(src, "w", encoding="utf-8").write(code)
        try:
            p = subprocess.run(["javac", "-encoding", "UTF-8", src], capture_output=True,
                               text=True, timeout=30, cwd=td)
            if p.returncode != 0:
                res["error"] = (p.stderr or p.stdout)[:600]
                res["func_tests"].append({"name": "javac", "status": "fail", "detail": "컴파일 실패"})
                return res
            res["ok"] = True
            res["func_tests"].append({"name": "javac", "status": "pass", "detail": "컴파일 성공"})
            if re.search(r"static\s+void\s+main\s*\(", code):
                try:
                    r = subprocess.run(["java", "-cp", td, cls], capture_output=True,
                                       text=True, timeout=8, cwd=td)
                    st = "pass" if r.returncode == 0 else "fail"
                    detail = f"exit={r.returncode}" + (f", stdout: {r.stdout.strip()[:80]}" if r.stdout.strip() else "")
                    if st == "fail" and r.stderr.strip():
                        detail += f", stderr: {r.stderr.strip()[:120]}"
                    res["func_tests"].append({"name": f"{cls}.main()", "status": st, "detail": detail})
                except subprocess.TimeoutExpired:
                    res["func_tests"].append({"name": f"{cls}.main()", "status": "fail", "detail": "8초 타임아웃"})
            else:
                res["notes"].append("main 메서드 없음 — 실행 단계 생략")
        except subprocess.TimeoutExpired:
            res["error"] = "javac 30초 타임아웃"
    return res


# ================================================================ C
def c_static(code: str) -> dict:
    lines = code.splitlines()
    out = {"syntax_ok": True, "syntax_error": None, "lines": len(lines),
           "functions": [], "classes": [], "issues": [], "docstring_coverage": None}
    fn_re = re.compile(r"^[\w\s\*]+?\b(\w+)\s*\(([^;)]*)\)\s*\{", re.M)
    documented = 0
    for m in fn_re.finditer(code):
        name = m.group(1)
        if name in ("if", "for", "while", "switch", "sizeof", "return"):
            continue
        line = code[:m.start()].count("\n") + 1
        args = len([a for a in m.group(2).split(",") if a.strip() and a.strip() != "void"])
        has_doc = code[:m.start()].rstrip().endswith("*/")
        documented += has_doc
        out["functions"].append({"name": name, "line": line, "length": 0, "args": args, "doc": has_doc})
    out["docstring_coverage"] = round(documented / len(out["functions"]), 2) if out["functions"] else None

    def add(sev, pat, msg):
        for m in re.finditer(pat, code):
            out["issues"].append({"sev": sev, "line": code[:m.start()].count("\n") + 1, "msg": msg})
    add("critical", r"\bgets\s*\(", "gets() — 버퍼 오버플로우, fgets() 사용")
    add("critical", r"\bstrcpy\s*\(", "strcpy() — 경계 검사 없음, strncpy/strlcpy 권장")
    add("critical", r"\bsprintf\s*\(", "sprintf() — snprintf() 권장")
    add("warning", r"\bsystem\s*\(", "system() — 명령 주입 위험")
    add("warning", r"\bscanf\s*\(\s*\"%s\"", 'scanf("%s") — 길이 제한 없는 입력')
    n_malloc = len(re.findall(r"\bmalloc\s*\(|\bcalloc\s*\(", code))
    n_free = len(re.findall(r"\bfree\s*\(", code))
    if n_malloc > n_free:
        out["issues"].append({"sev": "warning", "line": 0,
                              "msg": f"malloc/calloc {n_malloc}회 vs free {n_free}회 — 메모리 누수 가능성"})
    return out


def c_dynamic(code: str) -> dict:
    res = {"ok": False, "error": None, "kind": "gcc 컴파일+실행", "doctests": None,
           "func_tests": [], "notes": []}
    gcc = shutil.which("gcc") or shutil.which("cc")
    if not gcc:
        res["notes"].append("C 컴파일러(gcc) 미설치 — 컴파일/실행 단계 생략, 정적 분석만 수행")
        res["kind"] = "정적 분석만"
        res["ok"] = True
        return res
    with tempfile.TemporaryDirectory() as td:
        src, exe = os.path.join(td, "target.c"), os.path.join(td, "target.exe")
        open(src, "w", encoding="utf-8").write(code)
        try:
            p = subprocess.run([gcc, "-Wall", "-O0", src, "-o", exe], capture_output=True,
                               text=True, timeout=30)
            warns = len(re.findall(r"warning:", p.stderr or ""))
            if p.returncode != 0:
                res["error"] = (p.stderr or "")[:600]
                res["func_tests"].append({"name": "gcc", "status": "fail", "detail": "컴파일 실패"})
                return res
            res["ok"] = True
            res["func_tests"].append({"name": "gcc -Wall", "status": "pass",
                                      "detail": f"컴파일 성공 (경고 {warns}건)"})
            if warns:
                res["notes"].append(f"gcc 경고 {warns}건: " + (p.stderr or "").strip().splitlines()[0][:120])
            if re.search(r"\bint\s+main\s*\(", code):
                try:
                    r = subprocess.run([exe], capture_output=True, text=True, timeout=8, input="")
                    st = "pass" if r.returncode == 0 else "fail"
                    detail = f"exit={r.returncode}" + (f", stdout: {r.stdout.strip()[:80]}" if r.stdout.strip() else "")
                    res["func_tests"].append({"name": "main()", "status": st, "detail": detail})
                except subprocess.TimeoutExpired:
                    res["func_tests"].append({"name": "main()", "status": "fail", "detail": "8초 타임아웃"})
        except subprocess.TimeoutExpired:
            res["error"] = "gcc 30초 타임아웃"
    return res


# ================================================================ 통합 진입점
def analyze(lang: str, code: str) -> dict:
    return {"python": py_static, "java": java_static, "c": c_static}[lang](code)


def run_dynamic(lang: str, code: str, syntax_ok: bool) -> dict:
    if lang == "python" and not syntax_ok:
        return {"ok": False, "error": "구문 오류로 실행 생략", "kind": "생략",
                "doctests": None, "func_tests": [], "notes": []}
    return {"python": py_dynamic, "java": java_dynamic, "c": c_dynamic}[lang](code)

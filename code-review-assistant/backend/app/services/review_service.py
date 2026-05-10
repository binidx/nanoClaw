"""
Review service — uses Cursor Agent CLI or Claude Code CLI
to perform code review on git diffs.

The agent runs with cwd set to the target repository so it can
read source files for context. The diff is provided in the prompt
as a starting point but the agent is encouraged to explore the code.
"""

import asyncio
import logging
import re
import shutil
import tempfile
from functools import lru_cache
from collections import defaultdict
from collections.abc import Awaitable, Callable
from pathlib import Path

from app.config import settings
from app.services import git_service, cursor_service, claude_service

logger = logging.getLogger("code-review.review")
_repo_agent_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
LLM_TIMEOUT_SECONDS = 1200
LLM_RETRY_ON_TIMEOUT = 1

_PROMPT_ROOT = Path(__file__).resolve().parent.parent / "prompts"
_TEMPLATE_DIR = _PROMPT_ROOT / "templates"
_KNOWLEDGE_DIR = _PROMPT_ROOT / "knowledge"
_SKILL_DIR = _PROMPT_ROOT / "skills"

_FALLBACK_SINGLE_PROMPT = "你是一名资深代码审查专家，请输出中文 Markdown 审查报告。"
_FALLBACK_CROSS_PROMPT = "你是一名资深跨仓库代码审查专家，请输出中文 Markdown 联审报告。"
_FALLBACK_CROSS_SUB_PROMPT = "你是一名资深代码审查专家，请输出单仓结构化审查报告。"
_FALLBACK_CROSS_AGG_PROMPT = "你是一名发布评审负责人，请输出跨仓汇总审查报告。"
_PROMPT_FILES = {
    "single_review": "single_review.md",
    "cross_repo_review": "cross_repo_review.md",
    "cross_repo_sub_review": "cross_repo_sub_review.md",
    "cross_repo_aggregate": "cross_repo_aggregate.md",
}
_GUIDANCE_FILES = {
    "common_evidence_rules": _KNOWLEDGE_DIR / "common_evidence_rules.md",
    "cross_repo_business_checks": _KNOWLEDGE_DIR / "cross_repo_business_checks.md",
    "java_service_review_skill": _SKILL_DIR / "java_service_review_skill.md",
    "sql_review_skill": _SKILL_DIR / "sql_review_skill.md",
}
_GUIDANCE_DESC = {
    "common_evidence_rules": "高风险结论的证据约束与输出规范",
    "cross_repo_business_checks": "跨仓接口契约/调用链/版本兼容检查清单",
    "java_service_review_skill": "Java 服务端常见风险审查要点",
    "sql_review_skill": "SQL 正确性、性能、隔离与安全检查要点",
}


@lru_cache(maxsize=64)
def _load_text_file(path_text: str) -> str:
    p = Path(path_text)
    return p.read_text(encoding="utf-8").strip()


def _prompt(name: str, fallback: str) -> str:
    try:
        filename = _PROMPT_FILES.get(name)
        if not filename:
            return fallback
        return _load_text_file(str(_TEMPLATE_DIR / filename)) or fallback
    except Exception as e:
        logger.warning("Load prompt section failed (%s): %s", name, e)
        return fallback


def _looks_like_sql_change(changed_paths: list[str], diff_text: str) -> bool:
    p_hit = any(
        (
            str(p).lower().endswith(".sql")
            or "mapper.xml" in str(p).lower()
            or str(p).lower().endswith(".xml") and ("mapper" in str(p).lower() or "mybatis" in str(p).lower())
        )
        for p in (changed_paths or [])
    )
    if p_hit:
        return True
    low = (diff_text or "").lower()
    return any(
        token in low
        for token in ("select ", "update ", "delete ", "insert into ", " left join ", " inner join ", " where ")
    )


def _heuristic_guidance_keys(
    mode: str,
    changed_paths: list[str] | None,
    diff_text: str,
) -> tuple[list[str], set[str]]:
    keys: list[str] = ["common_evidence_rules"]
    forced: set[str] = set()
    if mode.startswith("cross"):
        keys.append("cross_repo_business_checks")
    if changed_paths and any(str(p).lower().endswith(".java") for p in changed_paths):
        keys.append("java_service_review_skill")
    # SQL change: force-load SQL skill to avoid missing data-layer risks.
    if _looks_like_sql_change(changed_paths or [], diff_text):
        forced.add("sql_review_skill")
        keys.append("sql_review_skill")
    # de-dup while preserving order
    dedup: list[str] = []
    seen: set[str] = set()
    for k in keys:
        if k in seen:
            continue
        seen.add(k)
        dedup.append(k)
    return dedup, forced


def _extract_context_request_keys(raw_text: str) -> list[str]:
    text = (raw_text or "").strip()
    if not text:
        return []
    block = re.search(
        r"BEGIN_CONTEXT_REQUEST\s*([\s\S]*?)\s*END_CONTEXT_REQUEST",
        text,
        flags=re.IGNORECASE,
    )
    if not block:
        return []
    content = block.group(1).strip()
    if not content:
        return []
    try:
        import json
        arr = json.loads(content)
        if isinstance(arr, list):
            return [str(x).strip() for x in arr if str(x).strip()]
    except Exception:
        pass
    return []


def _render_guidance_block(selected: list[str]) -> str:
    chunks: list[str] = []
    for key in selected[:4]:
        p = _GUIDANCE_FILES.get(key)
        if not p:
            continue
        try:
            title = f"### {key}"
            body = _load_text_file(str(p))
            chunks.append(f"{title}\n{body}")
        except Exception as e:
            logger.warning("Load guidance failed (%s): %s", p, e)
    if not chunks:
        return ""
    return "## 额外审查知识与技能\n" + "\n\n".join(chunks)


async def _call_llm_with_context_requests(
    *,
    base_prompt: str,
    cwd: str,
    candidate_keys: list[str],
    initial_keys: list[str],
    forced_keys: set[str],
    on_stream: Callable[[str], Awaitable[None] | None] | None = None,
    max_rounds: int = 2,
) -> tuple[str, list[str], list[list[str]]]:
    selected: list[str] = []
    for k in initial_keys:
        if k in _GUIDANCE_FILES and k not in selected:
            selected.append(k)
    for fk in forced_keys:
        if fk in _GUIDANCE_FILES and fk not in selected:
            selected.append(fk)

    key_lines = []
    for key in candidate_keys:
        desc = _GUIDANCE_DESC.get(key, "扩展审查上下文")
        key_lines.append(f"- `{key}`: {desc}")
    keys_text = "\n".join(key_lines) if key_lines else "- （无可选上下文键）"

    raw_final = ""
    request_rounds: list[list[str]] = []
    for round_idx in range(max_rounds + 1):
        guidance_block = _render_guidance_block(selected)
        prompt = f"""{base_prompt}

{guidance_block}

## 可按需请求的上下文键
{keys_text}

若当前上下文不足，请仅输出以下结构（不要输出其他文字）：
BEGIN_CONTEXT_REQUEST
["key1","key2"]
END_CONTEXT_REQUEST

若上下文已足够，请直接输出最终审查报告（BEGIN_REVIEW_REPORT ... END_REVIEW_REPORT）。
"""
        # Only stream on final round to reduce noisy incremental output.
        current_on_stream = on_stream if round_idx == max_rounds else None
        raw = await _call_llm(prompt, cwd=cwd, on_stream=current_on_stream)
        raw_final = raw
        req = _extract_context_request_keys(raw)
        if req:
            request_rounds.append(req)
        if not req:
            break
        if round_idx >= max_rounds:
            break
        added = 0
        for key in req:
            if key not in _GUIDANCE_FILES:
                continue
            if key not in candidate_keys:
                continue
            if key not in selected:
                selected.append(key)
                added += 1
        for fk in forced_keys:
            if fk in _GUIDANCE_FILES and fk not in selected:
                selected.append(fk)
        if added == 0:
            break
    return raw_final, selected, request_rounds


def _slug_name(name: str, fallback: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_\-]+", "_", name or "").strip("_")
    return safe or fallback


async def _call_llm(
    prompt: str,
    cwd: str,
    on_stream: Callable[[str], Awaitable[None] | None] | None = None,
) -> str:
    """Route to the appropriate CLI backend based on the key prefix."""
    api_key = settings.anthropic_api_key

    logger.info("Prompt length: %d chars, cwd: %s", len(prompt), cwd)
    logger.debug("=== PROMPT (first 2000) ===\n%s", prompt[:2000])

    for attempt in range(LLM_RETRY_ON_TIMEOUT + 1):
        try:
            if cursor_service.is_cursor_key(api_key):
                logger.info("Using Cursor Agent CLI for review (key=crsr_...)")
                return await cursor_service.call_llm(
                    api_key,
                    prompt,
                    timeout=LLM_TIMEOUT_SECONDS,
                    cwd=cwd,
                    on_stream=on_stream,
                )
            else:
                logger.info("Using Claude Code CLI for review (key=%s...)", api_key[:6])
                return await claude_service.call_llm(
                    api_key,
                    prompt,
                    timeout=LLM_TIMEOUT_SECONDS,
                    cwd=cwd,
                    on_stream=on_stream,
                )
        except Exception as e:
            msg = str(e).lower()
            timed_out = "timed out" in msg or "timeout" in msg
            if timed_out and attempt < LLM_RETRY_ON_TIMEOUT:
                logger.warning(
                    "LLM call timeout in cwd=%s, retrying (%d/%d): %s",
                    cwd,
                    attempt + 1,
                    LLM_RETRY_ON_TIMEOUT,
                    e,
                )
                continue
            raise
    raise RuntimeError("LLM call failed after retries")


def _extract_report_text(raw_text: str) -> str:
    """Extract the final markdown report from possibly noisy CLI output."""
    text = (raw_text or "").strip()
    if not text:
        return ""

    marked = re.search(
        r"BEGIN_REVIEW_REPORT\s*([\s\S]*?)\s*END_REVIEW_REPORT",
        text,
        flags=re.IGNORECASE,
    )
    if marked:
        return marked.group(1).strip()

    fenced_blocks = re.findall(
        r"```(?:markdown|md)?\s*([\s\S]*?)```",
        text,
        flags=re.IGNORECASE,
    )
    if fenced_blocks:
        for block in reversed(fenced_blocks):
            if "变更概述" in block or "审查结论" in block:
                return block.strip()
        return fenced_blocks[-1].strip()

    for anchor in ("## 变更概述", "# 变更概述", "## 审查结论", "# 审查结论"):
        idx = text.find(anchor)
        if idx != -1:
            heading_start = text.rfind("\n#", 0, idx)
            if heading_start != -1:
                return text[heading_start + 1 :].strip()
            return text[idx:].strip()

    return text


def _extract_section(markdown_text: str, section_title: str) -> str:
    pattern = re.compile(
        rf"^\s*##+\s*{re.escape(section_title)}\s*$\n([\s\S]*?)(?=^\s*##+\s*\S|\Z)",
        flags=re.MULTILINE,
    )
    match = pattern.search(markdown_text)
    return match.group(1).strip() if match else ""


def _normalize_digits(num_text: str) -> str:
    table = str.maketrans("０１２３４５６７８９", "0123456789")
    return num_text.translate(table)


def _parse_report(report_text: str) -> dict:
    """Parse markdown report to extract summary, passed, findings_count."""
    summary = ""
    passed = True
    result_explicit = False
    findings_count = 0

    overview = _extract_section(report_text, "变更概述")
    if overview:
        summary = overview
        summary = re.sub(r"\s+", " ", summary)
        if len(summary) > 200:
            summary = summary[:197] + "..."

    conclusion = _extract_section(report_text, "审查结论")
    if conclusion:
        result_match = re.search(r"结果[：:]\s*\**\s*(通过|不通过)", conclusion)
        if result_match:
            result_explicit = True
            passed = result_match.group(1) == "通过"
        elif "不通过" in conclusion:
            passed = False
            result_explicit = True
        elif "通过" in conclusion:
            passed = True
            result_explicit = True

        count_m = re.search(r"发现问题数[：:]\s*\**\s*([0-9０-９]+)", conclusion)
        if count_m:
            findings_count = int(_normalize_digits(count_m.group(1)))

    if findings_count == 0:
        findings_count = len(
            re.findall(r"^\s*###\s+\d+[\.\)]?\s+", report_text, flags=re.MULTILINE)
        )

    if not summary:
        candidate = ""
        for line in report_text.splitlines():
            s = line.strip()
            if not s:
                continue
            # skip pure headings/bullets to avoid summaries like "一、总体概览"
            if s.startswith("#"):
                continue
            plain = s.lstrip("-* ").strip()
            if re.fullmatch(r"[一二三四五六七八九十]+[、.．]\s*.+", plain):
                # likely section heading
                continue
            if len(plain) < 8:
                continue
            candidate = plain
            break
        if not candidate:
            first_line = next((line.strip() for line in report_text.splitlines() if line.strip()), "")
            candidate = first_line.lstrip("#- ").strip()
        summary = candidate[:200]

    if not result_explicit:
        passed = findings_count == 0

    return {
        "passed": passed,
        "summary": summary,
        "detail": report_text.strip(),
        "findings_count": findings_count,
    }


def _extract_cross_summary(report_text: str, passed: bool, findings_count: int) -> str:
    """Build a concise cross-review summary from conclusion semantics, not title headings."""
    conclusion = _extract_section(report_text, "审查结论")
    if conclusion:
        for line in conclusion.splitlines():
            s = line.strip().lstrip("-* ").strip()
            if not s:
                continue
            low = s.lower()
            if low.startswith("结果") or low.startswith("发现问题数") or low.startswith("总体风险评级"):
                continue
            if len(s) >= 10:
                return s[:200]

    # fallback: pick first meaningful sentence from whole report body
    for line in report_text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            continue
        plain = s.lstrip("-* ").strip()
        if re.fullmatch(r"[一二三四五六七八九十]+[、.．]\s*.+", plain):
            continue
        if plain in {"联审目标", "审查结论", "分仓审查", "跨仓库调用链分析", "详细发现", "发版建议"}:
            continue
        if len(plain) >= 10:
            return plain[:200]

    return f"跨仓联审{'通过' if passed else '不通过'}：发现 {findings_count} 个问题。"


def _extract_ai_trace(raw_text: str) -> dict:
    """Extract thinking summary, thought steps, and tool calls from raw output."""
    text = (raw_text or "").strip()
    if not text:
        return {"ai_thought_summary": "", "ai_thought_steps": [], "tool_calls": []}

    thought = ""
    thought_steps: list[str] = []
    thought_patterns = [
        r"(?:思考|计划|规划下一步)[：:\s]+(.+)",
        r"(?:analysis|reasoning)[：:\s]+(.+)",
    ]
    lines = text.splitlines()
    for line in lines:
        line_s = line.strip().strip("-*")
        if not line_s:
            continue
        for pat in thought_patterns:
            m = re.search(pat, line_s, flags=re.IGNORECASE)
            if m and m.group(1).strip():
                thought = m.group(1).strip()
                break
        if thought:
            break

    # Try to extract richer thought steps from non-report area.
    report_text = _extract_report_text(text)
    non_report = text
    if report_text and report_text in text:
        non_report = text.replace(report_text, "")
    for line in non_report.splitlines():
        line_s = line.strip().lstrip("-*").strip()
        if not line_s:
            continue
        low = line_s.lower()
        if "begin_review_report" in low or "end_review_report" in low:
            continue
        if re.search(r"\b(read_file|tool|bash|git|rg|grep)\b", low):
            continue
        if len(line_s) < 8:
            continue
        if any(
            key in line_s
            for key in ("思考", "分析", "判断", "计划", "下一步", "风险", "影响", "结论", "建议")
        ):
            thought_steps.append(line_s[:280])
        elif line_s.endswith(("。", ".", "；", ";")) and len(thought_steps) < 8:
            thought_steps.append(line_s[:280])
        if len(thought_steps) >= 8:
            break

    tool_calls: list[dict] = []
    allowed_tools = {
        "read_file",
        "write_file",
        "edit_file",
        "search",
        "rg",
        "glob",
        "git",
        "bash",
        "shell",
        "list_dir",
        "grep",
        "cat",
    }
    tool_patterns = [
        # Examples: "工具: read_file xxx", "Tool: git diff ..."
        r"^\s*(?:工具|tool)\s*[:：]\s*([a-zA-Z_][\w\-]*)\s*(.*)$",
        # Examples: "[TOOL] read_file ...", "read_file: ..."
        r"^\s*(?:\[tool\]\s*)?([a-z_][a-z0-9_]{1,30})\s*(?:[:(]\s*|\s+)(.*)$",
    ]
    for line in non_report.splitlines():
        line_s = line.strip()
        if not line_s:
            continue
        # Avoid parsing plain markdown/report lines as tool calls.
        if line_s.startswith(("#", "-", "*")) and "tool" not in line_s.lower():
            continue
        parsed = None
        for pat in tool_patterns:
            m = re.search(pat, line_s, flags=re.IGNORECASE)
            if not m:
                continue
            name = (m.group(1) or "").strip().lower()
            args = (m.group(2) or "").strip()
            name = name.replace("-", "_")
            if name not in allowed_tools:
                continue
            # Normalize noisy arg text.
            args = re.sub(r"[`'\"]+", "", args)
            args = re.sub(r"\s+", " ", args).strip()
            parsed = {"name": name, "args": args[:180]}
            break
        if parsed:
            tool_calls.append(parsed)
        if len(tool_calls) >= 20:
            break

    if not thought:
        thought = "模型基于代码上下文、变更目的与影响范围完成审查。"
    if not thought_steps:
        thought_steps = [thought]

    return {
        "ai_thought_summary": thought[:280],
        "ai_thought_steps": thought_steps,
        "tool_calls": tool_calls,
    }


def _count_severity_levels(markdown_text: str) -> dict[str, int]:
    levels = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
    for level in ("P0", "P1", "P2", "P3"):
        levels[level] = len(
            re.findall(rf"\[\s*{level}\s*\]", markdown_text or "", flags=re.IGNORECASE)
        )
    return levels


async def run_review(
    local_path: str,
    baseline_branch: str,
    target_ref: str,
    prompt_template: str = "",
    file_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
    on_stream: Callable[[str], Awaitable[None] | None] | None = None,
) -> dict:
    """Run a code review comparing target_ref against baseline_branch.

    Returns dict with keys: passed, summary, detail, findings_count
    """
    repo = Path(local_path)
    repo_lock = _repo_agent_locks[str(repo.resolve()).lower()]

    baseline_fetch = baseline_branch.removeprefix("origin/")
    target_fetch = target_ref.removeprefix("origin/")
    try:
        git_service.fetch_branch(repo, baseline_fetch)
    except Exception as e:
        logger.warning("Failed to fetch baseline branch %s: %s", baseline_fetch, e)
    try:
        git_service.fetch_branch(repo, target_fetch)
    except Exception as e:
        logger.warning("Failed to fetch target branch %s: %s", target_fetch, e)

    try:
        base_ref = git_service.resolve_ref(repo, baseline_branch)
    except git_service.GitError:
        base_ref = baseline_branch

    try:
        target = git_service.resolve_ref(repo, target_ref)
    except git_service.GitError:
        target = target_ref

    try:
        mb = git_service.merge_base(repo, base_ref, target)
    except git_service.GitError:
        mb = base_ref

    diff_text = git_service.diff_unified(repo, mb, target)
    if not diff_text.strip():
        return {
            "passed": True,
            "summary": "没有需要审查的变更",
            "detail": "diff 为空 — 目标分支与基线分支之间没有代码变更。",
            "findings_count": 0,
            "target_commit": target,
        }

    changed_files = git_service.parse_diff_to_files(diff_text)

    if file_patterns:
        import fnmatch
        changed_files = [
            f for f in changed_files
            if any(fnmatch.fnmatch(f["new_path"], p) for p in file_patterns)
        ]
    if exclude_patterns:
        import fnmatch
        changed_files = [
            f for f in changed_files
            if not any(fnmatch.fnmatch(f["new_path"], p) for p in exclude_patterns)
        ]

    if not changed_files:
        return {
            "passed": True,
            "summary": "文件过滤后没有需要审查的变更",
            "detail": "所有变更文件已被文件匹配规则过滤。",
            "findings_count": 0,
            "target_commit": target,
        }

    diff_for_prompt = "\n\n".join(
        f"--- {f['old_path']}\n+++ {f['new_path']}\n{f['diff']}"
        for f in changed_files[:50]
    )
    if len(diff_for_prompt) > 80000:
        diff_for_prompt = diff_for_prompt[:80000] + "\n\n... (diff 已截断)"

    branch_name = target_ref.removeprefix("origin/")
    file_list = "\n".join(f"  - `{f['new_path']}`" for f in changed_files[:30])
    changed_paths = [str(f.get("new_path") or "") for f in changed_files]
    guidance_candidates, forced_guidance = _heuristic_guidance_keys(
        mode="single",
        changed_paths=changed_paths,
        diff_text=diff_text,
    )
    initial_guidance = [k for k in guidance_candidates if k in {"common_evidence_rules"}]
    for fk in forced_guidance:
        if fk not in initial_guidance:
            initial_guidance.append(fk)

    base_prompt = f"""{_prompt("single_review", _FALLBACK_SINGLE_PROMPT)}

---

## 审查目标
- **仓库**: `{repo.name}`
- **目标分支**: `{branch_name}`
- **基线分支**: `{baseline_branch}`
- **变更文件** ({len(changed_files)} 个):
{file_list}
{f'''
- **额外审查指令**: {prompt_template}
''' if prompt_template else ""}
当前工作目录已定位到目标分支 `{branch_name}` 的提交，请直接阅读代码上下文并撰写审查报告。
最终输出时，请使用以下边界包裹完整 Markdown 报告（边界本身也要输出）：
BEGIN_REVIEW_REPORT
...你的 Markdown 报告...
END_REVIEW_REPORT

以下是 diff 供参考（你也可以自行运行 git diff 获取）：

```diff
{diff_for_prompt}
```"""

    logger.info(
        "Review prompt built: branch=%s baseline=%s files=%d diff_chars=%d",
        branch_name, baseline_branch, len(changed_files), len(diff_for_prompt),
    )

    if not settings.anthropic_api_key:
        return {
            "passed": True,
            "summary": "审查已跳过 — 未配置 API Key",
            "detail": "请登录并输入有效的 API Key 以启用自动审查。",
            "findings_count": 0,
            "target_commit": target,
        }

    if repo_lock.locked():
        logger.info("Repo agent lock waiting: %s", repo)
    async with repo_lock:
        worktree_path: Path | None = None
        try:
            # Isolate review context from user's current branch by using
            # a detached temporary worktree pinned to the target commit.
            worktree_path = git_service.create_detached_worktree(repo, target)
            raw_text, loaded_guidance, request_rounds = await _call_llm_with_context_requests(
                base_prompt=base_prompt,
                cwd=str(worktree_path),
                candidate_keys=guidance_candidates,
                initial_keys=initial_guidance,
                forced_keys=forced_guidance,
                on_stream=on_stream,
                max_rounds=2,
            )
        except Exception as e:
            logger.error("LLM CLI error: %s", e)
            return {
                "passed": False,
                "summary": f"审查出错: {e}",
                "detail": str(e),
                "findings_count": 0,
                "target_commit": target,
            }
        finally:
            if worktree_path:
                try:
                    git_service.remove_worktree(repo, worktree_path)
                except Exception as cleanup_err:
                    logger.warning("Failed to cleanup worktree %s: %s", worktree_path, cleanup_err)

    report_text = _extract_report_text(raw_text)
    result = _parse_report(report_text)
    trace = _extract_ai_trace(raw_text)
    result.update(trace)
    result["loaded_guidance_keys"] = loaded_guidance
    result["context_request_rounds"] = request_rounds
    result["target_commit"] = target
    logger.info(
        "Review parsed: passed=%s findings=%d summary=%s",
        result["passed"], result["findings_count"], result["summary"][:80],
    )
    return result


async def run_cross_repo_review(
    *,
    branch_name: str,
    repos: list[dict],
    child_hints: list[dict] | None = None,
    extra_instructions: str = "",
    on_stream: Callable[[str], Awaitable[None] | None] | None = None,
) -> dict:
    """Run a two-stage cross-repo review: per-repo reviews + aggregate review."""
    if not repos:
        return {
            "passed": False,
            "summary": "跨仓库联审失败：未提供可审查仓库。",
            "detail": "未提供可审查仓库。",
            "findings_count": 0,
        }

    if not settings.anthropic_api_key:
        return {
            "passed": True,
            "summary": "联审已跳过 — 未配置 API Key",
            "detail": "请登录并输入有效的 API Key 以启用联审。",
            "findings_count": 0,
        }

    lock_keys = sorted(
        {
            str(Path(str(item["local_path"])).resolve()).lower()
            for item in repos
            if item.get("local_path")
        }
    )
    acquired_locks: list[asyncio.Lock] = []
    workspace_root = Path(tempfile.mkdtemp(prefix="cr_cross_workspace_"))
    mounted: list[tuple[Path, Path]] = []
    mounted_repo_names: list[str] = []
    repo_contexts: list[dict] = []
    child_results: list[dict] = []

    try:
        for key in lock_keys:
            lock = _repo_agent_locks[key]
            await lock.acquire()
            acquired_locks.append(lock)

        for idx, item in enumerate(repos, 1):
            repo_name = str(item.get("repo_name") or f"repo-{idx}")
            repo_path = Path(str(item["local_path"]))
            baseline_branch = str(item.get("baseline_branch") or "master")
            target_ref = str(item.get("target_ref") or f"origin/{branch_name}")

            baseline_fetch = baseline_branch.removeprefix("origin/")
            target_fetch = target_ref.removeprefix("origin/")
            try:
                git_service.fetch_branch(repo_path, baseline_fetch)
            except Exception as e:
                logger.warning("Cross review fetch baseline failed repo=%s branch=%s err=%s", repo_name, baseline_fetch, e)
            try:
                git_service.fetch_branch(repo_path, target_fetch)
            except Exception as e:
                logger.warning("Cross review fetch target failed repo=%s branch=%s err=%s", repo_name, target_fetch, e)

            try:
                base_ref = git_service.resolve_ref(repo_path, baseline_branch)
            except git_service.GitError:
                base_ref = baseline_branch
            try:
                target = git_service.resolve_ref(repo_path, target_ref)
            except git_service.GitError:
                target = target_ref
            try:
                mb = git_service.merge_base(repo_path, base_ref, target)
            except git_service.GitError:
                mb = base_ref

            diff_text = git_service.diff_unified(repo_path, mb, target)
            changed_files = git_service.parse_diff_to_files(diff_text)
            repo_file_list = "\n".join(
                f"  - `{f['new_path']}`" for f in changed_files[:25]
            ) or "  - （无）"
            mount_name = f"{idx:02d}_{_slug_name(repo_name, f'repo_{idx}')}"
            mount_path = workspace_root / mount_name
            git_service.create_detached_worktree_at(repo_path, target, mount_path)
            mounted.append((repo_path, mount_path))
            mounted_repo_names.append(repo_name)

            artifacts_dir = workspace_root / "_review_inputs" / mount_name
            artifacts_dir.mkdir(parents=True, exist_ok=True)
            name_status_items = git_service.diff_name_status(repo_path, mb, target)
            name_status_lines: list[str] = []
            for ns in name_status_items:
                status = str(ns.get("status") or "modified")
                path = str(ns.get("path") or "")
                old_path = str(ns.get("old_path") or "")
                if old_path and old_path != path:
                    name_status_lines.append(f"{status}\t{old_path}\t{path}")
                else:
                    name_status_lines.append(f"{status}\t{path}")
            (artifacts_dir / "name_status.txt").write_text(
                "\n".join(name_status_lines),
                encoding="utf-8",
            )
            (artifacts_dir / "full.diff").write_text(diff_text or "", encoding="utf-8")
            repo_contexts.append(
                {
                    "idx": idx,
                    "repo_id": int(item.get("repo_id") or 0),
                    "repo_name": repo_name,
                    "mount_name": mount_name,
                    "mount_path": mount_path,
                    "baseline_branch": baseline_branch,
                    "target_ref": target_ref,
                    "target_commit": target,
                    "merge_base": mb,
                    "changed_files": changed_files,
                    "changed_file_count": len(changed_files),
                    "repo_file_list": repo_file_list,
                    "artifact_name_status": f"_review_inputs/{mount_name}/name_status.txt",
                    "artifact_full_diff": f"_review_inputs/{mount_name}/full.diff",
                }
            )

        for ctx in repo_contexts:
            sub_diff_text = (
                str((workspace_root / ctx["artifact_full_diff"]).read_text(encoding="utf-8"))
                if (workspace_root / ctx["artifact_full_diff"]).exists()
                else ""
            )
            sub_candidates, sub_forced = _heuristic_guidance_keys(
                mode="cross_sub",
                changed_paths=[str(f.get("new_path") or "") for f in (ctx.get("changed_files") or [])],
                diff_text=sub_diff_text,
            )
            sub_initial = [k for k in sub_candidates if k in {"common_evidence_rules", "cross_repo_business_checks"}]
            for fk in sub_forced:
                if fk not in sub_initial:
                    sub_initial.append(fk)

            sub_base_prompt = f"""{_prompt("cross_repo_sub_review", _FALLBACK_CROSS_SUB_PROMPT)}

---

## 审查输入
- 仓库名：`{ctx['repo_name']}`
- 工作区目录：`{ctx['mount_name']}`
- 目标分支：`{branch_name}`
- 基线分支：`{ctx['baseline_branch']}`
- merge_base：`{ctx['merge_base']}`
- target_commit：`{ctx['target_commit']}`
- 变更文件数：{ctx['changed_file_count']}
- 主要变更文件：
{ctx['repo_file_list']}
- 差异工件（优先读取）：
  - `{ctx['artifact_name_status']}`
  - `{ctx['artifact_full_diff']}`
- 可选抽样命令（如果 shell 可用）：
  - `git -C {ctx['mount_name']} diff --name-status {ctx['merge_base']} {ctx['target_commit']}`
  - `git -C {ctx['mount_name']} diff {ctx['merge_base']} {ctx['target_commit']}`

{f"额外审查要求：{extra_instructions}" if extra_instructions else "额外审查要求：无"}

最终输出时，请使用以下边界包裹完整 Markdown 报告（边界本身也要输出）：
BEGIN_REVIEW_REPORT
...你的 Markdown 报告...
END_REVIEW_REPORT
"""
            try:
                raw_sub, sub_loaded_keys, sub_request_rounds = await _call_llm_with_context_requests(
                    base_prompt=sub_base_prompt,
                    cwd=str(workspace_root),
                    candidate_keys=sub_candidates,
                    initial_keys=sub_initial,
                    forced_keys=sub_forced,
                    on_stream=None,
                    max_rounds=2,
                )
                sub_report = _extract_report_text(raw_sub)
                sub_result = _parse_report(sub_report)
                sub_trace = _extract_ai_trace(raw_sub)
            except Exception as e:
                sub_report = (
                    f"## 仓库信息\n- 仓库名: {ctx['repo_name']}\n\n"
                    f"## 变更摘要\n无法完成该仓审查：{e}\n\n"
                    "## 风险判断\n- 结论: 不通过\n- 问题数: 1\n- 主要风险: 审查流程失败\n\n"
                    "## 详细发现\n### 1. [P1] 审查流程失败\n- **文件**: `N/A`\n- **类型**: 质量\n"
                    f"- **描述**: {e}\n- **建议**: 检查仓库可用性、Git 状态与审查环境后重试。"
                )
                sub_result = {
                    "passed": False,
                    "summary": f"{ctx['repo_name']} 审查失败：{e}",
                    "detail": sub_report,
                    "findings_count": 1,
                }
                sub_trace = {"ai_thought_summary": "", "ai_thought_steps": [], "tool_calls": []}
                sub_loaded_keys = sub_initial
                sub_request_rounds = []

            severity = _count_severity_levels(sub_result["detail"])
            child_results.append(
                {
                    "repo_id": int(ctx.get("repo_id") or 0),
                    "repo_name": ctx["repo_name"],
                    "branch_name": branch_name,
                    "baseline_branch": ctx["baseline_branch"],
                    "status": "passed" if sub_result["passed"] else "failed",
                    "summary": str(sub_result["summary"] or ""),
                    "detail": str(sub_result["detail"] or ""),
                    "findings_count": int(sub_result["findings_count"] or 0),
                    "severity": severity,
                    "merge_base": ctx["merge_base"],
                    "target_commit": ctx["target_commit"],
                    "changed_file_count": int(ctx["changed_file_count"]),
                    "mount_name": ctx["mount_name"],
                    "artifact_name_status": ctx["artifact_name_status"],
                    "artifact_full_diff": ctx["artifact_full_diff"],
                    "ai_thought_summary": str(sub_trace.get("ai_thought_summary") or ""),
                    "loaded_guidance_keys": sub_loaded_keys,
                    "context_request_rounds": sub_request_rounds,
                }
            )

        repo_name_list = [str(item["repo_name"]) for item in child_results]
        must_cover_repos = "\n".join(f"- {name}" for name in repo_name_list) or "- （无）"

        hints_text = ""
        if child_hints:
            lines = []
            for h in child_hints[:50]:
                lines.append(
                    f"- {h.get('repo_name', '-')}: 状态={h.get('status', '-')}, 问题数={h.get('findings_count', 0)}, 摘要={h.get('summary', '-')}"
                )
            hints_text = "\n".join(lines)
        total_files = sum(int(x.get("changed_file_count") or 0) for x in child_results)
        sev_total = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
        for item in child_results:
            sev = item.get("severity") or {}
            for key in sev_total:
                sev_total[key] += int(sev.get(key) or 0)

        child_blocks: list[str] = []
        for idx, item in enumerate(child_results, 1):
            child_blocks.append(
                (
                    f"### 子结果 {idx}: {item['repo_name']}\n"
                    f"- 状态: {item['status']}\n"
                    f"- 问题数: {item['findings_count']}\n"
                    f"- 变更文件数: {item['changed_file_count']}\n"
                    f"- merge_base: `{item['merge_base']}`\n"
                    f"- target_commit: `{item['target_commit']}`\n"
                    f"- 差异工件: `{item['artifact_name_status']}` / `{item['artifact_full_diff']}`\n"
                    f"- 摘要: {item['summary']}\n"
                    f"- 详细报告:\n{item['detail'][:12000]}\n"
                )
            )

        agg_diff_hint = "\n".join(str(x.get("summary") or "") for x in child_results)
        agg_candidates, agg_forced = _heuristic_guidance_keys(
            mode="cross_aggregate",
            changed_paths=[str(x.get("repo_name") or "") for x in child_results],
            diff_text=agg_diff_hint,
        )
        agg_initial = [k for k in agg_candidates if k in {"common_evidence_rules", "cross_repo_business_checks"}]
        for fk in agg_forced:
            if fk not in agg_initial:
                agg_initial.append(fk)
        base_prompt = f"""{_prompt("cross_repo_aggregate", _FALLBACK_CROSS_AGG_PROMPT)}

---

## 联审目标
- 目标分支：`{branch_name}`
- 匹配仓库数量：{len(child_results)}
- 总变更文件数：{total_files}
- 风险计数：P0={sev_total['P0']} / P1={sev_total['P1']} / P2={sev_total['P2']} / P3={sev_total['P3']}
- 必须覆盖仓库：
{must_cover_repos}

## 子任务先验信息（仅供参考）
{hints_text or "暂无"}

## 分仓审查结果（这是你必须汇总的输入）
{"\n\n".join(child_blocks)}

## 额外汇总要求
{extra_instructions or "无"}

你可以补充跨仓调用链视角，但不得丢失任何分仓结果，不得把“无法执行命令”当作本次结论。
最终输出时，请使用以下边界包裹完整 Markdown 报告（边界本身也要输出）：
BEGIN_REVIEW_REPORT
...你的 Markdown 报告...
END_REVIEW_REPORT
"""
        try:
            raw_text, agg_loaded_keys, agg_request_rounds = await _call_llm_with_context_requests(
                base_prompt=base_prompt,
                cwd=str(workspace_root),
                candidate_keys=agg_candidates,
                initial_keys=agg_initial,
                forced_keys=agg_forced,
                on_stream=on_stream,
                max_rounds=2,
            )
        except Exception as e:
            logger.warning("Cross aggregate LLM failed, using fallback summary: %s", e)
            fallback = build_cross_repo_summary(child_results)
            return {
                "passed": fallback["status"] == "passed",
                "summary": fallback["summary"],
                "detail": fallback["detail"],
                "findings_count": sum(int(x.get("findings_count") or 0) for x in child_results),
                "ai_thought_summary": "",
                "ai_thought_steps": [],
                "tool_calls": [],
                "child_reviews": child_results,
                "loaded_guidance_keys": agg_initial,
                "context_request_rounds": [],
            }
        report_text = _extract_report_text(raw_text)
        if not report_text.strip():
            fallback = build_cross_repo_summary(child_results)
            result = {
                "passed": fallback["status"] == "passed",
                "summary": fallback["summary"],
                "detail": fallback["detail"],
                "findings_count": sum(int(x.get("findings_count") or 0) for x in child_results),
            }
        else:
            result = _parse_report(report_text)
            result["summary"] = _extract_cross_summary(
                report_text=report_text,
                passed=bool(result.get("passed")),
                findings_count=int(result.get("findings_count") or 0),
            )
        result.update(_extract_ai_trace(raw_text))
        result["child_reviews"] = child_results
        result["loaded_guidance_keys"] = agg_loaded_keys
        result["context_request_rounds"] = agg_request_rounds
        missing_repos = [
            name for name in repo_name_list if name and name.lower() not in report_text.lower()
        ]
        if missing_repos:
            result["passed"] = False
            result["findings_count"] = int(result.get("findings_count") or 0) + len(missing_repos)
            result["detail"] = (
                result["detail"]
                + "\n\n## 补充校验\n"
                + f"- 以下仓库未在联审总报告中被覆盖：{', '.join(missing_repos)}"
            )
            result["summary"] = f"联审完成但覆盖不完整：缺少 {len(missing_repos)} 个仓库"
        return result
    except Exception as e:
        logger.error("Cross repo unified review failed: %s", e, exc_info=True)
        return {
            "passed": False,
            "summary": f"跨仓库统一审查失败：{e}",
            "detail": str(e),
            "findings_count": 0,
        }
    finally:
        for repo_path, mount in reversed(mounted):
            try:
                git_service.remove_worktree(repo_path, mount)
            except Exception as cleanup_err:
                logger.warning("Failed to cleanup cross worktree %s: %s", mount, cleanup_err)
        try:
            shutil.rmtree(workspace_root, ignore_errors=True)
        except Exception:
            pass
        for lock in reversed(acquired_locks):
            if lock.locked():
                lock.release()


def build_cross_repo_summary(children: list[dict]) -> dict:
    """Build a structured cross-repo summary as fallback when LLM aggregation fails."""
    if not children:
        return {
            "status": "error",
            "summary": "跨仓库联审失败：未找到可汇总的子审查结果。",
            "detail": "未找到子审查结果。",
        }

    total = len(children)
    passed = sum(1 for c in children if c.get("status") == "passed")
    failed = sum(1 for c in children if c.get("status") == "failed")
    errored = sum(1 for c in children if c.get("status") == "error")
    total_findings = sum(int(c.get("findings_count") or 0) for c in children)

    if errored > 0:
        status = "partial_failed" if passed > 0 else "error"
    elif failed > 0:
        status = "failed"
    else:
        status = "passed"

    summary = (
        f"跨仓库联审完成：共 {total} 个仓库，"
        f"通过 {passed}，不通过 {failed}，错误 {errored}，问题总数 {total_findings}。"
    )

    p1_titles: list[str] = []
    p2_titles: list[str] = []
    for c in children:
        detail = str(c.get("detail") or "")
        repo = str(c.get("repo_name") or "-")
        for m in re.findall(r"###\s+\d+\.\s*\[(P0|P1|P2|P3)\]\s*(.+)", detail):
            level = str(m[0]).upper()
            title = str(m[1]).strip()
            item = f"- `{repo}` [{level}] {title}"
            if level in {"P0", "P1"}:
                p1_titles.append(item)
            elif level == "P2":
                p2_titles.append(item)

    lines = ["# 跨仓库同名分支联审报告", "", "## 一、总体概览", ""]
    lines.extend(
        [
            f"- 目标分支：`{children[0].get('branch_name', '-')}`",
            f"- 覆盖仓库：{total}",
            f"- 通过：{passed}；不通过：{failed}；错误：{errored}",
            f"- 问题总计：{total_findings}",
            "",
            "## 二、各项目概述",
            "",
        ]
    )

    for idx, c in enumerate(children, 1):
        repo = c.get("repo_name", f"repo-{idx}")
        child_status = c.get("status", "-")
        child_summary = c.get("summary", "")
        findings = c.get("findings_count", 0)
        lines.extend(
            [
                f"### {idx}. {repo}",
                "",
                f"- 状态：`{child_status}`",
                f"- 问题数：{findings}",
                f"- 摘要：{child_summary or '-'}",
                "",
            ]
        )

    lines.extend(["## 三、上线红线清单（高风险，必须上线前修复）", ""])
    lines.extend(p1_titles or ["- 无"])
    lines.extend(["", "## 四、中风险问题汇总", ""])
    lines.extend(p2_titles or ["- 无"])
    lines.extend(["", "## 五、发版建议", ""])
    for c in children:
        repo = str(c.get("repo_name") or "-")
        c_status = str(c.get("status") or "-")
        findings = int(c.get("findings_count") or 0)
        if c_status == "error":
            advise = "暂缓发版"
        elif findings > 0:
            advise = "有条件发版（需修复问题）"
        else:
            advise = "可发版"
        lines.append(f"- `{repo}`：{advise}")
    lines.extend(
        [
            "",
            f"- 总体风险评级：{'高风险' if p1_titles else ('中风险' if p2_titles else '低风险')}",
            "- 发版前必要行动：",
            "  1) 修复红线问题并回归；",
            "  2) 逐仓确认契约兼容与依赖版本；",
            "  3) 复跑联审并保留审查证据。",
        ]
    )

    return {
        "status": status,
        "summary": summary,
        "detail": "\n".join(lines),
    }

"""
Claude Code CLI service — wraps the 'claude' binary for LLM calls.
Reference: D:\\project\\work-order-assistant\\wms-assistant\\server.py

Environment variables for the subprocess:
  ANTHROPIC_API_KEY      — set to the user-provided auth token
  ANTHROPIC_AUTH_TOKEN   — same token (used by some proxy gateways)
  ANTHROPIC_BASE_URL     — custom API endpoint (from server config)
"""

import asyncio
import logging
import os
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable

from app.config import settings

logger = logging.getLogger("code-review.claude")

CLAUDE_CMD = "claude.cmd" if sys.platform == "win32" else "claude"


async def _kill_proc(proc: asyncio.subprocess.Process):
    """Kill process and its entire child tree (Windows .cmd wrappers spawn sub-processes)."""
    if proc.returncode is not None:
        return
    pid = proc.pid
    if sys.platform == "win32":
        try:
            kill_proc = await asyncio.create_subprocess_exec(
                "taskkill", "/F", "/T", "/PID", str(pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(kill_proc.wait(), timeout=8)
        except Exception:
            proc.kill()
    else:
        import signal
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.kill()
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        proc.kill()


def _build_env(api_key: str) -> dict:
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    env["ANTHROPIC_API_KEY"] = api_key
    env["ANTHROPIC_AUTH_TOKEN"] = api_key
    if settings.anthropic_base_url:
        env["ANTHROPIC_BASE_URL"] = settings.anthropic_base_url
    if sys.platform == "win32" and "PATH" in env:
        env["PATH"] = os.pathsep.join(
            p for p in env["PATH"].split(os.pathsep)
            if "WindowsApps" not in p
        )
    return env


def _base_cmd() -> list[str]:
    """Build the base command list. On Windows, .cmd files need cmd /c to execute reliably."""
    if sys.platform == "win32":
        return ["cmd", "/c", CLAUDE_CMD]
    return [CLAUDE_CMD]


async def verify_key(api_key: str, timeout: float = 30) -> tuple[bool, str]:
    """Validate an API key via Claude Code CLI. Returns (ok, error_message)."""
    proc = None
    try:
        env = _build_env(api_key)
        cmd = _base_cmd() + ["--print", "-p", "回复OK"]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        stdout_text = stdout_bytes.decode("utf-8", errors="replace")
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")
        logger.info("Claude verify rc=%s stdout=%s stderr=%s",
                     proc.returncode, stdout_text[:200], stderr_text[:200])

        if proc.returncode == 0 and "invalid" not in stderr_text.lower():
            return True, ""

        lower_stderr = stderr_text.lower()
        if any(kw in lower_stderr for kw in ("unauthorized", "invalid", "authentication")):
            return False, "API Key 验证失败，请检查后重试"
        if any(kw in lower_stderr for kw in ("rate", "limit", "spend", "quota")):
            return False, "API Key 额度已用尽或请求频率限制"
        return False, f"API Key 验证失败 (exit code {proc.returncode})"

    except asyncio.TimeoutError:
        if proc:
            await _kill_proc(proc)
        return False, "API Key 验证超时，请稍后再试"
    except FileNotFoundError:
        return False, f"未找到 Claude Code CLI: {CLAUDE_CMD}，请确认已安装"
    except Exception as e:
        if proc:
            await _kill_proc(proc)
        logger.error("Claude Code CLI key verification error: %s", e)
        return False, f"API Key 验证出错: {e}"


async def call_llm(
    api_key: str,
    prompt: str,
    timeout: float = 300,
    cwd: str | None = None,
    on_stream: Callable[[str], Awaitable[None] | None] | None = None,
) -> str:
    """Call Claude Code CLI with a prompt and return the raw text output.
    If cwd is provided, the subprocess runs in that directory (used to scope workspace context).
    Long prompts are written to a temp file to avoid Windows command-line length limits.
    """
    proc = None
    prompt_file: str | None = None

    async def _stream_process_output(
        process: asyncio.subprocess.Process,
        total_timeout: float,
        idle_timeout: float | None = None,
    ) -> tuple[str, str]:
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        queue: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue()
        start = time.monotonic()
        last_output = start

        async def _pump(stream: asyncio.StreamReader | None, tag: str):
            if stream is None:
                return
            while True:
                chunk = await stream.read(4096)
                if not chunk:
                    break
                await queue.put((tag, chunk))

        out_task = asyncio.create_task(_pump(process.stdout, "stdout"))
        err_task = asyncio.create_task(_pump(process.stderr, "stderr"))
        tasks = [out_task, err_task]
        try:
            while True:
                now = time.monotonic()
                if total_timeout and now - start > total_timeout:
                    raise TimeoutError(f"total timeout reached ({total_timeout}s)")
                if idle_timeout and now - last_output > idle_timeout:
                    raise TimeoutError(f"idle timeout reached ({idle_timeout}s)")

                try:
                    tag, chunk = await asyncio.wait_for(queue.get(), timeout=0.8)
                    text = chunk.decode("utf-8", errors="replace")
                    if tag == "stdout":
                        stdout_chunks.append(text)
                        if on_stream and text:
                            maybe = on_stream(text)
                            if asyncio.iscoroutine(maybe):
                                await maybe
                    else:
                        stderr_chunks.append(text)
                    last_output = time.monotonic()
                except asyncio.TimeoutError:
                    pass

                done = process.returncode is not None
                if done and queue.empty() and all(t.done() for t in tasks):
                    break
                if not done:
                    try:
                        await asyncio.wait_for(process.wait(), timeout=0.05)
                    except asyncio.TimeoutError:
                        pass
            await process.wait()
            return ("".join(stdout_chunks), "".join(stderr_chunks))
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()
    try:
        env = _build_env(api_key)
        kwargs: dict = {}
        if sys.platform == "win32":
            import subprocess as _sp
            kwargs["creationflags"] = _sp.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True

        if sys.platform == "win32":
            fd, prompt_file = tempfile.mkstemp(suffix=".txt", prefix="cr_prompt_")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(prompt)
            shell_cmd = f'{CLAUDE_CMD} --print -p < "{prompt_file}"'
            logger.info("Prompt written to temp file (%d chars): %s", len(prompt), prompt_file)
            proc = await asyncio.create_subprocess_shell(
                shell_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=cwd,
                **kwargs,
            )
        else:
            cmd = _base_cmd() + ["--print", "-p", prompt]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=cwd,
                **kwargs,
            )

        stdout_text, stderr_text = await _stream_process_output(
            proc,
            total_timeout=timeout,
            idle_timeout=max(300.0, min(timeout, 900.0)),
        )

        if proc.returncode != 0:
            logger.error("Claude Code CLI failed (rc=%d): %s", proc.returncode, stderr_text[:500])
            lower = stderr_text.lower()
            if any(kw in lower for kw in ("spend", "limit", "quota")):
                raise RuntimeError("API Key 额度已用尽，请更换 Key")
            raise RuntimeError(f"Claude Code CLI error: {stderr_text[:200]}")

        return stdout_text

    except TimeoutError:
        if proc:
            await _kill_proc(proc)
        raise RuntimeError(f"Claude Code CLI timed out after {timeout}s")
    except FileNotFoundError as e:
        logger.error("FileNotFoundError in call_llm: %s (cwd=%s, cmd=%s)", e, cwd, CLAUDE_CMD)
        if cwd and not os.path.isdir(cwd):
            raise RuntimeError(f"Review working directory not found: {cwd}")
        raise RuntimeError(f"Claude Code CLI not found: {CLAUDE_CMD}")
    except OSError as e:
        logger.error("OSError in call_llm: %s (cwd=%s)", e, cwd)
        raise RuntimeError(f"Claude Code CLI OS error: {e}")
    finally:
        if prompt_file and os.path.exists(prompt_file):
            try:
                os.unlink(prompt_file)
            except OSError:
                pass

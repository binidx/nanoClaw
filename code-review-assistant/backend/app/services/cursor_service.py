"""
Cursor Agent CLI service — wraps the Cursor agent binary for LLM calls.
Reference: D:\\project\\work-order-assistant\\wms-assistant-cursor\\server.py

Keys starting with 'crsr_' are Cursor keys, passed via --api-key argument.
"""

import asyncio
import logging
import os
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable

logger = logging.getLogger("code-review.cursor")

AGENT_CMD = (
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "cursor-agent", "agent.cmd")
    if sys.platform == "win32"
    else "agent"
)


async def _kill_proc(proc: asyncio.subprocess.Process):
    """Kill process and its entire child tree."""
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


def _build_env() -> dict:
    env = os.environ.copy()
    if "PATH" in env:
        env["PATH"] = os.pathsep.join(
            p for p in env["PATH"].split(os.pathsep)
            if "WindowsApps" not in p
        )
    agent_dir = os.path.dirname(AGENT_CMD)
    if agent_dir and agent_dir not in env.get("PATH", ""):
        env["PATH"] = agent_dir + os.pathsep + env.get("PATH", "")
    return env


def _base_cmd() -> list[str]:
    """Build the base command list. On Windows, .cmd files need cmd /c to execute reliably."""
    if sys.platform == "win32":
        return ["cmd", "/c", AGENT_CMD]
    return [AGENT_CMD]


def is_cursor_key(api_key: str) -> bool:
    return api_key.startswith("crsr_")


async def verify_key(api_key: str, timeout: float = 30) -> tuple[bool, str]:
    """Validate a Cursor API key. Returns (ok, error_message)."""
    proc = None
    try:
        cmd = _base_cmd() + ["--api-key", api_key, "--trust", "--print", "回复OK"]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_build_env(),
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        stdout_text = stdout_bytes.decode("utf-8", errors="replace")
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")
        logger.info("Cursor verify rc=%s stdout=%s stderr=%s",
                     proc.returncode, stdout_text[:200], stderr_text[:200])

        if proc.returncode == 0 and "invalid" not in stderr_text.lower():
            return True, ""

        lower_stderr = stderr_text.lower()
        if any(kw in lower_stderr for kw in ("unauthorized", "invalid")):
            return False, "Cursor API Key 无效，请检查是否正确"
        if any(kw in lower_stderr for kw in ("rate", "limit")):
            return False, "请求频率限制，请稍后再试"
        return False, "Cursor API Key 无效或已过期"

    except asyncio.TimeoutError:
        if proc:
            await _kill_proc(proc)
        return False, "Cursor API Key 验证超时，请稍后再试"
    except FileNotFoundError:
        return False, f"未找到 Cursor Agent 程序: {AGENT_CMD}"
    except Exception as e:
        if proc:
            await _kill_proc(proc)
        logger.error("Cursor key verification error: %s", e)
        return False, f"Cursor API Key 验证出错: {e}"


async def call_llm(
    api_key: str,
    prompt: str,
    timeout: float = 300,
    cwd: str | None = None,
    on_stream: Callable[[str], Awaitable[None] | None] | None = None,
) -> str:
    """Call the Cursor Agent CLI with a prompt and return the raw text output.
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
            shell_cmd = (
                f'"{AGENT_CMD}" --api-key "{api_key}" --trust --print < "{prompt_file}"'
            )
            logger.info("Prompt written to temp file (%d chars): %s", len(prompt), prompt_file)
            proc = await asyncio.create_subprocess_shell(
                shell_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_build_env(),
                cwd=cwd,
                **kwargs,
            )
        else:
            cmd = _base_cmd() + ["--api-key", api_key, "--trust", "--print", prompt]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_build_env(),
                cwd=cwd,
                **kwargs,
            )

        stdout_text, stderr_text = await _stream_process_output(
            proc,
            total_timeout=timeout,
            idle_timeout=max(300.0, min(timeout, 900.0)),
        )

        if proc.returncode != 0:
            logger.error("Cursor agent failed (rc=%d): %s", proc.returncode, stderr_text[:500])
            raise RuntimeError(f"Cursor agent error: {stderr_text[:200]}")

        return stdout_text

    except TimeoutError:
        if proc:
            await _kill_proc(proc)
        raise RuntimeError(f"Cursor agent timed out after {timeout}s")
    except FileNotFoundError as e:
        logger.error("FileNotFoundError in call_llm: %s (cwd=%s, agent=%s)", e, cwd, AGENT_CMD)
        if cwd and not os.path.isdir(cwd):
            raise RuntimeError(f"Review working directory not found: {cwd}")
        raise RuntimeError(f"Cursor Agent not found: {AGENT_CMD}")
    except OSError as e:
        logger.error("OSError in call_llm: %s (cwd=%s)", e, cwd)
        raise RuntimeError(f"Cursor agent OS error: {e}")
    finally:
        if prompt_file and os.path.exists(prompt_file):
            try:
                os.unlink(prompt_file)
            except OSError:
                pass

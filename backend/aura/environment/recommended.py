"""The curated "Recommended" list shown beside what is installed.

This is a product list, not detection or install logic: every entry names a
catalogue entry (`catalog.py`), which alone knows how a tool is probed and
whether, and how, AURA may install it. A tool the catalogue has no verified
installer for is listed as "not installable here" with its homepage, never
with an invented command.
"""

from __future__ import annotations

from typing import Any

#: (catalogue id, group, why it is recommended). Order is display order.
RECOMMENDED: tuple[tuple[str, str, str], ...] = (
    ("claude-code", "agent", "Anthropic's agentic coding assistant for the terminal."),
    ("codex-cli", "agent", "OpenAI's terminal coding agent."),
    ("gemini-cli", "agent", "Google's Gemini in the terminal, with a generous free tier."),
    ("opencode", "agent", "Open-source coding agent that works with many models, including free ones."),
    ("kilo-code", "agent", "Open-source coding agent with free-model support."),
    ("qwen-cli", "agent", "Qwen Code: an open-model coding agent."),
    ("cursor", "agent", "AI-first code editor."),
    ("ollama", "agent", "Run open models locally; a private inference runtime for your agents."),
    ("lm-studio", "agent", "Desktop app for running open models locally."),
    ("git", "dev", "Version control."),
    ("github-cli", "dev", "GitHub from the terminal."),
    ("vscode", "dev", "Popular code editor."),
    ("node", "dev", "JavaScript runtime."),
    ("python", "dev", "Python interpreter."),
    ("rust", "dev", "Rust toolchain."),
    ("go", "dev", "Go toolchain."),
    ("docker", "dev", "Containers; also the easiest way to run a private search gateway."),
    ("pnpm", "dev", "Fast JavaScript package manager."),
    ("bun", "dev", "All-in-one JavaScript runtime and toolkit."),
    ("playwright", "dev", "Browser automation and testing."),
)


def recommended_items() -> list[dict[str, Any]]:
    """The list joined with this machine's state: installed or not, and how.

    Presence comes from the catalogue probe (the same safe-probe boundary a
    scan uses); installability from `plan_install`, which is also what the
    install route runs, so what is offered here is exactly what would run.
    """
    from .catalog import catalog_entry
    from .install import is_plan, plan_install
    from .probe import probe_node

    out: list[dict[str, Any]] = []
    for catalog_id, group, why in RECOMMENDED:
        entry = catalog_entry(catalog_id)
        if entry is None:  # a list entry the catalogue no longer has is skipped, not guessed
            continue
        probe = probe_node(catalog_id)
        plan = plan_install(entry)
        item: dict[str, Any] = {
            "id": catalog_id,
            "name": entry.name,
            "group": group,
            "why": why,
            "summary": entry.summary,
            "homepage": entry.homepage,
            "installed": bool(probe.present),
            "version": probe.version,
        }
        if is_plan(plan):
            item.update(installable=True, privilege=plan.privilege, command=plan.command)
        else:
            item.update(installable=False, reason=plan.reason)
        out.append(item)
    return out

from starlette.testclient import TestClient

from aura.central_agent.mcp_context import ConfiguredMcpContextProvider
from aura.central_agent import mcp_context
from aura.api import server


class _LifecycleProbe(ConfiguredMcpContextProvider):
    def __init__(self):
        super().__init__({})
        self.closed = False

    def start(self):
        super().start()

    def close(self):
        self.closed = True
        super().close()


def test_normal_api_composition_injects_and_closes_configured_context_provider(
        monkeypatch, tmp_path):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "aura"))
    provider = _LifecycleProbe()
    monkeypatch.setattr(mcp_context, "configured_context_provider",
                        lambda _home: provider)

    app = server.create_app()
    assert app.state.agent._mcp_context_provider is provider
    with TestClient(app):
        assert provider._started is True
        assert provider.closed is False
    assert provider.closed is True

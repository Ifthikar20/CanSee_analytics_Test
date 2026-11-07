"""Thread mode runs turns on daemon threads and never strands a queued run.

A ThreadPoolExecutor's workers are joined at interpreter exit, so a
runserver reload waited for the runs in flight, and a run submitted
meanwhile failed with "cannot schedule new futures after interpreter
shutdown", leaving a queued, registered, heart-beaten run that held the
chat with 409 run_in_progress.
"""

import pytest

from apps.agent.models import AgentMessage, AgentRun
from apps.agent.runtime import dispatch
from apps.agent.runtime.registry import get_registry
from apps.agent.tests.runtime_support import *  # noqa: F403
from apps.agent.tests.runtime_support import make_chat, run_events, send


def test_run_threads_do_not_hold_the_interpreter_open():
    pool = dispatch.RunThreads(2)
    assert len(pool.threads) == 2
    assert all(t.daemon and t.is_alive() for t in pool.threads)


@pytest.mark.django_db(transaction=True)
@pytest.mark.usefixtures("no_title")
def test_a_run_that_cannot_be_handed_over_is_failed(fake_anthropic, user, website, settings,
                                                    monkeypatch):
    settings.AGENT_RUN_MODE = "thread"

    def shut_down():
        raise RuntimeError("can't create new thread at interpreter shutdown")

    monkeypatch.setattr(dispatch, "_get_pool", shut_down)
    chat = make_chat(user, website)

    started = send(chat)

    run = AgentRun.objects.get(id=started.run.id)
    msg = AgentMessage.objects.get(id=started.assistant_message.id)
    assert run.status == "failed" and run.error_code == "internal_error"
    assert msg.status == "failed"
    assert get_registry().get(run.id) is None
    assert run_events(run)[-1]["type"] == "run.failed"
    assert fake_anthropic.requests == []

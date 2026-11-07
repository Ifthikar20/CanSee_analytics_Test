"""Test-only builders for the agent API suites (never imported by app code)."""
from __future__ import annotations

import importlib
import sys
import types
import uuid
from datetime import timedelta

from django.utils import timezone
from rest_framework.test import APIClient

from apps.agent.models import AgentChat, AgentMessage, AgentRun

LIVE_MODULES = {
    "apps.agent.api.v1.live_views": (
        "SendMessageView", "RegenerateMessageView", "EditMessageView",
        "ContinueMessageView", "CancelRunView", "RunEventsView", "SwarmRerunView",
    ),
    "apps.agent.api.v1.stream": ("run_stream",),
}


def stand_in_missing_live_modules() -> list[str]:
    """Register placeholders for runtime-owned live modules that do not exist
    yet, so the agent URLconf can be imported. Returns the module names it
    stood in for (empty once the real modules are there)."""
    from django.http import HttpResponse
    from rest_framework.views import APIView

    stood_in = []
    for name, attrs in LIVE_MODULES.items():
        if name in sys.modules:
            continue
        try:
            importlib.import_module(name)
            continue
        except ModuleNotFoundError as exc:
            if exc.name != name:
                raise
        module = types.ModuleType(name)
        module.STAND_IN = True
        for attr in attrs:
            if attr == "run_stream":
                module.run_stream = lambda request, **kwargs: HttpResponse(status=501)
            else:
                setattr(module, attr, type(attr, (APIView,), {}))
        sys.modules[name] = module
        stood_in.append(name)
    return stood_in


def client_for(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


def data(resp):
    return resp.json()["data"]


def error(resp) -> dict:
    return resp.json()["error"]


def make_user(django_user_model, email: str, name: str = ""):
    return django_user_model.objects.create_user(
        email=email, password="x" * 16, full_name=name or email.split("@")[0],
        is_email_verified=True,
    )


def join_org(website, owner, members: dict) -> dict:
    """Move ``website`` into an organization and add ``members``
    ({user: role}). Returns {user: membership}."""
    from apps.accounts.models import Organization, OrganizationMember

    org = Organization.objects.create(
        name="Northwind Team", slug=f"northwind-{uuid.uuid4().hex[:8]}", owner=owner,
    )
    OrganizationMember.objects.create(organization=org, user=owner, role="owner")
    website.organization = org
    website.save(update_fields=["organization"])
    return {
        user: OrganizationMember.objects.create(organization=org, user=user, role=role)
        for user, role in members.items()
    }


def make_chat(user, website, snapshot, **fields) -> AgentChat:
    return AgentChat.objects.create(website=website, user=user, snapshot=snapshot, **fields)


def add_message(chat, *, parent=None, role="user", text=None, parts=None, age_minutes=None,
                **fields) -> AgentMessage:
    """A message node. ``age_minutes`` back-dates created_at (tree order)."""
    if parts is None:
        parts = [{"id": f"p_{uuid.uuid4().hex[:8]}", "type": "text", "request": 0,
                  "text": text or ""}]
    message = AgentMessage.objects.create(
        chat=chat, parent=parent, role=role, parts=parts,
        depth=(parent.depth + 1) if parent else 0, **fields,
    )
    if age_minutes is not None:
        created = timezone.now() - timedelta(minutes=age_minutes)
        AgentMessage.objects.filter(pk=message.pk).update(created_at=created)
        message.created_at = created
    return message


def add_run(chat, user_message, assistant_message, *, status="completed", **fields) -> AgentRun:
    return AgentRun.objects.create(
        chat=chat, user=chat.user, website=chat.website, user_message=user_message,
        assistant_message=assistant_message, status=status, **fields,
    )

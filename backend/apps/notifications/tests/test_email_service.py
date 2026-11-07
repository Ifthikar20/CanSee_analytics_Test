"""EmailService, now backed by django.core.mail.

The previous implementation imported the SendGrid SDK, which was never in
requirements, so every send raised ImportError, the broad except swallowed
it, and the method returned False forever. These tests pin the replacement
to the configured backend (locmem under config/settings/test.py) so a
regression to an uninstallable dependency fails loudly.
"""
from unittest.mock import patch

from django.core import mail

from apps.notifications.services.email_service import EmailService


class TestSendEmail:
    def test_sends_one_message_through_the_configured_backend(self):
        ok = EmailService.send_email(
            to="owner@example.com",
            subject="Weekly report",
            html_content="<p>Hello <strong>there</strong></p>",
        )
        assert ok is True
        assert len(mail.outbox) == 1

        msg = mail.outbox[0]
        assert msg.to == ["owner@example.com"]
        assert msg.subject == "Weekly report"
        # Plain-text body is derived from the HTML for clients that
        # refuse text/html.
        assert msg.body == "Hello there"
        html_alts = [c for c, t in msg.alternatives if t == "text/html"]
        assert html_alts == ["<p>Hello <strong>there</strong></p>"]

    def test_from_address_comes_from_settings_not_a_hardcode(self, settings):
        settings.DEFAULT_FROM_EMAIL = "noreply@cansee.ai"
        EmailService.send_email(
            to="owner@example.com", subject="s", html_content="<p>b</p>",
        )
        assert mail.outbox[0].from_email == "noreply@cansee.ai"

    def test_backend_failure_returns_false_instead_of_raising(self):
        with patch.object(
            mail.EmailMessage, "send", side_effect=ConnectionError("smtp down"),
        ):
            ok = EmailService.send_email(
                to="owner@example.com", subject="s", html_content="<p>b</p>",
            )
        assert ok is False
        assert len(mail.outbox) == 0


"""The event log CSV export is reachable, and its errors stay JSON.

DRF read ``?format=csv`` as a renderer override and answered 404 before the
view ran, because no renderer has the csv format.
"""
import uuid

from django.test import TestCase
from rest_framework.test import APIClient

from apps.analytics.tests.test_analytics import create_test_user, create_test_website


class EventLogCsvTest(TestCase):
    def setUp(self):
        self.user = create_test_user()
        self.website = create_test_website(self.user)
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_empty_export_has_only_the_header(self):
        resp = self.client.get(
            f"/api/v1/analytics/{self.website.id}/event-log/", {"format": "CSV"},
        )
        self.assertEqual(resp.status_code, 200)
        body = b"".join(resp.streaming_content).decode()
        self.assertEqual(len(body.splitlines()), 1)

    def test_unknown_website_is_a_json_404(self):
        resp = self.client.get(
            f"/api/v1/analytics/{uuid.uuid4()}/event-log/", {"format": "csv"},
        )
        self.assertEqual(resp.status_code, 404)
        self.assertTrue(resp["Content-Type"].startswith("application/json"))
        self.assertFalse(resp.json()["success"])

    def test_anonymous_export_is_refused(self):
        resp = APIClient().get(
            f"/api/v1/analytics/{self.website.id}/event-log/", {"format": "csv"},
        )
        self.assertEqual(resp.status_code, 401)

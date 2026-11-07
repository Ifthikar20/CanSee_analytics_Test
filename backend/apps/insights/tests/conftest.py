import os

import pytest


@pytest.fixture(scope="session")
def django_db_modify_db_settings():
    """Point the suite at the compose ``db`` service when run in a container.

    config.settings.test pins HOST=localhost; inside the web container the
    database is reachable as ``db`` instead. TEST_DB_HOST opts in.
    """
    from django.conf import settings

    host = os.environ.get("TEST_DB_HOST")
    if host:
        settings.DATABASES["default"]["HOST"] = host

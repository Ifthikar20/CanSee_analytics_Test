"""Models and migrations agree, so `makemigrations --check` passes.

Hand-named indexes in migrations that the models declared without a name,
and TimestampMixin's indexed created_at missing from some CreateModel
migrations, left pending RenameIndex/AlterField operations. The next
developer's makemigrations then bundled them into an unrelated migration.
"""
from django.apps import apps as django_apps
from django.db.migrations.autodetector import MigrationAutodetector
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.state import ProjectState


def test_no_model_change_is_missing_a_migration():
    loader = MigrationLoader(None, ignore_no_migrations=True)
    autodetector = MigrationAutodetector(
        loader.project_state(),
        ProjectState.from_apps(django_apps),
    )
    changes = autodetector.changes(graph=loader.graph)
    pending = {
        app: [op.describe() for migration in migrations for op in migration.operations]
        for app, migrations in changes.items()
    }
    assert pending == {}, f"run manage.py makemigrations: {pending}"

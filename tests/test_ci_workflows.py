from pathlib import Path


WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "python-app.yml"


def test_python_application_runs_for_release_branch():
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert 'branches: [ "main", "test_me", "avian-visitors" ]' in workflow
    assert 'branches: [ "main", "avian-visitors" ]' in workflow

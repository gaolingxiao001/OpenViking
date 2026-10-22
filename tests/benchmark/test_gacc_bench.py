import json
from types import SimpleNamespace

import pytest

from benchmark.gacc import adapters, core, records, report
from benchmark.gacc.run_eval import _effective_config, parse_args
from openviking.session.retention import RETENTION_MODE_TURN_BUDGET


def _write_jsonl(path, rows):
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    return path


def _row(*, goal_id="goal-1", context_id="ctx-1", questions=None, dataset="Loong"):
    return {
        "dataset": dataset,
        "context_id": context_id,
        "context": "alpha beta gamma delta epsilon zeta eta theta",
        "goal_id": goal_id,
        "goal": "Preserve Greek-letter facts needed for lookup questions.",
        "questions": questions
        or [
            {
                "question_id": f"{goal_id}-q1",
                "question": "Which Greek letters are present?",
                "gold_answer": "alpha through theta",
            }
        ],
    }


def test_load_gacc_jsonl_validates_required_shape(tmp_path):
    path = _write_jsonl(tmp_path / "gacc.jsonl", [_row()])

    bundles = core.load_gacc_jsonl(path)

    assert len(bundles) == 1
    assert bundles[0].dataset == "Loong"
    assert bundles[0].goal_id == "goal-1"
    assert bundles[0].questions[0].gold_answer == "alpha through theta"

    bad = _write_jsonl(tmp_path / "bad.jsonl", [{**_row(), "goal_id": ""}])
    with pytest.raises(ValueError, match="missing goal_id"):
        core.load_gacc_jsonl(bad)


def test_parse_budgets_and_budget_tokens_are_percent_based():
    assert core.parse_budgets("5,10,33") == (0.05, 0.10, 0.33)

    bundle = core.GACCBundle.from_mapping(_row())
    source_tokens = core.count_tokens(bundle.context)

    assert core.budget_tokens(bundle, 0.10) == max(1, int(source_tokens * 0.10))

    with pytest.raises(ValueError, match="range 1-100"):
        core.parse_budgets("0,10")


def test_parse_target_ratios_supports_no_compression_baseline():
    assert core.parse_target_ratios("-1,0.5,0.3") == (-1.0, 0.5, 0.3)
    assert core.target_condition_name(-1) == "no_compression"
    assert core.target_condition_name(0.5) == "ratio_0_5"
    assert core.target_display_label(0.3) == "0.3"

    with pytest.raises(ValueError, match="compression ratios"):
        core.parse_target_ratios("0,1")
    with pytest.raises(ValueError, match="duplicates"):
        core.parse_target_ratios("-1,0.5,0.5")


def test_artifact_paths_are_stable_and_condition_specific(tmp_path):
    bundle = core.GACCBundle.from_mapping(_row())
    question = bundle.questions[0]

    memory = core.memory_path(tmp_path, 0.05, bundle)
    compressed_answer = core.answer_path(tmp_path, "5%", 0.05, question.question_id)
    full_answer = core.answer_path(tmp_path, "full_context", None, question.question_id)

    assert memory == core.memory_path(tmp_path, 0.05, bundle)
    assert "5%" in str(memory)
    assert compressed_answer != full_answer
    assert full_answer.parent.name == "full_context"


@pytest.mark.asyncio
async def test_ov_compression_adapter_uses_session_retention_path(monkeypatch):
    def fail_compression_prompt(*args, **kwargs):
        raise AssertionError("ov adapter must not use the local GACC compression prompt")

    monkeypatch.setattr(core, "build_compression_prompt", fail_compression_prompt)

    class FakeVLM:
        model = "fake-model"
        calls = []

        async def get_completion_async(self, **kwargs):
            self.calls.append(kwargs)
            raise AssertionError("ov adapter must not call the compressor VLM directly")

    class FakeSession:
        def __init__(self, session_id):
            self.session_id = session_id
            self.added_messages = None
            self.commit_kwargs = None
            self._archives = SimpleNamespace(read_overview=self._read_overview)

        async def add_messages_async(self, messages):
            self.added_messages = messages
            return []

        async def commit_async(self, **kwargs):
            self.commit_kwargs = kwargs
            return {
                "status": "skipped",
                "task_id": None,
                "archive_uri": "viking://archive/test",
                "estimated_active_tokens": 2,
                "budget_exceeded": False,
            }

        async def get_session_context(self, token_budget):
            raise AssertionError("adapter must read explicit OV compression artifacts")

        async def _read_live_messages_strict(self):
            return [
                SimpleNamespace(
                    to_dict=lambda: {
                        "role": "user",
                        "parts": [{"type": "text", "text": "tail gamma"}],
                    }
                )
            ]

        async def _read_overview(self, archive_uri):
            assert archive_uri == "viking://archive/test"
            return "summary alpha beta"

    created = []

    async def session_factory(request, session_id, memory_policy):
        session = FakeSession(session_id)
        created.append((request, session_id, memory_policy, session))
        return session

    bundle = core.GACCBundle.from_mapping(_row())
    adapter = adapters.OVCompressionAdapter(
        FakeVLM(),
        model="fake-model",
        session_factory=session_factory,
    )

    baseline = await adapter.compress(
        adapters.CompressionRequest(
            bundle=bundle,
            target_ratio=-1,
            run_id="run-1",
            repeat_index=1,
        )
    )

    assert baseline.condition == "no_compression"
    assert baseline.final_messages == [{"role": "user", "content": bundle.context}]
    assert baseline.token_metrics["actual_ratio"] == pytest.approx(1.0)
    assert baseline.effective_options["adapter"] == "ov"

    compressed = await adapter.compress(
        adapters.CompressionRequest(
            bundle=bundle,
            target_ratio=0.5,
            run_id="run-1",
            repeat_index=1,
        )
    )

    assert compressed.condition == "ratio_0_5"
    assert compressed.final_messages == [
        {"role": "assistant", "content": "OpenViking summary:\nsummary alpha beta"},
        {"role": "user", "content": "tail gamma"},
    ]
    assert compressed.token_metrics["target_ratio"] == 0.5
    assert compressed.effective_options["model"] == "fake-model"
    assert compressed.effective_options["mode"] == "ov_session_retention"
    assert compressed.effective_options["retention"]["mode"] == RETENTION_MODE_TURN_BUDGET
    assert len(created) == 1
    _request, session_id, memory_policy, session = created[0]
    assert "goal-1" not in session_id
    assert memory_policy == {
        "self": {"enabled": False},
        "peer": {"enabled": False},
        "memory_types": [],
        "working_memory": {"enabled": True},
    }
    assert session.added_messages[0]["role"] == "user"
    assert "GACC goal" in session.added_messages[0]["parts"][0].text
    assert len(session.added_messages) == 2
    assert all(
        "Context ingestion complete." not in part.text
        for message in session.added_messages
        for part in message["parts"]
    )
    assert session.commit_kwargs["retention_mode"] == RETENTION_MODE_TURN_BUDGET
    target_tokens = core.budget_tokens(bundle, 0.5)
    retained_budget = max(1, int(target_tokens * 0.2))
    summary_budget = max(1, target_tokens - retained_budget)
    assert session.commit_kwargs["retained_message_token_budget"] == retained_budget
    assert session.commit_kwargs["summary_tokens"] == summary_budget
    assert session.commit_kwargs["enable_working_memory"] is True
    assert compressed.token_metrics["target_tokens"] == target_tokens
    assert compressed.token_metrics["retained_budget_tokens"] == retained_budget
    assert compressed.token_metrics["summary_budget_tokens"] == summary_budget
    assert compressed.token_metrics["summary_tokens"] == core.count_tokens("summary alpha beta")
    assert compressed.token_metrics["retained_tokens"] == core.count_tokens("tail gamma")
    assert compressed.effective_options["retention"]["retained_budget_ratio"] == 0.2
    assert compressed.effective_options["retention"]["summary_budget_ratio"] == 0.8
    assert compressed.effective_options["retention"]["summary_tokens"] == summary_budget
    assert compressed.effective_options["output_contract"] == "summary_plus_retained"
    assert compressed.effective_options["compressed"]["summary"] == "summary alpha beta"
    assert compressed.effective_options["compressed"]["retained"] == [
        {
            "role": "user",
            "parts": [{"type": "text", "text": "tail gamma"}],
        }
    ]
    assert compressed.effective_options["compressed"]["commit"] == {
        "status": "skipped",
        "task_id": None,
        "archive_uri": "viking://archive/test",
        "estimated_active_tokens": 2,
        "budget_exceeded": False,
    }


def test_sqlite_record_layer_tracks_repeats_and_conditions(tmp_path):
    db_path = tmp_path / "gacc.sqlite"
    run_metadata = {
        "run_id": "run-1",
        "input_sha256": "abc",
        "seed": 7,
        "effective_config": {"reader_model": "fake"},
    }

    with records.connect(db_path) as conn:
        records.record_run(conn, run_metadata)
        records.record_result(
            conn,
            {
                "run_id": "run-1",
                "dataset": "Loong",
                "context_id": "ctx-1",
                "goal_id": "goal-1",
                "question_id": "q1",
                "condition": "no_compression",
                "target_ratio": -1,
                "actual_ratio": 1.0,
                "adapter": "ov",
                "repeat_index": 1,
                "answer_status": "ok",
                "judge_status": "ok",
                "grade": "CORRECT",
                "source_tokens": 10,
                "target_tokens": 10,
                "final_tokens": 10,
                "latency_ms": 12.5,
                "artifact_paths": {"answer": "answers/a.json"},
                "effective_options": {"adapter": "ov"},
            },
        )
        summary = records.summarize_results(conn)

    assert summary["conditions"]["no_compression"]["overall"]["planned"] == 1
    assert summary["conditions"]["no_compression"]["overall"]["accuracy"] == 1.0
    assert summary["conditions"]["no_compression"]["datasets"]["Loong"]["correct"] == 1


def test_effective_config_records_vlm_params_without_secret_values():
    class FakeConfig:
        provider = "openai"
        api_base = "https://example.test/v1"
        model = "reader-model"
        temperature = 0.2
        max_tokens = 4096
        api_key = "secret"

    args = type(
        "Args",
        (),
        {
            "adapter": "ov",
            "compression_ratios": (-1.0, 0.5),
            "repeats": 2,
            "seed": 42,
            "smoke": False,
        },
    )()

    config = _effective_config(args, FakeConfig(), FakeConfig(), FakeConfig())

    assert "provider" not in config
    assert "api_base" not in config
    assert "max_tokens" not in config
    assert "temperature" not in config
    assert config["vlm"]["reader"]["provider"] == "openai"
    assert config["vlm"]["reader"]["api_base"] == "https://example.test/v1"
    assert config["vlm"]["reader"]["model"] == "reader-model"
    assert config["vlm"]["reader"]["temperature"] == 0.2
    assert config["vlm"]["reader"]["max_tokens"] == 4096
    assert config["vlm"]["reader"]["api_key_configured"] is True
    assert "secret" not in json.dumps(config)


def test_run_eval_cli_exposes_temperature_as_only_model_control(tmp_path):
    args = parse_args(
        [
            "--input",
            str(tmp_path / "gacc.jsonl"),
            "--temperature",
            "0",
        ]
    )

    assert args.temperature == 0
    for removed_name in (
        "provider",
        "model",
        "api_base",
        "api_key",
        "max_tokens",
        "compressor_provider",
        "compressor_model",
        "compressor_api_base",
        "compressor_api_key",
        "reader_provider",
        "reader_model",
        "reader_api_base",
        "reader_api_key",
        "judge_provider",
        "judge_model",
        "judge_api_base",
        "judge_api_key",
    ):
        assert not hasattr(args, removed_name)


def test_smoke_sampling_is_seeded_and_uses_no_compression_only():
    bundles = [core.GACCBundle.from_mapping(_row(goal_id=f"goal-{idx}")) for idx in range(6)]

    first = core.select_smoke_bundles(bundles, sample_size=3, seed=42)
    second = core.select_smoke_bundles(bundles, sample_size=3, seed=42)

    assert [bundle.goal_id for bundle in first] == [bundle.goal_id for bundle in second]
    assert len(first) == 3


def test_html_report_renders_condition_comparison(tmp_path):
    db_path = tmp_path / "gacc.sqlite"
    with records.connect(db_path) as conn:
        records.record_run(conn, {"run_id": "run-1", "effective_config": {}})
        for condition, target_ratio, grade in [
            ("no_compression", -1, "CORRECT"),
            ("ratio_0_5", 0.5, "INCORRECT"),
        ]:
            records.record_result(
                conn,
                {
                    "run_id": "run-1",
                    "dataset": "Loong",
                    "context_id": "ctx-1",
                    "goal_id": "goal-1",
                    "question_id": f"{condition}-q1",
                    "condition": condition,
                    "target_ratio": target_ratio,
                    "actual_ratio": 1.0 if target_ratio == -1 else 0.5,
                    "adapter": "ov",
                    "repeat_index": 1,
                    "answer_status": "ok",
                    "judge_status": "ok",
                    "grade": grade,
                    "source_tokens": 10,
                    "target_tokens": 10 if target_ratio == -1 else 5,
                    "final_tokens": 10 if target_ratio == -1 else 5,
                    "latency_ms": 1.0,
                    "artifact_paths": {},
                    "effective_options": {},
                },
            )
        metrics = records.summarize_results(conn)

    output = report.write_html_report(tmp_path / "report.html", metrics)

    assert output.exists()
    html = output.read_text(encoding="utf-8")
    assert "no_compression" in html
    assert "ratio_0_5" in html
    assert "Loong" in html


def test_report_summarizes_full_and_compressed_conditions(tmp_path):
    bundles = [
        core.GACCBundle.from_mapping(
            _row(
                questions=[
                    {
                        "question_id": "q1",
                        "question": "Q1",
                        "gold_answer": "A1",
                    },
                    {
                        "question_id": "q2",
                        "question": "Q2",
                        "gold_answer": "A2",
                    },
                ]
            )
        )
    ]

    core.write_json(
        core.memory_path(tmp_path, 0.05, bundles[0]),
        {
            "status": "ok",
            "retained_tokens": 3,
            "budget_tokens": 4,
            "source_tokens": 8,
        },
    )
    for condition, ratio, grades in [
        ("full_context", None, ["CORRECT", "CORRECT"]),
        ("5%", 0.05, ["CORRECT", "INCORRECT"]),
    ]:
        for question, grade in zip(bundles[0].questions, grades, strict=True):
            core.write_json(
                core.judgment_path(tmp_path, condition, question.question_id),
                {
                    "status": "ok",
                    "grade": grade,
                    "condition": condition,
                    "ratio": ratio,
                    "question_id": question.question_id,
                },
            )

    report = core.build_report(
        tmp_path,
        bundles,
        budgets=(0.05,),
        include_full_context=True,
        metadata={"compressor_model": "ov-wm"},
    )

    assert report["goals"] == 1
    assert report["questions"] == 2
    assert report["conditions"]["full_context"]["overall"]["micro_accuracy"] == 1.0
    assert report["conditions"]["full_context"]["overall"]["macro_accuracy"] == 1.0
    assert report["conditions"]["5%"]["overall"]["micro_accuracy"] == 0.5
    assert report["conditions"]["5%"]["overall"]["macro_accuracy"] == 0.0
    assert report["compression_usage"]["5%"]["valid"] == 1


def test_extract_judge_grade_accepts_json_and_rejects_bad_values():
    assert core.extract_judge_grade('{"grade":"CORRECT","reason":"ok"}') == (
        "CORRECT",
        "ok",
    )
    assert core.extract_judge_grade('```json\n{"grade":"INCORRECT"}\n```') == (
        "INCORRECT",
        "",
    )

    with pytest.raises(ValueError, match="invalid judge grade"):
        core.extract_judge_grade('{"grade":"PARTIAL"}')

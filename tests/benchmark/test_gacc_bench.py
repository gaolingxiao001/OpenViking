import json
from types import SimpleNamespace

import pytest

from benchmark.gacc import adapters, core, records, report, run_eval
from benchmark.gacc.run_eval import _effective_config, build_compression_adapter, parse_args
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


def _locomo_row():
    return {
        "dataset": "locomo_multisession",
        "context_id": "conv-26",
        "sample_id": "conv-26",
        "conversation": {
            "speaker_a": "Alice",
            "speaker_b": "Bob",
            "session_1": [
                {"speaker": "Alice", "text": "Hi Bob"},
                {
                    "speaker": "Bob",
                    "text": "Hello Alice",
                    "blip_caption": "Bob is waving",
                },
            ],
            "session_1_date_time": "1:56 pm on 8 May, 2023",
            "session_2": [
                {"speaker": "Alice", "text": "Remember the cafe plan?"},
            ],
            "session_2_date_time": "8:00 pm on 9 May, 2023",
        },
        "qa": [
            {
                "question": "Who said hello?",
                "answer": "Bob",
                "category": "1",
                "evidence": ["D1:2"],
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


def test_load_gacc_jsonl_accepts_locomo_dataset_subsets(tmp_path):
    path = _write_jsonl(
        tmp_path / "locomo.jsonl",
        [
            _row(goal_id="goal-1", context_id="ctx-1", dataset="LoCoMo"),
            _row(goal_id="goal-2", context_id="ctx-2", dataset="locomo_multisession"),
        ],
    )

    bundles = core.load_gacc_jsonl(path)

    assert [bundle.dataset for bundle in bundles] == ["LoCoMo", "LoCoMo-multisession"]


def test_load_gacc_jsonl_builds_locomo_multiturn_conversation(tmp_path):
    path = _write_jsonl(tmp_path / "locomo.jsonl", [_locomo_row()])

    bundle = core.load_gacc_jsonl(path)[0]

    assert bundle.dataset == "LoCoMo-multisession"
    assert bundle.context_id == "conv-26"
    assert bundle.goal_id == "conv-26"
    assert bundle.goal == "Answer questions about the LoCoMo conversation."
    assert [question.question_id for question in bundle.questions] == ["conv-26_qa0"]
    assert bundle.questions[0].gold_answer == "Bob"
    assert [turn.role for turn in bundle.turns] == ["user", "assistant", "user"]
    assert [turn.speaker for turn in bundle.turns] == ["Alice", "Bob", "Alice"]
    assert [turn.session_key for turn in bundle.turns] == ["session_1", "session_1", "session_2"]
    assert bundle.turns[0].content == "[Alice]: Hi Bob"
    assert bundle.turns[1].content == (
        "[Bob]: Hello Alice\n(attached image; image description: Bob is waving)"
    )
    assert "session_1 (1:56 pm on 8 May, 2023)" in bundle.context
    assert "[Bob]: Hello Alice" in bundle.context


def test_load_gacc_jsonl_rejects_unknown_dataset(tmp_path):
    path = _write_jsonl(tmp_path / "bad-dataset.jsonl", [_row(dataset="unknown-bench")])

    with pytest.raises(ValueError, match="unsupported dataset"):
        core.load_gacc_jsonl(path)


def test_budget_tokens_uses_source_ratio():
    bundle = core.GACCBundle.from_mapping(_row())
    source_tokens = core.count_tokens(bundle.context)

    assert core.budget_tokens(bundle, 0.10) == max(1, int(source_tokens * 0.10))


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
    compressed_answer = run_eval.answer_artifact_path(
        tmp_path,
        condition="ratio_0_3",
        ratio=0.3,
        repeat_index=1,
        question_id=question.question_id,
    )
    full_answer = run_eval.answer_artifact_path(
        tmp_path,
        condition="no_compression",
        ratio=-1,
        repeat_index=1,
        question_id=question.question_id,
    )
    assert compressed_answer != full_answer
    assert full_answer.parent.parent.name == "no_compression"


@pytest.mark.asyncio
async def test_ov_compression_adapter_uses_session_retention_path():
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
    assert session.commit_kwargs["keep_recent_turn_count"] == 10_000
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
    assert compressed.effective_options["retention"]["keep_recent_turn_count"] == 10_000
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


@pytest.mark.asyncio
async def test_ov_compression_adapter_keeps_live_messages_when_commit_has_no_archive():
    class FakeVLM:
        model = "fake-model"

        async def get_completion_async(self, **kwargs):
            raise AssertionError("ov adapter must not call the compressor VLM directly")

    class FakeSession:
        def __init__(self):
            self._archives = SimpleNamespace(read_overview=self._read_overview)

        async def add_messages_async(self, messages):
            return []

        async def commit_async(self, **kwargs):
            return {
                "status": "skipped",
                "task_id": None,
                "archive_uri": None,
                "archived": False,
                "reason": "all_within_keep_window",
                "estimated_active_tokens": 123,
                "budget_exceeded": True,
            }

        async def _read_live_messages_strict(self):
            return [
                SimpleNamespace(
                    to_dict=lambda: {
                        "role": "assistant",
                        "parts": [{"type": "text", "text": "SOURCE_CONTEXT:\nlarge tail"}],
                    }
                )
            ]

        async def _read_overview(self, archive_uri):
            raise AssertionError("no archive overview should be read without archive_uri")

    async def session_factory(request, session_id, memory_policy):
        return FakeSession()

    bundle = core.GACCBundle.from_mapping(_row())
    adapter = adapters.OVCompressionAdapter(
        FakeVLM(),
        model="fake-model",
        session_factory=session_factory,
    )

    compressed = await adapter.compress(
        adapters.CompressionRequest(
            bundle=bundle,
            target_ratio=0.3,
            run_id="run-1",
            repeat_index=1,
        )
    )

    assert compressed.final_messages == [
        {"role": "assistant", "content": "SOURCE_CONTEXT:\nlarge tail"}
    ]
    assert compressed.effective_options["compressed"]["summary"] == ""
    assert compressed.effective_options["compressed"]["retained"] == [
        {
            "role": "assistant",
            "parts": [{"type": "text", "text": "SOURCE_CONTEXT:\nlarge tail"}],
        }
    ]
    assert compressed.effective_options["compressed"]["commit"]["archive_uri"] is None
    assert compressed.effective_options["compressed"]["commit"]["reason"] == (
        "all_within_keep_window"
    )


def test_ov_session_messages_preserve_locomo_turns():
    bundle = core.GACCBundle.from_mapping(_locomo_row())

    messages = adapters.OVCompressionAdapter._session_messages(bundle)

    assert [message["role"] for message in messages] == ["user", "assistant", "user"]
    assert [message["message_kind"] for message in messages] == [
        "user_query",
        "assistant_step",
        "user_query",
    ]
    assert [message["turn_id"] for message in messages] == [
        "session_1:0",
        "session_1:1",
        "session_2:0",
    ]
    assert [message["created_at"] for message in messages] == [
        "1:56 pm on 8 May, 2023",
        "1:56 pm on 8 May, 2023",
        "8:00 pm on 9 May, 2023",
    ]
    assert messages[0]["parts"][0].text == (
        "LoCoMo goal: Answer questions about the LoCoMo conversation.\n\n"
        "session_1 (1:56 pm on 8 May, 2023)\n[Alice]: Hi Bob"
    )
    assert "[Bob]: Hello Alice" in messages[1]["parts"][0].text
    assert "SOURCE_CONTEXT" not in messages[1]["parts"][0].text


def test_ov_session_messages_keep_gacc_context_as_single_assistant_step():
    bundle = core.GACCBundle.from_mapping(
        {
            **_row(),
            "context": "\n".join(f"fact {index}: {'x' * 80}" for index in range(120)),
        }
    )

    messages = adapters.OVCompressionAdapter._session_messages(bundle)

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert [message["message_kind"] for message in messages] == [
        "user_query",
        "assistant_step",
    ]
    assert "GACC goal" in messages[0]["parts"][0].text
    assert messages[1]["parts"][0].text.startswith("SOURCE_CONTEXT:\n")
    assert "SOURCE_CONTEXT_CHUNK" not in messages[1]["parts"][0].text
    assert "fact 119:" in messages[1]["parts"][0].text


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
            "--adapter",
            "codex-local-summary",
        ]
    )

    assert args.temperature == 0
    assert args.adapter == "codex-local-summary"
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


def test_run_eval_builds_selected_codex_local_summary_adapter(tmp_path):
    class FakeVLM:
        model = "fake-model"

    args = parse_args(
        [
            "--input",
            str(tmp_path / "gacc.jsonl"),
            "--adapter",
            "codex-local-summary",
        ]
    )

    adapter = build_compression_adapter(args, FakeVLM(), tmp_path)

    assert isinstance(adapter, adapters.CodexLocalSummaryAdapter)
    assert adapter.model == "fake-model"


@pytest.mark.asyncio
async def test_codex_local_summary_adapter_uses_codex_prompt_and_retains_recent_user_tail():
    long_context = "head-alpha " + ("middle facts " * 90000) + "tail-omega"
    bundle = core.GACCBundle.from_mapping({**_row(), "context": long_context})

    class FakeVLM:
        model = "fake-model"

        def __init__(self):
            self.calls = []

        async def get_completion_async(self, **kwargs):
            self.calls.append(kwargs)
            if kwargs.get("max_tokens") is None:
                return SimpleNamespace(content="summary " * 50000)
            return SimpleNamespace(content="summary alpha beta")

    vlm = FakeVLM()
    adapter = adapters.CodexLocalSummaryAdapter(vlm, model=vlm.model)

    compressed = await adapter.compress(
        adapters.CompressionRequest(
            bundle=bundle,
            target_ratio=0.3,
            run_id="run-1",
            repeat_index=1,
        )
    )

    target_tokens = core.budget_tokens(bundle, 0.3)
    retained_budget = max(1, int(target_tokens * 0.2))
    summary_budget = max(1, target_tokens - retained_budget)

    assert compressed.condition == "ratio_0_3"
    assert compressed.final_messages[0]["role"] == "assistant"
    assert compressed.final_messages[1]["role"] == "user"
    assert compressed.final_messages[0]["content"] == "Codex local summary:\nsummary alpha beta"
    assert "tail-omega" in compressed.final_messages[1]["content"]
    assert "head-alpha" not in compressed.final_messages[1]["content"]
    assert compressed.token_metrics["retained_budget_tokens"] == retained_budget
    assert compressed.token_metrics["summary_budget_tokens"] == summary_budget
    assert compressed.token_metrics["target_tokens"] == target_tokens
    assert compressed.effective_options["adapter"] == "codex-local-summary"
    assert compressed.effective_options["mode"] == "codex_local_summarization"
    assert compressed.effective_options["retention"]["retained_budget_ratio"] == 0.2
    assert compressed.effective_options["retention"]["summary_budget_ratio"] == 0.8
    assert (
        compressed.effective_options["retention"]["retained_message_token_budget"]
        == retained_budget
    )
    assert compressed.effective_options["retention"]["summary_tokens"] == summary_budget
    assert compressed.effective_options["output_contract"] == "summary_plus_retained"
    assert compressed.raw_response == "summary alpha beta"
    assert len(vlm.calls) == 2
    assert vlm.calls[0]["max_tokens"] is None
    assert vlm.calls[1]["max_tokens"] == summary_budget
    assert "CONTEXT CHECKPOINT COMPACTION" in vlm.calls[0]["prompt"]
    assert long_context in vlm.calls[0]["prompt"]


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


def test_sqlite_reports_all_questions_correct_goal_accuracy(tmp_path):
    with records.connect(tmp_path / "records.sqlite") as conn:
        for question_id, grade in [("q1", "CORRECT"), ("q2", "INCORRECT")]:
            records.record_result(conn, _result_row(question_id=question_id, grade=grade))
        summary = records.summarize_results(conn)["conditions"]["ratio_0_3"]["overall"]
    assert summary["accuracy"] == 0.5
    assert summary["macro_accuracy"] == 0.0


def test_macro_accuracy_counts_conditions_as_separate_evaluations(tmp_path):
    with records.connect(tmp_path / "records.sqlite") as conn:
        records.record_result(conn, _result_row())
        records.record_result(
            conn,
            _result_row(condition="no_compression", target_ratio=-1, grade="INCORRECT"),
        )
        summary = records.summarize_results(conn)["overall"]
    assert summary["goals_planned"] == 2
    assert summary["macro_accuracy"] == 0.5


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


def test_locomo_filters_adversarial_questions_without_renumbering(tmp_path):
    row = _locomo_row()
    row["qa"] = [
        {"category": 5, "question": "Unanswerable?"},
        {"category": "5", "question": "Also unanswerable?"},
        {"category": 1, "question": "How many?", "answer": 0},
    ]
    path = tmp_path / "locomo.json"
    path.write_text("\n  " + json.dumps([row]), encoding="utf-8")

    bundle = core.load_gacc_jsonl(path)[0]

    assert [(q.question_id, q.gold_answer) for q in bundle.questions] == [("conv-26_qa2", "0")]


def test_locomo_dates_are_visible_in_compression_messages():
    bundle = core.GACCBundle.from_mapping(_locomo_row())
    messages = adapters.OVCompressionAdapter._session_messages(bundle)

    assert "8 May, 2023" in messages[0]["parts"][0].text
    assert "9 May, 2023" in messages[-1]["parts"][0].text


@pytest.mark.asyncio
async def test_codex_local_keeps_only_real_user_turns_for_locomo():
    bundle = core.GACCBundle.from_mapping(_locomo_row())
    vlm = SimpleNamespace(get_completion_async=_short_summary)
    adapter = adapters.CodexLocalSummaryAdapter(vlm)

    result = await adapter.compress(adapters.CompressionRequest(bundle, 0.9, "test", 1))

    retained = result.final_messages[1:]
    assert retained and all(message["role"] == "user" for message in retained)
    assert "Bob is waving" not in core.final_messages_to_context(retained)
    prompt = adapter._build_compaction_prompt(bundle)
    assert "<ASSISTANT_MESSAGE>" in prompt
    assert "8 May, 2023" in prompt


async def _short_summary(**kwargs):
    return "short"


@pytest.mark.asyncio
async def test_codex_local_rejects_over_budget_retry():
    async def oversized(**kwargs):
        return "x" * 1000

    adapter = adapters.CodexLocalSummaryAdapter(SimpleNamespace(get_completion_async=oversized))
    with pytest.raises(RuntimeError, match="budget"):
        await adapter._complete_summary("prompt", 10)


@pytest.mark.asyncio
async def test_ov_missing_archive_summary_is_not_a_success():
    async def missing_overview(archive_uri):
        return ""

    async def live():
        return []

    session = SimpleNamespace(
        _archives=SimpleNamespace(read_overview=missing_overview),
        _read_live_messages_strict=live,
    )
    adapter = adapters.OVCompressionAdapter(None)
    with pytest.raises(RuntimeError, match="summary"):
        await adapter._read_compressed_artifacts(session, {"archive_uri": "viking://archive"})


@pytest.mark.asyncio
async def test_answer_and_judge_do_not_reuse_previous_calls(tmp_path):
    answers = iter(["old answer", "new answer"])
    judgments = iter(['{"grade":"CORRECT"}', '{"grade":"INCORRECT"}'])

    async def reader_call(**kwargs):
        return next(answers)

    async def judge_call(**kwargs):
        return next(judgments)

    bundle = core.GACCBundle.from_mapping(_row())
    question = bundle.questions[0]
    compression = await adapters.CodexLocalSummaryAdapter(None).compress(
        adapters.CompressionRequest(bundle, -1, "test", 1)
    )
    for _ in range(2):
        path = await run_eval.answer_question(
            SimpleNamespace(get_completion_async=reader_call),
            "model",
            bundle,
            question,
            compression,
            tmp_path,
            repeat_index=1,
        )
        judgment = await run_eval.judge_answer(
            SimpleNamespace(get_completion_async=judge_call),
            "model",
            bundle,
            question,
            compression,
            tmp_path,
            repeat_index=1,
            answer_path=path,
        )

    assert core.read_json(path)["answer"] == "new answer"
    assert core.read_json(judgment)["grade"] == "INCORRECT"


def _result_row(**overrides):
    return {
        "run_id": "r1",
        "dataset": "Loong",
        "context_id": "c1",
        "goal_id": "g1",
        "question_id": "q1",
        "condition": "ratio_0_3",
        "target_ratio": 0.3,
        "adapter": "ov",
        "repeat_index": 1,
        "answer_status": "ok",
        "judge_status": "ok",
        "grade": "CORRECT",
        **overrides,
    }


def test_records_survive_later_failure(tmp_path):
    path = tmp_path / "records.sqlite"
    with pytest.raises(RuntimeError):
        with records.connect(path) as conn:
            records.record_run(conn, {"run_id": "r1"})
            records.record_result(conn, _result_row())
            raise RuntimeError("later failure")

    with records.connect(path) as conn:
        assert records.summarize_results(conn)["overall"]["planned"] == 1
        assert conn.execute("SELECT count(*) FROM runs").fetchone()[0] == 1


def test_report_separates_methods_and_filters_runs(tmp_path):
    with records.connect(tmp_path / "records.sqlite") as conn:
        for run_id, adapter, grade in [
            ("r1", "ov", "CORRECT"),
            ("r2", "codex-local-summary", "INCORRECT"),
        ]:
            records.record_run(conn, {"run_id": run_id})
            records.record_result(conn, _result_row(run_id=run_id, adapter=adapter, grade=grade))
        metrics = records.summarize_results(conn)
        filtered = records.summarize_results(conn, run_id="r1")

    assert metrics["methods"]["ov"]["conditions"]["ratio_0_3"]["overall"]["accuracy"] == 1
    assert (
        metrics["methods"]["codex-local-summary"]["conditions"]["ratio_0_3"]["overall"]["accuracy"]
        == 0
    )
    assert [row["run_id"] for row in filtered["runs"]] == ["r1"]
    rendered = report.write_html_report(tmp_path / "report.html", metrics).read_text()
    assert "<td>ov</td>" in rendered
    assert "<td>codex-local-summary</td>" in rendered


def test_smoke_defaults_to_three_repeats(tmp_path):
    args = parse_args(["--input", str(tmp_path / "input.jsonl"), "--smoke"])
    assert args.repeats == 3


def test_smoke_reports_answer_and_grade_variation(tmp_path):
    with records.connect(tmp_path / "records.sqlite") as conn:
        for index, answer, grade in [(1, "yes", "CORRECT"), (2, "no", "INCORRECT")]:
            records.record_result(
                conn,
                _result_row(
                    condition="no_compression",
                    target_ratio=-1,
                    repeat_index=index,
                    answer=answer,
                    grade=grade,
                ),
            )
        variance = records.summarize_results(conn)["variance"]
    assert variance["grade_changed_questions"] == 1
    assert variance["answer_changed_questions"] == 1
    assert variance["recommended_repeats"] == 5


@pytest.mark.asyncio
async def test_runner_records_compression_failure_and_continues(tmp_path, monkeypatch):
    path = _write_jsonl(tmp_path / "input.jsonl", [_row()])
    args = parse_args(
        [
            "--input",
            str(path),
            "--output",
            str(tmp_path / "output"),
            "--run-id",
            "test",
            "--compression-ratios",
            "0.3,-1",
        ]
    )
    vlm = SimpleNamespace(
        model="test",
        provider="openai",
        api_base=None,
        temperature=0,
        max_tokens=None,
        api_key=None,
        is_available=lambda: True,
        get_completion_async=_short_summary,
    )
    monkeypatch.setattr(run_eval, "load_vlm_config", lambda args: vlm)

    class FailingAdapter(adapters.CodexLocalSummaryAdapter):
        async def compress(self, request):
            if request.target_ratio != -1:
                raise RuntimeError("compression failure")
            return await super().compress(request)

    monkeypatch.setattr(run_eval, "build_compression_adapter", lambda *args: FailingAdapter(vlm))
    monkeypatch.setattr(core, "extract_judge_grade", lambda response: ("CORRECT", ""))

    metrics = await run_eval.run(args)

    assert metrics["overall"]["planned"] == 2
    assert metrics["overall"]["failed"] == 1
    assert metrics["overall"]["correct"] == 1
    assert (args.output / "runs" / "test" / "reports" / "metrics.json").exists()


@pytest.mark.asyncio
async def test_ov_session_uses_benchmark_temperature(tmp_path):
    from openviking_cli.utils.config import VLMConfig, get_openviking_config

    config = VLMConfig.model_validate(get_openviking_config().vlm.model_dump(mode="python"))
    config.temperature = 0.123
    adapter = adapters.OVCompressionAdapter(config, state_root=tmp_path / "ov")
    request = adapters.CompressionRequest(
        core.GACCBundle.from_mapping(_row()), 0.3, "temperature-test", 1
    )
    try:
        session = await adapter._create_session(
            request, session_id="temperature-test", memory_policy=adapter._MEMORY_POLICY
        )
        effective = await session._get_vlm_config()
        assert effective.temperature == pytest.approx(0.123)
    finally:
        await adapter.close()
        config.close()

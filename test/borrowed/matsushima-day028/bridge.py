"""Bridge to the borrowed Day 028 code (matsushima_a, ai-100days @ 2a325e42bf91).

This file is ours. It contains none of the borrowed code: run.mjs downloads the original
files into a temp folder, verifies their sha256, and passes that folder here. We import the
original modules from it so that the extraction and the scoring are literally the author's.

  python -I bridge.py <src_dir> extract          -> JSON on stdout
  python -I bridge.py <src_dir> score < in.json  -> JSON on stdout

extract: for every conversation, the stream of extracted facts in turn order, produced by the
  author's own process_conversation_facts() (memory_methods.py) — the same extraction that
  feeds the author's MutatingSummaryMemory and AppendOnlyMemory. Also the 24 QUESTIONS and the
  author's own Mutating / AppendOnly answers and verdicts, so the results can sit side by side.
score: [{"gold": ..., "value": ...}] -> [bool], using the author's fuzzy_match()
  (run_experiment.py) unchanged.
"""
import json
import sys

CATEGORY_ORDER = ["home_city", "job", "favorite_food", "pet"]  # order process_conversation_facts walks a turn


def main():
    src_dir, mode = sys.argv[1], sys.argv[2]
    sys.path.insert(0, src_dir)
    from datasets import CONVERSATIONS, QUESTIONS  # noqa: E402  (borrowed, fetched at run time)
    from memory_methods import (  # noqa: E402
        process_conversation_facts, MutatingSummaryMemory, AppendOnlyMemory,
    )
    from run_experiment import fuzzy_match  # noqa: E402

    if mode == "score":
        items = json.load(sys.stdin)
        json.dump([bool(fuzzy_match(i["gold"], i["value"])) for i in items], sys.stdout)
        return

    if mode != "extract":
        raise SystemExit(f"unknown mode {mode}")

    convs = []
    originals = {}
    for conv in CONVERSATIONS:
        _, history = process_conversation_facts(conv["turns"])
        events = []
        for cat in CATEGORY_ORDER:
            for turn_id, value in history.get(cat, []):
                events.append({"turn": turn_id, "category": cat, "value": value})
        events.sort(key=lambda e: (e["turn"], CATEGORY_ORDER.index(e["category"])))
        convs.append({"id": conv["id"], "person": conv["person"], "turns": len(conv["turns"]), "events": events})
        originals[conv["id"]] = (MutatingSummaryMemory(conv["turns"]), AppendOnlyMemory(conv["turns"]))

    questions = []
    for q in QUESTIONS:
        mut, app = originals[q["conv_id"]]
        mut_ans = mut.answer(q["category"], q["type"])
        app_ans = app.answer(q["category"], q["type"])
        questions.append({
            **q,
            "orig_mutating": {"value": mut_ans, "correct": bool(fuzzy_match(q["gold"], mut_ans))},
            "orig_append_only": {"value": app_ans, "correct": bool(fuzzy_match(q["gold"], app_ans))},
        })

    json.dump({"conversations": convs, "questions": questions}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

---
name: soup
description: >
  Fine-tune, post-train and evaluate open-weight LLMs from one YAML config using the
  Soup CLI (`soup-cli`, Apache-2.0). Covers the decide-before-you-train gate
  (`soup advise`), SFT and preference training (DPO / ORPO / SimPO / KTO), QLoRA on
  small GPUs, layer streaming for large models on tiny VRAM, evaluation and the
  SHIP / DON'T SHIP verdict, plus export to GGUF / ONNX / AWQ / GPTQ and local serving
  with an OpenAI-compatible API. Use when asked to fine-tune, post-train, LoRA-tune,
  distil, quantize, evaluate or self-host an open-weight model, or to judge whether
  fine-tuning is the right answer at all versus prompt engineering or RAG.
---

# Soup — LLM fine-tuning and post-training

`soup` is a Python CLI that drives fine-tuning from a single `soup.yaml`. One config,
one command; no SSH, no bespoke training script.

Upstream: https://github.com/MakazhanAlpamys/Soup · PyPI `soup-cli` · Apache-2.0.
Provenance and the group decision to reference rather than vendor: `soup-UPSTREAM.md`.

## Before anything else: is fine-tuning even the answer?

Most "we should fine-tune this" requests are better served by a better prompt or by
retrieval. Soup ships the gate as a first-class command — **run it before proposing a
training run**:

```bash
soup advise    # -> PROMPT_ENG / RAG / SFT / DPO / GRPO
```

Fine-tuning teaches _form, format and behaviour_. It is a poor and expensive way to
teach _facts_ — facts belong in RAG, or in `soup edit` (ROME/MEMIT knowledge editing)
which patches a fact without retraining. Say so plainly rather than starting a GPU run.

## Install

Python **3.10–3.12** only (the package pins `<3.13`; on 3.13+ the install fails).

```bash
pip install soup-cli              # light CLI: config, planning, cost, registry
pip install "soup-cli[train]"     # + torch/transformers/peft/trl/datasets/bitsandbytes
soup doctor                       # verify GPU, deps, versions before trusting anything
```

Bare `soup-cli` pulls only seven small deps (typer, rich, pydantic, pyyaml,
huggingface-hub, packaging, plotext) — safe to install anywhere. The `[train]` extra
pulls the full CUDA stack and is multi-GB; only install it on a machine that will
actually train. `soup doctor` reports every training dep as MISSING under the light
install — that is expected, not a fault.

## The core loop

```bash
soup init --template chat     # or: code, medical | writes soup.yaml
soup profile                  # VRAM / speed / GPU feasibility BEFORE spending anything
soup cost                     # USD estimate across cloud providers
soup train                    # run it
soup diagnose                 # forgetting / refusal / format / mode collapse / memorization
soup ship                     # SHIP or DON'T SHIP: task win AND no catastrophic forgetting
```

`soup profile` and `soup cost` are the cheap steps — always run them before `soup train`
and report the numbers to the owner rather than starting an open-ended run.

For a reproducible, drift-checked run use the plan/apply pair, which refuses to execute
if `soup.yaml` drifted from the plan:

```bash
soup plan     # renders cost / ETA / SHA / VRAM, writes soup.tfstate
soup apply    # executes, refusing on drift
```

## Config shape

```yaml
base: meta-llama/Llama-3.1-8B-Instruct
task: sft # sft | dpo | orpo | simpo | kto
data:
  train: ./data/train.jsonl
  format: alpaca
  val_split: 0.1
  max_length: 2048
training:
  epochs: 3
  lr: 2e-5
  batch_size: auto # auto-detected from VRAM
  lora: { r: 64, alpha: 16, target_modules: auto }
  quantization: 4bit # QLoRA
output: ./output
```

`soup recipes list` / `soup fetch` pull ready-made configs for popular models instead of
hand-writing one. `soup migrate` imports an existing LLaMA-Factory, Axolotl or Unsloth
config rather than rewriting it.

## Layer streaming — the 4 GB claim, stated honestly

`stream_layers: true` keeps the frozen base in RAM and feeds it to the GPU one decoder
layer at a time, which is how upstream trains an 8B model on a 4 GB card. Two caveats to
carry when quoting it:

- It is **opt-in and still BETA**.
- The headline 119.6 tok/s at 3.32 GB peak was measured on **v0.72.2**, before the
  v0.73.0 correctness repair that cost −4.8% at 32B, and has not been re-run on a 4 GB
  card since. Quote it as upstream's measurement, not as a number this group verified.

The whole package is `Development Status :: 3 - Alpha` with a fast release cadence
(175 releases). Pin an exact version in anything reproducible.

## After training

```bash
soup eval          # benchmarks, custom evals, LLM judge, leaderboard
soup diff          # two models side by side on the same prompts
soup merge         # fold a LoRA adapter into its base
soup export --format gguf     # gguf | onnx | tensorrt | awq | gptq | torchao
soup serve         # local OpenAI-compatible inference server
soup deploy        # Ollama
soup registry      # push / list / diff / promote versions
```

`soup can` packs a run into a shareable `.can` artifact; `soup bom` emits a CycloneDX
ML-BOM / SPDX AI bill of materials; `soup attest` produces in-toto / SLSA-3
attestations. `soup license-advisor` flags whether a chosen base model's licence is
clean for the intended deploy target — worth running before committing to a base for
anything client-facing.

## Guardrails for this group

**The local audit log is on by default.** Every invocation writes a line to
`~/.soup/audit.jsonl` (HIPAA/SOC2-shaped). It lives on the machine and is not uploaded,
but it does record what was run. Disable per-invocation with `--no-audit-log` or
globally with `SOUP_NO_AUDIT_LOG=1`. `soup audit-log tail|rotate` manages it.

**Patient and customer data.** Several repos here carry medical or personal records
(aiHealth, qcare, theravex, damascus-dental-clinic-demo) and the group's standing rule
is that a missing field renders empty rather than fabricated. Training data assembled
from any of those sources is real patient data: it must be de-identified before it
becomes a JSONL, it must never be pushed to HuggingFace Hub (`soup push`), and any
resulting adapter is confidential. `soup data inspect` / `validate` / `stats` before
training, and `soup diagnose` includes a `memorization` check — run it, because a model
that memorised a patient record is a disclosure, not a quality problem.

**Cost is real.** `soup train` on rented GPUs spends the owner's money. Run
`soup profile` and `soup cost`, report the estimate, and get explicit approval before
launching a run or pushing anything to a hub.

**No GPU here.** Remote Claude Code sessions have no CUDA device, so `soup train` is not
runnable in-session. Config authoring, `advise`, `profile`, `cost`, `data`, `recipes`,
`plan` and `doctor` all work fine on CPU — real training is a workstation job with the
owner's hardware and credentials.

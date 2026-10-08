#!/usr/bin/env bash
# Publish the converted laya artifacts (scripts/convert-encoder-fp16.py output)
# to the HuggingFace artifacts repo the extension loads at runtime
# (MODEL_REPO in lib/ai/runtime.ts), and print the commit SHA to pin.
#
# One-time setup:
#   pip install -U huggingface_hub        # provides the `hf` CLI
#   hf auth login                         # token with WRITE access to the repo
#
# Usage:
#   ./.venv-convert/bin/python ... (no) — plain bash:
#   scripts/publish-laya-model.sh [repo_id]
#
# Default repo: marrviin/laya-en-fp16 — if the HF account/org name
# differs, pass it (and update MODEL_REPO + PINNED_REVISIONS to match).

set -euo pipefail

REPO="${1:-marrviin/laya-en-fp16}"
SRC="public/models/laya-en"
FILES=(encoder.onnx encoder.onnx.data head.onnx head.onnx.data rl_agent_config.json tokenizer.json)

command -v hf >/dev/null || { echo "error: hf CLI not found — pip install -U huggingface_hub"; exit 1; }
hf auth whoami >/dev/null || { echo "error: not logged in — run 'hf auth login' with a write token"; exit 1; }

for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "error: missing $SRC/$f (run scripts/convert-encoder-fp16.py first)"; exit 1; }
done

echo "uploading ${FILES[*]} -> https://huggingface.co/$REPO (root)"
hf upload "$REPO" "$SRC" .

echo
COMMIT=$(curl -fsS "https://huggingface.co/api/models/$REPO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
echo "published. Pin this commit SHA in PINNED_REVISIONS (lib/ai/providers.ts):"
echo "  \"$REPO\": \"$COMMIT\","
echo
echo "verify the runtime entrypoint is reachable:"
echo "  curl -fsSI https://huggingface.co/$REPO/resolve/$COMMIT/rl_agent_config.json"

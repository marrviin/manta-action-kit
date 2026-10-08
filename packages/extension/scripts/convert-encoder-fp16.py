"""Convert a laya encoder ONNX export from fp32 to fp16 for browser use.

The extension loads `public/models/laya-en/` via onnxruntime-web. The artifacts
in that folder are NOT in git (too large — see .gitignore), so every machine
exports/copies its own. Requirements for the artifact placed there:

  - encoder.onnx + encoder.onnx.data (external-data sidecar, filename recorded
    inside the proto) — single-file exports also load, but the sidecar layout
    is what this repo standardizes on;
  - encoder weights MUST be fp16 (~790 MB for ModernBERT-large). The official
    `laya/scripts/export_onnx.py` produces fp32 (1.58 GB): URL-mode session
    creation in ort-web copies JS buffer + wasm heap + WebGPU upload, and at
    fp32 that peak (~4.7 GB) crashes the browser. fp16 halves every copy.
  - graph IO stays fp32 (keep_io_types) — the hidden-state output feeds the
    fp32 head session.

Uses onnxruntime.transformers (NOT onnxconverter-common: it mis-types torch
`_to_copy` cast nodes, which fails session creation with "Type (tensor(float16))
of output arg ... does not match expected type (tensor(float))").

Usage:
    python -m venv .venv-convert && .venv-convert/bin/pip install onnx onnxruntime sympy
    .venv-convert/bin/python scripts/convert-encoder-fp16.py <encoder.onnx> [out_dir]

Writes <out_dir>/encoder.onnx + <out_dir>/encoder.onnx.data (out_dir defaults
to <input>/../laya-en-fp16). Verify before deploying: create a CPU
InferenceSession on the output and run one forward pass.
"""

import os
import sys
import time

import onnx
from onnxruntime.transformers.onnx_model import OnnxModel


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "public/models/laya-en/encoder.onnx"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.abspath(src)), "laya-en-fp16"
    )
    os.makedirs(out_dir, exist_ok=True)
    out_proto = os.path.join(out_dir, "encoder.onnx")

    t0 = time.time()
    print("loading fp32 model (with external data)...", flush=True)
    model = OnnxModel(onnx.load(src))  # resolves the .onnx.data sidecar
    print(f"loaded in {time.time() - t0:.1f}s", flush=True)

    t0 = time.time()
    print("converting to fp16 (ort transformers, keep_io_types)...", flush=True)
    model.convert_float_to_float16(keep_io_types=True)
    print(f"converted in {time.time() - t0:.1f}s", flush=True)

    t0 = time.time()
    print("saving with external-data sidecar...", flush=True)
    # save_model_to_file writes the sidecar as "<proto path>.data", i.e.
    # exactly "encoder.onnx.data" — the layout the runtime expects.
    model.save_model_to_file(out_proto, use_external_data_format=True)
    print(f"saved in {time.time() - t0:.1f}s", flush=True)

    for f in sorted(os.listdir(out_dir)):
        print(f"{f}: {os.path.getsize(os.path.join(out_dir, f)):,} bytes", flush=True)


if __name__ == "__main__":
    main()

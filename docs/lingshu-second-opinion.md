# Lingshu second opinion for radiograph reads

The viewer's **AI diagnosis** panel has a reader picker:

- **Claude**: the primary reader, unchanged.
- **Lingshu · 2nd opinion**: [Lingshu-32B](https://huggingface.co/lingshu-medical-mllm/Lingshu-32B),
  an open-weight medical vision-language model that we host ourselves on a rented GPU.

Both go through the `ai-read-radiograph` Edge function with the same prompt, finding types and
bounding-box format. A Lingshu read is stored in `imaging_studies.ai_analysis.radiograph_reader_lingshu`,
so it never overwrites Claude's `radiograph_reader`. Every run also writes an `imaging_ai_inferences`
row with the model name. Output is assistive only and must be verified by the treating clinician.

Until the secrets below are set, picking Lingshu shows "Lingshu second opinion is not configured on
this deployment." and nothing is sent anywhere.

## 1. Rent and start the GPU (owner)

Lingshu-32B needs about 70 GB of GPU memory at bf16: one 80 GB card (A100 or H100 80GB).
An AWQ 4-bit build fits a 48 GB card (L40S or A6000) at some quality cost.

Pick a provider region with the data-residency rules in mind: patient radiographs are sent to this
machine. Prefer a UAE region. If the GPU is outside the UAE, the clinic's consent and data-handling
rules for cross-border AI apply in the same way as for Claude.

On the machine (Ubuntu with NVIDIA drivers):

```bash
pip install "vllm>=0.8"
vllm serve lingshu-medical-mllm/Lingshu-32B \
  --served-model-name lingshu-32b \
  --api-key "$LINGSHU_API_KEY" \
  --max-model-len 8192 \
  --limit-mm-per-prompt image=1 \
  --host 127.0.0.1 --port 8000
```

Put it behind HTTPS (for example Caddy with a domain, or a Cloudflare Tunnel). Never expose port 8000
over plain HTTP: the Edge function refuses `http://` URLs.

Check it:

```bash
curl -s https://<gpu-host>/v1/models -H "Authorization: Bearer $LINGSHU_API_KEY"
```

## 2. Set the Edge function secrets (owner)

```bash
supabase secrets set --project-ref <project> \
  LINGSHU_BASE_URL=https://<gpu-host>/v1 \
  LINGSHU_API_KEY=<the same key> \
  LINGSHU_MODEL=lingshu-32b
```

Optional: `LINGSHU_DATA_RESIDENCY_UAE=true` only when the GPU is hosted in the UAE. With it, Lingshu keeps
working while `DISABLE_CROSS_BORDER_AI=true` blocks Claude.

## 3. Deploy and check

Deploy `ai-read-radiograph` from this repository (it owns the function), then open a radiograph on a
test study, pick **Lingshu · 2nd opinion**, and run **Analyze frame**. The footer shows the model name.

## Limits

- Lingshu was trained on general medical images. Its dental radiograph accuracy and its bounding boxes
  have not been measured against ours. Compare it with Claude on a set of de-identified cases before any
  clinician relies on it.
- Requests time out after 90 seconds (cold GPU starts can be slow).

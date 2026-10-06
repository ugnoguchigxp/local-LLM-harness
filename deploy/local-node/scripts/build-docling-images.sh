#!/usr/bin/env bash
set -euo pipefail
# Run only in a reviewed docling checkout. Build output stays in the container engine.
if [[ $# != 1 ]]; then
  echo 'Usage: build-docling-images.sh /absolute/path/to/docling-desk' >&2
  exit 1
fi
docling_source=$(realpath -- "$1")
if [[ ! -f "$docling_source/knowledge-api/Dockerfile" || ! -f "$docling_source/deploy/compose.larm.yml" ]]; then
  echo 'A reviewed docling-desk checkout with the lifecycle adapter is required.' >&2
  exit 1
fi
git -C "$docling_source" submodule update --init --recursive
printf '%s\n' 'Building CPU images; no service will be started.'
docker build --tag larm/docling-api:local "$docling_source/knowledge-api"
docker build --tag larm/docling-processor:local "$docling_source"
api_image=$(docker image inspect --format '{{.Id}}' larm/docling-api:local)
processor_image=$(docker image inspect --format '{{.Id}}' larm/docling-processor:local)
printf 'LARM_DOCLING_API_IMAGE=%s\nLARM_DOCLING_PROCESSOR_IMAGE=%s\nLARM_DOCLING_SECRET_ROOT=/etc/larm-local-services/docling-desk/secrets\n' "$api_image" "$processor_image"

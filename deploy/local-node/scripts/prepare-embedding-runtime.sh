#!/usr/bin/env bash
set -euo pipefail

repository="https://github.com/ugnoguchigxp/local-llm.git"
revision="d2f40a755fdda85c87274b0724a62de7250d8526"
source_dir="/srv/ai/apps/local-llm"

if [[ "$(id -un)" != "ugnoguchi" ]]; then
  echo "Run as ugnoguchi: $0" >&2
  exit 1
fi

if [[ ! -e "${source_dir}" ]]; then
  git clone "${repository}" "${source_dir}"
elif [[ ! -d "${source_dir}/.git" || -L "${source_dir}" ]]; then
  echo "Refusing non-Git or symlinked source path: ${source_dir}" >&2
  exit 1
elif [[ -n "$(git -C "${source_dir}" status --porcelain)" ]]; then
  echo "Refusing to change a dirty source checkout: ${source_dir}" >&2
  exit 1
fi

if [[ "$(git -C "${source_dir}" rev-parse HEAD)" != "${revision}" ]]; then
  git -C "${source_dir}" fetch --no-tags origin "${revision}"
  git -C "${source_dir}" switch --detach "${revision}"
fi

test "$(git -C "${source_dir}" rev-parse HEAD)" = "${revision}"
cargo build --locked --release --manifest-path "${source_dir}/Cargo.toml" -p embedding
test -x "${source_dir}/target/release/embedding"
echo "Embedding runtime prepared at ${source_dir}/target/release/embedding (${revision})."

#include "llama.h"
#include "ggml-backend.h"
#include "larm-on-demand-kv.h"
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

static std::vector<uint8_t> state(llama_context * ctx) {
    std::vector<uint8_t> result(llama_state_seq_get_size(ctx, 0));
    assert(llama_state_seq_get_data(ctx, result.data(), result.size(), 0) == result.size());
    return result;
}

int main(int argc, char ** argv) {
    if (argc != 2) return 2;
    ggml_backend_load_all();
    llama_backend_init();
    auto mp = llama_model_default_params();
    ggml_backend_dev_t devices[] = { ggml_backend_dev_by_name("Vulkan0"), nullptr };
    assert(devices[0]);
    mp.devices = devices;
    mp.n_gpu_layers = 999;
    mp.use_mmap = false;
    auto * model = llama_model_load_from_file(argv[1], mp);
    assert(model);
    auto cp = llama_context_default_params();
    cp.n_ctx = 8192;
    cp.n_seq_max = 3;
    cp.n_batch = 2048;
    cp.n_ubatch = 512;
    cp.n_threads = cp.n_threads_batch = 16;
    cp.type_k = cp.type_v = GGML_TYPE_Q4_0;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;
    cp.kv_unified = true;
    auto * ctx = llama_init_from_model(model, cp);
    assert(ctx && llama_larm_kv_capacity(ctx) == 8192);
    std::string input;
    for (int i = 0; i < 200; ++i) input += "A synthetic state transfer fixture. ";
    const auto * vocab = llama_model_get_vocab(model);
    std::vector<llama_token> tokens(input.size());
    const int n = llama_tokenize(vocab, input.data(), input.size(), tokens.data(), tokens.size(), true, true);
    assert(n > 256 && n < 2048);
    tokens.resize(n);
    assert(llama_decode(ctx, llama_batch_get_one(tokens.data(), tokens.size())) == 0);
    const auto before = state(ctx);
    // An invalid target and a genuine restore-capacity failure must preserve
    // the live cache, including the recurrent state and current sequence.
    assert(!llama_larm_resize_kv(ctx, 16384));
    assert(!llama_larm_resize_kv(ctx, 256));
    assert(llama_larm_kv_capacity(ctx) == 8192 && state(ctx) == before);
    assert(llama_larm_resize_kv(ctx, 4096));
    assert(llama_larm_kv_capacity(ctx) == 4096 && state(ctx) == before);
    assert(llama_larm_resize_kv(ctx, 8192));
    assert(llama_larm_kv_capacity(ctx) == 8192 && state(ctx) == before);
    std::puts("{\"ok\":true,\"statePreserved\":true,\"failedShrinkRolledBack\":true}");
    llama_free(ctx);
    llama_model_free(model);
    llama_backend_free();
}

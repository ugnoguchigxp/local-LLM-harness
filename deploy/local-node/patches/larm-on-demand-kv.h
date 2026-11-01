#pragma once
#include "larm-context-pools.h"
#include <cstddef>
#include <cstdint>
#include <stdexcept>

// An explicit private engine opt-in. The default engine and public request are unchanged.
struct larm_on_demand_kv_policy {
    bool enabled = false;
    uint32_t base = 0;
    uint32_t auxiliary = 0;
    uint32_t maximum = 0;

    static uint32_t padded(uint32_t tokens) { return (tokens + 255u) / 256u * 256u; }
    static larm_on_demand_kv_policy parse(const std::string & flag, const larm_context_layout & layout) {
        larm_on_demand_kv_policy p;
        if (flag.empty() || flag == "0") return p;
        if (flag != "1" || layout.capacities.size() != 3 || !layout.enabled()
            || layout.count(layout.maximum()) != 1 || layout.count(layout.default_tokens) != 2
            || layout.default_tokens >= layout.maximum()) throw std::runtime_error("unsupported on-demand KV layout");
        p.enabled = true;
        p.base = layout.maximum();
        p.auxiliary = layout.default_tokens;
        p.maximum = padded(p.base + 2u * p.auxiliary);
        return p;
    }
    uint32_t capacity(size_t auxiliary_slots) const {
        if (!enabled || auxiliary_slots > 2) throw std::runtime_error("invalid on-demand KV demand");
        return padded(base + uint32_t(auxiliary_slots) * auxiliary);
    }
};

struct llama_context;
extern "C" bool llama_larm_resize_kv(llama_context * ctx, uint32_t tokens);
extern "C" uint32_t llama_larm_kv_capacity(const llama_context * ctx);

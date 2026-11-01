#pragma once
#include <algorithm>
#include <cstdint>

// Per-slot, monotonic time. Only native inference completion advances the clock.
// Profile demand, credential renewal, cache inspection and peer activity do not.
struct larm_aux_kv_idle {
    static constexpr int64_t timeout_ms = 300000;
    int64_t last_completed_ms = -1;

    void completed(int64_t now) { last_completed_ms = now; }
    void clear() { last_completed_ms = -1; }
    bool expired(int64_t now) const {
        return last_completed_ms >= 0 && now >= last_completed_ms
            && now - last_completed_ms >= timeout_ms;
    }
    bool needed(int64_t now, bool processing) const {
        return processing || (last_completed_ms >= 0 && !expired(now));
    }
    int64_t remaining_ms(int64_t now) const {
        return last_completed_ms < 0 ? 0
            : timeout_ms - std::min(timeout_ms, std::max(int64_t(0), now - last_completed_ms));
    }
};

#include "larm-aux-kv-idle.h"
#include <cassert>

int main() {
    larm_aux_kv_idle one, two;
    assert(!one.needed(0, false));
    assert(one.needed(0, true));
    assert(!one.expired(900000));
    one.completed(1000);
    assert(one.needed(300999, false));
    assert(one.remaining_ms(300999) == 1);
    assert(one.expired(301000) && !one.needed(301000, false));
    assert(one.remaining_ms(301000) == 0);
    // A long-running request is never reclaimed and its five minutes start at
    // completion, even when the request/cache lease expired during inference.
    assert(one.needed(700000, true));
    one.completed(700000);
    assert(one.needed(999999, false));
    assert(one.expired(1000000));
    // Independent slots do not renew one another's deadline.
    one.completed(1000000);
    two.completed(1200000);
    assert(one.expired(1300000));
    assert(two.needed(1300000, false));
    assert(one.needed(1300000, true));
    // Explicit task revocation may release earlier than the idle grace period.
    two.clear();
    assert(!two.needed(1300000, false));
    assert(two.needed(1300000, true));
    // A clock anomaly must not release a live slot prematurely.
    one.completed(2000000);
    assert(one.needed(1900000, false));
    assert(one.remaining_ms(1900000) == larm_aux_kv_idle::timeout_ms);
}

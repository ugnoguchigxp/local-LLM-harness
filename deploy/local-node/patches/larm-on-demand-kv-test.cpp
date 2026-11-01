#include "larm-on-demand-kv.h"
#include <cassert>

int main() {
    const auto layout = larm_context_layout::parse("200000,131072,131072", "131072");
    assert(!larm_on_demand_kv_policy::parse("", layout).enabled);
    assert(!larm_on_demand_kv_policy::parse("0", layout).enabled);
    const auto p = larm_on_demand_kv_policy::parse("1", layout);
    assert(p.capacity(0) == 200192);
    assert(p.capacity(1) == 331264);
    assert(p.capacity(2) == 462336);
    assert(p.maximum == p.capacity(2));
    for (const auto bad : {"true", "yes", "2"}) {
        bool rejected = false;
        try { larm_on_demand_kv_policy::parse(bad, layout); } catch (...) { rejected = true; }
        assert(rejected);
    }
    for (const auto bad : {larm_context_layout{}, larm_context_layout::parse("131072,131072,131072", "131072"),
                          larm_context_layout::parse("200000,131072", "131072")}) {
        bool rejected = false;
        try { larm_on_demand_kv_policy::parse("1", bad); } catch (...) { rejected = true; }
        assert(rejected);
    }
    bool rejected = false;
    try { p.capacity(3); } catch (...) { rejected = true; }
    assert(rejected);
}

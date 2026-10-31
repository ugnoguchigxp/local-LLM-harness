#include "larm-context-pools.h"
#include <cassert>
#include <functional>

static void rejects(const std::function<void()> & fn) { bool rejected = false; try { fn(); } catch (const std::exception &) { rejected = true; } assert(rejected); }
int main() {
    const auto layout = larm_context_layout::parse("200000,131072,131072", "131072");
    assert(layout.capacities.size() == 3 && layout.count(200000) == 1 && layout.count(131072) == 2);
    assert(layout.default_tokens == 131072 && !layout.accepts(262144));
    layout.validate(3, 462336, 262144, true);
    rejects([&] { layout.validate(3, 462336, 262144, false); });
    rejects([&] { layout.validate(4, 462336, 262144, true); });
    rejects([&] { layout.validate(3, 400000, 262144, true); });
    rejects([&] { layout.validate(3, 462336, 131072, true); });
    for (const auto text : {"", "0", "-1", "200000,", ",131072", "200000, 131072", "1000001", "131072x"}) rejects([&] { larm_context_layout::parse(text, "131072"); });
    rejects([] { larm_context_layout::parse("200000", "131072"); });
    assert(!larm_context_layout::parse("", "").enabled());
}

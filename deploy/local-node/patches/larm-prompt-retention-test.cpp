#include "server-task.h"
#include <cassert>
#include <iostream>

static larm_cache_record record(char owner, char scope, int64_t t = 10000) {
    larm_cache_record r;
    r.owner = std::string(64, owner); r.scope = std::string(64, scope); r.instance = std::string(64, 'f');
    r.created = r.used = t; r.lease_until = t + 300000; r.completed = true;
    return r;
}
static server_prompt prompt(char owner, char scope, size_t bytes, int64_t t = 10000) {
    server_prompt p;
    p.tokens = server_tokens(llama_tokens{1, 2, 3}, false);
    p.data.main.resize(bytes); p.retention = record(owner, scope, t); return p;
}
int main() {
    larm_retention_policy policy; policy.enabled = true;
    policy.max_bytes = 1000; policy.owner_bytes = 600; policy.entry_bytes = policy.staging_bytes = 400;
    std::list<server_prompt> states;
    states.push_back(prompt('a', 'b', 400)); states.push_back(prompt('c', 'd', 400));
    assert(policy.admit(states, record('a','e'), 300, 4096, 10001));
    assert(states.size() == 1 && states.front().retention.owner == std::string(64, 'c'));
    // Oversize cannot evict another consumer, and no temporary allocation is admitted.
    assert(!policy.admit(states, record('a','b'), 401, 4096, 10001));
    assert(states.size() == 1);
    policy.invalidate(std::string(64,'d'), 10002); policy.prune(states, 10002);
    assert(states.empty());
    assert(!policy.valid(record('c','d'), 10003));
    auto expired = record('a','b'); expired.used = 0;
    assert(!policy.valid(expired, 400000));
    auto active = record('a','b'); active.completed = false;
    assert(!policy.valid(active, 10002));
    assert(!larm_retention_policy::same(record('a','b'), record('c','b')));
    // Hard age does not renew when a snapshot is copied or reused.
    auto old = record('a','b'); old.created = 1; old.used = 1799999; old.lease_until = 2000000;
    assert(!policy.valid(old, 1800001));
    // Recurrent rollback ranks the reachable checkpoint, not merely raw LCP.
    server_prompt p;
    llama_tokens long_input(14000, 12);
    p.tokens = server_tokens(long_input, false); p.retention.memory_floor = 14000;
    auto & cp = p.checkpoints.emplace_back(); cp.n_tokens = 13996; cp.pos_min = 13996; cp.pos_max = 13996;
    auto next = server_tokens(long_input, false);
    assert(larm_effective_prefix(p, next, 0) == 13996);
    p.checkpoints.clear();
    assert(larm_effective_prefix(p, next, 0) == 0);
    p.retention.memory_floor = 0;
    assert(larm_effective_prefix(p, next, 0) == 14000);
    // Text in a multimodal-capable runtime is still text and can be cached.
    auto vision_text = server_tokens(long_input, true);
    assert(larm_text_tokens(vision_text));
    auto media = server_tokens(llama_tokens{1, LLAMA_TOKEN_NULL}, true);
    assert(!larm_text_tokens(media));
    // Duplicate saves under quota pressure must be idempotent and must not
    // consult the live engine. A non-idempotent path would dereference ctx=null.
    server_prompt_cache cache(1, 1024);
    cache.ram_enabled = true; cache.limit_size = 1000;
    cache.retention.enabled = true; cache.retention.max_bytes = 1000;
    cache.retention.owner_bytes = 600; cache.retention.entry_bytes = cache.retention.staging_bytes = 400;
    const auto t = larm_retention_policy::now();
    cache.states.push_back(prompt('a','b',400,t)); cache.states.push_back(prompt('c','d',400,t));
    auto duplicate = prompt('a','b',400,t);
    assert(!cache.save(duplicate, nullptr, nullptr, 0, {}));
    assert(cache.states.size() == 2 && cache.size() == 800);
    assert(cache.retention.evictions == 0 && cache.retention.saves == 0);
    duplicate.checkpoints.emplace_back().n_tokens = 2;
    assert(!larm_same_snapshot(cache.states.front(), duplicate));
    std::cout << "retention native policy/checkpoint tests passed\n";
}

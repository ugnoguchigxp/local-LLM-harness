#pragma once
// Private server extension; serialized state stays in server_prompt_cache.
// All mutations run on the existing server task queue, including idle pruning.
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <string>

// HTTP field names are case-insensitive. Reverse proxies commonly title-case
// them; reject ambiguous duplicate fields rather than selecting one credential.
inline const std::string * larm_retention_header(const std::map<std::string, std::string> & headers, const std::string & name) {
    const std::string * result = nullptr;
    for (const auto & field : headers) {
        if (field.first.size() != name.size()) continue;
        bool same = true;
        for (size_t i = 0; i < name.size(); ++i) {
            auto c = (unsigned char) field.first[i];
            if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
            if (c != (unsigned char) name[i]) { same = false; break; }
        }
        if (!same) continue;
        if (result) return nullptr;
        result = &field.second;
    }
    return result;
}

struct larm_cache_record {
    std::string owner, scope, instance, correlation;
    int64_t created = 0, used = 0, lease_until = 0, memory_floor = 0;
    bool completed = false;
};

struct larm_retention_policy {
    bool enabled = false, failed_closed = false;
    size_t max_bytes = 8ull << 30, owner_bytes = 4ull << 30, entry_bytes = 1ull << 30;
    size_t staging_bytes = 1ull << 30, metadata_bytes = 64ull << 20;
    size_t max_entries = 64, owner_entries = 16;
    int64_t idle_ms = 300000, age_ms = 1800000;
    std::map<std::string, int64_t> revoked;
    uint64_t saves = 0, loads = 0, evictions = 0, failures = 0, bypasses = 0;
    std::function<void(const char *, const char *, const larm_cache_record &, size_t)> event;

    void emit(const char * action, const char * reason, const larm_cache_record & r, size_t bytes) const {
        if (event) event(action, reason, r, bytes);
    }

    static int64_t now() {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
    }
    static bool opaque(const std::string & s) {
        return s.size() == 64 && std::all_of(s.begin(), s.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
    }
    static bool same(const larm_cache_record & a, const larm_cache_record & b) {
        return !a.owner.empty() && a.owner == b.owner && a.scope == b.scope && a.instance == b.instance;
    }
    bool valid(const larm_cache_record & r, int64_t t, bool completed = true) const {
        return enabled && !failed_closed && opaque(r.owner) && opaque(r.scope) && opaque(r.instance)
            && (!completed || r.completed) && r.lease_until > t && t - r.used < idle_ms && t - r.created < age_ms
            && revoked.count(r.scope) == 0;
    }
    void invalidate(const std::string & scope, int64_t t) {
        for (auto it = revoked.begin(); it != revoked.end();) {
            if (it->second <= t) it = revoked.erase(it); else ++it;
        }
        // Requests carry at most five minutes of scope validity. A bounded
        // tombstone covers queued requests; overflow disables reuse, not inference.
        if (revoked.size() >= 16384 && !revoked.count(scope)) failed_closed = true;
        else revoked[scope] = t + 300000;
    }
    template<class Prompt> static size_t metadata(const Prompt & p) {
        // Text only: allow for token vector capacity, checkpoint/list/string nodes.
        return 2048 + p.tokens.size() * 64 + p.checkpoints.size() * 256;
    }
    template<class States> void prune(States & states, int64_t t) {
        for (auto it = states.begin(); it != states.end();) {
            if (!valid(it->retention, t)) {
                emit("evict", failed_closed ? "disabled" : revoked.count(it->retention.scope) ? "invalidated" : "expired", it->retention, it->size());
                it = states.erase(it); ++evictions;
            }
            else ++it;
        }
        for (auto it = revoked.begin(); it != revoked.end();) {
            if (it->second <= t) it = revoked.erase(it); else ++it;
        }
    }
    template<class States> bool admit(States & states, const larm_cache_record & r,
                                      size_t payload, size_t meta, int64_t t) {
        prune(states, t);
        if (!valid(r, t) || payload > entry_bytes || payload > staging_bytes || meta > metadata_bytes) {
            emit("bypass", !valid(r,t) ? "invalid-state" : payload > entry_bytes ? "entry-budget" : payload > staging_bytes ? "staging-budget" : "metadata-budget", r, payload);
            ++bypasses; return false;
        }
        // Admission reserves all payload and metadata BEFORE cloning checkpoints.
        // Erase whole states, never truncate the token/checkpoint pair.
        for (;;) {
            size_t total = payload, own = payload, metas = meta, count = 1, own_count = 1;
            std::map<std::string, size_t> owners;
            owners[r.owner] = payload;
            for (const auto & s : states) {
                total += s.size(); metas += metadata(s); ++count;
                owners[s.retention.owner] += s.size();
                if (s.retention.owner == r.owner) { own += s.size(); ++own_count; }
            }
            const bool own_pressure = own > owner_bytes || own_count > owner_entries;
            const bool global_pressure = total > max_bytes || metas > metadata_bytes || count > max_entries;
            if (!own_pressure && !global_pressure) return true;
            auto victim = states.end();
            std::string owner = r.owner;
            if (!own_pressure && total > max_bytes) {
                const size_t fair = std::min(owner_bytes, max_bytes / owners.size());
                size_t excess = 0;
                for (const auto & pair : owners) {
                    if (pair.second > fair && pair.second - fair > excess) { owner = pair.first; excess = pair.second - fair; }
                }
            } else if (!own_pressure) {
                // Metadata/count pressure is global: oldest eligible state wins.
                owner.clear();
            }
            std::map<std::string, size_t> groups;
            size_t owner_total = owner == r.owner ? payload : 0;
            if (owner == r.owner) groups[r.scope] = payload;
            for (const auto & s : states) if (s.retention.owner == owner) {
                groups[s.retention.scope] += s.size(); owner_total += s.size();
            }
            std::string group;
            size_t greatest = 0;
            const size_t fair_group = groups.empty() ? 0 : owner_total / groups.size();
            for (const auto & pair : groups) if (pair.second > fair_group && pair.second - fair_group > greatest) {
                greatest = pair.second - fair_group; group = pair.first;
            }
            for (auto it = states.begin(); it != states.end(); ++it) {
                if ((!owner.empty() && it->retention.owner != owner) || (!group.empty() && it->retention.scope != group)) continue;
                if (victim == states.end() || it->retention.used < victim->retention.used) victim = it;
            }
            if (victim == states.end()) { emit("bypass", "fair-share", r, payload); ++bypasses; return false; }
            emit("evict", own_pressure ? "principal-budget" : total > max_bytes ? "global-budget" : metas > metadata_bytes ? "metadata-budget" : "entry-count", victim->retention, victim->size());
            states.erase(victim); ++evictions;
        }
    }
};

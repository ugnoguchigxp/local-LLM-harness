#pragma once
#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

// Private startup configuration. The public generation request remains unchanged.
struct larm_context_layout {
    std::vector<int32_t> capacities;
    int32_t default_tokens = 0;

    static int32_t number(const std::string & text) {
        if (text.empty() || text.size() > 7 || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; })) throw std::runtime_error("invalid context capacity");
        const auto value = std::stoll(text);
        if (value < 1 || value > 1000000) throw std::runtime_error("invalid context capacity");
        return (int32_t) value;
    }
    static larm_context_layout parse(const std::string & text, const std::string & default_text) {
        larm_context_layout result;
        if (text.empty() && default_text.empty()) return result;
        result.default_tokens = number(default_text);
        size_t start = 0;
        do {
            const size_t end = text.find(',', start);
            result.capacities.push_back(number(text.substr(start, end == std::string::npos ? end : end - start)));
            if (result.capacities.size() > 256) throw std::runtime_error("too many context slots");
            if (end == std::string::npos) break;
            start = end + 1;
        } while (true);
        if (!result.accepts(result.default_tokens)) throw std::runtime_error("default context pool is missing");
        return result;
    }
    bool enabled() const { return !capacities.empty(); }
    bool accepts(int32_t tokens) const { return std::find(capacities.begin(), capacities.end(), tokens) != capacities.end(); }
    size_t count(int32_t tokens) const { return std::count(capacities.begin(), capacities.end(), tokens); }
    int32_t maximum() const { return enabled() ? *std::max_element(capacities.begin(), capacities.end()) : 0; }
    void validate(size_t slots, uint64_t total_tokens, int32_t training_limit, bool unified) const {
        if (!enabled()) return;
        uint64_t needed = 0;
        for (const auto tokens : capacities) needed += (uint32_t) tokens;
        if (!unified || capacities.size() != slots || needed > total_tokens || maximum() > training_limit) throw std::runtime_error("context layout does not fit native KV allocation");
    }
};

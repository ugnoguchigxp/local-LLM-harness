/* Persistent benchmark process for antirez/qwen-asr. No HTTP/service changes. */
#define _POSIX_C_SOURCE 200809L
#include "qwen_asr.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>

void qwen_set_threads(int n);

static double monotonic_seconds(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

static void print_json_string(const char *text) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
        if (*p == '"' || *p == '\\') {
            putchar('\\');
            putchar(*p);
        } else if (*p < 32) {
            printf("\\u%04x", *p);
        } else {
            putchar(*p);
        }
    }
    putchar('"');
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    qwen_verbose = 0;
    qwen_monitor = 0;
    qwen_set_threads(atoi(argv[2]));
    double start = monotonic_seconds();
    qwen_ctx_t *ctx = qwen_load(argv[1]);
    if (!ctx) return 3;
    ctx->segment_sec = 0; /* whole utterance, no previous-transcript bias */
    if (qwen_set_force_language(ctx, "Japanese") != 0) return 4;
    printf("{\"ready\":true,\"load_seconds\":%.9f}\n", monotonic_seconds() - start);
    fflush(stdout);
    char *path = NULL;
    size_t capacity = 0;
    while (getline(&path, &capacity, stdin) > 0) {
        path[strcspn(path, "\r\n")] = 0;
        start = monotonic_seconds();
        char *text = qwen_transcribe(ctx, path);
        double seconds = monotonic_seconds() - start;
        if (text) {
            printf("{\"seconds\":%.9f,\"text\":", seconds);
            print_json_string(text);
            puts("}");
            free(text);
        } else {
            puts("{\"error\":\"qwen_transcribe returned NULL\"}");
        }
        fflush(stdout);
    }
    free(path);
    qwen_free(ctx);
    return 0;
}

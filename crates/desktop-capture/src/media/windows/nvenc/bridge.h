#pragma once
#include <stdint.h>

// Only these POD values cross the Rust boundary; NVIDIA's ABI stays in C++.
struct WeblinkNvencConfig {
    uint32_t codec, width, height, fps, bitrate, ceiling;
    uint32_t primaries, transfer, matrix, full_range;
};
struct WeblinkNvencPacket {
    const uint8_t* bytes;
    uint32_t size, keyframe;
    int64_t timestamp;
};
using WeblinkNvencWake = void (*)(void*);
extern "C" {
void* weblink_nvenc_open(void* device, const WeblinkNvencConfig* config,
                        WeblinkNvencWake wake, void* context, char* error);
void weblink_nvenc_close(void* session);
uint32_t weblink_nvenc_ready(void* session);
// 1 = accepted/output, 0 = backpressure/no output, -1 = error.
int32_t weblink_nvenc_input(void* session, void* texture, int64_t timestamp,
                           uint32_t keyframe, char* error);
int32_t weblink_nvenc_poll(void* session, WeblinkNvencPacket* packet, char* error);
int32_t weblink_nvenc_bitrate(void* session, uint32_t bitrate, char* error);
}

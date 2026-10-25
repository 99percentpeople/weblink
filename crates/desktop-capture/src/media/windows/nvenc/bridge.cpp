#include "bridge.h"
#include "nvEncodeAPI.h"
#include <d3d11.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <deque>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
using Microsoft::WRL::ComPtr;
constexpr size_t kSlots = 4; // SDK minimum for asynchronous output without B frames.
constexpr size_t kTextures = 8; // Bounded registration cache across shared surface pools.
constexpr uint32_t kApi = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;

void copy_error(char* error, const char* message) noexcept {
    if (!error) return;
    auto length = std::min(size_t(511), std::strlen(message));
    std::memcpy(error, message, length);
    error[length] = '\0';
}
struct Driver {
    HMODULE module = nullptr;
    NV_ENCODE_API_FUNCTION_LIST api{};
    Driver() {
        // Do not search the application/current directory for a driver DLL.
#ifdef _WIN64
        module = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
#else
        module = LoadLibraryExW(L"nvEncodeAPI.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
#endif
        if (!module) throw std::runtime_error("NVENC driver library is unavailable");
        try {
            using Version = NVENCSTATUS (NVENCAPI*)(uint32_t*);
            using Create = NVENCSTATUS (NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);
            auto version = reinterpret_cast<Version>(GetProcAddress(module, "NvEncodeAPIGetMaxSupportedVersion"));
            auto create = reinterpret_cast<Create>(GetProcAddress(module, "NvEncodeAPICreateInstance"));
            uint32_t supported = 0;
            if (!version || !create || version(&supported) != NV_ENC_SUCCESS)
                throw std::runtime_error("NVENC driver API query failed");
            if (supported < kApi)
                throw std::runtime_error("NVENC driver is older than API 12.2; using Media Foundation");
            api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
            if (create(&api) != NV_ENC_SUCCESS)
                throw std::runtime_error("NVENC function table creation failed");
        } catch (...) {
            FreeLibrary(module);
            module = nullptr;
            throw;
        }
    }
    ~Driver() { if (module) FreeLibrary(module); }
};
struct Texture {
    ComPtr<ID3D11Texture2D> texture;
    NV_ENC_REGISTERED_PTR registered = nullptr;
    bool busy = false;
    uint64_t last_used = 0;
};
struct Slot {
    HANDLE event = nullptr;
    bool event_registered = false;
    NV_ENC_OUTPUT_PTR output = nullptr;
    NV_ENC_INPUT_PTR input = nullptr;
    size_t texture = 0;
    bool pending = false;
};
struct Session {
    Driver driver;
    ComPtr<ID3D11Device> device;
    void* encoder = nullptr;
    GUID codec{};
    NV_ENC_CONFIG config{};
    NV_ENC_INITIALIZE_PARAMS init{};
    std::array<Slot, kSlots> slots{};
    std::vector<Texture> textures;
    uint64_t input_serial = 0;
    std::deque<size_t> pending;
    std::vector<uint8_t> packet;
    std::atomic<uint32_t> completed{0};
    std::atomic<bool> event_error{false};
    HANDLE stop = nullptr;
    std::thread events;
    bool initialized = false;
    WeblinkNvencWake wake = nullptr;
    void* context = nullptr;

    void check(NVENCSTATUS status, const char* operation) {
        if (status == NV_ENC_SUCCESS) return;
        std::string error = std::string(operation) + " (NVENC " + std::to_string(status) + ")";
        if (encoder && driver.api.nvEncGetLastErrorString) {
            if (const char* detail = driver.api.nvEncGetLastErrorString(encoder); detail && *detail)
                error += std::string(": ") + detail;
        }
        throw std::runtime_error(error);
    }
    int capability(NV_ENC_CAPS query) {
        NV_ENC_CAPS_PARAM caps{};
        caps.version = NV_ENC_CAPS_PARAM_VER;
        caps.capsToQuery = query;
        int value = 0;
        check(driver.api.nvEncGetEncodeCaps(encoder, codec, &caps, &value), "Query capability");
        return value;
    }
    void open(ID3D11Device* input_device, const WeblinkNvencConfig& options,
              WeblinkNvencWake callback, void* callback_context) {
        device = input_device;
        wake = callback;
        context = callback_context;
        if (!device || (options.codec != 1 && options.codec != 2) || !options.fps ||
            !options.width || !options.height || !options.bitrate || !options.ceiling ||
            options.preset < 1 || options.preset > 7 ||
            (options.tuning != NV_ENC_TUNING_INFO_LOW_LATENCY && options.tuning != NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY) ||
            options.spatial_aq > 15)
            throw std::runtime_error("Invalid NVENC device or codec");
        codec = options.codec == 1 ? NV_ENC_CODEC_H264_GUID : NV_ENC_CODEC_HEVC_GUID;
        NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};
        open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
        open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
        open.device = device.Get();
        open.apiVersion = NVENCAPI_VERSION;
        check(driver.api.nvEncOpenEncodeSessionEx(&open, &encoder), "Open D3D11 session");
        uint32_t count = 0;
        check(driver.api.nvEncGetEncodeGUIDCount(encoder, &count), "Query codec count");
        if (count == 0 || count > 64) throw std::runtime_error("Invalid NVENC codec count");
        std::vector<GUID> codecs(count);
        check(driver.api.nvEncGetEncodeGUIDs(encoder, codecs.data(), count, &count), "Query codecs");
        if (std::none_of(codecs.begin(), codecs.end(), [&](const GUID& candidate) { return candidate == codec; }))
            throw std::runtime_error("NVENC does not support the requested codec");
        if (!capability(NV_ENC_CAPS_ASYNC_ENCODE_SUPPORT) || !capability(NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE))
            throw std::runtime_error("NVENC requires asynchronous output and dynamic bitrate support");
        if (options.width > static_cast<uint32_t>(capability(NV_ENC_CAPS_WIDTH_MAX)) ||
            options.height > static_cast<uint32_t>(capability(NV_ENC_CAPS_HEIGHT_MAX)))
            throw std::runtime_error("NVENC resolution is unsupported");
        check(driver.api.nvEncGetInputFormatCount(encoder, codec, &count), "Query input format count");
        if (count == 0 || count > 64) throw std::runtime_error("Invalid NVENC input format count");
        std::vector<NV_ENC_BUFFER_FORMAT> formats(count);
        check(driver.api.nvEncGetInputFormats(encoder, codec, formats.data(), count, &count), "Query input formats");
        if (std::find(formats.begin(), formats.end(), NV_ENC_BUFFER_FORMAT_NV12) == formats.end())
            throw std::runtime_error("NVENC NV12 input is unavailable");
        NV_ENC_PRESET_CONFIG preset{};
        const GUID presets[] = {NV_ENC_PRESET_P1_GUID, NV_ENC_PRESET_P2_GUID, NV_ENC_PRESET_P3_GUID,
            NV_ENC_PRESET_P4_GUID, NV_ENC_PRESET_P5_GUID, NV_ENC_PRESET_P6_GUID, NV_ENC_PRESET_P7_GUID};
        const auto preset_guid = presets[options.preset - 1];
        const auto tuning = static_cast<NV_ENC_TUNING_INFO>(options.tuning);
        preset.version = NV_ENC_PRESET_CONFIG_VER;
        preset.presetCfg.version = NV_ENC_CONFIG_VER;
        check(driver.api.nvEncGetEncodePresetConfigEx(encoder, codec, preset_guid,
              tuning, &preset), "Query interactive preset");
        config = preset.presetCfg;
        config.profileGUID = options.codec == 1 ? NV_ENC_H264_PROFILE_BASELINE_GUID : NV_ENC_HEVC_PROFILE_MAIN_GUID;
        config.gopLength = options.fps * 2;
        config.frameIntervalP = 1;
        config.frameFieldMode = NV_ENC_PARAMS_FRAME_FIELD_MODE_FRAME;
        auto& rate = config.rcParams;
        rate.rateControlMode = NV_ENC_PARAMS_RC_CBR;
        rate.averageBitRate = options.bitrate;
        rate.maxBitRate = options.bitrate;
        rate.vbvBufferSize = std::max(1u, options.ceiling / options.fps);
        rate.vbvInitialDelay = rate.vbvBufferSize;
        rate.enableLookahead = 0;
        rate.lookaheadDepth = 0;
        rate.enableAQ = options.spatial_aq != 0;
        rate.aqStrength = options.spatial_aq;
        rate.enableTemporalAQ = 0;
        rate.zeroReorderDelay = 1;
        rate.multiPass = NV_ENC_MULTI_PASS_DISABLED;
        auto vui = [&](auto& v) {
            v.videoSignalTypePresentFlag = 1;
            v.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
            v.videoFullRangeFlag = options.full_range;
            v.colourDescriptionPresentFlag = 1;
            v.colourPrimaries = static_cast<NV_ENC_VUI_COLOR_PRIMARIES>(options.primaries);
            v.transferCharacteristics = static_cast<NV_ENC_VUI_TRANSFER_CHARACTERISTIC>(options.transfer);
            v.colourMatrix = static_cast<NV_ENC_VUI_MATRIX_COEFFS>(options.matrix);
        };
        if (options.codec == 1) {
            auto& h264 = config.encodeCodecConfig.h264Config;
            h264.repeatSPSPPS = 1;
            h264.idrPeriod = config.gopLength;
            vui(h264.h264VUIParameters);
        } else {
            auto& hevc = config.encodeCodecConfig.hevcConfig;
            hevc.repeatSPSPPS = 1;
            hevc.idrPeriod = config.gopLength;
            vui(hevc.hevcVUIParameters);
        }
        init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init.encodeGUID = codec;
        init.presetGUID = preset_guid;
        init.tuningInfo = tuning;
        init.encodeWidth = init.darWidth = init.maxEncodeWidth = options.width;
        init.encodeHeight = init.darHeight = init.maxEncodeHeight = options.height;
        init.frameRateNum = options.fps;
        init.frameRateDen = 1;
        init.enableEncodeAsync = 1;
        init.enablePTD = 1;
        init.encodeConfig = &config;
        check(driver.api.nvEncInitializeEncoder(encoder, &init), "Initialize NVENC");
        initialized = true;
        stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!stop) throw std::runtime_error("Create NVENC stop event failed");
        for (auto& slot : slots) {
            slot.event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
            if (!slot.event) throw std::runtime_error("Create NVENC completion event failed");
            NV_ENC_EVENT_PARAMS event{};
            event.version = NV_ENC_EVENT_PARAMS_VER;
            event.completionEvent = slot.event;
            check(driver.api.nvEncRegisterAsyncEvent(encoder, &event), "Register completion event");
            slot.event_registered = true;
            NV_ENC_CREATE_BITSTREAM_BUFFER buffer{};
            buffer.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            check(driver.api.nvEncCreateBitstreamBuffer(encoder, &buffer), "Create output buffer");
            slot.output = buffer.bitstreamBuffer;
        }
        events = std::thread([this] {
            HANDLE handles[kSlots + 1] = {stop};
            for (size_t i = 0; i < kSlots; ++i) handles[i + 1] = slots[i].event;
            for (;;) {
                DWORD index = WaitForMultipleObjects(kSlots + 1, handles, FALSE, INFINITE);
                if (index == WAIT_OBJECT_0) return;
                if (index <= WAIT_OBJECT_0 || index > WAIT_OBJECT_0 + kSlots) {
                    event_error.store(true, std::memory_order_release);
                    if (wake) wake(context);
                    return;
                }
                completed.fetch_or(1u << (index - WAIT_OBJECT_0 - 1), std::memory_order_release);
                if (wake) wake(context);
            }
        });
    }
    int input(ID3D11Texture2D* texture, int64_t timestamp, bool keyframe) {
        if (pending.size() == kSlots) return 0;
        size_t index = 0;
        while (index < textures.size() && textures[index].texture.Get() != texture) ++index;
        if (index == textures.size()) {
            D3D11_TEXTURE2D_DESC desc{};
            texture->GetDesc(&desc);
            ComPtr<ID3D11Device> owner;
            texture->GetDevice(&owner);
            if (owner.Get() != device.Get() || desc.Format != DXGI_FORMAT_NV12 ||
                desc.Width != init.encodeWidth || desc.Height != init.encodeHeight)
                throw std::runtime_error("NVENC input texture does not match the encoding device/format");
            if (textures.size() == kTextures) {
                // A shared frame can originate from another worker's NV12 pool.
                // Retire only the oldest idle registration, after poll unmapped it.
                auto idle = textures.end();
                for (auto candidate = textures.begin(); candidate != textures.end(); ++candidate)
                    if (!candidate->busy && (idle == textures.end() || candidate->last_used < idle->last_used))
                        idle = candidate;
                if (idle == textures.end()) return 0;
                index = static_cast<size_t>(idle - textures.begin());
                if (idle->registered)
                    check(driver.api.nvEncUnregisterResource(encoder, idle->registered), "Retire input texture");
                *idle = Texture{};
            }
            Texture resource;
            resource.texture = texture;
            NV_ENC_REGISTER_RESOURCE registration{};
            registration.version = NV_ENC_REGISTER_RESOURCE_VER;
            registration.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
            registration.resourceToRegister = texture;
            registration.width = desc.Width;
            registration.height = desc.Height;
            registration.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
            registration.bufferUsage = NV_ENC_INPUT_IMAGE;
            check(driver.api.nvEncRegisterResource(encoder, &registration), "Register input texture");
            resource.registered = registration.registeredResource;
            try {
                if (index < textures.size()) textures[index] = std::move(resource);
                else textures.push_back(std::move(resource));
            }
            catch (...) {
                driver.api.nvEncUnregisterResource(encoder, registration.registeredResource);
                throw;
            }
        }
        auto& resource = textures[index];
        if (resource.busy) return 0;
        size_t slot_index = 0;
        while (slots[slot_index].pending) ++slot_index;
        auto& slot = slots[slot_index];
        NV_ENC_MAP_INPUT_RESOURCE map{};
        map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
        map.registeredResource = resource.registered;
        check(driver.api.nvEncMapInputResource(encoder, &map), "Map input texture");
        slot.input = map.mappedResource;
        NV_ENC_PIC_PARAMS picture{};
        picture.version = NV_ENC_PIC_PARAMS_VER;
        picture.inputBuffer = slot.input;
        picture.bufferFmt = NV_ENC_BUFFER_FORMAT_NV12;
        picture.inputWidth = init.encodeWidth;
        picture.inputHeight = init.encodeHeight;
        picture.outputBitstream = slot.output;
        picture.completionEvent = slot.event;
        picture.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        picture.inputTimeStamp = static_cast<uint64_t>(timestamp);
        picture.inputDuration = 1000000 / init.frameRateNum;
        picture.encodePicFlags = keyframe ? NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS : 0;
        auto status = driver.api.nvEncEncodePicture(encoder, &picture);
        if (status != NV_ENC_SUCCESS && status != NV_ENC_ERR_NEED_MORE_INPUT) {
            driver.api.nvEncUnmapInputResource(encoder, slot.input);
            slot.input = nullptr;
            if (status == NV_ENC_ERR_ENCODER_BUSY) return 0;
            check(status, "Submit texture");
        }
        resource.busy = slot.pending = true;
        resource.last_used = ++input_serial;
        slot.texture = index;
        pending.push_back(slot_index);
        return 1;
    }
    int poll(WeblinkNvencPacket& result) {
        if (event_error.load(std::memory_order_acquire)) throw std::runtime_error("NVENC completion wait failed");
        if (pending.empty()) return 0;
        auto index = pending.front();
        if (!(completed.load(std::memory_order_acquire) & (1u << index))) return 0;
        auto& slot = slots[index];
        NV_ENC_LOCK_BITSTREAM locked{};
        locked.version = NV_ENC_LOCK_BITSTREAM_VER;
        locked.outputBitstream = slot.output;
        locked.doNotWait = 1;
        check(driver.api.nvEncLockBitstream(encoder, &locked), "Read encoded output");
        try {
            if (!locked.bitstreamBufferPtr || !locked.bitstreamSizeInBytes || locked.bitstreamSizeInBytes > 64 * 1024 * 1024)
                throw std::runtime_error("Invalid NVENC output size");
            auto bytes = static_cast<const uint8_t*>(locked.bitstreamBufferPtr);
            packet.assign(bytes, bytes + locked.bitstreamSizeInBytes);
        } catch (...) {
            driver.api.nvEncUnlockBitstream(encoder, slot.output);
            throw;
        }
        result.bytes = packet.data();
        result.size = static_cast<uint32_t>(packet.size());
        result.timestamp = static_cast<int64_t>(locked.outputTimeStamp);
        result.keyframe = locked.pictureType == NV_ENC_PIC_TYPE_IDR;
        check(driver.api.nvEncUnlockBitstream(encoder, slot.output), "Release encoded output");
        check(driver.api.nvEncUnmapInputResource(encoder, slot.input), "Release input texture");
        slot.input = nullptr;
        textures[slot.texture].busy = slot.pending = false;
        pending.pop_front();
        completed.fetch_and(~(1u << index), std::memory_order_acq_rel);
        return 1;
    }
    void bitrate(uint32_t value) {
        auto next = config;
        next.rcParams.averageBitRate = next.rcParams.maxBitRate = value;
        NV_ENC_RECONFIGURE_PARAMS update{};
        update.version = NV_ENC_RECONFIGURE_PARAMS_VER;
        update.reInitEncodeParams = init;
        update.reInitEncodeParams.encodeConfig = &next;
        check(driver.api.nvEncReconfigureEncoder(encoder, &update), "Update bitrate");
        config = next;
    }
    ~Session() {
        if (stop) SetEvent(stop);
        if (events.joinable()) events.join();
        if (encoder) {
            if (initialized && !pending.empty()) {
                NV_ENC_PIC_PARAMS end{};
                end.version = NV_ENC_PIC_PARAMS_VER;
                end.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
                driver.api.nvEncEncodePicture(encoder, &end);
                // Keep surfaces/events alive through driver completion, even on cancellation.
                auto deadline = GetTickCount64() + 2000;
                for (auto index : pending) {
                    if (!(completed.load(std::memory_order_acquire) & (1u << index))) {
                        auto now = GetTickCount64();
                        WaitForSingleObject(slots[index].event, static_cast<DWORD>(now < deadline ? deadline - now : 0));
                    }
                }
            }
            for (auto& slot : slots) {
                if (slot.input) driver.api.nvEncUnmapInputResource(encoder, slot.input);
                if (slot.output) driver.api.nvEncDestroyBitstreamBuffer(encoder, slot.output);
                if (slot.event_registered) {
                    NV_ENC_EVENT_PARAMS event{};
                    event.version = NV_ENC_EVENT_PARAMS_VER;
                    event.completionEvent = slot.event;
                    driver.api.nvEncUnregisterAsyncEvent(encoder, &event);
                }
            }
            for (auto& resource : textures)
                if (resource.registered) driver.api.nvEncUnregisterResource(encoder, resource.registered);
            driver.api.nvEncDestroyEncoder(encoder);
        }
        for (auto& slot : slots) if (slot.event) CloseHandle(slot.event);
        if (stop) CloseHandle(stop);
    }
};
template<typename F> int32_t guarded(char* error, F operation) noexcept {
    try { return operation(); }
    catch (const std::exception& e) { copy_error(error, e.what()); }
    catch (...) { copy_error(error, "Unknown NVENC driver error"); }
    return -1;
}
}
extern "C" {
void* weblink_nvenc_open(void* device, const WeblinkNvencConfig* config,
                        WeblinkNvencWake wake, void* context, char* error) {
    std::unique_ptr<Session> session;
    auto ok = guarded(error, [&] {
        session = std::make_unique<Session>();
        session->open(static_cast<ID3D11Device*>(device), *config, wake, context);
        return 1;
    });
    return ok == 1 ? session.release() : nullptr;
}
void weblink_nvenc_close(void* session) { delete static_cast<Session*>(session); }
uint32_t weblink_nvenc_ready(void* session) {
    return static_cast<Session*>(session)->pending.size() < kSlots;
}
int32_t weblink_nvenc_input(void* session, void* texture, int64_t timestamp, uint32_t keyframe, char* error) {
    return guarded(error, [&] { return static_cast<Session*>(session)->input(static_cast<ID3D11Texture2D*>(texture), timestamp, keyframe != 0); });
}
int32_t weblink_nvenc_poll(void* session, WeblinkNvencPacket* packet, char* error) {
    return guarded(error, [&] { return static_cast<Session*>(session)->poll(*packet); });
}
int32_t weblink_nvenc_bitrate(void* session, uint32_t bitrate, char* error) {
    return guarded(error, [&] { static_cast<Session*>(session)->bitrate(bitrate); return 1; });
}
}

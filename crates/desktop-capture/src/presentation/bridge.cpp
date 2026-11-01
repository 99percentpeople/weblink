// Window composition only. The caller retains the complete decoder/capture
// lease until poll() completes, including when removing or replacing a view.
#include <d3d10_1.h>
#include <d3d11_3.h>
#include <dcomp.h>
#include <dxgi1_3.h>
#include <windows.h>
#include <wrl.h>
#include <map>
#include <memory>
#include <array>
#include <algorithm>
#include <vector>
using Microsoft::WRL::ComPtr;
#define CHECK(expr)       \
  do {                    \
    HRESULT hr_ = (expr); \
    if (FAILED(hr_))      \
      return hr_;         \
  } while (0)

struct Upload {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
};
extern "C" HRESULT wl_upload_nv12(Upload** state,
                                  ID3D11Texture2D* reuse,
                                  const BYTE* data,
                                  UINT width,
                                  UINT height,
                                  ID3D11Texture2D** result) {
  *result = nullptr;
  if (!*state) {
    auto upload = std::make_unique<Upload>();
    CHECK(D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        nullptr, 0, D3D11_SDK_VERSION, &upload->device, nullptr, nullptr));
    upload->device->GetImmediateContext(&upload->context);
    ComPtr<ID3D10Multithread> threading;
    CHECK(upload->context.As(&threading));
    threading->SetMultithreadProtected(TRUE);
    *state = upload.release();
  }
  CHECK((*state)->device->GetDeviceRemovedReason());
  if (reuse) {
    // Rust only returns textures after the complete compositor/readback lease
    // ends. UpdateSubresource snapshots CPU bytes before returning to the caller.
    (*state)->context->UpdateSubresource(reuse, 0, nullptr, data, width, 0);
    CHECK((*state)->device->GetDeviceRemovedReason());
    reuse->AddRef();
    *result = reuse;
    return S_OK;
  }
  D3D11_TEXTURE2D_DESC td{};
  td.Width = width;
  td.Height = height;
  td.MipLevels = td.ArraySize = 1;
  td.Format = DXGI_FORMAT_NV12;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_DEFAULT;
  td.BindFlags = D3D11_BIND_DECODER;
  D3D11_SUBRESOURCE_DATA initial{data, width, width * height * 3 / 2};
  return (*state)->device->CreateTexture2D(&td, &initial, result);
}
extern "C" void wl_upload_destroy(Upload* upload) {
  delete upload;
}
struct View {
  ComPtr<IDCompositionVisual> visual;
  ComPtr<IDCompositionRectangleClip> clip;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11DeviceContext3> context3;
  ComPtr<ID3D11VideoDevice> video;
  ComPtr<ID3D11VideoContext> video_context;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  ComPtr<ID3D11VideoProcessor> processor;
  ComPtr<IDXGISwapChain2> swap;
  // Keep the last presented image while a replacement swap chain is prepared.
  ComPtr<IDXGISwapChain2> displayed;
  UINT displayed_width = 0, displayed_height = 0;
  ComPtr<ID3D11Query> completion;
  ComPtr<ID3D11VideoProcessorOutputView> output;
  ComPtr<ID3D11VideoProcessorInputView> transient_input;
  struct Input {
    ComPtr<ID3D11Texture2D> texture;
    UINT subresource;
    ComPtr<ID3D11VideoProcessorInputView> view;
  };
  // The cache owns texture/view COM references, never decoder sample leases.
  // Bound retained resources even when a hardware/capture pool rotates textures.
  static constexpr size_t input_limit = 16;
  static constexpr size_t texture_limit = 4;
  std::vector<Input> inputs;
  bool parameters_set = false;
  bool configured = false;
  UINT crop_x = 0, crop_y = 0;
  BOOL bt709 = FALSE, full_range = FALSE;
  UINT width = 0, height = 0, input_width = 0, input_height = 0;
  bool pending = false;
  float x = 0, y = 0, display_width = 0, display_height = 0, radius = 0;
  BOOL visible = FALSE;
  UINT clip_width = 0, clip_height = 0;
  float clip_rx = -1, clip_ry = -1;
  HANDLE available = nullptr;
  HANDLE completed = nullptr;
  bool waiting_available = false;
  bool admitted = false;
  ~View() {
    if (available)
      CloseHandle(available);
    if (completed)
      CloseHandle(completed);
  }
};
struct Composition {
  ComPtr<IDCompositionDevice> device;
  ComPtr<IDCompositionTarget> target;
  ComPtr<IDCompositionVisual> root;
  std::map<UINT64, std::unique_ptr<View>> views;
  bool dirty = false;
};
extern "C" HRESULT wl_composition_create(HWND window, Composition** result) {
  *result = nullptr;
  auto c = std::make_unique<Composition>();
  CHECK(DCompositionCreateDevice(nullptr, IID_PPV_ARGS(&c->device)));
  CHECK(c->device->CreateTargetForHwnd(window, FALSE, &c->target));
  CHECK(c->device->CreateVisual(&c->root));
  // The inherited default is nearest-neighbor, which drops thin text strokes
  // when desktop views shrink. Filter both preview and receive visuals on GPU.
  CHECK(c->root->SetBitmapInterpolationMode(
      DCOMPOSITION_BITMAP_INTERPOLATION_MODE_LINEAR));
  CHECK(c->target->SetRoot(c->root.Get()));
  CHECK(c->device->Commit());
  *result = c.release();
  return S_OK;
}
extern "C" void wl_composition_destroy(Composition* c) {
  delete c;
}
extern "C" HRESULT wl_composition_remove(Composition* c, UINT64 id) {
  auto it = c->views.find(id);
  if (it == c->views.end())
    return S_OK;
  if (it->second->pending)
    return E_PENDING;
  CHECK(c->root->RemoveVisual(it->second->visual.Get()));
  c->views.erase(it);
  c->dirty = true;
  return S_OK;
}
extern "C" HRESULT wl_composition_commit(Composition* c) {
  if (!c->dirty)
    return S_OK;
  CHECK(c->device->Commit());
  c->dirty = false;
  return S_OK;
}
extern "C" HRESULT wl_composition_layout(Composition* c,
                                         UINT64 id,
                                         float x,
                                         float y,
                                         float width,
                                         float height,
                                         float radius,
                                         BOOL visible) {
  auto it = c->views.find(id);
  if (it == c->views.end()) {
    auto view = std::make_unique<View>();
    CHECK(c->device->CreateVisual(&view->visual));
    CHECK(c->device->CreateRectangleClip(&view->clip));
    CHECK(view->clip->SetLeft(0.f));
    CHECK(view->clip->SetTop(0.f));
    CHECK(view->clip->SetRight(0.f));
    CHECK(view->clip->SetBottom(0.f));
    CHECK(view->visual->SetClip(view->clip.Get()));
    CHECK(c->root->AddVisual(view->visual.Get(), TRUE, nullptr));
    it = c->views.emplace(id, std::move(view)).first;
  }
  auto& v = it->second;
  c->dirty = true;
  v->x = x;
  v->y = y;
  v->display_width = width;
  v->display_height = height;
  v->radius = radius;
  v->visible = visible;
  if (!visible)
    v->waiting_available = false;
  CHECK(v->visual->SetOffsetX(x));
  CHECK(v->visual->SetOffsetY(y));
  if (v->displayed_width && v->displayed_height) {
    D2D_MATRIX_3X2_F matrix{width / v->displayed_width, 0, 0,
                           height / v->displayed_height, 0, 0};
    CHECK(v->visual->SetTransform(matrix));
    const UINT clip_width = visible ? v->displayed_width : 0;
    const UINT clip_height = visible ? v->displayed_height : 0;
    if (v->clip_width != clip_width || v->clip_height != clip_height) {
      CHECK(v->clip->SetRight(float(clip_width)));
      CHECK(v->clip->SetBottom(float(clip_height)));
      v->clip_width = clip_width;
      v->clip_height = clip_height;
    }
    const float rx = width > 0 ? radius * v->displayed_width / width : 0;
    const float ry = height > 0 ? radius * v->displayed_height / height : 0;
    if (v->clip_rx != rx || v->clip_ry != ry) {
      CHECK(v->clip->SetTopLeftRadiusX(rx));
      CHECK(v->clip->SetTopLeftRadiusY(ry));
      CHECK(v->clip->SetTopRightRadiusX(rx));
      CHECK(v->clip->SetTopRightRadiusY(ry));
      CHECK(v->clip->SetBottomLeftRadiusX(rx));
      CHECK(v->clip->SetBottomLeftRadiusY(ry));
      CHECK(v->clip->SetBottomRightRadiusX(rx));
      CHECK(v->clip->SetBottomRightRadiusY(ry));
      v->clip_rx = rx;
      v->clip_ry = ry;
    }
  }
  return S_OK;
}
static HRESULT configure(View& v,
                         ID3D11Texture2D* texture,
                         UINT width,
                         UINT height) {
  ComPtr<ID3D11Device> device;
  texture->GetDevice(&device);
  D3D11_TEXTURE2D_DESC td{};
  texture->GetDesc(&td);
  if (v.configured && v.device == device && v.width == width && v.height == height &&
      v.input_width == td.Width && v.input_height == td.Height)
    return S_OK;
  if (v.pending)
    return E_PENDING;
  if (device->GetFeatureLevel() < D3D_FEATURE_LEVEL_11_0)
    return E_NOTIMPL;
  v.configured = false;
  v.output.Reset();
  v.transient_input.Reset();
  v.inputs.clear();
  v.inputs.reserve(View::input_limit);
  v.parameters_set = false;
  v.admitted = v.waiting_available = false;
  v.swap.Reset();
  v.processor.Reset();
  v.enumerator.Reset();
  if (v.available) {
    CloseHandle(v.available);
    v.available = nullptr;
  }
  v.device = device;
  device->GetImmediateContext(&v.context);
  CHECK(v.context.As(&v.context3));
  ComPtr<ID3D10Multithread> threading;
  CHECK(v.context.As(&threading));
  threading->SetMultithreadProtected(TRUE);
  CHECK(device.As(&v.video));
  CHECK(v.context.As(&v.video_context));
  ComPtr<IDXGIDevice> dxgi;
  CHECK(device.As(&dxgi));
  ComPtr<IDXGIAdapter> adapter;
  CHECK(dxgi->GetAdapter(&adapter));
  ComPtr<IDXGIFactory2> factory;
  CHECK(adapter->GetParent(IID_PPV_ARGS(&factory)));
  DXGI_SWAP_CHAIN_DESC1 sd{};
  sd.Width = width;
  sd.Height = height;
  sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  sd.SampleDesc.Count = 1;
  sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  sd.BufferCount = 2;
  sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
  sd.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
  sd.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
  ComPtr<IDXGISwapChain1> swap;
  CHECK(factory->CreateSwapChainForComposition(device.Get(), &sd, nullptr,
                                               &swap));
  CHECK(swap.As(&v.swap));
  CHECK(v.swap->SetMaximumFrameLatency(1));
  v.available = v.swap->GetFrameLatencyWaitableObject();
  if (!v.available)
    return E_UNEXPECTED;
  if (!v.completed) {
    v.completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!v.completed)
      return HRESULT_FROM_WIN32(GetLastError());
  }
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd{};
  cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  cd.InputFrameRate = cd.OutputFrameRate = {60, 1};
  cd.InputWidth = td.Width;
  cd.InputHeight = td.Height;
  cd.OutputWidth = width;
  cd.OutputHeight = height;
  cd.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
  CHECK(v.video->CreateVideoProcessorEnumerator(&cd, &v.enumerator));
  CHECK(v.video->CreateVideoProcessor(v.enumerator.Get(), 0, &v.processor));
  D3D11_QUERY_DESC qd{D3D11_QUERY_EVENT, 0};
  CHECK(device->CreateQuery(&qd, &v.completion));
  // D3D11 preserves logical back-buffer-0 identity across flip-model Present.
  ComPtr<ID3D11Texture2D> back;
  CHECK(v.swap->GetBuffer(0, IID_PPV_ARGS(&back)));
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ov{};
  ov.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  CHECK(v.video->CreateVideoProcessorOutputView(back.Get(), v.enumerator.Get(),
                                                &ov, &v.output));
  v.video_context->VideoProcessorSetStreamAutoProcessingMode(v.processor.Get(),
                                                             0, FALSE);
  v.video_context->VideoProcessorSetOutputAlphaFillMode(
      v.processor.Get(), D3D11_VIDEO_PROCESSOR_ALPHA_FILL_MODE_OPAQUE, 0);
  RECT dst{0, 0, LONG(width), LONG(height)};
  v.video_context->VideoProcessorSetStreamDestRect(v.processor.Get(), 0, TRUE,
                                                   &dst);
  v.video_context->VideoProcessorSetOutputTargetRect(v.processor.Get(), TRUE,
                                                     &dst);
  D3D11_VIDEO_PROCESSOR_COLOR_SPACE rgb{};
  rgb.RGB_Range = 0;
  v.video_context->VideoProcessorSetOutputColorSpace(v.processor.Get(), &rgb);
  v.width = width;
  v.height = height;
  v.input_width = td.Width;
  v.input_height = td.Height;
  // Do not alter the visual here. Admission can yield before the first Present,
  // and another view/layout may commit while this replacement is still empty.
  v.configured = true;
  return S_OK;
}
static HRESULT input_view(View& v, ID3D11Texture2D* texture, UINT subresource,
                          const D3D11_TEXTURE2D_DESC& td,
                          ID3D11VideoProcessorInputView** result,
                          bool cache = true) {
  if (!cache) {
    v.inputs.clear();
    v.transient_input.Reset();
  }
  if (cache) {
    for (const auto& input : v.inputs) {
      if (input.texture.Get() == texture && input.subresource == subresource) {
        *result = input.view.Get();
        return S_OK;
      }
    }
  }
  // Subresources of one decoder array are cheap to retain together. Bound the
  // number of distinct allocations too: sixteen large texture arrays can retain
  // far more GPU memory than sixteen views of the same decoder pool.
  if (cache) {
    std::array<ID3D11Texture2D*, View::input_limit> textures{};
    size_t count = 0;
    for (const auto& input : v.inputs) {
      if (std::find(textures.begin(), textures.begin() + count,
                    input.texture.Get()) == textures.begin() + count)
        textures[count++] = input.texture.Get();
    }
    if (count == View::texture_limit &&
        std::find(textures.begin(), textures.begin() + count, texture) ==
            textures.begin() + count) {
      auto oldest = v.inputs.front().texture;
      v.inputs.erase(std::remove_if(v.inputs.begin(), v.inputs.end(),
          [&](const View::Input& input) { return input.texture == oldest; }),
          v.inputs.end());
    }
    // Evict before allocating, after the preceding GPU submission completed.
    if (v.inputs.size() == View::input_limit)
      v.inputs.erase(v.inputs.begin());
  }
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC iv{};
  iv.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  iv.Texture2D.MipSlice = subresource % td.MipLevels;
  iv.Texture2D.ArraySlice = subresource / td.MipLevels;
  View::Input input{texture, subresource, nullptr};
  CHECK(v.video->CreateVideoProcessorInputView(texture, v.enumerator.Get(), &iv,
                                               &input.view));
  *result = input.view.Get();
  if (!cache) {
    // Explicitly uncached callers retain only the view needed by pending work.
    v.transient_input = std::move(input.view);
  } else {
    v.inputs.push_back(std::move(input));
  }
  return S_OK;
}
// S_FALSE means wait; no GPU reference to the caller's lease was submitted.
extern "C" HRESULT wl_composition_submit(Composition* c,
                                         UINT64 id,
                                         ID3D11Texture2D* texture,
                                         UINT subresource,
                                         UINT crop_x,
                                         UINT crop_y,
                                         UINT width,
                                         UINT height,
                                         BOOL bt709,
                                         BOOL full_range,
                                         BOOL cache_input) {
  auto it = c->views.find(id);
  if (it == c->views.end() || !texture)
    return E_INVALIDARG;
  View& v = *it->second;
  if (v.pending)
    return S_FALSE;
  CHECK(configure(v, texture, width, height));
  CHECK(v.device->GetDeviceRemovedReason());
  if (!v.admitted) {
    DWORD ready = WaitForSingleObject(v.available, 0);
    if (ready == WAIT_FAILED)
      return HRESULT_FROM_WIN32(GetLastError());
    if (ready != WAIT_OBJECT_0) {
      v.waiting_available = true;
      return S_FALSE;
    }
    v.admitted = true;
  }
  v.waiting_available = false;
  D3D11_TEXTURE2D_DESC td{};
  texture->GetDesc(&td);
  if (width > td.Width || height > td.Height ||
      crop_x > td.Width - width || crop_y > td.Height - height ||
      subresource >= td.MipLevels * td.ArraySize)
    return E_INVALIDARG;
  ID3D11VideoProcessorInputView* input = nullptr;
  CHECK(input_view(v, texture, subresource, td, &input, cache_input != FALSE));
  if (!v.parameters_set || v.crop_x != crop_x || v.crop_y != crop_y) {
    RECT src{LONG(crop_x), LONG(crop_y), LONG(crop_x + width),
             LONG(crop_y + height)};
    v.video_context->VideoProcessorSetStreamSourceRect(v.processor.Get(), 0, TRUE,
                                                       &src);
    v.crop_x = crop_x;
    v.crop_y = crop_y;
  }
  if (!v.parameters_set || v.bt709 != bt709 || v.full_range != full_range) {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE color{};
    color.YCbCr_Matrix = bt709 ? 1 : 0;
    color.Nominal_Range = full_range ? 2 : 1;
    v.video_context->VideoProcessorSetStreamColorSpace(v.processor.Get(), 0,
                                                       &color);
    v.bt709 = bt709;
    v.full_range = full_range;
  }
  v.parameters_set = true;
  // Fail before issuing work if the completion event cannot be rearmed.
  if (!ResetEvent(v.completed))
    return HRESULT_FROM_WIN32(GetLastError());
  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = input;
  CHECK(v.video_context->VideoProcessorBlt(v.processor.Get(), v.output.Get(), 0,
                                           1, &stream));
  v.context->End(v.completion.Get());
  v.context3->Flush1(D3D11_CONTEXT_TYPE_ALL, v.completed);
  v.pending = true;
  v.admitted = false;
  // A failed Present still leaves a GPU read in flight; the caller must poll.
  CHECK(v.swap->Present(0, 0));
  if (v.displayed != v.swap) {
    CHECK(v.visual->SetContent(v.swap.Get()));
    v.displayed = v.swap;
    v.displayed_width = v.width;
    v.displayed_height = v.height;
    // Content and its transform/clip become visible in the same composition
    // commit. Until now, layout updates continued to use the previous image.
    CHECK(wl_composition_layout(c, id, v.x, v.y, v.display_width,
                                 v.display_height, v.radius, v.visible));
  }
  return S_OK;
}
extern "C" HRESULT wl_composition_poll(Composition* c, UINT64 id) {
  auto it = c->views.find(id);
  if (it == c->views.end() || !it->second->pending)
    return S_OK;
  View& v = *it->second;
  HRESULT removed = v.device->GetDeviceRemovedReason();
  if (FAILED(removed)) {
    v.pending = false;
    v.transient_input.Reset();
    return removed;
  }
  if (WaitForSingleObject(v.completed, 0) != WAIT_OBJECT_0)
    return S_FALSE;
  BOOL done = FALSE;
  HRESULT hr = v.context->GetData(v.completion.Get(), &done, sizeof(done),
                                  D3D11_ASYNC_GETDATA_DONOTFLUSH);
  if (hr == S_FALSE || (hr == S_OK && !done)) {
    // Normally Flush1's event and the preceding query complete together. If a
    // driver signals early, rearm once instead of spinning on a signalled event.
    if (ResetEvent(v.completed)) {
      v.context3->Flush1(D3D11_CONTEXT_TYPE_ALL, v.completed);
    }
    return S_FALSE;
  }
  // Failure indicates device removal; it can no longer read the source sample.
  v.pending = false;
  v.transient_input.Reset();
  return hr;
}

extern "C" HRESULT wl_composition_wait(Composition* c, HANDLE wake) {
  // At most one GPU or swap-chain wait per view, plus the coalesced source/layout
  // event. View mutation and handle closure happen only on this worker thread.
  std::array<HANDLE, MAXIMUM_WAIT_OBJECTS> handles{};
  std::array<View*, MAXIMUM_WAIT_OBJECTS> available{};
  DWORD count = 1;
  handles[0] = wake;
  for (const auto& entry : c->views) {
    View& v = *entry.second;
    HANDLE handle = v.pending ? v.completed
                             : (v.waiting_available ? v.available : nullptr);
    if (!handle)
      continue;
    if (count == handles.size())
      return E_UNEXPECTED;
    handles[count] = handle;
    if (!v.pending)
      available[count] = &v;
    ++count;
  }
  // A slow watchdog catches device removal while a driver has stopped signalling.
  // No pending GPU work means indefinite sleep until a frame/layout/close event.
  DWORD result = WaitForMultipleObjects(count, handles.data(), FALSE,
                                        count > 1 ? 2000 : INFINITE);
  if (result == WAIT_FAILED)
    return HRESULT_FROM_WIN32(GetLastError());
  if (result >= WAIT_OBJECT_0 && result < WAIT_OBJECT_0 + count) {
    if (auto* view = available[result - WAIT_OBJECT_0]) {
      // The wait already consumed this swap-chain credit; submit must not wait
      // again or it can deadlock despite a frame being ready for presentation.
      view->admitted = true;
      view->waiting_available = false;
    }
    return S_OK;
  }
  return result == WAIT_TIMEOUT ? S_FALSE : E_UNEXPECTED;
}

#ifdef WEBLINK_COMPOSITION_TEST
#include "bridge_tests.h"
#endif

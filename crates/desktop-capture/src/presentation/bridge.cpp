// Window composition only. The caller retains the complete decoder/capture
// lease until poll() completes, including when removing or replacing a view.
#include <d3d10_1.h>
#include <d3d11_1.h>
#include <dcomp.h>
#include <dxgi1_3.h>
#include <windows.h>
#include <wrl.h>
#include <map>
#include <memory>
using Microsoft::WRL::ComPtr;
#define CHECK(expr)       \
  do {                    \
    HRESULT hr_ = (expr); \
    if (FAILED(hr_))      \
      return hr_;         \
  } while (0)

struct Upload {
  ComPtr<ID3D11Device> device;
};
extern "C" HRESULT wl_upload_nv12(Upload** state,
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
    ComPtr<ID3D11DeviceContext> context;
    upload->device->GetImmediateContext(&context);
    ComPtr<ID3D10Multithread> threading;
    CHECK(context.As(&threading));
    threading->SetMultithreadProtected(TRUE);
    *state = upload.release();
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
// Explicit CPU consumers (recording/export) only. Ordinary presentation never
// calls this path. The caller owns the source lease for the whole operation.
extern "C" HRESULT wl_read_nv12(ID3D11Texture2D* texture,
                                UINT subresource,
                                UINT crop_x,
                                UINT crop_y,
                                UINT width,
                                UINT height,
                                BYTE* output) {
  D3D11_TEXTURE2D_DESC td{};
  texture->GetDesc(&td);
  if (td.Format != DXGI_FORMAT_NV12 || td.MipLevels != 1 ||
      subresource >= td.ArraySize || crop_x + width > td.Width ||
      crop_y + height > td.Height)
    return E_INVALIDARG;
  ComPtr<ID3D11Device> device;
  texture->GetDevice(&device);
  ComPtr<ID3D11DeviceContext> context;
  device->GetImmediateContext(&context);
  td.ArraySize = 1;
  td.Usage = D3D11_USAGE_STAGING;
  td.BindFlags = td.MiscFlags = 0;
  td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  CHECK(device->CreateTexture2D(&td, nullptr, &staging));
  context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, texture,
                                 subresource, nullptr);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  CHECK(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
  const BYTE* y = static_cast<const BYTE*>(mapped.pData) +
                  size_t(crop_y) * mapped.RowPitch + crop_x;
  const BYTE* uv = static_cast<const BYTE*>(mapped.pData) +
                   size_t(td.Height + crop_y / 2) * mapped.RowPitch + crop_x;
  for (UINT row = 0; row < height; ++row)
    memcpy(output + size_t(row) * width, y + size_t(row) * mapped.RowPitch,
           width);
  for (UINT row = 0; row < height / 2; ++row)
    memcpy(output + size_t(height + row) * width,
           uv + size_t(row) * mapped.RowPitch, width);
  context->Unmap(staging.Get(), 0);
  return S_OK;
}

struct View {
  ComPtr<IDCompositionVisual> visual;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11VideoDevice> video;
  ComPtr<ID3D11VideoContext> video_context;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  ComPtr<ID3D11VideoProcessor> processor;
  ComPtr<IDXGISwapChain2> swap;
  ComPtr<ID3D11Query> completion;
  UINT width = 0, height = 0, input_width = 0, input_height = 0;
  bool pending = false;
  float x = 0, y = 0, display_width = 0, display_height = 0, radius = 0;
  BOOL visible = FALSE;
  HANDLE available = nullptr;
  ~View() {
    if (available)
      CloseHandle(available);
  }
};
struct Composition {
  ComPtr<IDCompositionDevice> device;
  ComPtr<IDCompositionTarget> target;
  ComPtr<IDCompositionVisual> root;
  std::map<UINT64, std::unique_ptr<View>> views;
};
extern "C" HRESULT wl_composition_create(HWND window, Composition** result) {
  *result = nullptr;
  auto c = std::make_unique<Composition>();
  CHECK(DCompositionCreateDevice(nullptr, IID_PPV_ARGS(&c->device)));
  CHECK(c->device->CreateTargetForHwnd(window, FALSE, &c->target));
  CHECK(c->device->CreateVisual(&c->root));
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
  return c->device->Commit();
}
extern "C" HRESULT wl_composition_layout(Composition* c,
                                         UINT64 id,
                                         float x,
                                         float y,
                                         float width,
                                         float height,
                                         float radius,
                                         BOOL visible) {
  auto& v = c->views[id];
  if (!v) {
    v = std::make_unique<View>();
    CHECK(c->device->CreateVisual(&v->visual));
    CHECK(c->root->AddVisual(v->visual.Get(), TRUE, nullptr));
  }
  v->x = x;
  v->y = y;
  v->display_width = width;
  v->display_height = height;
  v->radius = radius;
  v->visible = visible;
  CHECK(v->visual->SetOffsetX(x));
  CHECK(v->visual->SetOffsetY(y));
  if (v->width && v->height) {
    D2D_MATRIX_3X2_F matrix{width / v->width, 0, 0, height / v->height, 0, 0};
    CHECK(v->visual->SetTransform(matrix));
    ComPtr<IDCompositionRectangleClip> clip;
    CHECK(c->device->CreateRectangleClip(&clip));
    CHECK(clip->SetLeft(0.f));
    CHECK(clip->SetTop(0.f));
    CHECK(clip->SetRight(visible ? float(v->width) : 0));
    CHECK(clip->SetBottom(visible ? float(v->height) : 0));
    const float rx = width > 0 ? radius * v->width / width : 0;
    const float ry = height > 0 ? radius * v->height / height : 0;
    CHECK(clip->SetTopLeftRadiusX(rx));
    CHECK(clip->SetTopLeftRadiusY(ry));
    CHECK(clip->SetTopRightRadiusX(rx));
    CHECK(clip->SetTopRightRadiusY(ry));
    CHECK(clip->SetBottomLeftRadiusX(rx));
    CHECK(clip->SetBottomLeftRadiusY(ry));
    CHECK(clip->SetBottomRightRadiusX(rx));
    CHECK(clip->SetBottomRightRadiusY(ry));
    CHECK(v->visual->SetClip(clip.Get()));
  }
  return c->device->Commit();
}
static HRESULT configure(Composition* c,
                         UINT64 id,
                         View& v,
                         ID3D11Texture2D* texture,
                         UINT width,
                         UINT height) {
  ComPtr<ID3D11Device> device;
  texture->GetDevice(&device);
  D3D11_TEXTURE2D_DESC td{};
  texture->GetDesc(&td);
  if (v.swap && v.device == device && v.width == width && v.height == height &&
      v.input_width == td.Width && v.input_height == td.Height)
    return S_OK;
  if (v.pending)
    return E_PENDING;
  if (device->GetFeatureLevel() < D3D_FEATURE_LEVEL_11_0)
    return E_NOTIMPL;
  v.swap.Reset();
  v.processor.Reset();
  v.enumerator.Reset();
  if (v.available) {
    CloseHandle(v.available);
    v.available = nullptr;
  }
  v.device = device;
  device->GetImmediateContext(&v.context);
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
  v.video_context->VideoProcessorSetStreamAutoProcessingMode(v.processor.Get(),
                                                             0, FALSE);
  v.video_context->VideoProcessorSetOutputAlphaFillMode(
      v.processor.Get(), D3D11_VIDEO_PROCESSOR_ALPHA_FILL_MODE_OPAQUE, 0);
  CHECK(v.visual->SetContent(v.swap.Get()));
  v.width = width;
  v.height = height;
  v.input_width = td.Width;
  v.input_height = td.Height;
  return wl_composition_layout(c, id, v.x, v.y, v.display_width,
                               v.display_height, v.radius, v.visible);
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
                                         BOOL full_range) {
  auto it = c->views.find(id);
  if (it == c->views.end() || !texture)
    return E_INVALIDARG;
  View& v = *it->second;
  if (v.pending)
    return S_FALSE;
  CHECK(configure(c, id, v, texture, width, height));
  if (v.available && WaitForSingleObject(v.available, 0) != WAIT_OBJECT_0)
    return S_FALSE;
  D3D11_TEXTURE2D_DESC td{};
  texture->GetDesc(&td);
  if (crop_x + width > td.Width || crop_y + height > td.Height ||
      subresource >= td.MipLevels * td.ArraySize)
    return E_INVALIDARG;
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC iv{};
  iv.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  iv.Texture2D.MipSlice = subresource % td.MipLevels;
  iv.Texture2D.ArraySlice = subresource / td.MipLevels;
  ComPtr<ID3D11VideoProcessorInputView> input;
  CHECK(v.video->CreateVideoProcessorInputView(texture, v.enumerator.Get(), &iv,
                                               &input));
  ComPtr<ID3D11Texture2D> back;
  CHECK(v.swap->GetBuffer(0, IID_PPV_ARGS(&back)));
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ov{};
  ov.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  ComPtr<ID3D11VideoProcessorOutputView> output;
  CHECK(v.video->CreateVideoProcessorOutputView(back.Get(), v.enumerator.Get(),
                                                &ov, &output));
  RECT src{LONG(crop_x), LONG(crop_y), LONG(crop_x + width),
           LONG(crop_y + height)};
  RECT dst{0, 0, LONG(width), LONG(height)};
  v.video_context->VideoProcessorSetStreamSourceRect(v.processor.Get(), 0, TRUE,
                                                     &src);
  v.video_context->VideoProcessorSetStreamDestRect(v.processor.Get(), 0, TRUE,
                                                   &dst);
  v.video_context->VideoProcessorSetOutputTargetRect(v.processor.Get(), TRUE,
                                                     &dst);
  D3D11_VIDEO_PROCESSOR_COLOR_SPACE color{};
  color.YCbCr_Matrix = bt709 ? 1 : 0;
  color.Nominal_Range = full_range ? 2 : 1;
  v.video_context->VideoProcessorSetStreamColorSpace(v.processor.Get(), 0,
                                                     &color);
  D3D11_VIDEO_PROCESSOR_COLOR_SPACE rgb{};
  rgb.RGB_Range = 0;
  v.video_context->VideoProcessorSetOutputColorSpace(v.processor.Get(), &rgb);
  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = input.Get();
  CHECK(v.video_context->VideoProcessorBlt(v.processor.Get(), output.Get(), 0,
                                           1, &stream));
  v.context->End(v.completion.Get());
  v.context->Flush();
  v.pending = true;
  // A failed Present still leaves a GPU read in flight; the caller must poll.
  return v.swap->Present(0, 0);
}
extern "C" HRESULT wl_composition_poll(Composition* c, UINT64 id) {
  auto it = c->views.find(id);
  if (it == c->views.end() || !it->second->pending)
    return S_OK;
  View& v = *it->second;
  BOOL done = FALSE;
  HRESULT hr = v.context->GetData(v.completion.Get(), &done, sizeof(done),
                                  D3D11_ASYNC_GETDATA_DONOTFLUSH);
  if (hr == S_FALSE || (hr == S_OK && !done))
    return S_FALSE;
  // Failure indicates device removal; it can no longer read the source sample.
  v.pending = false;
  return hr;
}

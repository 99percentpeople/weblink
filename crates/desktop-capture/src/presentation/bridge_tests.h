// Debug-build native regression entry points; called by Rust tests with their own
// hidden window and synthetic textures. No user window or screen is captured.
#include <thread>
#include <cstdio>
#define VERIFY(expr) do { if (!(expr)) return __LINE__; } while (0)
#define SUCCEED(expr) do { HRESULT test_hr = (expr); if (FAILED(test_hr)) { \
  std::fprintf(stderr, "Native test line %d: HRESULT %08lx\n", __LINE__, \
               static_cast<unsigned long>(test_hr)); return __LINE__; } } while (0)

extern "C" int wl_composition_test_wait() {
  Composition c;
  HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  VERIFY(wake);
  struct Close { HANDLE h; ~Close() { CloseHandle(h); } } close{wake};
  auto view = std::make_unique<View>();
  view->completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  view->available = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  VERIFY(view->completed && view->available);
  auto& v = *view;
  c.views.emplace(1, std::move(view));
  // A signal published before waiting is retained and coalesced.
  SetEvent(wake);
  SetEvent(wake);
  SUCCEED(wl_composition_wait(&c, wake));
  VERIFY(WaitForSingleObject(wake, 0) == WAIT_TIMEOUT);
  // Idle waits do not return periodically. Wake explicitly on another thread.
  auto started = GetTickCount64();
  std::thread notify([wake] { Sleep(40); SetEvent(wake); });
  HRESULT hr = wl_composition_wait(&c, wake);
  notify.join();
  SUCCEED(hr);
  VERIFY(GetTickCount64() - started >= 25);
  v.pending = true;
  SetEvent(v.completed);
  SUCCEED(wl_composition_wait(&c, wake));
  VERIFY(!v.admitted);
  v.pending = false;
  v.waiting_available = true;
  SetEvent(v.available);
  SUCCEED(wl_composition_wait(&c, wake));
  VERIFY(v.admitted && !v.waiting_available);
  VERIFY(WaitForSingleObject(v.available, 0) == WAIT_TIMEOUT);
  return 0;
}

static HRESULT test_texture(ID3D11Device* device, UINT width, UINT height,
                             ID3D11Texture2D** texture, UINT array_size = 2) {
  D3D11_TEXTURE2D_DESC td{};
  td.Width = width;
  td.Height = height;
  td.MipLevels = 1;
  td.ArraySize = array_size;
  td.Format = DXGI_FORMAT_NV12;
  td.SampleDesc.Count = 1;
  td.BindFlags = D3D11_BIND_DECODER;
  std::vector<BYTE> pixels(width * height * 3 / 2, 128);
  std::vector<D3D11_SUBRESOURCE_DATA> initial(array_size);
  for (auto& data : initial) {
    data.pSysMem = pixels.data();
    data.SysMemPitch = width;
    data.SysMemSlicePitch = static_cast<UINT>(pixels.size());
  }
  return device->CreateTexture2D(&td, initial.data(), texture);
}
extern "C" int wl_composition_test_cache(HWND hwnd) {
  Composition* raw = nullptr;
  SUCCEED(wl_composition_create(hwnd, &raw));
  std::unique_ptr<Composition> c(raw);
  ComPtr<ID3D11Device> device;
  SUCCEED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
      nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, nullptr));
  ComPtr<ID3D11Texture2D> texture;
  SUCCEED(test_texture(device.Get(), 656, 368, &texture));
  SUCCEED(wl_composition_layout(c.get(), 1, 0, 0, 640, 360, 0, TRUE));
  auto& v = *c->views.at(1);
  SUCCEED(configure(c.get(), 1, v, texture.Get(), 640, 360));
  auto processor = v.processor;
  auto output = v.output;
  D3D11_TEXTURE2D_DESC td{};
  texture->GetDesc(&td);
  ID3D11VideoProcessorInputView* first = nullptr;
  ID3D11VideoProcessorInputView* again = nullptr;
  ID3D11VideoProcessorInputView* second = nullptr;
  SUCCEED(input_view(v, texture.Get(), 0, td, &first));
  SUCCEED(input_view(v, texture.Get(), 0, td, &again));
  SUCCEED(input_view(v, texture.Get(), 1, td, &second));
  VERIFY(first == again && first != second && v.inputs.size() == 2);
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_desc{};
  second->GetDesc(&input_desc);
  VERIFY(input_desc.Texture2D.ArraySlice == 1);
  SUCCEED(configure(c.get(), 1, v, texture.Get(), 640, 360));
  VERIFY(v.processor == processor && v.output == output && v.inputs.size() == 2);
  HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  VERIFY(wake);
  struct Close { HANDLE h; ~Close() { CloseHandle(h); } } close{wake};
  SUCCEED(wl_composition_commit(c.get()));
  for (UINT i = 0; i < 8; ++i) {
    const UINT crop = i % 2 * 2;
    const BOOL bt709 = i % 2, full = i % 3 == 0;
    const auto deadline = GetTickCount64() + 4000;
    HRESULT hr;
    while ((hr = wl_composition_submit(c.get(), 1, texture.Get(), i % 2,
                                        crop, crop, 640, 360, bt709, full, TRUE)) == S_FALSE) {
      VERIFY(GetTickCount64() < deadline);
      SUCCEED(wl_composition_wait(c.get(), wake));
    }
    SUCCEED(hr);
    SUCCEED(wl_composition_commit(c.get()));
    while ((hr = wl_composition_poll(c.get(), 1)) == S_FALSE) {
      VERIFY(GetTickCount64() < deadline);
      SUCCEED(wl_composition_wait(c.get(), wake));
    }
    SUCCEED(hr);
    VERIFY(v.output == output && v.inputs.size() == 2);
    BOOL enabled = FALSE;
    RECT rect{};
    v.video_context->VideoProcessorGetStreamSourceRect(v.processor.Get(), 0,
                                                       &enabled, &rect);
    VERIFY(enabled && rect.left == crop && rect.top == crop &&
           rect.right == crop + 640 && rect.bottom == crop + 360);
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE color{};
    v.video_context->VideoProcessorGetStreamColorSpace(v.processor.Get(), 0, &color);
    VERIFY(color.YCbCr_Matrix == bt709 && color.Nominal_Range == (full ? 2 : 1));
  }
  {
    ComPtr<ID3D11Texture2D> array;
    SUCCEED(test_texture(device.Get(), 656, 368, &array,
                         static_cast<UINT>(View::input_limit + 1)));
    D3D11_TEXTURE2D_DESC array_desc{};
    array->GetDesc(&array_desc);
    for (UINT slice = 0; slice <= View::input_limit; ++slice) {
      SUCCEED(input_view(v, array.Get(), slice, array_desc, &again));
      VERIFY(v.inputs.size() <= View::input_limit);
    }
    VERIFY(v.inputs.size() == View::input_limit);
    for (const auto& input : v.inputs)
      VERIFY(input.texture == array && input.subresource != 0);
  }
  for (size_t i = 0; i <= View::texture_limit; ++i) {
    ComPtr<ID3D11Texture2D> next;
    SUCCEED(test_texture(device.Get(), 656, 368, &next, 1));
    SUCCEED(input_view(v, next.Get(), 0, td, &again));
    VERIFY(v.inputs.size() <= View::input_limit);
  }
  VERIFY(v.inputs.size() == View::texture_limit);
  for (const auto& input : v.inputs)
    VERIFY(input.texture != texture);
  // Switching to disposable software uploads releases the reusable texture cache.
  for (int i = 0; i < 20; ++i) {
    ComPtr<ID3D11Texture2D> upload;
    SUCCEED(test_texture(device.Get(), 656, 368, &upload, 1));
    const auto deadline = GetTickCount64() + 4000;
    HRESULT hr;
    while ((hr = wl_composition_submit(c.get(), 1, upload.Get(), 0,
                                        2, 2, 640, 360, TRUE, FALSE, FALSE)) == S_FALSE) {
      VERIFY(GetTickCount64() < deadline);
      SUCCEED(wl_composition_wait(c.get(), wake));
    }
    SUCCEED(hr);
    VERIFY(v.transient_input && v.inputs.empty() && v.output == output);
    // Complete the real one-frame-in-flight lifecycle before another disposable
    // upload. Driver-side view destruction may be deferred until work is flushed.
    while ((hr = wl_composition_poll(c.get(), 1)) == S_FALSE) {
      VERIFY(GetTickCount64() < deadline);
      SUCCEED(wl_composition_wait(c.get(), wake));
    }
    SUCCEED(hr);
    VERIFY(!v.transient_input);
  }
  ComPtr<ID3D11Texture2D> resized;
  SUCCEED(test_texture(device.Get(), 1296, 736, &resized));
  SUCCEED(configure(c.get(), 1, v, resized.Get(), 1280, 720));
  VERIFY(v.inputs.empty() && v.processor != processor && v.output != output && !v.parameters_set);
  processor = v.processor;
  output = v.output;
  ComPtr<ID3D11Device> other;
  SUCCEED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
      nullptr, 0, D3D11_SDK_VERSION, &other, nullptr, nullptr));
  SUCCEED(test_texture(other.Get(), 1296, 736, &resized));
  SUCCEED(configure(c.get(), 1, v, resized.Get(), 1280, 720));
  VERIFY(v.device == other && v.inputs.empty() && v.processor != processor && v.output != output);
  // A hidden view must stop waiting on DXGI availability (which may never signal
  // while occluded), so close/layout updates always remain able to wake it.
  v.waiting_available = true;
  SUCCEED(wl_composition_layout(c.get(), 1, 0, 0, 1280, 720, 0, FALSE));
  VERIFY(!v.waiting_available);
  SUCCEED(wl_composition_remove(c.get(), 1));
  VERIFY(c->views.empty());
  return 0;
}
#undef VERIFY
#undef SUCCEED

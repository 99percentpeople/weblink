# NVENC interface header

`nvEncodeAPI.h` is NVIDIA's MIT-licensed interface header from
[nv-codec-headers n12.2.72.0](https://github.com/FFmpeg/nv-codec-headers/tree/n12.2.72.0).
Its copyright and license are retained in the header. No NVIDIA binary is bundled.

The Windows adapter uses this pinned ABI and loads the installed driver at runtime.
It checks the driver's maximum API version before creating an instance. Drivers
older than this ABI, missing libraries and unsupported adapters retain Media
Foundation. Building this adapter requires the normal Windows C++ toolchain, not
CUDA or an installed NVIDIA SDK. Newer SDK features must not be enabled by merely
changing structure version numbers.

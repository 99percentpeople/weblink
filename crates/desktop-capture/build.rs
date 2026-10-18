fn main() {
    println!("cargo:rerun-if-changed=src/media/windows/nvenc/bridge.cpp");
    println!("cargo:rerun-if-changed=src/media/windows/nvenc/bridge.h");
    println!("cargo:rerun-if-changed=vendor/nvcodec/nvEncodeAPI.h");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        cc::Build::new()
            .cpp(true)
            .std("c++17")
            .define("NOMINMAX", None)
            .define("WIN32_LEAN_AND_MEAN", None)
            .include("vendor/nvcodec")
            .file("src/media/windows/nvenc/bridge.cpp")
            .flag_if_supported("/EHsc")
            .compile("weblink_nvenc");
    }
}

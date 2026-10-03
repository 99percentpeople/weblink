// Login startup can point at a development build as well as an installed build.
// Both are GUI applications; a console would own the app's process lifetime.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    weblink_desktop_lib::run();
}

//! A real child process for job tests, with no Shell/runtime startup dependency.
use std::io::{self, Read, Write};

fn main() {
    let mode = std::env::args().nth(1).unwrap();
    // Match the production launch barrier: Windows assigns the process to its
    // kill-on-close job object before allowing it to execute or exit.
    #[cfg(windows)]
    if mode != "echo-stdin" {
        let mut ready = [1];
        io::stdin().read_exact(&mut ready).unwrap();
        assert_eq!(ready, [0]);
    }
    match mode.as_str() {
        // Used as a native pipeline child, after its parent passed the barrier.
        "echo-stdin" | "input" => {
            io::copy(&mut io::stdin().lock(), &mut io::stdout().lock()).unwrap();
        }
        "input-hex" => {
            let mut bytes = Vec::new();
            io::stdin().read_to_end(&mut bytes).unwrap();
            for byte in bytes {
                print!("{byte:02x}");
            }
        }
        "closed-input" => {
            #[cfg(windows)]
            {
                use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
                // This fixture deliberately closes stdin and never reads it again.
                drop(unsafe { OwnedHandle::from_raw_handle(io::stdin().as_raw_handle()) });
            }
            #[cfg(unix)]
            {
                use std::os::fd::{FromRawFd, OwnedFd};
                drop(unsafe { OwnedFd::from_raw_fd(0) });
            }
            println!("stdin closed");
            io::stdout().flush().unwrap();
            loop {
                std::thread::park();
            }
        }
        "exit" => {
            io::stdout().write_all(b"out").unwrap();
            io::stderr().write_all(b"err").unwrap();
            io::stdout().flush().unwrap();
            io::stderr().flush().unwrap();
            std::process::exit(7);
        }
        "output" => println!("automation-output"),
        "hold" => loop {
            std::thread::park();
        },
        mode @ ("large" | "bytes") => {
            let mut out = io::stdout().lock();
            let chunk = [b'x'; 10000];
            for _ in 0..500 {
                out.write_all(&chunk).unwrap();
            }
            if mode == "large" {
                out.write_all(b"\nFINAL-RESULT\n").unwrap();
            }
        }
        mode => panic!("Unknown fixture mode: {mode}"),
    }
}

//! A real child process for job tests, with no Shell/runtime startup dependency.
use std::io::{self, Write};

fn main() {
    // Match the production launch barrier: Windows assigns the process to its
    // kill-on-close job object before allowing it to execute or exit.
    #[cfg(windows)]
    {
        let mut ready = String::new();
        io::stdin().read_line(&mut ready).unwrap();
        assert_eq!(ready, "ready\n");
    }
    match std::env::args().nth(1).as_deref().unwrap() {
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

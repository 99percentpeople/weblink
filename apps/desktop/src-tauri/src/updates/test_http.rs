//! Loopback-only HTTP fixture. Also runnable directly with `rustc --test`.
use std::{
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HEADERS: usize = 16384;

fn read_request(stream: &mut TcpStream) -> io::Result<String> {
    // Accepted sockets can inherit nonblocking mode on Windows. A read timeout
    // alone does not make them wait for bytes that have not arrived yet.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let count = match stream.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "HTTP client closed before completing its headers",
            ));
        }
        request.extend_from_slice(&buffer[..count]);
        if request.len() > MAX_HEADERS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP request headers exceed fixture limit",
            ));
        }
        if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            return String::from_utf8(request)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }
    }
}

// Serve exactly one request; following attachments during discovery must fail.
pub(crate) fn mock_response(status: u16, body: &str) -> (String, JoinHandle<io::Result<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/releases/latest", listener.local_addr().unwrap());
    let body = body.to_owned();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + TIMEOUT;
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "No release API request received",
                        ));
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return Err(error),
            }
        };
        let request = read_request(&mut stream)?;
        write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
        Ok(request)
    });
    (endpoint, handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::Shutdown, sync::mpsc};

    fn sockets() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        // Exercise Windows' accepted-socket behavior on every platform.
        server.set_nonblocking(true).unwrap();
        (client, server)
    }

    #[test]
    fn waits_for_delayed_and_fragmented_headers_on_nonblocking_sockets() {
        let (mut client, mut server) = sockets();
        thread::scope(|scope| {
            let (sent, received) = mpsc::channel();
            scope.spawn(move || sent.send(read_request(&mut server)).unwrap());
            let pending = || {
                assert!(matches!(
                    received.recv_timeout(Duration::from_millis(50)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ));
            };
            pending();
            client
                .write_all(b"GET /releases/latest HTTP/1.1\r\n")
                .unwrap();
            pending();
            client.write_all(b"Host: localhost\r\n\r\n").unwrap();
            let request = received.recv_timeout(TIMEOUT).unwrap().unwrap();
            assert_eq!(
                request,
                "GET /releases/latest HTTP/1.1\r\nHost: localhost\r\n\r\n"
            );
        });
    }

    #[test]
    fn reports_a_client_closing_before_headers_are_complete() {
        let (mut client, mut server) = sockets();
        client
            .write_all(b"GET /releases/latest HTTP/1.1\r\n")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        assert_eq!(
            read_request(&mut server).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn bounds_unterminated_headers() {
        let (mut client, mut server) = sockets();
        client.write_all(&vec![b'x'; MAX_HEADERS + 1]).unwrap();
        assert_eq!(
            read_request(&mut server).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn serves_the_configured_status_and_complete_body() {
        let (endpoint, server) = mock_response(429, "{}");
        let address = endpoint
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        client.set_read_timeout(Some(TIMEOUT)).unwrap();
        client
            .write_all(b"GET /releases/latest HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert_eq!(
            response,
            "HTTP/1.1 429 Test\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
        );
        assert!(server
            .join()
            .unwrap()
            .unwrap()
            .starts_with("GET /releases/latest "));
    }
}

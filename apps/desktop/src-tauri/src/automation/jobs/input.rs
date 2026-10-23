//! Bounded stdin delivery. The authority lock only enqueues; pipe writes are cancellable.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::{io::AsyncWriteExt, sync::mpsc};
use tokio_util::sync::CancellationToken;

const QUEUE_SIZE: usize = 8;
const MAX_BYTES: usize = 65536;

pub(super) struct Message {
    bytes: Vec<u8>,
    eof: bool,
}

#[derive(Clone)]
pub(super) struct Input {
    sender: mpsc::Sender<Message>,
    status: Arc<Mutex<&'static str>>,
}

impl Input {
    pub fn new() -> (Self, mpsc::Receiver<Message>) {
        let (sender, receiver) = mpsc::channel(QUEUE_SIZE);
        (
            Self {
                sender,
                status: Arc::new(Mutex::new("open")),
            },
            receiver,
        )
    }

    pub fn status(&self) -> &'static str {
        *self.status.lock().unwrap()
    }

    pub fn enqueue(&self, args: &Value) -> Result<Value, String> {
        let input = args
            .get("input")
            .map(|v| v.as_str().ok_or("INVALID_ARGUMENTS"))
            .transpose()?;
        let eof = args
            .get("eof")
            .map(|v| v.as_bool().ok_or("INVALID_ARGUMENTS"))
            .transpose()?
            .unwrap_or(false);
        if input.is_none() && !eof
            || input.is_some_and(|text| {
                text.is_empty() || text.len() > MAX_BYTES || text.chars().count() > 16384
            })
        {
            return Err("INVALID_ARGUMENTS".into());
        }
        let bytes = input.unwrap_or_default().as_bytes().to_vec();
        let len = bytes.len();
        let mut status = self.status.lock().unwrap();
        if *status != "open" {
            return Err("STDIN_CLOSED".into());
        }
        self.sender
            .try_send(Message { bytes, eof })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => "BUSY",
                mpsc::error::TrySendError::Closed(_) => "STDIN_CLOSED",
            })?;
        if eof {
            *status = "closing";
        }
        Ok(json!({"queued":true,"bytes":len,"eof":eof}))
    }

    pub fn close(&self) {
        let mut status = self.status.lock().unwrap();
        if *status != "failed" {
            *status = "closed";
        }
    }

    pub async fn run(
        &self,
        mut stdin: impl tokio::io::AsyncWrite + Unpin,
        mut receiver: mpsc::Receiver<Message>,
        cancel: CancellationToken,
        launch_barrier: bool,
    ) {
        let write = async {
            if launch_barrier {
                // The Shell reads exactly one raw byte, without buffering user input.
                stdin.write_all(&[0]).await?;
                stdin.flush().await?;
            }
            while let Some(message) = receiver.recv().await {
                stdin.write_all(&message.bytes).await?;
                // Windows child pipes can acknowledge a buffered write before
                // the OS write finishes. Observe its result before EOF or idle.
                stdin.flush().await?;
                if message.eof {
                    stdin.shutdown().await?;
                    break;
                }
            }
            Ok(())
        };
        let result: std::io::Result<()> = tokio::select! {
            biased;
            _ = cancel.cancelled() => Ok(()),
            result = write => result,
        };
        drop(stdin);
        if result.is_err() && !cancel.is_cancelled() {
            *self.status.lock().unwrap() = "failed";
        }
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_is_bounded_and_eof_rejects_later_input() {
        let (input, _receiver) = Input::new();
        for _ in 0..QUEUE_SIZE {
            input.enqueue(&json!({"input":"hello"})).unwrap();
        }
        assert_eq!(input.enqueue(&json!({"input":"more"})).unwrap_err(), "BUSY");
        assert_eq!(input.enqueue(&json!({"eof":true})).unwrap_err(), "BUSY");
        assert_eq!(input.status(), "open");
        let (input, _receiver) = Input::new();
        assert_eq!(
            input
                .enqueue(&json!({"input":"中文🙂","eof":true}))
                .unwrap()["bytes"],
            10
        );
        assert_eq!(input.status(), "closing");
        assert_eq!(
            input.enqueue(&json!({"input":"more"})).unwrap_err(),
            "STDIN_CLOSED"
        );
    }

    #[test]
    fn rejects_invalid_input_and_closed_receivers() {
        let (input, receiver) = Input::new();
        for args in [
            json!({}),
            json!({"input":""}),
            json!({"eof":false}),
            json!({"input":1}),
            json!({"eof":1}),
            json!({"input":"🙂".repeat(16385)}),
        ] {
            assert!(input.enqueue(&args).is_err());
        }
        drop(receiver);
        assert_eq!(
            input.enqueue(&json!({"input":"more"})).unwrap_err(),
            "STDIN_CLOSED"
        );
    }

    #[tokio::test]
    async fn writes_exact_utf8_in_order_then_delivers_eof() {
        use tokio::io::AsyncReadExt;
        let (input, receiver) = Input::new();
        let (writer, mut reader) = tokio::io::duplex(16);
        input.enqueue(&json!({"input":"first\n"})).unwrap();
        input
            .enqueue(&json!({"input":"中文🙂","eof":true}))
            .unwrap();
        let copy = input.clone();
        let task = tokio::spawn(async move {
            copy.run(writer, receiver, CancellationToken::new(), false)
                .await;
        });
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap();
        assert_eq!(bytes, "first\n中文🙂".as_bytes());
        assert_eq!(input.status(), "closed");
    }

    #[tokio::test]
    async fn cancellation_interrupts_blocked_writes_and_broken_pipes_report_failure() {
        let (input, receiver) = Input::new();
        let (writer, _reader) = tokio::io::duplex(1);
        input.enqueue(&json!({"input":"x".repeat(16384)})).unwrap();
        let cancel = CancellationToken::new();
        let copy = input.clone();
        let token = cancel.clone();
        let task = tokio::spawn(async move { copy.run(writer, receiver, token, false).await });
        tokio::task::yield_now().await;
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(input.status(), "closed");

        let (input, receiver) = Input::new();
        let (writer, reader) = tokio::io::duplex(1);
        drop(reader);
        input.enqueue(&json!({"input":"text"})).unwrap();
        input
            .run(writer, receiver, CancellationToken::new(), false)
            .await;
        assert_eq!(input.status(), "failed");
    }

    #[tokio::test]
    async fn stdin_write_flushes_buffered_bytes_without_waiting_for_another_send() {
        use tokio::io::AsyncReadExt;
        let (input, receiver) = Input::new();
        let (writer, mut reader) = tokio::io::duplex(64);
        input.enqueue(&json!({"input":"hello"})).unwrap();
        let copy = input.clone();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move {
            copy.run(tokio::io::BufWriter::new(writer), receiver, token, false)
                .await;
        });
        let mut bytes = [0; 5];
        let received = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            reader.read_exact(&mut bytes),
        )
        .await;
        cancel.cancel();
        task.await.unwrap();
        received
            .expect("Input must reach the child without another send or EOF")
            .unwrap();
        assert_eq!(&bytes, b"hello");
    }

    #[tokio::test]
    async fn stdin_write_reports_deferred_errors_without_another_send() {
        let (input, receiver) = Input::new();
        let (writer, reader) = tokio::io::duplex(64);
        drop(reader);
        input.enqueue(&json!({"input":"hello"})).unwrap();
        let copy = input.clone();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let mut task = tokio::spawn(async move {
            copy.run(tokio::io::BufWriter::new(writer), receiver, token, false)
                .await;
        });
        let finished = tokio::time::timeout(std::time::Duration::from_secs(1), &mut task).await;
        if finished.is_err() {
            cancel.cancel();
            task.await.unwrap();
        }
        assert!(finished.is_ok(), "The failed pipe must stop the writer");
        assert_eq!(input.status(), "failed");
    }
}

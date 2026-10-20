//! Waiting for shell output must never block permission changes or other tool calls.
use super::*;

fn check(s: &State, epoch: &str, id: &str) -> Result<(), String> {
    Service::check(s, epoch)?;
    let t = s.tickets.get(id).ok_or("CANCELLED")?;
    if t.call.name != "commands.run" || t.call.arguments["target"] != "local" {
        return Err("INVALID_TARGET".into());
    }
    if t.deadline <= Instant::now()
        || !Service::current(s)
        || !s.grants.get(&t.grant).is_some_and(|g| {
            Service::grant_live(s, g)
                && g.principal.id == t.principal.id
                && g.target == "local"
                && g.scopes.iter().any(|scope| scope == "shell.execute")
        })
    {
        return Err("GRANT_EXPIRED".into());
    }
    Ok(())
}

pub async fn action(service: Shared, epoch: String, id: String) -> Result<Value, String> {
    let authority = service.clone();
    let start_epoch = epoch.clone();
    let start_id = id.clone();
    let (job, wait_ms) = tauri::async_runtime::spawn_blocking(move || {
        let mut s = authority.state.lock().unwrap();
        check(&s, &start_epoch, &start_id)?;
        let t = s.tickets.get_mut(&start_id).ok_or("CANCELLED")?;
        if t.used {
            return Err("CANCELLED".to_string());
        }
        t.used = true;
        // Serialize only process creation with revocation, never the output wait.
        let job = authority
            .jobs
            .start_waiting(&t.principal.id, &t.grant, &t.call.arguments)?;
        Ok((job, t.call.arguments["waitMs"].as_u64().unwrap_or(10000)))
    })
    .await
    .map_err(|_| "EXECUTION_FAILED")??;
    job.wait(wait_ms, || {
        check(&service.state.lock().unwrap(), &epoch, &id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Shared {
        let service = Arc::new(Service::default());
        let p = Principal {
            id: "caller".into(),
            label: "Test".into(),
            kind: "peer".into(),
            fingerprint: None,
        };
        {
            let mut s = service.state.lock().unwrap();
            s.enabled = true;
            s.epoch = "epoch".into();
            s.heartbeat = Some(Instant::now());
            s.peers.insert(p.id.clone(), p.clone());
            s.grants.insert(
                "grant".into(),
                Grant {
                    id: "grant".into(),
                    target: "local".into(),
                    principal: p.clone(),
                    scopes: vec!["shell.execute".into()],
                    expires_at: Some(now() + 60000),
                },
            );
            #[cfg(unix)]
            let script = "sleep 30";
            #[cfg(windows)]
            let script = "Start-Sleep -Seconds 30";
            s.tickets.insert(
                "ticket".into(),
                Ticket {
                    principal: p,
                    call: Call {
                        source: None,
                        name: "commands.run".into(),
                        arguments: json!({"target":"local","script":script,"waitMs":10000}),
                    },
                    grant: "grant".into(),
                    deadline: Instant::now() + Duration::from_secs(60),
                    answer: oneshot::channel().0,
                    used: false,
                },
            );
        }
        service
    }
    #[test]
    fn run_requires_live_local_shell_grant_and_matching_principal() {
        let service = fixture();
        let mut s = service.state.lock().unwrap();
        assert!(check(&s, "epoch", "ticket").is_ok());
        s.grants.get_mut("grant").unwrap().scopes = vec!["input.control".into()];
        assert!(check(&s, "epoch", "ticket").is_err());
        s.grants.get_mut("grant").unwrap().scopes = vec!["shell.execute".into()];
        s.grants.get_mut("grant").unwrap().principal.id = "other".into();
        assert!(check(&s, "epoch", "ticket").is_err());
        s.grants.get_mut("grant").unwrap().principal.id = "caller".into();
        s.grants.get_mut("grant").unwrap().expires_at = Some(now() - 1);
        assert!(check(&s, "epoch", "ticket").is_err());
        s.grants.get_mut("grant").unwrap().expires_at = Some(now() + 60000);
        s.tickets.get_mut("ticket").unwrap().call.arguments["target"] = json!("peer");
        assert!(check(&s, "epoch", "ticket").is_err());
        s.tickets.get_mut("ticket").unwrap().call.arguments["target"] = json!("local");
        s.peers.clear();
        assert!(check(&s, "epoch", "ticket").is_err());
    }
    #[tokio::test]
    async fn authority_remains_responsive_during_run_and_cancellation_drops_process() {
        let service = fixture();
        let running = tokio::spawn(action(service.clone(), "epoch".into(), "ticket".into()));
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if !service.jobs.list().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        // A held authority lock would fail immediately instead of hanging this test.
        service
            .state
            .try_lock()
            .expect("run held authority mutex while waiting")
            .tickets
            .remove("ticket");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), running)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
            "CANCELLED"
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if service.jobs.list()[0]["status"] == "cancelled" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

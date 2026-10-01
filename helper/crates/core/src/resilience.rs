//! Retry queue for failed provider calls.
//!
//! Raw audio is already safe on disk (see `storage.rs`) before any provider
//! call is attempted, so nothing here risks losing audio — this only
//! tracks which *processing* work (a transcription chunk, a summarization
//! call) still needs to happen after a failure, with exponential backoff,
//! so a transient network blip or a rate limit doesn't require the user to
//! notice and manually retry.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetryJob<T> {
    pub id: Uuid,
    pub payload: T,
    pub attempts: u32,
    pub next_retry_at: DateTime<Utc>,
}

const MAX_ATTEMPTS: u32 = 8;
const BASE_BACKOFF_SECS: i64 = 5;
const MAX_BACKOFF_SECS: i64 = 300; // 5 minutes

/// Exponential backoff with a ceiling: 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s...
pub fn backoff_for_attempt(attempt: u32) -> Duration {
    let secs = BASE_BACKOFF_SECS.saturating_mul(1i64 << attempt.min(20));
    Duration::seconds(secs.min(MAX_BACKOFF_SECS))
}

/// Up to 25% of the backoff, subtracted so the delay never exceeds the
/// documented ceiling.
///
/// A meeting fails its chunks in bursts — one expired key or one rate limit
/// fails every in-flight chunk at nearly the same instant, and each of those
/// jobs then gets the same `backoff_for_attempt` from the same `now`. Without
/// jitter the whole batch retries in lockstep and re-triggers the same rate
/// limit, over and over, in step with itself.
fn jitter_for(backoff: Duration) -> Duration {
    use rand::RngExt;
    let span = backoff.num_milliseconds() / 4;
    if span <= 0 {
        return Duration::zero();
    }
    Duration::milliseconds(rand::rng().random_range(0..=span))
}

fn jittered_backoff(attempt: u32) -> Duration {
    let backoff = backoff_for_attempt(attempt);
    backoff - jitter_for(backoff)
}

#[derive(Debug, thiserror::Error)]
pub enum RetryQueueError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// A disk-persisted FIFO-ish retry queue. Persisting means a helper
/// restart (or crash) doesn't silently drop work that was mid-retry —
/// it's picked back up the same way an interrupted recording is (see
/// `storage::MeetingStore::find_interrupted_meetings`).
pub struct RetryQueue<T> {
    path: PathBuf,
    jobs: Vec<RetryJob<T>>,
}

impl<T: Clone + Serialize + for<'de> Deserialize<'de>> RetryQueue<T> {
    pub fn load_or_create(path: impl Into<PathBuf>) -> Result<Self, RetryQueueError> {
        let path = path.into();
        let jobs = if path.exists() {
            let bytes = fs::read(&path)?;
            if bytes.is_empty() {
                vec![]
            } else {
                Self::parse_tolerant(&path, &bytes)
            }
        } else {
            vec![]
        };
        Ok(Self { path, jobs })
    }

    /// Reads the queue one job at a time. A corrupt or truncated file (a crash mid-write on a
    /// filesystem without atomic rename, a hand edit, a format from another version) must not
    /// make every start and settings refresh fail forever, and one bad entry must not discard
    /// its neighbours. Unreadable content is moved aside as `<file>.corrupt` for inspection.
    fn parse_tolerant(path: &std::path::Path, bytes: &[u8]) -> Vec<RetryJob<T>> {
        let entries: Vec<serde_json::Value> = match serde_json::from_slice(bytes) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(?path, %error, "retry queue is unreadable; quarantining it");
                Self::quarantine(path);
                return vec![];
            }
        };
        let mut jobs = Vec::with_capacity(entries.len());
        let mut skipped = false;
        for entry in entries {
            match serde_json::from_value::<RetryJob<T>>(entry) {
                Ok(job) => jobs.push(job),
                Err(error) => {
                    skipped = true;
                    tracing::warn!(?path, %error, "dropping an unreadable retry job");
                }
            }
        }
        if skipped {
            // Keep the original so the dropped jobs can be inspected, then rewrite what survived.
            let _ = fs::copy(path, Self::corrupt_path(path));
        }
        jobs
    }

    fn corrupt_path(path: &std::path::Path) -> PathBuf {
        let mut name = path.as_os_str().to_owned();
        name.push(".corrupt");
        PathBuf::from(name)
    }

    fn quarantine(path: &std::path::Path) {
        let _ = fs::rename(path, Self::corrupt_path(path));
    }

    fn dead_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".dead");
        PathBuf::from(name)
    }

    /// Jobs that ran out of attempts are parked here instead of vanishing, so the work they
    /// stand for (a transcription range whose audio is still on disk) can be offered again,
    /// for example when the user resumes the recording after fixing the provider key.
    fn bury(&self, job: &RetryJob<T>) -> Result<(), RetryQueueError> {
        let path = self.dead_path();
        let mut dead: Vec<serde_json::Value> = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        dead.push(serde_json::to_value(job)?);
        crate::storage::atomic_write(&path, &serde_json::to_vec_pretty(&dead)?)?;
        Ok(())
    }

    /// Puts every parked job back in the queue with a fresh attempt budget; returns how many.
    pub fn requeue_dead(&mut self, now: DateTime<Utc>) -> Result<usize, RetryQueueError> {
        let path = self.dead_path();
        let Ok(bytes) = fs::read(&path) else {
            return Ok(0);
        };
        let dead: Vec<RetryJob<T>> = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect();
        let count = dead.len();
        for mut job in dead {
            job.attempts = 0;
            job.next_retry_at = now;
            self.jobs.push(job);
        }
        self.persist()?;
        let _ = fs::remove_file(path);
        Ok(count)
    }

    fn persist(&self) -> Result<(), RetryQueueError> {
        // Shares storage's write-temp-then-rename helper rather than keeping
        // a second copy of the same logic — the two had already drifted into
        // repeating the same non-atomic Windows delete-then-rename bug.
        crate::storage::atomic_write(&self.path, &serde_json::to_vec_pretty(&self.jobs)?)?;
        Ok(())
    }

    pub fn enqueue(&mut self, payload: T, now: DateTime<Utc>) -> Result<Uuid, RetryQueueError> {
        let job = RetryJob {
            id: Uuid::new_v4(),
            payload,
            attempts: 0,
            next_retry_at: now,
        };
        let id = job.id;
        self.jobs.push(job);
        self.persist()?;
        Ok(id)
    }

    /// Jobs whose `next_retry_at` has arrived, oldest-enqueued first.
    pub fn due_jobs(&self, now: DateTime<Utc>) -> Vec<&RetryJob<T>> {
        self.jobs
            .iter()
            .filter(|j| j.next_retry_at <= now)
            .collect()
    }

    /// Call after a retry attempt fails. Increments the attempt count and
    /// reschedules with backoff, unless the job has exhausted its
    /// attempts — in which case it's returned so the caller can surface a
    /// terminal error to the user (the underlying audio is still safe on
    /// disk regardless).
    pub fn record_failure(
        &mut self,
        job_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<Option<RetryJob<T>>, RetryQueueError> {
        let Some(job) = self.jobs.iter_mut().find(|j| j.id == job_id) else {
            return Ok(None);
        };
        job.attempts += 1;
        if job.attempts >= MAX_ATTEMPTS {
            let exhausted = job.clone();
            // Park it before removing it: if parking fails the job stays queued rather than lost.
            self.bury(&exhausted)?;
            self.jobs.retain(|j| j.id != job_id);
            self.persist()?;
            return Ok(Some(exhausted));
        }
        job.next_retry_at = now + jittered_backoff(job.attempts);
        self.persist()?;
        Ok(None)
    }

    /// Parks a job right away, without spending its remaining attempts. For failures that
    /// retrying can never fix (the provider refused the request itself).
    pub fn give_up(&mut self, job_id: Uuid) -> Result<Option<RetryJob<T>>, RetryQueueError> {
        let Some(job) = self.jobs.iter().find(|j| j.id == job_id).cloned() else {
            return Ok(None);
        };
        self.bury(&job)?;
        self.jobs.retain(|j| j.id != job_id);
        self.persist()?;
        Ok(Some(job))
    }

    pub fn record_success(&mut self, job_id: Uuid) -> Result<(), RetryQueueError> {
        self.jobs.retain(|j| j.id != job_id);
        self.persist()
    }

    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    pub fn any<F>(&self, predicate: F) -> bool
    where
        F: FnMut(&RetryJob<T>) -> bool,
    {
        self.jobs.iter().any(predicate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_queue_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("retry_queue.json");
        (dir, path)
    }

    #[test]
    fn backoff_grows_exponentially_up_to_ceiling() {
        assert_eq!(backoff_for_attempt(0), Duration::seconds(5));
        assert_eq!(backoff_for_attempt(1), Duration::seconds(10));
        assert_eq!(backoff_for_attempt(2), Duration::seconds(20));
        assert_eq!(backoff_for_attempt(3), Duration::seconds(40));
        assert_eq!(backoff_for_attempt(10), Duration::seconds(300)); // clamped
    }

    #[test]
    fn enqueue_persists_and_reloads() {
        let (_dir, path) = temp_queue_path();
        let now = Utc::now();
        {
            let mut queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
            queue.enqueue("job-a".to_string(), now).unwrap();
        }
        let queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn due_jobs_only_returns_jobs_whose_time_has_arrived() {
        let (_dir, path) = temp_queue_path();
        let mut queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        let now = Utc::now();
        let future = now + Duration::minutes(10);

        queue.enqueue("due-now".to_string(), now).unwrap();
        queue.enqueue("not-yet".to_string(), future).unwrap();

        let due = queue.due_jobs(now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].payload, "due-now");
    }

    #[test]
    fn jitter_only_ever_shortens_the_backoff_and_spreads_retries_out() {
        // Never past the documented ceiling, never into the past.
        for attempt in 0..8 {
            let full = backoff_for_attempt(attempt);
            for _ in 0..50 {
                let jittered = jittered_backoff(attempt);
                assert!(jittered <= full, "jitter must not extend the backoff");
                assert!(jittered >= full - Duration::milliseconds(full.num_milliseconds() / 4));
                assert!(jittered > Duration::zero());
            }
        }

        // The point of the jitter: chunks that failed together must not all
        // come due at the same instant and re-trigger the same rate limit.
        let distinct: std::collections::HashSet<i64> = (0..50)
            .map(|_| jittered_backoff(3).num_milliseconds())
            .collect();
        assert!(distinct.len() > 1, "every retry landed on the same delay");
    }

    #[test]
    fn record_failure_reschedules_with_backoff() {
        let (_dir, path) = temp_queue_path();
        let mut queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        let now = Utc::now();
        let id = queue.enqueue("job".to_string(), now).unwrap();

        let result = queue.record_failure(id, now).unwrap();
        assert!(result.is_none()); // not exhausted yet

        let due_immediately = queue.due_jobs(now);
        assert!(due_immediately.is_empty()); // rescheduled into the future

        // attempts becomes 1 after the first failure -> backoff_for_attempt(1) == 10s
        let due_after_backoff = queue.due_jobs(now + Duration::seconds(11));
        assert_eq!(due_after_backoff.len(), 1);
    }

    #[test]
    fn record_failure_past_max_attempts_removes_job_and_returns_it() {
        let (_dir, path) = temp_queue_path();
        let mut queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        let mut now = Utc::now();
        let id = queue.enqueue("job".to_string(), now).unwrap();

        let mut exhausted = None;
        for _ in 0..MAX_ATTEMPTS {
            exhausted = queue.record_failure(id, now).unwrap();
            now += Duration::seconds(400); // past any backoff ceiling
        }

        assert!(exhausted.is_some());
        assert_eq!(exhausted.unwrap().payload, "job");
        assert!(queue.is_empty());
    }

    #[test]
    fn record_success_removes_the_job() {
        let (_dir, path) = temp_queue_path();
        let mut queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        let now = Utc::now();
        let id = queue.enqueue("job".to_string(), now).unwrap();

        queue.record_success(id).unwrap();
        assert!(queue.is_empty());
    }

    #[test]
    fn record_failure_on_unknown_job_id_is_a_noop() {
        let (_dir, path) = temp_queue_path();
        let mut queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        let result = queue.record_failure(Uuid::new_v4(), Utc::now()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn a_corrupt_queue_file_is_quarantined_instead_of_failing_every_load() {
        let (_dir, path) = temp_queue_path();
        std::fs::write(&path, b"{ not json").unwrap();
        let queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        assert_eq!(queue.len(), 0);
        assert!(!path.exists());
        assert!(path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn one_unreadable_job_does_not_discard_its_neighbours() {
        let (_dir, path) = temp_queue_path();
        let good = RetryJob {
            id: Uuid::new_v4(),
            payload: "ok".to_string(),
            attempts: 1,
            next_retry_at: Utc::now(),
        };
        let file = serde_json::json!([serde_json::to_value(&good).unwrap(), { "id": 5 }]);
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        let queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn exhausted_jobs_are_parked_and_can_be_requeued() {
        let (_dir, path) = temp_queue_path();
        let now = Utc::now();
        let mut queue: RetryQueue<String> = RetryQueue::load_or_create(&path).unwrap();
        let id = queue.enqueue("range".to_string(), now).unwrap();
        for _ in 0..MAX_ATTEMPTS {
            queue.record_failure(id, now).unwrap();
        }
        assert!(queue.is_empty());
        assert_eq!(queue.requeue_dead(now).unwrap(), 1);
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.requeue_dead(now).unwrap(), 0);
    }
}

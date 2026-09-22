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
use std::io::Write;
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
                serde_json::from_slice(&bytes)?
            }
        } else {
            vec![]
        };
        Ok(Self { path, jobs })
    }

    fn persist(&self) -> Result<(), RetryQueueError> {
        let temp = self.path.with_extension("tmp");
        let mut file = fs::File::create(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(&self.jobs)?)?;
        file.sync_all()?;
        #[cfg(windows)]
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        fs::rename(temp, &self.path)?;
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
            self.jobs.retain(|j| j.id != job_id);
            self.persist()?;
            return Ok(Some(exhausted));
        }
        job.next_retry_at = now + backoff_for_attempt(job.attempts);
        self.persist()?;
        Ok(None)
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
}
